// @vitest-environment node
/**
 * A variable parameter as vega-lite 6.4.3 assembles it (parameter.ts assembleParameterSignals): its `value` is a literal whatever it
 * holds - `{expr: "x"}` is an object with a key `expr`, not an expression (C442) - and its `expr` is the signal's update, or its init
 * when the parameter is bound (both were refused before; vega-lite compiles them). Each case is drawn by vega-lite and by @aster-charts/vl through real Vega.
 */
import { describe, it } from 'vitest'
import { drawsLikeVegaLite, caseName } from './vl-composition-render.js'

const data = { values: [{ a: 'A', b: 3 }, { a: 'B', b: 7 }] }
const sized = (expr: string): Record<string, unknown> => ({ x: { field: 'a', type: 'nominal' }, y: { field: 'b', type: 'quantitative' }, size: { value: { expr } } })
const cases: Array<[string, Record<string, unknown>]> = []
for (const [label, value, read] of [
  ['an object with an expr key', { expr: 'x' }, 'p.expr.length * 40'],
  ['an object with a signal key', { signal: 'x' }, 'p.signal.length * 40'],
  ['an object', { k: 5 }, 'p.k * 20'],
  ['an array', [1, 5], 'p[1] * 20'],
  ['null', null, 'p === null ? 200 : 20'],
] as const) {
  for (const mark of ['point', 'square']) cases.push([caseName(`a value that is ${label}`, mark), { data, params: [{ name: 'p', value }], mark, encoding: sized(read) }])
}
cases.push(['an expr, unbound: the signal updates', { data, params: [{ name: 'p', expr: '3 * 20' }], mark: 'point', encoding: sized('p') }])
cases.push(['an expr and a value: the value, then the update', { data, params: [{ name: 'p', value: 9, expr: '3 * 20' }], mark: 'point', encoding: sized('p') }])
cases.push(['a description and react', { data, params: [{ name: 'p', value: 2, expr: 'p * 30', react: false, description: 'the size' }], mark: 'point', encoding: sized('p') }])
cases.push(['an expr, bound: the expr is the initial value', { data, params: [{ name: 'p', expr: '3 * 20', bind: { input: 'range', min: 0, max: 200 } }], mark: 'point', encoding: sized('p') }])

describe('a variable parameter is the signal vega-lite makes of it', () => {
  for (const [name, spec] of cases) it(name, () => drawsLikeVegaLite(spec), 30_000)
})
