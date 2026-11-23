// @vitest-environment node
/**
 * The cross-view optimizations (optimize.ts: MergeBins, MergeIdenticalNodes, MergeAggregates, the shared sources) merge only what is the
 * same, against vega-lite 6.4.3 through real Vega, over the composition shapes two views can share data in (hconcat, vconcat, layer,
 * repeat, facet, and a layer inside a concat) x the bins (a computed extent, a literal extent, maxbins, a step, on x, on colour, on size)
 * x what the second view does first (nothing, a filter, a calculate of the binned field, other data) (C51, C56); the aggregates two
 * views make under one name (C57); the parses of one data (C180); and an `extent` transform's parameter read across views (C58).
 */
import { describe, it, expect } from 'vitest'
import { compile, VLCompileError } from '@aster-charts/vl'
import { drawsLikeVegaLite, caseName } from './vl-composition-render.js'

const rows = Array.from({ length: 24 }, (_, i) => ({ a: ['A', 'B', 'C'][i % 3], g: i % 2 ? 'p' : 'q', b: (i * 7) % 31, u: (i * 5) % 17, t: `2020-0${(i % 9) + 1}-1${i % 9}` }))
const data = { values: rows }
const other = { values: rows.map((r) => ({ ...r, b: r.b * 10 })) }

type View = Record<string, unknown>
const BINS: Array<[string, (f: string) => View]> = [
  ['bin true on x', (f) => ({ mark: 'bar', encoding: { x: { field: f, type: 'quantitative', bin: true }, y: { aggregate: 'count', type: 'quantitative' } } })],
  ['bin with a literal extent', (f) => ({ mark: 'bar', encoding: { x: { field: f, type: 'quantitative', bin: { extent: [0, 30] } }, y: { aggregate: 'count', type: 'quantitative' } } })],
  ['bin maxbins 5', (f) => ({ mark: 'bar', encoding: { x: { field: f, type: 'quantitative', bin: { maxbins: 5 } }, y: { aggregate: 'count', type: 'quantitative' } } })],
  ['bin step 5', (f) => ({ mark: 'bar', encoding: { x: { field: f, type: 'quantitative', bin: { step: 5 } }, y: { aggregate: 'count', type: 'quantitative' } } })],
  ['binned colour', (f) => ({ mark: 'rect', encoding: { x: { field: 'a', type: 'nominal' }, y: { field: 'g', type: 'nominal' }, color: { field: f, type: 'quantitative', bin: { extent: [0, 30] } } } })],
  ['binned size', (f) => ({ mark: 'point', encoding: { x: { field: 'a', type: 'nominal' }, y: { field: 'u', type: 'quantitative' }, size: { field: f, type: 'quantitative', bin: true } } })],
]
/** What the second view does before it bins. */
const SECOND: Array<[string, (v: View) => View]> = [
  ['the same', (v) => v],
  ['filtered first', (v) => ({ ...v, transform: [{ filter: 'datum.b < 20' }] })],
  ['over other data', (v) => ({ ...v, data: other })],
]
const SHAPES: Array<[string, (v1: View, v2: View) => Record<string, unknown>]> = [
  ['hconcat', (v1, v2) => ({ data, hconcat: [v1, v2] })],
  ['vconcat', (v1, v2) => ({ data, vconcat: [v1, v2] })],
  ['layer', (v1, v2) => ({ data, layer: [v1, v2] })],
  ['layer in a concat', (v1, v2) => ({ data, hconcat: [{ layer: [v1, v2] }, v1] })],
]

