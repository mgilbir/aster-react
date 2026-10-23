// @vitest-environment jsdom
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { AsterLimitError, AsterStreamBackpressureError, type ChartStream as CoreStream } from '@aster/core'
import { ChartStream, ChartWorkerStream, type ChartStreamHandle } from './ChartStream'
import { useChartStream, type UseChartStreamResult } from './useChartStream'
import { useChartWorkerStream, type WorkerChartStreamResult } from './useChartWorkerStream'
import {
  handleChartWorkerRequest, handleWorkerMessage, registerWorkerUrlPolicy, useChartWorker,
  type ChartWorkerStreamRequest,
} from './worker'
import { forEachVariant } from './testing/variants'

const wait = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms))
const rows = (n: number, from = 0) => Array.from({ length: n }, (_, i) => ({ x: from + i, y: from + i }))
const spec = (n = 2): never => ({
  width: 100, height: 100, padding: 0, autosize: 'none',
  data: [{ name: 't', values: rows(n) }],
  scales: [{ name: 'x', type: 'linear', domain: [0, 100], range: 'width' }, { name: 'y', type: 'linear', domain: [0, 100], range: 'height' }],
  marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'y' } } } }],
}) as never

class FakeWorker {
  listeners = new Map<string, Set<(e: unknown) => void>>()
  streams = new Map<number, CoreStream>()
  posted: ChartWorkerStreamRequest[] = []
  addEventListener(t: string, fn: (e: unknown) => void): void { (this.listeners.get(t) ?? this.listeners.set(t, new Set()).get(t)!).add(fn) }
  removeEventListener(t: string, fn: (e: unknown) => void): void { this.listeners.get(t)?.delete(fn) }
  postMessage(request: ChartWorkerStreamRequest): void {
    const wire = structuredClone(request)
    this.posted.push(wire)
    const response = handleWorkerMessage(wire, this.streams)
    if (response) queueMicrotask(() => { for (const fn of this.listeners.get('message') ?? []) fn({ data: structuredClone(response) }) })
  }
  terminate(): void { /* no-op */ }
}

function probe<T>(useIt: () => T): { result: () => T; root: ReturnType<typeof createRoot> } {
  let cur: T
  function P(): React.ReactElement { cur = useIt(); return <div /> }
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  act(() => { root.render(<P />) })
  return { result: () => cur, root }
}
afterEach(() => { document.body.innerHTML = '' })

describe('a failed flush is reported once, then the queue is discarded (useChartStream)', () => {
  it('error + flushFailure surface, discard runs, later flushes and pushes recover', async () => {
    const m = probe(() => useChartStream(spec(), { limits: { maxItems: 5 } }))
    await act(async () => { await wait() })
    expect(m.result().error).toBeNull()
    await act(async () => { m.result().push({ append: { t: rows(10, 10) } }); await wait() })
    const r = m.result()
    expect(r.error).toBeInstanceOf(AsterLimitError)
    expect(r.flushFailure).toEqual({ batches: 1, queuedRows: 10, discarded: 1 })
    expect(r.stream.stats().depth).toBe(0)
    expect(r.stream.stats().dropped).toBe(1)
    // another flush does not rethrow the same batch forever
    await act(async () => { m.result().flush(); await wait() })
    // the earlier scene is intact and a valid push recovers
    await act(async () => { m.result().push({ append: { t: rows(1, 50) } }); await wait() })
    expect(m.result().error).toBeNull()
    expect(m.result().flushFailure).toBeNull()
    expect(m.result().scene).not.toBeNull()
  })

  it('<ChartStream> reports the error once, with the failure info', async () => {
    const onStreamError = vi.fn()
    const ref = React.createRef<ChartStreamHandle>()
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const node = (i: number) => <ChartStream ref={ref} spec={spec()} width={100} height={100} className={`r${i}`} streamOptions={{ limits: { maxItems: 5 } }} onStreamError={onStreamError} />
    await act(async () => { root.render(node(0)); await wait() })
    await act(async () => { ref.current!.push({ append: { t: rows(10, 10) } }); await wait() })
    for (let i = 1; i < 4; i++) await act(async () => { root.render(node(i)); await wait() })
    await act(async () => { ref.current!.flush(); await wait() })
    expect(onStreamError).toHaveBeenCalledTimes(1)
    expect(onStreamError.mock.calls[0]![0]).toBeInstanceOf(AsterLimitError)
    expect(onStreamError.mock.calls[0]![1]).toEqual({ batches: 1, queuedRows: 10, discarded: 1 })
  })
})

