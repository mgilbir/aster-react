// @vitest-environment jsdom
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { describe, it, expect, afterEach } from 'vitest'
import { AsterLimitError, createChartStream, renderSceneToSvg, type ChartStream } from '@aster/core'
import {
  cloneableScene, handleChartWorkerRequest, handleChartWorkerStreamRequest, handleWorkerMessage,
  registerWorkerTextMetrics, useChartWorker,
  type ChartWorkerRequest, type ChartWorkerResponse, type ChartWorkerStreamRequest, type ChartWorkerStreamResponse,
} from './worker'
import { useChartWorkerStream, type WorkerChartStreamResult } from './useChartWorkerStream'

const specOf = (n: number, extra: Record<string, unknown> = {}): never => ({
  $schema: 'https://vega.github.io/schema/vega/v6.json',
  width: 200, height: 100, padding: 0, autosize: 'none',
  data: [{ name: 't', values: Array.from({ length: n }, (_, i) => ({ x: i, y: i })) }],
  scales: [
    { name: 'x', type: 'linear', domain: [0, 10], range: 'width' },
    { name: 'y', type: 'linear', domain: [0, 10], range: 'height' },
  ],
  marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'y' }, size: { value: 20 } } } }],
  ...extra,
}) as never

/** A worker that answers both protocols, crossing a real structured-clone boundary. */
class FakeWorker {
  listeners = new Map<string, Set<(event: unknown) => void>>()
  streams = new Map<number, ChartStream>()
  posted: Array<{ id: number; kind?: string; op?: string; streamId?: number } & Record<string, unknown>> = []
  held: Array<() => void> = []
  hold = false
  terminated = false
  addEventListener(type: string, fn: (event: unknown) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)!.add(fn)
  }
  removeEventListener(type: string, fn: (event: unknown) => void): void { this.listeners.get(type)?.delete(fn) }
  emit(type: string, event: unknown): void { for (const fn of this.listeners.get(type) ?? []) fn(event) }
  postMessage(request: ChartWorkerRequest | ChartWorkerStreamRequest): void {
    const wire = structuredClone(request) as typeof request & { kind?: string }
    this.posted.push(wire as never)
    const respond = (): void => {
      const response = handleWorkerMessage(wire, this.streams)
      if (response) queueMicrotask(() => this.emit('message', { data: structuredClone(response) }))
    }
    if (this.hold) this.held.push(respond)
    else respond()
  }
  release(): void { for (const r of this.held.splice(0)) r() }
  terminate(): void { this.terminated = true }
}

registerWorkerTextMetrics('huge', { measure: () => 500 })

const wait = (ms = 20): Promise<void> => new Promise((r) => setTimeout(r, ms))

function mountProbe<T>(useIt: () => T): { host: HTMLElement; root: ReturnType<typeof createRoot>; result: () => T; rerender: () => Promise<void> } {
  let current: T
  let bump: () => void = () => {}
  function Probe(): React.ReactElement {
    const [, set] = React.useState(0)
    bump = () => set((n) => n + 1)
    current = useIt()
    return <div />
  }
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  act(() => { root.render(<Probe />) })
  return { host, root, result: () => current, rerender: async () => { await act(async () => { bump(); await wait() }) } }
}

afterEach(() => { document.body.innerHTML = '' })

