// @vitest-environment jsdom
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { describe, it, expect, afterEach } from 'vitest'
import { ChartStream, ChartWorkerStream, type ChartStreamHandle } from './ChartStream'
import { handleChartWorkerStreamRequest, type ChartWorkerStreamRequest } from './worker'

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

class FakeWorker {
  listeners = new Set<(event: MessageEvent) => void>()
  streams = new Map<number, never>()
  addEventListener(_type: string, fn: (event: MessageEvent) => void): void { this.listeners.add(fn) }
  removeEventListener(_type: string, fn: (event: MessageEvent) => void): void { this.listeners.delete(fn) }
  postMessage(request: ChartWorkerStreamRequest): void {
    const response = handleChartWorkerStreamRequest(request, this.streams as never)
    queueMicrotask(() => { for (const fn of this.listeners) fn({ data: response } as MessageEvent) })
  }
  terminate(): void { /* no-op */ }
}

const wait = (): Promise<void> => new Promise((r) => setTimeout(r, 20))

describe('streaming chart components', () => {
  afterEach(() => { document.body.innerHTML = '' })

  it('patches the same SVG element for an append', async () => {
    const ref = React.createRef<ChartStreamHandle>()
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(<ChartStream ref={ref} spec={spec} width={200} height={100} streamOptions={{ autoFlush: false }} />)
      await wait()
    })
    const svg = host.querySelector('svg')!
    expect(svg).not.toBeNull()
    const before = svg.querySelectorAll('path').length
    const scene = ref.current!.scene()!
    const beforeItems = (scene.items[0] as { items: unknown[] }).items.length

    await act(async () => {
      ref.current!.push({ append: { t: [{ x: 2, y: 3 }] } })
      ref.current!.flush()
      await wait()
    })
    const after = host.querySelector('svg')!
    expect(after).toBe(svg)
    expect(after.querySelectorAll('path').length).toBeGreaterThan(before)
    expect((ref.current!.scene()!.items[0] as { items: unknown[] }).items.length).toBe(beforeItems + 1)
    act(() => root.unmount())
  })

  it('renders a streamed scene on the canvas backend', async () => {
    const ref = React.createRef<ChartStreamHandle>()
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(<ChartStream ref={ref} spec={spec} width={200} height={100} renderer="canvas" streamOptions={{ autoFlush: false }} />)
      await wait()
    })
    expect(host.querySelector('[data-testid="chart-canvas"]')).not.toBeNull()
    const before = (ref.current!.scene()!.items[0] as { items: unknown[] }).items.length
    await act(async () => {
      ref.current!.push({ append: { t: [{ x: 2, y: 3 }] } })
      ref.current!.flush()
      await wait()
    })
    expect((ref.current!.scene()!.items[0] as { items: unknown[] }).items.length).toBe(before + 1)
    act(() => root.unmount())
  })

  it('uses the worker stream path when a Worker is supplied', async () => {
    const ref = React.createRef<ChartStreamHandle>()
    const fake = new FakeWorker()
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(<ChartWorkerStream ref={ref} spec={spec} width={200} height={100} streamOptions={{ worker: fake as unknown as Worker, autoFlush: false }} />)
      await wait()
    })
    expect(host.querySelector('svg')).not.toBeNull()
    const before = (ref.current!.scene()!.items[0] as { items: unknown[] }).items.length
    await act(async () => {
      ref.current!.push({ append: { t: [{ x: 2, y: 3 }] } })
      ref.current!.flush()
      await wait()
    })
    expect((ref.current!.scene()!.items[0] as { items: unknown[] }).items.length).toBe(before + 1)
    act(() => root.unmount())
  })
})
