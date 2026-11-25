// @vitest-environment node
/**
 * A top-level `padding` given as an expression (`{"expr": "p"}`) on every kind of view, composite marks included, against vega-lite 6.4.3:
 * the padding is the signal's value and each composite mark (boxplot, errorbar, errorband - layers once vega-lite has normalized them)
 * lays out under it as a unit does.
 */
import { describe, it } from 'vitest'
import { check, plain } from './vl-parity-check.js'

const DATA = { values: [{ c: 'A', v: 5, w: 2 }, { c: 'B', v: 9, w: 3 }, { c: 'A', v: 2, w: 4 }, { c: 'B', v: 7, w: 1 }, { c: 'A', v: 6, w: 5 }, { c: 'B', v: 4, w: 2 }] }
const x = { field: 'c', type: 'nominal' }
const y = { field: 'v', type: 'quantitative' }
const VIEWS: Array<[string, Record<string, unknown>]> = [
  ['a bar', { mark: 'bar', encoding: { x, y } }],
  ['a boxplot', { mark: 'boxplot', encoding: { x, y } }],
  ['an errorbar', { mark: 'errorbar', encoding: { x, y } }],
  ['an errorband', { mark: 'errorband', encoding: { x, y } }],
  ['a boxplot in a layer', { layer: [{ mark: 'boxplot', encoding: { x, y } }, { mark: 'rule', encoding: { y: { datum: 4 } } }] }],
  ['an errorbar in an hconcat', { hconcat: [{ mark: 'errorbar', encoding: { x, y } }, { mark: 'point', encoding: { x: { field: 'w', type: 'quantitative' }, y } }] }],
  ['a boxplot in a column facet', { facet: { column: x }, spec: { mark: 'boxplot', encoding: { y } } }],
]
const PADDINGS: Array<[string, unknown]> = [['an expression', { expr: 'p' }], ['an expression computed', { expr: 'p * 2 + 1' }], ['a number', 11]]
describe('@aster-charts/vl == vega-lite: a padding that is an expression', () => {
  for (const [name, view] of VIEWS) {
    for (const [padName, padding] of PADDINGS) {
      it(`${name}, padding ${padName}`, () => check(plain({ data: DATA, params: [{ name: 'p', value: 9 }], padding, ...view })), 30_000)
    }
  }
})
