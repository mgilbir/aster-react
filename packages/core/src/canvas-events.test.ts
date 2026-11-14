// @vitest-environment jsdom
/**
 * The canvas renderer's events, against a scene stub: which handlers a native event reaches and which item each is about. Real
 * vega's canvas renderer is the oracle of `pnpm conformance:signals` (every case runs on it); this pins the states that need no
 * browser: the hovered item, the pressed one, the touched one, what a new binding carries over, and the listeners' lifetime.
 */
import { describe, it, expect } from 'vitest'
import { createCanvasEvents } from './canvas-events.js'
import type { PickedItem, ViewEventScene } from './signals.js'

/** Items by the x band the pointer is in: `a` 0..10, `b` 10..20, nothing beyond (jsdom: a canvas's client point is its own). */
function stubScene(names: Record<string, object>, gone: ReadonlySet<string> = new Set()): ViewEventScene & { items: Record<string, PickedItem> } {
  const items: Record<string, PickedItem> = {}
  for (const [k, item] of Object.entries(names)) items[k] = { item, marktype: 'rect', name: k }
  const keyOf = (p: PickedItem): string | undefined => Object.keys(items).find((k) => items[k]!.name === p.name)
  return {
    items,
    resolve: ({ clientX }) => (clientX < 10 ? items.a! : clientX < 20 ? items.b! : null),
    relocate: (p) => {
      const k = keyOf(p) ?? p.name!
      return gone.has(k) ? null : items[k] ?? null
    },
  }
}

function record(canvas: HTMLCanvasElement, sc: ViewEventScene, types: string[]): { log: string[]; disconnect: () => void } {
  const log: string[] = []
  const events = (canvas as unknown as { __events: ReturnType<typeof createCanvasEvents> }).__events
  const conn = events.connect(sc)
  for (const t of types) conn.on(t, (e, item) => log.push(`${t}<${e.type}>:${item ? item.name : String(item)}`))
  return { log, disconnect: () => conn.disconnect() }
}

function setup(): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  ;(canvas as unknown as { __events: unknown }).__events = createCanvasEvents(canvas)
  return canvas
}
const fire = (el: Element, type: string, x = 0, init: Record<string, unknown> = {}): void => {
  el.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: 5, ...init }))
}

