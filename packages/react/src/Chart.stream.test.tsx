// @vitest-environment jsdom
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ChartStream as CoreChartStream } from '@aster/core'
import { Chart } from './Chart'
import { ChartStream, ChartWorkerStream, type ChartStreamHandle } from './ChartStream'
import { handleWorkerMessage, type ChartWorkerStreamRequest } from './worker'
import { useChartStream, type UseChartStreamResult } from './useChartStream'
import type { ViewDomain } from './interaction'

const RECT = { left: 0, top: 0, width: 210, height: 110, right: 210, bottom: 110, x: 0, y: 0, toJSON: () => ({}) } as DOMRect

/** x scale is data-driven so streamed rows change it; `xscale` also proves non-x/y names. */
const dataSpec = (rows: Array<{ a: number; b: number }>, extra: Record<string, unknown> = {}): never => ({
  $schema: 'https://vega.github.io/schema/vega/v6.json',
  width: 200, height: 100, padding: 5, autosize: 'none',
  signals: [{ name: 'dotSize', value: 20 }],
  data: [{ name: 't', values: rows }],
  scales: [
    { name: 'xscale', type: 'linear', domain: { data: 't', field: 'a' }, range: 'width', nice: false, zero: false },
    { name: 'yscale', type: 'linear', domain: { data: 't', field: 'b' }, range: 'height', nice: false, zero: false },
  ],
  axes: [{ scale: 'xscale', orient: 'bottom' }, { scale: 'yscale', orient: 'left' }],
  marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: {
    x: { scale: 'xscale', field: 'a' }, y: { scale: 'yscale', field: 'b' }, size: { signal: 'dotSize' },
  } } }],
  ...extra,
}) as never

const base = [{ a: 0, b: 0 }, { a: 10, b: 10 }]

class FakeWorker {
  listeners = new Set<(event: unknown) => void>()
  streams = new Map<number, CoreChartStream>()
  posted: ChartWorkerStreamRequest[] = []
  addEventListener(type: string, fn: (event: unknown) => void): void { if (type === 'message') this.listeners.add(fn) }
  removeEventListener(type: string, fn: (event: unknown) => void): void { if (type === 'message') this.listeners.delete(fn) }
  postMessage(request: ChartWorkerStreamRequest): void {
    const wire = structuredClone(request)
    this.posted.push(wire)
    const response = handleWorkerMessage(wire, this.streams)
    // A real worker clones the response: functions and live scale maps never arrive.
    if (response) queueMicrotask(() => { for (const fn of this.listeners) fn({ data: structuredClone(response) }) })
  }
  terminate(): void { /* no-op */ }
}

const wait = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms))

function mount(node: React.ReactElement) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => { root.render(node) })
  const render = async (n: React.ReactElement): Promise<void> => { await act(async () => { root.render(n); await wait() }) }
  return { container, root, render, host: () => container.firstElementChild as HTMLElement }
}

const key = async (host: HTMLElement, k: string): Promise<void> => {
  await act(async () => { host.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })); await wait() })
}

/** Items of the first mark group of a given type (axis/legend groups come first in the scene). */
function markItems(scene: unknown, marktype: string): Array<Record<string, unknown>> {
  const walk = (node: unknown): Array<Record<string, unknown>> | null => {
    const g = node as { marktype?: string; role?: string; items?: unknown[] }
    if (g.marktype === marktype && g.role === 'mark') return g.items as Array<Record<string, unknown>>
    for (const c of g.items ?? []) { const hit = Array.isArray((c as { items?: unknown[] }).items) ? walk(c) : null; if (hit) return hit }
    return null
  }
  for (const n of (scene as { items: unknown[] }).items) { const hit = walk(n); if (hit) return hit }
  return []
}
const xDomain = (ref: React.RefObject<ChartStreamHandle | null>): number[] =>
  ((ref.current!.scene() as unknown as { __scaleMap: Map<string, { domain(): number[] }> }).__scaleMap.get('xscale')!).domain()
