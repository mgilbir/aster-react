// @vitest-environment jsdom
/**
 * Every hook, every input position, as a literal rebuilt by every render (C72; the identity rule of docs/ARCHITECTURE.md, "The
 * React boundary"). A parent re-renders the hook 20 times; the hook must evaluate, post or flush no more than the first render
 * did, and render no more than once per parent render. A hook that loops is stopped by a render ceiling, so a regression fails
 * here instead of hanging.
 *
 * Each table below names EVERY option of its hook (the `Required<>` record type makes a missing option a compile error): a new
 * option is covered the day it is added. JSON-shaped values and functions are rebuilt by each call; stateful objects the rule
 * compares by identity (`random`, `textMetrics` providers, `dataPulse`, `worker`, `AbortSignal`) are hoisted, as the rule asks of
 * the host.
 */
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import type { VgSpec } from '@aster-charts/core'
import { useChart, type UseChartOptions } from './useChart'
import { useChartStream, type UseChartStreamOptions } from './useChartStream'
import { useChartWorkerStream, type ChartWorkerStreamOptions } from './useChartWorkerStream'
import { handleChartWorkerRequest, handleChartWorkerStreamRequest, registerWorkerTextMetrics, useChartWorker } from './worker'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const rows = [{ x: 1, y: 2 }, { x: 2, y: 3 }]
const spec = {
  width: 100, height: 50, padding: 0, autosize: 'none',
  signals: [{ name: 's', value: 1 }],
  data: [{ name: 'table', values: rows }],
  scales: [{ name: 'x', type: 'linear', domain: { data: 'table', field: 'x' }, range: 'width' }],
  marks: [{ type: 'symbol', from: { data: 'table' }, encode: { update: { x: { scale: 'x', field: 'x' }, y: { value: 5 } } } }],
} as unknown as VgSpec
/** The spec as a literal rebuilt by every render: a new object at every level, the same rows array (the rows are `data`'s job). */
const inlineSpec = (): VgSpec => ({ ...(JSON.parse(JSON.stringify({ ...spec, data: [] })) as object), data: [{ name: 'table', values: rows }] }) as VgSpec

// hoisted: the stateful objects the rule compares by identity
const random = (): number => 0.5
const textMetrics = { measure: (t: string, _f: string, size: number) => t.length * size * 0.5 }
const dataPulse = { table: { changed: [0] } }

/** A Worker double: real protocol handlers, answers on a later task, counts what it is sent. */
class FakeWorker {
  listeners = new Set<(e: MessageEvent) => void>()
  posted: Array<{ op?: string }> = []
  streams = new Map<number, never>()
  addEventListener(type: string, fn: (e: MessageEvent) => void): void { if (type === 'message') this.listeners.add(fn) }
  removeEventListener(_t: string, fn: (e: MessageEvent) => void): void { this.listeners.delete(fn) }
  postMessage(msg: { kind?: string; op?: string }): void {
    const data = structuredClone(msg)
    this.posted.push(data)
    const response = data.kind === 'stream'
      ? handleChartWorkerStreamRequest(data as never, this.streams as never)
      : handleChartWorkerRequest(data as never)
    setTimeout(() => { for (const fn of [...this.listeners]) fn({ data: structuredClone(response) } as MessageEvent) }, 0)
  }
  terminate(): void {}
}

// (the fake worker runs in this realm: the provider names it is sent resolve here)
registerWorkerTextMetrics('tm', textMetrics)

const RENDER_CEILING = 200
const PARENT_RENDERS = 20

/**
 * Render `useHook(options())` under a parent that re-renders `PARENT_RENDERS` times; returns the hook's render count and every
 * value it returned.
 */
async function drive<T>(useHook: () => T): Promise<{ renders: number; results: T[] }> {
  const results: T[] = []
  let renders = 0
  let bump: (() => void) | null = null
  function Probe(): null {
    renders++
    if (renders > RENDER_CEILING) throw new Error(`render loop: more than ${RENDER_CEILING} renders`)
    results.push(useHook())
    return null
  }
  function Parent(): React.ReactElement {
    const [, set] = React.useState(0)
    bump = () => set((n) => n + 1)
    return <Probe />
  }
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(<Parent />); await new Promise((r) => setTimeout(r, 20)) })
  for (let i = 0; i < PARENT_RENDERS; i++) await act(async () => { bump!(); await new Promise((r) => setTimeout(r, 2)) })
  await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
  act(() => { root.unmount() })
  return { renders, results }
}

afterEach(() => { document.body.innerHTML = '' })

/** A render count that is one per parent render, plus what the hook's own async work adds (bounded). */
const boundedRenders = (renders: number): void => {
  expect(renders).toBeGreaterThanOrEqual(PARENT_RENDERS + 1)
  expect(renders).toBeLessThanOrEqual(PARENT_RENDERS + 6)
}

describe('useChart: every RuntimeInput as an inline literal evaluates once', () => {
  const INLINE: { [K in keyof Required<UseChartOptions>]: () => UseChartOptions[K] } = {
    serialize: () => true,
    limits: () => ({ maxRows: 10_000 }),
    textMetrics: () => textMetrics,
    urlPolicy: () => ({ allow: () => true, protocols: ['https:'] }),
    urlData: () => 'allow',
    data: () => ({ table: rows }),
    width: () => 100,
    height: () => 50,
    signals: () => ({ s: 2 }),
    changedDatasets: () => ['table'],
    dataChanges: () => ({ table: [0] }),
    dataPulse: () => dataPulse,
    autoChanges: () => true,
    domainRaw: () => ({ x: [0, 10] }),
    logger: () => ({ error: () => {}, warn: () => {} }),
    random: () => random,
    containerSize: () => ({ width: 100, height: 50 }),
    measuredSize: () => ({ width: 100 }),
  }
  it.each(Object.keys(INLINE) as Array<keyof UseChartOptions>)('%s', async (key) => {
    const { renders, results } = await drive(() => useChart(inlineSpec(), { [key]: INLINE[key]() }))
    boundedRenders(renders)
    expect(results.at(-1)!.error).toBeNull()
    expect(new Set(results.map((r) => r.scene)).size).toBe(1)
  })
})

