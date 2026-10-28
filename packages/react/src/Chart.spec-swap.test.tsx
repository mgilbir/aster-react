// @vitest-environment jsdom
/**
 * A mounted <Chart> / <SvgChart> given a different `spec` must show what a FRESH mount of that spec shows.
 *
 * Every other test mounts fresh, so nothing held a spec CHANGE to that: the incremental DOM patcher, the timers, the
 * interaction state and the signal state a chart keeps between renders all belong to the spec they were made under.
 * The relation is the same everywhere: swap(A, B) === fresh(B), and swap(A, B, A) === fresh(A), as canonical markup
 * (attribute order is not output) -- over a seeded sample of the conformance corpus (both grammars, every mark type), and
 * for a swap made while a timer is ticking or a pointer interaction is in flight.
 * (The same relation against vega's own output, over the gallery, is `pnpm conformance:gallery` -- the spec-swap path.)
 */
import * as React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import type { VgSpec } from '@aster/core'
import type { ChartHandle } from './Chart'
import { forEachVariant } from './testing/variants'
import { corpusFiles, loadCorpusSpec, type CorpusSpec } from './testing/corpus'

/** The markup as a tree with sorted attributes: what two renders are compared by. */
function canonical(el: Element): string {
  const attrs = [...el.attributes].map((a) => `${a.name}=${a.value}`).sort().join(' ')
  return `<${el.tagName} ${attrs}>${el.children.length ? [...el.children].map(canonical).join('') : (el.textContent ?? '')}</${el.tagName}>`
}

