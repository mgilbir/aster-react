/**
 * Date formatting and parsing with strftime-style specifiers (`%Y-%m-%d`, `%-I:%M %p`, `%b %e`...), for axis labels,
 * `timeFormat()` expressions and the `parse` of date fields.
 *
 * Design. A locale is built once from its names and patterns. Each directive is defined once and instantiated for the
 * two time bases (local and UTC) over a `Base` (the zone's field readers plus the intervals week numbers are counted
 * with). A specifier is compiled to a list of steps the first time it is used and the steps are replayed per date; the
 * parser keeps what it reads in a record of date fields and builds the Date at the end. Directives that expand to a
 * locale pattern (`%c %x %X`) compile their pattern lazily, so a pattern that refers to itself fails when it is used,
 * not when the locale is made.
 *
 * Output is held identical to d3-time-format for every specifier, date and string by the recorded vectors of the
 * locale facade (`testdata/vectors/vega-format.json`) and the generated differential
 * (`packages/conformance/scripts/differential-time-format.test.mts`). Behaviour-forced, not chosen:
 * - an unknown directive prints as its letter (`%K` is `K`), a lone trailing `%` or `%-` prints nothing;
 * - a numeric directive reads at most its width in characters after optional leading whitespace, so `%d%m` parses
 *   `1203` as the 12th of March and `%Y` reads four characters;
 * - parsing is exact: the whole string must be consumed and the specifier's literals must match, case-sensitively;
 * - names match case-insensitively, trying the locale's names in order (not the longest), and map to the LAST index of
 *   equal names;
 * - `%Z` reads `+hhmm`/`+hh:mm`/`Z` and applies it as a signed hhmm integer: hours are the truncated Z / 100, minutes
 *   the remainder, so half-hour offsets work;
 * - a parsed two-digit year is 1969..2068; `%Q` and `%s` win over every other field; ISO weeks are 1..53.
 */
import {
  localDate, localZone, timeDay, timeMonday, timeSunday, timeThursday, timeYear,
  utcDate, utcDay, utcMonday, utcSunday, utcThursday, utcYear, utcZone,
  type TimeInterval, type Zone,
} from './time.js'

// --- locales --------------------------------------------------------------------------------

export interface TimeLocaleDefinition {
  dateTime?: string
  date?: string
  time?: string
  periods?: readonly string[]
  days?: readonly string[]
  shortDays?: readonly string[]
  months?: readonly string[]
  shortMonths?: readonly string[]
}

type Formatter = ((date: unknown) => string) & { toString(): string }
type Parser = ((text: string) => Date | null) & { toString(): string }

export interface TimeFormatLocale {
  format(specifier: string): Formatter
  parse(specifier: string): Parser
  utcFormat(specifier: string): Formatter
  utcParse(specifier: string): Parser
}

// --- padding -------------------------------------------------------------------------------------

/** The padding modifiers: `%-d` none, `%_d` spaces, `%0d` zeros. */
const PAD_MODIFIERS: Record<string, string> = { '-': '', '_': ' ', '0': '0' }

function padded(value: number, fill: string, width: number): string {
  const sign = value < 0 ? '-' : ''
  const digits = (sign ? -value : value) + ''
  return sign + (digits.length < width ? fill.repeat(width - digits.length) + digits : digits)
}

// --- the two time bases -------------------------------------------------------------------------------

interface Base {
  zone: Zone
  year: TimeInterval
  day: TimeInterval
  sunday: TimeInterval
  monday: TimeInterval
  thursday: TimeInterval
  /** The `%Z` text. */
  offsetText(d: Date): string
  /** A Date from fields (month and day may overflow into the next unit). */
  build(y: number, m: number, d: number, H: number, M: number, S: number, L: number): Date
}

