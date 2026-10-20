// @vitest-environment jsdom
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Chart, type ChartHandle } from './Chart'
import type { SelectValue, ViewDomain } from './interaction'

function scatterSpec() {
  return {
    $schema: 'https://vega.github.io/schema/vega/v6.json',
    width: 200, height: 100, padding: 5, autosize: 'none',
    data: [{ name: 't', values: [{ px: 0, py: 1, cat: 'a' }, { px: 5, py: 5, cat: 'b' }, { px: 10, py: 9, cat: 'c' }] }],
    scales: [
      { name: 'x', type: 'linear', domain: [0, 10], range: 'width', nice: true },
      { name: 'y', type: 'linear', domain: [0, 10], range: 'height', nice: true },
    ],
    axes: [{ scale: 'x', orient: 'bottom', title: 'X' }, { scale: 'y', orient: 'left', title: 'Y' }],
    marks: [{
      type: 'symbol', from: { data: 't' },
      encode: { update: {
        x: { scale: 'x', field: 'px' }, y: { scale: 'y', field: 'py' },
        size: { value: 60 }, fill: { value: 'steelblue' }, description: { field: 'cat' },
      } },
    }],
  } as const
}

function mount(node: React.ReactElement): { container: HTMLElement; root: ReturnType<typeof createRoot> } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => { root.render(node) })
  return { container, root }
}

beforeEach(() => {
  ;(Element.prototype as unknown as Record<string, unknown>).setPointerCapture = vi.fn()
  ;(Element.prototype as unknown as Record<string, unknown>).releasePointerCapture = vi.fn()
})
afterEach(() => { document.body.innerHTML = '' })

describe('pan/zoom', () => {
  it('zooms on wheel through domainRaw and resets on double click', () => {
    const { container, root } = mount(<Chart spec={scatterSpec() as never} panZoom width={200} height={100} />)
    const before = container.querySelector('svg .mark-symbol path')?.getAttribute('transform')
    const host = container.firstElementChild as HTMLElement
    const rect = { left: 0, top: 0, width: 210, height: 110, right: 210, bottom: 110, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
    host.getBoundingClientRect = () => rect
    act(() => {
      host.dispatchEvent(new WheelEvent('wheel', { deltaY: -200, clientX: 100, clientY: 50, bubbles: true, cancelable: true }))
    })
    expect(host.getAttribute('data-aster-view')).toBe('zoomed')
    const after = container.querySelector('svg .mark-symbol path')?.getAttribute('transform')
    expect(after).not.toBe(before)
    act(() => {
      host.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })
    expect(host.getAttribute('data-aster-view')).toBe('base')
    void root
  })

  it('supports a controlled view and reports changes', () => {
    const onViewChange = vi.fn()
    const view: ViewDomain = { x: [0, 5], y: [0, 5] }
    const { container } = mount(
      <Chart spec={scatterSpec() as never} panZoom view={view} onViewChange={onViewChange} width={200} height={100} />,
    )
    const host = container.firstElementChild as HTMLElement
    expect(host.getAttribute('data-aster-view')).toBe('zoomed')
    const rect = { left: 0, top: 0, width: 210, height: 110, right: 210, bottom: 110, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
    host.getBoundingClientRect = () => rect
    act(() => {
      host.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, clientX: 50, clientY: 50, bubbles: true, cancelable: true }))
    })
    expect(onViewChange).toHaveBeenCalled()
    const next = onViewChange.mock.calls.at(-1)![0] as ViewDomain
    expect(next.x![1] - next.x![0]).toBeLessThan(5)
  })

  it('exposes an imperative view/ref handle', () => {
    const ref = React.createRef<ChartHandle>()
    const { container } = mount(<Chart ref={ref} spec={scatterSpec() as never} panZoom width={200} height={100} />)
    expect(ref.current).not.toBeNull()
    expect(ref.current!.getSvg()).toContain('<svg')
    expect(ref.current!.getChartInfo()).not.toBeNull()
    act(() => { ref.current!.setView({ x: [2, 4] }) })
    expect(ref.current!.getView()).toEqual({ x: [2, 4] })
    expect((container.firstElementChild as HTMLElement).getAttribute('data-aster-view')).toBe('zoomed')
    act(() => { ref.current!.resetView() })
    expect(ref.current!.getView()).toBeNull()
  })

  it('pans with the keyboard and resets with 0', () => {
    const { container } = mount(<Chart spec={scatterSpec() as never} panZoom width={200} height={100} />)
    const host = container.firstElementChild as HTMLElement
    act(() => { host.focus() })
    act(() => { host.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })) })
    expect(host.getAttribute('data-aster-view')).toBe('zoomed')
    act(() => { host.dispatchEvent(new KeyboardEvent('keydown', { key: '0', bubbles: true })) })
    expect(host.getAttribute('data-aster-view')).toBe('base')
  })
})

