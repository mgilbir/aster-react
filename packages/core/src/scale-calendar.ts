/**
 * The calendar scales: continuous scales over instants (milliseconds since the epoch), in local time (`time`) or in UTC
 * (`utc`). The domain reads back as Dates, an inverted value is a Date, ticks fall on calendar boundaries (a day starts at
 * midnight of the scale's zone), and the default label for a tick is the coarsest unit the instant sits exactly on.
 *
 * What the callers observe, and so what is fixed here: the ladder of tick intervals (1, 5, 15, 30 seconds; 1, 5, 15, 30
 * minutes; 1, 3, 6, 12 hours; 1, 2 days; a week; 1, 3 months; a year) and the rule that chooses a rung: the one whose span
 * is nearer the wanted step in ratio, with milliseconds below the ladder and multi-year steps above it; and that the UTC
 * ladder counts days from the epoch (so its two-day tick falls on even epoch days, which is not "every second date").
 */
import { bisectRight, tickStep } from './arr.js'
import { accessor, carry, continuousScale, niceDomain, type ScaleObject } from './scale-continuous.js'
import {
  durationDay,
  durationHour,
  durationMinute,
  durationMonth,
  durationSecond,
  durationWeek,
  durationYear,
  millisecond,
  second,
  timeDay,
  timeHour,
  timeMinute,
  timeMonth,
  timeWeek,
  timeYear,
  unixDay,
  utcDay,
  utcHour,
  utcMinute,
  utcMonth,
  utcWeek,
  utcYear,
  type TimeInterval,
} from './time.js'
import { timeFormat, utcFormat } from './time-format.js'

type Unit = 'second' | 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year'

/** The rungs of the tick ladder: a unit and the multiples of it that are ticks. */
const LADDER: readonly (readonly [Unit, readonly number[]])[] = [
  ['second', [1, 5, 15, 30]],
  ['minute', [1, 5, 15, 30]],
  ['hour', [1, 3, 6, 12]],
  ['day', [1, 2]],
  ['week', [1]],
  ['month', [1, 3]],
  ['year', [1]],
]

const UNIT_MS: Record<Unit, number> = {
  second: durationSecond,
  minute: durationMinute,
  hour: durationHour,
  day: durationDay,
  week: durationWeek,
  month: durationMonth,
  year: durationYear,
}

interface Zone {
  units: Record<Unit, TimeInterval>
  /** The interval whose multiples the ladder's day rung counts (the epoch's days for UTC, calendar days locally). */
  ladderDay: TimeInterval
  format: (specifier: string) => (date: Date) => string
}

const LOCAL: Zone = {
  units: { second, minute: timeMinute, hour: timeHour, day: timeDay, week: timeWeek, month: timeMonth, year: timeYear },
  ladderDay: timeDay,
  format: timeFormat as Zone['format'],
}

const UTC: Zone = {
  units: { second, minute: utcMinute, hour: utcHour, day: utcDay, week: utcWeek, month: utcMonth, year: utcYear },
  ladderDay: unixDay,
  format: utcFormat as Zone['format'],
}

interface Rung {
  interval: TimeInterval
  step: number
}

function ladderOf(zone: Zone): { rungs: Rung[]; spans: number[] } {
  const rungs: Rung[] = []
  const spans: number[] = []
  for (const [unit, steps] of LADDER) {
    for (const step of steps) {
      rungs.push({ interval: unit === 'day' ? zone.ladderDay : zone.units[unit], step })
      spans.push(step * UNIT_MS[unit])
    }
  }
  return { rungs, spans }
}

const msOf = (t: unknown): number => (t instanceof Date ? +t : +new Date(+(t as number)))

function calendarScale(zone: Zone, copy: () => ScaleObject): ScaleObject {
  const { scale } = continuousScale()
  const { rungs, spans } = ladderOf(zone)
  const { year, month, week, day, hour, minute, second: sec } = zone.units
  const asInstants = scale.domain
  const asInverse = scale.invert

  /** The interval that puts about `count` ticks between two instants. */
  const pick = (start: number, stop: number, count: unknown): TimeInterval | null => {
    const target = Math.abs(stop - start) / (count as number)
    const at = bisectRight(spans, target)
    if (at === rungs.length) return year.every!(tickStep(start / durationYear, stop / durationYear, count as number))
    if (at === 0) return millisecond.every!(Math.max(tickStep(start, stop, count as number), 1))
    const nearer = target / spans[at - 1]! < spans[at]! / target ? rungs[at - 1]! : rungs[at]!
    return nearer.interval.every!(nearer.step)
  }

  const isInterval = (x: unknown): x is TimeInterval => !!x && typeof (x as TimeInterval).range === 'function'

  const listTicks = (start: number, stop: number, count: unknown): Date[] => {
    const reversed = stop < start
    if (reversed) [start, stop] = [stop, start]
    const interval = isInterval(count) ? count : pick(start, stop, count)
    const dates = interval ? interval.range(start, +stop + 1) : []
    return reversed ? dates.reverse() : dates
  }

  const asMillisecond = zone.format('.%L')
  const asSecond = zone.format(':%S')
  const asMinute = zone.format('%I:%M')
  const asHour = zone.format('%I %p')
  const asDay = zone.format('%a %d')
  const asWeek = zone.format('%b %d')
  const asMonth = zone.format('%B')
  const asYear = zone.format('%Y')

  /** The default label: the coarsest unit the date sits on, read off the finest-first ladder of "is it exactly on it". */
  const labelFor = (d: Date): string => {
    const write =
      sec(d) < d ? asMillisecond
      : minute(d) < d ? asSecond
      : hour(d) < d ? asMinute
      : day(d) < d ? asHour
      : month(d) < d ? (week(d) < d ? asDay : asWeek)
      : year(d) < d ? asMonth
      : asYear
    return write(d)
  }

  scale.invert = (y: unknown) => new Date(asInverse(y) as number)
  scale.domain = accessor(
    scale,
    () => (asInstants() as number[]).map((t) => new Date(t)),
    (v: Iterable<unknown>) => void asInstants(Array.from(v, msOf)),
  )
  scale.ticks = (interval?: unknown) => {
    const d = asInstants() as number[]
    return listTicks(d[0]!, d[d.length - 1]!, interval == null ? 10 : interval)
  }
  scale.tickFormat = (_count?: number, specifier?: string) => (specifier == null ? labelFor : zone.format(specifier))
  scale.nice = (interval?: unknown) => {
    const d = asInstants() as number[]
    const chosen = isInterval(interval) ? interval : pick(d[0]!, d[d.length - 1]!, interval == null ? 10 : interval)
    if (!chosen) return scale
    return asInstants(niceDomain(d, { floor: (x) => +chosen.floor(x as unknown as Date), ceil: (x) => +chosen.ceil(x as unknown as Date) }))
  }
  scale.copy = () => carry(scale, copy())
  return scale
}

export function time(): ScaleObject {
  return calendarScale(LOCAL, time).domain([new Date(2000, 0, 1), new Date(2000, 0, 2)])
}

export function utcTime(): ScaleObject {
  return calendarScale(UTC, utcTime).domain([Date.UTC(2000, 0, 1), Date.UTC(2000, 0, 2)])
}
