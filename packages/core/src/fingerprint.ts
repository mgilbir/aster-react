/**
 * Typed value fingerprints and structural equality for cache keys.
 *
 * The incremental runtime and the session no-op cache decide "is this input the
 * same as last time?" from a fingerprint. Three properties matter:
 *
 * - **Typed**: `1`, `"1"`, `true`, `null` and `undefined` never collide (a
 *   `String(v)` key made signal `1` and `"1"` equal; primitives all hashed to
 *   one id, so replacing an inline CSV string never invalidated anything).
 * - **Structural for plain data, whatever its size**: a derived signal such as `[0, width]` returns a fresh array on every
 *   evaluation, and so does one such as `sequence(0, 600)`. A value small enough is keyed by its text; a larger one by a one-pass
 *   hash of all of its content (two independent 32-bit lanes and the length of what was hashed, so two different values share a key
 *   with a chance near 2^-64). A value its owner changed in place (a host's array, a typed array) is a new key, as an equal fresh
 *   copy is the same key.
 * - **Engine arrays by their stamp**: a dataset's rows as the engine publishes them (`publishRows`) are keyed by their content while
 *   small, and past that by their content stamp (content-stamp.ts): the array and how many times the engine wrote it in place. The
 *   engine advances such arrays in place, so their identity alone is not their content, and hashing a dataset for every key would
 *   cost every evaluation the size of the data.
 *
 * `valuesEqual(a, b)` is `Object.is(a, b) || valueKey(a) === valueKey(b)`: the two never disagree. Functions and class instances
 * other than Date, Set and the typed arrays are keyed by identity: a different object is a miss, never a stale hit.
 */
import { idOf, stampKey } from './content-stamp.js'

/** A process-unique id for an object/function (identity key). */
export function refId(v: object): number {
  return idOf(v)
}

/** The engine's published dataset arrays (see the header): keyed by their stamp past the text budget. */
const PUBLISHED = new WeakSet<object>()

/** Say that `rows` are a dataset's rows as the engine publishes them (what `data()` reads). */
export function publishRows(rows: readonly unknown[]): void {
  PUBLISHED.add(rows)
}

/** Bounds of the text key: past them the value is keyed by the hash of its content. */
const MAX_DEPTH = 6
const MAX_NODES = 512

