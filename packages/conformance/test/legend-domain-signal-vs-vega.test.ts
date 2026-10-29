// @vitest-environment node
/**
 * HANDOFF (lane 3 -> lane 7): a scale whose domain is a signal that reads another scale's domain (`domain('color')`) through a
 * `react: false` signal, with a legend bound to a selection. Real vega draws the legend with its 3 entries and every point; Aster's runtime
 * draws a legend with 0 values and drops the points. The Vega is vega-lite's own output (nothing of @aster/vl is involved):
 * gallery spec vl/point_constant_legend_domain. Fails today; belongs in packages/conformance/test/.
 */
import { describe, it, expect } from 'vitest'
import * as vl from 'vega-lite'
import { renderSpec } from '@aster/core'
import { renderWithVegaChecked } from '../src/render-vega.js'
import { canonicalizeSvg, diffCanonical } from '../src/normalize.js'

const CARS = [
  { Name: 'a', Origin: 'USA', Horsepower: 130, Miles_per_Gallon: 18 },
  { Name: 'b', Origin: 'Japan', Horsepower: 95, Miles_per_Gallon: 31 },
  { Name: 'c', Origin: 'Europe', Horsepower: 102, Miles_per_Gallon: 26 },
  { Name: 'd', Origin: 'USA', Horsepower: 165, Miles_per_Gallon: 15 },
]
const vlSpec = {
  data: { values: CARS },
  params: [
    { name: 'color_selection', select: { type: 'point', encodings: ['color'] }, bind: 'legend' },
    { name: 'computed_domain', expr: "domain('color')" },
    { name: 'color_domain', react: false, expr: 'computed_domain' },
  ],
  transform: [{ filter: { param: 'color_selection' } }],
  mark: { type: 'point', filled: true },
  encoding: {
    color: { field: 'Origin', type: 'nominal', scale: { domain: { expr: 'color_domain' } } },
    x: { field: 'Horsepower', type: 'quantitative' },
    y: { field: 'Miles_per_Gallon', type: 'quantitative' },
  },
}

describe('a scale domain read back through a react:false signal', () => {
  it("Aster's runtime draws what vega draws for vega-lite's own output", async () => {
    const vg = (vl as unknown as { compile: (s: unknown) => { spec: unknown } }).compile(JSON.parse(JSON.stringify(vlSpec))).spec
    const vega = await renderWithVegaChecked(JSON.parse(JSON.stringify(vg)))
    expect(vega.errors).toEqual([])
    const mine = renderSpec(JSON.parse(JSON.stringify(vg)) as never) as string
    expect(diffCanonical(canonicalizeSvg(vega.svg), canonicalizeSvg(mine)).slice(0, 3)).toEqual([])
  }, 30_000)
})