describe('maxQueuedRows reaches the stream (hooks)', () => {
  it('useChartStream', async () => {
    const m = probe(() => useChartStream(spec(), { maxQueuedRows: 5 }))
    await act(async () => { await wait() })
    expect(m.result().stats().maxQueuedRows).toBe(5)
    expect(m.result().push({ append: { t: rows(10) } })).toBe(false)
    expect(m.result().push({ append: { t: rows(3) } })).toBe(true)
  })

  it.each(['coalesce', 'drop-newest', 'drop-oldest'] as const)('useChartWorkerStream (%s): the producer buffer applies the row bound and the worker gets it', async (policy) => {
    const worker = new FakeWorker()
    const m = probe(() => useChartWorkerStream(spec(), { worker: worker as unknown as Worker, policy, maxQueuedRows: 5, autoFlush: false }))
    await act(async () => { await wait() })
    expect(worker.posted.find((p) => p.op === 'init')!.options).toMatchObject({ maxQueuedRows: 5 })
    let a = false; let b = false; let big = true
    act(() => {
      a = m.result().push({ append: { t: rows(3) } })
      b = m.result().push({ append: { t: rows(3, 3) } })
      big = m.result().push({ append: { t: rows(6, 6) } })
    })
    expect(a).toBe(true)
    expect(big).toBe(false) // a single batch above the bound is always refused
    if (policy === 'drop-oldest') { expect(b).toBe(true); expect(m.result().depth()).toBe(1) }
    else if (policy === 'coalesce') { expect(b).toBe(false); expect(m.result().depth()).toBe(1) }
    else { expect(b).toBe(false); expect(m.result().depth()).toBe(1) }
  })

  it('policy "error" throws AsterStreamBackpressureError(rows) from the producer buffer', async () => {
    const worker = new FakeWorker()
    const m = probe(() => useChartWorkerStream(spec(), { worker: worker as unknown as Worker, policy: 'error', maxQueuedRows: 5, autoFlush: false }))
    await act(async () => { await wait() })
    let err: unknown
    act(() => { try { m.result().push({ append: { t: rows(9) } }) } catch (e) { err = e } })
    expect(err).toBeInstanceOf(AsterStreamBackpressureError)
    expect((err as AsterStreamBackpressureError).bound).toBe('rows')
  })
})

describe('worker stream: failed flush is reported and discarded in the worker', () => {
  it('protocol: the response carries failure info and the next flush works', () => {
    const streams = new Map<number, CoreStream>()
    handleWorkerMessage({ kind: 'stream', id: 1, streamId: 1, op: 'init', spec: spec(), options: { limits: { maxItems: 5 } } }, streams)
    const bad = handleWorkerMessage({ kind: 'stream', id: 2, streamId: 1, op: 'flush', batches: [{ append: { t: rows(10, 10) } }] }, streams) as { error?: { code?: string }; failure?: unknown }
    expect(bad.error?.code).toBe('ASTER_LIMIT')
    expect(bad.failure).toEqual({ batches: 1, queuedRows: 10, discarded: 1 })
    const ok = handleWorkerMessage({ kind: 'stream', id: 3, streamId: 1, op: 'flush', batches: [{ append: { t: rows(1, 50) } }] }, streams) as { error?: unknown; scene?: unknown }
    expect(ok.error).toBeUndefined()
    expect(ok.scene).toBeTruthy()
  })

  it('hook: AsterLimitError + flushFailure, then recovery', async () => {
    const worker = new FakeWorker()
    const m = probe(() => useChartWorkerStream(spec(), { worker: worker as unknown as Worker, limits: { maxItems: 5 } }))
    await act(async () => { await wait() })
    await act(async () => { m.result().push({ append: { t: rows(10, 10) } }); await wait() })
    expect(m.result().error).toBeInstanceOf(AsterLimitError)
    expect(m.result().flushFailure).toEqual({ batches: 1, queuedRows: 10, discarded: 1 })
    await act(async () => { m.result().push({ append: { t: rows(1, 50) } }); await wait() })
    expect(m.result().error).toBeNull()
    expect(m.result().flushFailure).toBeNull()
  })

  it('local fallback (no Worker) recovers the same way', async () => {
    const m = probe((): WorkerChartStreamResult => useChartWorkerStream(spec(), { limits: { maxItems: 5 } }))
    await act(async () => { await wait() })
    await act(async () => { m.result().push({ append: { t: rows(10, 10) } }); await wait() })
    expect(m.result().flushFailure).toEqual({ batches: 1, queuedRows: 10, discarded: 1 })
    await act(async () => { m.result().push({ append: { t: rows(1, 50) } }); await wait() })
    expect(m.result().error).toBeNull()
  })

  it('<ChartWorkerStream> reports once with the failure info', async () => {
    const worker = new FakeWorker()
    const onStreamError = vi.fn()
    const ref = React.createRef<ChartStreamHandle>()
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => { root.render(<ChartWorkerStream ref={ref} spec={spec()} width={100} height={100} limits={{ maxItems: 5 }} streamOptions={{ worker: worker as unknown as Worker }} onStreamError={onStreamError} />); await wait() })
    await act(async () => { ref.current!.push({ append: { t: rows(10, 10) } }); await wait() })
    expect(onStreamError).toHaveBeenCalledTimes(1)
    expect(onStreamError.mock.calls[0]![1]).toMatchObject({ batches: 1, discarded: 1 })
  })
})

