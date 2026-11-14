/**
 * The user's rows, as the compiler sees them: opaque payloads.
 *
 * compile edits its copy of the spec in place, so the spec has to be copied first. The copy covers the spec's
 * structure (views, encodings, transforms, config) but not its rows: an inline `data.values` and every entry of
 * `datasets` stays the user's own array or object, carried by reference. Copying them would make compiling cost
 * as much as the data is big.
 *
 * While a compile runs, its payloads are registered here (`withRows`), so the compiler's generic walks over specs
 * can step over them (`isRows`), and the few decisions that do depend on rows (are two layers' data the same
 * dataset? what is an anonymous lookup source named after?) read each payload at most once per compile
 * (`sameJson`, `jsonWithRows`). The registry lives for one synchronous compile call and holds nothing afterwards.
 * `detachRows` gives the output a private top-level array for each payload, so a caller that edits the compiled
 * spec can't reach the input. test/data-independence.test.ts counts every read of a row and deep-freezes the input.
 */

import { VLCompileError } from './names.js'

type Obj = Record<string, unknown>

/** The user's row payloads a copy carries by reference. */
export type RowPayloads = Set<object>

/** Rows: the `values` of a `data` object (a view's `data`, a lookup's `from.data`) and every entry of `datasets`. */
const isPayload = (parentKey: string, key: string): boolean => (parentKey === 'data' && key === 'values') || parentKey === 'datasets'

const isPlain = (v: object): boolean => {
  if (Array.isArray(v)) return true
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

/**
 * Copy `input` the way structuredClone does (shared and cyclic objects stay shared and cyclic, holes stay holes, a
 * `__proto__` key stays an own key, a value structuredClone refuses throws the same message), except for row payloads.
 */
export function cloneSpecStructure(input: unknown, payloads: RowPayloads): Obj {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new VLCompileError('a Vega-Lite spec must be a JSON object')
  const memo = new Map<object, unknown>()
  const copy = (v: unknown, parentKey: string, key: string): unknown => {
    if (v !== null && typeof v === 'object' && isPayload(parentKey, key)) {
      payloads.add(v)
      return v
    }
    if (v === null || typeof v !== 'object') {
      // (structuredClone refuses functions and symbols wherever they are)
      if (typeof v === 'function' || typeof v === 'symbol') return structured(v)
      return v
    }
    const seen = memo.get(v)
    if (seen !== undefined) return seen
    if (!isPlain(v)) {
      const out = structured(v)
      memo.set(v, out)
      return out
    }
    if (Array.isArray(v)) {
      const out: unknown[] = new Array(v.length)
      memo.set(v, out)
      for (let i = 0; i < v.length; i++) if (i in v) out[i] = copy(v[i], key, '')
      return out
    }
    const out: Obj = {}
    memo.set(v, out)
    for (const k of Object.keys(v)) {
      const value = copy((v as Obj)[k], key, k)
      if (k === '__proto__') Object.defineProperty(out, k, { value, writable: true, enumerable: true, configurable: true })
      else out[k] = value
    }
    return out
  }
  return copy(input, '', '') as Obj
}

function structured(v: unknown): unknown {
  try {
    return structuredClone(v)
  } catch (e) {
    throw new VLCompileError(`the spec must be plain JSON-compatible data (${(e as Error).message})`)
  }
}

/**
 * Give the compiled spec its own top-level array (or object) wherever it holds one of the user's payloads, so a caller
 * that pushes onto a compiled `values` doesn't push onto the input. The rows themselves are shared, as vega-lite shares them.
 * Walks the compiled spec only: a payload is replaced, never entered. Two places that held the same payload hold the same copy.
 */
export function detachRows(out: Obj, payloads: RowPayloads): void {
  if (payloads.size === 0) return
  const copies = new Map<object, unknown>()
  const seen = new Set<object>()
  const visit = (node: object): void => {
    if (seen.has(node)) return
    seen.add(node)
    const keys = Array.isArray(node) ? node.keys() : Object.keys(node)
    for (const k of keys) {
      const v = (node as Record<string | number, unknown>)[k]
      if (v === null || typeof v !== 'object') continue
      if (payloads.has(v)) {
        let copy = copies.get(v)
        if (copy === undefined) copies.set(v, (copy = Array.isArray(v) ? v.slice() : { ...v }))
        ;(node as Record<string | number, unknown>)[k] = copy
      } else {
        visit(v)
      }
    }
  }
  visit(out)
}

// --- the compile in progress ---------------------------------------------------------------------------------------

interface RowScope {
  payloads: RowPayloads
  /** sameRows results: payload -> payload -> equal */
  equal: Map<object, Map<object, boolean>>
  /** rowsJson results */
  json: Map<object, string>
}

let scope: RowScope | undefined

/** Run `f` (a compile) with `payloads` registered as the user's rows. Re-entrant: the previous registration is restored. */
export function withRows<T>(payloads: RowPayloads, f: () => T): T {
  const saved = scope
  scope = { payloads, equal: new Map(), json: new Map() }
  try {
    return f()
  } finally {
    scope = saved
  }
}

/** Whether `v` is one of the user's row payloads in the compile in progress: a walk over a spec steps over it. */
export function isRows(v: unknown): boolean {
  return scope !== undefined && v !== null && typeof v === 'object' && scope.payloads.has(v)
}

/** JSON.stringify of a payload, once per compile (outside a compile, every time). */
function rowsJson(v: object): string {
  const cached = scope?.json.get(v)
  if (cached !== undefined) return cached
  const text = JSON.stringify(v) ?? 'null'
  scope?.json.set(v, text)
  return text
}

/** Whether two payloads write the same JSON. Equal-but-distinct arrays are compared row by row, stopping at the first difference. */
function sameRows(a: object, b: object): boolean {
  if (a === b) return true
  const known = scope?.equal.get(a)?.get(b)
  if (known !== undefined) return known
  const result = Array.isArray(a) && Array.isArray(b) ? sameArrayJson(a, b) : rowsJson(a) === rowsJson(b)
  if (scope) {
    for (const [x, y] of [[a, b], [b, a]] as const) {
      let m = scope.equal.get(x)
      if (!m) scope.equal.set(x, (m = new Map()))
      m.set(y, result)
    }
  }
  return result
}

/** JSON.stringify(a) === JSON.stringify(b) for two arrays: an array writes its elements in order, each as JSON (`null` for what JSON has no value for). */
function sameArrayJson(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (x === y && (x === null || typeof x !== 'object')) continue
    if ((JSON.stringify(x) ?? 'null') !== (JSON.stringify(y) ?? 'null')) return false
  }
  return true
}

