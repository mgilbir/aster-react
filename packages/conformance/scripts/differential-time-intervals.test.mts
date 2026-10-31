/**
 * GENERATED live differential of calendar arithmetic: Aster's `time.ts` against the pinned d3-time and vega-time in
 * one process, in zones with and without daylight saving (UTC, America/New_York, Australia/Lord_Howe,
 * Pacific/Apia, Asia/Kolkata). Instants cluster around the zones' offset changes (found by scanning, see
 * `differential-zones.mts`) and the ends of the Date range.
 *
 * d3-time: every interval's floor / ceil / round / offset / range / count / every(k) / filter, with odd steps
 * (fractions, NaN, strings, negatives) and non-Date inputs. vega-time: timeUnits, timeUnitSpecifier, timeFloor and
 * utcFloor over generated unit lists and steps, timeInterval / timeOffset / timeSequence (and utc), dayofyear / week,
 * and timeBin (which lives in `transform-basic.ts`).
 */
import * as d3 from 'd3-time'
import * as vt from 'vega-time'
import { describe, expect, it, vi } from 'vitest'
import * as aster from '../../core/src/time.ts'
import { timeBin as asterTimeBin } from '../../core/src/transform-basic.ts'
import { compareCases, makeRng, scaled, type Rng } from './differential-gen.mts'
import { withTz } from './differential-util.mts'
import { ZONES, genInstant, offsetChanges } from './differential-zones.mts'

vi.setConfig({ testTimeout: 120_000 })

type AnyInterval = {
  (d?: unknown): Date
  floor(d: unknown): Date
  ceil(d: unknown): Date
  round(d: unknown): Date
  offset(d: unknown, step?: unknown): Date
  range(a: unknown, b: unknown, step?: unknown): Date[]
  count?(a: unknown, b: unknown): number
  every?(k: unknown): AnyInterval | null
  filter(test: (d: Date) => boolean): AnyInterval
}

const SEC = 1000
const MIN = 60 * SEC
const HOUR = 60 * MIN
const DAY = 24 * HOUR

interface Pair { name: string; oracle: AnyInterval; aster: AnyInterval; unit: number; test: (d: Date) => boolean }

const PAIRS: Pair[] = [
  { name: 'timeMillisecond', oracle: d3.timeMillisecond as never, aster: aster.millisecond as never, unit: 1, test: (d) => d.getMilliseconds() % 7 === 0 },
  { name: 'utcMillisecond', oracle: d3.utcMillisecond as never, aster: aster.millisecond as never, unit: 1, test: (d) => d.getUTCMilliseconds() % 5 === 0 },
  { name: 'timeSecond', oracle: d3.timeSecond as never, aster: aster.second as never, unit: SEC, test: (d) => d.getSeconds() % 5 === 0 },
  { name: 'utcSecond', oracle: d3.utcSecond as never, aster: aster.second as never, unit: SEC, test: (d) => d.getUTCSeconds() % 7 === 0 },
  { name: 'timeMinute', oracle: d3.timeMinute as never, aster: aster.timeMinute as never, unit: MIN, test: (d) => d.getMinutes() % 4 === 0 },
  { name: 'utcMinute', oracle: d3.utcMinute as never, aster: aster.utcMinute as never, unit: MIN, test: (d) => d.getUTCMinutes() % 3 === 0 },
  { name: 'timeHour', oracle: d3.timeHour as never, aster: aster.timeHour as never, unit: HOUR, test: (d) => d.getHours() % 3 === 0 },
  { name: 'utcHour', oracle: d3.utcHour as never, aster: aster.utcHour as never, unit: HOUR, test: (d) => d.getUTCHours() % 5 === 0 },
  { name: 'timeDay', oracle: d3.timeDay as never, aster: aster.timeDay as never, unit: DAY, test: (d) => d.getDate() % 2 === 0 },
  { name: 'utcDay', oracle: d3.utcDay as never, aster: aster.utcDay as never, unit: DAY, test: (d) => d.getUTCDate() % 3 === 0 },
  { name: 'unixDay', oracle: d3.unixDay as never, aster: aster.unixDay as never, unit: DAY, test: (d) => d.getUTCDate() % 2 === 1 },
  ...(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const).flatMap((day) => [
    { name: `time${day}`, oracle: (d3 as never)[`time${day}`] as AnyInterval, aster: (aster as never)[`time${day}`] as AnyInterval, unit: 7 * DAY, test: (d: Date) => d.getDate() % 2 === 0 },
    { name: `utc${day}`, oracle: (d3 as never)[`utc${day}`] as AnyInterval, aster: (aster as never)[`utc${day}`] as AnyInterval, unit: 7 * DAY, test: (d: Date) => d.getUTCDate() % 3 !== 1 },
  ]),
  { name: 'timeWeek', oracle: d3.timeWeek as never, aster: aster.timeWeek as never, unit: 7 * DAY, test: (d) => d.getDate() % 2 === 0 },
  { name: 'utcWeek', oracle: d3.utcWeek as never, aster: aster.utcWeek as never, unit: 7 * DAY, test: (d) => d.getUTCDate() % 2 === 0 },
  { name: 'timeMonth', oracle: d3.timeMonth as never, aster: aster.timeMonth as never, unit: 30 * DAY, test: (d) => d.getMonth() % 2 === 0 },
  { name: 'utcMonth', oracle: d3.utcMonth as never, aster: aster.utcMonth as never, unit: 30 * DAY, test: (d) => d.getUTCMonth() % 3 === 1 },
  { name: 'timeYear', oracle: d3.timeYear as never, aster: aster.timeYear as never, unit: 365 * DAY, test: (d) => d.getFullYear() % 2 === 0 },
  { name: 'utcYear', oracle: d3.utcYear as never, aster: aster.utcYear as never, unit: 365 * DAY, test: (d) => d.getUTCFullYear() % 4 === 0 },
]

