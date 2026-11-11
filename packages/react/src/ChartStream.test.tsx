// @vitest-environment jsdom
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { describe, it, expect, afterEach } from 'vitest'
import { ChartStream, ChartWorkerStream, type ChartStreamHandle } from './ChartStream'
import { handleChartWorkerStreamRequest, type ChartWorkerStreamRequest } from './worker'
import { compile } from '@aster-charts/vl'
import { compileChart, evaluateChart, renderSceneToSvg, type SceneRoot } from '@aster-charts/core'

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
  // Like a real Worker: only `message` listeners receive responses.
  addEventListener(type: string, fn: (event: MessageEvent) => void): void { if (type === 'message') this.listeners.add(fn) }
  removeEventListener(type: string, fn: (event: MessageEvent) => void): void { if (type === 'message') this.listeners.delete(fn) }
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

  it('a Vega-Lite scatter coloured by a category: an append of a category it has keeps the colour scale and every point, and draws the new one', async () => {
    // (Vega-Lite's validity filter runs before the colour scale's dataset, and the scale's domain is sorted)
    const vl = compile({
      width: 200, height: 100, data: { name: 'src' }, mark: 'point',
      encoding: { x: { field: 'x', type: 'quantitative' }, y: { field: 'y', type: 'quantitative' }, color: { field: 'c', type: 'nominal' } },
    } as never) as never
    const rows = Array.from({ length: 30 }, (_, i) => ({ x: i, y: (i * 7) % 11, c: ['b', 'a', 'c'][i % 3] }))
    const ref = React.createRef<ChartStreamHandle>()
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(<ChartStream ref={ref} spec={vl} width={200} height={100} streamOptions={{ autoFlush: false, initial: { data: { src: rows } } }} />)
      await wait()
    })
    const points = (scene: SceneRoot): unknown[] => {
      const out: unknown[] = []
      const walk = (items: readonly unknown[]): void => {
        for (const it of items) {
          const g = it as { role?: string; marktype?: string; items?: unknown[] }
          if (g.role === 'mark' && g.marktype === 'symbol') out.push(...(g.items ?? []))
          else if (Array.isArray(g.items)) walk(g.items)
        }
      }
      walk(scene.items)
      return out
    }
    const color = (scene: SceneRoot): unknown => (scene as unknown as { __scaleMap: Map<string, unknown> }).__scaleMap.get('color')
    expect(points(ref.current!.scene()!).length).toBe(rows.length)
    let all = rows
    for (const [k, c] of ['a', 'c', 'new', 'b'].entries()) {
      const before = ref.current!.scene()!
      const added = [{ x: 3 + k, y: 5, c }]
      all = [...all, ...added]
      await act(async () => {
        ref.current!.push({ append: { src: added } })
        ref.current!.flush()
        await wait()
      })
      const after = ref.current!.scene()!
      const fresh = evaluateChart(compileChart(vl), { data: { src: all }, width: 200, height: 100 })
      expect(renderSceneToSvg(after), c).toBe(renderSceneToSvg(fresh))
      // (the patched DOM shows the scene: one point per row)
      expect(host.querySelectorAll('svg g.mark-symbol.role-mark path').length, c).toBe(all.length)
      const was = new Set(points(before))
      const kept = points(after).filter((p) => was.has(p)).length
      if (c === 'new') {
        // (a category the scale did not have: every point is coloured again)
        expect(color(after), c).not.toBe(color(before))
        expect(kept, c).toBe(0)
      } else {
        expect(color(after), c).toBe(color(before))
        expect(kept, c).toBe(points(before).length)
      }
      expect(points(after).length, c).toBe(points(before).length + 1)
    }
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
