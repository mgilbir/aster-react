/**
 * Calendar arithmetic: intervals (floor, ceil, offset, range, count, every, filter) over the local and the UTC
 * calendar, and the time-unit layer the `timeunit` transform, the time scales and the date expressions are built on
 * (unit validation, floors to a unit list, offsets, sequences, day-of-year and week numbers).
 *
 * Design. A calendar unit is a `Unit`: how to snap a Date down, how to move it, and optionally how many whole units lie
 * between two snapped dates and where it sits in the next larger unit. `makeInterval` turns a `Unit` into the callable
 * interval object. The same unit definitions serve both calendars: a `Zone` supplies the field readers and writers of
 * local or UTC time, so each unit is written once (`calendarUnits(zone)`).
 *
 * What is behaviour-forced rather than chosen:
 * - local minute and hour floors subtract the fields from the timestamp instead of calling `setMinutes(0, 0)`: across a
 *   30-minute daylight-saving change or a repeated hour, the two land on different instants;
 * - local day and week counts correct for a change of the zone's offset between the two dates (the day count of a
 *   23-hour day is one), the UTC ones do so with an offset of zero;
 * - `timeYear.every(k)` and `timeMillisecond.every(k)` are dedicated intervals (offset moves k units, floor snaps to a
 *   multiple of k), not filters, and the offset of a filtered interval walks one match at a time;
 * - a range that lands in years 0..99 is built with the proper year in local time, but vega-time's UTC floor yields an
 *   Invalid Date there (see `utcDate` below), and its UTC day-of-year / week for such years count from 19xx;
 * - an inherited name (`constructor`, `__proto__`) is not a time unit.
 * One deliberate difference from vega-time: `timeUnitSpecifier` with a specifier table that blanks out a unit
 * (`{ year: null }`) skips that unit instead of looping forever.
 */
import { array, error, extend, hasOwnProperty, ownGet, peek, toSet } from './util.js'
import { activeMeter } from './limits.js'

// --- durations ----------------------------------------------------------------------------

export const durationSecond = 1000
export const durationMinute = durationSecond * 60
export const durationHour = durationMinute * 60
export const durationDay = durationHour * 24
export const durationWeek = durationDay * 7
export const durationMonth = durationDay * 30
export const durationYear = durationDay * 365

// --- the interval object -------------------------------------------------------------------

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

/** One calendar unit, acting in place on Dates. */
interface Unit {
  /** Snap down to the start of the unit. */
  floor(date: Date): void
  /** Move by `n` units. */
  shift(date: Date, n: number): void
  /** Whole units from `a` to `b`, both already floored; its presence enables `count` and `every`. */
  between?(a: Date, b: Date): number
  /** The date's position in the next larger unit (0-based); `every(k)` keeps the multiples of k. */
  phase?(date: Date): number
  /** A dedicated `every`, where filtering would be slow or would offset differently. */
  every?(k: number): TimeInterval | null
}

const lowEnd = new Date(0)
const highEnd = new Date(0)

