/**
 * Dataflow pulses.
 *
 * Vega's runtime is a pulse graph: a source dataset emits a change tuple, each
 * transform propagates it to its targets, and only the dirty marks re-encode.
 * Aster evaluates eagerly; what it takes from pulses is inferring a source pulse
 * automatically when a host hands over new immutable row arrays (no explicit
 * `dataChanges` needed), which the evaluation then follows through the steps
 * (incremental-engine.ts).
 *
 * A pulse carries more than the changed indices: length-changing updates
 * (append/insert/delete) also carry an index mapping (`from`/`to`) and the
 * added/removed ranges. Downstream transforms and marks use that mapping to
 * splice their cached rows/items instead of rebuilding the world.
 *
 * Pulses are plain data so hosts can inspect them in tests/devtools.
 */
import type { CompiledData } from './types.js'

/** A contiguous range `[start, end)` in an array. */
export type PulseRange = [number, number]

export interface RowDiff {
  /** Indices (into the new rows) whose values changed. */
  changed: number[]
  /** True when the new array has the same length and row order. */
  sameLength: boolean
  /** First appended range `[start, end)` into the new rows, if any. */
  added: PulseRange | null
  /** First removed range `[start, end)` from the previous rows, if any. */
  removed: PulseRange | null
  /**
   * Length-changing diff only: for every new index, the previous index it was
   * retained from (`-1` for inserted rows). `undefined` means identity.
   */
  from?: number[]
  /**
   * Length-changing diff only: for every previous index, the new index it was
   * retained as (`-1` for removed rows).
   */
  to?: number[]
  /** All appended ranges (new coordinates). */
  addedRanges?: PulseRange[]
  /** All removed ranges (previous coordinates). */
  removedRanges?: PulseRange[]
  /**
   * True when the update only appends after `baseLength`: every retained row
   * keeps its index, so consumers can splice instead of synthesising `from`.
   */
  appendOnly?: boolean
  /** Previous row count for an append-only pulse. */
  baseLength?: number
}

const GROUPED = new Set<string>(['aggregate', 'joinaggregate', 'window', 'stack'])

/**
 * Whether two cells hold the same value as the scene sees it: `Object.is` for a primitive (so `0` and `-0` differ, as a format or a
 * scale's domain tells them apart, and `NaN` is `NaN`), the same instant for two Dates, and for plain arrays and objects the same
 * entries, compared the same way, a bounded number of levels deep. Any other object is the same only when it is the same object.
 */
export function equalCell(a: unknown, b: unknown): boolean {
  if (a === b) return a !== 0 || Object.is(a, b)
  if (a == null || b == null || typeof a !== 'object' || typeof b !== 'object') {
    return a !== a && b !== b // NaN
  }
  return sameNested(a, b, 0)
}

/** How deep `equalCell` looks into nested arrays and objects before it calls them different. */
const NESTED_DEPTH = 32

function sameNested(a: object, b: object, depth: number): boolean {
  if (a === b) return true
  if (depth > NESTED_DEPTH) return false
  if (a instanceof Date || b instanceof Date) return a instanceof Date && b instanceof Date && Object.is(a.getTime(), b.getTime())
  const proto = Object.getPrototypeOf(a)
  if (proto !== Object.getPrototypeOf(b)) return false
  if (proto === Array.prototype) {
    const x = a as unknown[]
    const y = b as unknown[]
    if (x.length !== y.length) return false
    for (let i = 0; i < x.length; i++) if (!sameValueAt(x[i], y[i], depth + 1)) return false
    return true
  }
  if (proto !== Object.prototype && proto !== null) return false
  const x = a as Record<string, unknown>
  const y = b as Record<string, unknown>
  const keys = Object.keys(x)
  if (keys.length !== Object.keys(y).length) return false
  for (const k of keys) if (!Object.hasOwn(y, k) || !sameValueAt(x[k], y[k], depth + 1)) return false
  return true
}