const STEPS: unknown[] = [undefined, null, 0, 1, -1, 2, 3, 5, -7, 12, 1.7, -1.2, 0.5, NaN, Infinity, -Infinity, 100, '3', '', true, [2]]
const EVERY: unknown[] = [undefined, null, 0, 1, 2, 3, 4, 5, 6, 7, 10, 12, 15, 20, 24, 30, 60, 100, -1, 1.5, 2.9, NaN, Infinity, '2', '7', []]

/**
 * An instant a filtered interval can step back from. `filter` searches backwards one millisecond at a time until the
 * test holds, and an invalid date never satisfies a test, so near the ends of the Date range the search does not end
 * (in d3-time as well); those instants are left out of the filter and every(k) cases.
 */
function genWalkableInstant(r: Rng, changes: readonly number[]): number {
  for (;;) {
    const t = genInstant(r, changes)
    if (Number.isFinite(t) && Math.abs(t) < 3e14) return t
  }
}

/** A date-or-number input as the interval methods accept it. */
function asInput(r: Rng, t: number, bounded: boolean): unknown {
  // null and true read as the epoch: fine for one date, but a range from there to now is millions of entries
  return r.chance(0.7) ? new Date(t) : r.chance(0.9) ? t : r.pick<unknown>(bounded ? [String(t), undefined, [t]] : [String(t), null, undefined, true, [t]])
}

const instants = (iv: AnyInterval, ...ts: unknown[]) => ts.map((t) => (t == null ? t : iv.floor(t)))
void instants

function runDerived(iv: AnyInterval, ts: number[], extra: unknown): unknown {
  const [t0, t1] = ts as [number, number]
  return [
    iv.floor(new Date(t0)), iv.ceil(new Date(t0)), iv.round(new Date(t0)),
    iv.offset(new Date(t0), extra), iv.offset(new Date(t0), -2),
    iv.range(new Date(t0), new Date(t1)),
    iv.count ? iv.count(new Date(t0), new Date(t1)) : 'no count',
    typeof iv.every,
    typeof iv.count,
    Object.keys(iv).sort(),
  ]
}

