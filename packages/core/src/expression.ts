/**
 * Expression engine.
 *
 * We reuse the spec language's own grammar: `vega-expression` parses the
 * expression DSL to an AST, and `vega-interpreter` evaluates that AST (CSP-safe,
 * no `new Function`). We supply the *function context* — the semantics of
 * `vega-functions` that our runtime needs — bound to our scales/data, plus
 * owned, oracle-vector-tested ports: the type/array/string/math utilities
 * (`./util.js`), the colour spaces (`./color.js`), and formatting functions
 * from `vega-format` and `vega-time` (all pure). This keeps expression
 * semantics byte-compatible with vega while the stack is brought in-house.
 */
import { parseExpression } from 'vega-expression'
import { expressionInterpreter } from 'vega-interpreter'
import { locale, defaultLocale } from 'vega-format'
import { bandSpace } from 'vega-scale'
import {
  timeOffset, utcOffset, timeSequence, utcSequence,
  dayofyear, utcdayofyear, week, utcweek, timeUnitSpecifier,
} from './time.js'

/** d3-array's range: arithmetic sequence [start, stop) by step. */
function numericSequence(start: number, stop?: number, step?: number): number[] {
  if (stop === undefined) { stop = start; start = 0 }
  step = step ?? (stop < start ? -1 : 1)
  const len = Math.max(0, Math.ceil((stop - start) / step))
  const out = new Array(len)
  for (let i = 0; i < len; i++) out[i] = start + i * step
  return out
}
import { rgb, hsl, lab, hcl } from './color.js'
import {
  accessor, ascending, extent, isArray, isBoolean, isDate, isNumber, isObject,
  isRegExp, isString, toBoolean, toDate, toNumber, toString, pluck,
} from './util.js'

export interface ExpressionRuntime {
  /** Scale lookup by name. Returns the scale callable, or undefined. */
  scale: (name: string) => ((value: unknown) => unknown) | undefined
  /** Dataset lookup by name. Returns the rows, or undefined. */
  data: (name: string) => unknown[] | undefined
  /** Compile an expression string against this runtime. */
  expr: (expr: string) => CompiledExpr
}

export type CompiledExpr = (datum: unknown, params?: Record<string, unknown>, event?: unknown) => unknown

const L = locale(defaultLocale)

function isValid(value: unknown): boolean {
  return value != null && value === value
}

function monthFormatValue(month: unknown): string {
  return L.timeFormat('%B')(new Date(2000, Number(month), 1))
}

function dayFormatValue(day: unknown): string {
  return L.timeFormat('%A')(new Date(2000, 0, 2 + Number(day)))
}

// --- numeric/time formatting (vega semantics: null -> "null") ---------------

function fmtNumber(value: unknown, spec?: string): string {
  return value == null ? 'null' : L.format(spec ?? '')(value as number)
}
function fmtTime(value: unknown, spec?: string): string {
  if (value == null) return 'null'
  const t = toDate(value)
  return L.timeFormat(spec ?? '')(t == null ? (value as Date) : new Date(t))
}
function fmtUtc(value: unknown, spec?: string): string {
  if (value == null) return 'null'
  const t = toDate(value)
  return L.utcFormat(spec ?? '')(t == null ? (value as Date) : new Date(t))
}

// --- date-time accessors -----------------------------------------------------

type DateTimeFn = (value: unknown) => number | undefined
function asMs(value: unknown): number | undefined {
  const t = toDate(value)
  if (t == null) return undefined
  return t instanceof Date ? +t : (t as number)
}
function local(f: (d: Date) => number): DateTimeFn {
  return (value) => {
    const t = asMs(value)
    return t === undefined ? undefined : f(new Date(t))
  }
}
const utc = local

