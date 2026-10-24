// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { compileChart, evaluateChart, renderSceneToSvg } from './index.js'
import { bindSceneSignals, parseEventSelector, stampDatumAttrs } from './signals.js'
import type { VgSpec } from './types.js'

const specWithEventSignal = {
  width: 200,
  height: 100,
  signals: [
    {
      name: 'pointer',
      value: 0,
      on: [{ events: 'mousemove', update: 'event.x' }],
    },
    {
      name: 'clicked',
      value: false,
      on: [{ events: 'click', update: '!clicked' }],
    },
  ],
  data: [{ name: 't', values: [{ x: 1, y: 2 }] }],
  marks: [
    { type: 'rect', from: { data: 't' }, encode: { update: { x: { value: 5 }, width: { value: 50 }, y: { value: 5 }, height: { value: 50 }, fill: { value: '#4c78a8' } } } },
  ],
} as unknown as VgSpec

/** jsdom dispatches clientX=0; monkey-patch getBoundingClientRect for view coords. */
function mount(): { host: HTMLDivElement; svg: SVGSVGElement } {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const chart = compileChart(specWithEventSignal)
  const scene = evaluateChart(chart)
  const svg = document.createElement('div')
  svg.innerHTML = renderSceneToSvg(scene)
  host.appendChild(svg.firstElementChild as SVGSVGElement)
  const el = host.querySelector('svg') as SVGSVGElement
  el.getBoundingClientRect = () => ({ left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 } as DOMRect)
  return { host, svg: el }
}

describe('event-driven signals', () => {
  it('parses vega event selectors (comma merges; whitespace is not a separator)', () => {
    expect(parseEventSelector('mousemove, click, wheel')).toEqual(['mousemove', 'click', 'wheel'])
    expect(parseEventSelector('mouseover')).toEqual(['mouseover'])
    // vega reads "mousemove click wheel" as ONE event type of that (unmatchable) name
    expect(parseEventSelector('mousemove click wheel')).toEqual(['mousemove click wheel'])
    expect(parseEventSelector('[mousedown, mouseup] > mousemove')).toEqual(['mousemove'])
    expect(parseEventSelector([{ type: 'click' }, { source: 'window', type: 'keydown' }])).toEqual(['click', 'keydown'])
    expect(parseEventSelector({ type: 'wheel' })).toEqual(['wheel'])
  })

  it('binds mousemove -> signal update with view coordinates', () => {
    const { host, svg } = mount()
    let last: { name: string; value: unknown } | null = null
    const scene = evaluateChart(compileChart(structuredClone(specWithEventSignal)))
    const binding = bindSceneSignals(svg, scene, {}, {
      onSignal: (name, value) => { last = { name, value } },
    })
    svg.dispatchEvent(new MouseEvent('mousemove', { clientX: 42, clientY: 10, bubbles: true }))
    expect(last).toEqual({ name: 'pointer', value: 42 })
    binding.detach()
    void host
  })

  it('click stream toggles the signal (expr with signal refs)', () => {
    const { svg } = mount()
    let last = null as null | { name: string; value: unknown }
    const binding = bindSceneSignals(svg, evaluateChart(compileChart(structuredClone(specWithEventSignal))), {}, {
      onSignal: (name, value) => { last = { name, value } },
    })
    svg.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(last).toEqual({ name: 'clicked', value: true })
    svg.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(last!.value).toBe(false)
    binding.detach()
  })

  it('recovers the hovered mark datum into the event context', () => {
    const spec = {
      width: 100, height: 100,
      signals: [{ name: 'hit', value: '', on: [{ events: 'click', update: 'isValid(datum) ? datum.tag + "" : "none"' }] }],
      data: [{ name: 't', values: [{ tag: 'A' }] }],
      marks: [{ type: 'rect', from: { data: 't' }, encode: { update: { x: { value: 0 }, y: { value: 0 }, width: { value: 50 }, height: { value: 50 }, fill: { value: '#4c78a8' } } } }],
    } as unknown as VgSpec
    const host = document.createElement('div')
    document.body.appendChild(host)
    const chart = compileChart(spec)
    const scene = evaluateChart(chart)
    stampDatumAttrs(scene.items)
    host.innerHTML = renderSceneToSvg(scene)
    const svg = host.querySelector('svg') as SVGSVGElement
    // the rendered rect must carry data-datum
    expect(svg.querySelector('[data-datum]')).toBeTruthy()
    let captured: unknown
    const binding = bindSceneSignals(svg, scene, {}, {
      onSignal: (name, value) => { if (name === 'hit') captured = value },
    })
    const rect = svg.querySelector('.mark-rect path') ?? svg.querySelector('path')
    rect!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    binding.detach()
    expect(captured).toBe('A')
  })

  it('setSignal resolves dependent updates to a fixed point', () => {
    const spec = {
      signals: [
        { name: 'a', value: 1 },
        { name: 'b', value: 0, update: 'a * 2' },
      ],
    } as unknown as VgSpec
    const { svg } = mount()
    let got: Record<string, unknown> | null = null
    const binding = bindSceneSignals(svg, evaluateChart(compileChart(spec)), {}, {
      onSignal: (name, value, all) => { if (name === 'a') got = all },
    })
    binding.setSignal('a', 5)
    expect(got!.b).toBe(10)
    binding.detach()
    void svg
  })
})