function makeInterval(unit: Unit): TimeInterval {
  const snapped = (date: unknown): Date => {
    const copy = new Date(+(date as Date))
    unit.floor(copy)
    return copy
  }
  const ceil = (date: unknown): Date => {
    const copy = new Date((date as number) - 1)
    unit.floor(copy)
    unit.shift(copy, 1)
    unit.floor(copy)
    return copy
  }
  const interval = ((...args: unknown[]): Date => {
    const copy = args.length === 0 ? new Date() : new Date(+(args[0] as Date))
    unit.floor(copy)
    return copy
  }) as TimeInterval

  interval.floor = snapped
  interval.ceil = ceil
  interval.round = (date) => {
    const below = snapped(date)
    const above = ceil(date)
    return (date as unknown as number) - +below < +above - (date as unknown as number) ? below : above
  }
  interval.offset = (date, step) => {
    const copy = new Date(+date)
    unit.shift(copy, step == null ? 1 : Math.floor(step))
    return copy
  }
  interval.range = (start, stop, step) => {
    const out: Date[] = []
    const cursor = ceil(start)
    const stride = step == null ? 1 : Math.floor(step)
    if (!(cursor < (stop as Date)) || !(stride > 0)) return out
    // under limits the tick count is bounded while the range is generated; a 1 ms interval over decades would
    // otherwise allocate without end
    const meter = activeMeter()
    let previous: Date
    do {
      out.push(previous = new Date(+cursor))
      unit.shift(cursor, stride)
      unit.floor(cursor)
      if (meter && (out.length & 1023) === 0) meter.items(out.length, 'time ticks')
    } while (previous < cursor && cursor < (stop as Date))
    return out
  }
  interval.filter = (test) => makeInterval({
    floor(date) {
      if (date >= date) while (unit.floor(date), !test(date)) date.setTime(+date - 1)
    },
    shift(date, n) {
      if (!(date >= date)) return
      if (n < 0) {
        while (++n <= 0) {
          do unit.shift(date, -1)
          while (!test(date))
        }
      } else {
        while (--n >= 0) {
          do unit.shift(date, +1)
          while (!test(date))
        }
      }
    },
  })

  const { between, phase } = unit
  if (between) {
    interval.count = (start, end) => {
      lowEnd.setTime(+(start as Date))
      highEnd.setTime(+(end as Date))
      unit.floor(lowEnd)
      unit.floor(highEnd)
      return Math.floor(between(lowEnd, highEnd))
    }
    interval.every = unit.every ?? ((k) => {
      k = Math.floor(k)
      if (!isFinite(k) || !(k > 0)) return null
      if (!(k > 1)) return interval
      return interval.filter(phase ? (d) => phase(d) % k === 0 : (d) => interval.count!(0, d) % k === 0)
    })
  }
  return interval
}

// --- zones: local and UTC field access ---------------------------------------------------------

export interface Zone {
  ms(d: Date): number
  sec(d: Date): number
  min(d: Date): number
  hour(d: Date): number
  date(d: Date): number
  day(d: Date): number
  month(d: Date): number
  year(d: Date): number
  setDate(d: Date, n: number): void
  setMonth(d: Date, n: number): void
  /** Move by calendar days, months and years (written out per zone: these are the hot paths of offsets and ranges). */
  addDays(d: Date, n: number): void
  addMonths(d: Date, n: number): void
  addYears(d: Date, n: number): void
  setMonthAndDate(d: Date, month: number, date: number): void
  setYear(d: Date, n: number): void
  midnight(d: Date): void
  /** Minutes behind UTC at `d` (always 0 in UTC). */
  behind(d: Date): number
}

export const localZone: Zone = {
  ms: (d) => d.getMilliseconds(),
  sec: (d) => d.getSeconds(),
  min: (d) => d.getMinutes(),
  hour: (d) => d.getHours(),
  date: (d) => d.getDate(),
  day: (d) => d.getDay(),
  month: (d) => d.getMonth(),
  year: (d) => d.getFullYear(),
  setDate: (d, n) => void d.setDate(n),
  setMonth: (d, n) => void d.setMonth(n),
  addDays: (d, n) => void d.setDate(d.getDate() + n),
  addMonths: (d, n) => void d.setMonth(d.getMonth() + n),
  addYears: (d, n) => void d.setFullYear(d.getFullYear() + n),
  setMonthAndDate: (d, m, n) => void d.setMonth(m, n),
  setYear: (d, n) => void d.setFullYear(n),
  midnight: (d) => void d.setHours(0, 0, 0, 0),
  behind: (d) => d.getTimezoneOffset(),
}

