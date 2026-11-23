// @vitest-environment node
/**
 * The user's own expressions are not renamed by a composition (C299), against vega-lite 6.4.3 through real Vega: a `labelExpr` that
 * names `width` / `height` / a parameter on an axis, a legend or a header x the composition (hconcat, vconcat, repeat, a facet, a layer,
 * a concat of independent scales), next to the compiler's own expressions that read the same names.
 */
import { describe, it } from 'vitest'
import { drawsLikeVegaLite, caseName } from './vl-composition-render.js'

const rows = Array.from({ length: 6 }, (_, i) => ({ a: ['A', 'B', 'C'][i % 3], g: i % 2 ? 'p' : 'q', b: i + 2, c: (i * 5) % 7 + 1 }))
const data = { values: rows }
const EXPRS = ["datum.value + '/' + width", "datum.label + ' of ' + height", "width > 100 ? datum.label : '-'", "datum.label + k"]
const view = (expr: string, where: 'axis' | 'legend'): Record<string, unknown> => ({
  mark: 'point',
  encoding: {
    x: { field: 'b', type: 'quantitative', ...(where === 'axis' ? { axis: { labelExpr: expr } } : {}) },
    y: { field: 'c', type: 'quantitative' },
    color: { field: 'a', type: 'nominal', ...(where === 'legend' ? { legend: { labelExpr: expr } } : {}) },
  },
})
const params = [{ name: 'k', value: '!' }]
const cases: Array<[string, Record<string, unknown>]> = []
for (const expr of EXPRS) {
  for (const where of ['axis', 'legend'] as const) {
    const v = view(expr, where)
    cases.push([caseName(where, expr, 'unit'), { data, params, ...v }])
    cases.push([caseName(where, expr, 'hconcat'), { data, params, hconcat: [v, v] }])
    cases.push([caseName(where, expr, 'vconcat'), { data, params, vconcat: [v, v] }])
    cases.push([caseName(where, expr, 'hconcat, independent x'), { data, params, hconcat: [v, v], resolve: { scale: { x: 'independent' } } }])
    cases.push([caseName(where, expr, 'repeat'), { data, params, repeat: ['b', 'c'], spec: { ...v, encoding: { ...(v.encoding as object), y: { field: { repeat: 'repeat' }, type: 'quantitative' } } } }])
    cases.push([caseName(where, expr, 'facet'), { data, params, facet: { column: { field: 'g', type: 'nominal' } }, spec: v }])
    cases.push([caseName(where, expr, 'layer'), { data, params, layer: [v, { ...v, mark: 'square' }] }])
  }
  cases.push([caseName('header', expr, 'facet'), { data, params, facet: { column: { field: 'g', type: 'nominal', header: { labelExpr: expr } } }, spec: view("datum.label", 'axis') }])
}

describe('a composition leaves the user\'s expressions as written', () => {
  for (const [name, spec] of cases) it(name, () => drawsLikeVegaLite(spec), 30_000)
})
