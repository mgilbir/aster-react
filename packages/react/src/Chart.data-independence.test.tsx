// @vitest-environment jsdom
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { compile } from '@aster-charts/vl'
import type { VgSpec } from '@aster-charts/core'
import { registerVegaLiteCompiler } from './vl-registry'
import { forEachVariant } from './testing/variants'
import { ChartStream, ChartWorkerStream } from './ChartStream'
import { useChart } from './useChart'
import { renderChartToStaticMarkup } from './ssr'
import { handleChartWorkerRequest, useChartWorker } from './worker'

// Turning a spec into a chart reads its rows only where the chart needs them: an evaluation reads the fields its transforms use,
// and nothing else. Every row below carries a field no chart uses, read through a counting getter, and the marks draw an aggregate
// of the rows (a mark's items hold copies of the rows they draw, so a mark drawing the rows themselves would read every field of
// them: that is the drawing). The compile, the spec comparisons, the skeleton, the add-on scan, the worker handler and SSR never
// read it -- every generic walk, clone, stringify or deep compare of rows would. And a Vega-Lite spec is compiled once per change
// of its content, whichever component or hook holds it.

let unusedReads = 0
let compilerReads = 0
let compiles = 0
let inCompiler = false
const row = (i: number): Record<string, unknown> => {
  const r: Record<string, unknown> = { k: `k${i % 3}`, x: i, y: (i * 7) % 11 }
  Object.defineProperty(r, 'unused', { enumerable: true, get: () => { unusedReads++; if (inCompiler) compilerReads++; return i } })
  return r
}
const rows = (n: number): Array<Record<string, unknown>> => Array.from({ length: n }, (_, i) => row(i))

beforeEach(() => {
  unusedReads = 0
  compilerReads = 0
  compiles = 0
  registerVegaLiteCompiler((spec) => {
    compiles++
    inCompiler = true
    try { return compile(spec as never) as VgSpec } finally { inCompiler = false }
  })
})
afterEach(() => {
  registerVegaLiteCompiler((spec) => compile(spec as never) as VgSpec)
  document.body.innerHTML = ''
})

const VL = 'https://vega.github.io/schema/vega-lite/v6.json'
const counts = { x: { field: 'k', type: 'nominal' }, y: { aggregate: 'count', type: 'quantitative' } } // (a count needs no cast of a field: a cast copies the rows)
const vl = (values: unknown[]): VgSpec => ({ $schema: VL, width: 120, height: 80, data: { values }, mark: 'bar', encoding: counts }) as VgSpec
const vlDatasets = (main: unknown[]): VgSpec => ({ $schema: VL, width: 120, height: 80, datasets: { main }, data: { name: 'main' }, mark: 'bar', encoding: counts }) as VgSpec
const vega = (values: unknown[]): VgSpec => ({
  $schema: 'https://vega.github.io/schema/vega/v6.json', width: 120, height: 80,
  data: [{ name: 't', values }, { name: 'agg', source: 't', transform: [{ type: 'aggregate', groupby: ['k'], fields: ['y'], ops: ['sum'], as: ['s'] }] }],
  scales: [{ name: 'x', type: 'band', domain: { data: 'agg', field: 'k' }, range: 'width' }],
  marks: [{ type: 'rect', from: { data: 'agg' }, encode: { update: { x: { scale: 'x', field: 'k' }, width: { value: 5 }, y: { value: 5 }, height: { signal: 'datum.s' } } } }],
}) as VgSpec

function mount(el: React.ReactElement): { root: ReturnType<typeof createRoot>; container: HTMLElement } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => { root.render(el) })
  return { root, container }
}

forEachVariant(['svg'], (Chart) => describe('<Chart> reads no row it does not draw', () => {
  it('a Vega-Lite spec: mount, re-render, a new spec object over the same rows', () => {
    const data = rows(200)
    const { root, container } = mount(<Chart spec={vl(data)} width={120} height={80} />)
    expect(container.querySelector('svg')).not.toBeNull()
    act(() => { root.render(<Chart spec={vl(data)} width={120} height={80} />) })
    act(() => { root.render(<Chart spec={vl(data)} width={121} height={80} />) })
    expect(compilerReads).toBe(0)
    expect(unusedReads).toBe(0)
    expect(compiles).toBe(1)
    act(() => { root.unmount() })
  })

  it('a Vega-Lite spec whose rows are named `datasets`: a new spec object over the same rows reads none of them', () => {
    const main = rows(200)
    const { root } = mount(<Chart spec={vlDatasets(main)} width={120} height={80} />)
    act(() => { root.render(<Chart spec={vlDatasets(main)} width={120} height={80} />) })
    expect(unusedReads).toBe(0)
    expect(compiles).toBe(1)
    act(() => { root.unmount() })
  })

  it('a Vega spec with inline values', () => {
    const data = rows(200)
    const { root, container } = mount(<Chart spec={vega(data)} width={120} height={80} />)
    act(() => { root.render(<Chart spec={vega(data)} width={120} height={80} />) })
    expect(container.querySelectorAll('path').length).toBeGreaterThan(0)
    expect(unusedReads).toBe(0)
    act(() => { root.unmount() })
  })
}))

describe('the hooks, SSR, the worker and the stream components read no row they do not draw', () => {
  it('useChart', () => {
    const data = rows(200)
    function Probe(): React.ReactElement {
      const { svg, error } = useChart(vl(data))
      return <div data-error={error?.message ?? ''} data-svg={svg ? 'yes' : 'no'} />
    }
    const { root, container } = mount(<Probe />)
    expect(container.firstElementChild!.getAttribute('data-error')).toBe('')
    expect(compilerReads).toBe(0)
    // (useChart compares a re-created spec by content, rows included -- by design, a stream must not restart -- so only the mount is
    // counted for rows; the compile happens once)
    expect(unusedReads).toBe(0)
    act(() => { root.render(<Probe />) })
    expect(compiles).toBe(1)
    act(() => { root.unmount() })
  })

  it('SSR', () => {
    const svg = renderChartToStaticMarkup(vl(rows(200)))
    expect(svg).toContain('<svg')
    expect(unusedReads).toBe(0)
  })

  it('the worker request handler, and useChartWorker without a Worker', () => {
    const res = handleChartWorkerRequest({ id: 1, spec: vl(rows(200)), input: { width: 120, height: 80 } })
    expect(res.svg).toContain('<svg')
    expect(unusedReads).toBe(0)
    const data = rows(200)
    const spec = vl(data)
    function Probe({ w }: { w: number }): React.ReactElement {
      const { svg } = useChartWorker(spec, { width: w, height: 80 })
      return <div data-svg={svg ? 'yes' : 'no'} />
    }
    compiles = 0
    const { root } = mount(<Probe w={120} />)
    act(() => { root.render(<Probe w={130} />) })
    act(() => { root.render(<Probe w={140} />) })
    expect(unusedReads).toBe(0)
    // (a new size is a new request; the spec it compiles has not changed)
    expect(compiles).toBe(1)
    act(() => { root.unmount() })
  })

  for (const [name, Stream] of [['ChartStream', ChartStream], ['ChartWorkerStream', ChartWorkerStream]] as const) {
    it(`<${name}> with a Vega-Lite spec compiles it once`, async () => {
      const data = rows(50)
      const { root } = mount(<Stream spec={vl(data)} width={120} height={80} />)
      await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
      act(() => { root.render(<Stream spec={vl(data)} width={120} height={80} />) })
      await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
      expect(compilerReads).toBe(0)
      expect(compiles).toBe(1)
      act(() => { root.unmount() })
    })
  }
})