const yearFn = local((d) => d.getFullYear())
const quarterFn = local((d) => Math.floor(d.getMonth() / 3))
const monthFn = local((d) => d.getMonth())
const weekFn = local((d) => week(d))
const dateFn = local((d) => d.getDate())
const dayFn = local((d) => d.getDay())
const dayofyearFn = local((d) => dayofyear(d))
const hoursFn = local((d) => d.getHours())
const minutesFn = local((d) => d.getMinutes())
const secondsFn = local((d) => d.getSeconds())
const millisFn = local((d) => d.getMilliseconds())

const utcYearFn = utc((d) => d.getUTCFullYear())
const utcQuarterFn = utc((d) => Math.floor(d.getUTCMonth() / 3))
const utcMonthFn = utc((d) => d.getUTCMonth())
const utcWeekFn = utc((d) => utcweek(d))
const utcDateFn = utc((d) => d.getUTCDate())
const utcDayFn = utc((d) => d.getUTCDay())
const utcDayofyearFn = utc((d) => utcdayofyear(d))
const utcHoursFn = utc((d) => d.getUTCHours())
const utcMinutesFn = utc((d) => d.getUTCMinutes())
const utcSecondsFn = utc((d) => d.getUTCSeconds())
const utcMillisFn = utc((d) => d.getUTCMilliseconds())

function datetime(y?: unknown, mo?: unknown, d?: unknown, h?: unknown, mi?: unknown, s?: unknown, ms?: unknown): Date {
  return new Date(
    Number(y ?? 1970), Number(mo ?? 0), d == null ? 1 : Number(d),
    Number(h ?? 0), Number(mi ?? 0), Number(s ?? 0), Number(ms ?? 0),
  )
}
function utcDatetime(y?: unknown, mo?: unknown, d?: unknown, h?: unknown, mi?: unknown, s?: unknown, ms?: unknown): number {
  return Date.UTC(
    Number(y ?? 1970), Number(mo ?? 0), d == null ? 1 : Number(d),
    Number(h ?? 0), Number(mi ?? 0), Number(s ?? 0), Number(ms ?? 0),
  )
}
function timeOffsetFn(unit: unknown, date: unknown, step?: unknown): Date | undefined {
  const d = asMs(date)
  return d === undefined ? undefined : timeOffset(String(unit), new Date(d), step == null ? 1 : Number(step))
}
function utcOffsetFn(unit: unknown, date: unknown, step?: unknown): Date | undefined {
  const d = asMs(date)
  return d === undefined ? undefined : utcOffset(String(unit), new Date(d), step == null ? 1 : Number(step))
}

// --- string/array utilities (vega semantics) --------------------------------

function lengthOf(value: unknown): number {
  return value == null ? 0 : (value as { length: number }).length
}
function sliceFn(value: unknown, start?: number, end?: number): unknown {
  const e = end == null ? undefined : end < 0 ? lengthOf(value) + end : end
  return (value as { slice(a?: number, b?: number): unknown }).slice(start, e)
}
function truncate(value: unknown, count: number, align = 'right', ellipsis = '\u2026'): string {
  const str = value == null ? '' : String(value)
  if (str.length <= count) return str
  const len = Math.max(0, count - ellipsis.length)
  const half = Math.floor(len / 2)
  if (align === 'left') return ellipsis + str.slice(str.length - len)
  if (align === 'center') return str.slice(0, half) + ellipsis + str.slice(str.length - (len - half))
  return str.slice(0, len) + ellipsis
}
function pad(value: unknown, count: number, char = ' ', align = 'right'): string {
  const str = value == null ? '' : String(value)
  const len = Math.max(0, count - str.length)
  if (align === 'left') return char.repeat(len) + str
  if (align === 'center') {
    const left = len >> 1
    return char.repeat(left) + str + char.repeat(len - left)
  }
  return str + char.repeat(len)
}
function inrange(value: unknown, range: unknown): boolean {
  const [lo, hi] = range as [number, number]
  const v = value as number
  return lo < hi ? v >= lo && v <= hi : v >= hi && v <= lo
}
function mergeObj(...objs: unknown[]): unknown {
  return Object.assign({}, ...objs)
}
function testRe(reg: unknown, value: unknown): boolean {
  if (value == null) return false
  const re = isRegExp(reg) ? (reg as RegExp) : new RegExp(String(reg))
  return re.test(String(value))
}