// ---------------------------------------------------------------------------
// C20: vega's event-stream semantics (the real-browser parity gate is
// packages/conformance/scripts/browser-signals.mts; these are the jsdom-level checks)
// ---------------------------------------------------------------------------

function bindSpec(signals: unknown[], store: Record<string, unknown> = {}, hooks: Parameters<typeof bindSceneSignals>[3] = {}) {
  const spec = { width: 200, height: 100, signals, marks: [] } as unknown as VgSpec
  const host = document.createElement('div')
  document.body.appendChild(host)
  const scene = evaluateChart(compileChart(spec))
  host.innerHTML = renderSceneToSvg(scene)
  const svg = host.querySelector('svg') as SVGSVGElement
  svg.getBoundingClientRect = () => ({ left: 0, top: 0, right: 200, bottom: 100, width: 200, height: 100 } as DOMRect)
  const calls: Array<[string, unknown]> = []
  const logs: string[] = []
  const binding = bindSceneSignals(svg, scene, store, {
    onSignal: (n, v) => calls.push([n, v]),
    logger: { error: (...a) => logs.push('error:' + a.join(' ')), warn: (...a) => logs.push('warn:' + a.join(' ')) },
    ...hooks,
  })
  return { svg, scene, binding, calls, logs, store, host }
}
const fire = (el: EventTarget, type: string, init: MouseEventInit = {}): void => {
  el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init }))
}