const LOCAL_BASE: Base = {
  zone: localZone,
  year: timeYear,
  day: timeDay,
  sunday: timeSunday,
  monday: timeMonday,
  thursday: timeThursday,
  offsetText(d) {
    let behind = d.getTimezoneOffset()
    const sign = behind > 0 ? '-' : (behind *= -1, '+')
    return sign + padded(behind / 60 | 0, '0', 2) + padded(behind % 60, '0', 2)
  },
  build: localDate,
}

const UTC_BASE: Base = {
  zone: utcZone,
  year: utcYear,
  day: utcDay,
  sunday: utcSunday,
  monday: utcMonday,
  thursday: utcThursday,
  offsetText: () => '+0000',
  build: utcDate,
}

// --- formatting ------------------------------------------------------------------------------------------

type Emit = (date: Date, pad: string) => string | number | undefined

interface Names {
  periods: readonly string[]
  days: readonly string[]
  shortDays: readonly string[]
  months: readonly string[]
  shortMonths: readonly string[]
}

/** The Thursday of a date's ISO week: the date itself when it falls Thursday..Sunday, else the coming Thursday. */
function isoThursday(base: Base, d: Date): Date {
  const day = base.zone.day(d)
  return day >= 4 || day === 0 ? base.thursday(d) : base.thursday.ceil(d)
}

/** One locale's output directives over one time base. `pattern(key)` expands a locale pattern (`%c`, `%x`, `%X`). */
function emitters(base: Base, names: Names, pattern: (key: 'dateTime' | 'date' | 'time') => (date: Date) => string): Record<string, Emit> {
  const z = base.zone
  const weekCount = (interval: TimeInterval, d: Date, pad: string): string => padded(interval.count!(+base.year(d) - 1, d), pad, 2)
  return {
    a: (d) => names.shortDays[z.day(d)],
    A: (d) => names.days[z.day(d)],
    b: (d) => names.shortMonths[z.month(d)],
    B: (d) => names.months[z.month(d)],
    c: (d) => pattern('dateTime')(d),
    d: (d, p) => padded(z.date(d), p, 2),
    e: (d, p) => padded(z.date(d), p, 2),
    f: (d, p) => padded(z.ms(d), p, 3) + '000',
    g: (d, p) => padded(z.year(isoThursday(base, d)) % 100, p, 2),
    G: (d, p) => padded(z.year(isoThursday(base, d)) % 10000, p, 4),
    H: (d, p) => padded(z.hour(d), p, 2),
    I: (d, p) => padded(z.hour(d) % 12 || 12, p, 2),
    j: (d, p) => padded(1 + base.day.count!(base.year(d), d), p, 3),
    L: (d, p) => padded(z.ms(d), p, 3),
    m: (d, p) => padded(z.month(d) + 1, p, 2),
    M: (d, p) => padded(z.min(d), p, 2),
    p: (d) => names.periods[+(z.hour(d) >= 12)],
    q: (d) => 1 + ~~(z.month(d) / 3),
    Q: (d) => +d,
    s: (d) => Math.floor(+d / 1000),
    S: (d, p) => padded(z.sec(d), p, 2),
    u: (d) => {
      const day = z.day(d)
      return day === 0 ? 7 : day
    },
    U: (d, p) => weekCount(base.sunday, d, p),
    V: (d, p) => {
      const thursday = isoThursday(base, d)
      const firstOfYear = base.year(thursday)
      return padded(base.thursday.count!(firstOfYear, thursday) + (z.day(firstOfYear) === 4 ? 1 : 0), p, 2)
    },
    w: (d) => z.day(d),
    W: (d, p) => weekCount(base.monday, d, p),
    x: (d) => pattern('date')(d),
    X: (d) => pattern('time')(d),
    y: (d, p) => padded(z.year(d) % 100, p, 2),
    Y: (d, p) => padded(z.year(d) % 10000, p, 4),
    Z: (d) => base.offsetText(d),
    '%': () => '%',
  }
}

type Step = (date: Date) => string | number | undefined

