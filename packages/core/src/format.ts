/**
 * Number formatting: the `[[fill]align][sign][symbol][0][width][,][.precision][~][type]` mini-language of d3-format,
 * as Aster's axis labels, legends, `format()` expressions and text encodings use it.
 *
 * How a value becomes text:
 *   1. `parseSpecifier` reads the grammar into a `FormatSpecifier` (a plain record that prints back as its text);
 *   2. `compile` settles what the specifier means in a locale (aliases, defaults, the affixes), once;
 *   3. each call rounds |value| with the type's renderer, trims, signs, splits off the part that must not be grouped
 *      (fraction, exponent, SI prefix), groups, pads and aligns.
 *
 * Output is held identical to d3-format for every input by the vectors in `testdata/vectors/d3-format.json` and the
 * generated differential `packages/conformance/scripts/differential-format.test.mts`. Behaviour that follows from that
 * and not from taste:
 * - `format('')` is `.12~g`, `n` is `,g`, and any unknown type is `.12~g` (trimmed);
 * - the SI prefix of an `s` format comes from the last number an `s` format rounded, in any locale, and a NaN does not
 *   refresh it: `format('s')(NaN)` under a locale whose NaN text is empty or numeric still wears the previous prefix;
 * - a minus sign survives only when the rounded text is not zero (a `-0` shows no sign, `+` excepted);
 * - the pad is built with `new Array(n + 1).join(fill)` so an absurd width fails with the same RangeError;
 * - locale fields are read as array-likes (`Array.prototype.map.call`), so `grouping: '3'` works.
 */
import { meterBytes } from './limits.js'

export { tickStep } from './arr.js'

// --- digits ---------------------------------------------------------------------------

interface Decimal {
  /** The significant digits, no point, e.g. 1.23e4 -> '123'. */
  digits: string
  /** The power of ten of the first digit. */
  power: number
}

/**
 * |x| as significant digits and a power of ten, rounded to `significant` digits (all digits when omitted or 0).
 * `null` for zero and the non-finite numbers, which have no such form.
 */
function decimalOf(x: number, significant?: number): Decimal | null {
  if (!isFinite(x) || x === 0) return null
  const text = significant ? x.toExponential(significant - 1) : x.toExponential()
  const e = text.indexOf('e')
  const mantissa = text.slice(0, e)
  return { digits: mantissa.length > 1 ? mantissa[0]! + mantissa.slice(2) : mantissa, power: +text.slice(e + 1) }
}

const zeros = (n: number): string => (n > 0 ? '0'.repeat(n) : '')

