/**
 * The canvas renderer's events: how the events of a chart drawn on a `<canvas>` reach the signal event loop, and which item
 * each one is about.
 *
 * A canvas has no element per item for the browser to find under the pointer, so the renderer says which item an event is
 * about, as vega-scenegraph's canvas handler does. What a host sees of it (`event.item`, which streams fire, how often) is
 * vega's, and is what this module keeps; the shape is Aster's:
 *
 * - The item under the pointer is the one the last `pointermove` picked (the "hovered" item). Every event is about it: a
 *   click, a wheel, a key, a mouseup. A touch is about the item its `touchstart` picked (the first touch of a page also makes
 *   it the hovered item).
 * - A `pointermove` that finds another item than the hovered one is also the `pointerout` and `mouseout` of the item it leaves
 *   (not of one that is gone from the scene), then the `pointerover` and `mouseover` of the one it enters. Every
 *   `pointermove` is also a `mousemove`. Leaving the canvas (its `pointerout`) is the `pointerout` and `mouseout` of the
 *   hovered item, and leaves none hovered. `dragover` / `dragenter` / `dragleave` work the same way.
 * - A `click` counts only when the hovered item is the one a button went down on (`pointerdown` / `mousedown`).
 * - Other native events of a type a stream listens to are handed over as they come.
 *
 * The state outlives a binding: a host binds again after every render, and the hovered item must stay hovered (vega's items
 * persist across renders). A new binding relocates the items held so far into its scene (`ViewEventScene.relocate`); one
 * that is gone is kept as it was, so it is no longer the hovered one and its `pointerout` is not sent.
 */
import type { HostCanvas } from './host-types.js'
import type { PickedItem, ViewEventConnection, ViewEventScene, ViewEvents } from './signals.js'

/** A canvas's event handler for the signal event loop (`SignalBindOptions.events`). */
export interface CanvasEvents extends ViewEvents {
  /** Stop listening to the canvas: the host is done with it. Idempotent. */
  release(): void
}

type Send = (event: Event, item: PickedItem | null | undefined, vegaType?: string) => void

/** The listeners the handler always has: they keep the hovered item and the pressed one up to date. */
const ALWAYS = ['click', 'mousedown', 'pointerdown', 'pointermove', 'pointerout', 'dragleave'] as const
const TOUCH = new Set(['touchstart', 'touchmove', 'touchend'])

/**
 * The events of `canvas` for the signal event loop, resolved as vega's canvas renderer resolves them. Keep one per canvas for
 * as long as it is shown, pass it to every binding (`bindSceneSignals(canvas, scene, signals, hooks, { events })`), and
 * `release` it when the canvas goes.
 */
