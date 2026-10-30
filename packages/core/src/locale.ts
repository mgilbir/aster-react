/**
 * Locales: the number and time formatters a chart reads text through, as one object.
 *
 * A locale offers `format`, `formatPrefix`, `formatFloat`, `formatSpan` (numbers) and `timeFormat`, `utcFormat`,
 * `timeParse`, `utcParse` (dates), built over the engines in `format.ts` and `time-format.ts`. Axis labels and
 * expression functions format thousands of values through a handful of specifiers, so compiled formatters are kept per
 * specifier in a bounded least-recently-used table (a specifier is spec- or data-supplied text, and an unbounded table
 * would be a retention vector in a long-lived process).
 *
 * The behaviour is the observable behaviour of vega-format, held by `testdata/vectors/vega-format.json` and the generated
 * differential `packages/conformance/scripts/differential-format.test.mts` / `-time-format.test.mts`. Forced by it:
 * - `formatFloat` with no precision rounds to 12 significant digits and trims zeros, and under a locale whose numerals
 *   are not ASCII digits that trim finds no digit and returns an empty string, as vega's does;
 * - `formatSpan` picks the precision from the tick step between the ends, and an `s` span formats through
 *   `formatPrefix` at the larger end (so every label of an axis shares one SI prefix);
 * - a time multi-format picks, per date, the coarsest unit the date sits exactly on (milliseconds when it is off every
 *   second, then seconds, minutes, hours, days, and month, year starts with the week and quarter variants);
 * - `defaultLocale` takes either no arguments (read) or both (set); anything else is an error.
 * Aster differs from vega on purpose in one place: the table is keyed through a Map, so a specifier such as
 * `constructor` is just an invalid specifier, not the inherited `Object` function.
 */
import {
  format as defaultNumberFormat, formatLocale, formatPrefix as defaultNumberFormatPrefix, formatSpecifier,
  precisionFixed, precisionPrefix, precisionRound, tickStep,
  type FormatLocaleDefinition, type FormatSpecifier,
} from './format.js'
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

/** Entries kept per formatter table; the least recently used is dropped past it. */
export const FORMATTER_CACHE_MAX = 512

/** `make`, remembered per `String(key)`, keeping the most recently used `FORMATTER_CACHE_MAX` results. */
function remember<A, T>(make: (key: A) => T): (key: A) => T {
  // a Map iterates in insertion order, so re-inserting on a hit keeps the oldest entry first
  const table = new Map<string, T>()
  let latest: string | undefined
  return (key) => {
    const id = String(key)
    const known = table.get(id)
    if (known !== undefined) {
      // asking again for the entry just used (a label loop) needs no reordering
      if (id !== latest) {
        table.delete(id)
        table.set(id, known)
        latest = id
      }
      return known
    }
    const made = make(key)
    table.set(id, made)
    latest = id
    if (table.size > FORMATTER_CACHE_MAX) table.delete(table.keys().next().value as string)
    return made
  }
}

// --- the number half --------------------------------------------------------------------------

type Formatter = (value: unknown) => string

interface NumberEngine {
  format(specifier: unknown): Formatter
  formatPrefix(specifier: unknown, value: number): Formatter
}

/**
 * Cut the zeros that end the fraction of a formatted number: the text after the last digit (an exponent, a unit) stays.
 * `decimal` is the locale's decimal mark. Text without a mark is returned as it is. When the text has a mark but no
 * ASCII digit follows it (a locale with its own numerals) nothing is left: vega-format returns an empty string there.
 */
function trimFraction(text: string, decimal: string): string {
  const mark = text.indexOf(decimal)
  if (mark < 0) return text
  let end = text.lastIndexOf('e')
  if (!(end > 0)) {
    end = NaN
    for (let i = text.length - 1; i > mark; i--) {
      const code = text.charCodeAt(i)
      if (code >= 48 && code <= 57) {
        end = i + 1
        break
      }
    }
  }
  if (Number.isNaN(end)) return ''
  const tail = end < text.length ? text.slice(end) : ''
  let keep = end
  while (--keep > mark) {
    if (text[keep] !== '0') {
      keep++
      break
    }
  }
  return text.slice(0, keep) + tail
}

function numberLocale(engine: NumberEngine) {
  const format = remember(engine.format)
  const { formatPrefix } = engine

  /** A specifier with the precision a span of ticks needs, when it has none and the type calls for one. */
  const withSpanPrecision = (spec: FormatSpecifier, step: number, largest: number): FormatSpecifier => {
    if (spec.precision != null) return spec
    switch (spec.type) {
      case '':
      case 'e':
      case 'g':
      case 'p':
      case 'r': {
        const precision = precisionRound(step, largest)
        if (!isNaN(precision)) spec.precision = precision - (spec.type === 'e' ? 1 : 0)
        break
      }
      case 'f':
      case '%': {
        const precision = precisionFixed(step)
        if (!isNaN(precision)) spec.precision = precision - (spec.type === '%' ? 2 : 0)
        break
      }
    }
    return spec
  }

  return {
    format,
    formatPrefix,
    /** Format a number with its natural precision: given, or 12 significant digits with the zeros trimmed. */
    formatFloat(specifier: unknown): Formatter {
      const spec = formatSpecifier(specifier || ',')
      if (spec.precision != null) return format(spec)
      spec.precision = spec.type === '%' ? 10 : spec.type === 'e' ? 11 : 12
      const decimal = format('.1f')(1)[1]!
      const rounded = format(spec)
      return (x) => trimFraction(rounded(x), decimal)
    },
    /** A formatter for tick labels spanning `start..stop` in about `count` ticks: just enough precision to tell them apart. */
    formatSpan(start: number, stop: number, count: number, specifier: unknown): Formatter {
      const spec = formatSpecifier(specifier == null ? ',f' : specifier)
      const step = tickStep(start, stop, count)
      const largest = Math.max(Math.abs(start), Math.abs(stop))
      if (spec.precision == null && spec.type === 's') {
        const precision = precisionPrefix(step, largest)
        if (!isNaN(precision)) spec.precision = precision
        return formatPrefix(spec, largest)
      }
      return format(withSpanPrecision(spec, step, largest))
    },
  }
}

