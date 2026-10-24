// @vitest-environment jsdom
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Chart, type ChartHandle } from './Chart'
import type { SelectionInterval, ViewDomain } from './interaction'

/** The tutorial naming (`xscale`/`yscale`), not the literal x/y the engine used to require. */
function tutorialSpec(names: { x: string; y: string } = { x: 'xscale', y: 'yscale' }) {
  return {
    $schema: 'https://vega.github.io/schema/vega/v6.json',
    width: 200, height: 100, padding: 5, autosize: 'none',
    data: [{ name: 't', values: [{ px: 0, py: 0 }, { px: 5, py: 5 }, { px: 10, py: 10 }] }],
    scales: [
      { name: names.x, type: 'linear', domain: [0, 10], range: 'width', nice: false },
      { name: names.y, type: 'linear', domain: [0, 10], range: 'height', nice: false },
    ],
    axes: [{ scale: names.x, orient: 'bottom' }, { scale: names.y, orient: 'left' }],
    marks: [{
      type: 'symbol', from: { data: 't' },
      encode: { update: { x: { scale: names.x, field: 'px' }, y: { scale: names.y, field: 'py' }, size: { value: 40 } } },
    }],
  }
}

const RECT = { left: 0, top: 0, width: 210, height: 110, right: 210, bottom: 110, x: 0, y: 0, toJSON: () => ({}) } as DOMRect

function mount(node: React.ReactElement): { container: HTMLElement; host: HTMLElement } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => { root.render(node) })
  const host = container.firstElementChild as HTMLElement
  host.getBoundingClientRect = () => RECT
  return { container, host }
}

/** Gesture target: the overlay the browser would hit first (events bubble to the chart). */
const overlayOf = (container: HTMLElement): Element => container.querySelector('[data-testid="chart-brush-overlay"]')!
const key = (host: HTMLElement, k: string): void => {
  act(() => { host.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })) })
}
const wheel = (host: HTMLElement): void => {
  act(() => { host.dispatchEvent(new WheelEvent('wheel', { deltaY: -200, clientX: 100, clientY: 50, bubbles: true, cancelable: true })) })
}
const ptr = (el: Element, type: string, x: number, y: number, id = 1): void => {
  act(() => { el.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, pointerId: id, bubbles: true })) })
}

beforeEach(() => {
  ;(Element.prototype as unknown as Record<string, unknown>).setPointerCapture = vi.fn()
  ;(Element.prototype as unknown as Record<string, unknown>).releasePointerCapture = vi.fn()
})
afterEach(() => { document.body.innerHTML = '' })

describe.each([
  ['xscale/yscale', { x: 'xscale', y: 'yscale' }],
  ['x/y', { x: 'x', y: 'y' }],
  ['arbitrary names', { x: 'horizontal', y: 'vertical' }],
])('pan/zoom/brush with scales named %s (C68)', (_label, names) => {
  it('zooms on wheel and reports a view for both positional axes', () => {
    const onViewChange = vi.fn<(v: ViewDomain | null) => void>()
    const { host } = mount(<Chart spec={tutorialSpec(names) as never} panZoom onViewChange={onViewChange} width={200} height={100} />)
    wheel(host)
    expect(host.getAttribute('data-aster-view')).toBe('zoomed')
    const view = onViewChange.mock.calls.at(-1)![0]!
    expect(view.x![1] - view.x![0]).toBeLessThan(10)
    expect(view.y![1] - view.y![0]).toBeLessThan(10)
  })

  it('the keyboard zooms with + and pans with ArrowRight (no onViewChange(null))', () => {
    const onViewChange = vi.fn<(v: ViewDomain | null) => void>()
    const { host } = mount(<Chart spec={tutorialSpec(names) as never} panZoom onViewChange={onViewChange} width={200} height={100} />)
    key(host, '+')
    expect(onViewChange.mock.calls.at(-1)![0]).not.toBeNull()
    key(host, 'ArrowRight')
    const view = onViewChange.mock.calls.at(-1)![0]!
    expect(view.x![0]).toBeGreaterThan(0)
  })

  it('re-evaluates the real scale: the marks move when the view changes', () => {
    const ref = React.createRef<ChartHandle>()
    const { container } = mount(<Chart ref={ref} spec={tutorialSpec(names) as never} panZoom width={200} height={100} />)
    const second = (): string | null | undefined => container.querySelectorAll('svg .mark-symbol path')[1]?.getAttribute('transform')
    const before = second()
    act(() => { ref.current!.setView({ x: [0, 5], y: [0, 5] }) })
    const after = second()
    expect(after).not.toBe(before)
    const info = ref.current!.getChartInfo()!
    expect((info.scales.get(names.x) as { domain(): number[] }).domain()).toEqual([0, 5])
  })

  it('a brush drag reports an x and y interval', () => {
    const onSelect = vi.fn<(i: SelectionInterval | null) => void>()
    const { container } = mount(<Chart spec={tutorialSpec(names) as never} onSelect={onSelect} width={200} height={100} />)
    ptr(overlayOf(container), 'pointerdown', 30, 20)
    ptr(overlayOf(container), 'pointermove', 130, 80)
    ptr(overlayOf(container), 'pointerup', 130, 80)
    const interval = onSelect.mock.calls.at(-1)![0]!
    expect(interval.x).toBeDefined()
    expect(interval.y).toBeDefined()
    expect(interval.x![1]).toBeGreaterThan(interval.x![0])
  })

  it('a controlled interval selection draws its rectangle (C64)', () => {
    const { container } = mount(
      <Chart spec={tutorialSpec(names) as never} selection={{ type: 'interval', interval: { x: [2, 6], y: [1, 4] } }} width={200} height={100} />,
    )
    const overlay = container.querySelector('[data-testid="chart-brush-overlay"]')!
    const rect = overlay.firstElementChild as HTMLElement
    expect(rect).not.toBeNull()
    expect(parseFloat(rect.style.width)).toBeCloseTo(80, 0) // 4 of 10 over a 200px plot
  })
})

