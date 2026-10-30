/**
 * Number formatting — a faithful port of d3-format (3.1.2), pinned by oracle
 * vectors (`testdata/vectors/d3-format.json`).
 *
 * The grammar is `[[fill]align][sign][symbol][0][width][,][.precision][~][type]`.
 * Nothing is clamped or "fixed": the quirks are upstream's, e.g. `format("")`
 * is `,.12~g`, the `n` type is an alias for `,g`, `-0` keeps its sign only via
 * `1 / value < 0`, and values ≥ 1e21 go through `toLocaleString("en")`.
 */

import { meterBytes } from './limits.js'

// --- decimal expansion -------------------------------------------------------

/**
 * The decimal coefficient and exponent of `x` with `p` significant digits,
 * where `x` is positive and `p` is in [1, 21] or undefined.
 * `formatDecimalParts(1.23)` returns `["123", 0]`.
 */
export function formatDecimalParts(x: number, p?: number): [string, number] | null {
  if (!isFinite(x) || x === 0) return null // NaN, ±Infinity, ±0
  const s = p ? x.toExponential(p - 1) : x.toExponential()
  const i = s.indexOf('e')
  const coefficient = s.slice(0, i)
  // The string returned by toExponential either has the form \d\.\d+e[-+]\d+
  // (e.g., 1.2e+3) or the form \de[-+]\d+ (e.g., 1e+3).
  return [
    coefficient.length > 1 ? coefficient[0]! + coefficient.slice(2) : coefficient,
    +s.slice(i + 1),
  ]
}

/** Integer formatting for the `d` type. */
export function formatDecimal(x: number): string {
  return Math.abs(x = Math.round(x)) >= 1e21
    ? x.toLocaleString('en').replace(/,/g, '')
    : x.toString(10)
}

// --- trim, grouping, numerals ------------------------------------------------

/** Trims insignificant zeros, e.g., replaces 1.2000k with 1.2k. */
export function formatTrim(s: string): string {
  let i0 = -1
  let i1: number | undefined
  out: for (let n = s.length, i = 1; i < n; ++i) {
    switch (s[i]) {
      case '.': i0 = i1 = i; break
      case '0': if (i0 === 0) i0 = i; i1 = i; break
      default: if (!+(s[i] as string)) break out; if (i0 > 0) i0 = 0; break
    }
  }
  return i0 > 0 ? s.slice(0, i0) + s.slice((i1 as number) + 1) : s
}

export function formatGroup(grouping: readonly number[], thousands: string): (value: string, width: number) => string {
  return function (value, width) {
    let i = value.length
    const t: string[] = []
    let j = 0
    let g = grouping[0] as number
    let length = 0
    while (i > 0 && g > 0) {
      if (length + g + 1 > width) g = Math.max(1, width - length)
      t.push(value.substring((i -= g), i + g))
      if ((length += g + 1) > width) break
      g = grouping[j = (j + 1) % grouping.length] as number
    }
    return t.reverse().join(thousands)
  }
}

export function formatNumerals(numerals: readonly string[]): (value: string) => string {
  return (value) => value.replace(/[0-9]/g, (i) => numerals[+i] as string)
}

// --- exponent and precisions -------------------------------------------------

export function exponent(x: number): number {
  const d = formatDecimalParts(Math.abs(x))
  return d ? d[1] : NaN
}

export function precisionFixed(step: number): number {
  return Math.max(0, -exponent(Math.abs(step)))
}

export function precisionPrefix(step: number, value: number): number {
  return Math.max(0, Math.max(-8, Math.min(8, Math.floor(exponent(value) / 3))) * 3 - exponent(Math.abs(step)))
}

export function precisionRound(step: number, max: number): number {
  step = Math.abs(step)
  max = Math.abs(max) - step
  return Math.max(0, exponent(max) - exponent(step)) + 1
}

export { tickStep } from './arr.js'

// --- the specifier -----------------------------------------------------------

