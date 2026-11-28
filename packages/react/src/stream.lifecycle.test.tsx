// @vitest-environment jsdom
/**
 * The lifecycle of both stream hooks, on every path (useChartStream; useChartWorkerStream with a Worker and without one) and
 * both flush alignments:
 *
 * - C159: `close()` then a new spec: the new stream is open and flushes (a cancelled animation frame does not leave the hook
 *   believing a flush is scheduled, and closing does not pause the hook);
 * - C506: after unmount, and through the handle of a replaced stream, `push` answers false; StrictMode's re-run of the effects
 *   keeps the stream;
 * - C632: `flush()` with nothing queued, called from an effect without dependencies, does not re-render;
 * - C296: a change of `limits` (by content) reaches the live stream; a textMetrics change applies from the next flush.
 */
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import type { SpecLimits, StreamBatch, VgSpec } from '@aster-charts/core'
import { handleChartWorkerStreamRequest, type ChartWorkerStreamRequest } from './worker-impl'
import { useChartStream } from './useChartStream'
import { useChartWorkerStream } from './useChartWorkerStream'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const specOf = (width = 200, text = false): VgSpec => ({
  // (a text mark is measured when the view is sized to its bounds: autosize pad)
  width, height: 50, padding: 0, autosize: text ? 'pad' : 'none',
  data: [{ name: 't', values: [{ x: 0 }] }],
  marks: text
    ? [{ type: 'text', from: { data: 't' }, encode: { update: { x: { field: 'x' }, y: { value: 5 }, text: { value: 'hello' } } } }]
    : [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { field: 'x' }, y: { value: 5 } } } }],
}) as unknown as VgSpec

class FakeWorker {
  listeners = new Set<(e: MessageEvent) => void>()
  posted: ChartWorkerStreamRequest[] = []
  streams = new Map<number, never>()
  addEventListener(type: string, fn: (e: MessageEvent) => void): void { if (type === 'message') this.listeners.add(fn) }
  removeEventListener(_t: string, fn: (e: MessageEvent) => void): void { this.listeners.delete(fn) }
  postMessage(msg: ChartWorkerStreamRequest): void {
    const data = structuredClone(msg)
    this.posted.push(data)
    const r = handleChartWorkerStreamRequest(data, this.streams as never)
    setTimeout(() => { for (const fn of [...this.listeners]) fn({ data: structuredClone(r) } as MessageEvent) }, 0)
  }
  terminate(): void {}
}

/** What the tests need of either hook. */
interface Common {
  push: (b: StreamBatch) => boolean
  flush: () => unknown
  close: () => void
  paused: boolean
  error: Error | null
  rows: number
}

type Path = 'useChartStream' | 'useChartWorkerStream (Worker)' | 'useChartWorkerStream (no Worker)'
const PATHS: Path[] = ['useChartStream', 'useChartWorkerStream (Worker)', 'useChartWorkerStream (no Worker)']

function useCommon(path: Path, spec: VgSpec, options: { flushPolicy?: 'microtask' | 'raf'; limits?: SpecLimits; textMetrics?: { measure: () => number }; worker?: FakeWorker }): Common {
  const rowsOf = (scene: unknown): number => ((scene as { items: Array<{ items?: unknown[] }> } | null)?.items[0]?.items?.length ?? 0)
  if (path === 'useChartStream') {
    const r = useChartStream(spec, { flushPolicy: options.flushPolicy, limits: options.limits, textMetrics: options.textMetrics })
    return { push: r.push, flush: r.flush, close: r.close, paused: r.paused, error: r.error, rows: rowsOf(r.scene) }
  }
  const r = useChartWorkerStream(spec, {
    flushPolicy: options.flushPolicy, limits: options.limits,
    worker: path === 'useChartWorkerStream (Worker)' ? options.worker as unknown as Worker : null,
    ...(path === 'useChartWorkerStream (no Worker)' && options.textMetrics ? { textMetrics: options.textMetrics } : {}),
  })
  return { push: r.push, flush: r.flush, close: r.close, paused: r.paused, error: r.error, rows: rowsOf(r.scene) }
}

const wait = (ms = 30): Promise<void> => act(async () => { await new Promise((r) => setTimeout(r, ms)) })

function mountHook(path: Path, init: { flushPolicy?: 'microtask' | 'raf'; limits?: SpecLimits }, strict = false) {
  const worker = new FakeWorker()
  let latest!: Common
  let setProps!: (p: { width?: number; limits?: SpecLimits }) => void
  function Probe(): null {
    const [p, set] = React.useState<{ width?: number; limits?: SpecLimits }>({ limits: init.limits })
    setProps = set
    latest = useCommon(path, specOf(p.width ?? 200), { flushPolicy: init.flushPolicy, limits: p.limits, worker })
    return null
  }
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  act(() => { root.render(strict ? <React.StrictMode><Probe /></React.StrictMode> : <Probe />) })
  return { get: () => latest, set: (p: { width?: number; limits?: SpecLimits }) => act(() => { setProps(p) }), root, worker }
}

afterEach(() => { document.body.innerHTML = '' })