function sameValueAt(a: unknown, b: unknown, depth: number): boolean {
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return Object.is(a, b)
  return sameNested(a, b, depth)
}

/**
 * Row equality: the same own fields, each `equalCell` (a field one row lacks is not the other's `undefined` field). A row that is
 * not an object is a value, compared as a cell is.
 */
export function rowsEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  if (a === b) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return equalCell(a, b)
  return fieldsEqual(a, b)
}

/**
 * How `diffRows` reads a pair of rows, in the one look it takes at each: `-1` when either is not an object (a primitive row, which
 * the engine wraps as `{data: value}`, has no fields to compare, so a dataset holding one is not diffed: it is replaced as a
 * whole; the same primitive at the same index is the same row, and is not looked at), else `1` for the same fields and `0` for
 * different ones. Checking each row where it is compared, and not in a scan of
 * both arrays first, is what keeps a whole-array replacement of a long dataset as cheap as it was (two more passes over the rows
 * cost a third of it).
 */
function compareRows(a: unknown, b: unknown): -1 | 0 | 1 {
  // the same value (the same object, or an identical primitive other than the zero `===` cannot tell from `-0`): nothing to look at,
  // and not reading it at all is most of what a replacement that kept its rows (a `slice()` with one row changed) costs
  if (a === b && a !== 0) return 1
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return -1
  return a === b || fieldsEqual(a as Record<string, unknown>, b as Record<string, unknown>) ? 1 : 0
}

const isRow = (r: unknown): boolean => r !== null && typeof r === 'object'

/**
 * Arrays whose leading rows are known to be objects, by how many: what the engine ingested as they were (runtime.ts `ingestHostRows`)
 * and what a diff against such an array found to be objects (`diffRows`). Rows are the host's and immutable (docs/API.md), so this
 * holds for as long as the array lives, and the rows need not be looked at again: a session's next diff compares the rows of such an
 * array by identity first, and the evaluation does not scan an array a diff vouched for.
 */
const OBJECT_ROWS = new WeakMap<readonly unknown[], number>()

/** How many leading rows of `rows` are known to be objects (see `OBJECT_ROWS`). */
export const objectRowsOf = (rows: readonly unknown[]): number => OBJECT_ROWS.get(rows) ?? 0

/** Say that the first `n` rows of `rows` are objects. */
export const noteObjectRows = (rows: readonly unknown[], n: number): void => { OBJECT_ROWS.set(rows, n) }

/** The fields of two objects: the same own ones, each `equalCell`. */
function fieldsEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const proto = Object.getPrototypeOf(a)
  if (proto === Object.prototype || proto === null) {
    // `for...in` avoids the two Object.keys() allocations per row that made
    // auto-pulse inference dominate wholesale array replacement: 100k flat rows
    // compare in ~3.9ms instead of ~5.7ms. Plain rows (the norm) take this path;
    // objects with a custom prototype fall back to own-key comparison.
    let n = 0
    for (const k in a) {
      n++
      const v = b[k]
      if (!equalCell(a[k], v) || (v === undefined && !Object.hasOwn(b, k))) return false
    }
    let m = 0
    for (const _k in b) m++
    return n === m
  }
  const ak = Object.keys(a)
  if (ak.length !== Object.keys(b).length) return false
  for (const k of ak) if (!equalCell(a[k], b[k]) || (b[k] === undefined && !Object.hasOwn(b, k))) return false
  return true
}

function pushRange(ranges: PulseRange[], start: number, end: number): void {
  if (end <= start) return
  const last = ranges[ranges.length - 1]
  if (last && last[1] === start) last[1] = end
  else ranges.push([start, end])
}

/**
 * Diff two source row arrays. Same-length arrays yield the changed indices.
 * Length-changing arrays use prefix/suffix matching (so an append or a single
 * insertion/deletion is cheap) and additionally return an index mapping:
 *
 * - `from[newIndex]` is the old index of a retained row (`-1` for an insert),
 * - `to[oldIndex]` is the new index of a retained row (`-1` for a delete).
 *
 * The middle block between the common prefix and suffix is treated as a
 * replace/insert/delete: paired rows are modifications, and any surplus on
 * either side becomes an added/removed range.
 */