// [[fill]align][sign][symbol][0][width][,][.precision][~][type]
const re = /^(?:(.)?([<>=^]))?([+\-( ])?([$#])?(0)?(\d+)?(,)?(\.\d+)?(~)?([a-z%])?$/i

export class FormatSpecifier {
  fill: string
  align: string
  sign: string
  symbol: string
  zero: boolean
  width: number | undefined
  comma: boolean
  precision: number | undefined
  trim: boolean
  type: string

  constructor(specifier: Partial<FormatSpecifierSpec>) {
    this.fill = specifier.fill === undefined ? ' ' : specifier.fill + ''
    this.align = specifier.align === undefined ? '>' : specifier.align + ''
    this.sign = specifier.sign === undefined ? '-' : specifier.sign + ''
    this.symbol = specifier.symbol === undefined ? '' : specifier.symbol + ''
    this.zero = !!specifier.zero
    this.width = specifier.width === undefined ? undefined : +specifier.width
    this.comma = !!specifier.comma
    this.precision = specifier.precision === undefined ? undefined : +specifier.precision
    this.trim = !!specifier.trim
    this.type = specifier.type === undefined ? '' : specifier.type + ''
  }

  toString(): string {
    return this.fill
      + this.align
      + this.sign
      + this.symbol
      + (this.zero ? '0' : '')
      + (this.width === undefined ? '' : Math.max(1, this.width | 0))
      + (this.comma ? ',' : '')
      + (this.precision === undefined ? '' : '.' + Math.max(0, this.precision | 0))
      + (this.trim ? '~' : '')
      + this.type
  }
}

export interface FormatSpecifierSpec {
  fill?: string
  align?: string
  sign?: string
  symbol?: string
  zero?: string | boolean
  width?: string | number
  comma?: string | boolean
  precision?: string | number
  trim?: string | boolean
  type?: string
}

/** Parse a specifier string, throwing on a malformed one (as upstream). */
export function formatSpecifier(specifier: unknown): FormatSpecifier {
  const match = re.exec(String(specifier))
  if (!match) throw new Error('invalid format: ' + specifier)
  return new FormatSpecifier({
    fill: match[1],
    align: match[2],
    sign: match[3],
    symbol: match[4],
    zero: match[5],
    width: match[6],
    comma: match[7],
    precision: match[8] && match[8].slice(1),
    trim: match[9],
    type: match[10],
  })
}

// --- the numeric types -------------------------------------------------------

let prefixExponent: number | undefined

/** The `s` type: SI prefixes, chosen by the value's magnitude. */
export function formatPrefixAuto(x: number, p: number): string {
  const d = formatDecimalParts(x, p)
  if (!d) return prefixExponent = undefined, x.toPrecision(p)
  const coefficient = d[0]
  const exp = d[1]
  const i = exp - (prefixExponent = Math.max(-8, Math.min(8, Math.floor(exp / 3))) * 3) + 1
  const n = coefficient.length
  return i === n ? coefficient
    : i > n ? coefficient + new Array(i - n + 1).join('0')
    : i > 0 ? coefficient.slice(0, i) + '.' + coefficient.slice(i)
    : '0.' + new Array(1 - i).join('0') + formatDecimalParts(x, Math.max(0, p + i - 1))![0]
}

/** The `r` and `p` types: rounded to significant digits. */
export function formatRounded(x: number, p: number): string {
  const d = formatDecimalParts(x, p)
  if (!d) return x + ''
  const coefficient = d[0]
  const exp = d[1]
  return exp < 0 ? '0.' + new Array(-exp).join('0') + coefficient
    : coefficient.length > exp + 1 ? coefficient.slice(0, exp + 1) + '.' + coefficient.slice(exp + 1)
    : coefficient + new Array(exp - coefficient.length + 2).join('0')
}

export const formatTypes: Record<string, (x: number, p: number) => string> = {
  '%': (x, p) => (x * 100).toFixed(p),
  b: (x) => Math.round(x).toString(2),
  c: (x) => x + '',
  d: formatDecimal,
  e: (x, p) => x.toExponential(p),
  f: (x, p) => x.toFixed(p),
  g: (x, p) => x.toPrecision(p),
  o: (x) => Math.round(x).toString(8),
  p: (x, p) => formatRounded(x * 100, p),
  r: formatRounded,
  s: formatPrefixAuto,
  X: (x) => Math.round(x).toString(16).toUpperCase(),
  x: (x) => Math.round(x).toString(16),
}

// --- the locale --------------------------------------------------------------

export interface FormatLocaleDefinition {
  decimal?: string
  thousands?: string
  grouping?: readonly number[] | readonly string[]
  currency?: readonly [string, string] | readonly string[]
  numerals?: readonly string[]
  percent?: string
  minus?: string
  nan?: string
}

export interface FormatFunction {
  (value: unknown): string
  toString(): string
}

export interface FormatLocale {
  format(specifier: unknown): FormatFunction
  formatPrefix(specifier: unknown, value: number): FormatFunction
}

const identity = (value: string): string => value
const prefixes = ['y', 'z', 'a', 'f', 'p', 'n', 'µ', 'm', '', 'k', 'M', 'G', 'T', 'P', 'E', 'Z', 'Y']

export function formatLocale(locale: FormatLocaleDefinition): FormatLocale {
  const group = locale.grouping === undefined || locale.thousands === undefined
    ? identity
    : formatGroup(Array.prototype.map.call(locale.grouping, Number) as number[], locale.thousands + '')
  const currencyPrefix = locale.currency === undefined ? '' : locale.currency[0] + ''
  const currencySuffix = locale.currency === undefined ? '' : locale.currency[1] + ''
  const decimal = locale.decimal === undefined ? '.' : locale.decimal + ''
  const numerals = locale.numerals === undefined ? identity : formatNumerals(Array.prototype.map.call(locale.numerals, String) as string[])
  const percent = locale.percent === undefined ? '%' : locale.percent + ''
  const minus = locale.minus === undefined ? '−' : locale.minus + ''
  const nan = locale.nan === undefined ? 'NaN' : locale.nan + ''

  function newFormat(specifier: unknown, options?: { prefix?: string; suffix?: string }): FormatFunction {
    const spec = formatSpecifier(specifier)
    // upstream reassigns these while normalising the specifier
    let { fill, align, sign, symbol, zero, width, comma, precision, trim, type } = spec
    // The "n" type is an alias for ",g".
    if (type === 'n') comma = true, type = 'g'
    // The "" type, and any invalid type, is an alias for ".12~g".
    else if (!formatTypes[type]) precision === undefined && (precision = 12), trim = true, type = 'g'
    // If zero fill is specified, padding goes after sign and before digits.
    if (zero || (fill === '0' && align === '=')) zero = true, fill = '0', align = '='
    // Compute the prefix and suffix.
    // For SI-prefix, the suffix is lazily computed.
    const prefix = (options && options.prefix !== undefined ? options.prefix : '') + (symbol === '$' ? currencyPrefix : symbol === '#' && /[boxX]/.test(type) ? '0' + type.toLowerCase() : '')
    const suffix = (symbol === '$' ? currencySuffix : /[%p]/.test(type) ? percent : '') + (options && options.suffix !== undefined ? options.suffix : '')
    // What format function should we use?
    // Is this an integer type?
    // Can this type generate exponential notation?
    const formatType = formatTypes[type]
    const maybeSuffix = /[defgprs%]/.test(type)
    // Set the default precision if not specified,
    // or clamp the specified precision to the supported range.
    // For significant precision, it must be in [1, 21].
    // For fixed precision, it must be in [0, 20].
    precision = precision === undefined ? 6
      : /[gprs]/.test(type) ? Math.max(1, Math.min(21, precision))
      : Math.max(0, Math.min(20, precision))

    function format(value: unknown): string {
      let valuePrefix = prefix
      let valueSuffix = suffix
      let out: string
      let i: number, n: number, c: number
      const formatTypeFn = formatType as (x: number, p: number) => string
      if (type === 'c') {
        valueSuffix = formatTypeFn(value as number, precision as number) + valueSuffix
        out = ''
      } else {
        const v = +(value as number)
        // Determine the sign. -0 is not less than 0, but 1 / -0 is!
        let valueNegative = v < 0 || 1 / v < 0
        // Perform the initial formatting.
        out = isNaN(v) ? nan : formatTypeFn(Math.abs(v), precision as number)
        // Trim insignificant zeros.
        if (trim) out = formatTrim(out)
        // If a negative value rounds to zero after formatting, and no explicit
        // positive sign is requested, hide the sign.
        if (valueNegative && +out === 0 && sign !== '+') valueNegative = false
        // Compute the prefix and suffix.
        valuePrefix = (valueNegative ? (sign === '(' ? sign : minus) : sign === '-' || sign === '(' ? '' : sign) + valuePrefix
        valueSuffix = (type === 's' && !isNaN(out as unknown as number) && prefixExponent !== undefined ? prefixes[8 + prefixExponent / 3] as string : '') + valueSuffix + (valueNegative && sign === '(' ? ')' : '')
        // Break the formatted value into the integer "value" part that can be
        // grouped, and fractional or exponential "suffix" part that is not.
        if (maybeSuffix) {
          i = -1, n = out.length
          while (++i < n) {
            c = out.charCodeAt(i)
            if (48 > c || c > 57) {
              valueSuffix = (c === 46 ? decimal + out.slice(i + 1) : out.slice(i)) + valueSuffix
              out = out.slice(0, i)
              break
            }
          }
        }
      }
      // If the fill character is not "0", grouping is applied before padding.
      if (comma && !zero) out = group(out, Infinity)
      // Compute the padding.
      let length = valuePrefix.length + out.length + valueSuffix.length
      // The width comes from the specifier string (`%` + digits): under limits an
      // oversized pad is refused before the string is built (C9).
      if (length < (width as number)) meterBytes((width as number) - length, 'number format width')
      let padding = length < (width as number) ? new Array(width as number - length + 1).join(fill) : ''
      // If the fill character is "0", grouping is applied after padding.
      if (comma && zero) {
        out = group(padding + out, padding.length ? (width as number) - valueSuffix.length : Infinity)
        padding = ''
      }
      // Reconstruct the final output based on the desired alignment.
      switch (align) {
        case '<': out = valuePrefix + out + valueSuffix + padding; break
        case '=': out = valuePrefix + padding + out + valueSuffix; break
        case '^': out = padding.slice(0, length = padding.length >> 1) + valuePrefix + out + valueSuffix + padding.slice(length); break
        default: out = padding + valuePrefix + out + valueSuffix; break
      }
      return numerals(out)
    }
    format.toString = () => spec + ''
    return format
  }

  function formatPrefix(specifier: unknown, value: number): FormatFunction {
    const e = Math.max(-8, Math.min(8, Math.floor(exponent(value) / 3))) * 3
    const k = Math.pow(10, -e)
    const spec = formatSpecifier(specifier)
    spec.type = 'f'
    const f = newFormat(spec, { suffix: prefixes[8 + e / 3] as string })
    return ((v: number) => f(k * v)) as FormatFunction
  }

  return {
    format: newFormat as (specifier: unknown) => FormatFunction,
    formatPrefix,
  }
}

// --- the default locale ------------------------------------------------------

let locale: FormatLocale
let formatExport: FormatLocale['format']
let formatPrefixExport: FormatLocale['formatPrefix']

defaultNumberLocale({
  thousands: ',',
  grouping: [3],
  currency: ['$', ''],
})

function defaultNumberLocale(definition: FormatLocaleDefinition): FormatLocale {
  locale = formatLocale(definition)
  formatExport = locale.format
  formatPrefixExport = locale.formatPrefix
  return locale
}

/** The default locale's `format` (d3-format's module-level `format`). */
export function format(specifier: unknown): FormatFunction {
  return formatExport!(specifier)
}

/** The default locale's `formatPrefix`. */
export function formatPrefix(specifier: unknown, value: number): FormatFunction {
  return formatPrefixExport!(specifier, value)
}

/** Swap the module-level default locale (d3-format's `defaultLocale`). */
export function formatDefaultLocale(definition: FormatLocaleDefinition): FormatLocale {
  return defaultNumberLocale(definition)
}

