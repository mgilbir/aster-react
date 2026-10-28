/**
 * A scale with `bins` (vega-lite's pre-binned fields, `bins: {step}`) ticks at every bin edge: vega's tickCount() raises the
 * count to the number of edges. Judged against real vega with the strict canonicalizer.
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import '@aster/core/geo'
import '@aster/core/transforms'
import { renderSpec } from '@aster/core'
import { canonicalizeSvg, diffCanonical } from './normalize.js'

type Spec = Record<string, unknown>

async function oracleSvg(spec: Spec): Promise<string> {
  const view = new (vega as unknown as { View: new (rt: unknown, o: unknown) => { runAsync(): Promise<void>; toSVG(): Promise<string>; finalize(): void } }).View(
    vega.parse(spec as never),
    { renderer: 'none' },
  )
  try {
    await view.runAsync()
    return await view.toSVG()
  } finally {
    view.finalize()
  }
}

const axisSpec = (scale: Record<string, unknown>, axis: Record<string, unknown> = {}, rows: Array<Record<string, number>> = [{ a: 8, b: 10 }, { a: 22, b: 24 }]): Spec => ({
  width: 200, height: 50, padding: 5,
  data: [{ name: 't', values: rows }],
  scales: [{ name: 'x', type: 'linear', domain: { data: 't', fields: ['a', 'b'] }, range: [0, { signal: 'width' }], zero: false, ...scale }],
  axes: [{ scale: 'x', orient: 'bottom', labelFlush: true, labelOverlap: true, ...axis }],
})

const CASES: Array<[string, Spec]> = [
  ['bins by step with a tick count signal', axisSpec({ bins: { step: 2 } }, { tickCount: { signal: 'ceil(width/40)' } })],
  ['bins by step with a small tick count', axisSpec({ bins: { step: 2 } }, { tickCount: 3 })],
  ['bins by step with no tick count', axisSpec({ bins: { step: 2 } })],
  ['bins by step with a tick min step', axisSpec({ bins: { step: 2 } }, { tickCount: 3, tickMinStep: 2 })],
  ['bins with a start and a stop', axisSpec({ bins: { step: 4, start: 8, stop: 20 } }, { tickCount: 3 })],
  ['bins as a list', axisSpec({ bins: [8, 12, 16, 24] }, { tickCount: 2 })],
  ['no bins (the count still thins the ticks)', axisSpec({}, { tickCount: 3 })],
]

describe('a binned scale ticks at its bin edges like vega', () => {
  it.each(CASES)('%s', async (_n, spec) => {
    expect(diffCanonical(canonicalizeSvg(await oracleSvg(spec)), canonicalizeSvg(renderSpec(spec as never)))).toEqual([])
  })
  it('really draws a tick at every edge (an empty comparison would pass anything)', () => {
    expect((renderSpec(CASES[0]![1] as never).match(/stroke="#888"/g) ?? []).length).toBeGreaterThanOrEqual(9)
  })
})