/** Where a payload stood in `stringifyWithoutRows` text. */
const ROWS_MARK = '\u0000rows\u0000'

/** JSON.stringify of `v` with every payload written as a marker (`undefined` when the spec itself spells the marker). */
function textAround(v: unknown, found: object[]): string | undefined {
  const active = scope!
  let spelled = false
  const text = JSON.stringify(v, (k, x: unknown) => {
    if (k.includes(ROWS_MARK) || (typeof x === 'string' && x.includes(ROWS_MARK))) spelled = true
    if (x !== null && typeof x === 'object' && active.payloads.has(x)) {
      found.push(x)
      return ROWS_MARK
    }
    return x
  }) ?? 'undefined'
  return spelled ? undefined : text
}

/** JSON.stringify of `v` with every payload written as the same marker: the text of the spec around its rows (for comparing what is not rows). */
export function stringifyWithoutRows(v: unknown): string {
  if (scope === undefined || scope.payloads.size === 0) return JSON.stringify(v) ?? 'undefined'
  return textAround(v, []) ?? JSON.stringify(v) ?? 'undefined'
}

/**
 * JSON.stringify(a) === JSON.stringify(b), reading rows only when it must: the text around the payloads is compared
 * first, then the payloads pairwise (the same payload is equal to itself; distinct ones are compared once per compile).
 */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (scope === undefined || scope.payloads.size === 0) return JSON.stringify(a) === JSON.stringify(b)
  const ra: object[] = []
  const rb: object[] = []
  const ta = textAround(a, ra)
  const tb = textAround(b, rb)
  if (ta === undefined || tb === undefined) return JSON.stringify(a) === JSON.stringify(b)
  if (ta !== tb || ra.length !== rb.length) return false
  return ra.every((x, i) => sameRows(x, rb[i]!))
}

/** JSON.stringify(v), with each payload's text computed once per compile. */
export function jsonWithRows(v: unknown): string {
  if (scope === undefined || scope.payloads.size === 0) return JSON.stringify(v) ?? 'undefined'
  const found: object[] = []
  const text = textAround(v, found)
  if (text === undefined) return JSON.stringify(v) ?? 'undefined'
  if (!found.length) return text
  let i = 0
  return text.replaceAll(JSON.stringify(ROWS_MARK), () => rowsJson(found[i++]!))
}
