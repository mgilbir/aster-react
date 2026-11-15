// @vitest-environment jsdom
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { describe, it, expect, afterEach, vi } from 'vitest'
import type { VgSpec } from '@aster-charts/core'
import './vl'
import { forEachVariant } from './testing/variants'
import { useChart } from './useChart'
import { useChartWorker } from './worker'
import { ChartStream, type ChartStreamHandle } from './ChartStream'

// Development builds: a chart warns, once per dataset, when rows it was given are changed in place and it renders again with the same
// array -- whether or not that render evaluates anything (core's row-watch.ts). Through the logger it is given, else the console.

const rows = (n: number): Array<Record<string, unknown>> => Array.from({ length: n }, (_, i) => ({ k: `k${i % 3}`, v: i }))
const vega = (values?: unknown[]): VgSpec => ({
  width: 60, height: 30,
  data: [{ name: 't', ...(values ? { values } : {}) }],
  marks: [{ type: 'rect', from: { data: 't' }, encode: { update: { x: { field: 'v' }, width: { value: 1 }, y: { value: 0 }, height: { value: 1 } } } }],
}) as unknown as VgSpec
const vl = (values: unknown[]): VgSpec => ({
  $schema: 'https://vega.github.io/schema/vega-lite/v6.json', width: 60, height: 30, data: { values }, mark: 'bar',
  encoding: { x: { field: 'k', type: 'nominal' }, y: { aggregate: 'count', type: 'quantitative' } },
}) as VgSpec

function mount(): { root: ReturnType<typeof createRoot>; container: HTMLElement } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  return { root: createRoot(container), container }
}
const inPlace = (w: string[]): string[] => w.filter((m) => /changed in place/.test(m))

afterEach(() => { document.body.innerHTML = ''; vi.restoreAllMocks() })

forEachVariant(['svg'], (Chart) => describe('<Chart> and rows changed in place', () => {
  const draw = (root: ReturnType<typeof createRoot>, props: Record<string, unknown>, warnings: string[]): void => {
    const logger = { error: () => {}, warn: (m: unknown) => { warnings.push(String(m)) } }
    act(() => { root.render(<Chart width={60} height={30} logger={logger} {...(props as unknown as { spec: VgSpec })} />) })
  }

  for (const [name, mutate] of Object.entries({
    'a row edited': (a: Array<Record<string, unknown>>) => { a[0]!.v = 50 },
    'a row replaced': (a: Array<Record<string, unknown>>) => { a[0] = { k: 'z', v: 1 } },
    'a push': (a: Array<Record<string, unknown>>) => { a.push({ k: 'z', v: 2 }) },
    'a splice': (a: Array<Record<string, unknown>>) => { a.splice(0, 2) },
  })) {
    it(`the data prop, ${name}: one warning on the next render with the same array`, () => {
      const warnings: string[] = []
      const { root } = mount()
      const spec = vega()
      const data = { t: rows(30) }
      draw(root, { spec, data }, warnings)
      mutate(data.t)
      draw(root, { spec, data }, warnings)
      draw(root, { spec, data }, warnings)
      expect(inPlace(warnings)).toHaveLength(1)
      expect(warnings[0]).toMatch(/^\[aster\] .*dataset "t"/)
      act(() => { root.unmount() })
    })

    it(`a Vega-Lite spec's inline values, ${name}: one warning`, () => {
      const warnings: string[] = []
      const { root } = mount()
      const values = rows(30)
      const spec = vl(values)
      draw(root, { spec }, warnings)
      mutate(values)
      draw(root, { spec }, warnings)
      expect(inPlace(warnings)).toHaveLength(1)
      expect(warnings[0]).toMatch(/inline `data.values`/)
      act(() => { root.unmount() })
    })
  }

  it('no warning: a new array, dataChanges over an in-place edit, equal re-renders (Vega and Vega-Lite)', () => {
    const warnings: string[] = []
    const { root } = mount()
    const data = rows(10)
    draw(root, { spec: vega(), data: { t: data } }, warnings)
    draw(root, { spec: vega(), data: { t: data } }, warnings)
    draw(root, { spec: vega(), data: { t: [...data, { k: 'n', v: 3 }] } }, warnings)
    const edited = rows(10)
    draw(root, { spec: vega(), data: { t: edited } }, warnings)
    edited[2]!.v = 33
    draw(root, { spec: vega(), data: { t: edited }, dataChanges: { t: [2] } }, warnings)
    const values = rows(10)
    for (let i = 0; i < 3; i++) draw(root, { spec: vl(values) }, warnings)
    draw(root, { spec: vl(rows(10)) }, warnings)
    expect(warnings).toEqual([])
    act(() => { root.unmount() })
  })
}))

