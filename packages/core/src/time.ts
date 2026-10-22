/**
 * Calendar arithmetic: the d3-time interval engine and the vega-time unit
 * layer on top of it (units, floors, offsets, sequences, specifiers).
 *
 * A faithful port of both, pinned by oracle vectors recorded from the pinned
 * packages (`testdata/vectors/d3-time.json`, `vega-time.json`), including
 * daylight-saving cases recorded under a DST-observing zone — the replay
 * switches `process.env.TZ` per suite the same way the generator pinned it.
 *
 * The quirks that are upstream's and therefore ours:
 * - `interval.offset` mutates the date it is given and returns it;
 * - `timeDay` counts compensate for the local zone's DST shifts;
 * - `splitAccessPath`-style surprises do not exist here, but
 *   `vega-time/util.utcDate` has a real bug upstream (`date.setUTCFullYear(d.y)`
 *   on a number) — reproduced verbatim, and pinned by vectors, because the
 *   two-argument form is what callers hit, not that branch.
 */

import { array, constant, error, extend, hasOwnProperty, ownGet, peek, toSet } from './util.js'
import { activeMeter } from './limits.js'

// --- durations ---------------------------------------------------------------

export const durationSecond = 1000
export const durationMinute = durationSecond * 60
export const durationHour = durationMinute * 60
export const durationDay = durationHour * 24
export const durationWeek = durationDay * 7
export const durationMonth = durationDay * 30
export const durationYear = durationDay * 365

// --- interval factory (d3-time's timeInterval) --------------------------------

export interface TimeInterval {
  (date?: unknown): Date
  floor(date: Date): Date
  ceil(date: Date): Date
  round(date: Date): Date
  offset(date: Date, step?: number): Date
  range(start: unknown, stop: unknown, step?: number): Date[]
  filter(test: (date: Date) => boolean): TimeInterval
  count?(start: unknown, end: unknown): number
  every?(step: number): TimeInterval | null
}

type DateMutator = (date: Date, step?: number) => void

const t0 = new Date()
const t1 = new Date()

/**
 * The interval factory: `floori` snaps a date down, `offseti` moves it by
 * `step` units, and `count`/`field` back `count()` and `every()`.
 */
export function timeInterval(
  floori: DateMutator,
  offseti: DateMutator,
  count?: (start: Date, end: Date) => number,
  field?: (date: Date) => number,
): TimeInterval {
  function interval(date?: unknown): Date {
    return floori(date = arguments.length === 0 ? new Date() : new Date(+(date as Date))), date as Date
  }
  interval.floor = (date: Date) => {
    return floori(date = new Date(+date)), date
  }
  interval.ceil = (date: Date) => {
    return floori(date = new Date(+(date as Date) - 1)), offseti(date, 1), floori(date), date
  }
  interval.round = (date: Date) => {
    const d0 = interval(date)
    const d1 = interval.ceil(date)
    return +(date as Date) - +d0 < +d1 - +(date as Date) ? d0 : d1
  }
  interval.offset = (date: Date, step?: number) => {
    return offseti(date = new Date(+date), step == null ? 1 : Math.floor(step)), date
  }
  interval.range = (start: unknown, stop: unknown, step?: number) => {
    const range: Date[] = []
    start = interval.ceil(start as Date)
    step = step == null ? 1 : Math.floor(step)
    if (!(+(start as Date) < +(stop as Date)) || !(step > 0)) return range // also handles Invalid Date
    let previous: Date
    // Deviation (safety): under limits the tick count is bounded while the range
    // is generated; a 1 ms interval over decades would otherwise allocate forever.
    const meter = activeMeter()
    do {
      range.push(previous = new Date(+(start as Date))), offseti(start as Date, step), floori(start as Date)
      if (meter && (range.length & 1023) === 0) meter.items(range.length, 'time ticks')
    }
    while (previous < (start as Date) && (start as Date) < (stop as Date))
    return range
  }
  interval.filter = (test: (date: Date) => boolean): TimeInterval => {
    return timeInterval((date) => {
      if (date >= date) while (floori(date), !test(date)) date.setTime(+date - 1)
    }, (date, step) => {
      if (date >= date) {
        if ((step ?? 0) < 0) while (++step! <= 0) {
          while (offseti(date, -1), !test(date)) { /* step backwards to a match */ }
        } else while (--step! >= 0) {
          while (offseti(date, +1), !test(date)) { /* step forwards to a match */ }
        }
      }
    })
  }
  if (count) {
    interval.count = (start: unknown, end: unknown) => {
      t0.setTime(+(start as Date))
      t1.setTime(+(end as Date))
      floori(t0)
      floori(t1)
      return Math.floor(count(t0, t1))
    }
    interval.every = (step: number) => {
      step = Math.floor(step)
      return !isFinite(step) || !(step > 0) ? null
        : !(step > 1) ? interval
        : interval.filter(field
            ? (d) => field(d) % step === 0
            : (d) => interval.count!(0, d) % step === 0)
    }
  }
  return interval as TimeInterval
}

