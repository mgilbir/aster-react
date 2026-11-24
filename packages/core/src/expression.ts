/**
 * Expression engine.
 *
 * The expression DSL is parsed by our parser for the Vega expression language
 * (`./expr-parser.ts`) and evaluated by closures compiled from its tree
 * (`./expr-interpreter.ts`) — no `new Function`.
 * This module supplies the *function context* — the semantics of
 * `vega-functions` that our runtime needs — bound to our scales/data, plus
 * owned, oracle-vector-tested ports: the type/array/string/math utilities
 * (`./util.js`), the colour spaces (`./color.js`, the engine's colour part), the calendar (`./time.js`, the engine's time part: engine-parts.ts)
 * and the format layer (`./locale.js`).
 */
import { currentLocale, type Locale } from './locale.js'
import { allot, allotArray, meterTick, checkRegexInput, checkRegexObject, regExpOf } from './limits.js'
import { bandSpace, scaleGradient, type Scale } from './scale.js'
import { part } from './engine-parts.js'
import { parseExpressionCached } from './expr-parser.js'
import { PRIMITIVE_TUPLE, tupleDatum } from './util.js'
import { ADDON_FUNCTIONS } from './addon-functions.js'
import { compileExpression, DefaultFunctions, ExpressionConstants, EventFunctions, FIRST_ARGUMENT_ONLY, markBuiltinTable } from './expr-interpreter.js'

/**
 * `sequence(...)`: the arithmetic sequence [start, stop) by step, as vega's (d3-array's `range`) reads its arguments: by how many
 * were given (one is the stop from 0; two step by 1, whatever their order; a third, even `undefined`, is the step), each coerced to
 * a number, and a count that is not positive (or not a number) is an empty sequence.
 */
function numericSequence(args: readonly unknown[]): number[] {
  const n = args.length
  let start = +(args[0] as number)
  let stop = +(args[1] as number)
  let step = 1
  if (n < 2) { stop = start; start = 0 } else if (n > 2) step = +(args[2] as number)
  const count = Math.max(0, Math.ceil((stop - start) / step))
  // Deviation from d3/vega (safety): the length is bounded BEFORE the allocation (sequence(0, 5e7) would otherwise build a
  // 400 MB array in one uninterruptible call), and the clock is sampled while filling.
  const len = allotArray('rows', count | 0, 'sequence')
  const out = new Array(len)
  for (let i = 0; i < len; i++) {
    out[i] = start + i * step
    if ((i & 0xffff) === 0xffff) meterTick('sequence', 1024)
  }
  return out
}
import type { AstNode } from './expr-parser.js'
import {
  ascending, extent, lerp as lerpOf, isArray, isBoolean, isDate, isNumber, isObject,
  isRegExp, isString, toBoolean, toDate, toNumber, toString, pluck, memoField, DisallowedObjectProperties,
  sortSlice, inrange, clampRange, isTuple, panLinear, panLog, panPow, panSymlog, zoomLinear, zoomLog, zoomPow, zoomSymlog,
} from './util.js'

export interface ExpressionRuntime {
  /** Scale lookup by name. Returns the scale callable, or undefined. */
  scale: (name: string) => ((value: unknown) => unknown) | undefined
  /** Dataset lookup by name. Returns the rows, or undefined. */
  data: (name: string) => unknown[] | undefined
  /** Compile an expression string against this runtime. */
  expr: (expr: string) => CompiledExpr
  /** A projection by name (vega keeps projections among the scales: `geoArea('projection', ...)`), when the host has any. */
  projection?: (name: string) => unknown
  /** The tree a dataset is the backing data of (`treePath`, `treeAncestors`): its root and the dataset's rows. */
  tree?: (name: string) => unknown
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
  /**
   * The view's source of random numbers: the counterpart of vega's `setRandom(random)`, but per view instead of
   * global. `random()`, `sampleNormal` / `sampleLogNormal` / `sampleUniform`, the `sample` transform and the
   * bootstrap `ci0` / `ci1` aggregate ops all draw from it, one number per draw in vega's order. Absent, the
   * expression functions draw from `Math.random` (as vega's default does) and the `sample` / `ci` ops from the
   * engine's seeded stream.
   */
  random?: () => number
  /**
   * vega-functions `setdata(name, tuples)`: replace the rows of the named dataset's input (a dataset with no source) by `tuples`; the
   * datasets that read it run again. Only a host that owns the datasets supplies it; without one `setdata` changes nothing.
   * Returns 1, as vega does.
   */
  setdata?: (name: string, tuples: unknown) => number
  /**
   * `intersect(box, {marktype, markname}, group)`: the items of the scene the view has drawn inside a box. Only a host that has a
   * scene while it runs event handlers (the signal event loop) supplies it; without one `intersect` finds nothing -- vega's root is
   * empty until its marks are built.
   */
  intersect?: (box: unknown, opt?: unknown, group?: unknown) => unknown[]
  /**
   * The locale `format`, `timeFormat`, `timeParse` ... read (vega's view locale): the chart's own when its config has a `locale`.
   * Absent, the default locale.
   */
  locale?: () => Locale
}

