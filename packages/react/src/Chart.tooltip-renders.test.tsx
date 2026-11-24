// @vitest-environment jsdom
/**
 * A pointer move that only moves the tooltip renders the tooltip, not the chart: the chart-bench survival chart's tooltip changes on
 * every move, and each change rendered the whole chart (every hook, the accessible overlay, the SVG host) a second time per move.
 *
 * The chart's renders are counted where every one of them passes (the development check of the rows it was given, which ChartCore
 * imports from the lean engine entry: that is the module mocked, a mock of any other entry would count nothing). The counter is
 * proven live before it is trusted: it moves at mount and on a re-render the test forces, and only then must the pointer moves leave
 * it where it is. The tooltip still shows what the item under the pointer says, move after move.
 */
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { describe, it, expect, vi } from 'vitest'
import { forEachVariant } from './testing/variants'
import { chartTooltip } from './testing/tooltip'

const renders = vi.hoisted(() => ({ count: 0 }))
vi.mock('@aster-charts/core/lean', async (importOriginal) => {
  const lean = await importOriginal<typeof import('@aster-charts/core/lean')>()
  return { ...lean, checkChartRows: (...args: Parameters<typeof lean.checkChartRows>) => { renders.count++; return lean.checkChartRows(...args) } }
})

forEachVariant(['interaction'], (Chart) => {
  const spec = {
    width: 400, height: 300, padding: 0, autosize: 'none',
    data: [{ name: 'table', values: [{ x: 1, y: 2, label: 'a' }, { x: 4, y: 3, label: 'b' }, { x: 7, y: 6, label: 'c' }] }],
    scales: [
      { name: 'x', type: 'linear', domain: [0, 10], range: 'width' },
      { name: 'y', type: 'linear', domain: [0, 10], range: 'height' },
    ],
    marks: [
      { type: 'symbol', from: { data: 'table' }, encode: { update: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'y' }, size: { value: 400 }, tooltip: { signal: 'datum.label' } } } },
    ],
  }

  describe('a tooltip move renders the tooltip, not the chart', () => {
    it('moves over three items and off them without rendering the chart again', () => {
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      act(() => { root.render(<Chart spec={spec} width={400} height={300} tooltip />) })
      const svg = container.querySelector('svg')!
      const tip = (): string | null => chartTooltip()?.textContent ?? null
      // the counter sees the mount, and a re-render the test forces (a new className re-renders the chart and nothing else)
      const mounted = renders.count
      expect(mounted).toBeGreaterThan(0)
      act(() => { root.render(<Chart spec={spec} width={400} height={300} tooltip className="forced" />) })
      const at = renders.count
      expect(at, 'a forced re-render must be counted').toBeGreaterThan(mounted)
      const move = (x: number, y: number): void => {
        act(() => { svg.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y })) })
      }
      move(40, 240)
      expect(tip()).toBe('a')
      move(160, 210)
      expect(tip()).toBe('b')
      move(280, 120)
      expect(tip()).toBe('c')
      move(390, 10)
      expect(tip()).toBeNull()
      move(160, 210)
      expect(tip()).toBe('b')
      expect(renders.count - at).toBe(0)
      act(() => { root.unmount() })
      container.remove()
    })
  })
})
