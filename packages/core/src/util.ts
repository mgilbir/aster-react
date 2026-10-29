/**
 * Type coercion, predicates, accessors and ordering.
 *
 * A faithful port of the `vega-util` surface `@aster/core` uses, plus the
 * `field`/`getter`/`splitAccessPath` access-path helpers the expression
 * functions need (`pluck` upstream is `field` + `isArray`).
 *
 * Every exported function is replayed against vectors recorded from the
 * pinned oracle packages (see `testdata/vectors/` and the generator in
 * `packages/conformance/scripts/gen-vectors.mjs`); semantics must match
 * upstream exactly, including edge cases like `'False' -> true` and
 * `NaN` comparing equal to everything in `ascending`.
 */

// --- predicates --------------------------------------------------------------

/** Whether the value is an array (`vega-util` re-exports `Array.isArray`). */
export const isArray: (value: unknown) => value is readonly unknown[] = Array.isArray

export function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean'
}

/** `Date` instances only, not timestamps — `Object.prototype.toString` check as upstream. */
export function isDate(value: unknown): value is Date {
  return Object.prototype.toString.call(value) === '[object Date]'
}

export function isNumber(value: unknown): value is number {
  return typeof value === 'number'
}

/** True for objects, arrays and functions; false for primitives (incl. `null`). */
export function isObject(_: unknown): boolean {
  return _ === Object(_)
}

/** `RegExp` instances only, via the same `Object.prototype.toString` check as upstream. */
export function isRegExp(value: unknown): value is RegExp {
  return Object.prototype.toString.call(value) === '[object RegExp]'
}

export function isString(value: unknown): value is string {
  return typeof value === 'string'
}

export function isFunction(value: unknown): value is (...args: never[]) => unknown {
  return typeof value === 'function'
}

// --- small collection helpers ------------------------------------------------

/** Wrap a value in an array unless it already is one; `null`/`undefined` give `[]`. */
export function array(_: unknown): unknown[] {
  return _ != null ? (isArray(_) ? (_ as unknown[]).slice() : [_]) : []
}

/** A function returning the given value (the value itself if already a function). */
export function constant<T>(_: T): (...args: never[]) => T {
  return isFunction(_ as unknown) ? (_ as (...args: never[]) => T) : () => _
}

/** The last element of an array (`undefined` for empty). */
export function peek<T>(array: readonly T[]): T | undefined {
  return array[array.length - 1]
}

/**
 * vega-util `lerp`: the point a fraction of the way between an array's ends (the first end for a falsy fraction, the
 * last for 1, the first for an array with no last element). No arithmetic is done on the ends in those cases, so a
 * non-numeric end is returned as it is.
 */
export function lerp(array: readonly unknown[], frac: unknown): number {
  const lo = array[0] as number
  const hi = array[array.length - 1] as number | undefined
  const f = +(frac as number)
  if (hi === undefined) return lo
  return !f ? lo : f === 1 ? hi : lo + f * (hi - lo)
}

/** An object map of the array's (stringified) values to `true`. */
export function toSet(_: readonly unknown[]): Record<string, true> {
  const s: Record<string, true> = {}
  const n = _.length
  for (let i = 0; i < n; ++i) s[_[i] + ''] = true
  return s
}

/**
 * Copy the *own enumerable* properties of each source onto the target, in
 * order — upstream's `extend` uses `for…in`, so prototype chains are walked
 * for inherited enumerables too; plain sources behave like `Object.assign`.
 */
export function extend<T extends object>(_: T, ...args: unknown[]): T {
  for (const arg of args) {
    for (const k in arg as Record<string, unknown>) {
      (_ as Record<string, unknown>)[k] = (arg as Record<string, unknown>)[k]
    }
  }
  return _
}

/** Own-property check that never hits an inherited `hasOwnProperty`. */
export function hasOwnProperty(object: unknown, property: string | number | symbol): boolean {
  return Object.hasOwn(object as object, property)
}

