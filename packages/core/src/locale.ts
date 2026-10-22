/**
 * The locale facade — a faithful port of vega-format (2.1.2), joining the
 * number-format engine (`./format.ts`) with the time-format engine
 * (`./time-format.ts`) into the locale object the runtime and the expression
 * functions consume. Pinned by oracle vectors recorded from the pinned
 * vega-format (`testdata/vectors/vega-format.json`).
 *
 * The memoized surfaces matter for performance: `format`/`timeFormat`/
 * `utcFormat`/`timeParse`/`utcParse` cache compiled formatters per specifier,
 * since axis labels and expression functions reformat thousands of values
 * through one spec.
 */
import {
  format as d3Format, formatLocale as d3FormatLocale,
  formatPrefix as d3FormatPrefix, formatSpecifier, precisionFixed,
  precisionPrefix, precisionRound, tickStep,
  type FormatLocaleDefinition,
} from './format.js'
import {
  timeFormat as d3TimeFormat, timeFormatDefaultLocale as d3TimeFormatDefaultLocale,
  timeFormatLocale as d3TimeFormatLocale, timeParse as d3TimeParse,
  utcFormat as d3UtcFormat, utcParse as d3UtcParse,
  type TimeLocaleDefinition,
} from './time-format.js'
import { DATE, DAY, HOURS, MILLISECONDS, MINUTES, MONTH, QUARTER, SECONDS, WEEK, YEAR, timeIntervalFor, utcIntervalFor } from './time.js'
import { error, isObject, isString } from './util.js'

/** Cache compiled formatters per specifier (vega-format's memoize). */
function memoize<T, A>(method: (arg: A) => T): (arg: A) => T {
  // a Map: the specifier is spec/data-supplied (`constructor`, `__proto__`, ...)
  // prototype-less: the specifier is spec/data-supplied (`constructor`, `__proto__`, ...)
  const cache = Object.create(null) as Record<string, T>
  return (spec: A) => cache[String(spec)] || (cache[String(spec)] = method(spec))
}

function rightmostDigit(str: string, dec: number): number {
  let i = str.lastIndexOf('e')
  if (i > 0) return i
  let c: number
  for (i = str.length; --i > dec;) {
    c = str.charCodeAt(i)
    if (c >= 48 && c <= 57) return i + 1 // is digit
  }
  return i
}

function trimZeroes(numberFormat: (x: number) => string, decimalChar: string): (x: number) => string {
  return (x) => {
    const str = numberFormat(x)
    const dec = str.indexOf(decimalChar)
    if (dec < 0) return str
    let idx = rightmostDigit(str, dec)
    const end = idx < str.length ? str.slice(idx) : ''
    while (--idx > dec) if (str[idx] !== '0') { ++idx; break }
    return str.slice(0, idx) + end
  }
}

type NumberFormat = (spec: unknown) => (v: unknown) => string

/** The number half of a locale: memoized format/prefix plus the tick formatters. */
function numberLocale(locale: { format: NumberFormat; formatPrefix: (spec: unknown, value: number) => (v: unknown) => string }) {
  const format = memoize(locale.format)
  const formatPrefix = locale.formatPrefix
  return {
    format,
    formatPrefix,
    formatFloat(spec: unknown) {
      const s = formatSpecifier(spec || ',')
      if (s.precision == null) {
        s.precision = 12
        switch (s.type) {
          case '%': s.precision = (s.precision as number) - 2; break
          case 'e': s.precision = (s.precision as number) - 1; break
        }
        return trimZeroes(
          format(s),          // number format
          format('.1f')(1)[1] as string, // decimal point character
        )
      } else {
        return format(s)
      }
    },
    formatSpan(start: number, stop: number, count: number, specifier: unknown) {
      const spec = formatSpecifier(specifier == null ? ',f' : specifier)
      const step = tickStep(start, stop, count)
      const value = Math.max(Math.abs(start), Math.abs(stop))
      let precision: number
      if (spec.precision == null) {
        switch (spec.type) {
          case 's': {
            precision = precisionPrefix(step, value)
            if (!isNaN(precision)) {
              spec.precision = precision
            }
            return formatPrefix(spec, value)
          }
          case '':
          case 'e':
          case 'g':
          case 'p':
          case 'r': {
            precision = precisionRound(step, value)
            if (!isNaN(precision)) {
              spec.precision = precision - (spec.type === 'e' ? 1 : 0)
            }
            break
          }
          case 'f':
          case '%': {
            precision = precisionFixed(step)
            if (!isNaN(precision)) {
              spec.precision = precision - (spec.type === '%' ? 2 : 0)
            }
            break
          }
        }
      }
      return format(spec)
    },
  }
}

let defaultNumberLocale: ReturnType<typeof numberLocale>

resetNumberFormatDefaultLocale()

export function resetNumberFormatDefaultLocale(): ReturnType<typeof numberLocale> {
  return defaultNumberLocale = numberLocale({
    format: d3Format,
    formatPrefix: d3FormatPrefix,
  })
}

export function numberFormatLocale(definition: FormatLocaleDefinition): ReturnType<typeof numberLocale> {
  return numberLocale(d3FormatLocale(definition))
}