// --- the calendar intervals (d3-time) ----------------------------------------

export const millisecond = timeInterval(() => {
  // noop
}, (date, step) => {
  date.setTime(+date + (step as number))
}, (start, end) => {
  return +end - +start
})
// An optimized implementation for this simple case.
millisecond.every = (k: number) => {
  k = Math.floor(k)
  if (!isFinite(k) || !(k > 0)) return null
  if (!(k > 1)) return millisecond
  return timeInterval((date) => {
    date.setTime(Math.floor(+date / k) * k)
  }, (date, step) => {
    date.setTime(+date + (step as number) * k)
  }, (start, end) => {
    return (+end - +start) / k
  })
}
export const milliseconds = millisecond.range

export const second = timeInterval((date) => {
  date.setTime(+date - date.getMilliseconds())
}, (date, step) => {
  date.setTime(+date + (step as number) * durationSecond)
}, (start, end) => {
  return (+end - +start) / durationSecond
}, (date) => {
  return date.getUTCSeconds()
})
export const seconds = second.range

export const timeMinute = timeInterval((date) => {
  date.setTime(+date - date.getMilliseconds() - date.getSeconds() * durationSecond)
}, (date, step) => {
  date.setTime(+date + (step as number) * durationMinute)
}, (start, end) => {
  return (+end - +start) / durationMinute
}, (date) => {
  return date.getMinutes()
})
export const timeMinutes = timeMinute.range

export const utcMinute = timeInterval((date) => {
  date.setUTCSeconds(0, 0)
}, (date, step) => {
  date.setTime(+date + (step as number) * durationMinute)
}, (start, end) => {
  return (+end - +start) / durationMinute
}, (date) => {
  return date.getUTCMinutes()
})
export const utcMinutes = utcMinute.range

export const timeHour = timeInterval((date) => {
  date.setTime(+date - date.getMilliseconds() - date.getSeconds() * durationSecond - date.getMinutes() * durationMinute)
}, (date, step) => {
  date.setTime(+date + (step as number) * durationHour)
}, (start, end) => {
  return (+end - +start) / durationHour
}, (date) => {
  return date.getHours()
})
export const timeHours = timeHour.range

export const utcHour = timeInterval((date) => {
  date.setUTCMinutes(0, 0, 0)
}, (date, step) => {
  date.setTime(+date + (step as number) * durationHour)
}, (start, end) => {
  return (+end - +start) / durationHour
}, (date) => {
  return date.getUTCHours()
})
export const utcHours = utcHour.range

export const timeDay = timeInterval(
  (date) => date.setHours(0, 0, 0, 0),
  (date, step) => date.setDate(date.getDate() + (step as number)),
  (start, end) => (+end - +start - (end.getTimezoneOffset() - start.getTimezoneOffset()) * durationMinute) / durationDay,
  (date) => date.getDate() - 1,
)
export const timeDays = timeDay.range

export const utcDay = timeInterval((date) => {
  date.setUTCHours(0, 0, 0, 0)
}, (date, step) => {
  date.setUTCDate(date.getUTCDate() + (step as number))
}, (start, end) => {
  return (+end - +start) / durationDay
}, (date) => {
  return date.getUTCDate() - 1
})
export const utcDays = utcDay.range

export const unixDay = timeInterval((date) => {
  date.setUTCHours(0, 0, 0, 0)
}, (date, step) => {
  date.setUTCDate(date.getUTCDate() + (step as number))
}, (start, end) => {
  return (+end - +start) / durationDay
}, (date) => {
  return Math.floor(+date / durationDay)
})
export const unixDays = unixDay.range