describe.each(PATHS)('%s', (path) => {
  it.each(['microtask', 'raf'] as const)('C159 (%s): close() then a new spec: the new stream is open, flushes, and the hook is not paused', async (flushPolicy) => {
    const h = mountHook(path, { flushPolicy })
    await wait()
    // a push schedules a flush (an animation frame under raf), and close() cancels it
    act(() => { h.get().push({ append: { t: [{ x: 1 }] } }); h.get().close() })
    expect(h.get().push({ append: { t: [{ x: 2 }] } })).toBe(false)
    h.set({ width: 201 })
    await wait()
    expect(h.get().paused).toBe(false)
    act(() => { expect(h.get().push({ append: { t: [{ x: 3 }, { x: 4 }] } })).toBe(true) })
    await wait(60)
    expect(h.get().rows).toBe(3)
    act(() => { h.root.unmount() })
  })

  it('C506: after unmount push answers false; the handle of a replaced stream answers false', async () => {
    const h = mountHook(path, {})
    await wait()
    const before = h.get().push
    h.set({ width: 201 })
    await wait()
    if (before !== h.get().push) expect(before({ append: { t: [{ x: 1 }] } })).toBe(false)
    const push = h.get().push
    expect(push({ append: { t: [{ x: 1 }] } })).toBe(true)
    act(() => { h.root.unmount() })
    await wait(5)
    for (let i = 0; i < 50; i++) expect(push({ append: { t: [{ x: i }] } })).toBe(false)
  })

  it('C506: StrictMode re-runs the effects and keeps the stream open', async () => {
    const h = mountHook(path, {}, true)
    await wait()
    act(() => { expect(h.get().push({ append: { t: [{ x: 1 }, { x: 2 }] } })).toBe(true) })
    await wait(60)
    expect(h.get().rows).toBe(3)
    act(() => { h.root.unmount() })
  })

  it('C296: a tighter `limits` reaches the live stream; an equal inline literal is no change', async () => {
    const h = mountHook(path, { limits: { maxRows: 1000 } })
    await wait()
    h.set({ limits: { maxRows: 1000 } })
    await wait()
    expect(h.get().error).toBeNull()
    h.set({ limits: { maxRows: 2 } })
    await wait()
    act(() => { h.get().push({ append: { t: Array.from({ length: 50 }, (_, x) => ({ x })) } }) })
    await wait(60)
    expect(h.get().error?.message).toMatch(/maxRows/)
    // and removing it removes the budget: the next flush draws
    h.set({ limits: undefined })
    await wait()
    act(() => { h.get().push({ append: { t: [{ x: 99 }] } }) })
    await wait(60)
    expect(h.get().error).toBeNull()
    act(() => { h.root.unmount() })
  })
})

describe('C632: flush() with nothing queued does not re-render', () => {
  it.each(PATHS)('%s', async (path) => {
    const worker = new FakeWorker()
    let renders = 0
    function Probe(): null {
      renders++
      if (renders > 100) throw new Error('render loop')
      const r = useCommon(path, specOf(), { worker })
      React.useEffect(() => { r.flush() })
      return null
    }
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => { root.render(<Probe />); await new Promise((r) => setTimeout(r, 50)) })
    expect(renders).toBeLessThanOrEqual(4)
    act(() => { root.unmount() })
  })
})

describe('C296: a textMetrics change applies from the next flush, and an inline provider does not flush by itself', () => {
  it.each(['useChartStream', 'useChartWorkerStream (no Worker)'] as const)('%s', async (path) => {
    const narrow = { measure: () => 1 }
    let latest!: Common & { scene?: unknown }
    let setTm!: (tm: { measure: () => number }) => void
    let renders = 0
    function Probe({ inline }: { inline: boolean }): null {
      renders++
      if (renders > 200) throw new Error('render loop')
      const [tm, set] = React.useState(narrow)
      setTm = set
      latest = useCommon(path, specOf(200, true), { textMetrics: inline ? { measure: tm.measure } : tm })
      return null
    }
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    // an inline provider rebuilt by every render: bounded renders (it rides on flushes, it does not cause them)
    await act(async () => { root.render(<Probe inline />); await new Promise((r) => setTimeout(r, 50)) })
    act(() => { setTm({ measure: () => 2 }) })
    await wait(50)
    expect(renders).toBeLessThan(10)
    act(() => { root.unmount() })
    // a new provider: the next flush measures with it
    renders = 0
    const host2 = document.createElement('div')
    document.body.appendChild(host2)
    const root2 = createRoot(host2)
    let measured = 0
    const spy = { measure: () => { measured++; return 100 } }
    await act(async () => { root2.render(<Probe inline={false} />); await new Promise((r) => setTimeout(r, 30)) })
    act(() => { setTm(spy) })
    await wait()
    expect(measured).toBe(0) // (not flushed by the change itself)
    act(() => { latest.push({ append: { t: [{ x: 1 }] } }) })
    await wait(50)
    expect(measured).toBeGreaterThan(0)
    act(() => { root2.unmount() })
  })
})
