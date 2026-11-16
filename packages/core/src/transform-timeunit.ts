/**
 * The `timeunit` transform: each value floored to its time bin (units and step given, detected from the data, or chosen for a
 * number of bins over the extent). Part of the engine's time family (engine-parts.ts: `time`), with the calendar it floors by.
 */
import { error, extent as columnExtent, peek } from './util.js'
import { fieldOf, required, type Row } from './row-keys.js'
import { tickStep } from './arr.js'
import {
  DATE, DAY, HOURS, MILLISECONDS, MINUTES, MONTH, SECONDS, WEEK, YEAR,
  durationDay, durationHour, durationMinute, durationMonth, durationSecond, durationWeek, durationYear,
  timeFloor, timeIntervalFor, timeUnits, utcFloor, utcIntervalFor,
} from './time.js'

type Params = Record<string, unknown>
type Read = (d: unknown) => unknown

/** A row to write onto: the row itself when the pipeline owns it, otherwise a copy of it. */
const writable = (row: Row, owned: boolean): Row => (owned ? row : { ...row })

// ---------------------------------------------------------------------------
// timeunit
// ---------------------------------------------------------------------------

const THROUGH_MILLISECONDS = [YEAR, MONTH, DATE, HOURS, MINUTES, SECONDS, MILLISECONDS]
const THROUGH_SECONDS = THROUGH_MILLISECONDS.slice(0, -1)
const THROUGH_MINUTES = THROUGH_SECONDS.slice(0, -1)
const THROUGH_HOURS = THROUGH_MINUTES.slice(0, -1)
const THROUGH_DATE = THROUGH_HOURS.slice(0, -1)
const YEAR_WEEK = [YEAR, WEEK]
const YEAR_MONTH = [YEAR, MONTH]
const YEAR_ONLY = [YEAR]

/** The calendar steps a time bin may use, each with its length in ms (an approximation for months and years), shortest first. */
const BIN_GRAINS: Array<{ units: string[]; step: number; ms: number }> = [
  { units: THROUGH_SECONDS, step: 1, ms: durationSecond }, { units: THROUGH_SECONDS, step: 5, ms: 5 * durationSecond },
  { units: THROUGH_SECONDS, step: 15, ms: 15 * durationSecond }, { units: THROUGH_SECONDS, step: 30, ms: 30 * durationSecond },
  { units: THROUGH_MINUTES, step: 1, ms: durationMinute }, { units: THROUGH_MINUTES, step: 5, ms: 5 * durationMinute },
  { units: THROUGH_MINUTES, step: 15, ms: 15 * durationMinute }, { units: THROUGH_MINUTES, step: 30, ms: 30 * durationMinute },
  { units: THROUGH_HOURS, step: 1, ms: durationHour }, { units: THROUGH_HOURS, step: 3, ms: 3 * durationHour },
  { units: THROUGH_HOURS, step: 6, ms: 6 * durationHour }, { units: THROUGH_HOURS, step: 12, ms: 12 * durationHour },
  { units: THROUGH_DATE, step: 1, ms: durationDay }, { units: YEAR_WEEK, step: 1, ms: durationWeek },
  { units: YEAR_MONTH, step: 1, ms: durationMonth }, { units: YEAR_MONTH, step: 3, ms: 3 * durationMonth },
  { units: YEAR_ONLY, step: 1, ms: durationYear },
]

/**
 * The units and step that give about `maxbins` bins over a time extent: the calendar step whose length is nearest (in ratio) to
 * the extent's span over `maxbins`, years in a tick step beyond the longest, and milliseconds below the shortest.
 * An extent whose ends do not subtract to a number (NaN, Infinity - Infinity, a missing end) spans nothing.
 */
export function timeBin(extent: readonly number[], maxbins?: number): { units: string[]; step: number } {
  const bins = maxbins || 40
  const target = Math.abs((extent[extent.length - 1]! - extent[0]!) || 0) / bins
  let longer = 0
  while (longer < BIN_GRAINS.length && BIN_GRAINS[longer]!.ms - target <= 0) longer++
  if (longer === BIN_GRAINS.length) {
    return { units: YEAR_ONLY, step: tickStep(extent[0]! / durationYear, extent[1]! / durationYear, bins) }
  }
  if (longer === 0) {
    return { units: THROUGH_MILLISECONDS, step: Math.max(tickStep(extent[0]!, extent[1]!, bins), 1) }
  }
  const shorter = BIN_GRAINS[longer - 1]!
  const nearer = target / shorter.ms < BIN_GRAINS[longer]!.ms / target ? shorter : BIN_GRAINS[longer]!
  return { units: nearer.units, step: nearer.step }
}

type DateParts = (d: Date) => number
const localParts: Record<string, DateParts> = {
  [YEAR]: (d) => d.getFullYear(), [MONTH]: (d) => d.getMonth(), [DATE]: (d) => d.getDate(), [DAY]: (d) => d.getDay(),
  [HOURS]: (d) => d.getHours(), [MINUTES]: (d) => d.getMinutes(), [SECONDS]: (d) => d.getSeconds(), [MILLISECONDS]: (d) => d.getMilliseconds(),
}
const utcParts: Record<string, DateParts> = {
  [YEAR]: (d) => d.getUTCFullYear(), [MONTH]: (d) => d.getUTCMonth(), [DATE]: (d) => d.getUTCDate(), [DAY]: (d) => d.getUTCDay(),
  [HOURS]: (d) => d.getUTCHours(), [MINUTES]: (d) => d.getUTCMinutes(), [SECONDS]: (d) => d.getUTCSeconds(), [MILLISECONDS]: (d) => d.getUTCMilliseconds(),
}

