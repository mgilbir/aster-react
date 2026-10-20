// @vitest-environment jsdom
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { describe, it, expect, afterEach } from 'vitest'
import { handleChartWorkerRequest, useChartWorker } from './worker'

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

describe('worker offload (R11.4)', () => {
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

  it('uses a supplied Worker and applies its response', async () => {
    class FakeWorker {
      listeners = new Set<(event: MessageEvent) => void>()
      terminated = false
      addEventListener(_type: string, fn: (event: MessageEvent) => void) { this.listeners.add(fn) }
      removeEventListener(_type: string, fn: (event: MessageEvent) => void) { this.listeners.delete(fn) }
      postMessage(request: { id: number; spec: never; input?: never }) {
        const response = handleChartWorkerRequest(request)
        queueMicrotask(() => {
          for (const fn of this.listeners) fn({ data: response } as MessageEvent)
        })
      }
      terminate() { this.terminated = true }
    }
    const fake = new FakeWorker()
    function Probe() {
      const result = useChartWorker(spec, { width: 100, height: 100, worker: fake as unknown as Worker })
      return <div data-testid="probe" data-pending={String(result.pending)} dangerouslySetInnerHTML={result.svg ? { __html: result.svg } : undefined} />
    }
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => { root.render(<Probe />) })
    await act(async () => { await Promise.resolve() })
    expect(container.querySelector('[data-testid="probe"]')!.getAttribute('data-pending')).toBe('false')
    expect(container.querySelector('svg .mark-line path')).not.toBeNull()
    act(() => { root.unmount() })
  })

  it('handles errors with a serializable response', () => {
    const response = handleChartWorkerRequest({ id: 2, spec, input: { width: 100, height: 100 } })
    expect(response.id).toBe(2)
    const bad = handleChartWorkerRequest({ id: 3, spec: { scales: 'bad' } as never })
    expect(bad.id).toBe(3)
    expect(bad.error?.message).toBeTruthy()
  })
})