// --- WCAG luminance / contrast -----------------------------------------------

function channelLum(c: number): number {
  const val = c / 255
  return val <= 0.03928 ? val / 12.92 : Math.pow((val + 0.055) / 1.055, 2.4)
}
function luminance(spec: unknown): number {
  const c = rgb(spec as string)
  return 0.2126 * channelLum(c.r) + 0.7152 * channelLum(c.g) + 0.0722 * channelLum(c.b)
}
function contrastRatio(c1: unknown, c2: unknown): number {
  const l1 = luminance(c1)
  const l2 = luminance(c2)
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
}

// -----------------------------------------------------------------------------

function createFunctionContext(runtime: ExpressionRuntime): Record<string, unknown> {
  const scaleObject = (name: unknown): Record<string, unknown> | undefined =>
    runtime.scale(String(name)) as unknown as Record<string, unknown> | undefined
  return {
    // type checking
    isValid,
    isInvalid: (value: unknown) => value == null || value !== value,
    isDefined: (value: unknown) => value !== undefined,
    isArray,
    isBoolean,
    isDate,
    isNumber,
    isObject,
    isRegExp,
    isString,
    // coercion (vega semantics: null/empty-string -> null)
    toBoolean: (value: unknown) => toBoolean(value),
    toNumber: (value: unknown) => toNumber(value),
    toDate: (value: unknown, parser?: unknown) => toDate(value, parser as ((v: unknown) => number | Date) | undefined),
    toString: (value: unknown) => toString(value),
    // control flow
    if: (t: unknown, a: unknown, b: unknown) => (t ? a : b),
    test: testRe,
    // math
    abs: Math.abs, acos: Math.acos, asin: Math.asin, atan: Math.atan, atan2: Math.atan2,
    ceil: Math.ceil, cos: Math.cos, exp: Math.exp, floor: Math.floor, hypot: Math.hypot,
    isFinite: Number.isFinite, isNaN: Number.isNaN, log: Math.log, pow: Math.pow,
    round: Math.round, sin: Math.sin, sqrt: Math.sqrt, tan: Math.tan,
    min: (...args: number[]) => Math.min(...args),
    max: (...args: number[]) => Math.max(...args),
    clamp: (value: number, lo: number, hi: number) => Math.min(Math.max(value, lo), hi),
    // arrays
    extent: (arr: unknown) => extent(arr as ArrayLike<unknown>),
    clampRange: (r: unknown, lo: unknown, hi: unknown) => {
      const [start, stop] = r as [number, number]
      if (stop - start >= (hi as number) - (lo as number)) return [lo, hi]
      if (start < (lo as number)) return [lo as number, start + ((hi as number) - (lo as number))]
      if (stop > (hi as number)) return [stop - ((hi as number) - (lo as number)), hi]
      return [start, stop]
    },
    inrange,
    join: (seq: unknown, sep?: unknown) => (seq as unknown[]).join(sep as string | undefined),
    lerp: (arr: unknown, t: unknown) => {
      const a = arr as number[]
      const s = a.length <= 1 ? a[0] ?? 0 : a[0]!
      const e = a.length <= 1 ? a[0] ?? 0 : a[a.length - 1]!
      return (1 - (t as number)) * s + (t as number) * e
    },
    length: lengthOf,
    indexof: (seq: unknown, v: unknown) => (seq as { indexOf: (v: unknown) => number }).indexOf(v),
    lastindexof: (seq: unknown, v: unknown) => (seq as { lastIndexOf: (v: unknown) => number }).lastIndexOf(v),
    peek: (arr: unknown) => ((arr as unknown[]) ?? []).slice(-1)[0],
    reverse: (seq: unknown) => (seq as unknown[]).slice().reverse(),
    sequence: (start: number, stop?: number, step?: number) =>
      stop === undefined ? numericSequence(start) : step === undefined ? numericSequence(start, stop) : numericSequence(start, stop, step),
    slice: sliceFn,
    sort: (seq: unknown) => (seq as unknown[]).slice().sort((a, b) => ascending(a as never, b as never)),
    merge: mergeObj,
    modify: (set: unknown, value: unknown, signal?: unknown) => set, // event-only; static no-op returns the set
    span: (arr: unknown) => { const a = arr as number[]; return a[a.length - 1]! - a[0]! },
    pluck,
    // strings
    lower: (value: unknown) => String(value).toLowerCase(),
    pad,
    parseFloat: (value: unknown) => parseFloat(String(value)),
    parseInt: (value: unknown, radix?: unknown) => parseInt(String(value), radix == null ? undefined : Number(radix)),
    replace: (value: unknown, pattern: unknown, repl: unknown) => String(value).replace(pattern as string | RegExp, String(repl)),
    split: (value: unknown, sep: unknown, limit?: unknown) => String(value).split(sep as string, limit == null ? undefined : Number(limit)),
    substring: (value: unknown, start?: number, end?: number) => String(value).substring(start ?? 0, end),
    trim: (value: unknown) => String(value).trim(),
    truncate,
    upper: (value: unknown) => String(value).toUpperCase(),
    encodeURIComponent: (value: unknown) => encodeURIComponent(String(value)),
    regexp: (pattern: unknown, flags?: unknown) => new RegExp(String(pattern), flags == null ? undefined : String(flags)),
    // date-time
    now: () => Date.now(),
    datetime: (...args: unknown[]) => datetime(...(args as [unknown, unknown, unknown, unknown, unknown, unknown, unknown])),
    utc: (...args: unknown[]) => utcDatetime(...(args as [unknown, unknown, unknown, unknown, unknown, unknown, unknown])),
    time: (value: unknown) => toDate(value),
    timezoneoffset: (value: unknown) => { const t = toDate(value); return t == null ? undefined : new Date(t).getTimezoneOffset() },
    timeOffset: (unit: unknown, date: unknown, step?: unknown) => timeOffsetFn(unit, date, step),
    utcOffset: (unit: unknown, date: unknown, step?: unknown) => utcOffsetFn(unit, date, step),
    timeSequence: (unit: unknown, start: unknown, stop: unknown, step?: unknown) => {
      const a = asMs(start); const b = asMs(stop)
      return a === undefined || b === undefined ? undefined : timeSequence(String(unit), new Date(a), new Date(b), step == null ? 1 : Number(step))
    },
    utcSequence: (unit: unknown, start: unknown, stop: unknown, step?: unknown) => {
      const a = asMs(start); const b = asMs(stop)
      return a === undefined || b === undefined ? undefined : utcSequence(String(unit), new Date(a), new Date(b), step == null ? 1 : Number(step))
    },
    year: yearFn, quarter: quarterFn, month: monthFn, week: weekFn, date: dateFn, day: dayFn,
    dayofyear: dayofyearFn, hours: hoursFn, minutes: minutesFn, seconds: secondsFn, milliseconds: millisFn,
    utcyear: utcYearFn, utcquarter: utcQuarterFn, utcmonth: utcMonthFn, utcweek: utcWeekFn,
    utcdate: utcDateFn, utcday: utcDayFn, utcdayofyear: utcDayofyearFn,
    utchours: utcHoursFn, utcminutes: utcMinutesFn, utcseconds: utcSecondsFn, utcmilliseconds: utcMillisFn,
    // formatting
    format: (value: unknown, spec?: string) => fmtNumber(value, spec),
    timeFormat: (value: unknown, spec?: string) => fmtTime(value, spec),
    utcFormat: (value: unknown, spec?: string) => fmtUtc(value, spec),
    timeParse: (value: unknown, spec: string) => L.timeParse(spec)(String(value)) ?? undefined,
    utcParse: (value: unknown, spec: string) => L.utcParse(spec)(String(value)) ?? undefined,
    timeUnitSpecifier: (units: unknown, specs?: unknown) => timeUnitSpecifier(units as never, specs as never),
    monthFormat: monthFormatValue,
    monthAbbrevFormat: (month: unknown) => L.timeFormat('%b')(new Date(2000, Number(month), 1)),
    dayFormat: dayFormatValue,
    dayAbbrevFormat: (day: unknown) => L.timeFormat('%a')(new Date(2000, 0, 2 + Number(day))),
    // colors
    rgb: (...args: number[] | [string]) => (rgb as unknown as (...a: unknown[]) => unknown)(...args),
    hsl: (...args: number[] | [string]) => (hsl as unknown as (...a: unknown[]) => unknown)(...args),
    lab: (...args: number[] | [string]) => (lab as unknown as (...a: unknown[]) => unknown)(...args),
    hcl: (...args: number[] | [string]) => (hcl as unknown as (...a: unknown[]) => unknown)(...args),
    luminance,
    contrast: contrastRatio,
    // data & scale functions
    data: (name: string) => runtime.data(name) ?? [],
    indata: (name: string, field: string, value: unknown) => {
      const rows = runtime.data(name) ?? []
      let count = 0
      for (const r of rows) if ((r as Record<string, unknown>)[field] === value) count++
      return count ? count : undefined
    },
    scale: function (this: unknown, name: string, value?: unknown) {
      const scale = runtime.scale(name)
      if (scale === undefined) return undefined
      return arguments.length > 1 ? scale(value) : scale
    },
    invert: (name: string, value: unknown) => {
      const s = scaleObject(name)
      if (!s) return undefined
      const inv = (s.invert ?? s.invertExtent) as ((v: unknown) => unknown) | undefined
      return inv ? (isArray(value) && s.invertRange ? (s.invertRange as (v: unknown) => unknown)(value) : inv(value)) : undefined
    },
    domain: (name: string) => {
      const s = scaleObject(name)
      return s && s.domain ? (s.domain as () => unknown[])() : []
    },
    range: (name: string) => {
      const s = scaleObject(name)
      return s && s.range ? (s.range as () => unknown[])() : []
    },
    bandwidth: (name: string) => {
      const s = scaleObject(name)
      return s && s.bandwidth ? (s.bandwidth as () => number)() : 0
    },
    bandspace: (count: number, paddingInner?: number, paddingOuter?: number) =>
      bandSpace(count || 0, paddingInner || 0, paddingOuter || 0),
    copy: (name: string) => {
      const s = scaleObject(name)
      return s && s.copy ? (s.copy as () => unknown)() : undefined
    },
  }
}

/** Compile an expression string to an evaluable function bound to a runtime. */
export function compileExpr(expr: string, runtime: ExpressionRuntime): CompiledExpr {
  const ast = parseExpression(expr)
  const functions = createFunctionContext(runtime)
  const evalParam = expressionInterpreter.parameter({ functions }, { ast })
  const evalHandler = expressionInterpreter.handler({ functions }, { ast })
  const compiled = (datum: unknown, params: unknown, event?: unknown) => {
    // Signal values are exposed to expressions as $-prefixed params (vega convention).
    const p: Record<string, unknown> = {}
    if (params) {
      for (const key of Object.keys(params as Record<string, unknown>)) p[`$${key}`] = (params as Record<string, unknown>)[key]
    }
    // vega-interpreter's handler arity: (params, event) with
    // datum = event.item.datum — our event facade carries both.
    if (event != null) {
      const h = evalHandler as unknown as (p: Record<string, unknown> | undefined, e: unknown) => unknown
      return h(p, event)
    }
    const e2 = evalParam as unknown as (d: unknown, p: Record<string, unknown> | undefined) => unknown
    return e2(datum, p)
  }
  return compiled as CompiledExpr
}