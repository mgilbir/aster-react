/**
 * The time half of a locale (locale.ts) over its engines: the time formats of time-format.ts, each remembered per specifier, and the
 * multi-format a time axis labels with by default. Part of the engine's `time` family (engine-parts.ts), which locale.ts reads when
 * a date is first formatted or parsed.
 */
import {
  timeFormat as defaultTimeFormat, timeFormatLocale as makeTimeLocale, timeParse as defaultTimeParse,
  utcFormat as defaultUtcFormat, utcParse as defaultUtcParse,
  type TimeLocaleDefinition,
} from './time-format.js'
import {
  DATE, DAY, HOURS, MILLISECONDS, MINUTES, MONTH, QUARTER, SECONDS, WEEK, YEAR,
  timeIntervalFor, utcIntervalFor, type TimeInterval,
} from './time.js'
import { error, isObject, isString } from './util.js'
import { remember, type TimeLocale } from './locale.js'

type TimeFormat = (specifier: string) => (value: unknown) => string

/**
 * The formatter a time axis uses by default: one function that prints a date with the format of the coarsest unit the
 * date starts exactly on. `spec` overrides the format per unit name (`milliseconds`, `seconds`, `minutes`, `hours`,
 * `date`/`day`, `week`, `month`, `quarter`, `year`).
 */
function multiFormat(format: TimeFormat, intervalOf: (unit: string) => TimeInterval | undefined, spec: unknown): (date: unknown) => string {
  const formats = (spec || {}) as Record<string, string | undefined>
  if (!isObject(formats)) error(`Invalid time multi-format specifier: ${formats}`)
  const pick = (fallback: string, ...units: string[]): ((value: unknown) => string) => {
    for (const unit of units) if (formats[unit]) return format(formats[unit]!)
    return format(fallback)
  }
  const [second, minute, hour, day, week, month, quarter, year] =
    [SECONDS, MINUTES, HOURS, DATE, WEEK, MONTH, QUARTER, YEAR].map((unit) => intervalOf(unit)!)
  const millis = pick('.%L', MILLISECONDS)
  const seconds = pick(':%S', SECONDS)
  const minutes = pick('%I:%M', MINUTES)
  const hours = pick('%I %p', HOURS)
  const days = pick('%a %d', DATE, DAY)
  const weeks = pick('%b %d', WEEK)
  const months = pick('%B', MONTH)
  const quarters = pick('%B', QUARTER)
  const years = pick('%Y', YEAR)
  const isOff = (floor: TimeInterval, date: unknown): boolean => floor(date) < (date as Date)
  return (date) => (
    isOff(second!, date) ? millis
    : isOff(minute!, date) ? seconds
    : isOff(hour!, date) ? minutes
    : isOff(day!, date) ? hours
    : isOff(month!, date) ? (isOff(week!, date) ? days : weeks)
    : isOff(year!, date) ? (isOff(quarter!, date) ? months : quarters)
    : years
  )(date)
}

interface TimeEngine {
  format: TimeFormat
  parse(specifier: string): (text: string) => Date | null
  utcFormat: TimeFormat
  utcParse(specifier: string): (text: string) => Date | null
}

function timeLocale(engine: TimeEngine): TimeLocale {
  const local = remember(engine.format)
  const utc = remember(engine.utcFormat)
  return {
    timeFormat: (spec: unknown) => (isString(spec) ? local(spec) : multiFormat(local, timeIntervalFor, spec)),
    utcFormat: (spec: unknown) => (isString(spec) ? utc(spec) : multiFormat(utc, utcIntervalFor, spec)),
    timeParse: remember(engine.parse),
    utcParse: remember(engine.utcParse),
  }
}


function defaultTimeEngine(): TimeEngine {
  return { format: defaultTimeFormat, parse: defaultTimeParse, utcFormat: defaultUtcFormat, utcParse: defaultUtcParse }
}

/** The default time locale: the time formats' default engine (en-US, as d3-time-format's). */
export function defaultTimeLocale(): TimeLocale {
  return timeLocale(defaultTimeEngine())
}

/** A time locale from a definition. */
export function timeFormatLocale(definition: TimeLocaleDefinition): TimeLocale {
  return timeLocale(makeTimeLocale(definition))
}