export type CompiledExpr = (datum: unknown, params?: Record<string, unknown>, event?: unknown) => unknown

/**
 * The locale an expression formats and parses through (vega-functions reads `this.context.dataflow.locale()`): the chart's
 * (`config.locale`, see `chartLocale`) when its runtime says so, else the default one -- read per call (not snapshotted at import),
 * so a later `defaultLocale(...)` is honoured.
 */
const localeOf = (runtime: ExpressionRuntime): Locale => runtime.locale?.() ?? currentLocale()

function isValid(value: unknown): boolean {
  return value != null && value === value
}

// `monthFormat` / `dayFormat` (and the abbreviated forms): a non-integer month or day is the empty string; otherwise one Date, kept
// for every call in the process as vega keeps it, is moved to year 2000, the month, then the day, and formatted through the default
// locale. That the Date is kept is observable: a day past the end of a month (`dayFormat(30)` is January 32nd) carries the next
// month name over to the following month, and a midnight the time zone skips moves the date back an hour into the day before.
const nameDate = new Date(2000, 0, 1)
function nameFormat(L: Locale, month: unknown, day: unknown, spec: string): string {
  if (!Number.isInteger(month) || !Number.isInteger(day)) return ''
  nameDate.setFullYear(2000)
  nameDate.setMonth(month as number)
  nameDate.setDate(day as number)
  return L.timeFormat(spec)(nameDate)
}

// --- numeric/time formatting (vega semantics: null -> "null") ---------------

// vega-functions wraps the locale's formatter but only maps *null* to "null"; undefined reaches the formatter and formats as NaN. The
// specifier is passed as given.
const formatting = (method: 'format' | 'timeFormat' | 'utcFormat' | 'timeParse' | 'utcParse', runtime: ExpressionRuntime) =>
  (value: unknown, spec?: unknown): unknown => (value === null ? 'null' : (localeOf(runtime)[method] as (s: unknown) => (v: unknown) => unknown)(spec)(value))

// --- date-time accessors -----------------------------------------------------

// vega-expression compiles `year(x)` to `new Date(x).getFullYear()` and vega-util / vega-time define the
// rest the same way: every accessor builds a Date from the RAW argument (null is the epoch, undefined is an
// invalid date), nothing is coerced through toDate and nothing short-circuits to undefined.
const D = (value: unknown): Date => new Date(value as number)

const quarterFn = (v: unknown): number => 1 + ~~(D(v).getMonth() / 3)
const weekFn = (v: unknown): number => part('time').week(v)
const dayofyearFn = (v: unknown): number => part('time').dayofyear(v)

const utcQuarterFn = (v: unknown): number => 1 + ~~(D(v).getUTCMonth() / 3)
const utcWeekFn = (v: unknown): number => part('time').utcweek(v)
const utcDayofyearFn = (v: unknown): number => part('time').utcdayofyear(v)

// `datetime` is `new Date(...)` with the arguments as given; `utc` is `Date.UTC(...)`.
const datetime = (...args: unknown[]): Date => new (Date as unknown as new (...a: unknown[]) => Date)(...args)
const timeOffsetFn = (unit: unknown, date: unknown, step?: unknown): Date | undefined =>
  part('time').timeOffset(unit as string, date, step as number)
const utcOffsetFn = (unit: unknown, date: unknown, step?: unknown): Date | undefined =>
  part('time').utcOffset(unit as string, date, step as number)

// --- string/array utilities (vega semantics) --------------------------------
//
// What vega does with each argument is the contract, odd inputs included: a value is made text with `+ ''` (null is "null"), a
// sequence function reads only an array, a typed array or a string (anything else fails as reading a member of null), and every
// argument after the ones a function names reaches the method it calls.

