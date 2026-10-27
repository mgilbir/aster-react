// @vitest-environment jsdom
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { describe, it, expect, afterEach } from 'vitest'
import type { ChartHandle } from './Chart'
import { forEachVariant } from './testing/variants'

// `width` / `height` are signals in Vega (`view.width(w)` is a signal write, and the later write wins). A spec that
// drives them itself (a bound slider, a handler) must keep doing so in a <Chart> that measures its container.

const sliderSpec = {
  $schema: 'https://vega.github.io/schema/vega/v6.json',
  height: 50, padding: 0, autosize: 'none',
  signals: [{ name: 'width', value: 300, bind: { input: 'range', min: 100, max: 500, step: 1 } }],
  data: [{ name: 't', values: [{ v: 1 }] }],
  scales: [{ name: 'x', type: 'linear', domain: [0, 1], range: 'width' }],
  marks: [{ type: 'rect', from: { data: 't' }, encode: { update: { x: { value: 0 }, y: { value: 0 }, height: { value: 10 }, width: { signal: 'width' }, fill: { value: 'steelblue' } } } }],
} as never

/** A ResizeObserver that reports `size.current` for each observed element, and again on `fire()`. */
function stubResizeObserver(size: { current: { width: number; height: number } }): { fire(): void; restore(): void } {
  const prev = (globalThis as { ResizeObserver?: unknown }).ResizeObserver
  const live = new Set<() => void>()
  class FakeResizeObserver {
    private report: () => void
    constructor(cb: ResizeObserverCallback) { this.report = () => cb([{ contentRect: { ...size.current } } as ResizeObserverEntry], this as never) }
    observe(): void { live.add(this.report); this.report() }
    unobserve(): void { live.delete(this.report) }
    disconnect(): void { live.delete(this.report) }
  }
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeResizeObserver
  return { fire: () => { act(() => { for (const r of live) r() }) }, restore: () => { (globalThis as { ResizeObserver?: unknown }).ResizeObserver = prev } }
}

const setInputValue = (input: HTMLInputElement, value: string): void => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
  act(() => { input.dispatchEvent(new Event('input', { bubbles: true })) })
}

forEachVariant(['svg'], (Chart) => {
  describe('a spec that drives the width signal itself, in a <Chart> that measures its container', () => {
    afterEach(() => { document.body.innerHTML = '' })

    it('a slider write reaches the signal and the marks that read it (as it always has)', () => {
      ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
      const ro = stubResizeObserver({ current: { width: 700, height: 200 } })
      try {
        const ref = React.createRef<ChartHandle>()
        const container = document.createElement('div')
        document.body.appendChild(container)
        const root = createRoot(container)
        act(() => { root.render(<Chart ref={ref} spec={sliderSpec} />) })
        setInputValue(container.querySelector('input[type="range"]') as HTMLInputElement, '250')
        expect(ref.current!.getSignals().width).toBe(250)
        expect(((ref.current!.getScene()!.items[0] as { items: Array<{ width: number }> }).items[0])!.width).toBe(250)
        act(() => { root.unmount() })
      } finally { ro.restore() }
    })

    it('a bound width slider moves the view; the measured container does not override it', () => {
      ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
      const box = { current: { width: 700, height: 200 } }
      const ro = stubResizeObserver(box)
      try {
        const ref = React.createRef<ChartHandle>()
        const container = document.createElement('div')
        document.body.appendChild(container)
        const root = createRoot(container)
        act(() => { root.render(<Chart ref={ref} spec={sliderSpec} />) })
        const svgWidth = (): string | null => container.querySelector('svg')!.getAttribute('width')
        const rectWidth = (): number => ((ref.current!.getScene()!.items[0] as { items: Array<{ width: number }> }).items[0])!.width
        const scaleRange = (): number => Number((ref.current!.getScene() as unknown as { __scales: Array<{ range: number[] }> }).__scales[0]!.range[1])
        // the spec's own value is the view size; the container is only what `containerSize()` reports
        expect([svgWidth(), rectWidth(), scaleRange()]).toEqual(['300', 300, 300])
        setInputValue(container.querySelector('input[type="range"]') as HTMLInputElement, '250')
        expect(ref.current!.getSignals().width).toBe(250)
        expect([svgWidth(), rectWidth(), scaleRange()]).toEqual(['250', 250, 250])
        // a container resize afterwards does not undo the slider
        box.current = { width: 640, height: 220 }
        ro.fire()
        expect([svgWidth(), rectWidth(), scaleRange()]).toEqual(['250', 250, 250])
        act(() => { root.unmount() })
      } finally { ro.restore() }
    })
  })
})