export const utcZone: Zone = {
  ms: (d) => d.getUTCMilliseconds(),
  sec: (d) => d.getUTCSeconds(),
  min: (d) => d.getUTCMinutes(),
  hour: (d) => d.getUTCHours(),
  date: (d) => d.getUTCDate(),
  day: (d) => d.getUTCDay(),
  month: (d) => d.getUTCMonth(),
  year: (d) => d.getUTCFullYear(),
  setDate: (d, n) => void d.setUTCDate(n),
  setMonth: (d, n) => void d.setUTCMonth(n),
  addDays: (d, n) => void d.setUTCDate(d.getUTCDate() + n),
  addMonths: (d, n) => void d.setUTCMonth(d.getUTCMonth() + n),
  addYears: (d, n) => void d.setUTCFullYear(d.getUTCFullYear() + n),
  setMonthAndDate: (d, m, n) => void d.setUTCMonth(m, n),
  setYear: (d, n) => void d.setUTCFullYear(n),
  midnight: (d) => void d.setUTCHours(0, 0, 0, 0),
  behind: () => 0,
}

/** Days or weeks between two floored dates, discounting a change of the zone's offset between them. */
const spanBetween = (zone: Zone, length: number) => zone === utcZone
  ? (a: Date, b: Date): number => (+b - +a) / length
  : (a: Date, b: Date): number => (+b - +a - (zone.behind(b) - zone.behind(a)) * durationMinute) / length

function calendarUnits(zone: Zone) {
  const minute: Unit = {
    floor: (d) => void d.setTime(+d - zone.ms(d) - zone.sec(d) * durationSecond),
    shift: (d, n) => void d.setTime(+d + n * durationMinute),
    between: (a, b) => (+b - +a) / durationMinute,
    phase: zone.min,
  }
  const hour: Unit = {
    floor: (d) => void d.setTime(+d - zone.ms(d) - zone.sec(d) * durationSecond - zone.min(d) * durationMinute),
    shift: (d, n) => void d.setTime(+d + n * durationHour),
    between: (a, b) => (+b - +a) / durationHour,
    phase: zone.hour,
  }
  const day: Unit = {
    floor: zone.midnight,
    shift: zone.addDays,
    between: spanBetween(zone, durationDay),
    phase: (d) => zone.date(d) - 1,
  }
  const week = (firstDay: number): Unit => ({
    floor(d) {
      zone.setDate(d, zone.date(d) - (zone.day(d) + 7 - firstDay) % 7)
      zone.midnight(d)
    },
    shift: (d, n) => zone.addDays(d, n * 7),
    between: spanBetween(zone, durationWeek),
  })
  const month: Unit = {
    floor(d) {
      zone.setDate(d, 1)
      zone.midnight(d)
    },
    shift: zone.addMonths,
    between: (a, b) => zone.month(b) - zone.month(a) + (zone.year(b) - zone.year(a)) * 12,
    phase: zone.month,
  }
  const year: Unit = {
    floor(d) {
      zone.setMonthAndDate(d, 0, 1)
      zone.midnight(d)
    },
    shift: zone.addYears,
    between: (a, b) => zone.year(b) - zone.year(a),
    phase: zone.year,
    // every k years: floor to a multiple of k, and offsetting moves k years whatever the month and day
    every: (k) => {
      k = Math.floor(k)
      return !isFinite(k) || !(k > 0) ? null : makeInterval({
        floor(d) {
          zone.setYear(d, Math.floor(zone.year(d) / k) * k)
          zone.setMonthAndDate(d, 0, 1)
          zone.midnight(d)
        },
        shift: (d, n) => zone.setYear(d, zone.year(d) + n * k),
      })
    },
  }
  return { minute, hour, day, week, month, year }
}

const localUnits = /* @__PURE__ */ calendarUnits(localZone)
const utcUnits = /* @__PURE__ */ calendarUnits(utcZone)

// --- the exported intervals -----------------------------------------------------------------------

export const millisecond: TimeInterval = /* @__PURE__ */ makeInterval({
  floor: () => undefined,
  shift: (d, n) => void d.setTime(+d + n),
  between: (a, b) => +b - +a,
  // whole milliseconds are the finest grain, so "every k" is plain arithmetic
  every: (k) => {
    k = Math.floor(k)
    if (!isFinite(k) || !(k > 0)) return null
    if (!(k > 1)) return millisecond
    return makeInterval({
      floor: (d) => void d.setTime(Math.floor(+d / k) * k),
      shift: (d, n) => void d.setTime(+d + n * k),
      between: (a, b) => (+b - +a) / k,
    })
  },
})

