// @vitest-environment node
/**
 * Every form of predicate, against vega-lite 6.4.3: the rows a filter keeps (here, and under the zones `pnpm test:tz` runs it in) and
 * the expression that keeps them. A predicate vega-lite refuses must be refused here.
 *
 * Field predicates (equal, lt, lte, gt, gte, range, oneOf, valid) over a number, a string, a boolean and a field with nulls in it, and
 * over a time unit; each with the kinds of value it takes (a plain value, a DateTime, a time-unit value, an expression); and the ways
 * to put them together (not, and, or, nested, a bare expression). A UTC time unit is not here: vega-lite reads a time unit in a field
 * predicate in local time whatever it says (its source says "TODO: support utc"), and @aster/vl reads it as asked, which the last tests
 * pin.
 */
import { describe, it, expect } from 'vitest'
import { compile } from '@aster/vl'
import { INSTANTS, bothCompile, rowsOf } from './vl-time-helpers.js'
import { expressionDiff } from './vl-expressions.js'

const DATA = INSTANTS.map((t, i) => ({ id: i, t, q: i % 9, s: 'abc'[i % 3], b: i % 2 === 0, n: i % 5 === 0 ? null : i, u: new Date(t).getTime() })).concat([{ id: INSTANTS.length, t: null as never, q: 4, s: 'a', b: false, n: null, u: null as never }])

const DATETIMES: Array<Record<string, unknown>> = [
  { year: 2020 }, { year: 2020, month: 'feb' }, { year: 2020, month: 3, date: 4 }, { month: 'Jan', date: 1 }, { year: 2020, quarter: 2 }, { year: 2020, hours: 5, minutes: 3 },
  { day: 'Mon' }, { year: 2020, month: 'march', date: 2, hours: 1, minutes: 2, seconds: 3, milliseconds: 4 }, { year: 2021, month: 1, date: 3, day: 'Sunday' }, { utc: true, year: 2020, month: 2 },
]

type Op = 'equal' | 'lt' | 'gt' | 'lte' | 'gte' | 'oneOf' | 'range' | 'valid'
const VALUES: Record<Op, unknown[]> = {
  equal: [3, 0, 'a', true, null, { expr: 'datum.q + 1' }, ...DATETIMES],
  lt: [3, 'b', { expr: '4' }, ...DATETIMES],
  gt: [3, 'b', ...DATETIMES],
  lte: [3, 'b', ...DATETIMES],
  gte: [3, 'b', ...DATETIMES],
  oneOf: [[1, 2, 3], ['a', 'b'], [true, false], [0, null], DATETIMES.slice(0, 3), []],
  range: [[1, 5], [null, 5], [1, null], [null, null], [DATETIMES[0], DATETIMES[1]], [DATETIMES[2], null]],
  valid: [true, false],
}
const FIELDS = ['q', 's', 'b', 'n', 't']
/** Units, and the values that suit them (a time unit compares numbers as parts of a date). */
const UNITS: unknown[] = ['year', 'quarter', 'month', 'week', 'day', 'dayofyear', 'date', 'hours', 'minutes', 'seconds', 'milliseconds', 'yearmonth', 'yearmonthdate', 'monthdate', 'hoursminutes', 'yearquarter', { unit: 'month', step: 2 }]
/** What each time unit can be compared with: a number, a time-unit value, and the names of the months and days for the units that have them. */
const UNIT_VALUES: Record<Op, unknown[]> = {
  equal: [3, 2020, '2020-03-01', { year: 2020, month: 3 }, { month: 'feb' }],
  lt: [3, 2020, { year: 2020, month: 3 }],
  gt: [3, 2020, { year: 2020, month: 3 }],
  lte: [3, 2020, { month: 'feb' }],
  gte: [3, 2020, { month: 'feb' }],
  oneOf: [[1, 2, 3], [{ month: 'feb' }, { month: 'mar' }]],
  range: [[1, 5], [2019, 2021], [null, 3], [2, null], [{ month: 'feb' }, { month: 'mar' }]],
  valid: [true, false],
}
const NAMES: Array<[string, Array<[Op, unknown]>]> = [
  ['month', [['equal', 'Mar'], ['equal', 'march'], ['lt', 'Mar'], ['gt', 'Mar'], ['oneOf', ['Jan', 'Feb']], ['range', ['Jan', 'Mar']]]],
  ['yearmonth', [['equal', 'Mar'], ['lt', 'march']]],
  ['day', [['equal', 'monday'], ['equal', 'Sun'], ['gt', 'Tue'], ['oneOf', ['Mon', 'Fri']]]],
]

