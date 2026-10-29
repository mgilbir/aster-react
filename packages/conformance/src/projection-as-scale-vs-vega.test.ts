/**
 * vega keeps a projection among the scales of the view: `scale('projection', [lon, lat])` is the projected point,
 * `invert` its inverse, `range` is empty, `bandwidth` is 0. vega-lite compiles an interval selection over longitude /
 * latitude with an initial value to `scale("projection", [-86, 30])` (the selection's initial pixel box). Each spec runs
 * in real vega and in the engine; the picture must be equal.
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import * as vl from 'vega-lite'
import '@aster/core/geo'
import '@aster/core/transforms'
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

const probe = (signals: Spec[], texts: string[], extra: Spec = {}): Spec => ({
  width: 300, height: 200, padding: 5, autosize: 'none',
  projections: [{ name: 'p', type: 'mercator', size: [300, 200] }],
  signals,
  marks: texts.map((t, i) => ({ type: 'text', encode: { update: { x: { value: 5 }, y: { value: 15 + 15 * i }, text: { signal: `'' + (${t})` } } } })),
  ...extra,
})

/** The two coordinates of a point-valued expression, written out (`format` of an array is not text). */
const xy = (e: string): string => `${e}[0] + ',' + ${e}[1]`

const CASES: Array<[string, Spec]> = [
  ['scale of a projection is the projected point', probe([], [xy("scale('p', [-86, 30])"), xy("scale('p', [-118, 40])")])],
  ['invert of a projection', probe([], [xy("invert('p', [250, 166])")])],
  ['range and bandwidth of a projection', probe([], ["length(range('p'))", "bandwidth('p')"])],
  ['an init signal reads the projection, a second signal reads the first', probe([
    { name: 'box', init: "[scale('p', [-86, 30]), scale('p', [-118, 40])]" },
    { name: 'lat', init: '[box[0][1], box[1][1]]' },
  ], [xy('lat')])],
  ['a projection that fits the data it is given', probe([], [xy("scale('q', [-86, 30])")], {
    data: [{ name: 'pts', values: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [-120, 35] } }, { type: 'Feature', geometry: { type: 'Point', coordinates: [-80, 45] } }], transform: [{ type: 'geojson', signal: 'gj' }] }],
    projections: [{ name: 'q', type: 'mercator', size: [300, 200], fit: { signal: 'gj' } }],
  })],
]

const FEATURES = [[-120, 35], [-80, 45], [-95, 35], [-90, 38]].map(([longitude, latitude], i) => ({ longitude, latitude, n: i + 1 }))

describe('a projection is a scale of the view (vs vega)', () => {
  for (const [name, spec] of CASES) {
    it(name, async () => {
      const want = await vegaSvg(spec)
      expect(want).not.toMatch(/undefined|NaN/)
      const got = renderSpec(structuredClone(spec) as never)
      expect(diffCanonical(canonicalizeSvg(want), canonicalizeSvg(got))).toEqual([])
    })
  }
  it("vega-lite's Vega for an interval selection with an initial longitude / latitude box", async () => {
    const compiled = vl.compile({
      width: 400, height: 250, data: { values: FEATURES }, projection: { type: 'albersUsa' },
      params: [{ name: 'brush', select: 'interval', value: { latitude: [30, 40], longitude: [-100, -85] } }],
      mark: 'circle',
      encoding: {
        longitude: { field: 'longitude', type: 'quantitative' }, latitude: { field: 'latitude', type: 'quantitative' },
        color: { condition: { param: 'brush', empty: false, value: 'goldenrod' }, value: 'steelblue' },
      },
    } as never).spec as unknown as Spec
    const want = await vegaSvg(compiled)
    expect(want).toContain('fill-opacity="0.125"') // the brush box drawn from the initial value
    const got = renderSpec(structuredClone(compiled) as never)
    expect(diffCanonical(canonicalizeSvg(want), canonicalizeSvg(got))).toEqual([])
  })
})
