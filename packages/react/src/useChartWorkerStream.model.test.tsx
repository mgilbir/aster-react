// @vitest-environment jsdom
/**
 * `useChartWorkerStream` against a reference model, over generated operation sequences (C49, C77, C158, C159, C506;
 * DECISIONS Q19: "`true` means it will be delivered").
 *
 * The model is the stream's backpressure policy applied to one ordered queue (as `createChartStream` applies it), plus the
 * hook's lifecycle: a stream that has not started keeps what is pushed; `close()` refuses until the next stream; a restart (a
 * new spec) starts a stream from the spec and delivers what is still queued to it; unmounting refuses everything. Each step
 * checks the hook against the model:
 *
 * - every `push` answers what the model answers (true / false / throws);
 * - `depth()` is the model's queue;
 * - with a Worker (a double that holds messages until the test answers them, i.e. a slow worker): every flush carries exactly
 *   the batches the model has queued, in order, and there is never more than ONE flush unanswered (the worker is bounded, C77);
 * - at the end, after the worker has answered everything, the stream's scene holds exactly the rows the model delivered to the
 *   current stream, in order.
 */
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import type { StreamPolicy, VgSpec } from '@aster-charts/core'
import { handleChartWorkerStreamRequest, type ChartWorkerStreamRequest, type ChartWorkerStreamResponse } from './worker-impl'
import { useChartWorkerStream, type WorkerChartStreamResult } from './useChartWorkerStream'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const specOf = (width: number): VgSpec => ({
  width, height: 50, padding: 0, autosize: 'none',
  data: [{ name: 't', values: [] }],
  marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { field: 'x' }, y: { value: 5 } } } }],
}) as unknown as VgSpec

/** A worker that holds every message until `answer()`: the slowest consumer there is. Real protocol handler. */
class SlowWorker {
  listeners = new Set<(e: MessageEvent) => void>()
  held: ChartWorkerStreamRequest[] = []
  received: ChartWorkerStreamRequest[] = []
  streams = new Map<number, never>()
  onReceive: ((m: ChartWorkerStreamRequest) => void) | null = null
  addEventListener(type: string, fn: (e: MessageEvent) => void): void { if (type === 'message') this.listeners.add(fn) }
  removeEventListener(_t: string, fn: (e: MessageEvent) => void): void { this.listeners.delete(fn) }
  postMessage(msg: ChartWorkerStreamRequest): void {
    const data = structuredClone(msg)
    this.received.push(data)
    this.onReceive?.(data)
    this.held.push(data)
  }
  /** Unanswered flushes per stream. */
  unansweredFlushes(streamId: number): number {
    return this.held.filter((m) => m.op === 'flush' && m.streamId === streamId).length
  }
  answerAll(): void {
    while (this.held.length) {
      const m = this.held.shift()!
      const r: ChartWorkerStreamResponse = handleChartWorkerStreamRequest(m, this.streams as never)
      for (const fn of [...this.listeners]) fn({ data: structuredClone(r) } as MessageEvent)
    }
  }
  terminate(): void {}
}

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Bounds { capacity: number; maxQueuedRows: number; policy: StreamPolicy }
type Entry = { ids: number[] }

/** The reference: the stream's policy over one ordered queue, and the hook's lifecycle around it. */
class Model {
  queue: Entry[] = []
  /** Taken by a flush, not answered yet (worker mode). */
  inflight: Entry[] = []
  delivered: number[] = []
  closed = false
  dead = false
  paused = false
  constructor(readonly b: Bounds) {}
  rows(): number { return this.queue.reduce((n, e) => n + e.ids.length, 0) }
  depth(): number { return this.b.policy === 'coalesce' ? (this.queue.length ? 1 : 0) : this.queue.length }
  push(ids: number[]): boolean | 'throws' {
    if (this.dead || this.closed) return false
    const refuse = (): false | 'throws' => (this.b.policy === 'error' ? 'throws' : false)
    if (ids.length > this.b.maxQueuedRows) return refuse()
    if (this.b.policy === 'coalesce') {
      if (this.rows() + ids.length > this.b.maxQueuedRows) return refuse()
      this.queue.push({ ids })
      return true
    }
    while (this.queue.length >= this.b.capacity || this.rows() + ids.length > this.b.maxQueuedRows) {
      if (this.b.policy !== 'drop-oldest') return refuse()
      this.queue.shift()
    }
    this.queue.push({ ids })
    return true
  }
  /** The ids a flush must carry now (everything queued, in order). */
  take(): number[] {
    const ids = this.queue.flatMap((e) => e.ids)
    this.inflight.push(...this.queue)
    this.queue = []
    return ids
  }
  answered(): void { this.delivered.push(...this.inflight.flatMap((e) => e.ids)); this.inflight = [] }
  close(): void { this.closed = true; this.queue = [] }
  restart(): void { this.closed = false; this.delivered = []; this.inflight = [] }
}

type Op = { kind: 'push'; rows: number } | { kind: 'tick' } | { kind: 'flush' } | { kind: 'pause' } | { kind: 'resume' }
  | { kind: 'close' } | { kind: 'restart' } | { kind: 'answer' }

function generate(rand: () => number, n: number, withWorker: boolean): Op[] {
  const ops: Op[] = []
  for (let i = 0; i < n; i++) {
    const r = rand()
    if (r < 0.5) ops.push({ kind: 'push', rows: 1 + Math.floor(rand() * 4) })
    else if (r < 0.6) ops.push({ kind: 'tick' })
    else if (r < 0.66) ops.push({ kind: 'flush' })
    else if (r < 0.72) ops.push({ kind: 'pause' })
    else if (r < 0.8) ops.push({ kind: 'resume' })
    else if (r < 0.83) ops.push({ kind: 'close' })
    else if (r < 0.87) ops.push({ kind: 'restart' })
    else ops.push(withWorker ? { kind: 'answer' } : { kind: 'tick' })
  }
  return ops
}