describe('worker protocol carries limits and text metrics (C65)', () => {
  it('enforces limits inside the worker handler with a typed code', () => {
    const response = handleChartWorkerRequest({ id: 1, spec: specOf(5), input: { limits: { maxItems: 2 } } })
    expect(response.scene).toBeUndefined()
    expect(response.error?.code).toBe('ASTER_LIMIT')
  })

  it('maxSvgLength is checked on the serialized output like renderSpec', () => {
    const response = handleChartWorkerRequest({ id: 1, spec: specOf(5), input: { limits: { maxSvgLength: 50 } } })
    expect(response.error?.code).toBe('ASTER_LIMIT')
  })

  it('resolves text metrics by registered name, and rejects unknown names', () => {
    const titled = specOf(1, { title: { text: 'Title text' } })
    const calls: string[] = []
    registerWorkerTextMetrics('spy', { measure: (t) => { calls.push(t); return 3 } })
    handleChartWorkerRequest({ id: 1, spec: titled, input: {} })
    expect(calls).not.toContain('Title text')
    const measured = handleChartWorkerRequest({ id: 2, spec: titled, input: { textMetrics: 'spy' } })
    expect(measured.error).toBeUndefined()
    expect(calls).toContain('Title text')
    const unknown = handleChartWorkerRequest({ id: 3, spec: titled, input: { textMetrics: 'nope' } })
    expect(unknown.error?.message).toMatch(/unknown text-metrics provider "nope"/)
  })

  it('useChartWorker posts limits and the provider name over the wire and surfaces AsterLimitError', async () => {
    const fake = new FakeWorker()
    const m = mountProbe(() => useChartWorker(specOf(5), { worker: fake as unknown as Worker, limits: { maxItems: 2 }, textMetrics: 'huge' }))
    await act(async () => { await wait() })
    expect(fake.posted[0]!.input).toMatchObject({ limits: { maxItems: 2 }, textMetrics: 'huge' })
    expect(m.result().error).toBeInstanceOf(AsterLimitError)
    expect(m.result().pending).toBe(false)
  })

  it('a provider OBJECT cannot cross postMessage: explicit error instead of a silent drop', async () => {
    const fake = new FakeWorker()
    const m = mountProbe(() => useChartWorker(specOf(2), { worker: fake as unknown as Worker, textMetrics: { measure: () => 1 } }))
    await act(async () => { await wait() })
    expect(m.result().error?.message).toMatch(/registerWorkerTextMetrics/)
    expect(fake.posted).toHaveLength(0)
    // ...but without a Worker the object works through the sync fallback.
    const sync = mountProbe(() => useChartWorker(specOf(2, { title: { text: 'abc' } }), { textMetrics: { measure: () => 1 } }))
    await act(async () => { await wait() })
    expect(sync.result().error).toBeNull()
    expect(sync.result().svg).toContain('<svg')
  })

  it('stream protocol: limits and named text metrics in init and in batches', () => {
    const streams = new Map<number, ChartStream>()
    const limited = handleChartWorkerStreamRequest({ kind: 'stream', id: 1, streamId: 1, op: 'init', spec: specOf(5), options: { initial: { limits: { maxItems: 1 } } } }, streams)
    expect(limited.error?.code).toBe('ASTER_LIMIT')
    const ok = handleChartWorkerStreamRequest({ kind: 'stream', id: 2, streamId: 2, op: 'init', spec: specOf(5, { title: { text: 'T' } }) }, streams)
    expect(ok.error).toBeUndefined()
    const tightened = handleChartWorkerStreamRequest({ kind: 'stream', id: 3, streamId: 2, op: 'flush', batches: [{ limits: { maxItems: 1 } }] }, streams)
    expect(tightened.error?.code).toBe('ASTER_LIMIT')
    const unknown = handleChartWorkerStreamRequest({ kind: 'stream', id: 4, streamId: 2, op: 'flush', batches: [{ textMetrics: 'missing' }] }, streams)
    expect(unknown.error?.message).toMatch(/unknown text-metrics provider/)
  })
})

describe('sharing one worker between hooks (C65)', () => {
  it('request ids are unique across protocols, and each hook only applies its own response', async () => {
    const fake = new FakeWorker()
    const one = mountProbe(() => useChartWorker(specOf(2), { worker: fake as unknown as Worker }))
    const two = mountProbe(() => useChartWorkerStream(specOf(4), { worker: fake as unknown as Worker }))
    await act(async () => { await wait() })
    const ids = fake.posted.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
    const streamIds = fake.posted.filter((p) => p.kind === 'stream' && p.op === 'init').map((p) => p.streamId)
    expect(new Set(streamIds).size).toBe(streamIds.length)
    // chart hook shows its 2-row chart, stream hook its 4-row stream
    expect(one.result().svg!.match(/<path/g)!.length).toBeLessThan(two.result().svg!.match(/<path/g)!.length)
    expect((two.result().scene!.items[0] as { items: unknown[] }).items).toHaveLength(4)
    expect((one.result().scene!.items[0] as { items: unknown[] }).items).toHaveLength(2)
  })

  it('two stream hooks on one worker keep separate streams', async () => {
    const fake = new FakeWorker()
    const a = mountProbe(() => useChartWorkerStream(specOf(2), { worker: fake as unknown as Worker }))
    const b = mountProbe(() => useChartWorkerStream(specOf(5), { worker: fake as unknown as Worker }))
    await act(async () => { await wait() })
    await act(async () => { a.result().push({ append: { t: [{ x: 9, y: 9 }] } }); await wait() })
    expect((a.result().scene!.items[0] as { items: unknown[] }).items).toHaveLength(3)
    expect((b.result().scene!.items[0] as { items: unknown[] }).items).toHaveLength(5)
  })
})