describe('createCanvasEvents', () => {
  it('a pointermove is also a mousemove, and an item change is the out of one item and the over of the next', () => {
    const canvas = setup()
    const sc = stubScene({ a: {}, b: {} })
    const { log } = record(canvas, sc, ['pointermove', 'mousemove', 'pointerover', 'mouseover', 'pointerout', 'mouseout'])
    fire(canvas, 'pointermove', 2)
    fire(canvas, 'pointermove', 4)
    fire(canvas, 'pointermove', 15)
    fire(canvas, 'pointerout', 15)
    expect(log).toEqual([
      'pointerout<pointermove>:null', 'mouseout<pointermove>:null', 'pointerover<pointermove>:a', 'mouseover<pointermove>:a', 'pointermove<pointermove>:a', 'mousemove<pointermove>:a',
      'pointermove<pointermove>:a', 'mousemove<pointermove>:a',
      'pointerout<pointermove>:a', 'mouseout<pointermove>:a', 'pointerover<pointermove>:b', 'mouseover<pointermove>:b', 'pointermove<pointermove>:b', 'mousemove<pointermove>:b',
      'pointerout<pointerout>:b', 'mouseout<pointerout>:b',
    ])
  })

  it('every other event is about the hovered item, wherever it is', () => {
    const canvas = setup()
    const { log } = record(canvas, stubScene({ a: {}, b: {} }), ['wheel', 'dblclick', 'mouseup', 'keydown'])
    fire(canvas, 'wheel', 15)
    fire(canvas, 'pointermove', 2)
    fire(canvas, 'wheel', 15)
    fire(canvas, 'dblclick', 15)
    fire(canvas, 'mouseup', 15)
    canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'q' }))
    expect(log).toEqual(['wheel<wheel>:null', 'wheel<wheel>:a', 'dblclick<dblclick>:a', 'mouseup<mouseup>:a', 'keydown<keydown>:a'])
  })

  it('a click counts only on the item a button went down on', () => {
    const canvas = setup()
    const { log } = record(canvas, stubScene({ a: {}, b: {} }), ['click', 'mousedown', 'pointerdown'])
    fire(canvas, 'pointermove', 2)
    fire(canvas, 'pointerdown', 2)
    fire(canvas, 'mousedown', 2)
    fire(canvas, 'click', 2)
    fire(canvas, 'click', 2) // (no press since the last click)
    fire(canvas, 'pointerdown', 2)
    fire(canvas, 'pointermove', 15)
    fire(canvas, 'click', 15)
    expect(log).toEqual(['pointerdown<pointerdown>:a', 'mousedown<mousedown>:a', 'click<click>:a', 'pointerdown<pointerdown>:a'])
  })

  it('a touch is about the item it started on; the first one also makes it the hovered item', () => {
    const canvas = setup()
    const { log } = record(canvas, stubScene({ a: {}, b: {} }), ['touchstart', 'touchmove', 'touchend', 'wheel'])
    const touch = (type: string, x: number): void => {
      const e = new Event(type, { bubbles: true }) as Event & { changedTouches: unknown }
      Object.defineProperty(e, 'changedTouches', { value: [{ clientX: x, clientY: 5 }] })
      canvas.dispatchEvent(e)
    }
    touch('touchstart', 15)
    touch('touchmove', 2)
    touch('touchend', 2)
    fire(canvas, 'wheel', 2)
    touch('touchstart', 2)
    fire(canvas, 'wheel', 2)
    expect(log).toEqual(['touchstart<touchstart>:b', 'touchmove<touchmove>:b', 'touchend<touchend>:b', 'wheel<wheel>:b', 'touchstart<touchstart>:a', 'wheel<wheel>:b'])
  })

  it('a new binding carries the hovered item into its scene; one that has left the scene is not left by a pointerout', () => {
    const canvas = setup()
    const first = record(canvas, stubScene({ a: {}, b: {} }), ['pointerover', 'pointerout'])
    fire(canvas, 'pointermove', 2)
    first.disconnect()
    // the same items in a new scene (new objects): a move within a sends nothing
    const second = record(canvas, stubScene({ a: {}, b: {} }), ['pointerover', 'pointerout'])
    fire(canvas, 'pointermove', 3)
    expect(second.log).toEqual([])
    second.disconnect()
    // a scene without a: moving onto b enters b, and a is not left
    const third = record(canvas, stubScene({ a: {}, b: {} }, new Set(['a'])), ['pointerover', 'pointerout'])
    fire(canvas, 'pointermove', 15)
    expect(third.log).toEqual(['pointerover<pointermove>:b'])
  })

  it('a disconnected binding hears nothing; release stops listening to the canvas', () => {
    const canvas = setup()
    const events = (canvas as unknown as { __events: ReturnType<typeof createCanvasEvents> }).__events
    const a = record(canvas, stubScene({ a: {}, b: {} }), ['mousemove'])
    fire(canvas, 'pointermove', 2)
    a.disconnect()
    fire(canvas, 'pointermove', 3)
    expect(a.log).toEqual(['mousemove<pointermove>:a'])
    const b = record(canvas, stubScene({ a: {}, b: {} }), ['mousemove'])
    events.release()
    fire(canvas, 'pointermove', 4)
    fire(canvas, 'mousemove', 4)
    expect(b.log).toEqual([])
  })

  it('one native event handed over as several types: the first handled type sees its own vegaType, the queued ones the last', () => {
    const canvas = setup()
    const events = (canvas as unknown as { __events: ReturnType<typeof createCanvasEvents> }).__events
    const conn = events.connect(stubScene({ a: {}, b: {} }))
    const seen: string[] = []
    for (const t of ['pointerout', 'pointerover', 'mousemove']) conn.on(t, (_e, _item, vegaType) => seen.push(`${t}:${vegaType}`))
    fire(canvas, 'pointermove', 2)
    fire(canvas, 'pointermove', 15)
    fire(canvas, 'pointerout', 15)
    fire(canvas, 'click', 15)
    expect(seen).toEqual([
      'pointerout:pointerout', 'pointerover:mousemove', 'mousemove:mousemove',
      'pointerout:pointerout', 'pointerover:mousemove', 'mousemove:mousemove',
      'pointerout:pointerout',
    ])
  })
})