/**
 * Object property names the expression evaluator refuses (prototype
 * accessors and Object.prototype methods) — vega-util's
 * `DisallowedObjectProperties`, ported so the interpreter's security
 * blocklist is ours.
 */
export const DisallowedObjectProperties: ReadonlySet<string> = new Set([
  'constructor', '__defineGetter__', '__defineSetter__', 'hasOwnProperty',
  '__lookupGetter__', '__lookupSetter__', 'isPrototypeOf', 'propertyIsEnumerable',
  'toString', 'valueOf', 'toLocaleString', '__proto__',
])

// --- type coercion -----------------------------------------------------------

/**
 * Coerce to a boolean with Vega's signal semantics: `null`/`undefined`/`''`
 * become `null`, the strings `'false'` and `'0'` become `false`, everything
 * else is its truthiness. Note `'False'` (any case but exact) is *true*,
 * matching upstream.
 */
export function toBoolean(_: unknown): boolean | null {
  return _ == null || _ === '' ? null : !_ || _ === 'false' || _ === '0' ? false : !!_
}

/**
 * Coerce to a date-like value: `null`/`undefined`/`''` become `null`, numbers
 * pass through unchanged (milliseconds — *not* wrapped in a `Date`), `Date`
 * instances pass through, and anything else goes through `Date.parse`
 * (returning epoch milliseconds). An optional parser overrides the default.
 * The *expression* `toDate` is unary (see `createFunctionContext`): a parser
 * is a callable argument and must never be reachable from a spec string.
 */
export function toDate(
  _: unknown,
  parser?: (value: unknown) => number | Date,
): number | Date | null {
  const parse =
    parser ??
    ((v: unknown): number | Date =>
      isNumber(v) ? v : isDate(v) ? v : Date.parse(v as string))
  return _ == null || _ === '' ? null : parse(_)
}

/** Coerce to a number (`+value`); `null`/`undefined`/`''` become `null`. */
export function toNumber(_: unknown): number | null {
  return _ == null || _ === '' ? null : +(_ as number | string)
}

/** Coerce to a string (`value + ''`); `null`/`undefined`/`''` become `null`. */
export function toString(_: unknown): string | null {
  return _ == null || _ === '' ? null : (_ as string) + ''
}

// --- access paths ------------------------------------------------------------

/** Throw an `Error` with the given message (upstream's `error` helper). */
export function error(message: string): never {
  throw Error(message)
}

/**
 * Split an access path into its parts, handling `a.b`, `a[0]`, `a['b.c']`,
 * `a["b"]` and backslash escapes, exactly as upstream. Malformed paths
 * (unclosed bracket/quote) throw.
 *
 * NOTE: upstream reads `p.length` **before** coercing `p` to a string, so a
 * non-string input without a `length` property (e.g. the number `0`) yields
 * `n === undefined`, the loop never runs, and the path is empty — the accessor
 * then returns its datum unchanged. The vectors pin this; keep the order.
 */
export function splitAccessPath(p: unknown): string[] {
  const path: string[] = []
  const n = (p as { length?: number }).length as number | undefined
  let q: string | null = null
  let b = 0
  let s = ''
  let str: string
  let i: number
  let j: number
  let c: string | undefined

  const push = (): void => {
    path.push(s + str.substring(i, j))
    s = ''
    i = j + 1
  }

  str = p + ''
  for (i = j = 0; j < (n as number); ++j) {
    c = str[j]
    if (c === '\\') {
      s += str.substring(i, j++)
      i = j
    } else if (c === q) {
      push()
      q = null
      b = -1
    } else if (q) {
      continue
    } else if (i === b && c === '"') {
      i = j + 1
      q = c
    } else if (i === b && c === "'") {
      i = j + 1
      q = c
    } else if (c === '.' && !b) {
      if (j > i) {
        push()
      } else {
        i = j + 1
      }
    } else if (c === '[') {
      if (j > i) push()
      b = i = j + 1
    } else if (c === ']') {
      if (!b) error('Access path missing open bracket: ' + str)
      if (b > 0) push()
      b = 0
      i = j + 1
    }
  }
  if (b) error('Access path missing closing bracket: ' + str)
  if (q) error('Access path missing closing quote: ' + str)
  if (j > i) {
    j++
    push()
  }
  return path
}

