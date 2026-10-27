/**
 * LIVE differential for the date-producing and date-consuming expression functions (vega-functions /
 * vega-expression 6.x): every one is evaluated by the pinned real Vega (as a signal expression of a `View`) and by
 * Aster's `compileExpr` on the same inputs, in one process, and the results are compared with the strict
 * `exact` image (a `Date` is not its timestamp, NaN is not undefined, -0 is not 0).
 *
 * The inputs include every kind a spec can feed in: null, undefined, '', numbers, NaN, numeric and date strings,
 * Dates (valid and invalid), booleans, arrays, objects.
 */
import { describe, expect, it, vi } from 'vitest'
import * as vega from 'vega'
import { compileExpr, type ExpressionRuntime } from '../../core/src/expression.ts'
import { exact, quietLogger, withTz } from './differential-util.mts'

// each case sweeps hundreds of inputs through a real vega View: slower than a unit test, more so under a parallel run
vi.setConfig({ testTimeout: 60_000 })

const runtime: ExpressionRuntime = {
  scale: () => undefined,
  data: () => [],
  expr: (e: string) => compileExpr(e, runtime),
}

const NAMES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] as const
const spec = (code: string): vega.Spec => ({
  signals: [...NAMES.map((name) => ({ name, value: null })), { name: 'out', update: code }],
})

async function viaVega(code: string, args: unknown[]): Promise<unknown> {
  const errors: unknown[][] = []
  const view = new vega.View(vega.parse(spec(code)), { logger: quietLogger(errors) as never })
  args.forEach((v, i) => view.signal(NAMES[i]!, v))
  await view.runAsync()
  if (errors.length) return { $: 'throw' }
  return exact(() => view.signal('out'))
}
function viaAster(code: string, args: unknown[]): unknown {
  const params: Record<string, unknown> = {}
  args.forEach((v, i) => { params[NAMES[i]!] = v })
  const got = exact(() => compileExpr(code, runtime)(undefined, params)) as { $?: string } | null
  // the dataflow logs an operator error and keeps going; only that a call threw is compared
  return got?.$ === 'throw' ? { $: 'throw' } : got
}
const call = (fn: string, n: number) => `${fn}(${NAMES.slice(0, n).join(', ')})`

const TS = Date.UTC(2006, 0, 1)
const DATES: unknown[] = [
  null, undefined, '', 0, -0, 1, TS, 1.5e12, -1e15, 8.64e15, 8.64e15 + 1, NaN, Infinity,
  '2006-01-01', '2006-06-15T13:14:15.123Z', 'Jan 1, 2020', '2020/02/29', 'abc', ' 42 ', '1136073600000',
  true, false, [TS], [1, 2], [], {}, { valueOf: () => TS },
  new Date(TS), new Date(2020, 1, 29, 23, 59, 59, 999), new Date(NaN),
]
const UNARY = [
  'time', 'timezoneoffset', 'toDate',
  'year', 'quarter', 'month', 'week', 'date', 'day', 'dayofyear', 'hours', 'minutes', 'seconds', 'milliseconds',
  'utcyear', 'utcquarter', 'utcmonth', 'utcweek', 'utcdate', 'utcday', 'utcdayofyear', 'utchours', 'utcminutes',
  'utcseconds', 'utcmilliseconds',
]
const UNITS = ['year', 'quarter', 'month', 'week', 'day', 'date', 'hours', 'minutes', 'seconds', 'milliseconds', 'bogus', null, undefined]
const DT_ARGS: unknown[][] = [
  [2006], [2006, 0], [2006, 11, 31], [2006, 5, 15, 13], [2006, 5, 15, 13, 14, 15, 16], [2006, 14, 40, 25, 61, 61, 1001],
  [99, 0, 1], [-1, 0, 1], [2006, null], [2006, undefined, 5], [null], [undefined], ['2006'], ['2006', '2', '3'],
  [NaN], [2006, NaN], [true, false], ['Jan 1, 2020'], ['2006-01-01'], [TS], [new Date(TS)], [2006, 0, 1, 0, 0, 0, 0, 99],
  [[2006]], [{}], [1e15],
]

