// @vitest-environment node
/**
 * The top-level chrome and the data forms, against vega-lite 6.4.3 through real Vega, over the view kinds they apply to (a unit, a
 * layer, a concat, a facet): titles (empty, a subtitle alone, a non-string, a layer's own or its layers', a facet spec's own) (C162,
 * C427), background null (C427), usermeta (C427), named datasets of every inline form (rows, CSV text, a JSON object) (C165), and
 * `format.parse` null for the whole source or a field (C181).
 */
import { describe, it, expect } from 'vitest'
import * as vl from 'vega-lite'
import { compile } from '@aster-charts/vl'
import { drawsLikeVegaLite, caseName } from './vl-composition-render.js'

const rows = [{ a: 'A', b: 28, t: '2020-01-05' }, { a: 'B', b: 55, t: '2020-02-07' }, { a: 'C', b: 43, t: '2020-03-09' }]
const data = { values: rows }
const pt = { mark: 'point', encoding: { x: { field: 'b', type: 'quantitative' }, y: { field: 'a', type: 'nominal' } } }

const VIEWS: Array<[string, (extra: Record<string, unknown>, leafTitles?: unknown[]) => Record<string, unknown>]> = [
  ['unit', (extra) => ({ data, ...pt, ...extra })],
  ['layer', (extra, leafTitles = []) => ({ data, ...extra, layer: [{ ...pt, ...(leafTitles[0] !== undefined ? { title: leafTitles[0] } : {}) }, { mark: 'rule', encoding: { x: { field: 'b', aggregate: 'mean', type: 'quantitative' } }, ...(leafTitles[1] !== undefined ? { title: leafTitles[1] } : {}) }] })],
  ['hconcat', (extra) => ({ data, ...extra, hconcat: [pt, pt] })],
  ['facet', (extra) => ({ data, ...extra, facet: { column: { field: 'a', type: 'nominal' } }, spec: pt })],
]
const TITLES: Array<[string, unknown]> = [
  ['a string', 'T'], ['empty text', ''], ['an array', ['one', 'two']], ['an empty array', []], ['an object', { text: 'T', subtitle: 'S', color: 'red' }],
  ['a subtitle alone', { subtitle: 'S' }], ['empty text and a subtitle', { text: '', subtitle: 'S' }],
]

const cases: Array<[string, Record<string, unknown>]> = []
for (const [vName, view] of VIEWS) {
  for (const [tName, title] of TITLES) cases.push([caseName(vName, `title: ${tName}`), view({ title })])
  cases.push([caseName(vName, 'background null'), view({ background: null })])
  cases.push([caseName(vName, 'background null over a config background'), view({ background: null, config: { background: 'red' } })])
}
// a layer's own title, or its layers' (the first with text, depth first)
for (const [name, own, leaf] of [['the first layer\'s', undefined, ['first', 'second']], ['the second when the first has none', undefined, ['', 'second']], ['its own over its layers\'', 'own', ['first', 'second']], ['a subtitle-only first layer skipped', undefined, [{ subtitle: 'S' }, 'second']]] as const) {
  cases.push([caseName('layer', `title: ${name}`), VIEWS[1]![1](own !== undefined ? { title: own } : {}, [...leaf])])
}
cases.push(['nested layer: the inner layer\'s title', { data, layer: [{ title: 'inner', layer: [{ ...pt, title: 'leaf' }] }, pt] }])
// a facet's spec's own title is the cell's, unless the headers' labels are
cases.push(['facet: the spec\'s title', { data, facet: { column: { field: 'a', type: 'nominal' } }, spec: { ...pt, title: 'inner' } }])
cases.push(['facet: a layered spec\'s title', { data, facet: { row: { field: 'a', type: 'nominal' } }, spec: { title: 'inner', layer: [pt, { ...pt, mark: 'tick' }] } }])
cases.push(['wrapped facet: the labels are the cell titles', { data, facet: { field: 'a', type: 'nominal' }, spec: { ...pt, title: 'inner' } }])
cases.push(['facet with bottom labels: the labels are the cell titles', { data, facet: { row: { field: 'a', type: 'nominal', header: { labelOrient: 'bottom' } } }, spec: { ...pt, title: 'inner' } }])
// named datasets of every inline form, read by a unit, a layer and a lookup
const DATASETS: Array<[string, unknown, Record<string, unknown> | undefined]> = [
  ['rows', rows, undefined],
  ['a CSV text', 'a,b\nA,28\nB,55\nC,43', { type: 'csv' }],
  ['a TSV text', 'a\tb\nA\t28\nB\t55', { type: 'tsv' }],
  ['a JSON object with a property', { table: rows }, { property: 'table' }],
]
for (const [name, entry, format] of DATASETS) {
  const d = { name: 'tbl', ...(format ? { format } : {}) }
  cases.push([caseName('datasets', name, 'unit'), { datasets: { tbl: entry }, data: d, mark: 'bar', encoding: { x: { field: 'a', type: 'nominal' }, y: { field: 'b', type: 'quantitative' } } }])
  cases.push([caseName('datasets', name, 'layer'), { datasets: { tbl: entry }, data: d, layer: [{ mark: 'bar', encoding: { x: { field: 'a', type: 'nominal' }, y: { field: 'b', type: 'quantitative' } } }, { mark: 'rule', encoding: { y: { field: 'b', aggregate: 'mean', type: 'quantitative' } } }] }])
  cases.push([caseName('datasets', name, 'unused beside another'), { datasets: { tbl: entry, other: rows }, data: { values: rows }, ...pt }])
}
// format.parse: null for the source, or for one field
for (const [name, parse] of [['null', null], ['null for the date', { t: null }], ['null for the number', { b: null }], ['a date and a null', { t: 'date', b: null }]] as const) {
  for (const type of ['temporal', 'ordinal'] as const) {
    cases.push([caseName('parse', name, `t ${type}`), { data: { values: rows, format: { parse } }, mark: 'point', encoding: { x: { field: 't', type }, y: { field: 'b', type: 'quantitative' } } }])
  }
  cases.push([caseName('parse', name, 'a csv url'), { data: { values: 'a,b,t\nA,28,2020-01-05\nB,55,2020-02-07', format: { type: 'csv', parse } }, mark: 'point', encoding: { x: { field: 't', type: 'temporal' }, y: { field: 'b', type: 'quantitative' } } }])
}