const scaleInfo = (scene: unknown, name: string): { domain: number[] } | undefined =>
  ((scene as Record<string, unknown>).__scaleInfo as Array<{ name: string; domain: number[] }> | undefined)?.find((s) => s.name === name)

beforeEach(() => {
  ;(Element.prototype as unknown as Record<string, unknown>).setPointerCapture = vi.fn()
  ;(Element.prototype as unknown as Record<string, unknown>).releasePointerCapture = vi.fn()
})
afterEach(() => { document.body.innerHTML = '' })

describe('<ChartStream> honours the Chart props its type accepts (C31)', () => {
  it('a controlled view reaches the stream: the scale domain and the SVG change', async () => {
    const ref = React.createRef<ChartStreamHandle>()
    const m = mount(<ChartStream ref={ref} spec={dataSpec(base)} width={200} height={100} view={null} panZoom />)
    await m.render(<ChartStream ref={ref} spec={dataSpec(base)} width={200} height={100} view={null} panZoom />)
    const before = m.container.querySelector('svg')!.outerHTML
    expect(xDomain(ref)).toEqual([0, 10])
    const view: ViewDomain = { x: [2, 4] }
    await m.render(<ChartStream ref={ref} spec={dataSpec(base)} width={200} height={100} view={view} panZoom />)
    expect(xDomain(ref)).toEqual([2, 4])
    expect(m.container.querySelector('svg')!.outerHTML).not.toBe(before)
    // clearing the view returns to the data-derived domain
    await m.render(<ChartStream ref={ref} spec={dataSpec(base)} width={200} height={100} view={null} panZoom />)
    expect(xDomain(ref)).toEqual([0, 10])
  })

  it('uncontrolled gestures re-evaluate inside the stream: + zooms, 0 resets', async () => {
    const ref = React.createRef<ChartStreamHandle>()
    const onViewChange = vi.fn()
    const m = mount(<ChartStream ref={ref} spec={dataSpec(base)} width={200} height={100} panZoom onViewChange={onViewChange} />)
    await m.render(<ChartStream ref={ref} spec={dataSpec(base)} width={200} height={100} panZoom onViewChange={onViewChange} />)
    const svgBefore = m.container.querySelector('svg')!.outerHTML
    await key(m.host(), '+')
    expect(onViewChange).toHaveBeenCalled()
    const [lo, hi] = xDomain(ref)
    expect(hi! - lo!).toBeLessThan(10)
    expect(m.container.querySelector('svg')!.outerHTML).not.toBe(svgBefore)
    await key(m.host(), '0')
    expect(xDomain(ref)).toEqual([0, 10])
    expect(m.container.querySelector('svg')!.outerHTML).toBe(svgBefore)
  })

  it('the signals prop drives the stream evaluation', async () => {
    const ref = React.createRef<ChartStreamHandle>()
    const first = <ChartStream ref={ref} spec={dataSpec(base)} width={200} height={100} signals={{ dotSize: 20 }} />
    const m = mount(first)
    await m.render(first)
    const sizeOf = (): number => markItems(ref.current!.scene(), 'symbol')[0]!.size as number
    expect(sizeOf()).toBe(20)
    await m.render(<ChartStream ref={ref} spec={dataSpec(base)} width={200} height={100} signals={{ dotSize: 90 }} />)
    expect(sizeOf()).toBe(90)
  })

  it('limits apply to the stream: a violation is reported, not ignored', async () => {
    const onStreamError = vi.fn()
    const m = mount(<ChartStream spec={dataSpec(base)} width={200} height={100} limits={{ maxItems: 1 }} onStreamError={onStreamError} />)
    await m.render(<ChartStream spec={dataSpec(base)} width={200} height={100} limits={{ maxItems: 1 }} onStreamError={onStreamError} />)
    expect(onStreamError).toHaveBeenCalled()
    expect(m.container.querySelector('[role="alert"]')).not.toBeNull()
  })

  it('limits tightened on a live stream take effect on the next flush', async () => {
    const onStreamError = vi.fn()
    const ref = React.createRef<ChartStreamHandle>()
    const node = (limits: { maxItems: number }) => <ChartStream ref={ref} spec={dataSpec(base)} width={200} height={100} limits={limits} onStreamError={onStreamError} />
    const m = mount(node({ maxItems: 1000 }))
    await m.render(node({ maxItems: 1000 }))
    expect(onStreamError).not.toHaveBeenCalled()
    await m.render(node({ maxItems: 1 }))
    expect(onStreamError).toHaveBeenCalled()
  })

  it('textMetrics reaches the stream evaluation', async () => {
    const calls: string[] = []
    const provider = { measure: (t: string) => { calls.push(t); return 4 } }
    const spec = dataSpec(base, { title: { text: 'Streamed title' } })
    const m = mount(<ChartStream spec={spec} width={200} height={100} textMetrics={provider} />)
    await m.render(<ChartStream spec={spec} width={200} height={100} textMetrics={provider} />)
    expect(calls).toContain('Streamed title')
  })

  it('a view change does not discard rows that were streamed in', async () => {
    const ref = React.createRef<ChartStreamHandle>()
    const m = mount(<ChartStream ref={ref} spec={dataSpec(base)} width={200} height={100} panZoom />)
    await m.render(<ChartStream ref={ref} spec={dataSpec(base)} width={200} height={100} panZoom />)
    await act(async () => { ref.current!.push({ append: { t: [{ a: 20, b: 5 }] } }); await wait() })
    await key(m.host(), '+')
    expect(markItems(ref.current!.scene(), 'symbol')).toHaveLength(3)
  })

  it('<ChartWorkerStream> routes view and limits through the worker', async () => {
    const worker = new FakeWorker()
    const ref = React.createRef<ChartStreamHandle>()
    const node = (view: ViewDomain | null) => (
      <ChartWorkerStream ref={ref} spec={dataSpec(base)} width={200} height={100} view={view} panZoom streamOptions={{ worker: worker as unknown as Worker }} />
    )
    const m = mount(node(null))
    await m.render(node(null))
    expect(scaleInfo(ref.current!.scene(), 'xscale')!.domain).toEqual([0, 10])
    await m.render(node({ x: [2, 4] }))
    expect(scaleInfo(ref.current!.scene(), 'xscale')!.domain).toEqual([2, 4])
    await m.render(node(null))
    expect(scaleInfo(ref.current!.scene(), 'xscale')!.domain).toEqual([0, 10])
    const limited = mount(<ChartWorkerStream spec={dataSpec(base)} width={200} height={100} limits={{ maxItems: 1 }} streamOptions={{ worker: new FakeWorker() as unknown as Worker }} />)
    await limited.render(<ChartWorkerStream spec={dataSpec(base)} width={200} height={100} limits={{ maxItems: 1 }} streamOptions={{ worker: new FakeWorker() as unknown as Worker }} />)
    expect(limited.container.querySelector('[role="alert"]')).not.toBeNull()
  })
})