describe('worker hook lifecycle (C65)', () => {
  it('an inline workerFactory creates one worker and requests reach it', async () => {
    let created = 0
    const workers: FakeWorker[] = []
    const m = mountProbe(() => useChartWorker(specOf(3), {
      workerFactory: () => { created++; const w = new FakeWorker(); workers.push(w); return w as unknown as Worker },
    }))
    await act(async () => { await wait() })
    await m.rerender()
    await m.rerender()
    expect(created).toBe(1)
    expect(m.result().pending).toBe(false)
    expect(m.result().svg).toContain('<svg')
    expect(workers[0]!.posted.length).toBeGreaterThan(0)
  })

  it('pending is true again while a later request is in flight', async () => {
    const fake = new FakeWorker()
    let width = 200
    const m = mountProbe(() => useChartWorker(specOf(3), { worker: fake as unknown as Worker, width }))
    await act(async () => { await wait() })
    expect(m.result().pending).toBe(false)
    fake.hold = true
    width = 250
    await m.rerender()
    expect(m.result().pending).toBe(true)
    await act(async () => { fake.hold = false; fake.release(); await wait() })
    expect(m.result().pending).toBe(false)
  })

  it('error and messageerror end the pending request with an error', async () => {
    for (const type of ['error', 'messageerror']) {
      const fake = new FakeWorker()
      fake.hold = true
      const m = mountProbe(() => useChartWorker(specOf(3), { worker: fake as unknown as Worker }))
      await act(async () => { await wait() })
      expect(m.result().pending).toBe(true)
      await act(async () => { fake.emit(type, { message: 'boom' }); await wait() })
      expect(m.result().pending).toBe(false)
      expect(m.result().error).toBeInstanceOf(Error)
      document.body.innerHTML = ''
    }
  })

  it('a worker crash fails the stream hook too', async () => {
    const fake = new FakeWorker()
    fake.hold = true
    const m = mountProbe(() => useChartWorkerStream(specOf(3), { worker: fake as unknown as Worker }))
    await act(async () => { await wait() })
    await act(async () => { fake.emit('error', { message: 'crash' }); await wait() })
    expect(m.result().error?.message).toMatch(/crash/)
    expect(m.result().pending).toBe(false)
  })

  it('an equal inline spec, a new factory arrow and a flipped serialize do not restart the worker stream (C32)', async () => {
    const fake = new FakeWorker()
    let serialize = true
    const m = mountProbe(() => useChartWorkerStream(specOf(2), { worker: fake as unknown as Worker, workerFactory: () => null, serialize }))
    await act(async () => { await wait() })
    await act(async () => { m.result().push({ append: { t: [{ x: 7, y: 7 }] } }); await wait() })
    expect((m.result().scene!.items[0] as { items: unknown[] }).items).toHaveLength(3)
    const inits = (): number => fake.posted.filter((p) => p.op === 'init').length
    expect(inits()).toBe(1)
    serialize = false
    await m.rerender()
    await m.rerender()
    expect(inits()).toBe(1)
    expect((m.result().scene!.items[0] as { items: unknown[] }).items).toHaveLength(3)
  })
})