export function diffRows(previous: unknown, next: unknown): RowDiff | null {
  if (!Array.isArray(previous) || !Array.isArray(next)) return null
  const p: readonly unknown[] = previous
  const n: readonly unknown[] = next
  // (every row of both arrays is looked at by one of the loops below, and each looks at a row as an object: a dataset with a row
  // that is not one is not diffed, whichever row it is: see `compareRows`. When every row of `previous` is known to be an object
  // (`OBJECT_ROWS`), a row of `next` that is the very same object needs no look at all -- not even the `0`/`-0` test of
  // `compareRows`, which costs as much as the identity loop itself -- and every row of `next` is then known to be one too.)
  const objects = OBJECT_ROWS.get(p) === p.length
  if (p.length === n.length) {
    const changed: number[] = []
    if (objects) {
      for (let i = 0; i < n.length; i++) {
        if (p[i] === n[i]) continue
        const same = compareRows(p[i], n[i])
        if (same < 0) return null
        if (same === 0) changed.push(i)
      }
      OBJECT_ROWS.set(n, n.length)
    } else {
      for (let i = 0; i < n.length; i++) {
        const a = p[i]
        const b = n[i]
        if (a === b && a !== 0) continue // (see compareRows: the common row of a replacement is the very object it was)
        const same = compareRows(a, b)
        if (same < 0) return null
        if (same === 0) changed.push(i)
      }
    }
    return { changed, sameLength: true, added: null, removed: null }
  }

  const min = Math.min(p.length, n.length)
  let prefix = 0
  if (objects) while (prefix < min && p[prefix] === n[prefix]) prefix++
  while (prefix < min) {
    const same = compareRows(p[prefix], n[prefix])
    if (same < 0) return null
    if (same === 0) break
    prefix++
  }
  let suffix = 0
  if (objects) while (suffix < min - prefix && p[p.length - 1 - suffix] === n[n.length - 1 - suffix]) suffix++
  while (suffix < min - prefix) {
    const same = compareRows(p[p.length - 1 - suffix], n[n.length - 1 - suffix])
    if (same < 0) return null
    if (same === 0) break
    suffix++
  }

  const from = new Array<number>(n.length).fill(-1)
  const to = new Array<number>(p.length).fill(-1)
  const addedRanges: PulseRange[] = []
  const removedRanges: PulseRange[] = []
  const changed: number[] = []

  // Common prefix.
  for (let i = 0; i < prefix; i++) { from[i] = i; to[i] = i }
  // Common suffix.
  for (let j = 0; j < suffix; j++) {
    const ni = n.length - 1 - j
    const pi = p.length - 1 - j
    from[ni] = pi
    to[pi] = ni
  }

  // Mutable middle. Pair the overlap as replacements, then mark the surplus.
  const oldMiddle = p.length - suffix - prefix
  const newMiddle = n.length - suffix - prefix
  const paired = Math.min(oldMiddle, newMiddle)
  for (let k = 0; k < paired; k++) {
    const ni = prefix + k
    const pi = prefix + k
    from[ni] = pi
    to[pi] = ni
    const same = compareRows(p[pi], n[ni])
    if (same < 0) return null
    if (same === 0) changed.push(ni)
  }
  for (let k = paired; k < newMiddle; k++) {
    const ni = prefix + k
    if (!isRow(n[ni])) return null
    from[ni] = -1
    pushRange(addedRanges, ni, ni + 1)
  }
  for (let k = paired; k < oldMiddle; k++) {
    const pi = prefix + k
    if (!isRow(p[pi])) return null
    to[pi] = -1
    pushRange(removedRanges, pi, pi + 1)
  }

  // Derive the singular added/removed convenience ranges (first run).
  const added = addedRanges.length ? addedRanges[0]! : null
  const removed = removedRanges.length ? removedRanges[0]! : null
  // A pure append (or append + in-place modifications) keeps every retained
  // index; publish the compact form as well so streaming callers can avoid
  // carrying/allocating the full mapping.
  let appendOnly = removedRanges.length === 0
  let baseLength = p.length
  if (appendOnly) {
    for (let i = 0; i < from.length; i++) {
      const old = from[i]!
      if (old < 0) {
        baseLength = i
        // Only a suffix of inserted rows is append-only; anything retained
        // after an insertion means indices shifted.
        for (let j = i; j < from.length; j++) if (from[j]! !== -1) { appendOnly = false; break }
        break
      }
      if (old !== i) { appendOnly = false; break }
    }
    if (appendOnly && from.length === p.length && p.length !== n.length) appendOnly = false
  }
  if (objects) OBJECT_ROWS.set(n, n.length)
  return { changed, sameLength: false, added, removed, from, to, addedRanges, removedRanges, ...(appendOnly ? { appendOnly, baseLength } : {}) }
}

