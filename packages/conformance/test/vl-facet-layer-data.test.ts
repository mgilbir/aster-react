// @vitest-environment node
/**
 * A facet of layers draws in each cell the cell's rows only (C6), against vega-lite 6.4.3: every facet form (row, column, both, wrapped)
 * x the layer sets x where the transform that makes the drawn fields sits (on the facet, on the layer spec, on every layer, nowhere) x
 * the transform (calculate, joinaggregate, window, filter, aggregate) x whether a layer needs a cast dataset (a temporal field). The
 * compiler also checks, for every facet it compiles, that no mark inside a cell reads a dataset derived from the faceted data other than
 * through the cell's facet (compile.ts assertCellsReadTheirFacet).
 */
import { describe, it } from 'vitest'
import { drawsLikeVegaLite, caseName } from './vl-composition-render.js'

const data = {
  values: [
    { a: 'A', b: 28, c: 'x', g: 'p', t: '2020-01-05' }, { a: 'B', b: 55, c: 'x', g: 'q', t: '2020-02-07' }, { a: 'A', b: 43, c: 'y', g: 'p', t: '2020-03-09' },
    { a: 'B', b: 12, c: 'y', g: 'q', t: '2020-04-11' }, { a: 'A', b: 7, c: 'z', g: 'p', t: '2020-05-13' }, { a: 'B', b: 64, c: 'z', g: 'q', t: '2020-06-15' },
  ],
}

const FACETS: Array<[string, Record<string, unknown>]> = [
  ['column', { facet: { column: { field: 'c', type: 'nominal' } } }],
  ['row', { facet: { row: { field: 'c', type: 'nominal' } } }],
  ['row x column', { facet: { row: { field: 'c', type: 'nominal' }, column: { field: 'g', type: 'nominal' } } }],
  ['wrapped', { facet: { field: 'c', type: 'nominal' }, columns: 2 }],
]

/** The transforms that make the field `m` the layers draw. */
const TRANSFORMS: Array<[string, Record<string, unknown>[]]> = [
  ['calculate', [{ calculate: 'datum.b / 100', as: 'm' }]],
  ['joinaggregate', [{ joinaggregate: [{ op: 'sum', field: 'b', as: 'total' }] }, { calculate: 'datum.b / datum.total', as: 'm' }]],
  ['window', [{ window: [{ op: 'rank', as: 'm' }], sort: [{ field: 'b', order: 'ascending' }] }]],
  // (with a groupby, the facet fields join it: the window restarts in each cell)
  ['window by a', [{ window: [{ op: 'rank', as: 'm' }], sort: [{ field: 'b', order: 'ascending' }], groupby: ['a'] }]],
  ['joinaggregate by a', [{ joinaggregate: [{ op: 'max', field: 'b', as: 'top' }], groupby: ['a'] }, { calculate: 'datum.b / datum.top', as: 'm' }]],
  ['filter', [{ filter: 'datum.b > 10' }, { calculate: 'datum.b', as: 'm' }]],
  ['aggregate', [{ aggregate: [{ op: 'sum', field: 'b', as: 'm' }], groupby: ['a', 'c', 'g'] }]],
]

const x = { field: 'a', type: 'nominal' }
const m = { field: 'm', type: 'quantitative' }
const LAYERS: Array<[string, Record<string, unknown>[], boolean]> = [
  ['bar + text', [{ mark: 'bar', encoding: { x, y: m } }, { mark: { type: 'text', dy: -4 }, encoding: { x, y: m, text: m } }], false],
  ['bar + mean rule', [{ mark: 'bar', encoding: { x, y: m } }, { mark: 'rule', encoding: { y: { ...m, aggregate: 'mean' } } }], false],
  ['point + tick + text', [{ mark: 'point', encoding: { x, y: m } }, { mark: 'tick', encoding: { x, y: m } }, { mark: 'text', encoding: { x, y: m, text: { field: 'a' } } }], false],
  // (a temporal field is cast once for the layers, in a dataset of its own)
  ['point over time + line', [{ mark: 'point', encoding: { x: { field: 't', type: 'temporal' }, y: m } }, { mark: 'line', encoding: { x: { field: 't', type: 'temporal' }, y: m } }], true],
]

const cases: Array<[string, Record<string, unknown>]> = []
for (const [fName, facet] of FACETS) {
  for (const [lName, layers, temporal] of LAYERS) {
    for (const [tName, transform] of TRANSFORMS) {
      // (an aggregate drops the date: a temporal layer set reads a field the aggregate keeps)
      const tf = temporal && tName === 'aggregate' ? [{ aggregate: [{ op: 'sum', field: 'b', as: 'm' }], groupby: ['a', 'c', 'g', 't'] }] : transform
      cases.push([caseName(fName, lName, tName, 'on the facet'), { data, transform: tf, ...facet, spec: { layer: layers } }])
      cases.push([caseName(fName, lName, tName, 'on the layer spec'), { data, ...facet, spec: { transform: tf, layer: layers } }])
      cases.push([caseName(fName, lName, tName, 'on every layer'), { data, ...facet, spec: { layer: layers.map((l) => ({ ...l, transform: tf })) } }])
    }
    // (no transform: the layers draw a field of the data)
    cases.push([caseName(fName, lName, 'none'), { data: { values: data.values.map((r) => ({ ...r, m: r.b })) }, ...facet, spec: { layer: layers } }])
  }
}

describe('a facet of layers draws each cell from its own rows', () => {
  for (const [name, spec] of cases) it(name, () => drawsLikeVegaLite(spec), 30_000)
})
