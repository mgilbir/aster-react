// @vitest-environment node
/**
 * A rounded stacked bar is laid out in vega-lite's stack group (mark.ts getStackGroup) whichever channel stack.ts stacks: a bar that spans a
 * time unit on x (x and x2 of one field) over a measure on y has no orientation of its own, and stacks y. The group followed the bar's
 * orientation (horizontal), which stacks nothing there, so the bar was drawn as a stack of plain rects.
 */
import { describe, it } from 'vitest'
import { check, plain } from './vl-parity-check.js'

const DATA = { values: [{ t: '2024-01-07', v: 28, c: 'a' }, { t: '2024-03-19', v: 55, c: 'b' }, { t: '2024-03-25', v: 43, c: 'a' }, { t: '2024-06-02', v: 12, c: 'b' }] }
const time = (unit: string, extra: Record<string, unknown> = {}) => ({ field: 't', type: 'temporal', timeUnit: unit, ...extra })
const CASES: Array<[string, Record<string, unknown>]> = [
  ['a time unit on x and x2, y stacked', { x: time('yearmonth'), x2: { field: 't', timeUnit: 'yearmonth' }, y: { field: 'v', type: 'quantitative' } }],
  ['the same stacked by colour', { x: time('yearmonth'), x2: { field: 't', timeUnit: 'yearmonth' }, y: { field: 'v', type: 'quantitative' }, color: { field: 'c', type: 'nominal' } }],
  ['a time unit on y and y2, x stacked', { y: time('yearmonth'), y2: { field: 't', timeUnit: 'yearmonth' }, x: { field: 'v', type: 'quantitative' } }],
  ['a time unit on x alone, y stacked', { x: time('yearmonth'), y: { field: 'v', type: 'quantitative' }, color: { field: 'c', type: 'nominal' } }],
  ['a nominal x, y stacked', { x: { field: 'c', type: 'nominal' }, y: { field: 'v', type: 'quantitative' }, color: { field: 't', type: 'nominal' } }],
]
describe('@aster-charts/vl == vega-lite: the stack group of a rounded bar', () => {
  for (const [name, encoding] of CASES) {
    for (const cornerRadius of [4, 12]) it(`${name}, corner radius ${cornerRadius}`, () => check(plain({ data: DATA, mark: { type: 'bar', cornerRadius }, encoding })), 30_000)
  }
})