export function numberFormatDefaultLocale(definition?: FormatLocaleDefinition): ReturnType<typeof numberLocale> {
  return arguments.length
    ? (defaultNumberLocale = numberFormatLocale(definition as FormatLocaleDefinition))
    : defaultNumberLocale
}

// --- the time half -----------------------------------------------------------

type TimeFormat = (spec: string) => (v: unknown) => string

function timeMultiFormat(
  format: TimeFormat,
  interval: (unit: string) => (import('./time.js').TimeInterval | undefined),
  spec: unknown,
): (date: unknown) => string {
  spec = spec || {}
  if (!isObject(spec)) {
    error(`Invalid time multi-format specifier: ${spec}`)
  }
  const s = spec as Record<string, string>
  const second = interval(SECONDS)!
  const minute = interval(MINUTES)!
  const hour = interval(HOURS)!
  const day = interval(DATE)!
  const week = interval(WEEK)!
  const month = interval(MONTH)!
  const quarter = interval(QUARTER)!
  const year = interval(YEAR)!
  const L = format(s[MILLISECONDS] || '.%L')
  const S = format(s[SECONDS] || ':%S')
  const M = format(s[MINUTES] || '%I:%M')
  const H = format(s[HOURS] || '%I %p')
  const d = format(s[DATE] || s[DAY] || '%a %d')
  const w = format(s[WEEK] || '%b %d')
  const m = format(s[MONTH] || '%B')
  const q = format(s[QUARTER] || '%B')
  const y = format(s[YEAR] || '%Y')
  return (date: unknown) => (
    second(date as Date) < (date as Date) ? L :
    minute(date as Date) < (date as Date) ? S :
    hour(date as Date) < (date as Date) ? M :
    day(date as Date) < (date as Date) ? H :
    month(date as Date) < (date as Date) ? (week(date as Date) < (date as Date) ? d : w) :
    year(date as Date) < (date as Date) ? (quarter(date as Date) < (date as Date) ? m : q) :
    y)(date)
}

function timeLocale(locale: {
  format: TimeFormat
  parse: (spec: string) => (s: string) => Date | null
  utcFormat: TimeFormat
  utcParse: (spec: string) => (s: string) => Date | null
}) {
  const timeFormat = memoize(locale.format)
  const utcFormat = memoize(locale.utcFormat)
  return {
    timeFormat: (spec: unknown) => isString(spec)
      ? timeFormat(spec)
      : timeMultiFormat(timeFormat, timeIntervalFor, spec),
    utcFormat: (spec: unknown) => isString(spec)
      ? utcFormat(spec)
      : timeMultiFormat(utcFormat, utcIntervalFor, spec),
    timeParse: memoize(locale.parse),
    utcParse: memoize(locale.utcParse),
  }
}

let defaultTimeLocale: ReturnType<typeof timeLocale>

resetTimeFormatDefaultLocale()

export function resetTimeFormatDefaultLocale(): ReturnType<typeof timeLocale> {
  return defaultTimeLocale = timeLocale({
    format: d3TimeFormat,
    parse: d3TimeParse,
    utcFormat: d3UtcFormat,
    utcParse: d3UtcParse,
  })
}

export function timeFormatLocale(definition: TimeLocaleDefinition): ReturnType<typeof timeLocale> {
  return timeLocale(d3TimeFormatLocale(definition))
}

export function timeFormatDefaultLocale(definition?: TimeLocaleDefinition): ReturnType<typeof timeLocale> {
  return arguments.length
    ? (defaultTimeLocale = timeFormatLocale(definition as TimeLocaleDefinition))
    : defaultTimeLocale
}

// --- the combined locale -----------------------------------------------------

export type Locale = ReturnType<typeof numberLocale> & ReturnType<typeof timeLocale>

const createLocale = (number: ReturnType<typeof numberLocale>, time: ReturnType<typeof timeLocale>): Locale =>
  ({ ...number, ...time })

/** The locale object: `format`, `formatPrefix`, `formatFloat`, `formatSpan`,
 *  `timeFormat`, `utcFormat`, `timeParse`, `utcParse`. */
export function locale(numberSpec?: FormatLocaleDefinition, timeSpec?: TimeLocaleDefinition): Locale {
  const number = numberSpec
    ? numberFormatLocale(numberSpec)
    : numberFormatDefaultLocale()
  const time = timeSpec
    ? timeFormatLocale(timeSpec)
    : defaultTimeLocale
  return createLocale(number, time)
}

/** Read or set the default locale for both engines (vega-format's `defaultLocale`). */
export function defaultLocale(numberSpec?: FormatLocaleDefinition, timeSpec?: TimeLocaleDefinition): Locale {
  const args = arguments.length
  if (args && args !== 2) {
    error('defaultLocale expects either zero or two arguments.')
  }
  return args
    ? createLocale(
        numberFormatDefaultLocale(numberSpec),
        timeFormatDefaultLocale(timeSpec),
      )
    : createLocale(
        numberFormatDefaultLocale(),
        timeFormatDefaultLocale(),
      )
}

export function resetDefaultLocale(): Locale {
  resetNumberFormatDefaultLocale()
  resetTimeFormatDefaultLocale()
  return defaultLocale()
}