function exponent(x: number): number {
  const d = decimalOf(Math.abs(x))
  return d ? d.power : NaN
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

// --- the type renderers ---------------------------------------------------------------

/** The SI power (a multiple of 3 in [-24, 24]) of the last number the `s` renderer rounded; see the header. */
let lastSiPower: number | undefined

const SI_PREFIXES = ['y', 'z', 'a', 'f', 'p', 'n', 'µ', 'm', '', 'k', 'M', 'G', 'T', 'P', 'E', 'Z', 'Y']

const siPowerOf = (power: number): number => Math.max(-8, Math.min(8, Math.floor(power / 3))) * 3

/** `%` is not here: it only scales. Integer types round half away from the sign like Math.round. */
function integer(x: number): string {
  const rounded = Math.round(x)
  return Math.abs(rounded) >= 1e21 ? rounded.toLocaleString('en').replace(/,/g, '') : rounded.toString(10)
}

/** Digits at a power of ten laid out positionally: 12345 at power 2 -> '123.45', at power -2 -> '0.0012345'. */
function positional({ digits, power }: Decimal): string {
  if (power < 0) return '0.' + zeros(-power - 1) + digits
  if (digits.length > power + 1) return digits.slice(0, power + 1) + '.' + digits.slice(power + 1)
  return digits + zeros(power - digits.length + 1)
}

function significant(x: number, precision: number): string {
  const d = decimalOf(x, precision)
  return d ? positional(d) : x + ''
}

/** The `s` type: scale to the SI prefix the magnitude calls for, round to `precision` digits there. */
function siScaled(x: number, precision: number): string {
  const d = decimalOf(x, precision)
  if (!d) {
    lastSiPower = undefined
    return x.toPrecision(precision)
  }
  const power = (lastSiPower = Math.max(-8, Math.min(8, Math.floor(d.power / 3))) * 3)
  const intDigits = d.power - power + 1
  const n = d.digits.length
  if (intDigits === n) return d.digits
  if (intDigits > n) return d.digits + zeros(intDigits - n)
  if (intDigits > 0) return d.digits.slice(0, intDigits) + '.' + d.digits.slice(intDigits)
  // below one unit of the smallest prefix: re-round to the digits that remain (0 means "all digits" to decimalOf)
  return '0.' + zeros(-intDigits) + decimalOf(x, Math.max(0, precision + intDigits - 1))!.digits
}

const RENDERERS: Record<string, (x: number, precision: number) => string> = {
  '%': (x, p) => (x * 100).toFixed(p),
  b: (x) => Math.round(x).toString(2),
  c: (x) => x + '',
  d: integer,
  e: (x, p) => x.toExponential(p),
  f: (x, p) => x.toFixed(p),
  g: (x, p) => x.toPrecision(p),
  o: (x) => Math.round(x).toString(8),
  p: (x, p) => significant(x * 100, p),
  r: significant,
  s: siScaled,
  X: (x) => Math.round(x).toString(16).toUpperCase(),
  x: (x) => Math.round(x).toString(16),
}

// --- trimming, grouping, numerals ------------------------------------------------------

/**
 * Drop insignificant zeros from the leading run of digits and points: '1.500' -> '1.5', '2.000e+3' -> '2e+3',
 * '5.' -> '5'. Only text after a point (past the first character) can be trimmed.
 */
function trimZeros(text: string): string {
  // the leading run: the first character whatever it is, then digits and points
  let end = 1
  let point = -1
  for (; end < text.length; end++) {
    const code = text.charCodeAt(end)
    if (code === 46) point = end
    else if (code < 48 || code > 57) break
  }
  if (point < 0) return text
  let zerosFrom = end
  while (zerosFrom > point + 1 && text.charCodeAt(zerosFrom - 1) === 48) zerosFrom--
  const cut = zerosFrom === point + 1 ? point : zerosFrom
  return cut < end ? text.slice(0, cut) + text.slice(end) : text
}

/**
 * Insert `separator` between groups of digits counted from the right; `sizes` repeat cyclically. Under a `width` the
 * groups shrink so the grouped text does not outgrow it (zero-padded numbers group their padding).
 */
function grouper(sizes: readonly number[], separator: string): (digits: string, width: number) => string {
  return (digits, width) => {
    const chunks: string[] = []
    let end = digits.length
    let turn = 0
    let size = sizes[0]!
    let used = 0
    while (end > 0 && size > 0) {
      if (used + size + 1 > width) size = Math.max(1, width - used)
      end -= size
      chunks.push(digits.substring(end, end + size))
      used += size + 1
      if (used > width) break
      turn = (turn + 1) % sizes.length
      size = sizes[turn]!
    }
    return chunks.reverse().join(separator)
  }
}

const keepAsIs = (text: string): string => text

/** Replace the ASCII digits of a text with the locale's own numerals. */
const numeralMapper = (names: readonly string[]) => (text: string): string => text.replace(/[0-9]/g, (digit) => names[+digit]!)

// --- the specifier ----------------------------------------------------------------------

const GRAMMAR = new RegExp(
  '^(?:(.)?([<>=^]))?' // fill and align
  + '([+\\-( ])?' // sign
  + '([$#])?' // symbol
  + '(0)?' // zero padding
  + '(\\d+)?' // width
  + '(,)?' // grouping
  + '(\\.\\d+)?' // precision
  + '(~)?' // trim
  + '([a-z%])?$', // type
  'i',
)

export interface FormatSpecifierFields {
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
}

/** A parsed specifier. Mutable on purpose: vega-format fills in a precision and `formatPrefix` forces the type. */
export class FormatSpecifier implements FormatSpecifierFields {
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

  constructor(fields: FormatSpecifierFields) {
    this.fill = fields.fill
    this.align = fields.align
    this.sign = fields.sign
    this.symbol = fields.symbol
    this.zero = fields.zero
    this.width = fields.width
    this.comma = fields.comma
    this.precision = fields.precision
    this.trim = fields.trim
    this.type = fields.type
  }

  toString(): string {
    return this.fill + this.align + this.sign + this.symbol + (this.zero ? '0' : '')
      + (this.width === undefined ? '' : Math.max(1, this.width | 0))
      + (this.comma ? ',' : '')
      + (this.precision === undefined ? '' : '.' + Math.max(0, this.precision | 0))
      + (this.trim ? '~' : '') + this.type
  }
}

/** Parse a specifier; the text of anything else is `String()` of it. Malformed text throws `invalid format: ...`. */
export function formatSpecifier(specifier: unknown): FormatSpecifier {
  const m = GRAMMAR.exec(String(specifier))
  if (!m) throw new Error('invalid format: ' + specifier)
  return new FormatSpecifier({
    fill: m[1] === undefined ? ' ' : m[1],
    align: m[2] === undefined ? '>' : m[2],
    sign: m[3] === undefined ? '-' : m[3],
    symbol: m[4] === undefined ? '' : m[4],
    zero: !!m[5],
    width: m[6] === undefined ? undefined : +m[6],
    comma: !!m[7],
    precision: m[8] === undefined ? undefined : +m[8].slice(1),
    trim: !!m[9],
    type: m[10] === undefined ? '' : m[10],
  })
}

// --- locales -----------------------------------------------------------------------------

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

/** A locale's symbols, settled once when the locale is made. */
interface Symbols {
  group: (digits: string, width: number) => string
  currencyPrefix: string
  currencySuffix: string
  decimal: string
  numerals: (text: string) => string
  percent: string
  minus: string
  nan: string
}

function symbolsOf(def: FormatLocaleDefinition): Symbols {
  const text = (value: unknown, fallback: string): string => (value === undefined ? fallback : value + '')
  return {
    group: def.grouping === undefined || def.thousands === undefined
      ? keepAsIs
      : grouper(Array.prototype.map.call(def.grouping, Number) as number[], def.thousands + ''),
    currencyPrefix: def.currency === undefined ? '' : def.currency[0] + '',
    currencySuffix: def.currency === undefined ? '' : def.currency[1] + '',
    decimal: text(def.decimal, '.'),
    numerals: def.numerals === undefined ? keepAsIs : numeralMapper(Array.prototype.map.call(def.numerals, String) as string[]),
    percent: text(def.percent, '%'),
    minus: text(def.minus, '−'),
    nan: text(def.nan, 'NaN'),
  }
}

/** Text attached to every output of a compiled format on top of the specifier's own affixes (`formatPrefix`'s unit). */
interface Affixes {
  suffix?: string
}

const SIGNIFICANT_TYPES = /[gprs]/
const HAS_FRACTION_OR_EXPONENT = /[defgprs%]/

/**
 * Settle a specifier in a locale and return the formatter. The specifier object is copied, not retained: later
 * changes to it do not reach the formatter, and `toString` of the result is the specifier as parsed.
 */
function compile(spec: FormatSpecifier, symbols: Symbols, affixes?: Affixes): FormatFunction {
  const { sign, symbol, width, comma } = spec
  let { fill, align, zero, precision, trim, type } = spec
  let grouped = comma

  if (type === 'n') {
    grouped = true
    type = 'g'
  } else if (!RENDERERS[type]) {
    if (precision === undefined) precision = 12
    trim = true
    type = 'g'
  }
  if (zero || (fill === '0' && align === '=')) {
    zero = true
    fill = '0'
    align = '='
  }

  const prefix = symbol === '$' ? symbols.currencyPrefix : symbol === '#' && /[boxX]/.test(type) ? '0' + type.toLowerCase() : ''
  const suffix = (symbol === '$' ? symbols.currencySuffix : /[%p]/.test(type) ? symbols.percent : '') + (affixes?.suffix !== undefined ? affixes.suffix : '')
  const render = RENDERERS[type]!
  const splitsTail = HAS_FRACTION_OR_EXPONENT.test(type)
  const digitsAfter = precision === undefined ? 6
    : SIGNIFICANT_TYPES.test(type) ? Math.max(1, Math.min(21, precision))
    : Math.max(0, Math.min(20, precision))
  const { group, minus, nan, decimal, numerals } = symbols
  const label = spec + ''

  function format(value: unknown): string {
    let lead = prefix
    let tail = suffix
    let body: string

    if (type === 'c') {
      tail = render(value as number, digitsAfter) + tail
      body = ''
    } else {
      const v = +(value as number)
      let negative = v < 0 || 1 / v < 0
      body = isNaN(v) ? nan : render(Math.abs(v), digitsAfter)
      if (trim) body = trimZeros(body)
      if (negative && +body === 0 && sign !== '+') negative = false
      lead = (negative ? (sign === '(' ? sign : minus) : sign === '-' || sign === '(' ? '' : sign) + lead
      // the prefix test reads the produced text (a locale's NaN text may be empty or numeric), not the number
      const siUnit = type === 's' && !isNaN(body as unknown as number) && lastSiPower !== undefined ? SI_PREFIXES[8 + lastSiPower / 3]! : ''
      tail = siUnit + tail + (negative && sign === '(' ? ')' : '')
      if (splitsTail) {
        for (let i = 0; i < body.length; i++) {
          const code = body.charCodeAt(i)
          if (code < 48 || code > 57) {
            tail = (code === 46 ? decimal + body.slice(i + 1) : body.slice(i)) + tail
            body = body.slice(0, i)
            break
          }
        }
      }
    }

    if (grouped && !zero) body = group(body, Infinity)

    const used = lead.length + body.length + tail.length
    let padding = ''
    if (used < (width as number)) {
      meterBytes((width as number) - used, 'number format width')
      padding = new Array((width as number) - used + 1).join(fill)
    }
    if (grouped && zero) {
      body = group(padding + body, padding.length ? (width as number) - tail.length : Infinity)
      padding = ''
    }

    switch (align) {
      case '<': return numerals(lead + body + tail + padding)
      case '=': return numerals(lead + padding + body + tail)
      case '^': {
        const before = padding.length >> 1
        return numerals(padding.slice(0, before) + lead + body + tail + padding.slice(before))
      }
      default: return numerals(padding + lead + body + tail)
    }
  }
  format.toString = () => label
  return format
}

export function formatLocale(definition: FormatLocaleDefinition): FormatLocale {
  const symbols = symbolsOf(definition)
  return {
    format: (specifier) => compile(formatSpecifier(specifier), symbols),
    formatPrefix(specifier, value) {
      const power = siPowerOf(exponent(value))
      const scale = Math.pow(10, -power)
      const spec = formatSpecifier(specifier)
      spec.type = 'f'
      const fixed = compile(spec, symbols, { suffix: SI_PREFIXES[8 + power / 3] })
      return ((v: number) => fixed(scale * v)) as FormatFunction
    },
  }
}

// --- the default locale -------------------------------------------------------------------

let defaultLocale: FormatLocale = /* @__PURE__ */ formatLocale({ thousands: ',', grouping: [3], currency: ['$', ''] })

/** The default locale's `format`. */
export function format(specifier: unknown): FormatFunction {
  return defaultLocale.format(specifier)
}

/** The default locale's `formatPrefix`. */
export function formatPrefix(specifier: unknown, value: number): FormatFunction {
  return defaultLocale.formatPrefix(specifier, value)
}

/** Replace the default locale. */
export function formatDefaultLocale(definition: FormatLocaleDefinition): FormatLocale {
  return (defaultLocale = formatLocale(definition))
}