describe('pan/zoom/brush use the streamed or supplied data, not just the spec (C30)', () => {
  const sliderMax = (c: HTMLElement): string | null =>
    c.querySelector('[data-a11y-kind="axis"][role="slider"][aria-label^="X-axis"]')?.getAttribute('aria-valuemax') ?? null

  it('a stream: after appending a far point, + zooms around the NEW extent', async () => {
    const ref = React.createRef<ChartStreamHandle>()
    const onViewChange = vi.fn()
    const node = <ChartStream ref={ref} spec={dataSpec(base)} width={200} height={100} panZoom onViewChange={onViewChange} />
    const m = mount(node)
    await m.render(node)
    await act(async () => { ref.current!.push({ append: { t: [{ a: 1000, b: 5 }] } }); await wait() })
    expect(sliderMax(m.container)).toBe('1000')
    await key(m.host(), '+')
    const view = onViewChange.mock.calls.at(-1)![0] as ViewDomain
    expect(view.x![1] - view.x![0]).toBeCloseTo(1000 / 1.5, 0)
  })

  it('a worker stream: scales survive the clone, so brush and the a11y slider see the new extent', async () => {
    const worker = new FakeWorker()
    const ref = React.createRef<ChartStreamHandle>()
    const onSelect = vi.fn()
    const node = <ChartWorkerStream ref={ref} spec={dataSpec(base)} width={200} height={100} panZoom onSelect={onSelect} streamOptions={{ worker: worker as unknown as Worker }} />
    const m = mount(node)
    await m.render(node)
    m.host().getBoundingClientRect = () => RECT
    await act(async () => { ref.current!.push({ append: { t: [{ a: 1000, b: 5 }] } }); await wait() })
    expect(sliderMax(m.container)).toBe('1000')
    const overlay = m.container.querySelector('[data-testid="chart-brush-overlay"]')!
    act(() => { overlay.dispatchEvent(new PointerEvent('pointerdown', { clientX: 5, clientY: 5, pointerId: 1, bubbles: true })) })
    act(() => { overlay.dispatchEvent(new PointerEvent('pointermove', { clientX: 105, clientY: 55, pointerId: 1, bubbles: true })) })
    act(() => { overlay.dispatchEvent(new PointerEvent('pointerup', { clientX: 105, clientY: 55, pointerId: 1, bubbles: true })) })
    const interval = onSelect.mock.calls.at(-1)![0] as { x: [number, number] }
    // 100px of a 200px plot spanning 0..1000 is ~500 data units, not ~50.
    expect(interval.x[1] - interval.x[0]).toBeGreaterThan(400)
    // and zooming works from the streamed base
    await key(m.host(), '+')
    const info = (m.host() as HTMLElement).getAttribute('data-aster-view')
    expect(info).toBe('zoomed')
    expect(scaleInfo(ref.current!.scene(), 'xscale')!.domain[1]! - scaleInfo(ref.current!.scene(), 'xscale')!.domain[0]!).toBeLessThan(1000)
  })

  it('<Chart data=...>: the keyboard zoom works when the rows come from the data prop', async () => {
    const onViewChange = vi.fn()
    const noRows = dataSpec([]) as Record<string, unknown>
    const m = mount(<Chart spec={noRows as never} data={{ t: [{ a: 0, b: 0 }, { a: 500, b: 5 }] }} width={200} height={100} panZoom onViewChange={onViewChange} />)
    await act(async () => { await wait() })
    await key(m.host(), '+')
    expect(onViewChange).toHaveBeenCalled()
    const view = onViewChange.mock.calls.at(-1)![0] as ViewDomain | null
    expect(view).not.toBeNull()
    expect(view!.x![1] - view!.x![0]).toBeCloseTo(500 / 1.5, 0)
  })

  it('a chart that MOUNTS zoomed, with rows only in the data prop, still pans (base from a second evaluation)', async () => {
    const onViewChange = vi.fn()
    const noRows = dataSpec([]) as Record<string, unknown>
    const m = mount(<Chart spec={noRows as never} data={{ t: [{ a: 0, b: 0 }, { a: 500, b: 5 }] }} width={200} height={100} panZoom view={{ x: [100, 200] }} onViewChange={onViewChange} />)
    await act(async () => { await wait() })
    await key(m.host(), 'ArrowRight')
    const view = onViewChange.mock.calls.at(-1)![0] as ViewDomain
    expect(view.x![0]).toBeGreaterThan(100)
    // zooming out is capped by the data extent (0..500), proving the base came from the data prop
    for (let i = 0; i < 20; i++) await key(m.host(), '-')
    const out = onViewChange.mock.calls.at(-1)![0] as ViewDomain | null
    expect(out?.x == null || out.x[1] - out.x[0] <= 500 + 1e-6).toBe(true)
  })

  it('the base domain stays the data extent while zoomed (reset returns to it)', async () => {
    const ref = React.createRef<import('./Chart').ChartHandle>()
    const m = mount(<Chart ref={ref} spec={dataSpec(base)} width={200} height={100} panZoom />)
    await act(async () => { await wait() })
    act(() => { ref.current!.setView({ x: [2, 4], y: [2, 4] }) })
    await key(m.host(), 'ArrowRight')
    expect(ref.current!.getView()!.x![0]).toBeGreaterThan(2)
    await key(m.host(), '0')
    expect(ref.current!.getView()).toBeNull()
  })
})

