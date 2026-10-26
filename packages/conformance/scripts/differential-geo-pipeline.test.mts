/**
 * LIVE differential for "a projection fitted to data the data pipeline publishes": whole Vega specs
 * are rendered by real Vega and by Aster (same process), and the canonical SVGs must be identical.
 *
 * What vega-lite's maps depend on, and what this pins:
 *  - the `geojson` transform publishes its consolidated value as the `signal` it names, and a projection's
 *    `fit` may read that signal (`[data('shapes'), gj]`) or a dataset;
 *  - Vega's dataflow orders the producers before the projection and the projection before its `geopoint`
 *    consumers, whatever order the datasets are DECLARED in (Aster builds datasets in declaration order);
 *  - a `geopoint` / `geojson` field may be `{expr}`, an expression per datum (a `datum` / `value` position);
 *  - the geoshape mark transform's `field` is read off the scenegraph item (`datum["geo"]`).
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { renderSpec } from '../../core/src/index.ts'
import '../../core/src/addon-geo.ts'
import '../../core/src/addon-transforms.ts'
import { canonicalizeSvg, diffCanonical } from '../src/normalize.ts'

const poly = (ring: number[][]) => ({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } })
const SHAPES = [
  poly([[-10, 35], [-11, 48], [9, 50], [10, 36], [-10, 35]]),
  poly([[10, 36], [9, 50], [31, 50], [30, 38], [10, 36]]),
]
const POINTS = [
  { lon: -5, lat: 40, n: 1 },
  { lon: 20, lat: 45, n: 2 },
  { lon: 50, lat: 60, n: 3 },
  { lon: 5, lat: 10, n: 4 },
]
const SHAPE_ROWS = SHAPES.map((f, i) => ({ id: i, geo: f.geometry }))

type Spec = Record<string, unknown>

function build(opts: {
  pointsFirst: boolean
  fit: 'shapes' | 'signal' | 'both' | 'both-reversed' | 'geojson-field'
  fields: 'plain' | 'expr-lon' | 'expr-both'
  type: string
}): Spec {
  const fieldsOf = (): unknown[] =>
    opts.fields === 'plain' ? ['lon', 'lat']
      : opts.fields === 'expr-lon' ? [{ expr: 'datum.lon' }, 'lat']
        : [{ expr: 'datum.lon + 0' }, { expr: 'datum["lat"] * 1' }]
  const geojsonT = { type: 'geojson', fields: fieldsOf(), signal: 'gj' }
  const geopointT = { type: 'geopoint', projection: 'p', fields: fieldsOf(), as: ['px', 'py'] }
  const pts = { name: 'pts', values: POINTS, transform: [geojsonT, geopointT] }
  const shapes = opts.fit === 'geojson-field'
    ? { name: 'shapes', values: SHAPE_ROWS }
    : { name: 'shapes', values: SHAPES.map((f) => ({ ...f })) }
  const fitSignal = {
    shapes: "data('shapes')",
    signal: 'gj',
    both: "[data('shapes'), gj]",
    'both-reversed': "[gj, data('shapes')]",
    'geojson-field': 'gj2',
  }[opts.fit]
  const data = opts.pointsFirst ? [pts, shapes] : [shapes, pts]
  if (opts.fit === 'geojson-field') {
    ;(shapes as { transform?: unknown[] }).transform = [{ type: 'geojson', geojson: 'geo', signal: 'gj2' }]
  }
  return {
    width: 300,
    height: 200,
    padding: 5,
    autosize: 'none',
    data,
    projections: [{ name: 'p', size: { signal: '[width, height]' }, fit: { signal: fitSignal }, type: opts.type }],
    marks: [
      {
        type: 'shape', from: { data: 'shapes' }, encode: { update: { fill: { value: '#ddd' }, stroke: { value: '#333' } } },
        transform: [opts.fit === 'geojson-field' ? { type: 'geoshape', projection: 'p', field: 'datum["geo"]' } : { type: 'geoshape', projection: 'p' }],
      },
      { type: 'symbol', from: { data: 'pts' }, encode: { update: { x: { field: 'px' }, y: { field: 'py' }, size: { value: 60 }, fill: { value: 'tomato' } } } },
    ],
  }
}

async function viaVega(spec: Spec): Promise<string> {
  const view = new vega.View(vega.parse(structuredClone(spec) as vega.Spec), { renderer: 'none', logLevel: vega.None })
  await view.runAsync()
  const svg = await view.toSVG()
  view.finalize()
  return svg
}

const cases: Array<[string, Parameters<typeof build>[0]]> = []
for (const pointsFirst of [false, true]) {
  for (const fit of ['shapes', 'signal', 'both', 'both-reversed', 'geojson-field'] as const) {
    for (const fields of ['plain', 'expr-lon', 'expr-both'] as const) {
      for (const type of ['mercator', 'equalEarth', 'orthographic']) {
        cases.push([`${pointsFirst ? 'points-first' : 'shapes-first'}/${fit}/${fields}/${type}`, { pointsFirst, fit, fields, type }])
      }
    }
  }
}

describe(`geojson signal -> projection fit -> geopoint vs vega@${vega.version} (live)`, () => {
  for (const [name, opts] of cases) {
    it(name, async () => {
      const spec = build(opts)
      const want = canonicalizeSvg(await viaVega(spec))
      const got = canonicalizeSvg(renderSpec(structuredClone(spec) as never) as string)
      expect(diffCanonical(want, got)).toEqual([])
    })
  }
})