/** The array a sequence function reads (an array or a typed array), or null: a member read off it then fails. */
function asArray(value: unknown): { slice(...a: unknown[]): unknown[]; join(...a: unknown[]): string } {
  return (Array.isArray(value) || ArrayBuffer.isView(value) ? value : null) as never
}
/** The sequence a search or slice reads: an array, a typed array or a string, or null. */
function asSequence(value: unknown): { indexOf(...a: unknown[]): number; lastIndexOf(...a: unknown[]): number; slice(...a: unknown[]): unknown } {
  return (Array.isArray(value) || ArrayBuffer.isView(value) || typeof value === 'string' ? value : null) as never
}
function truncate(value: unknown, count: unknown, align?: unknown, ellipsis?: unknown): string {
  const mark = (ellipsis != null ? ellipsis : '\u2026') as string
  const str = (value as string) + ''
  const n = str.length
  const keep = Math.max(0, (count as number) - mark.length)
  if (n <= (count as number)) return str
  if (align === 'left') return mark + str.slice(n - keep)
  if (align === 'center') return str.slice(0, Math.ceil(keep / 2)) + mark + str.slice(n - ~~(keep / 2))
  return str.slice(0, keep) + mark
}
/** `count` copies of `text` (a count that is not a positive number is none; a fraction rounds down). */
function copies(text: string, count: number): string {
  return count >= 1 ? text.repeat(count) : ''
}
function pad(value: unknown, count: unknown, padchar?: unknown, align?: unknown): string {
  // (the pad character is any value, made text as the value is; a falsy one is a space)
  const fill = ((padchar || ' ') as string) + ''
  const str = (value as string) + ''
  const n = (count as number) - str.length
  if (!(n > 0)) return str
  // Deviation (safety): the padded string is bounded by the limits BEFORE it is built.
  allot('bytes', Math.floor(n) * fill.length + str.length, 'pad')
  if (align === 'left') return copies(fill, n) + str
  if (align === 'center') return copies(fill, ~~(n / 2)) + str + copies(fill, Math.ceil(n / 2))
  return str + copies(fill, n)
}
function mergeObj(...objs: unknown[]): unknown {
  // Like vega's merge (extend into {}), but an own `__proto__` key (JSON data)
  // must not leave the result with a foreign prototype: restore it.
  return Object.setPrototypeOf(Object.assign({}, ...objs), Object.prototype)
}
/** `test(pattern, text)`: `RegExp(pattern).test(text)`, the text made a string as `test` makes it. */
function testRe(pattern: unknown, text: unknown): boolean {
  // Regex guard (safety deviation): pattern and input lengths are capped under
  // limits. This does NOT stop catastrophic backtracking (docs/LIMITS.md).
  const re = regExpOf(pattern)
  const input = String(text)
  checkRegexInput(input)
  return re.test(input)
}

// -----------------------------------------------------------------------------

/** The functions the host registered (see {@link registerExpressionFunction}). */
const REGISTERED = new Map<string, (...args: never[]) => unknown>()
/** Bumped on every registration change: a compiled expression compiled under an older registry re-validates before it runs. */
let registryEpoch = 0
/** The version of the registry of expression functions: it changes with every registration, disposal and add-on load. */
export const expressionRegistryEpoch = (): number => registryEpoch

/** Functions an addon contributes that read the view they run in (a projection by name): built per runtime. */
const REGISTERED_BOUND = new Map<string, (runtime: ExpressionRuntime) => (...args: never[]) => unknown>()

/**
 * The built-ins that never write a signal (see `markParamSafe`): they read their arguments, the locale, the clock, the random
 * source, the container size or a scale, and nothing that can run a transform. Left out: whatever reads a dataset (`data`, `indata`,
 * the `vlSelection*` reads: a dataset may be derived when first read, and deriving one may write a signal), the edits (`modify`,
 * `setdata`) and what reads the drawn scene (`intersect`, `inScope`). A name missing here only costs a row pass its hoisting.
 */