describe('stream component hygiene (C92)', () => {
  it('onStreamError is reported once per error, not once per render of an inline callback', async () => {
    const calls: Error[] = []
    const node = (i: number) => <ChartStream spec={dataSpec(base)} width={200} height={100} limits={{ maxItems: 1 }} className={`r${i}`} onStreamError={(e) => { calls.push(e) }} />
    const m = mount(node(0))
    await m.render(node(0))
    for (let i = 1; i < 4; i++) await m.render(node(i))
    expect(calls).toHaveLength(1)
  })

  it('the imperative handle keeps its identity across parent re-renders', async () => {
    const seen = new Set<unknown>()
    const ref = (h: ChartStreamHandle | null): void => { if (h) seen.add(h) }
    const node = (i: number) => <ChartStream ref={ref} spec={dataSpec(base)} width={200} height={100} className={`r${i}`} />
    const m = mount(node(0))
    for (let i = 1; i < 4; i++) await m.render(node(i))
    expect(seen.size).toBe(1)
  })
})

describe('streams survive a new-but-equal spec (C32)', () => {
  it('useChartStream keeps pushed rows across re-renders with an equal inline spec', async () => {
    let result: UseChartStreamResult | null = null
    let bump = (): void => {}
    function Probe(): React.ReactElement {
      const [, set] = React.useState(0)
      bump = () => set((n) => n + 1)
      result = useChartStream(dataSpec(base), {})
      return <div />
    }
    const m = mount(<Probe />)
    await m.render(<Probe />)
    await act(async () => { result!.push({ append: { t: [{ a: 3, b: 3 }, { a: 4, b: 4 }] } }); await wait() })
    const rows = (): number => markItems(result!.scene, 'symbol').length
    expect(rows()).toBe(4)
    const stream = result!.stream
    await act(async () => { bump(); await wait() })
    await act(async () => { bump(); await wait() })
    expect(result!.stream).toBe(stream)
    expect(rows()).toBe(4)
  })

  it('a spec whose content really changed restarts the stream', async () => {
    let result: UseChartStreamResult | null = null
    let cur = dataSpec(base)
    function Probe(): React.ReactElement { result = useChartStream(cur, {}); return <div /> }
    const m = mount(<Probe />)
    await m.render(<Probe />)
    const first = result!.stream
    cur = dataSpec([{ a: 1, b: 1 }])
    await m.render(<Probe />)
    expect(result!.stream).not.toBe(first)
    expect(markItems(result!.scene, 'symbol')).toHaveLength(1)
  })

  it('<ChartStream> keeps its rows when the parent re-renders with a rebuilt spec literal', async () => {
    const ref = React.createRef<ChartStreamHandle>()
    const node = () => <ChartStream ref={ref} spec={dataSpec(base)} width={200} height={100} />
    const m = mount(node())
    await m.render(node())
    await act(async () => { ref.current!.push({ append: { t: [{ a: 3, b: 3 }, { a: 4, b: 4 }] } }); await wait() })
    expect(m.container.querySelectorAll('svg .mark-symbol path')).toHaveLength(4)
    await m.render(node())
    await m.render(node())
    expect(m.container.querySelectorAll('svg .mark-symbol path')).toHaveLength(4)
  })

  it('<Chart> does not recompile or re-evaluate for an equal spec literal', async () => {
    const ref = React.createRef<import('./Chart').ChartHandle>()
    const m = mount(<Chart ref={ref} spec={dataSpec(base, { signals: [{ name: 'dotSize', value: 20 }] })} width={200} height={100} />)
    const first = ref.current!.getScene()
    expect(first).not.toBeNull()
    // Each literal carries NEW nested objects (the base rows array is shared, as in a typical app).
    for (let i = 0; i < 3; i++) await m.render(<Chart ref={ref} spec={dataSpec(base, { signals: [{ name: 'dotSize', value: 20 }] })} width={200} height={100} />)
    expect(ref.current!.getScene()).toBe(first)
  })
})
