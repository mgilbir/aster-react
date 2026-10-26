/**
 * Expression engine.
 *
 * The expression DSL is parsed by our port of vega-expression's parser
 * (`./expr-parser.ts`) and evaluated by our port of vega-interpreter's
 * CSP-safe AST evaluator (`./expr-interpreter.ts`) — no `new Function`.
 * This module supplies the *function context* — the semantics of
 * `vega-functions` that our runtime needs — bound to our scales/data, plus
 * owned, oracle-vector-tested ports: the type/array/string/math utilities
 * (`./util.js`), the colour spaces (`./color.js`), the calendar (`./time.js`)
 * and the format layer (`./locale.js`).
 */
import { currentLocale } from './locale.js'
import { boundedCount, meterBytes, meterTick, guardedRegExp, checkRegexInput, checkRegexObject } from './limits.js'
import { bandSpace } from './scale.js'
import { selectionIdTest, selectionResolve, selectionTest, selectionTuples } from './selections.js'
import { parseExpression } from './expr-parser.js'
import { expressionInterpreter, DefaultFunctions, ExpressionConstants, EventFunctions } from './expr-interpreter.js'
import {
  timeOffset, utcOffset, timeSequence, utcSequence,
  dayofyear, utcdayofyear, week, utcweek, timeUnitSpecifier,
} from './time.js'

/** d3-array's range: arithmetic sequence [start, stop) by step. */
function numericSequence(start: number, stop?: number, step?: number): number[] {
  if (stop === undefined) { stop = start; start = 0 }
  step = step ?? (stop < start ? -1 : 1)
  const len = Math.max(0, Math.ceil((stop - start) / step))
  // Deviation from d3/vega (safety): under limits the length is bounded BEFORE
  // the allocation (sequence(0, 5e7) would otherwise build a 400 MB array in
  // one uninterruptible call), and the clock is sampled while filling (C9).
  boundedCount(len, 'sequence', 'rows')
  const out = new Array(len)
  for (let i = 0; i < len; i++) {
    out[i] = start + i * step
    if ((i & 0xffff) === 0xffff) meterTick('sequence', 1024)
  }
  return out
}
import { rgb, hsl, lab, hcl } from './color.js'
import type { AstNode } from './expr-parser.js'
import {
  ascending, extent, isArray, isBoolean, isDate, isNumber, isObject,
  isRegExp, isString, toBoolean, toDate, toNumber, toString, pluck, safeGet, DisallowedObjectProperties,
  inrange, clampRange, isTuple, panLinear, panLog, panPow, panSymlog, zoomLinear, zoomLog, zoomPow, zoomSymlog,
} from './util.js'

export interface ExpressionRuntime {
  /** Scale lookup by name. Returns the scale callable, or undefined. */
  scale: (name: string) => ((value: unknown) => unknown) | undefined
  /** Dataset lookup by name. Returns the rows, or undefined. */
  data: (name: string) => unknown[] | undefined
  /** Compile an expression string against this runtime. */
  expr: (expr: string) => CompiledExpr
  /**
   * The `modify(name, insert, remove, toggle, modify, values)` expression function: queue an edit of the
   * named dataset. Only a host that owns datasets while it runs event handlers (the signal event loop)
   * supplies it; without one `modify` changes nothing and returns 0.
   */
  modify?: (name: string, insert: unknown, remove: unknown, toggle: unknown, modify: unknown, values: unknown) => number
  /**
   * The rows dataset `name` publishes for the input rows `raw`: its transform pipeline run over them. The
   * event loop shows a dataset it modified through this, before the next evaluation computes it for real.
   */
  transformed?: (name: string, raw: readonly unknown[]) => unknown[]
  /**
   * `inScope(item)`: whether the item lies within the group whose scope the expression runs in (vega-functions
   * inscope.js reads `this.context.group`). Absent, the expression runs in the root scope, whose group is the root of
   * every scene item: any item is in scope.
   */
  inScope?: (item: unknown) => boolean
  /**
   * The view's container size (`containerSize()`), when the host has one. Absent
   * (like headless vega, which has no container) it is `[undefined, undefined]`.
   */
  containerSize?: () => [number | undefined, number | undefined]
}

export type CompiledExpr = (datum: unknown, params?: Record<string, unknown>, event?: unknown) => unknown