const hasOwn = Object.prototype.hasOwnProperty

/**
 * `obj[key]`, except that the prototype-chain/constructor keys of
 * `DisallowedObjectProperties` resolve only when they are *own* properties of
 * `obj` (a data column literally named `constructor` is data; the inherited
 * `Object` constructor is not). This is the shared guard for every dynamic
 * property walk (audit C1); a nullish `obj` falls through to the plain read,
 * which throws as before.
 */
export function safeGet(obj: unknown, key: unknown): unknown {
  const k = String(key)
  if (obj != null && DisallowedObjectProperties.has(k) && !hasOwn.call(Object(obj), k)) return undefined
  return (obj as Record<string, unknown>)[k]
}

/**
 * Own-property read from a spec-keyed table (dataset, signal, scheme, ...).
 * A plain `{}` table inherits `constructor`, `toString`, `__proto__` from
 * `Object.prototype`, so `table[name]` for a spec/data-supplied `name` can
 * return an inherited function or object (audit C50). Use this (or a `Map`)
 * for every lookup keyed by a name that is not a compile-time constant.
 */
export function ownGet<T>(table: Readonly<Record<string, T>> | null | undefined, key: string): T | undefined {
  return table != null && hasOwn.call(table, key) ? table[key] : undefined
}

/**
 * Own-property write that is safe for any key: `__proto__` becomes an
 * ordinary own data property instead of replacing the table's prototype.
 */
export function setOwn<T>(table: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(table, key, { value, writable: true, enumerable: true, configurable: true })
}

/**
 * A fresh name-keyed table with no prototype (`__proto__` is an ordinary key
 * and nothing is inherited), optionally filled from `sources` (own keys only;
 * on a prototype-less target even an own `__proto__` key is plain data).
 */
export function dict<T = unknown>(...sources: Array<Readonly<Record<string, T>> | null | undefined>): Record<string, T> {
  return Object.assign(Object.create(null) as Record<string, T>, ...sources)
}

/** Get a single path component (`obj[field]`). */
function get1(field: string): (obj: unknown) => unknown {
  return (obj) => (obj as Record<string, unknown>)[field]
}

/** Walk a multi-component path, returning `undefined` past a hole. */
function getN(path: readonly string[]): (obj: unknown) => unknown {
  const len = path.length
  return (obj) => {
    let cur = obj
    for (let i = 0; i < len; ++i) {
      cur = (cur as Record<string, unknown>)[path[i] as string]
    }
    return cur
  }
}

/**
 * Composed getter: single-component fast path, walking otherwise. Paths with
 * no risky segment (all of them in practice) use the unguarded closures, so
 * the hot path pays nothing for the guard.
 */
export function getter(path: readonly string[]): (obj: unknown) => unknown {
  if (path.some((p) => DisallowedObjectProperties.has(p))) return (obj) => path.reduce(safeGet, obj)
  return path.length === 1 ? get1(path[0] as string) : getN(path)
}

export interface Accessor<Out = unknown> {
  (d: unknown): Out
  /** The field names this accessor reads, as reported by `accessorFields`. */
  fields: string[]
  /** The accessor's display name (`fname`), if one was given or derived. */
  fname?: string
}

/** Attach `fields` and `fname` to a function, as upstream's `accessor` does. */
export function accessor<Out>(
  fn: (d: unknown) => Out,
  fields?: readonly string[],
  name?: string,
): Accessor<Out> {
  return Object.assign(fn, {
    fields: fields ? fields.slice() : [],
    fname: name,
  }) as Accessor<Out>
}