const mulberry32 = (seed: number): (() => number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

forEachVariant(['svg'], (Chart, variant) => {
  const roots: Root[] = []
  afterEach(() => { act(() => { for (const r of roots.splice(0)) r.unmount() }); document.body.innerHTML = '' })
  const mount = (): { container: HTMLElement; render(node: React.ReactElement): void } => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    return { container, render: (node) => { act(() => { root.render(node) }) } }
  }
  const markup = (c: HTMLElement): string => canonical(c.querySelector('svg')!)
  /** What a fresh mount of `spec` shows. */
  const fresh = (spec: VgSpec): string => {
    const m = mount()
    m.render(<Chart spec={spec} />)
    return markup(m.container)
  }

  describe('a spec that changes in a mounted chart', () => {
    let pool: CorpusSpec[] = []
    beforeAll(async () => {
      // a seeded sample of the corpus: every grammar and mark type, with and without scales, legends, facets, projections
      const files = corpusFiles()
      const rand = mulberry32(0xa57e4)
      const picked = new Set<string>()
      while (picked.size < 48) picked.add(files[Math.floor(rand() * files.length)]!)
      const loaded = await Promise.all([...picked].map(loadCorpusSpec))
      // a variant without the event loop reports a spec with event streams (and renders it without them): leave those to the variants that have it
      pool = loaded.filter((c) => variant.has(['signals']) || !JSON.stringify(c.spec).includes('"events"'))
    }, 60_000)

    it('equals a fresh mount of the new spec, over a seeded sample of corpus pairs (A -> B and A -> B -> A)', () => {
      expect(pool.length).toBeGreaterThanOrEqual(variant.has(['signals']) ? 48 : 30)
      const rand = mulberry32(0x5a9)
      const pairs: Array<[CorpusSpec, CorpusSpec]> = []
      for (let i = 0; i < 60; i++) {
        const a = pool[Math.floor(rand() * pool.length)]!
        const b = pool[Math.floor(rand() * pool.length)]!
        if (a !== b) pairs.push([a, b])
      }
      const bad: string[] = []
      for (const [a, b] of pairs) {
        const want = { a: fresh(a.spec), b: fresh(b.spec) }
        const m = mount()
        m.render(<Chart spec={a.spec} />)
        m.render(<Chart spec={b.spec} />)
        if (markup(m.container) !== want.b) bad.push(`${a.name} -> ${b.name}`)
        m.render(<Chart spec={a.spec} />)
        if (markup(m.container) !== want.a) bad.push(`${a.name} -> ${b.name} -> ${a.name}`)
      }
      expect(pairs.length).toBeGreaterThan(50)
      expect(bad).toEqual([])
    }, 120_000)

    it('keeps the incremental path for a data-only change (the same <svg> element is patched, not rebuilt)', () => {
      const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ c: `c${i}`, v: i + 1 }))
      const spec = (values: unknown[]) => ({
        width: 120, height: 80, padding: 0, autosize: 'none',
        data: [{ name: 't', values }],
        scales: [
          { name: 'x', type: 'band', domain: { data: 't', field: 'c' }, range: [0, 120] },
          { name: 'y', type: 'linear', domain: [0, 10], range: [80, 0] },
        ],
        marks: [{ type: 'rect', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'c' }, width: { scale: 'x', band: 1 }, y: { scale: 'y', field: 'v' }, y2: { scale: 'y', value: 0 } } } }],
      }) as never
      const m = mount()
      m.render(<Chart spec={spec(rows(4))} />)
      const svg = m.container.querySelector('svg')!
      m.render(<Chart spec={spec(rows(5))} />)
      expect(m.container.querySelector('svg')).toBe(svg)
      expect(markup(m.container)).toBe(fresh(spec(rows(5))))
    })
  })

  describe('the interaction state of the old spec', () => {
    const scatter = (name: string, rows: Array<{ a: number; b: number }>) => ({
      width: 200, height: 100, padding: 0, autosize: 'none',
      data: [{ name, values: rows }],
      scales: [
        { name: 'x', type: 'linear', domain: { data: name, field: 'a' }, range: 'width' },
        { name: 'y', type: 'linear', domain: { data: name, field: 'b' }, range: 'height' },
      ],
      marks: [{ type: 'symbol', from: { data: name }, encode: { update: { x: { scale: 'x', field: 'a' }, y: { scale: 'y', field: 'b' }, size: { value: 20 } } } }],
    }) as never
    const A = scatter('t', [{ a: 0, b: 0 }, { a: 50, b: 10 }, { a: 100, b: 40 }])
    const B = scatter('u', [{ a: 0, b: 5 }, { a: 20, b: 15 }, { a: 80, b: 25 }])

    variant.it(['interaction'], 'a zoom made on the old spec is not applied to the new one; a signal set imperatively is gone with it', () => {
      const ref = React.createRef<ChartHandle>()
      const m = mount()
      m.render(<Chart ref={ref} spec={A} panZoom />)
      act(() => { ref.current!.setView({ x: [10, 40] }) })
      act(() => { ref.current!.setSignal('s', 1) })
      expect(ref.current!.getView()).not.toBeNull()
      m.render(<Chart ref={ref} spec={B} panZoom />)
      expect(ref.current!.getView()?.x).toBeUndefined()
      expect(ref.current!.getSignals()).toEqual({})
      expect(markup(m.container)).toBe((() => { const f = mount(); f.render(<Chart spec={B} panZoom />); return markup(f.container) })())
    })

    variant.it(['interaction'], 'A -> B -> A: the zoom does not come back with the old spec either', () => {
      const ref = React.createRef<ChartHandle>()
      const m = mount()
      m.render(<Chart ref={ref} spec={A} panZoom />)
      act(() => { ref.current!.setView({ x: [10, 40] }) })
      const zoomed = markup(m.container)
      m.render(<Chart ref={ref} spec={B} panZoom />)
      m.render(<Chart ref={ref} spec={A} panZoom />)
      expect(markup(m.container)).toBe((() => { const f = mount(); f.render(<Chart spec={A} panZoom />); return markup(f.container) })())
      expect(markup(m.container)).not.toBe(zoomed)
    })
  })

  describe('a swap while the old spec is alive', () => {
    const base = { width: 200, height: 50, padding: 0, autosize: 'none' }
    const bar = (width: string) => ({ type: 'rect', from: { data: 't' }, encode: { update: { x: { value: 0 }, y: { value: 0 }, width: { signal: width }, height: { value: 10 }, fill: { value: 'steelblue' } } } })
    const data = [{ name: 't', values: [{ v: 1 }] }]
    /** a signal that a `timer` stream advances every 100 ms */
    const ticking = { ...base, signals: [{ name: 'n', value: 1, on: [{ events: { type: 'timer', throttle: 100 }, update: 'n + 1' }] }], data, marks: [bar('n * 10')] } as never
    const still = { ...base, signals: [{ name: 'n', value: 3 }], data, marks: [bar('n * 10'), { type: 'rect', from: { data: 't' }, encode: { update: { x: { value: 0 }, y: { value: 20 }, width: { value: 5 }, height: { value: 5 } } } }] } as never
    /** a different timer spec: same delay, same signal name, other arithmetic */
    const ticking2 = { ...base, signals: [{ name: 'n', value: 100, on: [{ events: { type: 'timer', throttle: 100 }, update: 'n + 7' }] }], data, marks: [bar('n')] } as never

    // d3-timer keeps one frame request in module state: a test that ends with a request pending under fake timers would
    // leave the next one waiting for a frame that never comes. So: unmount, let the pending frame run, then restore the clock.
    afterEach(() => {
      act(() => { for (const r of roots.splice(0)) r.unmount() })
      if (vi.isFakeTimers()) act(() => { vi.advanceTimersByTime(100) })
      vi.useRealTimers()
    })
    const fake = (): void => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance', 'Date'] }) }
    const width = (c: HTMLElement): string => c.querySelector('.mark-rect path')!.getAttribute('d')!

    variant.it(['signals'], 'a timer of the old spec stops with it: nothing keeps ticking behind a spec without timers', () => {
      fake()
      const onSignal = vi.fn()
      const m = mount()
      m.render(<Chart spec={ticking} onSignal={onSignal} />)
      act(() => { vi.advanceTimersByTime(350) })
      expect(onSignal).toHaveBeenCalledTimes(3)
      m.render(<Chart spec={still} onSignal={onSignal} />)
      onSignal.mockClear()
      act(() => { vi.advanceTimersByTime(60) }) // d3-timer's already requested frame runs once and finds nothing
      expect(vi.getTimerCount()).toBe(0)
      act(() => { vi.advanceTimersByTime(2000) })
      expect(onSignal).not.toHaveBeenCalled()
      expect(markup(m.container)).toBe(fresh(still))
    })

    variant.it(['signals'], 'a timer spec that follows a timer spec runs from its own initial state, in step with a fresh mount', () => {
      fake()
      const ref = React.createRef<ChartHandle>()
      const m = mount()
      m.render(<Chart ref={ref} spec={ticking} />)
      act(() => { vi.advanceTimersByTime(950) })
      m.render(<Chart ref={ref} spec={ticking2} />)
      const fref = React.createRef<ChartHandle>()
      const f = mount()
      f.render(<Chart ref={fref} spec={ticking2} />)
      expect(ref.current!.getSignals()).toEqual(fref.current!.getSignals())
      expect(markup(m.container)).toBe(markup(f.container))
      // one schedule: +7 per 100 ms in both, however long the first spec had been running
      for (let i = 1; i <= 4; i++) {
        act(() => { vi.advanceTimersByTime(100) })
        expect(ref.current!.getSignals().n).toBe(100 + 7 * i)
        expect(fref.current!.getSignals()).toEqual(ref.current!.getSignals())
        expect(markup(m.container)).toBe(markup(f.container))
      }
    })

    variant.it(['signals'], 'a swap back (A -> B -> A) restarts A from its initial state, as a fresh mount', () => {
      fake()
      const ref = React.createRef<ChartHandle>()
      const m = mount()
      m.render(<Chart ref={ref} spec={ticking} />)
      act(() => { vi.advanceTimersByTime(550) })
      const first = markup(m.container)
      expect(ref.current!.getSignals().n).toBeGreaterThan(1)
      m.render(<Chart ref={ref} spec={still} />)
      expect(ref.current!.getSignals().n).toBeUndefined() // the new chart's own state: no event has set a signal yet
      expect(markup(m.container)).toBe(fresh(still))
      m.render(<Chart ref={ref} spec={ticking} />)
      expect(markup(m.container)).toBe(fresh(ticking))
      expect(ref.current!.getSignals().n).toBeUndefined()
      act(() => { vi.advanceTimersByTime(250) })
      expect(ref.current!.getSignals().n).toBe(3) // restarted from its initial value: 2 ticks, not the 5 of the first run
      expect(first).not.toBe(markup(m.container))
    })

    // a pointer drag in flight: `between` keeps "the drag is on" per stream
    const dragging = (extra: unknown[]) => ({
      ...base, data,
      signals: [
        { name: 'moved', value: 0, on: [{ events: { type: 'mousemove', between: [{ type: 'mousedown' }, { type: 'mouseup' }] }, update: 'moved + 1' }] },
        ...extra,
      ],
      marks: [bar('50 + moved')],
    })
    const dragA = dragging([]) as never
    const dragB = dragging([{ name: 'other', value: 1 }]) as never
    const fire = (c: HTMLElement, type: string): void => { act(() => { c.querySelector('svg')!.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true })) }) }

    variant.it(['signals'], 'a drag in flight on the old spec is not a drag on the new one', () => {
      const ref = React.createRef<ChartHandle>()
      const m = mount()
      m.render(<Chart ref={ref} spec={dragA} />)
      fire(m.container, 'mousedown')
      fire(m.container, 'mousemove')
      expect(ref.current!.getSignals().moved).toBe(1)
      m.render(<Chart ref={ref} spec={dragB} />)
      expect(ref.current!.getSignals().moved).toBeUndefined()
      fire(m.container, 'mousemove') // no mousedown on this spec: a fresh mount ignores it
      expect(ref.current!.getSignals().moved).toBeUndefined()
      const f = mount()
      const fref = React.createRef<ChartHandle>()
      f.render(<Chart ref={fref} spec={dragB} />)
      fire(f.container, 'mousemove')
      expect(fref.current!.getSignals().moved).toBeUndefined()
      expect(markup(m.container)).toBe(markup(f.container))
    })
  })
})