/** Compile a specifier into steps: literal runs, and directives with the padding they were written with. */
function compileFormat(specifier: string, table: Record<string, Emit>): Step[] {
  const steps: Step[] = []
  let literalFrom = 0
  let i = 0
  const n = specifier.length
  while (i < n) {
    if (specifier.charCodeAt(i) !== 37) {
      i++
      continue
    }
    if (i > literalFrom) steps.push(literal(specifier.slice(literalFrom, i)))
    let letter = specifier.charAt(++i)
    let pad = PAD_MODIFIERS[letter]
    if (pad !== undefined) letter = specifier.charAt(++i)
    else pad = letter === 'e' ? ' ' : '0'
    const emit = table[letter]
    const fill = pad
    steps.push(emit ? (date) => emit(date, fill) : literal(letter))
    literalFrom = ++i
  }
  if (literalFrom < n) steps.push(literal(specifier.slice(literalFrom)))
  return steps
}

const literal = (text: string): Step => () => text

function runSteps(steps: readonly Step[], date: unknown): string {
  const d = date instanceof Date ? date : new Date(+(date as number))
  let out = ''
  for (const step of steps) out += step(d) ?? ''
  return out
}

// --- parsing -----------------------------------------------------------------------------------------------

/** What a parse has read so far; a field is "present" once a directive stored it (even as undefined). */
interface Fields {
  y?: number; m?: number; d?: number; H?: number; M?: number; S?: number; L?: number
  p?: number; q?: number; u?: number; U?: number; V?: number; W?: number; w?: number
  Z?: number; Q?: number; s?: number
}

/** Reads from `text` at `at`; returns the index after what it consumed, or -1. */
type Rule = (fields: Fields, text: string, at: number) => number

const LEADING_NUMBER = /^\s*\d+/
const ZONE_OFFSET = /^(Z)|([+-]\d\d)(?::?(\d\d))?/

/** A rule for a run of at most `width` digits (any number when omitted), after optional whitespace. */
const numeric = (width: number | undefined, store: (fields: Fields, n: number) => void): Rule => (fields, text, at) => {
  const m = LEADING_NUMBER.exec(width === undefined ? text.slice(at) : text.slice(at, at + width))
  if (!m) return -1
  store(fields, +m[0])
  return at + m[0].length
}

const twoDigitYear = (n: number): number => n + (n > 68 ? 1900 : 2000)

const NUMERIC_RULES: Record<string, Rule> = {
  d: numeric(2, (f, n) => { f.d = n }),
  e: numeric(2, (f, n) => { f.d = n }),
  f: numeric(6, (f, n) => { f.L = Math.floor(n / 1000) }),
  g: numeric(2, (f, n) => { f.y = twoDigitYear(n) }),
  G: numeric(4, (f, n) => { f.y = n }),
  H: numeric(2, (f, n) => { f.H = n }),
  I: numeric(2, (f, n) => { f.H = n }),
  j: numeric(3, (f, n) => { f.m = 0; f.d = n }),
  L: numeric(3, (f, n) => { f.L = n }),
  m: numeric(2, (f, n) => { f.m = n - 1 }),
  M: numeric(2, (f, n) => { f.M = n }),
  q: numeric(1, (f, n) => { f.q = n * 3 - 3 }),
  Q: numeric(undefined, (f, n) => { f.Q = n }),
  s: numeric(undefined, (f, n) => { f.s = n }),
  S: numeric(2, (f, n) => { f.S = n }),
  u: numeric(1, (f, n) => { f.u = n }),
  U: numeric(2, (f, n) => { f.U = n }),
  V: numeric(2, (f, n) => { f.V = n }),
  w: numeric(1, (f, n) => { f.w = n }),
  W: numeric(2, (f, n) => { f.W = n }),
  y: numeric(2, (f, n) => { f.y = twoDigitYear(n) }),
  Y: numeric(4, (f, n) => { f.y = n }),
  Z: (f, text, at) => {
    const m = ZONE_OFFSET.exec(text.slice(at, at + 6))
    if (!m) return -1
    // "+0130" becomes the signed integer -130 hhmm; the final step splits it with / 100 and % 100
    f.Z = m[1] ? 0 : -((m[2] as string) + (m[3] || '00')) as unknown as number
    return at + m[0].length
  },
  '%': (_f, text, at) => (text.charAt(at) === '%' ? at + 1 : -1),
}