describe('unified selection value', () => {
  it('reports point and interval selections in one value shape', () => {
    const onSelectionChange = vi.fn<(value: SelectValue | null) => void>()
    const { container } = mount(
      <Chart
        spec={scatterSpec() as never}
        width={200} height={100}
        onSelectionChange={onSelectionChange}
      />,
    )
    const overlay = container.querySelector('[data-testid="chart-brush-overlay"]')!
    const rect = { left: 0, top: 0, width: 210, height: 110, right: 210, bottom: 110, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
    overlay.getBoundingClientRect = () => rect
    ;(container.firstElementChild as HTMLElement).getBoundingClientRect = () => rect
    // click the first symbol (x=0,y=1 -> 5,90 in view coords)
    act(() => {
      overlay.dispatchEvent(new PointerEvent('pointerdown', { clientX: 5, clientY: 95, pointerId: 1, bubbles: true }))
    })
    act(() => {
      overlay.dispatchEvent(new PointerEvent('pointerup', { clientX: 5, clientY: 95, pointerId: 1, bubbles: true }))
    })
    const point = onSelectionChange.mock.calls.at(-1)![0] as SelectValue
    expect(point.type).toBe('point')
    if (point.type === 'point') expect(point.datum).toMatchObject({ px: 0, py: 1, cat: 'a' })

    act(() => {
      overlay.dispatchEvent(new PointerEvent('pointerdown', { clientX: 20, clientY: 20, pointerId: 2, bubbles: true }))
    })
    act(() => {
      overlay.dispatchEvent(new PointerEvent('pointermove', { clientX: 120, clientY: 80, pointerId: 2, bubbles: true }))
    })
    act(() => {
      overlay.dispatchEvent(new PointerEvent('pointerup', { clientX: 120, clientY: 80, pointerId: 2, bubbles: true }))
    })
    const interval = onSelectionChange.mock.calls.at(-1)![0] as SelectValue
    expect(interval.type).toBe('interval')
    if (interval.type === 'interval') {
      expect(interval.interval.x![0]).toBeLessThan(interval.interval.x![1])
    }
  })
})

describe('accessibility + keyboard navigation', () => {
  it('renders positioned focusable nodes with captions and selected state', () => {
    const selection: SelectValue = { type: 'point', datum: { cat: 'a' } }
    const { container } = mount(
      <Chart spec={scatterSpec() as never} width={200} height={100} selection={selection} />,
    )
    const tree = container.querySelector('[data-testid="chart-a11y"]')!
    expect(tree).not.toBeNull()
    const marks = [...tree.querySelectorAll('[data-a11y-kind="mark"]')]
    expect(marks.length).toBe(3)
    expect(marks.some((m) => m.getAttribute('aria-pressed') === 'true')).toBe(true)
    const axes = [...tree.querySelectorAll('[data-a11y-kind="axis"]')]
    expect(axes.length).toBe(2)
    expect(axes.some((a) => (a.getAttribute('aria-label') ?? '').includes("X-axis titled 'X'"))).toBe(true)
    expect(axes.some((a) => a.getAttribute('role') === 'slider')).toBe(true)
  })

  it('selects a mark with Enter and adjusts an axis with arrow keys', () => {
    const onPointSelect = vi.fn()
    const onViewChange = vi.fn()
    const { container } = mount(
      <Chart
        spec={scatterSpec() as never}
        width={200} height={100}
        panZoom
        onPointSelect={onPointSelect}
        onViewChange={onViewChange}
      />,
    )
    const tree = container.querySelector('[data-testid="chart-a11y"]')!
    const mark = tree.querySelector('[data-a11y-kind="mark"]') as HTMLElement
    act(() => { mark.focus() })
    act(() => { mark.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect(onPointSelect).toHaveBeenCalledWith(expect.objectContaining({ cat: expect.any(String) }))

    const slider = [...tree.querySelectorAll('[role="slider"]')][0] as HTMLElement
    act(() => { slider.focus() })
    const key = slider.getAttribute('aria-label')?.startsWith('Y-axis') ? 'ArrowDown' : 'ArrowRight'
    act(() => { slider.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })) })
    expect(onViewChange).toHaveBeenCalled()
  })
})


describe('interactive legend entries', () => {
  const legendSpec = {
    $schema: 'https://vega.github.io/schema/vega/v6.json',
    width: 220, height: 120, padding: 5, autosize: 'none',
    data: [{ name: 't', values: [
      { c: 'a', v: 1, g: 'x' }, { c: 'b', v: 2, g: 'x' },
      { c: 'c', v: 3, g: 'y' }, { c: 'd', v: 4, g: 'y' },
    ] }],
    scales: [
      { name: 'x', type: 'band', domain: { data: 't', field: 'c' }, range: 'width' },
      { name: 'y', type: 'linear', domain: [0, 5], range: 'height' },
      { name: 'colour', type: 'ordinal', domain: { data: 't', field: 'g' }, range: ['#4c78a8', '#e45756'] },
    ],
    axes: [{ scale: 'x', orient: 'bottom' }, { scale: 'y', orient: 'left' }],
    legends: [{ fill: 'colour', title: 'group' }],
    marks: [{ type: 'rect', from: { data: 't' }, encode: { update: {
      x: { scale: 'x', field: 'c' }, width: { scale: 'x', band: 1 },
      y: { scale: 'y', field: 'v' }, y2: { scale: 'y', value: 0 },
      fill: { scale: 'colour', field: 'g' }, description: { field: 'c' },
    } } }],
  } as never

  it('toggles a legend series with Enter and restores it with Space', () => {
    const { container } = mount(<Chart spec={legendSpec} width={220} height={120} />)
    const tree = container.querySelector('[data-testid="chart-a11y"]')!
    const entries = [...tree.querySelectorAll('[data-a11y-kind="legend-entry"]')] as HTMLElement[]
    expect(entries.length).toBe(2)
    expect(container.querySelectorAll('svg .mark-rect path').length).toBe(4)
    act(() => { entries[0]!.focus() })
    act(() => { entries[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect(container.querySelectorAll('svg .mark-rect path').length).toBe(2)
    expect(entries[0]!.getAttribute('aria-pressed')).toBe('true')
    act(() => { entries[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true })) })
    expect(container.querySelectorAll('svg .mark-rect path').length).toBe(4)
    expect(entries[0]!.getAttribute('aria-pressed')).toBe('false')
  })
})
