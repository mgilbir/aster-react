// @vitest-environment jsdom
/**
 * The worker hooks own a hard deadline (DECISIONS Q4, C244), and a worker event that names no request ends only requests in
 * flight (C555).
 *
 * - A request (one-shot render, stream start, stream flush) not answered within `timeoutMs` terminates the worker; the hook's
 *   `error` is an `AsterWorkerTimeoutError` and `pending` is false.
 * - A worker from `workerFactory` is replaced; the runaway request is not sent again by itself. A stream whose FLUSH ran away
 *   is started afresh on the new worker, with what is still queued; one whose START ran away is not started again for the same
 *   inputs (no terminate-respawn loop).
 * - A supplied `worker` is terminated and cannot be replaced: later requests fail at once, until a new `worker` is given.
 * - Every hook using a terminated worker ends its own request in flight.
 */
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VgSpec } from '@aster-charts/core'
import {
  AsterWorkerTimeoutError, handleChartWorkerRequest, handleChartWorkerStreamRequest, useChartWorker,
  type ChartWorkerRequest, type ChartWorkerStreamRequest, type WorkerChartResult,
} from './worker-impl'
import { useChartWorkerStream, type WorkerChartStreamResult } from './useChartWorkerStream'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const spec = {
  width: 100, height: 50, padding: 0, autosize: 'none',
  data: [{ name: 't', values: [{ x: 1 }] }],
  marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { field: 'x' }, y: { value: 5 } } } }],
} as unknown as VgSpec

/** A worker double. `silent(msg)` decides which messages it never answers (a runaway evaluation). */
class Worker2 {
  static made: Worker2[] = []
  listeners = { message: new Set<(e: MessageEvent) => void>(), error: new Set<(e: Event) => void>() }
  posted: Array<ChartWorkerRequest | ChartWorkerStreamRequest> = []
  terminated = false
  streams = new Map<number, never>()
  constructor(public silent: (m: { op?: string; kind?: string }) => boolean = () => false) { Worker2.made.push(this) }
  addEventListener(type: 'message' | 'error', fn: (e: never) => void): void { this.listeners[type]?.add(fn as never) }
  removeEventListener(type: 'message' | 'error', fn: (e: never) => void): void { this.listeners[type]?.delete(fn as never) }
  postMessage(msg: ChartWorkerRequest | ChartWorkerStreamRequest): void {
    const data = structuredClone(msg)
    this.posted.push(data)
    if (this.terminated || this.silent(data as never)) return
    const r = (data as { kind?: string }).kind === 'stream'
      ? handleChartWorkerStreamRequest(data as ChartWorkerStreamRequest, this.streams as never)
      : handleChartWorkerRequest(data as ChartWorkerRequest)
    setTimeout(() => { if (!this.terminated) for (const fn of [...this.listeners.message]) fn({ data: structuredClone(r) } as MessageEvent) }, 0)
  }
  /** A worker `error` event: it names no request. */
  crash(message: string): void { for (const fn of [...this.listeners.error]) fn({ message } as unknown as Event) }
  terminate(): void { this.terminated = true }
}

// The deadlines are on a fake clock: a wait advances it by exactly `ms`, so no machine load can let a deadline (or a worker's
// answer) fall on the other side of a wait.
beforeEach(() => { vi.useFakeTimers() })
const wait = (ms: number): Promise<void> => act(async () => { await vi.advanceTimersByTimeAsync(ms) })

function mount(node: React.ReactElement): { root: ReturnType<typeof createRoot>; render: (n: React.ReactElement) => void } {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  act(() => { root.render(node) })
  return { root, render: (n) => act(() => { root.render(n) }) }
}

afterEach(() => { vi.useRealTimers(); document.body.innerHTML = ''; Worker2.made = [] })