describe.each([['xscale/yscale', { x: 'xscale', y: 'yscale' }], ['x/y', { x: 'x', y: 'y' }]])('pan direction follows the scale orientation, %s (C64)', (_l, names) => {
  it('dragging down moves a bottom-to-top y scale so the data follows the pointer', () => {
    const ref = React.createRef<ChartHandle>()
    const { container, host } = mount(<Chart ref={ref} spec={tutorialSpec(names) as never} panZoom width={200} height={100} />)
    act(() => { ref.current!.setView({ x: [2, 6], y: [2, 6] }) })
    const yBefore = ref.current!.getView()!.y!
    ptr(overlayOf(container), 'pointerdown', 50, 40)
    ptr(overlayOf(container), 'pointermove', 50, 60)
    ptr(overlayOf(container), 'pointerup', 50, 60)
    const view = ref.current!.getView()!
    // y grows upward on screen: dragging the content DOWN reveals higher values.
    expect(view.y![0]).toBeGreaterThan(yBefore[0])
    // x untouched by a purely vertical drag
    expect(view.x).toEqual([2, 6])
  })

  it('dragging right moves the x domain left', () => {
    const ref = React.createRef<ChartHandle>()
    const { container, host } = mount(<Chart ref={ref} spec={tutorialSpec(names) as never} panZoom width={200} height={100} />)
    act(() => { ref.current!.setView({ x: [2, 6], y: [2, 6] }) })
    ptr(overlayOf(container), 'pointerdown', 50, 40)
    ptr(overlayOf(container), 'pointermove', 90, 40)
    ptr(overlayOf(container), 'pointerup', 90, 40)
    expect(ref.current!.getView()!.x![0]).toBeLessThan(2)
  })
})

describe('pan / zoom aliases enable only their own gestures (C66)', () => {
  it('pan: arrows and drag work, wheel and +/- do not', () => {
    const onViewChange = vi.fn()
    const { host } = mount(<Chart spec={tutorialSpec() as never} pan onViewChange={onViewChange} width={200} height={100} />)
    wheel(host)
    key(host, '+')
    key(host, '-')
    expect(onViewChange).not.toHaveBeenCalled()
    key(host, 'ArrowRight')
    expect(onViewChange).toHaveBeenCalledTimes(1)
  })

  it('zoom: wheel and +/- work, arrows and drag do not', () => {
    const onViewChange = vi.fn()
    const { container, host } = mount(<Chart spec={tutorialSpec() as never} zoom onViewChange={onViewChange} width={200} height={100} />)
    key(host, 'ArrowRight')
    ptr(overlayOf(container), 'pointerdown', 50, 40)
    ptr(overlayOf(container), 'pointermove', 90, 40)
    ptr(overlayOf(container), 'pointerup', 90, 40)
    expect(onViewChange).not.toHaveBeenCalled()
    wheel(host)
    expect(onViewChange).toHaveBeenCalledTimes(1)
    key(host, '+')
    expect(onViewChange).toHaveBeenCalledTimes(2)
  })

  it('panZoom still enables everything', () => {
    const onViewChange = vi.fn()
    const { host } = mount(<Chart spec={tutorialSpec() as never} panZoom onViewChange={onViewChange} width={200} height={100} />)
    key(host, 'ArrowRight')
    wheel(host)
    expect(onViewChange).toHaveBeenCalledTimes(2)
  })
})

describe('width and height props are independent (C64)', () => {
  const sizeOf = (c: HTMLElement): [string | null | undefined, string | null | undefined] => {
    const svg = c.querySelector('svg')
    return [svg?.getAttribute('width'), svg?.getAttribute('height')]
  }
  it('width alone fixes the width; the height keeps the spec size until measured', () => {
    const { container } = mount(<Chart spec={tutorialSpec() as never} width={320} />)
    expect(sizeOf(container)).toEqual(['330', '110'])
  })
  it('height alone fixes the height', () => {
    const { container } = mount(<Chart spec={tutorialSpec() as never} height={150} />)
    expect(sizeOf(container)).toEqual(['210', '160'])
  })
  it('neither: the spec size is used (not a hard-coded 600x400)', () => {
    const { container } = mount(<Chart spec={tutorialSpec() as never} />)
    expect(sizeOf(container)).toEqual(['210', '110'])
  })
})