describe('d3-time intervals vs d3-time (generated, live)', () => {
  for (const tz of ZONES) {
    describe(tz, () => {
      it('floor, ceil, round, offset, range and count of every interval', async () => {
        await withTz(tz, () => {
          const changes = offsetChanges(tz)
          const r = makeRng(0x1a01)
          compareCases(`intervals ${tz}`, scaled(14000), () => {
            const p = r.pick(PAIRS)
            const t = genInstant(r, changes)
            const span = p.unit * r.between(0, r.chance(0.3) ? 400 : 60) + r.int(Math.max(1, p.unit))
            const op = r.int(6)
            // a range is materialised: only the operations that do not build one may span the whole Date range
            const unbounded = (op === 0 || op === 1 || op === 3 || op === 4) && r.chance(0.1)
            const t2 = unbounded ? genInstant(r, changes) : t + (r.chance(0.15) ? -span : span)
            const step = r.pick(STEPS)
            const rangeStep = r.chance(0.5) ? undefined : r.pick(STEPS)
            const a = asInput(r, t, op === 2)
            const b = asInput(r, t2, op === 2)
            const run = (iv: AnyInterval): unknown => {
              switch (op) {
                case 0: return [iv.floor(a), iv.ceil(a), iv.round(a), typeof iv.floor(a)]
                case 1: { const d = new Date(t); const out = iv.offset(d, step); return [out, d.getTime(), out === d] }
                case 2: return iv.range(a, b, rangeStep as number)
                case 3: return iv.count ? [iv.count(a, b), iv.count(b, a)] : 'no count'
                case 4: return iv(new Date(t))
                default: return runDerived(iv, [t, t2], step)
              }
            }
            return {
              label: `${p.name} op ${op} ${new Date(t).getTime()} -> ${t2} step=${String(step)} rangeStep=${String(rangeStep)} input=${String(a)}`,
              oracle: () => run(p.oracle),
              aster: () => run(p.aster),
            }
          })
        })
      })

      it('every(k), and the intervals it returns', async () => {
        await withTz(tz, () => {
          const changes = offsetChanges(tz)
          const r = makeRng(0x1a02)
          compareCases(`every ${tz}`, scaled(6000), () => {
            const p = r.pick(PAIRS)
            const k = r.pick(EVERY)
            const t = genWalkableInstant(r, changes)
            const t2 = t + p.unit * r.between(0, 70)
            const run = (iv: AnyInterval): unknown => {
              const e = iv.every?.(k)
              if (!e) return e === undefined ? 'no every' : e
              return [
                e === iv, e.floor(new Date(t)), e.ceil(new Date(t)), e.round(new Date(t)), e.offset(new Date(t), 1), e.offset(new Date(t), -2),
                e.range(new Date(t), new Date(t2)), e.count ? e.count(new Date(t), new Date(t2)) : 'no count', typeof e.every,
                e.every ? (e.every(2) === e) : 'none',
              ]
            }
            return { label: `${p.name} every(${String(k)}) ${t} -> ${t2}`, oracle: () => run(p.oracle), aster: () => run(p.aster) }
          })
        })
      })

      it('filter(test), and the intervals it returns', async () => {
        await withTz(tz, () => {
          const changes = offsetChanges(tz)
          const r = makeRng(0x1a03)
          compareCases(`filter ${tz}`, scaled(5000), () => {
            const p = r.pick(PAIRS)
            const t = genWalkableInstant(r, changes)
            const t2 = t + p.unit * r.between(0, 40)
            const step = r.pick([undefined, 1, 2, -1, -3, 0, 1.7, NaN, 4])
            const run = (iv: AnyInterval): unknown => {
              const f = iv.filter(p.test)
              return [f.floor(new Date(t)), f.ceil(new Date(t)), f.round(new Date(t)), f.offset(new Date(t), step), f.range(new Date(t), new Date(t2)),
                typeof f.count, typeof f.every, Object.keys(f).sort()]
            }
            return { label: `${p.name} filter ${t} -> ${t2} step=${String(step)}`, oracle: () => run(p.oracle), aster: () => run(p.aster) }
          })
        })
      })
    })
  }

  it('has the same public shape: the same methods, and no count on the intervals that never had one', () => {
    for (const p of PAIRS) {
      expect(Object.keys(p.aster).sort(), p.name).toEqual(Object.keys(p.oracle).sort())
      expect(typeof p.aster.every, p.name).toBe(typeof p.oracle.every)
      expect(typeof p.aster.count, p.name).toBe(typeof p.oracle.count)
    }
  })

  it('the interval called with no argument is "now", floored', () => {
    for (const p of PAIRS) {
      const before = +p.oracle()
      const got = +p.aster()
      expect(Math.abs(got - before), p.name).toBeLessThanOrEqual(p.unit * 1.01 + 5000)
    }
  })

  it('interval durations', () => {
    expect([aster.durationSecond, aster.durationMinute, aster.durationHour, aster.durationDay, aster.durationWeek, aster.durationMonth, aster.durationYear])
      .toEqual([d3.timeSecond.every(1) && 1000, 60_000, 3_600_000, 86_400_000, 604_800_000, 2_592_000_000, 31_536_000_000])
  })
})

