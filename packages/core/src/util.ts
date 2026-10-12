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

/** Composed getter: single-component fast path, walking otherwise. */
export function getter(path: readonly string[]): (obj: unknown) => unknown {
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