const escapeForPattern = (name: string): string => name.replace(/[\\^$*+?|[\]().{}]/g, '\\$&')

/** A rule matching one of `names` (case-insensitively, first listed first) and storing its index in `field`. */
function nameRule(names: readonly string[], field: 'p' | 'w' | 'm'): Rule {
  const pattern = new RegExp('^(?:' + names.map(escapeForPattern).join('|') + ')', 'i')
  const index = new Map(names.map((name, i) => [name.toLowerCase(), i]))
  return (fields, text, at) => {
    const m = pattern.exec(text.slice(at))
    if (!m) return -1
    fields[field] = index.get(m[0].toLowerCase())
    return at + m[0].length
  }
}

/** Run a specifier against `text` from `at`; the index after it, or -1. */
function readSpecifier(rules: Record<string, Rule>, fields: Fields, specifier: string, text: string, at: number): number {
  let i = 0
  const n = specifier.length
  while (i < n) {
    if (at >= text.length) return -1
    let c = specifier[i++]!
    if (c === '%') {
      c = specifier[i++]!
      const rule = rules[c in PAD_MODIFIERS ? specifier[i++]! : c]
      if (!rule || (at = rule(fields, text, at)) < 0) return -1
    } else if (c !== text[at++]) {
      return -1
    }
  }
  return at
}

/** Turn what was read into a Date (null when the fields cannot name one). */
function assemble(f: Fields, utc: boolean): Date | null {
  if ('Q' in f) return new Date(f.Q!)
  if ('s' in f) return new Date(f.s! * 1000 + ('L' in f ? f.L! : 0))
  if (utc && !('Z' in f)) f.Z = 0
  if ('p' in f) f.H = f.H! % 12 + f.p! * 12
  if (f.m === undefined) f.m = 'q' in f ? f.q : 0
  const zoned = 'Z' in f
  const base = zoned ? UTC_BASE : LOCAL_BASE
  const z = base.zone
  if ('V' in f) {
    if (f.V! < 1 || f.V! > 53) return null
    if (!('w' in f)) f.w = 1
    const jan1 = base.build(f.y!, 0, 1, 0, 0, 0, 0)
    const day = z.day(jan1)
    const monday = day > 4 || day === 0 ? base.monday.ceil(jan1) : base.monday(jan1)
    const firstOfWeek = base.day.offset(monday, (f.V! - 1) * 7)
    f.y = z.year(firstOfWeek)
    f.m = z.month(firstOfWeek)
    f.d = z.date(firstOfWeek) + (f.w! + 6) % 7
  } else if ('W' in f || 'U' in f) {
    if (!('w' in f)) f.w = 'u' in f ? f.u! % 7 : 'W' in f ? 1 : 0
    const day = z.day(base.build(f.y!, 0, 1, 0, 0, 0, 0))
    f.m = 0
    f.d = 'W' in f ? (f.w! + 6) % 7 + f.W! * 7 - (day + 5) % 7 : f.w! + f.U! * 7 - (day + 6) % 7
  }
  if (zoned) {
    f.H = f.H! + (f.Z! / 100 | 0)
    f.M = f.M! + f.Z! % 100
    return utcDate(f.y!, f.m!, f.d!, f.H!, f.M!, f.S!, f.L!)
  }
  return localDate(f.y!, f.m!, f.d!, f.H!, f.M!, f.S!, f.L!)
}

// --- building a locale -----------------------------------------------------------------------------------------

function withText<F extends (...args: never[]) => unknown>(fn: F, text: string): F & { toString(): string } {
  ;(fn as unknown as { toString(): string }).toString = () => text
  return fn as F & { toString(): string }
}

