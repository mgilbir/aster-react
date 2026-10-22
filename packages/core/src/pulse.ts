/**
 * Dataflow pulses (R13).
 *
 * Vega's runtime is a pulse graph: a source dataset emits a change tuple, each
 * transform propagates it to its targets, and only the dirty marks re-encode.
 * Aster evaluates eagerly, but the same graph is useful for two things:
 *
 * - inferring a source pulse automatically when a host hands over new immutable
 *   row arrays (no explicit `dataChanges` needed), and
 * - naming the downstream datasets/marks and whether a transform can consume a
 *   row-wise pulse or needs a full re-derive.
 *
 * A pulse carries more than the changed indices: length-changing updates
 * (append/insert/delete) also carry an index mapping (`from`/`to`) and the
 * added/removed ranges. Downstream transforms and marks use that mapping to
 * splice their cached rows/items instead of rebuilding the world.
 *
 * The graph is structural and cached on the compiled chart; pulses are plain
 * data so hosts can inspect them in tests/devtools.
 */
import type { CompiledChart, CompiledData, CompiledMark, CompiledTransform } from './types.js'

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

const ROWWISE = new Set<string>([
  'formula', 'identifier', 'timeunit',
  // 1:1 geo transforms: each output row depends only on its own input row.
  'geoshape', 'geopoint', 'linkpath', 'project', 'geojson',
])
const GROUPED = new Set<string>(['aggregate', 'joinaggregate', 'window', 'stack'])
/** Transforms whose output row count/order is independent of the input order. */
const EXPANDING = new Set<string>([
  'fold', 'flatten', 'pivot', 'geojson', 'geopoint', 'geoshape', 'contour', 'linkpath',
  'kde', 'quantile', 'regression', 'loess', 'pack', 'partition', 'treemap', 'wordcloud',
  'voronoi', 'cross', 'countpattern', 'dotbin', 'project', 'label', 'stratify', 'sequence',
  'graticule',
])

/**
 * Transforms that emit exactly one output row per input row, in input order,
 * even when the output values depend on the whole dataset (pie angles, dotbin
 * bins, hierarchical layout). Their output can be spliced by index.
 */
const INDEX_PRESERVING = new Set<string>([
  'formula', 'identifier', 'timeunit', 'geoshape', 'geopoint', 'linkpath', 'project',
  'geojson', 'label', 'pie', 'dotbin', 'pack', 'partition', 'treemap', 'voronoi',
])

/** Transforms that re-derive every output but never change the input mapping. */
const STABLE_ROW_COUNT = new Set<string>([
  ...INDEX_PRESERVING,
  'extent', 'stratify',
])

function asRows(v: unknown): Record<string, unknown>[] | null {
  return Array.isArray(v) && (v.length === 0 || (v[0] != null && typeof v[0] === 'object')) ? v as Record<string, unknown>[] : null
}

function equalCell(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a == null || b == null || typeof a !== 'object' || typeof b !== 'object') {
    return a !== a && b !== b // NaN
  }
  // Rows are usually flat. For nested values compare identity, then JSON as a
  // last resort so a replaced nested array/dataset is still noticed.
  try { return JSON.stringify(a) === JSON.stringify(b) } catch { return false }
}

/** Shallow row equality with a JSON fallback for nested values. */
export function rowsEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  if (a === b) return true
  const proto = Object.getPrototypeOf(a)
  if (proto === Object.prototype || proto === null) {
    // `for...in` avoids the two Object.keys() allocations per row that made
    // auto-pulse inference dominate wholesale array replacement: 100k flat rows
    // compare in ~3.9ms instead of ~5.7ms. Plain rows (the norm) take this path;
    // objects with a custom prototype fall back to own-key comparison.
    let n = 0
    for (const k in a) {
      n++
      if (!equalCell(a[k], b[k])) return false
    }
    let m = 0
    for (const k in b) m++
    return n === m
  }
  const ak = Object.keys(a)
  if (ak.length !== Object.keys(b).length) return false
  for (const k of ak) if (!equalCell(a[k], b[k])) return false
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

export interface PulseNode {
  name: string
  source?: string
  transforms: string[]
  downstream: string[]
  marks: string[]
  /** False when a transform changes row count/order and needs a full re-derive. */
  rowWise: boolean
  /** True when every transform preserves the input row index (mapping-spliceable). */
  indexPreserving: boolean
}

export interface PulseGraph {
  nodes: Map<string, PulseNode>
  /** Source dataset -> mark names drawing from it (directly or via groups). */
  markSources: Map<string, string[]>
}