/** Seconds are zone-independent: one interval serves local and UTC time. */
export const second: TimeInterval = /* @__PURE__ */ makeInterval({
  floor: (d) => void d.setTime(+d - d.getMilliseconds()),
  shift: (d, n) => void d.setTime(+d + n * durationSecond),
  between: (a, b) => (+b - +a) / durationSecond,
  phase: (d) => d.getUTCSeconds(),
})

export const timeMinute: TimeInterval = /* @__PURE__ */ makeInterval(localUnits.minute)
export const utcMinute: TimeInterval = /* @__PURE__ */ makeInterval(utcUnits.minute)
export const timeHour: TimeInterval = /* @__PURE__ */ makeInterval(localUnits.hour)
export const utcHour: TimeInterval = /* @__PURE__ */ makeInterval(utcUnits.hour)
export const timeDay: TimeInterval = /* @__PURE__ */ makeInterval(localUnits.day)
export const utcDay: TimeInterval = /* @__PURE__ */ makeInterval(utcUnits.day)
/** UTC days numbered from the epoch, so `every(k)` counts from 1970-01-01. */
export const unixDay: TimeInterval = /* @__PURE__ */ makeInterval({ ...utcUnits.day, phase: (d) => Math.floor(+d / durationDay) })

export const timeSunday: TimeInterval = /* @__PURE__ */ makeInterval(localUnits.week(0))
export const timeMonday: TimeInterval = /* @__PURE__ */ makeInterval(localUnits.week(1))
export const timeTuesday: TimeInterval = /* @__PURE__ */ makeInterval(localUnits.week(2))
export const timeWednesday: TimeInterval = /* @__PURE__ */ makeInterval(localUnits.week(3))
export const timeThursday: TimeInterval = /* @__PURE__ */ makeInterval(localUnits.week(4))
export const timeFriday: TimeInterval = /* @__PURE__ */ makeInterval(localUnits.week(5))
export const timeSaturday: TimeInterval = /* @__PURE__ */ makeInterval(localUnits.week(6))
export const utcSunday: TimeInterval = /* @__PURE__ */ makeInterval(utcUnits.week(0))
export const utcMonday: TimeInterval = /* @__PURE__ */ makeInterval(utcUnits.week(1))
export const utcTuesday: TimeInterval = /* @__PURE__ */ makeInterval(utcUnits.week(2))
export const utcWednesday: TimeInterval = /* @__PURE__ */ makeInterval(utcUnits.week(3))
export const utcThursday: TimeInterval = /* @__PURE__ */ makeInterval(utcUnits.week(4))
export const utcFriday: TimeInterval = /* @__PURE__ */ makeInterval(utcUnits.week(5))
export const utcSaturday: TimeInterval = /* @__PURE__ */ makeInterval(utcUnits.week(6))
export const timeWeek: TimeInterval = timeSunday
export const utcWeek: TimeInterval = utcSunday

export const timeMonth: TimeInterval = /* @__PURE__ */ makeInterval(localUnits.month)
export const utcMonth: TimeInterval = /* @__PURE__ */ makeInterval(utcUnits.month)
export const timeYear: TimeInterval = /* @__PURE__ */ makeInterval(localUnits.year)
export const utcYear: TimeInterval = /* @__PURE__ */ makeInterval(utcUnits.year)

// --- time units (the names a spec uses) ---------------------------------------------------------------

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

/** Coarse to fine; a unit list is sorted by this order. */
export const TIME_UNITS = [YEAR, QUARTER, MONTH, WEEK, DATE, DAY, DAYOFYEAR, HOURS, MINUTES, SECONDS, MILLISECONDS] as const

const UNIT_ORDER: Record<string, number> = {}
TIME_UNITS.forEach((unit, i) => { UNIT_ORDER[unit] = i + 1 })