// --- vega-time ---------------------------------------------------------------

const UNIT_NAMES = ['year', 'quarter', 'month', 'week', 'date', 'day', 'dayofyear', 'hours', 'minutes', 'seconds', 'milliseconds']
const JUNK_UNITS: unknown[] = ['foo', '', 'Year', 'constructor', '__proto__', 'toString', 5, null, undefined, true]

/** A unit list that is mostly valid: one calendar family, plus the clock units, in any order. */
function genUnits(r: Rng): unknown {
  const k = r.int(20)
  if (k === 0) return r.pick<unknown>(['year', 'week', 'hours', '', null, undefined, [], 'foo', 7, 'month', 'dayofyear'])
  if (k === 1) return Array.from({ length: r.between(0, 4) }, () => (r.chance(0.8) ? r.pick(UNIT_NAMES) : r.pick(JUNK_UNITS)))
  const family = r.pick([['week', 'day'], ['week'], ['day'], ['quarter', 'month', 'date'], ['month'], ['quarter'], ['date'], ['month', 'date'], ['dayofyear'], []])
  const units: string[] = []
  if (r.chance(0.7)) units.push('year')
  for (const u of family) if (r.chance(0.8)) units.push(u)
  for (const u of ['hours', 'minutes', 'seconds', 'milliseconds']) if (r.chance(0.35)) units.push(u)
  if (!units.length) units.push(r.pick(UNIT_NAMES))
  if (r.chance(0.15)) units.reverse()
  if (r.chance(0.05)) units.push(r.pick(UNIT_NAMES))
  return units
}

/** About how long one of each unit is, to keep the generated sequences to a few dozen entries. */
const UNIT_MS: Record<string, number> = {
  year: 365 * DAY, quarter: 91 * DAY, month: 30 * DAY, week: 7 * DAY, date: DAY, day: DAY, dayofyear: DAY,
  hours: HOUR, minutes: MIN, seconds: SEC, milliseconds: 1,
}

const FLOOR_STEPS: unknown[] = [undefined, undefined, 1, 2, 3, 4, 5, 6, 7, 10, 12, 15, 30, 0, NaN, -1, 1.5, '2', null, 13]