function transformsOf(d: CompiledData): CompiledTransform[] {
  return d.transform ?? []
}

function isRowWise(d: CompiledData): boolean {
  return transformsOf(d).every((t) => ROWWISE.has(String(t.type)))
}

function isIndexPreserving(d: CompiledData): boolean {
  return transformsOf(d).every((t) => STABLE_ROW_COUNT.has(String(t.type)) || t.type === 'filter'
    || t.type === 'fold' || t.type === 'flatten' || t.type === 'aggregate'
    || t.type === 'joinaggregate' || t.type === 'window' || t.type === 'stack')
}

/** Build the structural dataflow graph for a compiled chart. */
export function buildPulseGraph(chart: CompiledChart): PulseGraph {
  const nodes = new Map<string, PulseNode>()
  for (const d of chart.data) {
    nodes.set(d.name, {
      name: d.name,
      source: (d as CompiledData & { source?: string }).source,
      transforms: transformsOf(d).map((t) => String(t.type)),
      downstream: [],
      marks: [],
      rowWise: isRowWise(d),
      indexPreserving: isIndexPreserving(d),
    })
  }
  for (const node of nodes.values()) {
    if (node.source && nodes.has(node.source)) nodes.get(node.source)!.downstream.push(node.name)
  }
  const markSources = new Map<string, string[]>()
  const walkMarks = (marks: CompiledMark[] | undefined): void => {
    for (const m of marks ?? []) {
      const src = (m.from as { data?: string } | undefined)?.data
      if (src) {
        const list = markSources.get(src) ?? []
        if (!list.includes(m.name ?? m.type)) list.push(m.name ?? m.type)
        markSources.set(src, list)
        const node = nodes.get(src)
        if (node && m.name && !node.marks.includes(m.name)) node.marks.push(m.name)
      }
      const nested = (m as { marks?: CompiledMark[] }).marks
      if (nested) walkMarks(nested)
    }
  }
  walkMarks(chart.marks)
  return { nodes, markSources }
}

export interface PulsePropagation {
  datasets: Set<string>
  marks: Set<string>
  /** Datasets whose transform chain cannot consume row-wise changes. */
  fullRederive: Set<string>
}

/** Propagate a source pulse through the graph (including derived sources). */
export function propagatePulse(graph: PulseGraph, changed: Iterable<string>): PulsePropagation {
  const datasets = new Set<string>()
  const marks = new Set<string>()
  const fullRederive = new Set<string>()
  const queue = [...changed]
  while (queue.length) {
    const name = queue.shift()!
    if (datasets.has(name)) continue
    datasets.add(name)
    const node = graph.nodes.get(name)
    if (!node) continue
    for (const m of node.marks) marks.add(m)
    if (!node.rowWise) fullRederive.add(name)
    for (const next of node.downstream) {
      if (!datasets.has(next)) queue.push(next)
    }
  }
  return { datasets, marks, fullRederive }
}

/** True when a transform chain contains a row-expanding/reordering operator. */
export function transformNeedsFullRederive(types: string[]): boolean {
  return types.some((t) => EXPANDING.has(t) && !STABLE_ROW_COUNT.has(t))
}

/** True when every transform preserves the input row index (mapping-spliceable). */
export function transformKeepsRowIndex(types: string[]): boolean {
  return types.every((t) => STABLE_ROW_COUNT.has(t) || t === 'filter'
    || t === 'fold' || t === 'flatten' || t === 'aggregate'
    || t === 'joinaggregate' || t === 'window' || t === 'stack')
}

/** Grouped transforms (aggregate/window/stack) consume dirty groups in place. */
export function isGroupedTransform(type: string): boolean {
  return GROUPED.has(type)
}

/** Convert a RowDiff into the compact change shape the runtime consumes. */
export function changeOf(diff: RowDiff): PulseChange {
  return {
    changed: diff.changed,
    ...(diff.from ? { from: diff.from } : {}),
    ...(diff.to ? { to: diff.to } : {}),
    ...(diff.addedRanges ? { added: diff.addedRanges } : {}),
    ...(diff.removedRanges ? { removed: diff.removedRanges } : {}),
    ...(diff.appendOnly ? { appendOnly: true, baseLength: diff.baseLength } : {}),
  }
}

// Internal classification shared with the runtime.
export const pulseInternals = {
  ROWWISE,
  GROUPED,
  EXPANDING,
  INDEX_PRESERVING,
  STABLE_ROW_COUNT,
}