function timeWeekday(i: number): TimeInterval {
  return timeInterval((date) => {
    date.setDate(date.getDate() - (date.getDay() + 7 - i) % 7)
    date.setHours(0, 0, 0, 0)
  }, (date, step) => {
    date.setDate(date.getDate() + (step as number) * 7)
  }, (start, end) => {
    return (+end - +start - (end.getTimezoneOffset() - start.getTimezoneOffset()) * durationMinute) / durationWeek
  })
}
export const timeSunday = /* @__PURE__ */ timeWeekday(0)
export const timeMonday = /* @__PURE__ */ timeWeekday(1)
export const timeTuesday = /* @__PURE__ */ timeWeekday(2)
export const timeWednesday = /* @__PURE__ */ timeWeekday(3)
export const timeThursday = /* @__PURE__ */ timeWeekday(4)
export const timeFriday = /* @__PURE__ */ timeWeekday(5)
export const timeSaturday = /* @__PURE__ */ timeWeekday(6)
export const timeWeek = timeSunday
export const timeWeeks = timeWeek.range

function utcWeekday(i: number): TimeInterval {
  return timeInterval((date) => {
    date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 7 - i) % 7)
    date.setUTCHours(0, 0, 0, 0)
  }, (date, step) => {
    date.setUTCDate(date.getUTCDate() + (step as number) * 7)
  }, (start, end) => {
    return (+end - +start) / durationWeek
  })
}
export const utcSunday = /* @__PURE__ */ utcWeekday(0)
export const utcMonday = /* @__PURE__ */ utcWeekday(1)
export const utcTuesday = /* @__PURE__ */ utcWeekday(2)
export const utcWednesday = /* @__PURE__ */ utcWeekday(3)
export const utcThursday = /* @__PURE__ */ utcWeekday(4)
export const utcFriday = /* @__PURE__ */ utcWeekday(5)
export const utcSaturday = /* @__PURE__ */ utcWeekday(6)
export const utcWeek = utcSunday
export const utcWeeks = utcWeek.range

export const timeMonth = timeInterval((date) => {
  date.setDate(1)
  date.setHours(0, 0, 0, 0)
}, (date, step) => {
  date.setMonth(date.getMonth() + (step as number))
}, (start, end) => {
  return end.getMonth() - start.getMonth() + (end.getFullYear() - start.getFullYear()) * 12
}, (date) => {
  return date.getMonth()
})
export const timeMonths = timeMonth.range

export const utcMonth = timeInterval((date) => {
  date.setUTCDate(1)
  date.setUTCHours(0, 0, 0, 0)
}, (date, step) => {
  date.setUTCMonth(date.getUTCMonth() + (step as number))
}, (start, end) => {
  return end.getUTCMonth() - start.getUTCMonth() + (end.getUTCFullYear() - start.getUTCFullYear()) * 12
}, (date) => {
  return date.getUTCMonth()
})
export const utcMonths = utcMonth.range

export const timeYear = timeInterval((date) => {
  date.setMonth(0, 1)
  date.setHours(0, 0, 0, 0)
}, (date, step) => {
  date.setFullYear(date.getFullYear() + (step as number))
}, (start, end) => {
  return end.getFullYear() - start.getFullYear()
}, (date) => {
  return date.getFullYear()
})
export const timeYears = timeYear.range

export const utcYear = timeInterval((date) => {
  date.setUTCMonth(0, 1)
  date.setUTCHours(0, 0, 0, 0)
}, (date, step) => {
  date.setUTCFullYear(date.getUTCFullYear() + (step as number))
}, (start, end) => {
  return end.getUTCFullYear() - start.getUTCFullYear()
}, (date) => {
  return date.getUTCFullYear()
})
export const utcYears = utcYear.range

// --- vega-time: units --------------------------------------------------------

export const YEAR = 'year'
export const QUARTER = 'quarter'
export const MONTH = 'month'
export const WEEK = 'week'
export const DATE = 'date'
export const DAY = 'day'
export const DAYOFYEAR = 'dayofyear'
export const HOURS = 'hours'
export const MINUTES = 'minutes'
export const SECONDS = 'seconds'
export const MILLISECONDS = 'milliseconds'

export const TIME_UNITS = [
  YEAR, QUARTER, MONTH, WEEK, DATE, DAY, DAYOFYEAR, HOURS, MINUTES, SECONDS, MILLISECONDS,
] as const