describe('useChartWorker: the deadline', () => {
  it('workerFactory: terminate, typed error, a new worker; the runaway request is not sent again; the next input uses the new worker', async () => {
    let result!: WorkerChartResult
    let factoryCalls = 0
    const factory = (): Worker => { factoryCalls++; return new Worker2((m) => factoryCalls === 1 && m.kind !== 'stream') as unknown as Worker }
    function Probe({ width }: { width: number }): null {
      result = useChartWorker(spec, { workerFactory: factory, timeoutMs: 60, width })
      return null
    }
    const m = mount(<Probe width={100} />)
    await wait(20)
    expect(result.pending).toBe(true)
    await wait(80)
    expect(result.error).toBeInstanceOf(AsterWorkerTimeoutError)
    expect((result.error as AsterWorkerTimeoutError).code).toBe('ASTER_WORKER_TIMEOUT')
    expect(result.pending).toBe(false)
    expect(Worker2.made[0]!.terminated).toBe(true)
    expect(factoryCalls).toBe(2)
    await wait(100)
    expect(Worker2.made[1]!.posted).toHaveLength(0)
    m.render(<Probe width={101} />)
    await wait(30)
    expect(Worker2.made[1]!.posted).toHaveLength(1)
    expect(result.error).toBeNull()
    expect(result.svg).toContain('<svg')
    act(() => { m.root.unmount() })
  })

  it('a supplied worker: terminated, and later requests fail at once until a new worker is given', async () => {
    let result!: WorkerChartResult
    const silent = new Worker2(() => true)
    function Probe({ width, worker }: { width: number; worker: Worker }): null {
      result = useChartWorker(spec, { worker, timeoutMs: 50, width })
      return null
    }
    const m = mount(<Probe width={100} worker={silent as unknown as Worker} />)
    await wait(90)
    expect(result.error).toBeInstanceOf(AsterWorkerTimeoutError)
    expect(silent.terminated).toBe(true)
    m.render(<Probe width={101} worker={silent as unknown as Worker} />)
    await wait(5)
    expect(result.error).toBeInstanceOf(AsterWorkerTimeoutError)
    expect(silent.posted).toHaveLength(1)
    const fresh = new Worker2()
    m.render(<Probe width={101} worker={fresh as unknown as Worker} />)
    await wait(30)
    expect(result.error).toBeNull()
    act(() => { m.root.unmount() })
  })

  it('an invalid timeoutMs is the error, through the same channel', async () => {
    let result!: WorkerChartResult
    // (a worker is a stateful object: compared by identity, so it is made once, outside render)
    const worker = new Worker2() as unknown as Worker
    function Probe(): null { result = useChartWorker(spec, { worker, timeoutMs: -1 }); return null }
    const m = mount(<Probe />)
    await wait(10)
    expect(result.error).toBeInstanceOf(TypeError)
    act(() => { m.root.unmount() })
  })
})

