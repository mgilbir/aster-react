/**
 * The runtime side of vega-lite's polar charts: the Vega vega-lite itself compiles for theta / radius encodings (a stacked
 * theta, a radius on a sqrt scale that starts at a range minimum, a band-scaled theta, polar text with an angle) renders
 * through the runtime exactly as vega renders it. Whatever @aster/vl emits for these charts, the runtime must draw
 * vega-lite's Vega like vega does; this holds the runtime to that so a compiler difference is not blamed on it.
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import * as vl from 'vega-lite'
import { renderSpec } from '@aster/core'
import { canonicalizeSvg, diffCanonical } from './normalize.js'

type Spec = Record<string, unknown>

async function vegaSvg(spec: Spec): Promise<string> {
  const view = new vega.View(vega.parse(structuredClone(spec) as never), { renderer: 'none' })
  try {
    await view.runAsync()
    return await view.toSVG()
  } finally { view.finalize() }
}

const DIRS = ['1N', '2NE', '3E', '4SE', '5S', '6SW', '7W', '8NW'].map((dir, i) => ({ dir, strength: i + 1 }))
const RATINGS = Array.from({ length: 60 }, (_, i) => ({ r: 1 + ((i * 37) % 90) / 10, g: i % 3 }))

const CASES: Array<[string, Spec]> = [
  ['a stacked theta with a sqrt radius from a range minimum, and text on the arcs', {
    data: { values: [12, 23, 47, 6, 52, 19] },
    layer: [
      { mark: { type: 'arc', innerRadius: 20, stroke: '#fff' } },
      { mark: { type: 'text', radiusOffset: 10 }, encoding: { text: { field: 'data', type: 'quantitative' } } },
    ],
    encoding: {
      theta: { field: 'data', type: 'quantitative', stack: true },
      radius: { field: 'data', scale: { type: 'sqrt', zero: true, rangeMin: 20 } },
      color: { field: 'data', type: 'nominal', legend: null },
    },
  }],
  ['a binned theta with an aggregated radius, and text at the bin angle', {
    data: { values: RATINGS },
    layer: [
      { mark: { type: 'arc', stroke: 'white', tooltip: true } },
      { mark: { type: 'text', radiusOffset: 15, align: 'right' }, encoding: { text: { bin: true, field: 'r' }, angle: { bin: true, field: 'r', scale: { range: [90, 450] } } } },
    ],
    encoding: { theta: { bin: true, field: 'r' }, radius: { aggregate: 'count', scale: { type: 'sqrt' } } },
  }],
  ['an ordinal theta (a band scale) with a quantitative radius', {
    data: { values: DIRS },
    encoding: { theta: { field: 'dir', type: 'ordinal' }, radius: { field: 'strength', type: 'quantitative' }, color: { field: 'dir', type: 'nominal' } },
    mark: { type: 'arc' },
  }],
  ['an ordinal theta with a radius stacked by a second field', {
    data: { values: DIRS.flatMap((d) => [{ ...d, kind: 'a' }, { ...d, kind: 'b', strength: 9 - d.strength }]) },
    encoding: { theta: { field: 'dir', type: 'ordinal' }, radius: { field: 'strength', type: 'quantitative', stack: true }, color: { field: 'kind', type: 'nominal' } },
    mark: { type: 'arc', padAngle: 0.05, cornerRadius: 3 },
  }],
  ['a stacked theta normalised, with an inner and outer radius', {
    data: { values: DIRS },
    encoding: { theta: { field: 'strength', type: 'quantitative', stack: 'normalize' }, color: { field: 'dir', type: 'nominal' } },
    mark: { type: 'arc', innerRadius: 40, outerRadius: 110, stroke: 'white' },
  }],
  ['a pie with a theta offset and text at the arcs centroids', {
    data: { values: DIRS },
    layer: [
      { mark: { type: 'arc', theta: { expr: 'PI / 6' }, theta2: { expr: 'PI / 3' } } },
      { mark: { type: 'text', radius: 80 }, encoding: { text: { field: 'dir', type: 'nominal' } } },
    ],
    encoding: { theta: { field: 'strength', type: 'quantitative', stack: true }, color: { field: 'dir', type: 'nominal', legend: null } },
  }],
  ['text with an angle and a radius offset on a polar arc chart, per group', {
    data: { values: RATINGS },
    facet: { field: 'g', type: 'nominal' },
    spec: {
      width: 120, height: 120,
      layer: [
        { mark: { type: 'arc', innerRadius: 10 } },
        { mark: { type: 'text', radiusOffset: 8, fontSize: 8 }, encoding: { text: { aggregate: 'count', type: 'quantitative' } } },
      ],
      encoding: { theta: { bin: { maxbins: 6 }, field: 'r' }, radius: { aggregate: 'count', scale: { type: 'sqrt' } }, color: { value: 'steelblue' } },
    },
  }],
]

describe("the runtime draws vega-lite's own Vega for polar charts like vega (theta, radius, polar text)", () => {
  for (const [name, input] of CASES) {
    it(name, async () => {
      const spec = vl.compile(structuredClone(input) as never).spec as unknown as Spec
      const want = await vegaSvg(spec)
      // not vacuous: arcs are drawn
      expect(want).toMatch(/aria-roledescription="arc mark"/)
      const got = renderSpec(structuredClone(spec) as never)
      expect(diffCanonical(canonicalizeSvg(want), canonicalizeSvg(got))).toEqual([])
    })
  }
})
