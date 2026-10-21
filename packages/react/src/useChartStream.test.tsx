// @vitest-environment jsdom
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { describe, it, expect, afterEach } from 'vitest'
import { useChartStream, type UseChartStreamResult } from './useChartStream'

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

describe('useChartStream', () => {
  afterEach(() => { document.body.innerHTML = '' })

  function mount(opts: Parameters<typeof useChartStream>[1] = {}): {
    result: () => UseChartStreamResult
    unmount: () => void
  } {
    let current: UseChartStreamResult | null = null
    function Probe() {
      current = useChartStream(spec, opts)
      return <div data-testid="probe" data-count={String((current.scene?.items[0] as any)?.items?.length ?? 0)} />
    }
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    act(() => root.render(<Probe />))
    return {
      result: () => current!,
      unmount: () => { act(() => root.unmount()); host.remove() },
    }
  }

  it('primes the initial scene and appends through the stream', async () => {
    const m = mount()
    await act(async () => { await new Promise((r) => setTimeout(r, 50)) })
    expect(m.result().scene).not.toBeNull()
    expect(m.result().svg).toContain('<svg')
    expect(document.querySelector('[data-testid="probe"]')!.getAttribute('data-count')).toBe('2')

    await act(async () => {
      m.result().push({ append: { t: [{ x: 2, y: 3 }] } })
      await Promise.resolve()
    })
    expect(document.querySelector('[data-testid="probe"]')!.getAttribute('data-count')).toBe('3')
    expect(m.result().pulse()?.datasets.get('t')?.addedRanges).toEqual([[2, 3]])
    expect(m.result().stats().flushes).toBeGreaterThanOrEqual(2)
    m.unmount()
  })

  it('can be driven manually with autoFlush=false', async () => {
    const m = mount({ autoFlush: false })
    await act(async () => { await new Promise((r) => setTimeout(r, 50)) })
    m.result().push({ append: { t: [{ x: 2, y: 3 }] } })
    expect(m.result().pending().datasets.get('t')?.addedRanges).toEqual([[2, 3]])
    expect((m.result().scene?.items[0] as any).items.length).toBe(2)
    act(() => { m.result().flush() })
    expect((m.result().scene?.items[0] as any).items.length).toBe(3)
    m.unmount()
  })

  it('can align automatic flushes to requestAnimationFrame', async () => {
    const queue: FrameRequestCallback[] = []
    const origRaf = globalThis.requestAnimationFrame
    const origCancel = globalThis.cancelAnimationFrame
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => { queue.push(cb); return queue.length }) as typeof requestAnimationFrame
    globalThis.cancelAnimationFrame = (() => { /* no-op */ }) as typeof cancelAnimationFrame
    try {
      const m = mount({ flushPolicy: 'raf' })
      await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
      const before = (m.result().scene?.items[0] as any).items.length
      m.result().push({ append: { t: [{ x: 2, y: 3 }] } })
      expect(queue.length).toBe(1)
      expect((m.result().scene?.items[0] as any).items.length).toBe(before)
      await act(async () => { queue.shift()!(performance.now()); await new Promise((r) => setTimeout(r, 20)) })
      expect((m.result().scene?.items[0] as any).items.length).toBe(before + 1)
      m.unmount()
    } finally {
      globalThis.requestAnimationFrame = origRaf
      globalThis.cancelAnimationFrame = origCancel
    }
  })

  it('pauses automatic flushing and resumes the queued work', async () => {
    const m = mount()
    await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
    const before = (m.result().scene?.items[0] as any).items.length
    act(() => { m.result().pause() })
    await act(async () => {
      m.result().push({ append: { t: [{ x: 2, y: 3 }] } })
      await new Promise((r) => setTimeout(r, 20))
    })
    expect((m.result().scene?.items[0] as any).items.length).toBe(before)
    expect(m.result().stats().depth).toBe(1)
    await act(async () => {
      m.result().resume()
      await new Promise((r) => setTimeout(r, 20))
    })
    expect((m.result().scene?.items[0] as any).items.length).toBe(before + 1)
    m.unmount()
  })

  it('reports rejected pushes and respects coalescing', async () => {
    const m = mount({ capacity: 1, policy: 'coalesce', autoFlush: false })
    expect(m.result().push({ append: { t: [{ x: 2, y: 3 }] } })).toBe(true)
    expect(m.result().push({ append: { t: [{ x: 3, y: 4 }] } })).toBe(true)
    expect(m.result().stats()).toMatchObject({ depth: 1, coalesced: 1 })
    expect(m.result().pending().datasets.get('t')?.addedRanges).toEqual([[2, 4]])
    act(() => { m.result().flush() })
    expect((m.result().scene?.items[0] as any).items.length).toBe(4)
    m.unmount()
  })
})