export function createCanvasEvents(canvas: HostCanvas): CanvasEvents {
  /** The handlers of the bound streams, by type, in the order they were added (one binding at a time, but a re-bind overlaps). */
  const handlers = new Map<string, Array<{ owner: object; send: Send }>>()
  /** The scene of the newest binding: what a pointer position is resolved in. */
  let scene: ViewEventScene | null = null
  let hovered: PickedItem | null = null
  let pressed: PickedItem | null = null
  let touched: PickedItem | null = null
  let firstTouch = true
  /** Items the newest scene has no place for (vega: exited); one hovered is not left by a `pointerout`. */
  const gone = new WeakSet<PickedItem>()
  const listening = new Map<string, (e: Event) => void>()
  let released = false

  /** One item, whichever binding resolved it (a relocated item is a new description of the same scene item). */
  const same = (a: PickedItem | null, b: PickedItem | null): boolean => a === b || (a != null && b != null && a.item === b.item)

  const pick = (point: { clientX: number; clientY: number } | undefined): PickedItem | null => {
    if (point === undefined || scene === null) return null
    return scene.resolve(point)
  }

  /**
   * The native event being handed over: whether a type of it has reached a handler yet, and the type it is handed over as last.
   * vega hands each type over as a run of its own (`view.runAsync`): the first runs at once, the others are queued behind it and
   * run once it is done, before the event goes on to the page (the microtasks of a listener run when it returns), so they see
   * the event as the last type left it: `event.vegaType` is that type.
   */
  let handing: { reached: boolean; last: string } = { reached: false, last: '' }
  /** Hand `e` to the handlers of `type`, about the hovered item (or the touched one). */
  const fire = (type: string, e: Event, touch = false): void => {
    const list = handlers.get(type)
    if (!list) return
    const item = touch ? touched : hovered
    const vegaType = handing.reached ? handing.last : type
    handing.reached = true
    for (const h of list.slice()) h.send(e, item, vegaType)
  }
  const fireAll = (types: readonly string[], e: Event): void => { for (const t of types) fire(t, e) }

  /** A move: the item under the point becomes the hovered one, with the out / over of the change, then the move itself. */
  const move = (moves: readonly string[], overs: readonly string[], outs: readonly string[]) => (e: Event): void => {
    const before = hovered
    const now = pick(e as MouseEvent)
    if (same(now, before)) {
      fireAll(moves, e)
      return
    }
    if (before === null || !gone.has(before)) fireAll(outs, e)
    hovered = now
    fireAll(overs, e)
    fireAll(moves, e)
  }
  /** Leaving: the out of the hovered item, then none is hovered. */
  const leave = (outs: readonly string[]) => (e: Event): void => {
    fireAll(outs, e)
    hovered = null
  }
  const press = (type: string) => (e: Event): void => {
    pressed = hovered
    fire(type, e)
  }
  /** What a native event of a type does (any other type is handed over as it comes). */
  const native: Record<string, (e: Event) => void> = {
    pointermove: move(['pointermove', 'mousemove'], ['pointerover', 'mouseover'], ['pointerout', 'mouseout']),
    dragover: move(['dragover'], ['dragenter'], ['dragleave']),
    pointerout: leave(['pointerout', 'mouseout']),
    dragleave: leave(['dragleave']),
    pointerdown: press('pointerdown'),
    mousedown: press('mousedown'),
    click: (e) => {
      if (!same(pressed, hovered)) return
      fire('click', e)
      pressed = null
    },
    touchstart: (e) => {
      touched = pick((e as TouchEvent).changedTouches?.[0])
      if (firstTouch) {
        hovered = touched
        firstTouch = false
      }
      fire('touchstart', e, true)
    },
    touchmove: (e) => fire('touchmove', e, true),
    touchend: (e) => {
      fire('touchend', e, true)
      touched = null
    },
    // (old Firefox's wheel)
    DOMMouseScroll: (e) => fire('mousewheel', e),
  }

  /** The type a native event is handed over as last (a move ends on its moves, a leave on its outs). */
  const LAST: Record<string, string> = { pointermove: 'mousemove', dragover: 'dragover', pointerout: 'mouseout', DOMMouseScroll: 'mousewheel' }
  const listen = (type: string): void => {
    if (released || listening.has(type)) return
    // (own properties only: an event type named like a member of `Object.prototype` -- `toString`, `constructor` -- is a type
    // like any other, handed over as it comes, never that member taken for its handler)
    const f = Object.hasOwn(native, type) ? native[type]! : (e: Event): void => fire(type, e)
    const last = Object.hasOwn(LAST, type) ? LAST[type]! : type
    const listener = (e: Event): void => {
      const outer = handing
      handing = { reached: false, last }
      try { f(e) } finally { handing = outer }
    }
    listening.set(type, listener)
    canvas.addEventListener(type, listener)
  }
  for (const t of ALWAYS) listen(t)

  /** A new scene: the items held so far stand for theirs in it, or are gone. */
  const carry = (item: PickedItem | null, into: ViewEventScene): PickedItem | null => {
    if (item === null || gone.has(item)) return item
    const now = into.relocate(item)
    if (now === null) {
      gone.add(item)
      return item
    }
    return now
  }

  return {
    connect(next: ViewEventScene): ViewEventConnection {
      if (next !== scene) {
        // (the hovered item and the pressed one may be one item: they stay one)
        const wasPressedHovered = pressed !== null && same(pressed, hovered)
        hovered = carry(hovered, next)
        pressed = wasPressedHovered ? hovered : carry(pressed, next)
        touched = carry(touched, next)
        scene = next
      }
      const owner = {}
      let connected = true
      return {
        on(type, send) {
          if (!connected) return
          for (const t of TOUCH.has(type) ? TOUCH : [type]) listen(t)
          let list = handlers.get(type)
          if (!list) handlers.set(type, (list = []))
          list.push({ owner, send })
        },
        disconnect() {
          if (!connected) return
          connected = false
          for (const [type, list] of handlers) {
            const kept = list.filter((h) => h.owner !== owner)
            if (kept.length) handlers.set(type, kept)
            else handlers.delete(type)
          }
          if (scene === next) scene = null
        },
      }
    },
    release() {
      if (released) return
      released = true
      for (const [type, listener] of listening) canvas.removeEventListener(type, listener)
      listening.clear()
      handlers.clear()
      scene = null
      hovered = pressed = touched = null
    },
  }
}