// The default locale -- upstream's expression `format` goes through
// vega-format's default locale (grouping included). It is read per call (not
// snapshotted at import) so a later `defaultLocale(...)` is honoured (C70).
const L = {
  format: (spec: string) => currentLocale().format(spec),
  timeFormat: (spec: unknown) => currentLocale().timeFormat(spec),
  utcFormat: (spec: unknown) => currentLocale().utcFormat(spec),
  timeParse: (spec: string) => currentLocale().timeParse(spec),
  utcParse: (spec: string) => currentLocale().utcParse(spec),
}

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
  // vega-functions wraps d3-format but only maps *null* to "null"; undefined
  // reaches the formatter and formats as NaN.
  return value === null ? 'null' : L.format(spec ?? '')(value as number)
}
function fmtTime(value: unknown, spec?: string): string {
  if (value === null) return 'null'
  const t = toDate(value)
  return L.timeFormat(spec ?? '')(t == null ? (value as unknown as Date) : new Date(t))
}
function fmtUtc(value: unknown, spec?: string): string {
  if (value === null) return 'null'
  const t = toDate(value)
  return L.utcFormat(spec ?? '')(t == null ? (value as unknown as Date) : new Date(t))
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
  // Deviation (safety): the padded string is bounded by the limits BEFORE it is built.
  meterBytes(len + str.length, 'pad')
  if (align === 'left') return char.repeat(len) + str
  if (align === 'center') {
    const left = len >> 1
    return char.repeat(left) + str + char.repeat(len - left)
  }
  return str + char.repeat(len)
}
function mergeObj(...objs: unknown[]): unknown {
  // Like vega's merge (extend into {}), but an own `__proto__` key (JSON data)
  // must not leave the result with a foreign prototype: restore it.
  return Object.setPrototypeOf(Object.assign({}, ...objs), Object.prototype)
}
function testRe(reg: unknown, value: unknown): boolean {
  if (value == null) return false
  // Regex guard (safety deviation): pattern and input lengths are capped under
  // limits. This does NOT stop catastrophic backtracking (docs/LIMITS.md).
  const re = isRegExp(reg) ? (reg as RegExp) : guardedRegExp(String(reg))
  if (isRegExp(reg)) checkRegexObject(reg as RegExp)
  const input = String(value)
  checkRegexInput(input)
  return re.test(input)
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

/** The functions the host registered (see {@link registerExpressionFunction}). */
const REGISTERED = new Map<string, (...args: never[]) => unknown>()
/** Bumped on every registration change: a compiled expression compiled under an older registry re-validates before it runs. */
let registryEpoch = 0

function createFunctionContext(runtime: ExpressionRuntime): Record<string, unknown> {
  const fns = createBuiltinFunctions(runtime)
  for (const [name, fn] of REGISTERED) fns[name] = fn
  return fns
}

let builtinNames: Set<string> | undefined
/** Every name an expression already means something by: the functions, the constants, the keywords. */
function reservedExpressionNames(): ReadonlySet<string> {
  if (builtinNames === undefined) {
    const stub: ExpressionRuntime = { scale: () => undefined, data: () => undefined, expr: () => () => undefined }
    builtinNames = new Set([
      ...Object.keys(createBuiltinFunctions(stub)), ...Object.keys(DefaultFunctions), ...Object.keys(ExpressionConstants),
      'datum', 'event', 'item', 'this', 'true', 'false', 'null', 'undefined', 'if',
    ])
  }
  return builtinNames
}

/**
 * Register a function that expressions may call by name: the counterpart of vega's `expressionFunction(name, fn)`.
 * It is how Vega-Lite's custom `formatType` works: `{"formatType": "price", "format": "$,.2f"}` compiles to the
 * expression `price(datum["v"], "$,.2f")`, which calls whatever is registered as `price` -- here, and in vega
 * for the same spec, before the chart is built.
 *
 * The registry is global (as vega's is) and holds host code: unlike the rest of the expression language it is not
 * sandboxed or metered by the engine, and a spec chooses its arguments. Register only functions that are safe
 * for any arguments a spec you render can produce.
 *
 * The name must be a plain identifier that is not already an expression function, constant or keyword (a host
 * cannot silently replace `format`), and must not start with `_` (an underscore prefix is internal routing).
 * Returns a function that removes the registration (restoring the one it replaced). Throws on a bad name or a
 * non-function.
 */
export function registerExpressionFunction(name: string, fn: (...args: never[]) => unknown): () => void {
  if (typeof name !== 'string' || !/^[A-Za-z$][A-Za-z0-9_$]*$/.test(name)) {
    throw new Error(`[aster] registerExpressionFunction: "${String(name)}" is not a plain identifier`)
  }
  if (DisallowedObjectProperties.has(name) || reservedExpressionNames().has(name)) {
    throw new Error(`[aster] registerExpressionFunction: "${name}" is already an expression function, constant or keyword`)
  }
  if (typeof fn !== 'function') throw new Error(`[aster] registerExpressionFunction: "${name}" needs a function`)
  const previous = REGISTERED.get(name)
  REGISTERED.set(name, fn)
  registryEpoch++
  return () => {
    if (REGISTERED.get(name) !== fn) return
    if (previous === undefined) REGISTERED.delete(name)
    else REGISTERED.set(name, previous)
    registryEpoch++
  }
}

function createBuiltinFunctions(runtime: ExpressionRuntime): Record<string, unknown> {
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
    // unary, like vega-functions ("suppress extra arguments"): a second argument
    // would be a caller-supplied callable (audit C1)
    toDate: (value: unknown) => toDate(value),
    toString: (value: unknown) => toString(value),
    // control flow
    if: (t: unknown, a: unknown, b: unknown) => (t ? a : b),
    test: testRe,
    // math
    abs: Math.abs, acos: Math.acos, asin: Math.asin, atan: Math.atan, atan2: Math.atan2,
    ceil: Math.ceil, cos: Math.cos, exp: Math.exp, floor: Math.floor, hypot: Math.hypot,
    // vega-functions: the view's container / the window. Headless vega has
    // neither (`[undefined, undefined]`); here the host passes the container's
    // size in RuntimeInput.containerSize, and without one a spec falls back to
    // its own default size (vega-lite: `isFinite(containerSize()[0]) ? ... : 300`).
    containerSize: () => runtime.containerSize?.() ?? [undefined, undefined],
    windowSize: () => [undefined, undefined],
    isFinite: Number.isFinite, isNaN: Number.isNaN, log: Math.log, pow: Math.pow,
    round: Math.round, sin: Math.sin, sqrt: Math.sqrt, tan: Math.tan,
    min: (...args: number[]) => Math.min(...args),
    max: (...args: number[]) => Math.max(...args),
    clamp: (value: number, lo: number, hi: number) => Math.min(Math.max(value, lo), hi),
    // arrays
    extent: (arr: unknown) => extent(arr as ArrayLike<unknown>), // unary: no accessor callable
    clampRange: (r: unknown, lo: unknown, hi: unknown) => clampRange(r as number[], lo as number, hi as number),
    inrange: (value: unknown, range: unknown, left?: unknown, right?: unknown) => inrange(value, range as unknown[], left as boolean | undefined, right as boolean | undefined),
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
    // dataset edits happen inside the signal event loop, which supplies runtime.modify; elsewhere there is nothing to edit
    modify: (name: unknown, insert?: unknown, remove?: unknown, toggle?: unknown, modifyTuple?: unknown, values?: unknown) =>
      runtime.modify ? runtime.modify(String(name), insert, remove, toggle, modifyTuple, values) : 0,
    // vega-selections
    vlSelectionTest: (name: unknown, datum: unknown, op?: unknown) => selectionTest(runtime.data(String(name)) as never, datum, op),
    vlSelectionIdTest: (name: unknown, datum: unknown, op?: unknown) => selectionIdTest(runtime.data(String(name)) as never, datum, op),
    vlSelectionResolve: (name: unknown, op?: unknown, isMulti?: unknown, vl5?: unknown) => selectionResolve(runtime.data(String(name)) as never, op, isMulti, vl5),
    vlSelectionTuples: (items: unknown, base: unknown) => selectionTuples(items, base),
    isTuple: (t: unknown) => isTuple(t),
    // vega-util pan / zoom of a scale domain
    panLinear: (domain: unknown, delta: unknown) => panLinear(domain as number[], delta as number),
    panLog: (domain: unknown, delta: unknown) => panLog(domain as number[], delta as number),
    panPow: (domain: unknown, delta: unknown, exponent: unknown) => panPow(domain as number[], delta as number, exponent as number),
    panSymlog: (domain: unknown, delta: unknown, constant: unknown) => panSymlog(domain as number[], delta as number, constant as number),
    zoomLinear: (domain: unknown, anchor: unknown, scale: unknown) => zoomLinear(domain as number[], anchor as number, scale as number),
    zoomLog: (domain: unknown, anchor: unknown, scale: unknown) => zoomLog(domain as number[], anchor as number, scale as number),
    zoomPow: (domain: unknown, anchor: unknown, scale: unknown, exponent: unknown) => zoomPow(domain as number[], anchor as number, scale as number, exponent as number),
    zoomSymlog: (domain: unknown, anchor: unknown, scale: unknown, constant: unknown) => zoomSymlog(domain as number[], anchor as number, scale as number, constant as number),
    // multi-touch gestures (vega-functions pinch.js); `event` must be a touch event
    pinchDistance: (event: unknown) => {
      const t = (event as { touches: Array<{ clientX: number; clientY: number }> }).touches
      return Math.hypot(t[0]!.clientX - t[1]!.clientX, t[0]!.clientY - t[1]!.clientY)
    },
    pinchAngle: (event: unknown) => {
      const t = (event as { touches: Array<{ clientX: number; clientY: number }> }).touches
      return Math.atan2(t[0]!.clientY - t[1]!.clientY, t[0]!.clientX - t[1]!.clientX)
    },
    // vega-functions inscope.js: true when `item` descends from the current scope's group. The
    // root scope's group is the root of every scene item, so any item is in scope (and nothing -- no
    // item under the pointer -- is not); a group scope (`runtime.inScope`) checks the item's group chain.
    inScope: (item: unknown) => runtime.inScope ? runtime.inScope(item) : item != null && typeof item === 'object',
    span: (arr: unknown) => { const a = arr as number[]; return a[a.length - 1]! - a[0]! },
    pluck,
    // strings
    lower: (value: unknown) => String(value).toLowerCase(),
    pad,
    parseFloat: (value: unknown) => parseFloat(String(value)),
    parseInt: (value: unknown, radix?: unknown) => parseInt(String(value), radix == null ? undefined : Number(radix)),
    replace: (value: unknown, pattern: unknown, repl: unknown) => {
      const str = String(value)
      if (isRegExp(pattern)) { checkRegexObject(pattern as RegExp); checkRegexInput(str) }
      return str.replace(pattern as string | RegExp, String(repl))
    },
    split: (value: unknown, sep: unknown, limit?: unknown) => {
      const str = String(value)
      if (isRegExp(sep)) { checkRegexObject(sep as RegExp); checkRegexInput(str) }
      return str.split(sep as string, limit == null ? undefined : Number(limit))
    },
    substring: (value: unknown, start?: number, end?: number) => String(value).substring(start ?? 0, end),
    trim: (value: unknown) => String(value).trim(),
    truncate,
    upper: (value: unknown) => String(value).toUpperCase(),
    encodeURIComponent: (value: unknown) => encodeURIComponent(String(value)),
    regexp: (pattern: unknown, flags?: unknown) => guardedRegExp(String(pattern), flags == null ? undefined : String(flags)),
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
      // O(rows) per call and usually called per row: charge the scan so the
      // wall clock is sampled inside the O(n^2) pattern (C7).
      meterTick('indata', rows.length)
      let count = 0
      for (const r of rows) if (safeGet(r, field) === value) count++
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

/**
 * An expression that does not parse. vega finds these in `vega.parse` (before anything runs) and
 * throws; the engine parses lazily, so the error surfaces mid-evaluation -- but it stays a throw: it
 * is the spec that is wrong, not one datum, and the "log and carry on" recovery of runtime
 * expression errors (see RuntimeInput.logger) does not apply to it.
 */
export class ExpressionParseError extends Error {
  constructor(message: string, readonly expression: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'ExpressionParseError'
  }
}

/** Every called name must be a function of the current context (or an engine intrinsic: `if`, the event functions the signal loop supplies): else an ExpressionParseError, as vega's codegen. */
function assertKnownFunctions(ast: AstNode, functions: Record<string, unknown>, expr: string): void {
  const visit = (n: unknown): void => {
    if (n === null || typeof n !== 'object') return
    if (Array.isArray(n)) { for (const x of n) visit(x); return }
    const node = n as { type?: string; callee?: { type?: string; name?: string } } & Record<string, unknown>
    if (node.type === 'CallExpression' && node.callee?.type === 'Identifier' && typeof node.callee.name === 'string') {
      let name = node.callee.name
      if (name.startsWith('_')) name = name.slice(1)
      if (name !== 'if' && !EventFunctions.includes(name) && !Object.hasOwn(functions, name) && !Object.hasOwn(DefaultFunctions, name)) {
        throw new ExpressionParseError(`Unrecognized function: ${name}`, expr)
      }
    }
    for (const k of Object.keys(node)) if (k !== 'type') visit(node[k])
  }
  visit(ast)
}

/** Compile an expression string to an evaluable function bound to a runtime. */
export function compileExpr(expr: string, runtime: ExpressionRuntime): CompiledExpr {
  let ast: AstNode
  try {
    ast = parseExpression(expr)
  } catch (e) {
    // limit violations keep their type (they are the engine's refusal, not a syntax error)
    if (e instanceof Error && e.name === 'AsterLimitError') throw e
    throw new ExpressionParseError(e instanceof Error ? e.message : String(e), expr, { cause: e })
  }
  // vega refuses an unknown function when it parses and generates code ("Unrecognized function: x"), not when it is called
  const functions = createFunctionContext(runtime)
  assertKnownFunctions(ast, functions, expr)
  const compiledEpoch = registryEpoch
  const evalParam = expressionInterpreter.parameter({ functions }, { ast })
  const evalHandler = expressionInterpreter.handler({ functions }, { ast })
  const compiled = (datum: unknown, params: unknown, event?: unknown): unknown => {
    // the registry changed since this closure was made (a function disposed, replaced): compile again under the
    // current one -- an unknown name is then refused as at first compile, a replaced one calls the new function
    if (registryEpoch !== compiledEpoch) {
      return compileExpr(expr, runtime)(datum, params as never, event)
    }
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