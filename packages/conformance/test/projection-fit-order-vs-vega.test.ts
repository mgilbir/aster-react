// @vitest-environment node
/**
 * A projection that fits data (`fit: {signal: "data('shapes')"}`) runs after the datasets it fits, in vega, whatever their declaration
 * order: a transform that projects with it (a `geopoint` of a dataset declared BEFORE the fitted one) sees the fitted projection. The
 * engine builds the fitted datasets when the projection is first asked for (`refreshProjection`); the datasets are compared with vega's.
 */
import { describe, expect, it } from 'vitest'
import '@aster-charts/core/geo'
import '@aster-charts/core/transforms'
import { compileChart, datasetsOfScene, evaluateChart } from '@aster-charts/core'
import { renderWithVegaChecked } from '../src/render-vega.js'

const shapes = [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[-20, -10], [20, -10], [20, 10], [-20, 10], [-20, -10]]] } }]
const spec = (fit: unknown): any => ({
  width: 120, height: 60, autosize: 'none',
  projections: [{ name: 'p', type: 'mercator', fit, size: [120, 60] }],
  data: [
    { name: 'src', values: [{ lon: 0, lat: 0 }, { lon: 10, lat: 5 }] },
    { name: 'pos', source: 'src', transform: [{ type: 'geopoint', projection: 'p', fields: ['lon', 'lat'] }] },
    { name: 'shapes', values: shapes },
    { name: 'outline', source: 'shapes', transform: [{ type: 'filter', expr: 'datum.type === "Feature"' }] },
  ],
  marks: [{ type: 'symbol', from: { data: 'pos' }, encode: { update: { x: { field: 'x' }, y: { field: 'y' } } } }],
})

describe('a projection fit to a dataset declared after its consumer', () => {
  for (const [name, fit] of [['data() of the dataset', { signal: "data('shapes')" }], ['data() of a dataset derived from it, declared after it too', { signal: "data('outline')" }]] as const) {
    it(name, async () => {
      const s = spec(fit)
      const vega = await renderWithVegaChecked(structuredClone(s))
      expect(vega.errors).toEqual([])
      const scene = evaluateChart(compileChart(structuredClone(s)))
      const round = (rows: unknown): unknown => (rows as Array<{ x: number; y: number }>).map((r) => [r.x, r.y].map((v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 1e6) / 1e6 : null)))
      const want = round(vega.datasets.pos)
      // (the fit made the points land in the view: a projection fitted to nothing puts them nowhere)
      expect((want as number[][]).every((p) => p.every((v) => v !== null))).toBe(true)
      expect(round(datasetsOfScene(scene).get('pos'))).toEqual(want)
    }, 30_000)
  }
})