describe('month/day name functions vs real vega (live)', () => {
  it('monthFormat, monthAbbrevFormat, dayFormat, dayAbbrevFormat', async () => {
    for (const fn of ['monthFormat', 'monthAbbrevFormat', 'dayFormat', 'dayAbbrevFormat']) {
      for (const v of [0, 1, 11, 12, -1, 6, 7, 1.5, NaN, null, undefined, '2', '', true, [3], {}, 31, 400]) {
        expect(viaAster(call(fn, 1), [v]), `${fn}(${String(v)})`).toEqual(await viaVega(call(fn, 1), [v]))
      }
    }
  })
})

describe('date expression functions vs real vega (live)', () => {
  for (const tz of ['UTC', 'America/Los_Angeles']) {
    describe(tz, () => {
      for (const fn of UNARY) {
        it(`${fn}(x)`, () => withTz(tz, async () => {
          for (const v of DATES) {
            expect(viaAster(call(fn, 1), [v]), `${fn}(${String(typeof v === 'object' ? JSON.stringify(v) : v)})`).toEqual(await viaVega(call(fn, 1), [v]))
          }
        }))
      }
      for (const fn of ['datetime', 'utc']) {
        it(`${fn}(...)`, () => withTz(tz, async () => {
          for (const args of DT_ARGS) {
            const code = call(fn, args.length)
            expect(viaAster(code, args), `${code} ${JSON.stringify(args)}`).toEqual(await viaVega(code, args))
          }
        }))
      }
      for (const fn of ['timeOffset', 'utcOffset']) {
        it(`${fn}(unit, x, step)`, () => withTz(tz, async () => {
          for (const unit of UNITS) for (const v of [TS, new Date(2020, 1, 29, 23, 59), null, undefined, '2006-01-01', NaN, 'abc']) {
            for (const step of [undefined, 1, -2, 0, 1.5, null, '2']) {
              const args = step === undefined ? [unit, v] : [unit, v, step]
              const code = call(fn, args.length)
              expect(viaAster(code, args), `${code} ${String(unit)} ${String(v)} ${String(step)}`).toEqual(await viaVega(code, args))
            }
          }
        }))
      }
      for (const fn of ['timeSequence', 'utcSequence']) {
        it(`${fn}(unit, a, b, step)`, () => withTz(tz, async () => {
          const ends: Array<[unknown, unknown]> = [
            [TS, Date.UTC(2006, 5, 1)], [new Date(2006, 0, 1), new Date(2006, 2, 1)], [null, TS], [TS, undefined],
            [TS, TS], [Date.UTC(2006, 5, 1), TS], ['2006-01-01', '2006-04-01'],
          ]
          for (const unit of ['month', 'week', 'day', 'hours', 'year', 'bogus']) for (const [a, b] of ends) {
            for (const step of [undefined, 1, 2, 0, -1]) {
              const args = step === undefined ? [unit, a, b] : [unit, a, b, step]
              const code = call(fn, args.length)
              expect(viaAster(code, args), `${code} ${unit}`).toEqual(await viaVega(code, args))
            }
          }
        }))
      }
      for (const fn of ['timeParse', 'utcParse']) {
        it(`${fn}(x, spec)`, () => withTz(tz, async () => {
          for (const v of [null, undefined, '', '2006-01-02', '02/01/2006', 'x', 20060102, true, new Date(TS), [], '2006-13-45']) {
            for (const f of ['%Y-%m-%d', '%d/%m/%Y', '%Y%m%d', '%H', '']) {
              const code = call(fn, 2)
              expect(viaAster(code, [v, f]), `${code} ${String(v)} ${f}`).toEqual(await viaVega(code, [v, f]))
            }
          }
        }))
      }
      for (const fn of ['timeFormat', 'utcFormat', 'format']) {
        it(`${fn}(x, spec)`, () => withTz(tz, async () => {
          for (const v of DATES) for (const f of ['%Y-%m-%d', '%H:%M:%S.%L', '%b %e, %Y', '', ',.2f', 'bogus%', '$,d', undefined, null, 5, [], {}]) {
            const args = f === undefined ? [v] : [v, f]
            const code = call(fn, args.length)
            expect(viaAster(code, args), `${code} ${String(v)} ${String(f)}`).toEqual(await viaVega(code, args))
          }
        }))
      }
    })
  }
})