describe('worker stream payloads and queue (C69)', () => {
  it('serialize:false responses carry no SVG; the default does', () => {
    const streams = new Map<number, ChartStream>()
    const lean = handleChartWorkerStreamRequest({ kind: 'stream', id: 1, streamId: 1, op: 'init', spec: specOf(3), serialize: false }, streams)
    expect(lean.scene).toBeTruthy()
    expect(lean.svg).toBeUndefined()
    const flush = handleChartWorkerStreamRequest({ kind: 'stream', id: 2, streamId: 1, op: 'flush', batches: [{ append: { t: [{ x: 1, y: 1 }] } }], serialize: false }, streams)
    expect(flush.svg).toBeUndefined()
    const full = handleChartWorkerStreamRequest({ kind: 'stream', id: 3, streamId: 2, op: 'init', spec: specOf(3) }, streams)
    expect(full.svg).toContain('<svg')
  })

  it('the hook asks for no SVG when serialize is false', async () => {
    const fake = new FakeWorker()
    const m = mountProbe(() => useChartWorkerStream(specOf(3), { worker: fake as unknown as Worker, serialize: false }))
    await act(async () => { await wait() })
    expect(fake.posted.every((p) => p.serialize === false)).toBe(true)
    expect(m.result().svg).toBeNull()
  })

  it('cloneableScene never mutates the live scene and keeps __scales snapshots', () => {
    const stream = createChartStream(specOf(3))
    stream.flush()
    const live = stream.scene()!
    const first = (live.items[0] as unknown as { items: Array<Record<string, unknown>>; __scales?: unknown })
    first.items[0]!.__domDesc = { el: 'patched' }
    ;(live.items[0] as unknown as Record<string, unknown>).__domDesc = { el: 'group' }
    const clone = cloneableScene(live)
    expect((first.items[0] as Record<string, unknown>).__domDesc).toEqual({ el: 'patched' })
    expect((live.items[0] as unknown as Record<string, unknown>).__domDesc).toEqual({ el: 'group' })
    expect(live.__scaleMap).toBeDefined()
    expect(live.runtime).toBeDefined()
    expect(live.compiled).toBeDefined()
    expect(clone.__scales?.length).toBeGreaterThan(0)
    expect(JSON.stringify(clone.items)).not.toContain('patched')
    expect(() => structuredClone(clone)).not.toThrow()
    expect(renderSceneToSvg(live)).toContain('<svg')
  })

  describe('producer queue mirrors the stream policy', () => {
    const rows = (...xs: number[]) => xs.map((x) => ({ x, y: x }))
    async function run(policy: 'coalesce' | 'drop-oldest' | 'drop-newest' | 'error', capacity: number) {
      const fake = new FakeWorker()
      const m = mountProbe(() => useChartWorkerStream(specOf(1), { worker: fake as unknown as Worker, policy, capacity, autoFlush: false }))
      await act(async () => { await wait() })
      const results: Array<boolean | 'threw'> = []
      act(() => {
        for (const b of [1, 2, 3]) {
          try { results.push(m.result().push({ append: { t: rows(b) } })) } catch { results.push('threw') }
        }
      })
      await act(async () => { m.result().flush(); await wait() })
      const flush = fake.posted.find((p) => p.op === 'flush')
      return { results, batches: (flush?.batches ?? []) as Array<{ append: { t: Array<{ x: number }> } }>, hook: m.result }
    }

    it('drop-newest rejects what does not fit (and says so)', async () => {
      const { results, batches, hook } = await run('drop-newest', 2)
      expect(results).toEqual([true, true, false])
      expect(batches.map((b) => b.append.t[0]!.x)).toEqual([1, 2])
      expect(hook().rejected()).toBe(0) // nothing was left for the worker to reject
    })
    it('drop-oldest keeps the newest batches', async () => {
      const { results, batches } = await run('drop-oldest', 2)
      expect(results).toEqual([true, true, true])
      expect(batches.map((b) => b.append.t[0]!.x)).toEqual([2, 3])
    })
    it('error throws AsterStreamBackpressureError', async () => {
      const { results } = await run('error', 2)
      expect(results).toEqual([true, true, 'threw'])
    })
    it('coalesce accepts everything and sends one merged batch (never "rejects the newest")', async () => {
      const { results, batches } = await run('coalesce', 1)
      expect(results).toEqual([true, true, true])
      expect(batches).toHaveLength(1)
      expect(batches[0]!.append.t.map((r) => r.x)).toEqual([1, 2, 3])
    })
  })
})

describe('worker message validation (C92)', () => {
  const streams = new Map<number, ChartStream>()
  it('drops what it cannot answer and rejects malformed requests with a typed error', () => {
    for (const junk of [null, undefined, 5, 'x', [], {}, { id: 'a' }]) expect(handleWorkerMessage(junk, streams)).toBeNull()
    const noSpec = handleWorkerMessage({ id: 4 }, streams) as ChartWorkerResponse
    expect(noSpec.id).toBe(4)
    expect(noSpec.error?.name).toBe('TypeError')
    const badOp = handleWorkerMessage({ kind: 'stream', id: 5, streamId: 1, op: 'explode' }, streams) as ChartWorkerStreamResponse
    expect(badOp).toMatchObject({ kind: 'stream', id: 5, streamId: 1 })
    expect(badOp.error?.name).toBe('TypeError')
    const badBatches = handleWorkerMessage({ kind: 'stream', id: 6, streamId: 1, op: 'flush', batches: 'nope' }, streams) as ChartWorkerStreamResponse
    expect(badBatches.error?.name).toBe('TypeError')
    const badInput = handleWorkerMessage({ id: 7, spec: {}, input: 3 }, streams) as ChartWorkerResponse
    expect(badInput.error?.name).toBe('TypeError')
  })
  it('well-formed messages still reach the pipeline', () => {
    const ok = handleWorkerMessage({ id: 8, spec: specOf(2) }, streams) as ChartWorkerResponse
    expect(ok.svg).toContain('<svg')
  })
})