describe('vega-time vs the pinned vega-time (generated, live)', () => {
  it('timeUnits and timeUnitSpecifier: validation, ordering, error messages', () => {
    const r = makeRng(0x1b01)
    compareCases('timeUnits', scaled(5000), () => {
      const units = genUnits(r)
      const specs = r.chance(0.6) ? undefined : Object.fromEntries(Array.from({ length: r.between(0, 4) }, () => [r.pick([...UNIT_NAMES, 'year-month', 'hours-minutes', 'year-month-date', 'month-date', 'year-quarter', 'minutes-seconds']), r.pick<unknown>(['%x', '', '%b %d', 'Z ', 5])]))
      return {
        label: `${JSON.stringify(units)} ${JSON.stringify(specs)}`,
        oracle: () => [vt.timeUnits(units), vt.timeUnitSpecifier(units as never, specs as never)],
        aster: () => [aster.timeUnits(units), aster.timeUnitSpecifier(units, specs)],
      }
    })
    expect(aster.TIME_UNITS).toEqual(vt.TIME_UNITS)
    for (const k of ['YEAR', 'QUARTER', 'MONTH', 'WEEK', 'DATE', 'DAY', 'DAYOFYEAR', 'HOURS', 'MINUTES', 'SECONDS', 'MILLISECONDS'] as const) {
      expect(aster[k], k).toBe(vt[k])
    }
  })

  for (const tz of ZONES) {
    describe(tz, () => {
      it('timeFloor and utcFloor over generated unit lists and steps', async () => {
        await withTz(tz, () => {
          const changes = offsetChanges(tz)
          const r = makeRng(0x1b02)
          const stats = compareCases(`floor ${tz}`, scaled(9000), () => {
            const raw = genUnits(r)
            // most of the time the units are validated first, as the timeunit transform does
            let units: string[] = []
            let invalid = false
            try { units = vt.timeUnits(raw) } catch { invalid = true; units = Array.isArray(raw) ? (raw as string[]) : [] }
            const step = r.pick(FLOOR_STEPS)
            const values = Array.from({ length: 4 }, () => genInstant(r, changes))
            const v = values.map((t) => (r.chance(0.85) ? new Date(t) : t))
            return {
              label: `${JSON.stringify(units)}${invalid ? ' (unvalidated)' : ''} step=${String(step)} ${values.join(',')}`,
              oracle: () => [vt.timeFloor(units, step as number), vt.utcFloor(units, step as number)].map((f) => v.map((x) => f(x))),
              aster: () => [aster.timeFloor(units, step as number), aster.utcFloor(units, step as number)].map((f) => v.map((x) => f(x))),
            }
          })
          expect(stats.informative).toBeGreaterThan(stats.cases * 0.5)
        })
      })

      it('timeInterval / utcInterval units, timeOffset, timeSequence (and utc)', async () => {
        await withTz(tz, () => {
          const changes = offsetChanges(tz)
          const r = makeRng(0x1b03)
          compareCases(`offset/sequence ${tz}`, scaled(5000), () => {
            const unit = r.chance(0.9) ? r.pick(UNIT_NAMES) : String(r.pick(['foo', '', 'YEAR', 5 as never, null as never, undefined as never]))
            const t = genWalkableInstant(r, changes)
            const t2 = t + r.between(0, 40) * (UNIT_MS[unit] ?? DAY)
            // the quarter is a filtered interval, and a filter steps one match at a time: an infinite step never ends
            const step = unit === 'quarter' ? r.pick(STEPS.filter((x) => typeof x !== 'number' || Number.isFinite(x))) : r.pick(STEPS)
            const date: unknown = r.chance(0.8) ? new Date(t) : t
            const run = (api: { timeOffset: Function; utcOffset: Function; timeSequence: Function; utcSequence: Function }) => [
              api.timeOffset(unit, date, step), api.utcOffset(unit, date, step),
              api.timeSequence(unit, new Date(t), new Date(t2), step), api.utcSequence(unit, new Date(t), new Date(t2), step),
              api.timeSequence(unit, t, t2), api.utcSequence(unit, t, t2),
            ]
            return { label: `${String(unit)} ${t}..${t2} step=${String(step)}`, oracle: () => run(vt as never), aster: () => run(aster as never) }
          })
        })
      })

      it('timeInterval / utcInterval resolve to intervals that behave alike', async () => {
        await withTz(tz, () => {
          const changes = offsetChanges(tz)
          const r = makeRng(0x1b04)
          for (const unit of UNIT_NAMES) {
            for (const [o, a] of [[vt.timeInterval(unit), aster.timeIntervalFor(unit)], [vt.utcInterval(unit), aster.utcIntervalFor(unit)]] as const) {
              expect(a, unit).toBeDefined()
              for (let i = 0; i < 40; i++) {
                const t = genWalkableInstant(r, changes)
                const run = (iv: AnyInterval) => [iv.floor(new Date(t)), iv.ceil(new Date(t)), iv.offset(new Date(t), 2), iv.count?.(new Date(t), new Date(t + 400 * DAY))]
                expect(JSON.stringify(run(a as never)), `${unit} ${t}`).toBe(JSON.stringify(run(o as never)))
              }
            }
          }
          for (const junk of ['foo', '', 'Year', 'YEAR', ' year']) {
            expect(vt.timeInterval(junk), junk).toBeUndefined()
            expect(aster.timeIntervalFor(junk), junk).toBeUndefined()
            expect(aster.utcIntervalFor(junk), junk).toBeUndefined()
          }
        })
      })

      it('dayofyear, week, utcdayofyear, utcweek', async () => {
        await withTz(tz, () => {
          const changes = offsetChanges(tz)
          const r = makeRng(0x1b05)
          compareCases(`dayofyear/week ${tz}`, scaled(5000), () => {
            const t = genInstant(r, changes)
            const x: unknown = r.chance(0.7) ? new Date(t) : r.chance(0.8) ? t : r.pick<unknown>([String(t), 'Jan 1, 2020', null, undefined, '', true, [t], {}])
            return {
              label: `${String(x)}`,
              oracle: () => [vt.dayofyear(x), vt.week(x), vt.utcdayofyear(x), vt.utcweek(x)],
              aster: () => [aster.dayofyear(x), aster.week(x), aster.utcdayofyear(x), aster.utcweek(x)],
            }
          })
        })
      })
    })
  }

  it('inherited keys are not units: the sandbox refuses what vega-time would hand back as an Object method', () => {
    // vega-time indexes a plain object, so `timeInterval('constructor')` is `Object`. Aster only reads own keys.
    for (const key of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(aster.timeIntervalFor(key), key).toBeUndefined()
      expect(aster.utcIntervalFor(key), key).toBeUndefined()
      expect(aster.timeOffset(key, new Date(0), 1), key).toBeUndefined()
      expect(aster.timeSequence(key, 0, 10), key).toBeUndefined()
    }
  })

  it('timeBin picks the same units and step (finite extents)', () => {
    const r = makeRng(0x1b06)
    compareCases('timeBin', scaled(6000), () => {
      const a = r.pick([0, 1.2e12, -3e12, 1.7e12, 8.64e15 - 1e13, 1]) + r.int(1e6)
      const span = r.pick([0, 1, 30, 1000, 45 * SEC, 8 * MIN, 5 * HOUR, 3 * DAY, 20 * DAY, 100 * DAY, 400 * DAY, 3000 * DAY, 1e5 * DAY, 3e9, 1e13])
      const sign = r.pick([1, 1, 1, -1])
      const b = a + sign * span * r.pick([1, 1, 1.5, 0.37])
      const maxbins = r.pick([undefined, undefined, 0, 1, 2, 5, 10, 20, 40, 100, 1000, NaN, -5, 2.5])
      return {
        label: `[${a}, ${b}] maxbins=${String(maxbins)}`,
        oracle: () => vt.timeBin({ extent: [a, b], maxbins } as never),
        aster: () => asterTimeBin([a, b], maxbins),
      }
    })
  })

  // vega-time reads the span of the extent as `(last - first) || 0`: an end that is not a number, or two ends whose difference
  // is NaN (Infinity - Infinity), is a zero span, which picks the milliseconds grain.
  it('timeBin picks the same units and step for extents that are not finite numbers', () => {
    const r = makeRng(0x1b07)
    const ends: unknown[] = [NaN, Infinity, -Infinity, undefined, null, '', 'abc', '1e12', new Date(1.5e12), new Date(NaN), true, 0, 1.2e12, -4e11, [3]]
    compareCases('timeBin non-finite', scaled(3000), () => {
      const a = r.pick(ends)
      const b = r.pick(ends)
      const maxbins = r.pick([undefined, 0, 1, 5, 40, 1000, NaN])
      return {
        label: `[${String(a)}, ${String(b)}] maxbins=${String(maxbins)}`,
        oracle: () => vt.timeBin({ extent: [a, b], maxbins } as never),
        aster: () => asterTimeBin([a, b] as never, maxbins),
      }
    })
  })
})
