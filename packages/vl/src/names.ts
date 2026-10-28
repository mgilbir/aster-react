/**
 * Field-name and generated-name helpers. EVERY place that lets a user-supplied
 * field name reach an expression string, a generated field name, or a signal
 * name goes through this module (audit C37):
 *
 *  - expressions reference fields with `datum[<JSON string>]` (never string
 *    concatenation into a quoted literal), so a hostile name cannot restructure
 *    the expression;
 *  - Vega `field:` properties are access paths (`a.b` is nested, `a\.b` flat),
 *    so flat keys are emitted escaped;
 *  - generated names (`sum_x`, `bin_maxbins_10_x`, `month_t`, signals) are
 *    sanitized: the characters Vega's access-path / signal grammar treats
 *    specially never appear in them, and a hash of the original name keeps two
 *    different inputs from colliding after sanitizing.
 */

export class VLCompileError extends Error {
  constructor(message: string) {
    super(`[aster/vl] ${message}`)
    this.name = 'VLCompileError'
  }
}

/** Port of vega-util splitAccessPath (throws VLCompileError on a malformed path). */
export function splitAccessPath(p: string): string[] {
  const path: string[] = []
  const n = p.length
  let q: string | null = null
  let b = 0
  let s = ''
  let i = 0
  let j = 0
  const push = (): void => {
    path.push(s + p.substring(i, j))
    s = ''
    i = j + 1
  }
  for (; j < n; ++j) {
    const c = p[j]!
    if (c === '\\') {
      s += p.substring(i, j++)
      i = j
    } else if (c === q) {
      push()
      q = null
      b = -1
    } else if (q) {
      continue
    } else if (i === b && (c === '"' || c === "'")) {
      i = j + 1
      q = c
    } else if (c === '.' && !b) {
      if (j > i) push()
      else i = j + 1
    } else if (c === '[') {
      if (j > i) push()
      b = i = j + 1
    } else if (c === ']') {
      if (!b) throw new VLCompileError(`invalid field name ${JSON.stringify(p)}: access path is missing an open bracket (escape literal brackets with a backslash)`)
      if (b > 0) push()
      b = 0
      i = j + 1
    }
  }
  if (b) throw new VLCompileError(`invalid field name ${JSON.stringify(p)}: access path is missing a closing bracket (escape literal brackets with a backslash)`)
  if (q) throw new VLCompileError(`invalid field name ${JSON.stringify(p)}: access path is missing a closing quote`)
  if (j > i) {
    j++
    push()
  }
  return path
}

/** FNV-1a (32-bit) of a string, as 6 hex digits. */
function hash(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0').slice(0, 6)
}

/** True when `key` survives the access-path round trip unchanged. */
function roundTrips(key: string): boolean {
  if (key === '') return false
  const parts = splitAccessPath(key)
  return parts.length === 1 && parts[0] === key
}

/**
 * A key that is safe as a generated (`as`) field name AND as a `field:` access
 * path: identity for ordinary names, sanitized + hashed otherwise.
 */
export function safeKey(key: string): string {
  let ok = false
  try {
    ok = roundTrips(key)
  } catch {
    ok = false
  }
  if (ok) return key
  return `${key.replace(/[^\w ]/g, '_')}_${hash(key)}`
}

/** A name safe as a Vega signal / dataset identifier (word characters only). */
export function signalSafe(key: string): string {
  if (/^\w+$/.test(key)) return key
  return `${key.replace(/[^\w]/g, '_')}_${hash(key)}`
}

/**
 * A user field path (as written in a Vega-Lite spec) resolved to the flat,
 * access-path-safe key the compiler uses everywhere internally.
 *
 *  - an ordinary column name ("IMDB Rating", "a'b") keeps its name;
 *  - a nested path ("o.v", "a[0]") or an escaped key ("a\\.b") gets a sanitized
 *    key, and `expr` (a Vega expression that reads the ORIGINAL location)
 *    tells the pipeline to copy the value into that key once, up front.
 *
 * After that copy every field reference is a flat key, so `field:` properties,
 * `datum["key"]` expressions and `${key}_start`-style generated names are all
 * valid without further escaping.
 */
export interface FlatField {
  key: string
  /** Present when the pipeline must materialize `key` from the original path. */
  expr?: string
}

export function flatField(userPath: string): FlatField {
  const parts = splitAccessPath(userPath) // throws VLCompileError when malformed
  if (parts.length === 1 && parts[0] === userPath && roundTrips(userPath)) return { key: userPath }
  return { key: safeKey(userPath), expr: guardedPathRef(userPath) }
}

/** `datum["key"]` for a flat key (JSON-escaped; never spliced into a quoted literal). */
export function datumRef(key: string): string {
  return `datum[${JSON.stringify(key)}]`
}

/** `datum["a"]["b"]` for a (possibly nested) user field path. */
export function datumPathRef(userPath: string): string {
  return 'datum' + splitAccessPath(userPath).map((p) => `[${JSON.stringify(p)}]`).join('')
}

/**
 * A nested user path read the way vega-lite flattens it (util.ts accessPathWithDatum): every prefix is
 * tested before the next step, `datum["o"] && datum["o"]["v"]`, so a row that lacks `o` yields a missing
 * value instead of a TypeError. A one-piece path is just `datum["a"]`.
 */
export function guardedPathRef(userPath: string): string {
  const parts = splitAccessPath(userPath)
  return parts.map((_, i) => 'datum' + parts.slice(0, i + 1).map((p) => `[${JSON.stringify(p)}]`).join('')).join(' && ')
}

/** util.ts flatAccessWithDatum: the flattened field, `datum["o.v"]` for `o.v` (the copy a parse transform wrote under the joined path). */
export function flatAccessRef(userPath: string): string {
  return `datum[${JSON.stringify(splitAccessPath(userPath).join('.'))}]`
}

/** util.ts replacePathInField: a path as a Vega field name that reads the flat key, `o\\.v` for `o.v`. */
export function replacePathInField(userPath: string): string {
  return splitAccessPath(userPath).map((p) => p.replace(/(\[|\]|\.|'|")/g, '\\$1')).join('\\.')
}

/** Generated field name `prefix_key` (flat-safe). */
export function genName(prefix: string, key: string): string {
  return safeKey(`${prefix}_${key}`)
}

/** Generated signal name `prefix_key`; word characters only. */
export function genSignal(prefix: string, key: string): string {
  return signalSafe(`${prefix}_${key}`)
}

/** `isValid(x) && isFinite(+x)` on a flat key. */
export function validExpr(key: string): string {
  const r = datumRef(key)
  return `isValid(${r}) && isFinite(+${r})`
}

/** Append every item (a spread push would overflow the stack for a huge list; these are spec-sized, but the rule is uniform). */
export function pushAll<T>(target: T[], items: readonly T[]): void {
  for (const x of items) target.push(x)
}
