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
 * The rows of a dataset value, when every one is an object: rows are compared field by field, and a value that is not an object
 * (a primitive row, which the engine wraps as `{data: value}`) has no fields to compare, so a dataset holding one is not diffed
 * (it is replaced as a whole).
 */
function asRows(v: unknown): Record<string, unknown>[] | null {
  if (!Array.isArray(v)) return null
  for (let i = 0; i < v.length; i++) {
    const row: unknown = v[i]
    if (row === null || typeof row !== 'object') return null
  }
  return v as Record<string, unknown>[]
}

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
  const p = asRows(previous)
  const n = asRows(next)
  if (!p || !n) return null
  if (p.length === n.length) {
    const changed: number[] = []
    for (let i = 0; i < n.length; i++) if (!rowsEqual(p[i]!, n[i]!)) changed.push(i)
    return { changed, sameLength: true, added: null, removed: null }
  }

  const min = Math.min(p.length, n.length)
  let prefix = 0
  while (prefix < min && rowsEqual(p[prefix]!, n[prefix]!)) prefix++
  let suffix = 0
  while (suffix < min - prefix && rowsEqual(p[p.length - 1 - suffix]!, n[n.length - 1 - suffix]!)) suffix++

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
    if (!rowsEqual(p[pi]!, n[ni]!)) changed.push(ni)
  }
  for (let k = paired; k < newMiddle; k++) {
    const ni = prefix + k
    from[ni] = -1
    pushRange(addedRanges, ni, ni + 1)
  }
  for (let k = paired; k < oldMiddle; k++) {
    const pi = prefix + k
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
