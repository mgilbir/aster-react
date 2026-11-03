// @vitest-environment node
/**
 * A ranged position over time units against vega-lite 6.4.3, in the zone the process runs in (`pnpm test:tz` runs it in each of the
 * zones): the domain of a time unit with a band spans its start to its end (month_t, month_t_end), the offsetted fields of a rect off
 * the middle of its band, and each channel of a range makes its own: a second channel that says it is temporal has a band of its own, a
 * first channel that has a second one has none. Compiled scales, scales and axes as they run, rows and SVG (vl-ranged-compare.ts).
 */
import { describe, it, expect } from 'vitest'
import { INSTANTS } from './vl-time-helpers.js'
import { collect } from './vl-ranged-compare.js'

type Obj = Record<string, unknown>
const DATA = INSTANTS.map((t, i) => ({ t, t2: INSTANTS[(i * 5 + 7) % INSTANTS.length], v: i % 5, k: i % 3 }))

const FIRST: Array<[string, Obj]> = [
  ['month', { field: 't', type: 'temporal', timeUnit: 'month' }],
  ['yearmonth', { field: 't', type: 'temporal', timeUnit: 'yearmonth' }],
  ['utcmonth', { field: 't', type: 'temporal', timeUnit: 'utcmonth' }],
  ['year, step 2', { field: 't', type: 'temporal', timeUnit: { unit: 'year', step: 2 } }],
  ['week', { field: 't', type: 'temporal', timeUnit: 'week' }],
  ['hours', { field: 't', type: 'temporal', timeUnit: 'hours' }],
  ['month, band position 0', { field: 't', type: 'temporal', timeUnit: 'month', bandPosition: 0 }],
  ['month, a utc scale', { field: 't', type: 'temporal', timeUnit: 'month', scale: { type: 'utc' } }],
  ['no unit', { field: 't', type: 'temporal' }],
]
const SECOND: Array<[string, Obj]> = [
  ['the same field and unit', { field: 't', timeUnit: 'month' }],
  ['the same field and unit, typed', { field: 't', timeUnit: 'month', type: 'temporal' }],
  ['another field and unit', { field: 't2', timeUnit: 'month' }],
  ['another field and unit, typed', { field: 't2', timeUnit: 'month', type: 'temporal' }],
  ['another unit, typed', { field: 't2', timeUnit: 'yearmonth', type: 'temporal' }],
  ['a utc unit, typed', { field: 't2', timeUnit: 'utcmonth', type: 'temporal' }],
  ['no unit', { field: 't2' }],
  ['no unit, typed', { field: 't2', type: 'temporal' }],
  ['a band position of 0, typed', { field: 't2', timeUnit: 'month', type: 'temporal', bandPosition: 0 }],
  ['a datum', { datum: { year: 2020, month: 6, date: 1 } }],
  ['a value', { value: 40 }],
]
const MARKS = ['bar', 'rect', 'rule', 'area', 'tick', 'line', 'point']

describe('a ranged position over time units has the scale, the axes and the marks vega-lite gives it', () => {
  for (const mark of MARKS) {
    for (const axis of ['x', 'y'] as const) {
      it(`${mark}, ${axis} and ${axis}2`, async () => {
        const other = axis === 'x' ? 'y' : 'x'
        const cases: Array<[string, Obj]> = []
        for (const [fn, first] of FIRST) {
          for (const [sn, second] of SECOND) {
            cases.push([`${fn} + ${sn}`, {
              data: { values: DATA },
              mark,
              encoding: { [axis]: first, [`${axis}2`]: second, [other]: { field: 'k', type: 'nominal' } },
            }])
          }
        }
        const bad = await collect(cases)
        expect(bad.slice(0, 6), `${bad.length} of ${cases.length} differ`).toEqual([])
      }, 240_000)
    }
  }

  it('a time unit alone has the band end its mark gives it (not ranged, nothing changes)', async () => {
    const cases: Array<[string, Obj]> = []
    for (const mark of MARKS) {
      for (const [fn, first] of FIRST) cases.push([`${mark} ${fn}`, { data: { values: DATA }, mark, encoding: { x: first, y: { field: 'v', type: 'quantitative' } } }])
    }
    const bad = await collect(cases)
    expect(bad.slice(0, 6), `${bad.length} of ${cases.length} differ`).toEqual([])
  }, 240_000)

  it('a ranged bar layered with a time-unit bar', async () => {
    const month = { field: 't', type: 'temporal', timeUnit: 'month' }
    const cases: Array<[string, Obj]> = []
    for (const [sn, second] of SECOND.slice(0, 8)) {
      const ranged = { mark: 'bar', encoding: { x: month, x2: second, y: { field: 'k', type: 'nominal' } } }
      const plain = { mark: 'bar', encoding: { x: month, y: { field: 'k', type: 'nominal' } } }
      cases.push([`${sn}, before`, { data: { values: DATA }, layer: [ranged, plain] }])
      cases.push([`${sn}, after`, { data: { values: DATA }, layer: [plain, ranged] }])
    }
    const bad = await collect(cases)
    expect(bad.slice(0, 6), `${bad.length} of ${cases.length} differ`).toEqual([])
  }, 240_000)
})