// (C426) autosize fit over a view sized by steps: vega-lite fits the other dimension only, or pads
for (const autosize of ['fit', 'fit-x', 'fit-y', { type: 'fit', contains: 'padding' }, { type: 'fit-x', resize: true }]) {
  for (const [sName, enc] of [['steps along x', { x: { field: 'a', type: 'nominal' }, y: { field: 'b', type: 'quantitative' } }], ['steps along y', { y: { field: 'a', type: 'nominal' }, x: { field: 'b', type: 'quantitative' } }], ['steps both ways', { x: { field: 'a', type: 'nominal' }, y: { field: 'a', type: 'nominal' } }], ['no steps', { x: { field: 'b', type: 'quantitative' }, y: { field: 'b', type: 'quantitative' } }]] as const) {
    cases.push([caseName('autosize', JSON.stringify(autosize), sName, 'unit'), { data, autosize, mark: 'bar', encoding: enc }])
    cases.push([caseName('autosize', JSON.stringify(autosize), sName, 'layer'), { data, autosize, layer: [{ mark: 'bar', encoding: enc }, { mark: 'point', encoding: enc }] }])
    cases.push([caseName('config.autosize', JSON.stringify(autosize), sName), { data, config: { autosize }, mark: 'bar', encoding: enc }])
  }
}

describe('top-level chrome and data forms draw what vega-lite draws', () => {
  for (const [name, spec] of cases) it(name, () => drawsLikeVegaLite(spec), 30_000)
})

// (a title the schema does not allow - a number - is refused by its path (C245): vega-lite draws no title for it, Aster drew "42")
describe('a title of a type the schema does not allow is refused', () => {
  for (const [vName, view] of VIEWS) {
    for (const title of [42, true, null]) {
      it(`${vName}: title ${JSON.stringify(title)}`, () => {
        expect(() => compile(view({ title }) as never)).toThrow(/^\[aster\/vl\] title: must be a string, an array or an object/)
      })
    }
  }
})

describe('usermeta passes through as vega-lite passes it', () => {
  for (const [vName, view] of VIEWS) {
    it(vName, () => {
      const spec = view({ usermeta: { k: 1, nested: { list: [1, 2] } } })
      const theirs = (vl as any).compile(JSON.parse(JSON.stringify(spec))).spec.usermeta
      expect((compile(JSON.parse(JSON.stringify(spec))) as Record<string, unknown>).usermeta).toEqual(theirs)
    })
  }
})