type NumberLocale = ReturnType<typeof numberLocale>

function defaultNumberEngine(): NumberEngine {
  return { format: defaultNumberFormat, formatPrefix: defaultNumberFormatPrefix }
}

let currentNumber: NumberLocale = numberLocale(defaultNumberEngine())

export function resetNumberFormatDefaultLocale(): NumberLocale {
  return (currentNumber = numberLocale(defaultNumberEngine()))
}

export function numberFormatLocale(definition: FormatLocaleDefinition): NumberLocale {
  return numberLocale(formatLocale(definition))
}

/** With no argument, the default number locale; with one, replace it. */
export function numberFormatDefaultLocale(...definition: [FormatLocaleDefinition?]): NumberLocale {
  return definition.length ? (currentNumber = numberFormatLocale(definition[0] as FormatLocaleDefinition)) : currentNumber
}

// --- the time half --------------------------------------------------------------------------------

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

function timeLocale(engine: TimeEngine) {
  const local = remember(engine.format)
  const utc = remember(engine.utcFormat)
  return {
    timeFormat: (spec: unknown) => (isString(spec) ? local(spec) : multiFormat(local, timeIntervalFor, spec)),
    utcFormat: (spec: unknown) => (isString(spec) ? utc(spec) : multiFormat(utc, utcIntervalFor, spec)),
    timeParse: remember(engine.parse),
    utcParse: remember(engine.utcParse),
  }
}

type TimeLocale = ReturnType<typeof timeLocale>

function defaultTimeEngine(): TimeEngine {
  // read at the call: the engine's defaults are live bindings that `timeFormatDefaultLocale` of time-format.ts replaces
  return { format: defaultTimeFormat, parse: defaultTimeParse, utcFormat: defaultUtcFormat, utcParse: defaultUtcParse }
}

let currentTime: TimeLocale = timeLocale(defaultTimeEngine())

export function resetTimeFormatDefaultLocale(): TimeLocale {
  return (currentTime = timeLocale(defaultTimeEngine()))
}

export function timeFormatLocale(definition: TimeLocaleDefinition): TimeLocale {
  return timeLocale(makeTimeLocale(definition))
}

/** With no argument, the default time locale; with one, replace it. */
export function timeFormatDefaultLocale(...definition: [TimeLocaleDefinition?]): TimeLocale {
  return definition.length ? (currentTime = timeFormatLocale(definition[0] as TimeLocaleDefinition)) : currentTime
}

// --- both halves ------------------------------------------------------------------------------------

export type Locale = NumberLocale & TimeLocale

const join = (number: NumberLocale, time: TimeLocale): Locale => ({ ...number, ...time })

/** A locale from definitions; a missing half is the default one. */
export function locale(numberSpec?: FormatLocaleDefinition, timeSpec?: TimeLocaleDefinition): Locale {
  return join(numberSpec ? numberFormatLocale(numberSpec) : currentNumber, timeSpec ? timeFormatLocale(timeSpec) : currentTime)
}

let joined: { number: NumberLocale; time: TimeLocale; locale: Locale } | undefined

/**
 * The CURRENT default locale as one object, rebuilt only when either default changed. Callers that format repeatedly
 * (the expression `format` / `timeFormat`) read it per call, so a later `defaultLocale(...)` is honoured.
 */
export function currentLocale(): Locale {
  if (!joined || joined.number !== currentNumber || joined.time !== currentTime) {
    joined = { number: currentNumber, time: currentTime, locale: join(currentNumber, currentTime) }
  }
  return joined.locale
}

/** With no arguments, the default locale; with both definitions, replace the defaults. One argument is an error. */
export function defaultLocale(...definitions: [FormatLocaleDefinition?, TimeLocaleDefinition?]): Locale {
  if (definitions.length && definitions.length !== 2) error('defaultLocale expects either zero or two arguments.')
  return definitions.length
    ? join(numberFormatDefaultLocale(definitions[0] as FormatLocaleDefinition), timeFormatDefaultLocale(definitions[1] as TimeLocaleDefinition))
    : join(currentNumber, currentTime)
}

export function resetDefaultLocale(): Locale {
  resetNumberFormatDefaultLocale()
  resetTimeFormatDefaultLocale()
  return defaultLocale()
}
