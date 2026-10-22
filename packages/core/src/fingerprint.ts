/**
 * Typed value fingerprints and structural equality for cache keys.
 *
 * The incremental runtime and the session no-op cache decide "is this input the
 * same as last time?" from a fingerprint. Two properties matter:
 *
 * - **Typed**: `1`, `"1"`, `true`, `null` and `undefined` never collide (a
 *   `String(v)` key made signal `1` and `"1"` equal; primitives all hashed to
 *   one id, so replacing an inline CSV string never invalidated anything).
 * - **Structural for plain data**: a derived signal such as `[0, width]` returns
 *   a fresh array on every evaluation. Keyed by identity it defeated every
 *   cache; keyed by structure, an unchanged value hashes to the same key.
 *
 * Anything that is not plain data (functions, class instances, Maps, typed
 * arrays, over-large or cyclic structures) falls back to a per-object identity
 * id: the key then differs for a different object, which is always the safe
 * direction (a miss, never a stale hit).
 */

const REF_IDS = new WeakMap<object, number>()
let REF_SEQ = 0

/** A process-unique id for an object/function (identity key). */
export function refId(v: object): number {
  let id = REF_IDS.get(v)
  if (id === undefined) {
    id = ++REF_SEQ
    REF_IDS.set(v, id)
  }
  return id
}

/** Bounds that keep a fingerprint O(small) even for pathological signal values. */
const MAX_DEPTH = 6
const MAX_NODES = 512

function isPlainObject(v: object): boolean {
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

/**
 * A typed fingerprint of `v`. Equal plain-data values produce equal keys;
 * values of different types never do.
 */
export function valueKey(v: unknown): string {
  const budget = { nodes: 0 }
  const key = keyOf(v, 0, budget)
  return key ?? `#${refId(v as object)}`
}

/** `null` means "too large / unsupported": the caller falls back to identity. */
function keyOf(v: unknown, depth: number, budget: { nodes: number }): string | null {
  if (++budget.nodes > MAX_NODES) return null
  switch (typeof v) {
    case 'undefined': return 'u'
    case 'boolean': return v ? 'b1' : 'b0'
    case 'number': return Object.is(v, -0) ? 'n-0' : `n${v}`
    case 'bigint': return `i${v}`
    case 'string': return `s${v.length}:${v}`
    case 'symbol': return `y${String(v)}`
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
 * Structural equality for signal values: `Object.is` for primitives, deep for
 * plain arrays/objects/Dates (bounded like `valueKey`), identity otherwise.
 */
export function valuesEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  return eq(a, b, 0, { nodes: 0 })
}

function eq(a: unknown, b: unknown, depth: number, budget: { nodes: number }): boolean {
  if (Object.is(a, b)) return true
  if (++budget.nodes > MAX_NODES || depth >= MAX_DEPTH) return false
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  if (a instanceof Date) return b instanceof Date && a.getTime() === b.getTime()
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!eq(a[i], b[i], depth + 1, budget)) return false
    return true
  }
  if (Array.isArray(b) || !isPlainObject(a) || !isPlainObject(b)) return false
  const ak = Object.keys(a)
  if (ak.length !== Object.keys(b).length) return false
  for (const k of ak) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false
    if (!eq((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], depth + 1, budget)) return false
  }
  return true
}