const UNITS: Record<string, number> = TIME_UNITS.reduce((o: Record<string, number>, u, i) => (o[u] = 1 + i, o), {})

/** Validate and sort a unit list; throws on empty, unknown or incompatible units. */
export function timeUnits(units: unknown): string[] {
  const u = array(units).slice() as string[]
  const m: Record<string, number> = {}
  // check validity
  if (!u.length) error('Missing time unit.')
  u.forEach((unit) => {
    if (hasOwnProperty(UNITS, unit)) {
      m[unit] = 1
    } else {
      error(`Invalid time unit: ${unit}.`)
    }
  })
  const numTypes = (
    ((m[WEEK] || m[DAY]) ? 1 : 0) +
    ((m[QUARTER] || m[MONTH] || m[DATE]) ? 1 : 0) +
    (m[DAYOFYEAR] ? 1 : 0)
  )
  if (numTypes > 1) {
    error(`Incompatible time units: ${units}`)
  }
  // ensure proper sort order
  u.sort((a, b) => UNITS[a]! - UNITS[b]!)
  return u
}

const defaultSpecifiers: Record<string, string> = {
  [YEAR]: '%Y ',
  [QUARTER]: 'Q%q ',
  [MONTH]: '%b ',
  [DATE]: '%d ',
  [WEEK]: 'W%U ',
  [DAY]: '%a ',
  [DAYOFYEAR]: '%j ',
  [HOURS]: '%H:00',
  [MINUTES]: '00:%M',
  [SECONDS]: ':%S',
  [MILLISECONDS]: '.%L',
  [`${YEAR}-${MONTH}`]: '%Y-%m ',
  [`${YEAR}-${MONTH}-${DATE}`]: '%Y-%m-%d ',
  [`${HOURS}-${MINUTES}`]: '%H:%M',
}

/** Build the d3 time-format specifier that covers a unit list. */
export function timeUnitSpecifier(units: unknown, specifiers?: Record<string, string>): string {
  const s = extend({}, defaultSpecifiers, specifiers) as Record<string, string | undefined>
  const u = timeUnits(units)
  const n = u.length
  let fmt = ''
  for (let start = 0; start < n; ) {
    for (let end = u.length; end > start; --end) {
      const key = u.slice(start, end).join('-')
      if (s[key] != null) {
        fmt += s[key]
        start = end
        break
      }
    }
  }
  return fmt.trim()
}

// --- vega-time: date helpers -------------------------------------------------

const utilDate = new Date()

function localYear(y: number): Date {
  utilDate.setFullYear(y)
  utilDate.setMonth(0)
  utilDate.setDate(1)
  utilDate.setHours(0, 0, 0, 0)
  return utilDate
}

export function dayofyear(d: unknown): number {
  return localDayOfYear(new Date(d as string | number | Date))
}

export function week(d: unknown): number {
  return localWeekNum(new Date(d as string | number | Date))
}

export function localDayOfYear(d: Date): number {
  // count from Dec 31 of the previous year, so Jan 1 is day 1 (as upstream)
  return timeDay.count!(+localYear(d.getFullYear()) - 1 as unknown, d)
}

export function localWeekNum(d: Date): number {
  return timeWeek.count!(+localYear(d.getFullYear()) - 1 as unknown, d)
}

export function localFirst(y: number): number {
  return localYear(y).getDay()
}

export function localDate(y: number, m: number, d: number, H: number, M: number, S: number, L: number): Date {
  if (0 <= y && y < 100) {
    const date = new Date(-1, m, d, H, M, S, L)
    date.setFullYear(y)
    return date
  }
  return new Date(y, m, d, H, M, S, L)
}

export function utcdayofyear(d: unknown): number {
  return utcDayOfYear(new Date(d as string | number | Date))
}

export function utcweek(d: unknown): number {
  return utcWeekNum(new Date(d as string | number | Date))
}

export function utcDayOfYear(d: Date): number {
  const y = Date.UTC(d.getUTCFullYear(), 0, 1)
  return utcDay.count!(y - 1, d)
}

export function utcWeekNum(d: Date): number {
  const y = Date.UTC(d.getUTCFullYear(), 0, 1)
  return utcWeek.count!(y - 1, d)
}

export function utcFirst(y: number): number {
  utilDate.setTime(Date.UTC(y, 0, 1))
  return utilDate.getUTCDay()
}