/** The accessor's display name, or `null` for a non-accessor. */
export function accessorName(fn: unknown): string | null {
  return fn == null ? null : ((fn as Accessor).fname ?? null)
}

/** The field names an accessor reads, or `null` for a non-accessor. */
export function accessorFields(fn: unknown): string[] | null {
  return fn == null ? null : ((fn as Accessor).fields as string[]) ?? null
}

/**
 * An accessor for a field path: `field('a.b')` reads `d.a.b`. The reported
 * `fields` is the single path (dotted) when it has one component, else the
 * original string — matching upstream. The path is *not* required to be a
 * string: a value without `length` (e.g. a number) produces an empty path and
 * an accessor that returns its datum unchanged, as upstream does.
 */
export function field(str: unknown, name?: string, opt?: { get?: (path: readonly string[]) => (d: unknown) => unknown }): Accessor {
  const path = splitAccessPath(str)
  const fieldName = path.length === 1 ? (path[0] as string) : (str as string)
  return accessor((opt && opt.get || getter)(path), [fieldName], name || fieldName)
}

// --- ordering ----------------------------------------------------------------

/**
 * Upstream's total ordering used by every comparison in the engine: `null`
 * sorts before everything, `NaN` compares equal to *everything* (so a `NaN`
 * never reorders a sort), and `Date` instances compare by their epoch value.
 */
export function ascending(_u: unknown, _v: unknown): -1 | 0 | 1 {
  let u = _u
  let v = _v
  return (lt(u, v) || u == null) && v != null ? -1
    : (gt(u, v) || v == null) && u != null ? 1
      : ((v = v instanceof Date ? +v : v), (u = u instanceof Date ? +u : u)) !== u && v === v ? -1
        : v !== v && u === u ? 1
          : 0
}

// --- extents -----------------------------------------------------------------

/**
 * `[min, max]` of an array, optionally read through an accessor. Skips
 * `null`/`undefined`; `NaN` values fail every comparison and are skipped the
 * same way. Empty (or all-invalid) input yields `[undefined, undefined]`.
 * Comparison is `<`/`>`, so mixed types behave exactly as upstream (e.g.
 * `extent([1, '2'])` is `[1, '2']`).
 */
/** Upstream compares untyped values with `<`/`>`; these keep that semantics. */
function lt(a: unknown, b: unknown): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (a as any) < (b as any)
}
function gt(a: unknown, b: unknown): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (a as any) > (b as any)
}

export function extent<T>(
  array: ArrayLike<T> | null | undefined,
  f?: (d: T) => unknown,
): [unknown, unknown] {
  let i = 0
  let v: unknown
  let min: unknown
  let max: unknown
  const n = array && array.length
  if (n) {
    if (f == null) {
      for (v = array[i]; i < n && (v == null || v !== v); v = array[++i]) { /* skip */ }
      min = max = v
      for (; i < n; ++i) {
        v = array[i]
        if (v != null) {
          if (lt(v, min)) min = v
          if (gt(v, max)) max = v
        }
      }
    } else {
      // the loop guard bounds i below n, so the indexed element exists
      for (v = f(array[i] as T); i < n && (v == null || v !== v); v = f(array[++i] as T)) { /* skip */ }
      min = max = v
      for (; i < n; ++i) {
        v = f(array[i] as T)
        if (v != null) {
          if (lt(v, min)) min = v
          if (gt(v, max)) max = v
        }
      }
    }
  }
  return [min, max]
}

/**
 * `Math.min(...a)` without the argument spread: spreading a data-sized array
 * overflows the call stack at roughly 120k-200k elements (C42). Same result as
 * Math.min(...a): NaN propagates, an empty array gives Infinity.
 */
export function minOf(a: ArrayLike<number>): number {
  let m = Infinity
  for (let i = 0; i < a.length; i++) m = Math.min(m, a[i]!)
  return m
}