/**
 * A dataset's pulse as a host states it (`RuntimeInput.dataPulse`, `StreamBatch.pulse`): the index mapping and the ranges, `added` and
 * `removed` being ALL the ranges. Hosts that diffed the rows themselves (`diffRows`) pass its {@link RowDiff} instead; it is read by
 * {@link pulseChangeOf}.
 */
export interface PulseChangeInput {
  /** Indices (new coordinates) whose rows changed in place. */
  changed?: number[]
  /** new index -> previous index (-1 for inserted rows). */
  from?: number[]
  /** previous index -> new index (-1 for removed rows). */
  to?: number[]
  /** Appended ranges in new coordinates. */
  added?: PulseRange[]
  /** Removed ranges in previous coordinates. */
  removed?: PulseRange[]
  /**
   * Compact append-only pulse: the retained prefix is unchanged in index, so `from` can be synthesised on demand. `baseLength` is the
   * previous length.
   */
  appendOnly?: boolean
  baseLength?: number
}

/**
 * The pulse a host handed in, as the one shape the engine reads. A `RowDiff` (what `diffRows` returns) names its first range in
 * `added` / `removed` and all of them in `addedRanges` / `removedRanges`; the long form names all of them in `added` / `removed`.
 */
export function pulseChangeOf(p: PulseChangeInput | RowDiff): PulseChangeInput {
  if (!('sameLength' in p)) return p
  const added = p.addedRanges ?? (p.added ? [p.added] : undefined)
  const removed = p.removedRanges ?? (p.removed ? [p.removed] : undefined)
  return {
    changed: p.changed,
    ...(p.from ? { from: p.from } : {}),
    ...(p.to ? { to: p.to } : {}),
    ...(added ? { added } : {}),
    ...(removed ? { removed } : {}),
    ...(p.appendOnly ? { appendOnly: true, baseLength: p.baseLength } : {}),
  }
}

export interface DatasetPulse extends RowDiff {
  name: string
}

/** A length/order-change summary for a dataset (before names are attached). */
export interface PulseChange {
  changed: number[]
  from?: number[]
  to?: number[]
  added?: PulseRange[]
  removed?: PulseRange[]
  appendOnly?: boolean
  baseLength?: number
}

export interface DataPulse {
  datasets: Map<string, DatasetPulse>
  /** Source datasets whose length/order changed (a full mark re-encode if no mapping can be used). */
  structural: Set<string>
}

/** The names a dataset derives from: its `source`, one name or a list (vega-parser: `array(data.source)`). */
export function sourceNames(d: CompiledData): string[] {
  const s = d.source
  return s === undefined || s === '' ? [] : Array.isArray(s) ? s : [s]
}

/** Grouped transforms (aggregate/window/stack) consume dirty groups in place. */
export function isGroupedTransform(type: string): boolean {
  return GROUPED.has(type)
}