export function utcDate(y: number, m: number, d: number, H: number, M: number, S: number, L: number): Date {
  if (0 <= y && y < 100) {
    const date = new Date(Date.UTC(-1, m, d, H, M, S, L))
    // Upstream reads `d.y` off the day number here — always undefined, so
    // setUTCFullYear(undefined) resets to the epoch year. Reproduced as-is;
    // the vectors pin it. Callers reach the general branch below.
    date.setUTCFullYear((d as unknown as { y?: number }).y as unknown as number)
    return date
  }
  return new Date(Date.UTC(y, m, d, H, M, S, L))
}

// --- vega-time: interval registry, offsets, sequences ------------------------

const timeIntervals: Record<string, TimeInterval> = {
  [YEAR]: timeYear,
  [QUARTER]: timeMonth.every!(3)!,
  [MONTH]: timeMonth,
  [WEEK]: timeWeek,
  [DATE]: timeDay,
  [DAY]: timeDay,
  [DAYOFYEAR]: timeDay,
  [HOURS]: timeHour,
  [MINUTES]: timeMinute,
  [SECONDS]: second as unknown as TimeInterval,
  [MILLISECONDS]: millisecond,
}

const utcIntervals: Record<string, TimeInterval> = {
  [YEAR]: utcYear,
  [QUARTER]: utcMonth.every!(3)!,
  [MONTH]: utcMonth,
  [WEEK]: utcWeek,
  [DATE]: utcDay,
  [DAY]: utcDay,
  [DAYOFYEAR]: utcDay,
  [HOURS]: utcHour,
  [MINUTES]: utcMinute,
  [SECONDS]: second as unknown as TimeInterval,
  [MILLISECONDS]: millisecond,
}

export function timeIntervalFor(unit: string): TimeInterval | undefined {
  return ownGet(timeIntervals, unit)
}

export function utcIntervalFor(unit: string): TimeInterval | undefined {
  return ownGet(utcIntervals, unit)
}

function offset(ival: TimeInterval | undefined, date: unknown, step: number): Date | undefined {
  // upstream passes the value through; `interval.offset` copies via `new Date(+date)`
  return ival ? ival.offset(date as Date, step) : undefined
}

export function timeOffset(unit: string, date: unknown, step: number): Date | undefined {
  return offset(timeIntervalFor(unit), date, step)
}

export function utcOffset(unit: string, date: unknown, step: number): Date | undefined {
  return offset(utcIntervalFor(unit), date, step)
}

function sequence(ival: TimeInterval | undefined, start: unknown, stop: unknown, step?: number): Date[] | undefined {
  return ival ? ival.range(start, stop, step) : undefined
}

export function timeSequence(unit: string, start: unknown, stop: unknown, step?: number): Date[] | undefined {
  return sequence(timeIntervalFor(unit), start, stop, step)
}

export function utcSequence(unit: string, start: unknown, stop: unknown, step?: number): Date[] | undefined {
  return sequence(utcIntervalFor(unit), start, stop, step)
}

// --- vega-time: floors -------------------------------------------------------

function floor(
  units: string[],
  step: number | undefined,
  get: Record<string, (...args: never[]) => unknown>,
  inv: Record<string, (...args: never[]) => unknown>,
  newDate: (y: number, m: number, d: number, H: number, M: number, S: number, L: number) => Date,
): (v: unknown) => Date {
  const s = step || 1
  const b = peek(units)
  const _ = (unit: string, p?: number, key?: string): ((d: Date, y?: number) => unknown) => {
    key = key || unit
    return getUnit(get[key] as never, inv[key] as never, unit === b ? s : undefined, p)
  }
  const t = new Date()
  const u = toSet(units)
  const y = u[YEAR] ? _(YEAR) : (constant(2012) as (d: Date, yr?: number) => unknown)
  const m = u[MONTH] ? _(MONTH)
    : u[QUARTER] ? _(QUARTER)
    : (constant(0) as (d: Date, yr?: number) => unknown)
  const d = u[WEEK] && u[DAY] ? _(DAY, 1, WEEK + DAY)
    : u[WEEK] ? _(WEEK, 1)
    : u[DAY] ? _(DAY, 1)
    : u[DATE] ? _(DATE, 1)
    : u[DAYOFYEAR] ? _(DAYOFYEAR, 1)
    : (constant(1) as (d: Date, yr?: number) => unknown)
  const H = u[HOURS] ? _(HOURS) : (constant(0) as (d: Date, yr?: number) => unknown)
  const M = u[MINUTES] ? _(MINUTES) : (constant(0) as (d: Date, yr?: number) => unknown)
  const S = u[SECONDS] ? _(SECONDS) : (constant(0) as (d: Date, yr?: number) => unknown)
  const L = u[MILLISECONDS] ? _(MILLISECONDS) : (constant(0) as (d: Date, yr?: number) => unknown)

  return function (v: unknown): Date {
    t.setTime(+(v as Date))
    const year = y(t) as number
    return newDate(year, m(t) as number, d(t, year) as number, H(t) as number, M(t) as number, S(t) as number, L(t) as number)
  }
}