describe('the hooks and the stream components', () => {
  it('useChart: one warning, through its logger', () => {
    const warnings: string[] = []
    const logger = { error: () => {}, warn: (m: unknown) => { warnings.push(String(m)) } }
    const data = { t: rows(10) }
    function Probe(): React.ReactElement { useChart(vega(), { data, logger }); return <div /> }
    const { root } = mount()
    act(() => { root.render(<Probe />) })
    data.t.push({ k: 'z', v: 1 })
    act(() => { root.render(<Probe />) })
    act(() => { root.render(<Probe />) })
    expect(inPlace(warnings)).toHaveLength(1)
    act(() => { root.unmount() })
  })

  it('useChartWorker (no Worker): one warning on the console (the hook has no logger); a worker could not see the change', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const data = { t: rows(10) }
    const spec = vega()
    function Probe(): React.ReactElement { useChartWorker(spec, { data, width: 60, height: 30 }); return <div /> }
    const { root } = mount()
    act(() => { root.render(<Probe />) })
    data.t[0]!.v = 9
    act(() => { root.render(<Probe />) })
    act(() => { root.render(<Probe />) })
    expect(inPlace(warn.mock.calls.map((c) => String(c[0])))).toHaveLength(1)
    act(() => { root.unmount() })
  })

  it('<ChartStream>: appends and snapshots through the handle never warn; a spec row changed in place warns, once, at the next flush', async () => {
    const warnings: string[] = []
    const logger = { error: () => {}, warn: (m: unknown) => { warnings.push(String(m)) } }
    const two = (values: unknown[]): VgSpec => ({ ...(vega(values) as Record<string, unknown>), data: [{ name: 't', values }, { name: 'u', values: rows(2) }] }) as VgSpec
    const mountStream = async (spec: VgSpec): Promise<{ root: ReturnType<typeof createRoot>; ref: React.RefObject<ChartStreamHandle | null> }> => {
      const ref = React.createRef<ChartStreamHandle>()
      const { root } = mount()
      act(() => { root.render(<ChartStream ref={ref} spec={spec} width={60} height={30} logger={logger} />) })
      await act(async () => { await new Promise((r) => setTimeout(r, 10)) })
      return { root, ref }
    }
    const quiet = await mountStream(two(rows(5)))
    for (let i = 0; i < 3; i++) act(() => { quiet.ref.current!.push({ append: { t: rows(2) } }); quiet.ref.current!.flush() })
    act(() => { quiet.ref.current!.push({ data: { t: rows(4) } }); quiet.ref.current!.flush() })
    act(() => { quiet.ref.current!.push({ append: { u: rows(1) } }); quiet.ref.current!.flush() })
    expect(inPlace(warnings)).toEqual([])
    act(() => { quiet.root.unmount() })
    const values = rows(5)
    const loud = await mountStream(two(values))
    values[0]!.v = 77
    for (let i = 0; i < 2; i++) act(() => { loud.ref.current!.push({ append: { u: rows(1) } }); loud.ref.current!.flush() })
    expect(inPlace(warnings)).toHaveLength(1)
    act(() => { loud.root.unmount() })
  })
})