/** Validate a unit list (one unit or an array) and return it coarse to fine; throws on empty, unknown or clashing units. */
export function timeUnits(units: unknown): string[] {
  const list = array(units) as string[]
  if (!list.length) error('Missing time unit.')
  const seen: Record<string, boolean> = {}
  for (const unit of list) {
    if (!hasOwnProperty(UNIT_ORDER, unit)) error(`Invalid time unit: ${unit}.`)
    seen[unit] = true
  }
  // the week/day family, the quarter/month/date family and day-of-year cannot be mixed
  const families = Number(seen[WEEK] || seen[DAY] || false) + Number(seen[QUARTER] || seen[MONTH] || seen[DATE] || false) + Number(seen[DAYOFYEAR] || false)
  if (families > 1) error(`Incompatible time units: ${units}`)
  return list.sort((a, b) => UNIT_ORDER[a]! - UNIT_ORDER[b]!)
}

const DEFAULT_SPECIFIERS: Record<string, string> = {
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

/** The time-format specifier that prints a unit list: the longest run of neighbours that has a specifier, repeatedly. */
export function timeUnitSpecifier(units: unknown, specifiers?: Record<string, string>): string {
  const table = extend({}, DEFAULT_SPECIFIERS, specifiers) as Record<string, string | null | undefined>
  const list = timeUnits(units)
  let text = ''
  for (let from = 0; from < list.length; ) {
    let to = list.length
    while (to > from && table[list.slice(from, to).join('-')] == null) to--
    if (to === from) {
      from++ // no specifier covers this unit: it contributes nothing (vega-time would never return)
    } else {
      text += table[list.slice(from, to).join('-')]
      from = to
    }
  }
  return text.trim()
}

// --- dates and day / week numbers -----------------------------------------------------------------------

/** A local-time Date with a literal year (the Date constructor would read 0..99 as 1900..1999). */
export function localDate(y: number, m: number, d: number, H: number, M: number, S: number, L: number): Date {
  if (0 <= y && y < 100) {
    const date = new Date(-1, m, d, H, M, S, L)
    date.setFullYear(y)
    return date
  }
  return new Date(y, m, d, H, M, S, L)
}

/** A UTC Date with a literal year. */
export function utcDate(y: number, m: number, d: number, H: number, M: number, S: number, L: number): Date {
  if (0 <= y && y < 100) {
    const date = new Date(Date.UTC(-1, m, d, H, M, S, L))
    date.setUTCFullYear(y)
    return date
  }
  return new Date(Date.UTC(y, m, d, H, M, S, L))
}

/**
 * A calendar's view for the unit floors: its zone, the milliseconds of 1 January, the day and week intervals, and how it
 * builds a Date from fields. UTC reads 1 January through `Date.UTC`, which maps years 0..99 to 19xx, and builds an
 * Invalid Date for those years (vega-time passes the day of the month where the year belongs); both are kept.
 */
interface Calendar {
  zone: Zone
  january1(year: number): number
  /** The weekday (0 = Sunday) of 1 January. */
  firstWeekday(year: number): number
  day: TimeInterval
  week: TimeInterval
  build(y: number, m: number, d: number, H: number, M: number, S: number, L: number): Date
}

/**
 * One Date that vega-time reuses for every 1 January lookup, local and UTC alike, so each call starts from what the
 * previous one left. That is observable: the year-by-year `setFullYear` of an old value can overflow the Date range and
 * leave an Invalid Date, which in the last months of the range (year 275760) depends on the history of calls and on the
 * zone. Kept as it is.
 */
const january1Scratch = new Date()

function localJanuary1(year: number): Date {
  january1Scratch.setFullYear(year)
  january1Scratch.setMonth(0)
  january1Scratch.setDate(1)
  january1Scratch.setHours(0, 0, 0, 0)
  return january1Scratch
}

const LOCAL_CALENDAR: Calendar = {
  zone: localZone,
  january1: (year) => +localJanuary1(year),
  firstWeekday: (year) => localJanuary1(year).getDay(),
  day: timeDay,
  week: timeWeek,
  build: localDate,
}

const UTC_CALENDAR: Calendar = {
  zone: utcZone,
  january1: (year) => Date.UTC(year, 0, 1),
  firstWeekday(year) {
    january1Scratch.setTime(Date.UTC(year, 0, 1))
    return january1Scratch.getUTCDay()
  },
  day: utcDay,
  week: utcWeek,
  build: (y, m, d, H, M, S, L) => (0 <= y && y < 100 ? new Date(NaN) : new Date(Date.UTC(y, m, d, H, M, S, L))),
}

const dayNumber = (cal: Calendar, d: Date): number => cal.day.count!(cal.january1(cal.zone.year(d)) - 1, d)
const weekNumber = (cal: Calendar, d: Date): number => cal.week.count!(cal.january1(cal.zone.year(d)) - 1, d)

export const dayofyear = (d: unknown): number => dayNumber(LOCAL_CALENDAR, new Date(d as number))
export const week = (d: unknown): number => weekNumber(LOCAL_CALENDAR, new Date(d as number))
export const utcdayofyear = (d: unknown): number => dayNumber(UTC_CALENDAR, new Date(d as number))
export const utcweek = (d: unknown): number => weekNumber(UTC_CALENDAR, new Date(d as number))

// --- unit -> interval, offsets and sequences ---------------------------------------------------------------

function intervalTable(f: { year: TimeInterval; month: TimeInterval; week: TimeInterval; day: TimeInterval; hour: TimeInterval; minute: TimeInterval }): Record<string, TimeInterval> {
  return {
    [YEAR]: f.year,
    [QUARTER]: f.month.every!(3)!,
    [MONTH]: f.month,
    [WEEK]: f.week,
    [DATE]: f.day,
    [DAY]: f.day,
    [DAYOFYEAR]: f.day,
    [HOURS]: f.hour,
    [MINUTES]: f.minute,
    [SECONDS]: second,
    [MILLISECONDS]: millisecond,
  }
}

const LOCAL_INTERVALS = intervalTable({ year: timeYear, month: timeMonth, week: timeWeek, day: timeDay, hour: timeHour, minute: timeMinute })
const UTC_INTERVALS = intervalTable({ year: utcYear, month: utcMonth, week: utcWeek, day: utcDay, hour: utcHour, minute: utcMinute })

export const timeIntervalFor = (unit: string): TimeInterval | undefined => ownGet(LOCAL_INTERVALS, unit)
export const utcIntervalFor = (unit: string): TimeInterval | undefined => ownGet(UTC_INTERVALS, unit)

export const timeOffset = (unit: string, date: unknown, step: number): Date | undefined =>
  timeIntervalFor(unit)?.offset(date as Date, step)
export const utcOffset = (unit: string, date: unknown, step: number): Date | undefined =>
  utcIntervalFor(unit)?.offset(date as Date, step)

export const timeSequence = (unit: string, start: unknown, stop: unknown, step?: number): Date[] | undefined =>
  timeIntervalFor(unit)?.range(start, stop, step)
export const utcSequence = (unit: string, start: unknown, stop: unknown, step?: number): Date[] | undefined =>
  utcIntervalFor(unit)?.range(start, stop, step)

// --- floors to a unit list ------------------------------------------------------------------------------------

type Reader = (d: Date, year: number) => number

/** The day-of-year of a weekday given its week number, the weekday (0 = Sunday) and the weekday of 1 January. */
const dayInYear = (weekNum: number, weekday: number, firstDay: number): number => weekday + weekNum * 7 - (firstDay + 6) % 7

/** How a calendar reads each unit from a Date, and how a unit read as a number is turned back into a Date field. */
function readersOf(cal: Calendar) {
  const z = cal.zone
  const read: Record<string, Reader> = {
    [YEAR]: (d) => z.year(d),
    [QUARTER]: (d) => Math.floor(z.month(d) / 3),
    [MONTH]: (d) => z.month(d),
    [DATE]: (d) => z.date(d),
    [HOURS]: (d) => z.hour(d),
    [MINUTES]: (d) => z.min(d),
    [SECONDS]: (d) => z.sec(d),
    [MILLISECONDS]: (d) => z.ms(d),
    [DAYOFYEAR]: (d) => dayNumber(cal, d),
    [WEEK]: (d) => weekNumber(cal, d),
    [WEEK + DAY]: (d, y) => dayInYear(weekNumber(cal, d), z.day(d), cal.firstWeekday(y)),
    [DAY]: (d, y) => dayInYear(1, z.day(d), cal.firstWeekday(y)),
  }
  const invert: Record<string, (value: number, year: number) => number> = {
    [QUARTER]: (q) => 3 * q,
    [WEEK]: (w, y) => dayInYear(w, 0, cal.firstWeekday(y)),
  }
  return { read, invert }
}

const LOCAL_READERS = readersOf(LOCAL_CALENDAR)
const UTC_READERS = readersOf(UTC_CALENDAR)

/** Round a unit's reading down to a multiple of `step` (counted from `phase` when the unit starts there). */
function steppedReader(read: Reader, invert: ((v: number, y: number) => number) | undefined, step: number | undefined, phase: number | undefined): Reader {
  const stepped: Reader = step === undefined || step <= 1 ? read
    : phase ? (d, y) => phase + (step as number) * Math.floor((read(d, y) - phase) / (step as number))
    : (d, y) => (step as number) * Math.floor(read(d, y) / (step as number))
  return invert ? (d, y) => invert(stepped(d, y), y) : stepped
}

/**
 * Which unit fills each field of the rebuilt Date, first listed first: the field's default is used when none of its
 * units is in the list. `phase` is the first value of the unit (days and weeks count from 1).
 */
interface FieldChoice { needs: readonly string[]; unit: string; key?: string; phase?: number }
const FIELDS: readonly { fallback: number; choices: readonly FieldChoice[] }[] = [
  { fallback: 2012, choices: [{ needs: [YEAR], unit: YEAR }] },
  { fallback: 0, choices: [{ needs: [MONTH], unit: MONTH }, { needs: [QUARTER], unit: QUARTER }] },
  {
    fallback: 1,
    choices: [
      { needs: [WEEK, DAY], unit: DAY, key: WEEK + DAY, phase: 1 },
      { needs: [WEEK], unit: WEEK, phase: 1 },
      { needs: [DAY], unit: DAY, phase: 1 },
      { needs: [DATE], unit: DATE, phase: 1 },
      { needs: [DAYOFYEAR], unit: DAYOFYEAR, phase: 1 },
    ],
  },
  { fallback: 0, choices: [{ needs: [HOURS], unit: HOURS }] },
  { fallback: 0, choices: [{ needs: [MINUTES], unit: MINUTES }] },
  { fallback: 0, choices: [{ needs: [SECONDS], unit: SECONDS }] },
  { fallback: 0, choices: [{ needs: [MILLISECONDS], unit: MILLISECONDS }] },
]

function floorFunction(cal: Calendar, readers: ReturnType<typeof readersOf>, units: string[], step: number | undefined): (v: unknown) => Date {
  const grain = step || 1
  const finest = peek(units)
  const present = toSet(units)
  const fields: Reader[] = FIELDS.map(({ fallback, choices }) => {
    const choice = choices.find((c) => c.needs.every((u) => present[u]))
    if (!choice) return () => fallback
    const key = choice.key ?? choice.unit
    return steppedReader(readers.read[key]!, readers.invert[key], choice.unit === finest ? grain : undefined, choice.phase)
  })
  const [y, m, d, H, M, S, L] = fields as [Reader, Reader, Reader, Reader, Reader, Reader, Reader]
  const scratch = new Date(0)
  return (v) => {
    scratch.setTime(+(v as Date))
    const year = y(scratch, 0)
    return cal.build(year, m(scratch, year), d(scratch, year), H(scratch, year), M(scratch, year), S(scratch, year), L(scratch, year))
  }
}

/** A function that floors a time to the given units (see `timeUnits`), in steps of `step` for the finest unit. */
export const timeFloor = (units: string[], step?: number): ((v: unknown) => Date) => floorFunction(LOCAL_CALENDAR, LOCAL_READERS, units, step)
export const utcFloor = (units: string[], step?: number): ((v: unknown) => Date) => floorFunction(UTC_CALENDAR, UTC_READERS, units, step)