const PARAM_SAFE_BUILTINS: ReadonlySet<string> = new Set([
  'isValid', 'isDefined', 'isArray', 'isBoolean', 'isDate', 'isNumber', 'isObject', 'isRegExp', 'isString',
  'toBoolean', 'toNumber', 'toDate', 'toString', 'if', 'test', 'hypot', 'containerSize', 'windowSize', 'clamp',
  'extent', 'clampRange', 'inrange', 'join', 'lerp', 'length', 'indexof', 'lastindexof', 'peek', 'reverse', 'sequence', 'slice', 'sort',
  'merge', 'vlSelectionTuples', 'isTuple', 'panLinear', 'panLog', 'panPow', 'panSymlog', 'zoomLinear', 'zoomLog', 'zoomPow', 'zoomSymlog',
  'pinchDistance', 'pinchAngle', 'span', 'pluck', 'pad', 'parseFloat', 'parseInt', 'replace', 'split', 'substring', 'truncate',
  'encodeURIComponent', 'regexp', 'now', 'random', 'datetime', 'timeOffset', 'utcOffset', 'timeSequence', 'utcSequence',
  'quarter', 'week', 'dayofyear', 'utcquarter', 'utcweek', 'utcdayofyear',
  'format', 'timeFormat', 'utcFormat', 'timeParse', 'utcParse', 'timeUnitSpecifier', 'monthFormat', 'monthAbbrevFormat', 'dayFormat',
  'dayAbbrevFormat', 'rgb', 'hsl', 'lab', 'hcl', 'luminance', 'contrast',
  'scale', 'invert', 'domain', 'range', 'bandwidth', 'bandspace', 'copy', 'gradient',
])

function createFunctionContext(runtime: ExpressionRuntime): Record<string, unknown> {
  const builtins = createBuiltinFunctions(runtime)
  // (the built-ins never read `this`: the interpreter calls them directly; what is registered below is called as a host function)
  const fns = { ...builtins }
  for (const [name, make] of REGISTERED_BOUND) fns[name] = make(runtime)
  for (const [name, fn] of REGISTERED) fns[name] = fn
  markBuiltinTable(fns, builtins, PARAM_SAFE_BUILTINS)
  return fns
}

/**
 * The function table of a runtime, made once per runtime and registry version (every expression compiled against the runtime reads
 * the same table). Sound because nothing in a table is fixed when it is made but the registry, which `registryEpoch` versions: the
 * built-ins and the add-ons' bound functions read the runtime's members (`scale`, `data`, `random`, ...) when they are called, and
 * no table is written after it is made. Keyed weakly by the runtime: a runtime is one evaluation's, and its table goes with it.
 */
const CONTEXTS = new WeakMap<ExpressionRuntime, { epoch: number; functions: Record<string, unknown> }>()
function functionContextOf(runtime: ExpressionRuntime): Record<string, unknown> {
  let made = CONTEXTS.get(runtime)
  if (made === undefined || made.epoch !== registryEpoch) {
    made = { epoch: registryEpoch, functions: createFunctionContext(runtime) }
    CONTEXTS.set(runtime, made)
  }
  return made.functions
}

/**
 * For the addons: an expression function that needs the runtime it is evaluated in (the geo addon's `geoCentroid`
 * reads a projection by name). `make` runs once per runtime. Internal -- not exported from the package barrel.
 */
export function registerRuntimeExpressionFunction(name: string, make: (runtime: ExpressionRuntime) => (...args: never[]) => unknown): void {
  REGISTERED_BOUND.set(name, make)
  registryEpoch++
}

/** Every function name an add-on or the host registered (not the built-ins): for the tests that check the add-on tables. */
export function registeredExpressionFunctionNames(): string[] {
  return [...new Set([...REGISTERED_BOUND.keys(), ...REGISTERED.keys()])]
}

/**
 * Take the named functions out of the registry (the add-ons', as if their module had not been imported); the returned function puts
 * them back. For the tests of `@aster-charts/core/addons`, which check the detector against an app that has not loaded an add-on.
 */
export function withdrawExpressionFunctions(names: readonly string[]): () => void {
  const bound = names.flatMap((n) => REGISTERED_BOUND.has(n) ? [[n, REGISTERED_BOUND.get(n)!] as const] : [])
  const plain = names.flatMap((n) => REGISTERED.has(n) ? [[n, REGISTERED.get(n)!] as const] : [])
  for (const [n] of bound) REGISTERED_BOUND.delete(n)
  for (const [n] of plain) REGISTERED.delete(n)
  registryEpoch++
  return () => {
    for (const [n, f] of bound) REGISTERED_BOUND.set(n, f)
    for (const [n, f] of plain) REGISTERED.set(n, f)
    registryEpoch++
  }
}

/** Every function name an expression can call under the registry as it is now (the built-ins and the registered ones): for the tests that sweep them. */
export function expressionFunctionNames(): string[] {
  const stub: ExpressionRuntime = { scale: () => undefined, data: () => undefined, expr: () => () => undefined }
  return [...new Set([...Object.keys(createFunctionContext(stub)), ...Object.keys(DefaultFunctions)])]
}