/** `Math.max(...a)` without the argument spread (see {@link minOf}); empty gives -Infinity. */
export function maxOf(a: ArrayLike<number>): number {
  let m = -Infinity
  for (let i = 0; i < a.length; i++) m = Math.max(m, a[i]!)
  return m
}

/** `target.push(...src)` without the argument spread (see {@link minOf}). */
export function pushAll<T>(target: T[], src: ArrayLike<T>): void {
  for (let i = 0; i < src.length; i++) target.push(src[i]!)
}

// --- accessors (constant accessor factories) ---------------------------------

/** The `id` field accessor. */
export const id = /* @__PURE__ */ field('id')
/** The identity accessor. */
export const identity = /* @__PURE__ */ accessor((_) => _, [], 'identity')
export const zero = /* @__PURE__ */ accessor(() => 0, [], 'zero')
export const one = /* @__PURE__ */ accessor(() => 1, [], 'one')
export const truthy = /* @__PURE__ */ accessor(() => true, [], 'true')
export const falsy = /* @__PURE__ */ accessor(() => false, [], 'false')

// --- expression helpers ------------------------------------------------------

/**
 * Memoized `field` accessors, keyed by the *stringified* name — upstream
 * memoizes in a plain object, so `pluck(d, 0)` and `pluck(d, '0')` share one
 * accessor. The keys match; the accessor is built from the raw name, whose
 * path-splitting quirks the vectors pin.
 */
const pluckAccessors = new Map<string, Accessor>()

/**
 * Read `name` off a datum, or off every datum of an array — the upstream
 * `pluck` expression function (`field` + `isArray`).
 */
export function pluck(data: unknown, name: unknown): unknown {
  const key = String(name)
  let f = pluckAccessors.get(key)
  if (!f) {
    f = field(name)
    pluckAccessors.set(key, f)
  }
  return isArray(data) ? (data as unknown[]).map(f) : f(data)
}

/** vega-scenegraph `shapes.js` `sz`: an item without `size` is a 64px² symbol. */
export const SYMBOL_DEFAULT_SIZE = 64

// --- ranges and pan / zoom (vega-util inrange, clampRange, transform) ---------

/**
 * vega-util `inrange`: whether `value` lies within the span of `range` (its first and last entry, in either
 * order). `left` / `right` choose inclusive (default) or exclusive comparisons for the lower / upper end.
 */
export function inrange(value: unknown, range: readonly unknown[], left?: boolean, right?: boolean): boolean {
  let r0 = range[0] as number
  let r1 = range[range.length - 1] as number
  if (r0 > r1) {
    const t = r0
    r0 = r1
    r1 = t
  }
  const inclusiveLeft = left === undefined || left
  const inclusiveRight = right === undefined || right
  const v = value as number
  return (inclusiveLeft ? r0 <= v : r0 < v) && (inclusiveRight ? v <= r1 : v < r1)
}

/**
 * vega-util `clampRange`: span-preserving clamp. A reversed range is put in order first; a span that fills
 * `[min, max]` yields `[min, max]`; otherwise the range is translated until it sits inside.
 */
export function clampRange(range: readonly number[], min: number, max: number): number[] {
  let lo = range[0] as number
  let hi = range[1] as number
  let span: number
  if (hi < lo) {
    span = hi
    hi = lo
    lo = span
  }
  span = hi - lo
  return span >= max - min
    ? [min, max]
    : [(lo = Math.min(Math.max(lo, min), max - span)), lo + span]
}

type TransformFn = (x: number) => number
type Anchor = number | null | undefined
const expT = (sign: number): TransformFn => (x) => sign * Math.exp(x)
const logT = (sign: number): TransformFn => (x) => Math.log(sign * x)
const symlogT = (c: number): TransformFn => (x) => Math.sign(x) * Math.log1p(Math.abs(x / c))
const symexpT = (c: number): TransformFn => (x) => Math.sign(x) * Math.expm1(Math.abs(x)) * c
const powT = (exponent: number): TransformFn => (x) => (x < 0 ? -Math.pow(-x, exponent) : Math.pow(x, exponent))
const coerceNumber: TransformFn = (x) => toNumber(x) ?? 0
const identityT: TransformFn = (x) => x