function isPlainObject(v: object): boolean {
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

const isTypedArray = (v: object): v is ArrayBufferView & ArrayLike<number | bigint> => ArrayBuffer.isView(v) && !(v instanceof DataView)

/** A symbol's key: a registered one by its key, any other by identity (two symbols with one description are two values). */
// (a symbol is a weak key where the engine allows it; elsewhere -- an engine without symbols as weak keys -- the ids are kept)
let SYMBOL_IDS: WeakMap<symbol, number> | Map<symbol, number> = new WeakMap<symbol, number>()
let symbolSeq = 0
function symbolKey(v: symbol): string {
  const registered = Symbol.keyFor(v)
  if (registered !== undefined) return `yR${registered.length}:${registered}`
  let id = SYMBOL_IDS.get(v)
  if (id === undefined) {
    id = ++symbolSeq
    try { SYMBOL_IDS.set(v, id) } catch { SYMBOL_IDS = new Map([[v, id]]) }
  }
  return `y#${id}`
}

/**
 * A typed fingerprint of `v`. Equal plain-data values produce equal keys;
 * values of different types never do.
 */
export function valueKey(v: unknown): string {
  const key = keyOf(v, 0, { nodes: 0 })
  return key ?? hashKey(v)
}

/** `null` means "past the text budget": the caller hashes the content. */
function keyOf(v: unknown, depth: number, budget: { nodes: number }): string | null {
  if (++budget.nodes > MAX_NODES) return null
  switch (typeof v) {
    case 'undefined': return 'u'
    case 'boolean': return v ? 'b1' : 'b0'
    case 'number': return Object.is(v, -0) ? 'n-0' : `n${v}`
    case 'bigint': return `i${v}`
    case 'string': return `s${v.length}:${v}`
    case 'symbol': return symbolKey(v)
    case 'function': return `#${refId(v)}`
    default: break
  }
  if (v === null) return 'N'
  const obj = v as object
  if (depth >= MAX_DEPTH) return null
  if (obj instanceof Date) return `D${obj.getTime()}`
  if (Array.isArray(obj)) {
    const parts: string[] = []
    for (let i = 0; i < obj.length; i++) {
      const k = keyOf(obj[i], depth + 1, budget)
      if (k == null) return null
      parts.push(k)
    }
    return `[${parts.join(',')}]`
  }
  if (obj instanceof Set) {
    const parts: string[] = []
    for (const x of obj) {
      const k = keyOf(x, depth + 1, budget)
      if (k == null) return null
      parts.push(k)
    }
    return `S[${parts.join(',')}]`
  }
  if (isTypedArray(obj)) {
    if ((budget.nodes += obj.length) > MAX_NODES) return null
    return `T${obj.constructor.name}[${Array.prototype.join.call(obj, ',')}]`
  }
  if (!isPlainObject(obj)) return `#${refId(obj)}`
  const parts: string[] = []
  for (const name of Object.keys(obj).sort()) {
    const k = keyOf((obj as Record<string, unknown>)[name], depth + 1, budget)
    if (k == null) return null
    parts.push(`${name.length}:${name}=${k}`)
  }
  return `{${parts.join(',')}}`
}

/**
 * The key of a value past the text budget: a hash of ALL of its content, in one pass, with no bound (a published dataset array is
 * its stamp; a cycle is a back-reference). It reads what the text key reads, so it tells apart exactly what the text would.
 */
function hashKey(v: unknown): string {
  if (v !== null && typeof v === 'object' && PUBLISHED.has(v)) return stampKey(v)
  let h1 = 0x811c9dc5
  let h2 = 0x9e3779b9
  let n = 0
  const mix = (s: string): void => {
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i)
      h1 = Math.imul(h1 ^ c, 0x01000193)
      h2 = Math.imul(h2 ^ c, 0x5bd1e995)
      h2 ^= h2 >>> 15
    }
    n += s.length
  }
  const path = new Map<object, number>()
  const walk = (x: unknown): void => {
    switch (typeof x) {
      case 'undefined': return mix('u;')
      case 'boolean': return mix(x ? 'b1;' : 'b0;')
      case 'number': return mix(Object.is(x, -0) ? 'n-0;' : `n${x};`)
      case 'bigint': return mix(`i${x};`)
      case 'string': return mix(`s${x.length}:${x};`)
      case 'symbol': return mix(`${symbolKey(x)};`)
      case 'function': return mix(`#${refId(x)};`)
    }
    if (x === null) return mix('N;')
    const o = x as object
    if (PUBLISHED.has(o)) return mix(`${stampKey(o)};`)
    if (o instanceof Date) return mix(`D${o.getTime()};`)
    const back = path.get(o)
    if (back !== undefined) return mix(`^${back};`)
    if (isTypedArray(o)) return mix(`T${o.constructor.name}[${Array.prototype.join.call(o, ',')}];`)
    if (!(Array.isArray(o) || o instanceof Set || isPlainObject(o))) return mix(`#${refId(o)};`)
    path.set(o, path.size)
    if (Array.isArray(o)) {
      mix(`[${o.length}:`)
      for (let i = 0; i < o.length; i++) walk(o[i])
      mix(']')
    } else if (o instanceof Set) {
      mix(`S[${o.size}:`)
      for (const e of o) walk(e)
      mix(']')
    } else {
      const keys = Object.keys(o).sort()
      mix(`{${keys.length}:`)
      for (const k of keys) { mix(`${k.length}:${k}=`); walk((o as Record<string, unknown>)[k]) }
      mix('}')
    }
    path.delete(o)
  }
  walk(v)
  return `H${(h1 >>> 0).toString(36)}.${(h2 >>> 0).toString(36)}.${n.toString(36)}`
}

/** Structural equality for signal values: equal exactly when their keys are (`valueKey`), or the very same value. */
export function valuesEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  // (two different primitives, symbols or functions are different values; only objects are compared by content)
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  return valueKey(a) === valueKey(b)
}