type WorkerOptions = NonNullable<Parameters<typeof useChartWorker>[1]>

describe.each([
  ['with a Worker', true],
  ['without a Worker', false],
] as const)('useChartWorker %s: every input as an inline literal posts once', (_name, withWorker) => {
  const INLINE: { [K in keyof Required<WorkerOptions>]: (w: FakeWorker) => WorkerOptions[K] } = {
    worker: (w) => (withWorker ? w as unknown as Worker : null),
    workerFactory: (w) => () => (withWorker ? w as unknown as Worker : null),
    timeoutMs: () => 10_000,
    width: () => 100,
    height: () => 50,
    containerSize: () => ({ width: 100, height: 50 }),
    measuredSize: () => ({ width: 100 }),
    data: () => ({ table: rows }),
    signals: () => ({ s: 2 }),
    domainRaw: () => ({ x: [0, 10] }),
    limits: () => ({ maxRows: 10_000 }),
    textMetrics: () => (withWorker ? 'tm' : { measure: () => 1 }),
    urlPolicy: () => ({ baseURL: 'https://example.com/', protocols: ['https:'] }),
    urlData: () => 'allow',
  }
  it.each(Object.keys(INLINE) as Array<keyof WorkerOptions>)('%s', async (key) => {
    const fake = new FakeWorker()
    // (the hook needs a worker for the Worker case: the worker prop, unless the case is the worker option itself)
    const base: WorkerOptions = key === 'worker' || key === 'workerFactory' ? {} : { worker: withWorker ? fake as unknown as Worker : null }
    let evaluations = 0
    const { renders, results } = await drive(() => {
      const r = useChartWorker(inlineSpec(), { ...base, [key]: INLINE[key](fake) })
      return r
    })
    evaluations = new Set(results.map((r) => r.scene ?? r.error)).size
    boundedRenders(renders)
    if (withWorker) expect(fake.posted.length).toBe(1)
    // (one answer: the first render's pending state, then one result)
    expect(evaluations).toBeLessThanOrEqual(2)
    expect(results.at(-1)!.pending).toBe(false)
  })
})

describe('useChartStream: every option as an inline literal keeps one stream', () => {
  const INLINE: { [K in keyof Required<UseChartStreamOptions>]: () => UseChartStreamOptions[K] } = {
    serialize: () => true,
    autoFlush: () => true,
    flushPolicy: () => 'microtask',
    capacity: () => 8,
    policy: () => 'drop-oldest',
    maxQueuedRows: () => 1000,
    limits: () => ({ maxRows: 10_000 }),
    textMetrics: () => textMetrics,
    initial: () => ({ signals: { s: 2 }, data: { table: rows }, logger: { error: () => {}, warn: () => {} } }),
  }
  it.each(Object.keys(INLINE) as Array<keyof UseChartStreamOptions>)('%s', async (key) => {
    const { renders, results } = await drive(() => useChartStream(inlineSpec(), { [key]: INLINE[key]() }))
    boundedRenders(renders)
    expect(results.at(-1)!.error).toBeNull()
    expect(new Set(results.map((r) => r.stream)).size).toBe(1)
    expect(new Set(results.map((r) => r.scene)).size).toBe(1)
  })
})

describe.each([
  ['with a Worker', true],
  ['without a Worker', false],
] as const)('useChartWorkerStream %s: every option as an inline literal starts one stream and flushes nothing', (_name, withWorker) => {
  const INLINE: { [K in keyof Required<ChartWorkerStreamOptions>]: (w: FakeWorker) => ChartWorkerStreamOptions[K] } = {
    worker: (w) => (withWorker ? w as unknown as Worker : null),
    workerFactory: (w) => () => (withWorker ? w as unknown as Worker : null),
    timeoutMs: () => 10_000,
    serialize: () => true,
    autoFlush: () => true,
    flushPolicy: () => 'microtask',
    capacity: () => 8,
    policy: () => 'drop-oldest',
    maxQueuedRows: () => 1000,
    limits: () => ({ maxRows: 10_000 }),
    textMetrics: () => (withWorker ? 'tm' : textMetrics),
    initial: () => ({ signals: { s: 2 }, data: { table: rows }, logger: { error: () => {}, warn: () => {} } }),
  }
  it.each(Object.keys(INLINE) as Array<keyof ChartWorkerStreamOptions>)('%s', async (key) => {
    const fake = new FakeWorker()
    const base: ChartWorkerStreamOptions = key === 'worker' || key === 'workerFactory' ? {} : { worker: withWorker ? fake as unknown as Worker : null }
    const { renders, results } = await drive(() => useChartWorkerStream(inlineSpec(), { ...base, [key]: INLINE[key](fake) }))
    boundedRenders(renders)
    const last = results.at(-1)!
    expect(last.error).toBeNull()
    expect(last.generation).toBe(1)
    expect(new Set(results.map((r) => r.scene).filter(Boolean)).size).toBe(1)
    if (withWorker) {
      expect(fake.posted.filter((p) => p.op === 'init')).toHaveLength(1)
      expect(fake.posted.filter((p) => p.op === 'flush')).toHaveLength(0)
    }
  })
})