const cases: Array<[string, Record<string, unknown>]> = []
for (const [bName, bin] of BINS) {
  for (const [sName, second] of SECOND) {
    for (const [shName, shape] of SHAPES) cases.push([caseName(shName, bName, `second view ${sName}`), shape(bin('b'), second(bin('b')))])
  }
  // (the first view changes its rows first: the second's bins are not the first's)
  for (const [shName, shape] of SHAPES) cases.push([caseName(shName, bName, 'first view filtered first'), shape({ ...bin('b'), transform: [{ filter: 'datum.b < 20' }] }, bin('b'))])
  cases.push([caseName('repeat', bName), { data, repeat: ['b', 'u'], spec: bin('b') }])
  cases.push([caseName('facet', bName), { data, facet: { column: { field: 'g', type: 'nominal' } }, spec: bin('b') }])
}
// (C58) an extent's parameter is the spec's, read by whatever view reads it
const EXTENT_READERS: Array<[string, Record<string, unknown>]> = [
  ['in a concat view, read by that view', { data, hconcat: [{ transform: [{ extent: 'b', param: 'ex' }, { filter: 'datum.b > ex[0]' }], mark: 'point', encoding: { x: { field: 'b', type: 'quantitative' } } }, { mark: 'point', encoding: { x: { field: 'u', type: 'quantitative' } } }] }],
  ['in a concat view, read by a parameter', { data, params: [{ name: 'top', expr: 'ex[1]' }], hconcat: [{ transform: [{ extent: 'b', param: 'ex' }], mark: 'point', encoding: { x: { field: 'b', type: 'quantitative' }, size: { value: { expr: 'top' } } } }, { mark: 'point', encoding: { x: { field: 'u', type: 'quantitative' } } }] }],
  ['in a facet spec', { data, facet: { column: { field: 'g', type: 'nominal' } }, spec: { transform: [{ extent: 'b', param: 'ex' }], mark: 'point', encoding: { x: { field: 'b', type: 'quantitative' }, size: { value: { expr: 'ex[1]' } } } } }],
  ['on a layer, read by both layers', { data, transform: [{ extent: 'b', param: 'ex' }], layer: [{ mark: 'point', encoding: { x: { field: 'b', type: 'quantitative' }, size: { value: { expr: 'ex[1]' } } } }, { mark: 'rule', encoding: { y: { field: 'u', aggregate: 'mean', type: 'quantitative' }, strokeWidth: { value: { expr: 'ex[0]' } } } }] }],
  ['on the root, read by concat views', { data, transform: [{ extent: 'b', param: 'ex' }], hconcat: [{ mark: 'point', encoding: { x: { field: 'b', type: 'quantitative' }, size: { value: { expr: 'ex[1]' } } } }, { mark: 'point', encoding: { x: { field: 'u', type: 'quantitative' }, size: { value: { expr: 'ex[0] + 2' } } } }] }],
]

describe('the cross-view merges merge what is the same, and only that', () => {
  for (const [name, spec] of cases) it(name, () => drawsLikeVegaLite(spec), 30_000)
  for (const [name, spec] of EXTENT_READERS) it(`an extent parameter ${name}`, () => drawsLikeVegaLite(spec), 30_000)
})

describe('two views that aggregate different measures into one name (C57: vega-lite draws one of them in both, refused)', () => {
  const agg = (op: string, field: string, as = 'v'): View => ({ transform: [{ aggregate: [{ op, field, as }], groupby: ['a'] }], mark: 'bar', encoding: { x: { field: 'a', type: 'nominal' }, y: { field: as, type: 'quantitative' } } })
  const conflicting: Array<[string, Record<string, unknown>]> = []
  for (const [shName, shape] of SHAPES) {
    conflicting.push([caseName(shName, 'sum and mean of one field'), shape(agg('sum', 'b'), agg('mean', 'b'))])
    conflicting.push([caseName(shName, 'max and min'), shape(agg('max', 'b'), agg('min', 'b'))])
    conflicting.push([caseName(shName, 'the sum of two fields'), shape(agg('sum', 'b'), agg('sum', 'u'))])
  }
  for (const [name, spec] of conflicting) {
    it(`${name}: refused`, () => {
      expect(() => compile(JSON.parse(JSON.stringify(spec)))).toThrow(VLCompileError)
      expect(() => compile(JSON.parse(JSON.stringify(spec)))).toThrow(/same field "v"/)
    })
  }
  for (const [shName, shape] of SHAPES) {
    it(`${shName}: the same measure under one name, or different names, compile as vega-lite does`, async () => {
      await drawsLikeVegaLite(shape(agg('sum', 'b'), agg('sum', 'b')))
      await drawsLikeVegaLite(shape(agg('sum', 'b'), agg('mean', 'b', 'w')))
    }, 30_000)
  }
})

describe('views that parse the same rows differently keep their parses (C180)', () => {
  const view = (parse: Record<string, unknown> | undefined, type: string): View => ({ data: { values: rows, ...(parse ? { format: { parse } } : {}) }, mark: 'point', encoding: { x: { field: 't', type }, y: { field: 'b', type: 'quantitative' } } })
  const PAIRS: Array<[string, View, View]> = [
    ['date then string', view({ t: 'date' }, 'ordinal'), view({ t: 'string' }, 'ordinal')],
    ['date then none', view({ t: 'date' }, 'ordinal'), view(undefined, 'ordinal')],
    ['none then date', view(undefined, 'ordinal'), view({ t: 'date' }, 'ordinal')],
    ['number then date', view({ b: 'number' }, 'temporal'), view({ t: 'date' }, 'temporal')],
  ]
  for (const [name, v1, v2] of PAIRS) {
    for (const k of ['hconcat', 'vconcat'] as const) it(`${k}: ${name}`, () => drawsLikeVegaLite({ [k]: [v1, v2] }), 30_000)
  }
})