describe('signal event streams (C20)', () => {
  it('exposes the native event: shiftKey and deltaY are the browser\'s own', () => {
    const t = bindSpec([
      { name: 'shift', value: 'init', on: [{ events: 'click', update: 'event.shiftKey' }] },
      { name: 'dy', value: 0, on: [{ events: 'wheel', update: 'event.deltaY' }] },
    ])
    fire(t.svg, 'click', { shiftKey: true })
    t.svg.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 120 }))
    expect(t.store.shift).toBe(true)
    expect(t.store.dy).toBe(120)
    t.binding.detach()
  })

  it('updates fire only for the handlers whose stream matched, and derived signals only when a dependency changed', () => {
    const t = bindSpec([
      { name: 'count', value: 0, on: [{ events: 'click', update: 'count + 1' }] },
      { name: 'moves', value: 0, on: [{ events: 'mousemove', update: 'moves + 1' }] },
      { name: 'doubled', value: 0, update: 'count * 2' },
      { name: 'unrelated', value: 0, update: 'moves * 10' },
    ])
    fire(t.svg, 'mousemove')
    fire(t.svg, 'mousemove')
    expect(t.calls.map((c) => c[0])).toEqual(['moves', 'unrelated', 'moves', 'unrelated'])
    t.calls.length = 0
    fire(t.svg, 'click')
    expect(t.calls).toEqual([['count', 1], ['doubled', 2]])
    expect(t.store.moves).toBe(2)
    t.binding.detach()
  })

  it('between: only events after the opener and before the closer', () => {
    const t = bindSpec([{ name: 'x', value: -1, on: [{ events: '[mousedown, mouseup] > mousemove', update: 'event.clientX' }] }])
    fire(t.svg, 'mousemove', { clientX: 5 })
    expect(t.store.x).toBeUndefined()
    fire(t.svg, 'mousedown')
    fire(t.svg, 'mousemove', { clientX: 7 })
    fire(t.svg, 'mouseup')
    fire(t.svg, 'mousemove', { clientX: 9 })
    expect(t.store.x).toBe(7)
    t.binding.detach()
  })

  it('between state survives a re-bind (hosts re-bind after every render)', () => {
    const signals = [{ name: 'x', value: -1, on: [{ events: '[mousedown, mouseup] > mousemove', update: 'event.clientX' }] }]
    const t = bindSpec(signals)
    fire(t.svg, 'mousedown')
    t.binding.detach()
    const again = bindSceneSignals(t.svg, t.scene, t.store, {})
    fire(t.svg, 'mousemove', { clientX: 11 })
    expect(t.store.x).toBe(11)
    again.detach()
  })

  it('filters, consume and window / object-form sources', () => {
    const t = bindSpec([
      { name: 'shifted', value: 0, on: [{ events: 'click[event.shiftKey]', update: 'shifted + 1' }] },
      { name: 'consumed', value: 0, on: [{ events: 'mousedown!', update: 'consumed + 1' }] },
      { name: 'leaked', value: 0, on: [{ events: 'window:mousedown', update: 'leaked + 1' }] },
      { name: 'key', value: '', on: [{ events: { source: 'window', type: 'keydown' }, update: 'event.key' }] },
    ])
    fire(t.svg, 'click')
    expect(t.store.shifted).toBeUndefined()
    fire(t.svg, 'click', { shiftKey: true })
    expect(t.store.shifted).toBe(1)
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    t.svg.dispatchEvent(down)
    expect(down.defaultPrevented).toBe(true)
    expect(t.store.consumed).toBe(1)
    expect(t.store.leaked).toBeUndefined()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'q' }))
    expect(t.store.key).toBe('q')
    t.binding.detach()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z' }))
    expect(t.store.key).toBe('q')
  })

  it('throttle and debounce', () => {
    vi.useFakeTimers()
    try {
      const t = bindSpec([
        { name: 'thr', value: 0, on: [{ events: 'mousemove{100}', update: 'thr + 1' }] },
        { name: 'deb', value: 0, on: [{ events: 'click{0,50}', update: 'event.clientX' }] },
      ])
      fire(t.svg, 'mousemove')
      vi.advanceTimersByTime(20)
      fire(t.svg, 'mousemove')
      expect(t.store.thr).toBe(1)
      vi.advanceTimersByTime(200)
      fire(t.svg, 'mousemove')
      expect(t.store.thr).toBe(2)
      fire(t.svg, 'click', { clientX: 3 })
      fire(t.svg, 'click', { clientX: 4 })
      expect(t.store.deb).toBeUndefined()
      vi.advanceTimersByTime(60)
      expect(t.store.deb).toBe(4)
      t.binding.detach()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a bad selector or expression is reported at bind time, the other handlers still bind', () => {
    const t = bindSpec([
      { name: 'bad', value: 0, on: [{ events: '[mousedown] > mousemove', update: '1' }] },
      { name: 'badExpr', value: 0, on: [{ events: 'click', update: '1 +' }] },
      { name: 'good', value: 0, on: [{ events: 'click', update: 'good + 1' }] },
    ])
    expect(t.logs.filter((l) => l.startsWith('error:'))).toHaveLength(2)
    expect(t.logs[0]).toContain('bad')
    fire(t.svg, 'click')
    expect(t.store.good).toBe(1)
    t.binding.detach()
  })

  it('an expression that throws while handling an event is logged, never thrown out of the DOM listener', () => {
    const t = bindSpec([
      { name: 'bad', value: 'init', on: [{ events: 'click', update: 'datum.nope.x' }] },
      { name: 'good', value: 0, on: [{ events: 'mousemove', update: 'good + 1' }] },
    ])
    expect(() => fire(t.svg, 'click')).not.toThrow()
    expect(t.logs.filter((l) => l.startsWith('error:'))).toHaveLength(1)
    expect(t.store.bad).toBeUndefined()
    fire(t.svg, 'mousemove')
    expect(t.store.good).toBe(1)
    t.binding.detach()
  })

  it('signal stores are prototype-safe: __proto__ / constructor signals are plain data', () => {
    const store: Record<string, unknown> = Object.create(null)
    const t = bindSpec([
      { name: '__proto__', value: 1, on: [{ events: 'click', update: '5' }] },
      { name: 'constructor', value: 2, on: [{ events: 'click', update: '"c"' }] },
    ], store)
    fire(t.svg, 'click')
    expect(Object.getPrototypeOf(store)).toBe(null)
    expect(Object.keys(store).sort()).toEqual(['__proto__', 'constructor'])
    expect(Object.getOwnPropertyDescriptor(store, '__proto__')!.value).toBe(5)
    expect(store.constructor).toBe('c')
    // a plain `{}` store keeps ITS prototype too
    const plain: Record<string, unknown> = {}
    const t2 = bindSpec([{ name: '__proto__', value: 1, on: [{ events: 'click', update: '7' }] }], plain)
    fire(t2.svg, 'click')
    expect(Object.getPrototypeOf(plain)).toBe(Object.prototype)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    t.binding.detach()
    t2.binding.detach()
  })

  it('event.item.mark and the group functions come from the picker', () => {
    const spec = {
      width: 100, height: 100,
      signals: [{ name: 'which', value: 'none', on: [{ events: '@bars:click', update: 'datum.tag + ":" + event.item.mark.marktype + ":" + event.item.mark.name' }] }],
      data: [{ name: 't', values: [{ tag: 'A' }] }],
      marks: [{ type: 'rect', name: 'bars', from: { data: 't' }, encode: { update: { x: { value: 0 }, y: { value: 0 }, width: { value: 50 }, height: { value: 50 } } } }],
    } as unknown as VgSpec
    const scene = evaluateChart(compileChart(spec))
    const host = document.createElement('div')
    host.innerHTML = renderSceneToSvg(scene)
    document.body.appendChild(host)
    const svg = host.querySelector('svg') as SVGSVGElement
    const store: Record<string, unknown> = {}
    const markGroup = scene.items.find((n) => n.marktype === 'rect') as unknown as { items: Array<{ datum: unknown }> }
    const item = markGroup.items[0]!
    const binding = bindSceneSignals(svg, scene, store, {}, { pick: () => ({ item, marktype: 'rect' }) })
    fire(svg, 'click')
    expect(store.which).toBe('A:rect:bars')
    binding.detach()
  })
})