/**
 * The functions vega's parser recognises that Aster does not implement (logging, the lasso tools, `screen`, mark re-encoding,
 * `flush`). A spec that calls one is not refused when it is compiled -- vega accepts it -- but when the call is
 * evaluated, as before. `expression-register.test.ts` pins this list against the vega the conformance suite runs.
 */
export const UNWRITTEN_FUNCTIONS: readonly string[] = Object.freeze([
  'debug', 'info', 'warn', 'encode', 'flush', 'intersectLasso', 'lassoAppend', 'lassoPath', 'screen',
])
/** The internal scale calls vega's own encode entries are written with (`_scale("x", v)`); the only names with an underscore it knows. */
const SCALE_CALLS: ReadonlySet<string> = new Set(['_scale', '_bandwidth', '_range'])

let writtenNames: Set<string> | undefined
/** The functions Aster has built in (not those registered later). */
function builtinFunctionNames(): ReadonlySet<string> {
  if (writtenNames === undefined) {
    const stub: ExpressionRuntime = { scale: () => undefined, data: () => undefined, expr: () => () => undefined }
    writtenNames = new Set([...Object.keys(createBuiltinFunctions(stub)), ...Object.keys(DefaultFunctions)])
  }
  return writtenNames
}

/**
 * Whether vega's parser would accept a call of `name` in an expression: a built-in, one registered (by the host or an add-on, loaded
 * or not), an event function, `if`, one of the functions in {@link UNWRITTEN_FUNCTIONS}, or the internal scale calls. Anything else
 * is `Unrecognized function: <name>` when the spec is compiled.
 */
