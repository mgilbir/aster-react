// @vitest-environment node
/**
 * Names of the spec that collide in the compiled Vega (C182), against vega-lite 6.4.3 through real Vega: a variable parameter named as a
 * name the compiler makes (`unit`, `x_step`, `width`-like sizes, a selection's `<name>_tuple`) x the view it sits in; one selection name
 * in two layers, two concat views, a repeat; two views of one `name` x the composition. Where vega-lite's output does not run,
 * @aster-charts/vl refuses with a VLCompileError naming the collision (not Vega's raw error); where it runs, both draw the same.
 */
import { describe, it, expect } from 'vitest'
import { compile } from '@aster-charts/vl'
import { drawsLikeVegaLite, caseName } from './vl-composition-render.js'

const rows = Array.from({ length: 6 }, (_, i) => ({ a: ['A', 'B', 'C'][i % 3], b: i + 1, c: (i * 5) % 7 }))
const data = { values: rows }
const pt = { mark: 'point', encoding: { x: { field: 'b', type: 'quantitative' }, y: { field: 'c', type: 'quantitative' } } }
const bar = { mark: 'bar', encoding: { x: { field: 'a', type: 'nominal' }, y: { field: 'b', type: 'quantitative' } } }
type View = Record<string, unknown>

const cases: Array<[string, View]> = []
// a variable parameter named as a compiler-made name
for (const name of ['unit', 'x_step', 'y_step', 'width', 'height', 'brush_tuple', 'brush_x', 'brush_modify', 'cursor', 'data_0', 'childWidth']) {
  cases.push([caseName(`a parameter named ${name}`, 'beside an interval brush on a bar'), { data, ...bar, params: [{ name, value: 1 }, { name: 'brush', select: 'interval' }] }])
  cases.push([caseName(`a parameter named ${name}`, 'on a plain bar'), { data, params: [{ name, value: 1 }], ...bar }])
}
// one selection name in several views
const sel = (v: View, name = 's', type = 'point'): View => ({ ...v, params: [{ name, select: type }] })
for (const type of ['point', 'interval']) {
  cases.push([caseName(`one ${type} selection name`, 'in two layers'), { data, layer: [sel(pt, 's', type), sel({ ...pt, mark: 'square' }, 's', type)] }])
  cases.push([caseName(`one ${type} selection name`, 'in two concat views'), { data, hconcat: [sel(pt, 's', type), sel(pt, 's', type)] }])
  cases.push([caseName(`one ${type} selection name`, 'in a repeat'), { data, repeat: ['b', 'c'], spec: sel({ ...pt, encoding: { ...pt.encoding, x: { field: { repeat: 'repeat' }, type: 'quantitative' } } }, 's', type) }])
  cases.push([caseName(`one ${type} selection name`, 'top-level and in a layer'), { data, params: [{ name: 's', value: 1 }], layer: [sel(pt, 't', type)] }])
}
// two views of one name
for (const [k, wrap] of [['hconcat', (a: View, b: View) => ({ data, hconcat: [a, b] })], ['vconcat', (a: View, b: View) => ({ data, vconcat: [a, b] })], ['layer', (a: View, b: View) => ({ data, layer: [a, b] })]] as const) {
  for (const [vName, v] of [['bars', bar], ['points', pt]] as const) {
    cases.push([caseName('two views named v', k, vName), wrap({ name: 'v', ...v }, { name: 'v', ...v })])
    cases.push([caseName('two views named v and w', k, vName), wrap({ name: 'v', ...v }, { name: 'w', ...v })])
  }
}

describe('names that collide in the compiled Vega are refused by name, or drawn as vega-lite draws them', () => {
  for (const [name, spec] of cases) it(name, () => drawsLikeVegaLite(spec), 30_000)
})

describe('the refusal names the collision', () => {
  it('a parameter named x_step on a bar', () => {
    expect(() => compile({ data, params: [{ name: 'x_step', value: 1 }], ...bar })).toThrow(/declares the Vega signal "x_step" twice/)
  })
})