describe('useChartWorkerStream: the deadline', () => {
  it('a flush that runs away: typed error with the flush as discarded; a fresh stream on a new worker gets what is still queued', async () => {
    let hook!: WorkerChartStreamResult
    let calls = 0
    // the first worker answers the start and never a flush; the second answers everything
    const factory = (): Worker => { calls++; const n = calls; return new Worker2((m) => n === 1 && m.op === 'flush') as unknown as Worker }
    function Probe(): null { hook = useChartWorkerStream(spec, { workerFactory: factory, timeoutMs: 60 }); return null }
    const m = mount(<Probe />)
    await wait(20)
    expect(hook.scene).not.toBeNull()
    act(() => { hook.push({ append: { t: [{ x: 2 }, { x: 3 }] } }) })
    await wait(10)
    // while the flush is in flight, pushes queue here (and are delivered later)
    act(() => { expect(hook.push({ append: { t: [{ x: 4 }] } })).toBe(true) })
    await wait(80)
    expect(calls).toBe(2)
    expect(Worker2.made[0]!.terminated).toBe(true)
    // the error is reported (it survives the restart's first render), then the fresh stream's first scene clears it
    await wait(40)
    expect(hook.generation).toBe(2)
    expect(hook.error).toBeNull()
    const xs = ((hook.scene!.items[0] as { items: Array<{ datum: { x: number } }> }).items).map((i) => i.datum.x)
    expect(xs).toEqual([1, 4])
    act(() => { m.root.unmount() })
  })

  it('a flush timeout is reported once through onStreamError-like observation of `error`', async () => {
    const seen: Error[] = []
    let hook!: WorkerChartStreamResult
    let calls = 0
    const factory = (): Worker => { calls++; const n = calls; return new Worker2((m) => n === 1 && m.op === 'flush') as unknown as Worker }
    function Probe(): null {
      hook = useChartWorkerStream(spec, { workerFactory: factory, timeoutMs: 50 })
      React.useEffect(() => { if (hook.error) seen.push(hook.error) }, [hook.error])
      return null
    }
    const m = mount(<Probe />)
    await wait(20)
    act(() => { hook.push({ append: { t: [{ x: 2 }] } }) })
    await wait(150)
    // (act flushes the replacement's render when a wait ends: one more turn lets the fresh stream answer)
    await wait(30)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toBeInstanceOf(AsterWorkerTimeoutError)
    expect(hook.flushFailure).toBeNull() // (cleared by the fresh stream's scene)
    act(() => { m.root.unmount() })
  })

  it('a start that runs away is not started again for the same inputs (no terminate/respawn loop); a new spec starts one', async () => {
    let hook!: WorkerChartStreamResult
    let calls = 0
    const factory = (): Worker => { calls++; return new Worker2((m) => m.op === 'init' && calls <= 1) as unknown as Worker }
    function Probe({ width }: { width: number }): null {
      hook = useChartWorkerStream({ ...(spec as object), width } as VgSpec, { workerFactory: factory, timeoutMs: 50 })
      return null
    }
    const m = mount(<Probe width={100} />)
    await wait(300)
    expect(calls).toBe(2)
    expect(hook.error).toBeInstanceOf(AsterWorkerTimeoutError)
    expect(Worker2.made[1]!.posted).toHaveLength(0)
    expect(hook.push({ append: { t: [{ x: 1 }] } })).toBe(false)
    m.render(<Probe width={101} />)
    await wait(30)
    expect(hook.error).toBeNull()
    expect(hook.scene).not.toBeNull()
    act(() => { m.root.unmount() })
  })
})

describe('a worker shared by several hooks', () => {
  it('a deadline on one hook ends the other hooks’ requests in flight on that worker', async () => {
    const shared = new Worker2((m) => m.kind !== 'stream' || m.op === 'flush')
    let one!: WorkerChartResult
    let stream!: WorkerChartStreamResult
    function Probe(): null {
      one = useChartWorker(spec, { worker: shared as unknown as Worker, timeoutMs: 60 })
      stream = useChartWorkerStream(spec, { worker: shared as unknown as Worker, timeoutMs: 10_000 })
      return null
    }
    const m = mount(<Probe />)
    await wait(20)
    act(() => { stream.push({ append: { t: [{ x: 2 }] } }) })
    await wait(80)
    expect(one.error).toBeInstanceOf(AsterWorkerTimeoutError)
    expect(stream.error).toBeInstanceOf(AsterWorkerTimeoutError)
    act(() => { m.root.unmount() })
  })

  it('C555: a worker error event ends only requests in flight; an idle healthy stream keeps its chart', async () => {
    const shared = new Worker2((m) => m.kind !== 'stream')
    let one!: WorkerChartResult
    let stream!: WorkerChartStreamResult
    function Probe(): null {
      one = useChartWorker(spec, { worker: shared as unknown as Worker })
      stream = useChartWorkerStream(spec, { worker: shared as unknown as Worker })
      return null
    }
    const m = mount(<Probe />)
    await wait(20)
    expect(stream.scene).not.toBeNull()
    expect(one.pending).toBe(true)
    act(() => { shared.crash('boom') })
    expect(one.error?.message).toMatch(/boom/)
    expect(stream.error).toBeNull()
    expect(stream.scene).not.toBeNull()
    act(() => { m.root.unmount() })
  })
})
