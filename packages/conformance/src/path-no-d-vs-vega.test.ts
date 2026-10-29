/**
 * A path, shape or geoshape mark is one `<path>` per item. An item whose path is empty (a GeoJSON geometry with no coordinates,
 * a `path` field that is '' or missing) is still drawn, with no `d` attribute and its fill and aria attributes. The picture of
 * `vega-lite/examples/specs/geo_choropleth` has 467 of them (counties whose geometry is an empty MultiPolygon).
 * Each spec runs in real vega and in the engine; the picture must be equal, and must really contain a `<path>` without `d`.
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import '@aster/core/geo'
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

const square = (x: number): Spec => ({ type: 'Feature', properties: { k: x }, geometry: { type: 'Polygon', coordinates: [[[x, 0], [x + 5, 0], [x + 5, 5], [x, 5], [x, 0]]] } })
const empty = (k: number): Spec => ({ type: 'Feature', properties: { k }, geometry: { type: 'MultiPolygon', coordinates: [] } })
const features = [empty(0), square(10), square(20), empty(3), square(30)]
const frame = { width: 200, height: 100, padding: 5, autosize: 'none' }

const CASES: Array<[string, Spec]> = [
  ['a geoshape mark over features, some with an empty geometry', {
    ...frame,
    data: [{ name: 'f', values: features }],
    projections: [{ name: 'p', type: 'equirectangular', scale: 4, translate: [0, 0] }],
    marks: [{
      type: 'shape', from: { data: 'f' }, transform: [{ type: 'geoshape', projection: 'p' }],
      encode: { update: { fill: { value: 'steelblue' }, description: { signal: 'datum.properties.k' } } },
    }],
  }],
  ['a path mark whose path field is empty, null or missing', {
    ...frame,
    data: [{ name: 'f', values: [{ d: '' }, { d: 'M0,0L30,30' }, { d: null }, {}, { d: 'M40,0L60,30' }] }],
    marks: [{ type: 'path', from: { data: 'f' }, encode: { update: { path: { field: 'd' }, stroke: { value: 'black' }, fill: { value: 'red' } } } }],
  }],
]

describe('items with an empty path are drawn without d (vs vega)', () => {
  for (const [name, spec] of CASES) {
    it(name, async () => {
      const want = await vegaSvg(spec)
      // not vacuous: vega draws a <path> that has no d
      expect(/<path (?![^>]*\bd=)[^>]*role="graphics-symbol"/.test(want) || /<path (?![^>]*\bd=)[^>]*(fill|stroke)=/.test(want)).toBe(true)
      const got = renderSpec(structuredClone(spec) as never)
      expect(diffCanonical(canonicalizeSvg(want), canonicalizeSvg(got))).toEqual([])
    })
  }
})