function getUnit(
  f: (d: Date, y?: number) => unknown,
  inv: ((v: unknown, y?: number) => unknown) | undefined,
  step: number | undefined,
  phase: number | undefined,
): (d: Date, y?: number) => unknown {
  const u = (step ?? 1) <= 1 ? f
    : phase !== undefined ? (d: Date, y?: number) => phase! + step! * Math.floor(((f(d, y) as number) - phase!) / step!)
    : (d: Date, y?: number) => step! * Math.floor((f(d, y) as number) / step!)
  return inv ? (d: Date, y?: number) => inv(u(d, y), y) : u
}

// returns the day of the year based on week number, day of week,
// and the day of the week for the first day of the year
function weekday(weekNum: number, day: number, firstDay: number): number {
  return day + weekNum * 7 - (firstDay + 6) % 7
}

// -- LOCAL TIME --

const localGet: Record<string, (d: Date, y?: number) => unknown> = {
  [YEAR]: (d) => d.getFullYear(),
  [QUARTER]: (d) => Math.floor(d.getMonth() / 3),
  [MONTH]: (d) => d.getMonth(),
  [DATE]: (d) => d.getDate(),
  [HOURS]: (d) => d.getHours(),
  [MINUTES]: (d) => d.getMinutes(),
  [SECONDS]: (d) => d.getSeconds(),
  [MILLISECONDS]: (d) => d.getMilliseconds(),
  [DAYOFYEAR]: (d) => localDayOfYear(d),
  [WEEK]: (d) => localWeekNum(d),
  [WEEK + DAY]: (d, y) => weekday(localWeekNum(d), d.getDay(), localFirst(y as number)),
  [DAY]: (d, y) => weekday(1, d.getDay(), localFirst(y as number)),
}

const localInv: Record<string, (...args: never[]) => unknown> = {
  [QUARTER]: ((q: unknown) => 3 * (q as number)) as never,
  [WEEK]: ((w: unknown, y?: unknown) => weekday(w as number, 0, localFirst(y as number))) as never,
}

export function timeFloor(units: string[], step?: number): (v: unknown) => Date {
  return floor(units, step, localGet, localInv, localDate)
}

// -- UTC TIME --

const utcGet: Record<string, (d: Date, y?: number) => unknown> = {
  [YEAR]: (d) => d.getUTCFullYear(),
  [QUARTER]: (d) => Math.floor(d.getUTCMonth() / 3),
  [MONTH]: (d) => d.getUTCMonth(),
  [DATE]: (d) => d.getUTCDate(),
  [HOURS]: (d) => d.getUTCHours(),
  [MINUTES]: (d) => d.getUTCMinutes(),
  [SECONDS]: (d) => d.getUTCSeconds(),
  [MILLISECONDS]: (d) => d.getUTCMilliseconds(),
  [DAYOFYEAR]: (d) => utcDayOfYear(d),
  [WEEK]: (d) => utcWeekNum(d),
  [DAY]: (d, y) => weekday(1, d.getUTCDay(), utcFirst(y as number)),
  [WEEK + DAY]: (d, y) => weekday(utcWeekNum(d), d.getUTCDay(), utcFirst(y as number)),
}

const utcInv: Record<string, (...args: never[]) => unknown> = {
  [QUARTER]: ((q: unknown) => 3 * (q as number)) as never,
  [WEEK]: ((w: unknown, y?: unknown) => weekday(w as number, 0, utcFirst(y as number))) as never,
}

export function utcFloor(units: string[], step?: number): (v: unknown) => Date {
  return floor(units, step, utcGet, utcInv, utcDate)
}
