// @vitest-environment jsdom
/**
 * Every shell that measures its container sizes the spec the same way: `<Chart>`, `<SvgChart>` (with and without the interaction
 * capability) and the streaming components (`<ChartStream>`, and `<ChartWorkerStream>` on the main thread), mounted in a
 * measured container, draw exactly what the core draws for that spec.
 *
 * Without size props the view is the spec's own, as in Vega (DECISIONS Q11): the measured element is only what
 * `containerSize()` reads (`containerSize`), so a literal size draws at that size in any container and only Vega-Lite's
 * `"container"` follows it. With `width="container" height="container"` the view fills the element (`measuredSize` too, each
 * dimension its own). What the core does with the container is judged against vega in
 * `packages/conformance/src/view-size-vs-vega.test.ts`: a spec whose autosize is `none` keeps its own size, a numeric size with
 * any other autosize fills the container, a size signal or no size is the spec's own, Vega-Lite's `"container"` reads it.
 */
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { describe, expect, it, afterEach } from 'vitest'
import { renderSpec } from '@aster-charts/core'
import { compile } from '@aster-charts/vl'
import { ChartStream, type ChartStreamHandle } from './ChartStream'
import { ChartWorkerStream } from './ChartWorkerStream'
import type { ChartHandle } from './chart-types'
import { forEachVariant } from './testing/variants'

const BOX = { width: 900, height: 600 }

/** A ResizeObserver that reports BOX for every observed element. */
function stubResizeObserver(): () => void {
  const prev = (globalThis as { ResizeObserver?: unknown }).ResizeObserver
  class FakeResizeObserver {
    constructor(private readonly cb: ResizeObserverCallback) {}
    observe(target: Element): void { this.cb([{ target, contentRect: { ...BOX } } as unknown as ResizeObserverEntry], this as never) }
    unobserve(): void {}
    disconnect(): void {}
  }
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeResizeObserver
  return () => { (globalThis as { ResizeObserver?: unknown }).ResizeObserver = prev }
}

const rows = Array.from({ length: 40 }, (_, i) => ({ x: i, y: (i * 37) % 100 }))
const body = {
  data: [{ name: 't', values: rows }],
  scales: [
    { name: 'x', type: 'linear', domain: { data: 't', field: 'x' }, range: 'width', nice: true, zero: false },
    { name: 'y', type: 'linear', domain: { data: 't', field: 'y' }, range: 'height', nice: true, zero: false },
  ],
  axes: [{ scale: 'x', orient: 'bottom', title: 'X' }, { scale: 'y', orient: 'left', title: 'Y', grid: true }],
  marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'y' }, size: { value: 40 }, fill: { value: '#4c78a8' } } } }],
}
// the chart-bench study's frame: the view and the padding make exactly the 900 x 600 box, and autosize none fixes it
const margin = { top: 20, right: 20, bottom: 44, left: 56 }
const SPECS: Array<[string, Record<string, unknown>]> = [
  ['autosize none, numeric size (keeps its own size)', { ...body, width: 824, height: 536, padding: margin, autosize: 'none' }],
  ['autosize none, containing the padding (keeps its own size)', { ...body, width: 700, height: 400, padding: margin, autosize: { type: 'none', contains: 'padding' } }],
  ['autosize pad, numeric size (fills the container)', { ...body, width: 300, height: 200, padding: margin }],
  ['autosize fit-x, numeric size (fills the container)', { ...body, width: 300, height: 200, padding: margin, autosize: 'fit-x' }],
  ['a size signal (its own)', { ...body, padding: margin, signals: [{ name: 'width', value: 320 }, { name: 'height', value: 180 }] }],
  ['Vega-Lite width/height "container"', compile({ width: 'container', height: 'container', data: { values: rows }, mark: 'point', encoding: { x: { field: 'x', type: 'quantitative' }, y: { field: 'y', type: 'quantitative' } } } as never) as unknown as Record<string, unknown>],
]

