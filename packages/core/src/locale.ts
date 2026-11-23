/**
 * Locales: the number and time formatters a chart reads text through, as one object.
 *
 * A locale offers `format`, `formatPrefix`, `formatFloat`, `formatSpan` (numbers) and `timeFormat`, `utcFormat`,
 * `timeParse`, `utcParse` (dates), built over the engines in `format.ts` and `time-format.ts` (the date half through locale-time.ts,
 * the `time` part of the engine, which it reads when a date is first formatted or parsed). Axis labels and
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
import type { TimeLocaleDefinition } from './time-format.js'
import { error, recentlyUsed } from './util.js'
import { part, type EngineParts } from './engine-parts.js'

/** Entries kept per formatter table; the least recently used is dropped past it. */
export const FORMATTER_CACHE_MAX = 512

/** `make`, remembered per `String(key)`, keeping the most recently used `FORMATTER_CACHE_MAX` results (see `recentlyUsed`). */
export function remember<A, T>(make: (key: A) => T, name = 'formatters'): (key: A) => T {
  return recentlyUsed(FORMATTER_CACHE_MAX, make, name)
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

/**
 * The time half of a locale: the four functions a chart formats and parses dates through. Their engine (the calendar, the time
 * formats, the multi-format of a time axis: locale-time.ts) is the `time` part of the engine (engine-parts.ts), read when one of them
 * is first called, so a chart that formats no date never needs it.
 */
export interface TimeLocale {
  timeFormat(spec: unknown): (value: unknown) => string
  utcFormat(spec: unknown): (value: unknown) => string
  timeParse(spec: string): (text: string) => Date | null
  utcParse(spec: string): (text: string) => Date | null
}

/**
 * A time locale made by `make` on its first use (the same one from then on). The part is read on every use, made or not: a slot that
 * is empty is refused however the locale got made (a chart that formats a date needs the time part, whatever ran before it).
 */
function lazyTimeLocale(make: (time: EngineParts['time']) => TimeLocale): TimeLocale {
  let made: TimeLocale | undefined
  const get = (): TimeLocale => {
    const time = part('time')
    return (made ??= make(time))
  }
  return {
    timeFormat: (spec) => get().timeFormat(spec),
    utcFormat: (spec) => get().utcFormat(spec),
    timeParse: (spec) => get().timeParse(spec),
    utcParse: (spec) => get().utcParse(spec),
  }
}

const defaultTimeLocale = (): TimeLocale => lazyTimeLocale((time) => time.defaultTimeLocale())

let currentTime: TimeLocale = defaultTimeLocale()

export function resetTimeFormatDefaultLocale(): TimeLocale {
  return (currentTime = defaultTimeLocale())
}

export function timeFormatLocale(definition: TimeLocaleDefinition): TimeLocale {
  return part('time').timeFormatLocale(definition)
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

const LOCALE_STAMPS = new WeakMap<object, number>()
let nextLocaleStamp = 0

/**
 * A number that names the current default locale (both halves): it changes whenever either default is replaced, and only then.
 * What an evaluation keeps from the one before was formatted under the locale of then (see `extraFp` in runtime.ts).
 */
function localeStamp(): number {
  const current = currentLocale()
  let stamp = LOCALE_STAMPS.get(current)
  if (stamp === undefined) LOCALE_STAMPS.set(current, (stamp = ++nextLocaleStamp))
  return stamp
}

/**
 * The host's time zone: a local date's parts (a `timeFormat`, a local time scale's ticks) are read in it, and a host may change it
 * while the process runs (Node reads `TZ` again when it is set; a browser follows the system's zone). Named by `TZ` where the host
 * has one, and by what the clock says at a few instants (the zone's long name and its offsets): reading the zone's name from `Intl`
 * costs a formatter per evaluation (about 0.1 ms). A zone switched to under a running page that has the same long name and the
 * same offsets at those instants as the one before is not told apart.
 */
function hostTimeZone(): string {
  const tz = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.TZ
  return `${tz ?? ''}|${new Date(0).toString()}|${new Date(6.6e11).getTimezoneOffset()}|${new Date(1.75e12).getTimezoneOffset()}`
}

/**
 * What text and local dates are made under besides the spec and the input: the default locale (`localeStamp`) and the host's time
 * zone. Whatever is kept from an earlier evaluation (a kept mark, a scene a session hands back unchanged) was made under the key of
 * then, so it is part of every such key.
 */
export function formatEnvironmentKey(): string {
  return `${localeStamp()}\u0001${hostTimeZone()}`
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
