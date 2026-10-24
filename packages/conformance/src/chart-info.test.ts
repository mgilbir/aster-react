/**
 * getChartInfo against the evaluated scene and against real vega (audit C53).
 *
 * It used to build a second, UNFITTED context (the spec's width/height, scales sized for them)
 * and then evaluate the whole chart again just for the padding, so under autosize `fit` /
 * `fit-x` / `fit-y` its width, height and scale ranges described a chart that was never drawn
 * (200 / [0,200] where the scene is fitted to 161), and pointer mapping went wrong by the
 * difference. It now reads the one evaluation. vega is the oracle: `view.width()` /
 * `view.height()` / `view.padding()` / `view.scale(name).range()` after a run.
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import '@aster/core/geo'
import '@aster/core/transforms'
import { chartInfoFromScene, compileChart, evaluateChart, getChartInfo } from '@aster/core'

type Spec = Record<string, unknown>

const DATA = [{ name: 't', values: [{ k: 'alpha', v: 3 }, { k: 'beta', v: 9 }, { k: 'gamma', v: 5 }] }]
const specOf = (autosize: unknown, extra: Spec = {}): Spec => ({
  width: 200, height: 120, padding: 5, autosize, data: DATA,
  scales: [
    { name: 'x', type: 'band', domain: { data: 't', field: 'k' }, range: 'width', padding: 0.1 },
    { name: 'y', type: 'linear', domain: { data: 't', field: 'v' }, nice: true, range: 'height' },
  ],
  axes: [{ orient: 'bottom', scale: 'x', title: 'category' }, { orient: 'left', scale: 'y', title: 'value' }],
  marks: [{ type: 'rect', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'k' }, width: { scale: 'x', band: 1 }, y: { scale: 'y', field: 'v' }, y2: { scale: 'y', value: 0 }, fill: { value: '#4c78a8' } } } }],
  ...extra,
})

const AUTOSIZES: Array<[string, unknown]> = [
  ['pad', 'pad'], ['fit', 'fit'], ['fit-x', 'fit-x'], ['fit-y', 'fit-y'], ['none', 'none'],
  ['object fit', { type: 'fit', contains: 'padding' }], ['object pad', { type: 'pad', contains: 'padding' }],
]

async function viewOf(spec: Spec): Promise<{ width: number; height: number; padding: Record<string, number>; range: (n: string) => number[] }> {
  const view = new (vega as unknown as { View: new (rt: unknown, o: unknown) => any }).View(vega.parse(spec as never), { renderer: 'none' })
  await view.runAsync()
  const out = { width: view.width(), height: view.height(), padding: view.padding(), range: (n: string) => view.scale(n).range() as number[] }
  return out
}

describe('getChartInfo describes the chart that is drawn (C53)', () => {
  it.each(AUTOSIZES)('autosize %s: size, padding and scale ranges equal vega\'s', async (_n, autosize) => {
    const spec = specOf(autosize)
    const want = await viewOf(spec)
    const info = getChartInfo(spec as never)
    expect(info.width).toBeCloseTo(want.width, 6)
    expect(info.height).toBeCloseTo(want.height, 6)
    const xr = info.scales.get('x')!.range() as number[]
    const yr = info.scales.get('y')!.range() as number[]
    expect(xr[0]).toBeCloseTo(want.range('x')[0]!, 6)
    expect(xr[1]).toBeCloseTo(want.range('x')[1]!, 6)
    expect(yr[0]).toBeCloseTo(want.range('y')[0]!, 6)
    expect(yr[1]).toBeCloseTo(want.range('y')[1]!, 6)
    // the scales are the fitted ones: their range ends at the plot size, not the spec's
    expect(xr[1]).toBeCloseTo(info.width, 6)
  })

  it.each(AUTOSIZES)('autosize %s: it is exactly what the evaluated scene says (one evaluation)', (_n, autosize) => {
    const spec = specOf(autosize)
    const scene = evaluateChart(compileChart(spec as never))
    const want = chartInfoFromScene(scene)
    const got = getChartInfo(spec as never)
    expect({ width: got.width, height: got.height, padding: got.padding }).toEqual({ width: want.width, height: want.height, padding: want.padding })
    expect([...got.scales.keys()]).toEqual([...want.scales.keys()])
    for (const [name, s] of got.scales) {
      expect(s.range()).toEqual(want.scales.get(name)!.range())
      expect(s.domain()).toEqual(want.scales.get(name)!.domain())
    }
  })

  it('the fit chart is smaller than the spec (the case the old code got wrong)', () => {
    const info = getChartInfo(specOf('fit') as never)
    expect(info.width).toBeLessThan(200)
    expect(info.height).toBeLessThan(120)
  })

  it.each(AUTOSIZES)('autosize %s: it costs one evaluation, not two', (_n, autosize) => {
    // a failing dataset transform is logged once per build of the datasets (a `fit` evaluation
    // builds them once per fit pass); getChartInfo must log exactly what one evaluateChart logs
    const spec = specOf(autosize, { data: [{ name: 't', values: [{ k: 'a', v: 1 }], transform: [{ type: 'filter', expr: 'datum.nope.x' }] }] })
    const count = (run: (logger: { error: (...a: unknown[]) => void; warn: () => void }) => void): number => {
      let n = 0
      run({ error: () => { n++ }, warn: () => {} })
      return n
    }
    const one = count((logger) => { evaluateChart(compileChart(spec as never), { logger }) })
    expect(one).toBeGreaterThan(0)
    expect(count((logger) => { getChartInfo(spec as never, { logger }) })).toBe(one)
  })
})