export function isExpressionFunction(name: string): boolean {
  if (name.startsWith('_')) return SCALE_CALLS.has(name)
  return builtinFunctionNames().has(name) || REGISTERED.has(name) || REGISTERED_BOUND.has(name) || name === 'if'
    || EventFunctions.includes(name) || Object.hasOwn(ADDON_FUNCTIONS, name) || UNWRITTEN_FUNCTIONS.includes(name)
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

/** A map projection (see geo-projections.ts): positions in, positions out. */
interface ProjectionLike {
  project(lon: number, lat: number): unknown
  invert(x: number, y: number): unknown
}
const isProjection = (s: unknown): s is ProjectionLike =>
  typeof s === 'object' && s !== null && typeof (s as ProjectionLike).project === 'function' && typeof (s as ProjectionLike).invert === 'function'

const PROJECTION_SCALES = new WeakMap<object, unknown>()

/** vega keeps projections among its scales: the projection as a function of a [lon, lat] pair, with an `invert`. */
function projectionScale(p: ProjectionLike): unknown {
  let scale = PROJECTION_SCALES.get(p)
  if (scale === undefined) {
    scale = Object.assign((point: ArrayLike<number>) => p.project(point[0]!, point[1]!), {
      invert: (point: ArrayLike<number>) => p.invert(point[0]!, point[1]!),
    })
    PROJECTION_SCALES.set(p, scale)
  }
  return scale
}

function createBuiltinFunctions(runtime: ExpressionRuntime): Record<string, unknown> {
  // (vega keeps a view's projections among its scales: `scale('projection', [lon, lat])` is the projected point)
  const scaleObject = (name: unknown): Record<string, unknown> | undefined => {
    const s = runtime.scale(String(name)) ?? runtime.projection?.(String(name))
    return (isProjection(s) ? projectionScale(s) : s) as unknown as Record<string, unknown> | undefined
  }
  return {
    // type checking
    isValid,
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
    // would be a caller-supplied callable
    toDate: (value: unknown) => toDate(value),
    toString: (value: unknown) => toString(value),
    // control flow
    if: (t: unknown, a: unknown, b: unknown) => (t ? a : b),
    test: testRe,
    // math
    hypot: Math.hypot,
    // vega-functions: the view's container / the window. Headless vega has
    // neither (`[undefined, undefined]`); here the host passes the container's
    // size in RuntimeInput.containerSize, and without one a spec falls back to
    // its own default size (vega-lite: `isFinite(containerSize()[0]) ? ... : 300`).
    containerSize: () => runtime.containerSize?.() ?? [undefined, undefined],
    windowSize: () => [undefined, undefined],
    // (vega writes `clamp(v, lo, hi)` as `Math.max(lo, Math.min(hi, v))`: a range given upside down clamps to `lo`)
    clamp: (value: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, value)),
    // arrays
    extent: (arr: unknown) => extent(arr as ArrayLike<unknown>), // unary: no accessor callable
    clampRange: (r: unknown, lo: unknown, hi: unknown) => clampRange(r as number[], lo as number, hi as number),
    inrange: (value: unknown, range: unknown, left?: unknown, right?: unknown) => inrange(value, range as unknown[], left as boolean | undefined, right as boolean | undefined),
    join: (seq: unknown, ...rest: unknown[]) => asArray(seq).join(...rest),
    lerp: (arr: unknown, t: unknown) => lerpOf(arr as number[], t),
    length: (value: unknown) => (value as { length: unknown }).length,
    indexof: (seq: unknown, ...rest: unknown[]) => asSequence(seq).indexOf(...rest),
    lastindexof: (seq: unknown, ...rest: unknown[]) => asSequence(seq).lastIndexOf(...rest),
    peek: (arr: unknown) => (arr as unknown[])[(arr as unknown[]).length - 1],
    reverse: (seq: unknown) => asArray(seq).slice().reverse(),
    sequence: (...args: unknown[]) => numericSequence(args),
    slice: (seq: unknown, ...rest: unknown[]) => asSequence(seq).slice(...rest),
    sort: (seq: unknown) => sortSlice(asArray(seq), (a, b) => ascending(a as never, b as never)),
    merge: mergeObj,
    // dataset edits happen inside the signal event loop, which supplies runtime.modify; elsewhere there is nothing to edit
    modify: (name: unknown, insert?: unknown, remove?: unknown, toggle?: unknown, modifyTuple?: unknown, values?: unknown) =>
      runtime.modify ? runtime.modify(String(name), insert, remove, toggle, modifyTuple, values) : 0,
    // vega-selections
    // (vega-selections' functions are a part the React shells load on demand: engine-parts.ts)
    vlSelectionTest: (name: unknown, datum: unknown, op?: unknown) => part('selections').selectionTest(runtime.data(String(name)) as never, datum, op),
    vlSelectionIdTest: (name: unknown, datum: unknown, op?: unknown) => part('selections').selectionIdTest(runtime.data(String(name)) as never, datum, op),
    vlSelectionResolve: (name: unknown, op?: unknown, isMulti?: unknown, vl5?: unknown) => part('selections').selectionResolve(runtime.data(String(name)) as never, op, isMulti, vl5),
    vlSelectionTuples: (items: unknown, base: unknown) => part('selections').selectionTuples(items, base),
    isTuple: (t: unknown) => isTuple(t),
    // vega-functions intersect.js: the items of the drawn scene inside a box
    intersect: (b: unknown, opt?: unknown, group?: unknown) => (runtime.intersect ? runtime.intersect(b, opt, group) : []),
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
    // (vega-util span: `array && (peek(array) - array[0]) || 0`, so a missing or empty array spans nothing)
    span: (arr: unknown) => { const a = arr as number[] | null | undefined; return (a && (a[a.length - 1]! - a[0]!)) || 0 },
    pluck,
    // strings
    pad,
    parseFloat: (value: unknown) => parseFloat(String(value)),
    parseInt: (value: unknown, radix?: unknown) => parseInt(String(value), radix == null ? undefined : Number(radix)),
    replace: (value: unknown, pattern: unknown, repl: unknown) => {
      // (vega-functions replace: the pattern must be a string or a regular expression; the replacement is passed as given)
      if (!isString(pattern) && !isRegExp(pattern)) throw new Error('Please pass a string or RegExp argument to replace.')
      const str = String(value)
      if (isRegExp(pattern)) { checkRegexObject(pattern as RegExp); checkRegexInput(str) }
      return str.replace(pattern as string | RegExp, repl as string)
    },
    // `split` and `substring` are the string methods called on `String(value)` with the remaining arguments as given
    split: (value: unknown, ...rest: unknown[]) => {
      const str = String(value)
      if (isRegExp(rest[0])) { checkRegexObject(rest[0] as RegExp); checkRegexInput(str) }
      return (str.split as (...a: unknown[]) => string[])(...rest)
    },
    substring: (value: unknown, ...rest: unknown[]) => (String(value).substring as (...a: unknown[]) => string)(...rest),
    truncate,
    encodeURIComponent: (value: unknown) => encodeURIComponent(String(value)),
    regexp: (...args: unknown[]) => regExpOf(...args),
    // date-time
    // (read when called, not when this module loaded: a host or a test that replaces `Date.now` -- the deterministic clock -- is heard)
    now: () => Date.now(),
    setdata: (name: unknown, tuples: unknown) => (runtime.setdata ? runtime.setdata(String(name), tuples) : 1),
    // vega-functions codegen.js: `random() { return random(); }`, vega-statistics' (replaceable) source
    random: () => (runtime.random ?? Math.random)(),
    datetime,
    timeOffset: (unit: unknown, date: unknown, step?: unknown) => timeOffsetFn(unit, date, step),
    utcOffset: (unit: unknown, date: unknown, step?: unknown) => utcOffsetFn(unit, date, step),
    timeSequence: (unit: unknown, start: unknown, stop: unknown, step?: unknown) =>
      part('time').timeSequence(unit as string, start, stop, step as number),
    utcSequence: (unit: unknown, start: unknown, stop: unknown, step?: unknown) =>
      part('time').utcSequence(unit as string, start, stop, step as number),
    quarter: quarterFn, week: weekFn, dayofyear: dayofyearFn,
    utcquarter: utcQuarterFn, utcweek: utcWeekFn, utcdayofyear: utcDayofyearFn,
    // formatting
    format: formatting('format', runtime),
    timeFormat: formatting('timeFormat', runtime),
    utcFormat: formatting('utcFormat', runtime),
    timeParse: formatting('timeParse', runtime),
    utcParse: formatting('utcParse', runtime),
    timeUnitSpecifier: (units: unknown, specs?: unknown) => part('time').timeUnitSpecifier(units as never, specs as never),
    monthFormat: (month: unknown) => nameFormat(localeOf(runtime), month, 1, '%B'),
    monthAbbrevFormat: (month: unknown) => nameFormat(localeOf(runtime), month, 1, '%b'),
    dayFormat: (day: unknown) => nameFormat(localeOf(runtime), 0, 2 + (day as number), '%A'),
    dayAbbrevFormat: (day: unknown) => nameFormat(localeOf(runtime), 0, 2 + (day as number), '%a'),
    // colors
    // (the colour spaces are the engine's colour part: engine-parts.ts)
    rgb: (...args: number[] | [string]) => (part('color').rgb as unknown as (...a: unknown[]) => unknown)(...args),
    hsl: (...args: number[] | [string]) => (part('color').hsl as unknown as (...a: unknown[]) => unknown)(...args),
    lab: (...args: number[] | [string]) => (part('color').lab as unknown as (...a: unknown[]) => unknown)(...args),
    hcl: (...args: number[] | [string]) => (part('color').hcl as unknown as (...a: unknown[]) => unknown)(...args),
    luminance: (spec: unknown) => part('color').luminance(spec),
    contrast: (c1: unknown, c2: unknown) => part('color').contrastRatio(c1, c2),
    // data & scale functions
    data: (name: string) => tupleData(runtime.data(name) ?? []),
    indata: (name: string, field: string, value: unknown) => {
      const rows = runtime.data(name) ?? []
      // O(rows) per call and usually called per row: charge the scan so the
      // wall clock is sampled inside the O(n^2) pattern.
      meterTick('indata', rows.length)
      const read = memoField(field)
      let count = 0
      for (const r of rows) if (read(r) === value) count++
      return count ? count : undefined
    },
    scale: function (this: unknown, name: string, value?: unknown) {
      const scale = scaleObject(name) as ((v: unknown) => unknown) | undefined
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
      // (a projection has no domain: vega's `s.domain()` throws)
      if (s && typeof s.domain !== 'function') throw new TypeError('s.domain is not a function')
      return s ? (s.domain as () => unknown[])() : []
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
    // vega-functions scale-gradient.js: a linear gradient (`start` and `stop` are points of the unit square) over a scale's stops
    gradient: (name: string, start?: unknown, stop?: unknown, count?: unknown) => scaleGradient(scaleObject(name) as unknown as Scale, start, stop, count),
  }
}

/**
 * An expression that does not parse, as thrown by the engine's expression compiler. vega finds these in
 * `vega.parse` (before anything runs) and throws; the expressions a spec contains are checked when the spec is
 * compiled, before evaluation, and fail there as a `SpecParseError`. Either way it is a throw: it
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
        const addon = Object.hasOwn(ADDON_FUNCTIONS, name) ? ADDON_FUNCTIONS[name] : undefined
        throw new ExpressionParseError(addon
          ? `[aster] this spec calls the expression function "${name}"; load the addon first: await import("@aster-charts/core/${addon}")`
          : `Unrecognized function: ${name}`, expr)
      }
    }
    // (an argument vega's code generator never reads is never refused: `upper(x, foo())` is `String(x).toUpperCase()`)
    if (node.type === 'CallExpression' && node.callee?.type === 'Identifier' && FIRST_ARGUMENT_ONLY.has(node.callee.name ?? '')) {
      visit((node.arguments as unknown[])[0])
      return
    }
    for (const k of Object.keys(node)) if (k !== 'type') visit(node[k])
  }
  visit(ast)
}

/** The row passes of the expressions `compileExpr` made (see `exprRows`). Keyed by the function: it holds nothing else alive. */
const ROW_PASSES = new WeakMap<CompiledExpr, (params: Record<string, unknown> | undefined) => (datum: unknown) => unknown>()

/**
 * The evaluation of each row of a pass over many rows in which the parameters stay as they are: a transform's loop over its rows,
 * where nothing that runs writes a signal. The values are those of `fn(datum, params)` per row; for an expression `compileExpr`
 * made, what every row reads alike is read once (see `EngineExpression.rows`). Prepare one per pass: the function returned is not to
 * be kept past it.
 */
export function exprRows(fn: CompiledExpr, params: Record<string, unknown> | undefined): (datum: unknown) => unknown {
  const rows = ROW_PASSES.get(fn)
  return rows !== undefined && params !== undefined && ENGINE_PARAMS.has(params) ? rows(params) : (datum) => fn(datum, params)
}

/**
 * The parameter objects the engine made itself (see `engineParams`): their signals are own data properties that only the engine
 * writes, so reading one once at the start of a pass gives what every row would read. A host's object (the public `applyTransforms`
 * takes any) may hold a getter or be a proxy, and is read per row, as before.
 */
const ENGINE_PARAMS = new WeakSet<object>()
/** Mark the engine's own signal parameters as such (see `ENGINE_PARAMS`); returns them. */
export function engineParams<T extends Record<string, unknown>>(params: T): T {
  ENGINE_PARAMS.add(params)
  return params
}

/** Compile an expression string to an evaluable function bound to a runtime. */
export function compileExpr(expr: string, runtime: ExpressionRuntime): CompiledExpr {
  let ast: AstNode
  try {
    ast = parseExpressionCached(expr)
  } catch (e) {
    // limit violations keep their type (they are the engine's refusal, not a syntax error)
    if (e instanceof Error && e.name === 'AsterLimitError') throw e
    throw new ExpressionParseError('Expression parse error: ' + expr, expr, { cause: e })
  }
  // vega refuses an unknown function when it parses and generates code ("Unrecognized function: x"), not when it is called
  const functions = functionContextOf(runtime)
  assertKnownFunctions(ast, functions, expr)
  const compiledEpoch = registryEpoch
  const evaluate = compileExpression(functions, ast)
  const compiled = (datum: unknown, params: unknown, event?: unknown): unknown => {
    // the registry changed since this closure was made (a function disposed, replaced): compile again under the
    // current one -- an unknown name is then refused as at first compile, a replaced one calls the new function
    if (registryEpoch !== compiledEpoch) {
      return compileExpr(expr, runtime)(datum, params as never, event)
    }
    // (the signals are read by their own names off the parameters: an event's datum is its item's)
    return evaluate(datum, params as Record<string, unknown> | undefined, event)
  }
  ROW_PASSES.set(compiled, (params) => {
    if (registryEpoch !== compiledEpoch) return (datum) => compiled(datum, params)
    const row = evaluate.rows(params)
    // (a registry change in the middle of the pass: every later row is evaluated as `compiled` evaluates it)
    return (datum) => (registryEpoch === compiledEpoch ? row(datum) : compiled(datum, params))
  })
  return compiled as CompiledExpr
}
/** What `data(name)` gives an expression: the dataset's tuples as vega has them (a primitive tuple is the primitive). Once per array. */
const TUPLE_DATA = new WeakMap<readonly unknown[], readonly unknown[]>()
function tupleData(rows: readonly unknown[]): readonly unknown[] {
  let out = TUPLE_DATA.get(rows)
  if (out === undefined) {
    out = rows.some((r) => r !== null && typeof r === 'object' && PRIMITIVE_TUPLE in r) ? rows.map(tupleDatum) : rows
    TUPLE_DATA.set(rows, out)
  }
  return out
}
