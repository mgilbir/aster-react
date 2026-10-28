// @vitest-environment node
/**
 * vega-crossfilter: `crossfilter` marks every tuple that lies outside a dimension's query range (`[lo, hi)` in the sorted order of
 * the field) and publishes the bitmaps as its `signal`; `resolvefilter` passes the tuples no relevant bit is set on, leaving out
 * the dimensions its `ignore` mask names. The datasets are compared with the real vega's `view.data` (the tuples carry `_index`),
 * and the render of a gallery-shaped chart (group-scoped resolved datasets, binned and aggregated).
 */
import { describe, it, expect } from 'vitest'
import '@aster/core/transforms'
import { renderSpec, evaluateChart, compileChart, datasetsOfScene } from '@aster/core'
import { renderWithVegaChecked } from '../src/render-vega.js'
import { canonicalizeSvg, diffCanonical } from '../src/normalize.js'

// 60 flights: a few ties, a null and a missing value, values on the query boundaries
const silent = { logger: { error: () => {}, warn: () => {} } } as never
const flights = Array.from({ length: 60 }, (_, i) => ({
  id: i,
  delay: i % 11 === 0 ? null : ((i * 37) % 17) * 5 - 20,
  time: (i * 7) % 24,
  distance: i === 5 ? undefined : ((i * 131) % 25) * 100,
}))
const frame = { $schema: 'https://vega.github.io/schema/vega/v5.json', width: 200, height: 120, padding: 5 }
const xfilter = (ranges: [string, string, string]): any => ({
  name: 'flights',
  values: flights,
  transform: [{ type: 'crossfilter', signal: 'xf', fields: ['delay', 'time', 'distance'], query: ranges.map((signal) => ({ signal })) }],
})
// (vega applies the filter lazily: the tuples a dataset ENDS with are filtered once a transform that materializes them, `collect`, follows)
const resolved = (name: string, ignore: number): any => ({ name, source: 'flights', transform: [{ type: 'resolvefilter', ignore, filter: { signal: 'xf' } }, { type: 'collect' }] })
const signals = (d: number[], t: number[], x: number[]): any[] => [
  { name: 'dr', value: d }, { name: 'tr', value: t }, { name: 'xr', value: x },
]
const spec = (dr: number[], tr: number[], xr: number[], ignores: number[]): any => ({
  ...frame,
  signals: signals(dr, tr, xr),
  data: [xfilter(['dr', 'tr', 'xr']), ...ignores.map((g, i) => resolved(`r${i}`, g))],
})
const CASES: Record<string, any> = {
  'a range on every dimension': spec([-10, 40], [3, 18], [200, 2000], [0, 1, 2, 4, 3, 5, 6]),
  'ranges that cover everything': spec([-100, 500], [0, 100], [-1, 9999], [0, 1, 2, 4]),
  'a range that excludes the boundary value': spec([-20, 25], [0, 12], [0, 1300], [0, 4]),
  'a range that selects nothing': spec([1000, 2000], [0, 100], [-1, 9999], [0, 1, 2, 4]),
  'every dimension ignored (nothing propagates)': spec([-10, 40], [3, 18], [200, 2000], [7, 15]),
  'a dimension twice': {
    ...frame, signals: signals([-10, 40], [3, 18], [200, 2000]),
    data: [{ name: 'flights', values: flights, transform: [{ type: 'crossfilter', signal: 'xf', fields: ['time', 'time'], query: [{ signal: 'tr' }, { signal: 'dr' }] }] }, resolved('r0', 0), resolved('r1', 1)],
  },
}
describe('crossfilter and resolvefilter', () => {
  for (const [name, s] of Object.entries(CASES)) {
    it(name, async () => {
      const vega = await renderWithVegaChecked(JSON.parse(JSON.stringify(s)))
      expect(vega.errors).toEqual([])
      const errors: unknown[] = []
      const scene = evaluateChart(compileChart(JSON.parse(JSON.stringify(s))), { logger: { error: (e: unknown) => { errors.push(e) }, warn: () => {} } } as never)
      expect(errors).toEqual([])
      const got: Record<string, unknown> = {}
      for (const d of s.data) got[d.name] = JSON.parse(JSON.stringify(datasetsOfScene(scene).get(d.name) ?? null))
      expect(got).toEqual(vega.datasets)
    }, 30_000)
  }

  it('a mark over a dataset that ends with the filter draws the tuples that pass', async () => {
    const s: any = {
      ...frame,
      signals: signals([-10, 40], [3, 18], [200, 2000]),
      scales: [{ name: 'x', type: 'linear', domain: [0, 24], range: 'width' }],
      data: [xfilter(['dr', 'tr', 'xr']), { name: 'r', source: 'flights', transform: [{ type: 'resolvefilter', ignore: 2, filter: { signal: 'xf' } }] }],
      marks: [{ type: 'symbol', from: { data: 'r' }, encode: { update: { x: { scale: 'x', field: 'time' }, y: { value: 20 } } } }],
    }
    const vega = await renderWithVegaChecked(JSON.parse(JSON.stringify(s)))
    expect(vega.errors).toEqual([])
    const drawn = vega.svg.match(/<path transform="translate/g)?.length ?? 0
    expect(drawn).toBeGreaterThan(0)
    expect(drawn, "vega filters the tuples a mark draws").toBeLessThan(60)
    const mine = renderSpec(JSON.parse(JSON.stringify(s)), silent) as string
    expect(diffCanonical(canonicalizeSvg(vega.svg), canonicalizeSvg(mine)).slice(0, 3)).toEqual([])
  }, 30_000)

  it('the gallery shape: group-scoped resolved datasets, binned and aggregated, drawn', async () => {
    const hist = (field: string, ignore: number, y: number): any => ({
      type: 'group',
      encode: { enter: { y: { value: y }, width: { signal: 'width' }, height: { value: 30 } } },
      data: [{ name: `${field}-bins`, source: 'flights', transform: [{ type: 'resolvefilter', ignore, filter: { signal: 'xf' } }, { type: 'aggregate', groupby: [`${field}0`, `${field}1`], key: `${field}0`, drop: false }] }],
      scales: [{ name: 'ys', type: 'linear', domain: { data: `${field}-bins`, field: 'count' }, range: [30, 0] }],
      marks: [{ type: 'rect', from: { data: `${field}-bins` }, encode: { update: { x: { signal: `datum.${field}0 * 4` }, width: { value: 6 }, y: { scale: 'ys', field: 'count' }, y2: { scale: 'ys', value: 0 }, fill: { value: 'steelblue' } } } }],
    })
    const s: any = {
      ...frame,
      height: 130,
      signals: signals([-10, 40], [3, 18], [200, 2000]),
      data: [{
        name: 'flights',
        values: flights,
        transform: [
          { type: 'bin', field: 'delay', extent: [-20, 70], step: 10, as: ['delay0', 'delay1'] },
          { type: 'bin', field: 'time', extent: [0, 24], step: 4, as: ['time0', 'time1'] },
          { type: 'bin', field: 'distance', extent: [0, 2500], step: 500, as: ['distance0', 'distance1'] },
          { type: 'crossfilter', signal: 'xf', fields: ['delay', 'time', 'distance'], query: [{ signal: 'dr' }, { signal: 'tr' }, { signal: 'xr' }] },
        ],
      }],
      marks: [hist('delay', 1, 0), hist('time', 2, 45), hist('distance', 4, 90)],
    }
    const vega = await renderWithVegaChecked(JSON.parse(JSON.stringify(s)))
    expect(vega.errors).toEqual([])
    const errors: unknown[] = []
    const mine = renderSpec(JSON.parse(JSON.stringify(s)), { logger: { error: (e: unknown) => { errors.push(e) }, warn: () => {} } } as never) as string
    expect(errors).toEqual([])
    expect(diffCanonical(canonicalizeSvg(vega.svg), canonicalizeSvg(mine)).slice(0, 3)).toEqual([])
  }, 30_000)
})