function pan(domain: readonly number[], delta: number, lift: TransformFn, ground: TransformFn): [number, number] {
  if (!domain.length) error('Domain array must not be empty')
  const d0 = lift(domain[0] as number)
  const d1 = lift(domain[domain.length - 1] as number)
  const dd = (d1 - d0) * delta
  return [ground(d0 - dd), ground(d1 - dd)]
}
export const panLinear = (domain: readonly number[], delta: number): [number, number] => pan(domain, delta, coerceNumber, identityT)
export const panLog = (domain: readonly number[], delta: number): [number, number] => {
  const sign = Math.sign(domain[0] as number)
  return pan(domain, delta, logT(sign), expT(sign))
}
export const panPow = (domain: readonly number[], delta: number, exponent: number): [number, number] => pan(domain, delta, powT(exponent), powT(1 / exponent))
export const panSymlog = (domain: readonly number[], delta: number, constant: number): [number, number] => pan(domain, delta, symlogT(constant), symexpT(constant))

function zoom(domain: readonly number[], anchor: Anchor, scale: number, lift: TransformFn, ground: TransformFn): [number, number] {
  if (!domain.length) error('Domain array must not be empty')
  const d0 = lift(domain[0] as number)
  const d1 = lift(domain[domain.length - 1] as number)
  const da = anchor != null ? lift(anchor) : (d0 + d1) / 2
  return [ground(da + (d0 - da) * scale), ground(da + (d1 - da) * scale)]
}
export const zoomLinear = (domain: readonly number[], anchor: Anchor, scale: number): [number, number] => zoom(domain, anchor, scale, coerceNumber, identityT)
export const zoomLog = (domain: readonly number[], anchor: Anchor, scale: number): [number, number] => {
  const sign = Math.sign(domain[0] as number)
  return zoom(domain, anchor, scale, logT(sign), expT(sign))
}
export const zoomPow = (domain: readonly number[], anchor: Anchor, scale: number, exponent: number): [number, number] => zoom(domain, anchor, scale, powT(exponent), powT(1 / exponent))
export const zoomSymlog = (domain: readonly number[], anchor: Anchor, scale: number, constant: number): [number, number] => zoom(domain, anchor, scale, symlogT(constant), symexpT(constant))

// --- tuples ------------------------------------------------------------------

/**
 * Marks an object as a data tuple (vega-dataflow's `Symbol('vega_id')`): the scene items the event loop
 * hands to expressions (`item()`, `group()`) carry it, so `isTuple(group())` is true for a group item and
 * false for the `{}` that `group()` returns when there is none.
 */
export const TUPLE_ID: unique symbol = Symbol.for('aster.tuple') as never

/**
 * On the `mark` of a picked item's facade: the scene node (the mark container, or the group mark for a group item) it stands for,
 * which `intersect()` walks when handed `unit.mark`.
 */
export const MARK_NODE: unique symbol = Symbol.for('aster.markNode') as never

/** vega-dataflow `isTuple`: whether the value is a registered tuple. */
export function isTuple(t: unknown): boolean {
  return !!(t && (typeof t === 'object' || typeof t === 'function') && (t as Record<symbol, unknown>)[TUPLE_ID])
}

/**
 * The store key of a signal declared by a group scope: `<scope id>:<name>`. A scope id is the path of group marks
 * from the root (`name@seq`, each plus `[key]` for a facet partition or a datum index): see `SceneGroup.scopeSignals`.
 */
export const scopedSignalName = (scopeId: string, name: string): string => `${scopeId}:${name}`