const symbolsOf = (r: WorkerChartStreamResult): number[] =>
  (((r.scene?.items[0] as { items?: Array<{ datum?: { x: number } }> } | undefined)?.items) ?? []).map((i) => i.datum!.x)

async function runSequence(seed: number, bounds: Bounds, withWorker: boolean): Promise<void> {
  const rand = rng(seed)
  const model = new Model(bounds)
  const worker = withWorker ? new SlowWorker() : null
  let hook!: WorkerChartStreamResult
  let width = 200
  let setWidth: ((w: number) => void) | null = null
  let nextId = 1
  const prePushed: Array<{ ids: number[]; answer: boolean | 'throws' }> = []
  // (C49: a child pushes in its mount effect, which runs before the hook's start effect)
  function Child({ push }: { push: WorkerChartStreamResult['push'] }): null {
    React.useEffect(() => {
      const ids = [nextId++, nextId++]
      let answer: boolean | 'throws'
      try { answer = push({ append: { t: ids.map((x) => ({ x })) } }) } catch { answer = 'throws' }
      prePushed.push({ ids, answer })
    }, [push])
    return null
  }
  function Host(): React.ReactElement {
    const [w, set] = React.useState(width)
    setWidth = set
    hook = useChartWorkerStream(specOf(w), { worker: worker as unknown as Worker | null, ...bounds, timeoutMs: 60_000 })
    return <Child push={hook.push} />
  }
  if (worker) {
    worker.onReceive = (m) => {
      if (m.op !== 'flush') return
      // every flush carries exactly what the model has queued, in order; never two unanswered (C77)
      const ids = (m.batches ?? []).flatMap((b) => (b.append?.t ?? []).map((r) => (r as { x: number }).x))
      expect(ids).toEqual(model.take())
      expect(worker.unansweredFlushes(m.streamId)).toBe(0)
    }
  }
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(<Host />) })
  // the mount-time push: accepted and queued (it is delivered with the first flush)
  expect(prePushed).toHaveLength(1)
  expect(prePushed[0]!.answer).toBe(model.push(prePushed[0]!.ids))
  const settle = async (): Promise<void> => {
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    if (!worker && !model.paused && !model.closed) { model.take(); model.answered() }
  }
  if (worker) { await act(async () => { worker.answerAll() }) ; model.answered() }
  await settle()
  const ops = generate(rand, 30, worker != null)
  for (const op of ops) {
    switch (op.kind) {
      case 'push': {
        const ids = Array.from({ length: op.rows }, () => nextId++)
        const expected = model.push(ids)
        let got: boolean | 'throws'
        await act(async () => {
          try { got = hook.push({ append: { t: ids.map((x) => ({ x })) } }) } catch { got = 'throws' }
        })
        expect({ op: 'push', ids, got: got! }).toEqual({ op: 'push', ids, got: expected })
        break
      }
      case 'flush':
        await act(async () => { hook.flush() })
        if (!worker && !model.closed) { model.take(); model.answered() }
        break
      case 'pause': model.paused = true; await act(async () => { hook.pause() }); break
      case 'resume': model.paused = false; await act(async () => { hook.resume() }); break
      case 'close': model.close(); await act(async () => { hook.close() }); break
      case 'restart':
        width = width === 200 ? 201 : 200
        // (what the old stream had in flight is the old stream's: it never reaches the new one)
        model.restart()
        await act(async () => { setWidth!(width) })
        if (worker) { await act(async () => { worker.answerAll() }) }
        break
      case 'answer':
        await act(async () => { worker!.answerAll() })
        model.answered()
        break
      case 'tick': break
    }
    await settle()
    expect(hook.depth()).toBe(model.depth())
  }
  // drain: resume, flush, answer everything; the scene is exactly what the model delivered, in order
  model.paused = false
  await act(async () => { hook.resume() })
  await settle()
  for (let i = 0; i < 3; i++) {
    await act(async () => { hook.flush() })
    if (worker) { await act(async () => { worker.answerAll() }); model.answered() } else if (!model.closed) { model.take(); model.answered() }
    await settle()
  }
  if (!model.closed) {
    expect(hook.error).toBeNull()
    expect(symbolsOf(hook)).toEqual(model.delivered)
  }
  // unmounted: every push is refused (C506)
  act(() => { root.unmount() })
  await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
  expect(hook.push({ append: { t: [{ x: -1 }] } })).toBe(false)
  expect(hook.depth()).toBe(0)
}

afterEach(() => { document.body.innerHTML = '' })

const BOUNDS: Bounds[] = [
  { policy: 'coalesce', capacity: 32, maxQueuedRows: 9 },
  { policy: 'drop-newest', capacity: 3, maxQueuedRows: 9 },
  { policy: 'drop-oldest', capacity: 3, maxQueuedRows: 9 },
  { policy: 'error', capacity: 3, maxQueuedRows: 9 },
]
const SEEDS = Array.from({ length: 12 }, (_, i) => i + 1)

describe.each([
  ['a slow Worker', true],
  ['no Worker (the in-realm stream)', false],
] as const)('useChartWorkerStream with %s follows the model', (_name, withWorker) => {
  for (const bounds of BOUNDS) {
    it.each(SEEDS)(`${bounds.policy} (capacity ${bounds.capacity}, ${bounds.maxQueuedRows} rows), seed %i`, async (seed) => {
      await runSequence(seed, bounds, withWorker)
    })
  }
})