export function timeFormatLocale(definition: TimeLocaleDefinition): TimeFormatLocale {
  const { dateTime, date, time } = definition
  const patterns = { dateTime, date, time }
  // building the matchers is what rejects a definition without the name lists (a TypeError, as in d3-time-format)
  const { periods, days, shortDays, months, shortMonths } = definition as unknown as Names
  const periodRule = nameRule(periods, 'p')
  const weekdayRule = nameRule(days, 'w')
  const shortWeekdayRule = nameRule(shortDays, 'w')
  const monthRule = nameRule(months, 'm')
  const shortMonthRule = nameRule(shortMonths, 'm')
  const heldNames: Names = { periods, days, shortDays, months, shortMonths }

  const formatTables = new Map<Base, Record<string, Emit>>()
  const tableFor = (base: Base): Record<string, Emit> => {
    let table = formatTables.get(base)
    if (!table) {
      const cache = new Map<string, Step[]>()
      table = emitters(base, heldNames, (key) => (d) => {
        const text = patterns[key] as string
        let steps = cache.get(key)
        if (!steps) cache.set(key, steps = compileFormat(text, formatTables.get(base)!))
        return runSteps(steps, d)
      })
      formatTables.set(base, table)
    }
    return table
  }

  const rules: Record<string, Rule> = {
    ...NUMERIC_RULES,
    a: shortWeekdayRule,
    A: weekdayRule,
    b: shortMonthRule,
    B: monthRule,
    p: periodRule,
    c: (f, text, at) => readSpecifier(rules, f, patterns.dateTime as string, text, at),
    x: (f, text, at) => readSpecifier(rules, f, patterns.date as string, text, at),
    X: (f, text, at) => readSpecifier(rules, f, patterns.time as string, text, at),
  }

  const formatter = (base: Base) => (specifier: string): Formatter => {
    const text = specifier + ''
    const steps = compileFormat(text, tableFor(base))
    return withText((date: unknown) => runSteps(steps, date), text)
  }
  const parser = (utc: boolean) => (specifier: string): Parser => {
    const text = specifier + ''
    return withText((input: string) => {
      const fields: Fields = { y: 1900, m: undefined, d: 1, H: 0, M: 0, S: 0, L: 0 }
      const source = input + ''
      return readSpecifier(rules, fields, text, source, 0) !== source.length ? null : assemble(fields, utc)
    }, text)
  }

  return {
    format: formatter(LOCAL_BASE),
    parse: parser(false),
    utcFormat: formatter(UTC_BASE),
    utcParse: parser(true),
  }
}

// --- the en-US default locale --------------------------------------------------------------------------------------

const EN_US: Required<TimeLocaleDefinition> = {
  dateTime: '%x, %X',
  date: '%-m/%-d/%Y',
  time: '%-I:%M:%S %p',
  periods: ['AM', 'PM'],
  days: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
  shortDays: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
  months: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
  shortMonths: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
}

export let timeFormat: TimeFormatLocale['format']
export let timeParse: TimeFormatLocale['parse']
export let utcFormat: TimeFormatLocale['utcFormat']
export let utcParse: TimeFormatLocale['utcParse']

timeFormatDefaultLocale(EN_US)

/** Replace the default locale behind `timeFormat`, `timeParse`, `utcFormat` and `utcParse`. */
export function timeFormatDefaultLocale(definition: TimeLocaleDefinition): TimeFormatLocale {
  const locale = timeFormatLocale(definition)
  ;({ format: timeFormat, parse: timeParse, utcFormat, utcParse } = locale)
  return locale
}

// --- ISO 8601 ----------------------------------------------------------------------------------------------------------

export const isoSpecifier = '%Y-%m-%dT%H:%M:%S.%LZ'

export function isoFormat(date: Date): string {
  return date.toISOString()
}

/** Parse any string `Date` accepts; null when it is not a date. */
export function isoParse(text: string): Date | null {
  const date = new Date(text)
  return isNaN(+date) ? null : date
}