describe('urlPolicy over the worker protocol (C93)', () => {
  const imgSpec = {
    width: 80, height: 40, padding: 0, autosize: 'none',
    data: [{ name: 't', values: [{ u: 'https://good.example/a.png', x: 0 }, { u: 'https://evil.example/b.png', x: 20 }] }],
    marks: [{ type: 'image', from: { data: 't' }, encode: { update: { url: { field: 'u' }, x: { field: 'x' }, y: { value: 0 }, width: { value: 10 }, height: { value: 10 } } } }],
  } as never
  const denied: string[] = []
  registerWorkerUrlPolicy('goodOnly', { allow: (u) => u.host === 'good.example', onDeny: (u) => { denied.push(u) } })

  it('data fields travel as data, functions by registered name', () => {
    denied.length = 0
    const r = handleChartWorkerRequest({ id: 1, spec: imgSpec, input: { urlPolicy: { hooks: 'goodOnly' } } })
    expect(r.error).toBeUndefined()
    expect(denied).toEqual(['https://evil.example/b.png'])
    const bad = handleChartWorkerRequest({ id: 2, spec: imgSpec, input: { urlPolicy: { hooks: 'nope' } } })
    expect(bad.error?.message).toMatch(/unknown url-policy hooks "nope"/)
    const protocols = handleChartWorkerRequest({ id: 3, spec: imgSpec, input: { urlPolicy: { protocols: ['http:'] } } })
    expect(protocols.error?.code).toBe('ASTER_URL_DENIED')
    expect(() => structuredClone({ id: 3, spec: imgSpec, input: { urlPolicy: { hooks: 'goodOnly', protocols: ['https:'] } } })).not.toThrow()
  })

  it('useChartWorker: functions with a Worker are an explicit error; hooks by name work; an object works in sync mode', async () => {
    const worker = new FakeWorker()
    const withFn = probe(() => useChartWorker(imgSpec, { worker: worker as unknown as Worker, urlPolicy: { allow: () => true } }))
    await act(async () => { await wait() })
    expect(withFn.result().error?.message).toMatch(/registerWorkerUrlPolicy/)
    expect(worker.posted).toHaveLength(0)
    denied.length = 0
    const sync = probe(() => useChartWorker(imgSpec, { urlPolicy: { hooks: 'goodOnly' } }))
    await act(async () => { await wait() })
    expect(sync.result().error).toBeNull()
    expect(denied).toContain('https://evil.example/b.png')
    const obj = probe(() => useChartWorker(imgSpec, { urlPolicy: { allow: () => false } }))
    await act(async () => { await wait() })
    expect(obj.result().error).toMatchObject({ code: 'ASTER_URL_DENIED' })
  })

  it('stream init carries it (hooks by name)', () => {
    denied.length = 0
    const streams = new Map<number, CoreStream>()
    const r = handleWorkerMessage({ kind: 'stream', id: 1, streamId: 1, op: 'init', spec: imgSpec, options: { initial: { urlPolicy: { hooks: 'goodOnly' } } } }, streams) as { error?: unknown }
    expect(r.error).toBeUndefined()
    expect(denied).toEqual(['https://evil.example/b.png'])
  })

  it('<ChartWorkerStream urlPolicy> with a Worker: functions are an explicit error, hooks work', async () => {
    const worker = new FakeWorker()
    const onStreamError = vi.fn()
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => { root.render(<ChartWorkerStream spec={imgSpec} width={80} height={40} urlPolicy={{ allow: () => true }} streamOptions={{ worker: worker as unknown as Worker }} onStreamError={onStreamError} />); await wait() })
    expect(onStreamError.mock.calls[0]![0].message).toMatch(/registerWorkerUrlPolicy/)
    denied.length = 0
    const w2 = new FakeWorker()
    await act(async () => { root.render(<ChartWorkerStream spec={imgSpec} width={80} height={40} urlPolicy={{ hooks: 'goodOnly' }} streamOptions={{ worker: w2 as unknown as Worker }} />); await wait() })
    expect(denied).toContain('https://evil.example/b.png')
  })
})

describe('limits meters flow through the React surface', () => {
  const gen = { width: 50, height: 50, padding: 0, autosize: 'none', data: [{ name: 't', transform: [{ type: 'sequence', start: 0, stop: 1000, as: 'x' }] }], marks: [] } as never
  forEachVariant(['svg'], (Chart) => {
    it('maxGeneratedRows is enforced by <Chart>, reported once', () => {
      const onError = vi.fn<(e: Error) => void>()
      const host = document.createElement('div')
      document.body.appendChild(host)
      const root = createRoot(host)
      act(() => { root.render(<Chart spec={gen} width={50} height={50} limits={{ maxGeneratedRows: 100 }} onError={onError} />) })
      expect(host.querySelector('[role="alert"]')).not.toBeNull()
      expect(onError.mock.calls[0]![0]).toBeInstanceOf(AsterLimitError)
      expect(onError).toHaveBeenCalledTimes(1)
    })
  })
  it('the worker request enforces it too', () => {
    const r = handleChartWorkerRequest({ id: 1, spec: gen, input: { limits: { maxGeneratedRows: 100 } } })
    expect(r.error?.code).toBe('ASTER_LIMIT')
  })
})
