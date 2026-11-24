// @vitest-environment jsdom
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { describe, it, expect, afterEach } from 'vitest'
import { handleChartWorkerRequest, useChartWorker } from './worker'
import { FakeWorker } from './testing/fake-worker'

const spec = {
  $schema: 'https://vega.github.io/schema/vega/v6.json',
  width: 100, height: 100, padding: 0, autosize: 'none',
  data: [{ name: 't', values: [{ x: 0, y: 1 }, { x: 1, y: 2 }] }],
  scales: [
    { name: 'x', type: 'linear', domain: { data: 't', field: 'x' }, range: 'width' },
    { name: 'y', type: 'linear', domain: { data: 't', field: 'y' }, range: 'height' },
  ],
  marks: [{ type: 'line', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'y' } } } }],
} as never

describe('worker offload', () => {
  afterEach(() => { document.body.innerHTML = '' })

  it('handles a request synchronously and returns a cloneable scene', () => {
    const response = handleChartWorkerRequest({ id: 1, spec, input: { width: 100, height: 100 } })
    expect(response.error).toBeUndefined()
    expect(response.svg).toContain('<svg')
    expect(() => structuredClone(response.scene)).not.toThrow()
  })

  it('falls back to the sync path when no Worker exists', async () => {
    function Probe() {
      const result = useChartWorker(spec, { width: 100, height: 100 })
      return <div data-testid="probe" data-pending={String(result.pending)} dangerouslySetInnerHTML={result.svg ? { __html: result.svg } : undefined} />
    }
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => { root.render(<Probe />) })
    await act(async () => { await Promise.resolve() })
    expect(container.querySelector('[data-testid="probe"]')!.getAttribute('data-pending')).toBe('false')
    expect(container.querySelector('svg')).not.toBeNull()
    act(() => { root.unmount() })
  })

  function mountProbe(options: Parameters<typeof useChartWorker>[1]): { container: HTMLElement; unmount(): void } {
    function Probe() {
      const result = useChartWorker(spec, options)
      return <div data-testid="probe" data-pending={String(result.pending)} dangerouslySetInnerHTML={result.svg ? { __html: result.svg } : undefined} />
    }
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(<Probe />) })
    return { container, unmount: () => act(() => { root.unmount() }) }
  }
  const settle = (): Promise<void> => act(async () => { await new Promise((r) => setTimeout(r, 20)) })

  it('uses a supplied Worker: the request reaches it, its answer is what is drawn, and the hook never terminates what it does not own', async () => {
    const fake = new FakeWorker()
    // (the answer is held until released, so what the chart shows can only have come from the worker)
    fake.hold = true
    const m = mountProbe({ width: 100, height: 100, worker: fake as unknown as Worker })
    await settle()
    expect(fake.posted).toHaveLength(1)
    expect(fake.posted[0]).toMatchObject({ spec: { width: 100 }, input: { width: 100, height: 100 } })
    expect(m.container.querySelector('[data-testid="probe"]')!.getAttribute('data-pending')).toBe('true')
    expect(m.container.querySelector('svg')).toBeNull()
    fake.hold = false
    await act(async () => { fake.release(); await new Promise((r) => setTimeout(r, 20)) })
    expect(m.container.querySelector('[data-testid="probe"]')!.getAttribute('data-pending')).toBe('false')
    expect(m.container.querySelector('svg .mark-line path')).not.toBeNull()
    m.unmount()
    expect(fake.terminated).toBe(false)
  })

  it('a worker the hook made (workerFactory) is the hook\'s: used, and terminated on unmount', async () => {
    const made: FakeWorker[] = []
    const m = mountProbe({ width: 100, height: 100, workerFactory: () => { const w = new FakeWorker(); made.push(w); return w as unknown as Worker } })
    await settle()
    expect(made).toHaveLength(1)
    expect(made[0]!.posted).toHaveLength(1)
    expect(m.container.querySelector('svg .mark-line path')).not.toBeNull()
    expect(made[0]!.terminated).toBe(false)
    m.unmount()
    expect(made[0]!.terminated).toBe(true)
  })

  it('a factory that returns null is the in-process path: nothing is posted anywhere', async () => {
    let calls = 0
    const m = mountProbe({ width: 100, height: 100, workerFactory: () => { calls++; return null } })
    await settle()
    expect(calls).toBeGreaterThan(0)
    expect(m.container.querySelector('svg .mark-line path')).not.toBeNull()
    m.unmount()
  })

  it('handles errors with a serializable response', () => {
    const response = handleChartWorkerRequest({ id: 2, spec, input: { width: 100, height: 100 } })
    expect(response.id).toBe(2)
    const bad = handleChartWorkerRequest({ id: 3, spec: { scales: 'bad' } as never })
    expect(bad.id).toBe(3)
    expect(bad.error?.message).toBeTruthy()
  })
})