/** Time grains from the finest to the coarsest, each with the units and step that bin to it. The last has none: nothing is aligned to it. */
const GRAINS: Array<{ units: string[]; step: number } | { units?: undefined; step?: undefined }> = [
  { units: THROUGH_MILLISECONDS, step: 1 }, { units: THROUGH_SECONDS, step: 1 }, { units: THROUGH_MINUTES, step: 1 },
  { units: THROUGH_MINUTES, step: 5 }, { units: THROUGH_MINUTES, step: 10 }, { units: THROUGH_HOURS, step: 1 },
  { units: THROUGH_DATE, step: 1 }, { units: YEAR_WEEK, step: 1 }, { units: YEAR_MONTH, step: 1 },
  { units: YEAR_MONTH, step: 3 }, { units: YEAR_ONLY, step: 1 }, { units: YEAR_ONLY, step: 10 }, {},
]
/** The week grain is the only one the coarse search may step over: dates that share a weekday are on it, yet it is not required. */
const WEEK_GRAIN = 7

/** Whether every date sits on the boundary of each grain (index as in {@link GRAINS}); the week grain holds when all dates share a weekday. */
function alignedGrains(dates: readonly Date[], utc: boolean): boolean[] {
  const part = utc ? utcParts : localParts
  const aligned = GRAINS.map(() => true)
  aligned[GRAINS.length - 1] = false
  const weekdays = new Set<number>()
  for (const d of dates) {
    if (part[MILLISECONDS]!(d) !== 0) aligned[1] = false
    if (part[SECONDS]!(d) !== 0) aligned[2] = false
    const minute = part[MINUTES]!(d)
    if (minute % 5 !== 0) aligned[3] = false
    if (minute % 10 !== 0) aligned[4] = false
    if (minute !== 0) aligned[5] = false
    if (part[HOURS]!(d) !== 0) aligned[6] = false
    weekdays.add(part[DAY]!(d))
    if (part[DATE]!(d) !== 1) aligned[8] = false
    const month = part[MONTH]!(d)
    if (month % 3 !== 0) aligned[9] = false
    if (month !== 0) aligned[10] = false
    if (part[YEAR]!(d) % 10 !== 0) aligned[11] = false
  }
  aligned[WEEK_GRAIN] = weekdays.size === 1
  return aligned
}

/** The coarsest grain every date in `rows` (read through `read`) is aligned to, as the units and step to bin by. */
function detectTimeUnits(rows: Row[], read: Read, utc: boolean): { units: string[]; step: number } {
  const dates = rows.map((row) => {
    const v = read(row)
    const d = new Date(v as string)
    if (Number.isNaN(+d)) error(`Invalid date: ${v}`)
    return d
  })
  const aligned = alignedGrains(dates, utc)
  const firstMiss = aligned.indexOf(false)
  const firstRequiredMiss = aligned.findIndex((ok, i) => !ok && i !== WEEK_GRAIN)
  const stop = firstRequiredMiss > firstMiss + 1 ? firstRequiredMiss : firstMiss
  const grain = GRAINS[stop - 1]!
  return { units: grain.units!, step: grain.step! }
}

/** What the `signal` of a timeunit transform publishes: the unit it floors to, the unit list, the step and the span of bins produced. */
export interface TimeUnitInfo { unit: string; units: string[]; step: number; start: number | Date; stop: number | Date }

/**
 * `timeunit`: `as` (default `unit0`, `unit1`) get the start and end of the value's time bin; null where there is no value, and
 * only the start without `interval`. The units are `units` (with `step`), detected from the data (`inferUnits`), or chosen to give
 * about `maxbins` bins over `extent` (the data's, by default).
 */
export function timeunitRows(rows: Row[], p: Params, publish?: (info: TimeUnitInfo) => void, owned = false): Row[] {
  required('timeunit', p, 'field')
  const read = fieldOf(p.field)
  const withEnd = p.interval !== false
  const utc = p.timezone === 'utc'
  const as = (p.as ?? ['unit0', 'unit1']) as string[]
  const startName = as[0] as string
  const endName = as[1] as string

  let units: unknown
  let step: number
  if (p.inferUnits) {
    ({ units, step } = detectTimeUnits(rows, read, utc))
  } else if (p.units) {
    units = p.units
    step = (p.step as number) || 1
  } else {
    ({ units, step } = timeBin((p.extent as [number, number] | undefined) || (columnExtent(rows, read) as [number, number]), p.maxbins as number | undefined))
  }
  const unitList = timeUnits(units)
  const floor = (utc ? utcFloor : timeFloor)(unitList, step)
  const unit = peek(unitList) as string
  const interval = (utc ? utcIntervalFor : timeIntervalFor)(unit)

  // (the span of the bins is published with the signal: it is what the rows visited came to)
  let first: number | Date = Infinity
  let last: number | Date = -Infinity
  const out = rows.map((row) => {
    const t = writable(row, owned)
    const v = read(row)
    if (v == null) {
      t[startName] = null
      if (withEnd) t[endName] = null
    } else {
      const binStart = floor(v)
      let binEnd: unknown = binStart
      t[startName] = binStart
      if (withEnd) t[endName] = binEnd = interval ? interval.offset(binStart, step) : undefined
      if (binStart < first) first = binStart
      if ((binEnd as number) > (last as number)) last = binEnd as number
    }
    return t
  })
  publish?.({ unit, units: unitList, step, start: first, stop: last })
  return out
}
