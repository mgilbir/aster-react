// @vitest-environment jsdom
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { describe, it, expect, afterEach } from 'vitest'
import { handleChartWorkerStreamRequest } from './worker'
import { useChartWorkerStream, type WorkerChartStreamResult } from './useChartWorkerStream'
import { FakeWorker } from './testing/fake-worker'

const spec = {
  $schema: 'https://vega.github.io/schema/vega/v6.json',
  width: 200, height: 100, padding: 0, autosize: 'none',
  data: [{ name: 't', values: [{ x: 0, y: 1 }, { x: 1, y: 2 }] }],
  scales: [
    { name: 'x', type: 'linear', domain: [0, 3], range: 'width' },
    { name: 'y', type: 'linear', domain: [0, 4], range: 'height' },
  ],
  marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: {
    x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'y' }, size: { value: 20 },
  } } }],
} as never

describe('worker streaming', () => {
  afterEach(() => { document.body.innerHTML = '' })

  it('handles init/flush/close through the pure stream protocol', () => {
    const streams = new Map()
    const init = handleChartWorkerStreamRequest({ kind: 'stream', id: 1, streamId: 7, op: 'init', spec }, streams)
    expect(init.error).toBeUndefined()
    expect(init.scene).toBeTruthy()
    expect(init.svg).toContain('<svg')
    expect(() => structuredClone(init.scene)).not.toThrow()

    const flush = handleChartWorkerStreamRequest({
      kind: 'stream', id: 2, streamId: 7, op: 'flush',
      batches: [{ append: { t: [{ x: 2, y: 3 }] } }],
    }, streams)
    expect((flush.scene!.items[0] as { items: unknown[] }).items).toHaveLength(3)
    expect(flush.pulse?.datasets.get('t')?.addedRanges).toEqual([[2, 3]])

    const closed = handleChartWorkerStreamRequest({ kind: 'stream', id: 3, streamId: 7, op: 'close' }, streams)
    expect(closed.closed).toBe(true)
    expect(streams.size).toBe(0)
  })

  it('falls back to a local stream without a Worker', async () => {
    function Probe(): React.ReactElement {
      const r: WorkerChartStreamResult = useChartWorkerStream(spec)
      return <div data-testid="probe" data-pending={String(r.pending)} data-count={String((r.scene?.items[0] as any)?.items?.length ?? 0)} />
    }
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => { root.render(<Probe />); await new Promise((r) => setTimeout(r, 20)) })
    expect(host.querySelector('[data-testid="probe"]')!.getAttribute('data-count')).toBe('2')
    expect(host.querySelector('[data-testid="probe"]')!.getAttribute('data-pending')).toBe('false')
    act(() => { root.unmount() })
  })

  it('surfaces worker backpressure accept/reject counts', () => {
    const streams = new Map()
    const init = handleChartWorkerStreamRequest({ kind: 'stream', id: 1, streamId: 9, op: 'init', spec, options: { capacity: 1, policy: 'drop-newest' } }, streams)
    expect(init.error).toBeUndefined()
    const flush = handleChartWorkerStreamRequest({
      kind: 'stream', id: 2, streamId: 9, op: 'flush',
      batches: [{ append: { t: [{ x: 2, y: 3 }] } }, { append: { t: [{ x: 3, y: 4 }] } }],
    }, streams)
    expect(flush.accepted).toBe(1)
    expect(flush.rejected).toBe(1)
    expect(flush.stats?.dropped).toBe(1)
    expect(flush.depth).toBe(0)
  })

  it('uses a supplied Worker and streams updates through it', async () => {
    const fake = new FakeWorker()
    let result: WorkerChartStreamResult | null = null
    function Probe(): React.ReactElement {
      result = useChartWorkerStream(spec, { worker: fake as unknown as Worker })
      return <div data-testid="probe" data-pending={String(result.pending)} data-count={String((result.scene?.items[0] as any)?.items?.length ?? 0)} />
    }
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => { root.render(<Probe />); await new Promise((r) => setTimeout(r, 20)) })
    expect(host.querySelector('[data-testid="probe"]')!.getAttribute('data-count')).toBe('2')

    await act(async () => {
      result!.push({ append: { t: [{ x: 2, y: 3 }] } })
      await new Promise((r) => setTimeout(r, 20))
    })
    expect(host.querySelector('[data-testid="probe"]')!.getAttribute('data-count')).toBe('3')
    // the worker is what streamed it: it received the init and the batch, and holds the stream it answers for
    expect(fake.posted.map((p) => p.op)).toEqual(['init', 'flush'])
    expect(fake.posted[1]).toMatchObject({ batches: [{ append: { t: [{ x: 2, y: 3 }] } }] })
    expect(fake.streams.size).toBe(1)
    expect(result!.pulse()?.datasets.get('t')?.addedRanges).toEqual([[2, 3]])
    act(() => { result!.close() })
    expect(result!.push({ append: { t: [{ x: 3, y: 4 }] } })).toBe(false)
    act(() => { root.unmount() })
    // the stream it opened is closed in the worker; the worker, which the caller supplied, is not the hook's to terminate
    expect(fake.streams.size).toBe(0)
    expect(fake.terminated).toBe(false)
  })
})
