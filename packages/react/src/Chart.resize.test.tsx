// @vitest-environment jsdom
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { compile } from '@aster/vl'
import { forEachVariant } from './testing/variants'

// A Vega-Lite view that fills its container: `width: 'container'` compiles to width / height signals that read
// `containerSize()` and re-run on `window:resize`, with an `autosize` fit that contains the padding.
const spec = compile({
  width: 'container', height: 'container', padding: 5,
  data: { name: 'table', values: [{ x: 0, y: 1 }] }, mark: 'line',
  encoding: { x: { field: 'x', type: 'quantitative' }, y: { field: 'y', type: 'quantitative' } },
} as never) as never

const rowsAt = (edits: Record<number, number>): Array<{ x: number; y: number }> =>
  Array.from({ length: 60 }, (_, i) => ({ x: i, y: edits[i] ?? 50 + Math.round(40 * Math.sin(i / 5)) }))

/** What a viewport resize does to the page: the window fires `resize` (and a container observer fires, when one exists). */
const resizeWindow = (): void => { act(() => { window.dispatchEvent(new Event('resize')) }) }

/** A ResizeObserver that reports `size.current` to each observed element, and again on `fire()`. */
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
  return {
    fire: () => { act(() => { for (const r of live) r() }) },
    restore: () => { (globalThis as { ResizeObserver?: unknown }).ResizeObserver = prev },
  }
}

forEachVariant(['signals'], (Chart, variant) => {
  describe('a container-sized spec with an explicit width / height', () => {
    let roots: Array<{ unmount(): void }> = []
    afterEach(() => { act(() => { for (const r of roots) r.unmount() }); roots = []; document.body.innerHTML = '' })

    const mount = (node: React.ReactElement): HTMLElement => {
      ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      roots.push(root)
      act(() => { root.render(node) })
      return container
    }
    const svgOf = (c: HTMLElement): SVGSVGElement => c.querySelector('svg')!
    const size = (c: HTMLElement): [string | null, string | null] => [svgOf(c).getAttribute('width'), svgOf(c).getAttribute('height')]

    variant.it(['signals'], 'keeps the chart at its props through window resizes and incremental data updates, as a fresh mount', () => {
      const chart = (edits: Record<number, number>, changed: number[] | undefined): React.ReactElement => (
        <Chart spec={spec} width={480} height={260} data={{ table: rowsAt(edits) }} {...(changed ? { dataChanges: { table: changed } } : {})} />
      )
      const live = mount(chart({}, undefined))
      expect(size(live)).toEqual(['480', '260'])
      const edits: Record<number, number> = {}
      const root = roots[0]!
      for (const [i, y] of [[7, 12], [14, 80], [21, 33]] as const) {
        edits[i] = y
        resizeWindow()
        act(() => { (root as unknown as { render(n: React.ReactElement): void }).render(chart(edits, [i])) })
        const fresh = mount(chart(edits, undefined))
        expect(size(live), `after the edit of row ${i}`).toEqual(['480', '260'])
        // the live (patched) DOM is the fresh mount's: the plot, its axes and their offsets
        expect(svgOf(live).outerHTML).toBe(svgOf(fresh).outerHTML)
      }
    })

    variant.it(['signals'], 'a measured height beside a fixed width follows the container only, and matches a fresh mount', () => {
      const box = { current: { width: 700, height: 300 } }
      const ro = stubResizeObserver(box)
      try {
        const chart = (edits: Record<number, number>, changed: number[] | undefined): React.ReactElement => (
          <Chart spec={spec} width={480} data={{ table: rowsAt(edits) }} {...(changed ? { dataChanges: { table: changed } } : {})} />
        )
        const live = mount(chart({}, undefined))
        expect(size(live)).toEqual(['480', '300'])
        box.current = { width: 520, height: 340 }
        ro.fire()
        resizeWindow()
        const edits = { 5: 20 }
        act(() => { (roots[0] as unknown as { render(n: React.ReactElement): void }).render(chart(edits, [5])) })
        const fresh = mount(chart(edits, undefined))
        expect(size(live)).toEqual(['480', '340'])
        expect(svgOf(live).outerHTML).toBe(svgOf(fresh).outerHTML)
      } finally { ro.restore(); vi.restoreAllMocks() }
    })

    variant.it(['signals'], 'without size props a container-sized spec follows the container through window resizes, as a fresh mount', () => {
      const box = { current: { width: 700, height: 200 } }
      const ro = stubResizeObserver(box)
      // the element as the browser lays it out: what `containerSize()` reads when the `window:resize` handler runs
      const proto = HTMLElement.prototype
      const saved = [Object.getOwnPropertyDescriptor(proto, 'clientWidth'), Object.getOwnPropertyDescriptor(proto, 'clientHeight')] as const
      Object.defineProperty(proto, 'clientWidth', { configurable: true, get: () => box.current.width })
      Object.defineProperty(proto, 'clientHeight', { configurable: true, get: () => box.current.height })
      try {
        const chart = (edits: Record<number, number>, changed: number[] | undefined): React.ReactElement => (
          <Chart spec={spec} data={{ table: rowsAt(edits) }} {...(changed ? { dataChanges: { table: changed } } : {})} />
        )
        const live = mount(chart({}, undefined))
        expect(size(live)).toEqual(['700', '200'])
        const edits: Record<number, number> = {}
        for (const [i, to] of [[7, { width: 500, height: 220 }], [14, { width: 320, height: 180 }]] as const) {
          edits[i] = 12 + i
          box.current = to
          ro.fire()
          resizeWindow()
          act(() => { (roots[0] as unknown as { render(n: React.ReactElement): void }).render(chart(edits, [i])) })
          const fresh = mount(chart(edits, undefined))
          expect(size(live), `after the resize to ${to.width}x${to.height}`).toEqual([String(to.width), String(to.height)])
          expect(svgOf(live).outerHTML).toBe(svgOf(fresh).outerHTML)
        }
      } finally {
        ro.restore()
        for (const [k, d] of [['clientWidth', saved[0]], ['clientHeight', saved[1]]] as const) { if (d) Object.defineProperty(proto, k, d); else delete (proto as unknown as Record<string, unknown>)[k] }
      }
    })
  })
})