const PREDICATES: Array<[string, unknown]> = []
for (const field of FIELDS) for (const op of Object.keys(VALUES) as Op[]) for (const value of VALUES[op]) PREDICATES.push([`${field} ${op} ${JSON.stringify(value)}`, { field, [op]: value }])
for (const unit of UNITS) for (const op of Object.keys(UNIT_VALUES) as Op[]) for (const value of UNIT_VALUES[op]) PREDICATES.push([`t ${JSON.stringify(unit)} ${op} ${JSON.stringify(value)}`, { field: 't', timeUnit: unit, [op]: value }])
for (const [unit, forms] of NAMES) for (const [op, value] of forms) PREDICATES.push([`t ${unit} ${op} ${JSON.stringify(value)}`, { field: 't', timeUnit: unit, [op]: value }])
const A = { field: 'q', gt: 2 }
const B = { field: 's', oneOf: ['a', 'b'] }
const C = { field: 't', timeUnit: 'month', range: [2, 6] }
PREDICATES.push(
  ['not', { not: A }], ['not of a bare expression', { not: 'datum.q > 2' }], ['and', { and: [A, B] }], ['or', { or: [A, B] }], ['and of three', { and: [A, B, C] }],
  ['or of three with a not', { or: [A, { not: B }, C] }], ['not of an and', { not: { and: [A, { or: [B, C] }] } }], ['and of nots and ors', { and: [{ not: A }, { or: [B, { not: C }] }] }],
  ['bare expression', 'datum.q > 2'], ['and with expressions', { and: ['datum.q > 2', B] }], ['a value that is an expression', { field: 'q', equal: { expr: 'datum.q + 1' } }],
  ['and of one', { and: [A] }], ['or of one', { or: [A] }], ['nested not', { not: { not: A } }],
)

/** Which rows a compiled spec keeps (the rows are told apart by their `id`: how the other fields are parsed is not the filter's). */
const keptBy = async (spec: unknown): Promise<unknown[]> => (await rowsOf(spec)).map((r: any) => r.id)

describe('a filter is what vega-lite makes', () => {
  for (const [name, predicate] of PREDICATES) {
    it(name, async () => {
      const both = bothCompile({ data: { values: DATA }, transform: [{ filter: predicate }], mark: 'point', encoding: { x: { field: 'q', type: 'quantitative' }, y: { field: 'u', type: 'quantitative' } } })
      if ('refusedBy' in both) {
        expect(both.refusedBy, name).toBe('vega-lite')
        return
      }
      expect(expressionDiff(both.ours, both.theirs)).toBe('')
      expect(await keptBy(both.ours)).toEqual(await keptBy(both.theirs))
    })
  }
})

describe('a condition tests what vega-lite makes', () => {
  for (const [name, predicate] of PREDICATES.filter((_, i) => i % 7 === 0)) {
    it(name, () => {
      const both = bothCompile({ data: { values: DATA }, mark: 'point', encoding: { x: { field: 'q', type: 'quantitative' }, color: { condition: { test: predicate, value: 'red' }, value: 'grey' } } })
      if ('refusedBy' in both) return expect(both.refusedBy, name).toBe('vega-lite')
      expect(expressionDiff(both.ours, both.theirs)).toBe('')
    })
  }
})

describe('a UTC time unit in a field predicate is read as UTC', () => {
  const expr = (predicate: unknown): string => {
    const out: any = compile({ data: { values: DATA }, transform: [{ filter: predicate }], mark: 'point', encoding: { x: { field: 'q', type: 'quantitative' } } } as never)
    return out.data.flatMap((d: any) => d.transform ?? []).find((t: any) => t.type === 'filter').expr
  }
  it('as an object', () => {
    expect(expr({ field: 't', timeUnit: { unit: 'yearmonth', utc: true }, gte: { year: 2020, month: 'feb' } })).toBe('time(utc(utcyear(datum["t"]), utcmonth(datum["t"]), 1, 0, 0, 0, 0))>=time(datetime(2020, 1, 1, 0, 0, 0, 0))')
  })
  it('as a string', () => {
    expect(expr({ field: 't', timeUnit: 'utcyear', equal: { utc: true, year: 2020 } })).toBe('time(utc(utcyear(datum["t"]), 0, 1, 0, 0, 0, 0))===time(utc(2020, 0, 1, 0, 0, 0, 0))')
  })
  it('over UTC values', () => {
    expect(expr({ field: 't', timeUnit: 'utcyearmonthdate', range: [{ utc: true, year: 2020, month: 2, date: 3 }, { utc: true, year: 2021 }] })).toBe(
      'inrange(time(utc(utcyear(datum["t"]), utcmonth(datum["t"]), utcdate(datum["t"]), 0, 0, 0, 0)), [time(utc(2020, 1, 3, 0, 0, 0, 0)), time(utc(2021, 0, 1, 0, 0, 0, 0))])',
    )
  })
  it('with a local unit and a UTC value, the value alone is UTC', () => {
    expect(expr({ field: 't', timeUnit: 'year', equal: { utc: true, year: 2020 } })).toBe('time(datetime(year(datum["t"]), 0, 1, 0, 0, 0, 0))===time(utc(2020, 0, 1, 0, 0, 0, 0))')
  })
})
