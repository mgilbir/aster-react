// @vitest-environment node
/**
 * The expressions the Vega-Lite schema takes in the definition of a composite mark (a colour, the size of ticks, the colour of a median,
 * the stroke width of a rule) read the parameter they name, against vega-lite 6.4.3. (The forms the schema gives a plain number - the
 * opacity, thickness and size of the whole mark - are refused by the schema check, which vega-lite does not make.)
 */
import { describe, it } from 'vitest'
import { check, plain } from './vl-parity-check.js'

const DATA = { values: [{ c: 'A', v: 5 }, { c: 'B', v: 9 }, { c: 'A', v: 2 }, { c: 'B', v: 7 }, { c: 'A', v: 6 }] }
const PARAMS = [{ name: 'p', value: 0.5 }, { name: 'w', value: 3 }, { name: 'col', value: 'red' }]
const CASES: Array<[string, Record<string, unknown>]> = [
  ['an errorbar colour', { type: 'errorbar', color: { expr: 'col' } }],
  ['an errorbar with ticks of a parameter\'s size', { type: 'errorbar', ticks: { size: { expr: 'w' } } }],
  ['an errorbar with a rule of a parameter\'s width', { type: 'errorbar', rule: { strokeWidth: { expr: 'w' } } }],
  ['an errorband colour with borders', { type: 'errorband', borders: true, color: { expr: 'col' } }],
  ['an errorband with a band of a parameter\'s opacity', { type: 'errorband', band: { opacity: { expr: 'p' } } }],
  ['a boxplot colour', { type: 'boxplot', color: { expr: 'col' } }],
  ['a boxplot median colour', { type: 'boxplot', median: { color: { expr: 'col' } } }],
  ['a boxplot rule width', { type: 'boxplot', rule: { strokeWidth: { expr: 'w' } } }],
  ['a boxplot box opacity', { type: 'boxplot', box: { opacity: { expr: 'p' } } }],
  ['a boxplot outlier size', { type: 'boxplot', outliers: { size: { expr: 'w * 10' } } }],
]
describe('@aster-charts/vl == vega-lite: an expression in the definition of a composite mark', () => {
  for (const [name, mark] of CASES) {
    for (const horizontal of [false, true]) {
      it(`${name}${horizontal ? ', horizontal' : ''}`, () => check(plain({ data: DATA, params: PARAMS, mark, encoding: horizontal ? { y: { field: 'c', type: 'nominal' }, x: { field: 'v', type: 'quantitative' } } : { x: { field: 'c', type: 'nominal' }, y: { field: 'v', type: 'quantitative' } } })), 30_000)
    }
  }
})