/** What the core draws for the spec in the measured container: filling it in the dimensions given, else reading it only. */
const expected = (spec: Record<string, unknown>, fill: { width?: number; height?: number } | undefined): string =>
  renderSpec(spec as never, { ...(fill ? { measuredSize: fill } : {}), containerSize: BOX })

/** The size props of each case, and the part of the box the view fills with them. */
const FILLS: Array<[string, Record<string, unknown>, { width?: number; height?: number } | undefined]> = [
  ['no size props (the spec\'s own size)', {}, undefined],
  ['width and height "container"', { width: 'container', height: 'container' }, BOX],
  ['width "container"', { width: 'container' }, { width: BOX.width }],
  ['height "container"', { height: 'container' }, { height: BOX.height }],
]

let restore: (() => void) | null = null
let cleanup: Array<() => void> = []
afterEach(() => {
  act(() => { for (const c of cleanup) c() })
  cleanup = []
  restore?.()
  restore = null
  document.body.innerHTML = ''
})

const host = (): HTMLElement => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  restore = stubResizeObserver()
  const el = document.createElement('div')
  document.body.appendChild(el)
  return el
}

// (Vega-Lite's "container" re-reads the container on `window:resize`: an event stream, which needs the event loop)
const needs = (name: string): Array<'svg' | 'signals'> => (name.startsWith('Vega-Lite') ? ['svg', 'signals'] : ['svg'])
forEachVariant(['svg'], (Chart, variant) => {
  for (const [fillName, props, fill] of FILLS) {
    describe(`${fillName}: the measured container sizes the spec as the core does`, () => {
      for (const [name, spec] of SPECS) {
        variant.it(needs(name), name, () => {
          const el = host()
          const root = createRoot(el)
          cleanup.push(() => root.unmount())
          const ref = React.createRef<ChartHandle>()
          act(() => { root.render(<Chart ref={ref} spec={spec as never} a11y={false} {...props} />) })
          expect(ref.current!.getSvg()).toBe(expected(spec, fill))
        })
      }
    })
  }

  describe('a literal size draws at that size in any container (Q11)', () => {
    variant.it(['svg'], 'the README spec', () => {
      const el = host()
      const root = createRoot(el)
      cleanup.push(() => root.unmount())
      const ref = React.createRef<ChartHandle>()
      act(() => { root.render(<Chart ref={ref} spec={{ ...body, width: 400, height: 300 } as never} a11y={false} />) })
      const svg = el.querySelector('svg')!
      // 400 x 300 plus the axes' share of the padding, as Vega draws it: not the 900 x 600 box
      expect(Number(svg.getAttribute('width'))).toBeLessThan(500)
      expect(Number(svg.getAttribute('height'))).toBeLessThan(400)
      expect(ref.current!.getSvg()).toBe(renderSpec({ ...body, width: 400, height: 300 } as never, {}))
    })
  })
})

describe('the streaming components size the stream to the container they measure, as <Chart> does', () => {
  for (const [label, Stream] of [['ChartStream', ChartStream], ['ChartWorkerStream (main thread)', ChartWorkerStream]] as const) {
    for (const [fillName, props, fill] of FILLS) for (const [name, spec] of SPECS) {
      it(`${label}, ${fillName}: ${name}`, async () => {
        const el = host()
        const root = createRoot(el)
        cleanup.push(() => root.unmount())
        const ref = React.createRef<ChartStreamHandle>()
        await act(async () => { root.render(<Stream ref={ref} spec={spec as never} a11y={false} streamOptions={{ autoFlush: true }} {...props} />) })
        // the stream flushes what the inner chart measured
        for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
        expect(el.querySelector('svg')?.outerHTML.length ?? 0).toBeGreaterThan(0)
        const scene = ref.current!.scene()
        const { renderSceneToSvg } = await import('@aster-charts/core')
        expect(renderSceneToSvg(scene!)).toBe(expected(spec, fill))
      })
    }
  }
})
