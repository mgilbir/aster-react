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
 * The graph is structural and cached on the compiled chart; pulses are plain
 * data so hosts can inspect them in tests/devtools.
 */
import type { CompiledChart, CompiledData, CompiledMark, CompiledTransform } from './types.js'

export interface RowDiff {
  /** Indices (into the new rows) whose values changed; only for same-length updates. */
  changed: number[]
  /** True when the new array has the same length and row order. */
  sameLength: boolean
  /** Appended range [start, end) into the new rows, if any. */
  added: [number, number] | null
  /** Removed range [start, end) from the previous rows, if any. */
  removed: [number, number] | null
}

const ROWWISE = new Set<string>(['formula', 'identifier', 'timeunit'])
const GROUPED = new Set<string>(['aggregate', 'joinaggregate', 'window', 'stack'])
const EXPANDING = new Set<string>([
  'fold', 'flatten', 'pivot', 'geojson', 'geopoint', 'geoshape', 'contour', 'linkpath',
  'kde', 'quantile', 'regression', 'loess', 'pack', 'partition', 'treemap', 'wordcloud',
  'voronoi', 'cross', 'countpattern', 'dotbin', 'project', 'label', 'stratify', 'sequence',
  'graticule',
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
  const ak = Object.keys(a)
  if (ak.length !== Object.keys(b).length) return false
  for (const k of ak) if (!equalCell(a[k], b[k])) return false
  return true
}

/**
 * Diff two source row arrays. Same-length arrays yield the changed indices;
 * prefix/suffix matching keeps an append or a single insertion cheap.
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
  // Find the unchanged prefix and suffix; everything in the middle is the
  // inserted/removed/changed block.
  let prefix = 0
  const min = Math.min(p.length, n.length)
  while (prefix < min && rowsEqual(p[prefix]!, n[prefix]!)) prefix++
  let suffix = 0
  while (suffix < min - prefix && rowsEqual(p[p.length - 1 - suffix]!, n[n.length - 1 - suffix]!)) suffix++
  const changed: number[] = []
  const overlapEnd = n.length - suffix
  for (let i = prefix; i < overlapEnd; i++) {
    const old = p[i]
    if (old == null || !rowsEqual(old, n[i]!)) changed.push(i)
  }
  const added: [number, number] | null = n.length > p.length ? [prefix, n.length - suffix] : null
  const removed: [number, number] | null = p.length > n.length ? [prefix, p.length - suffix] : null
  return { changed, sameLength: false, added, removed }
}

export interface DatasetPulse extends RowDiff {
  name: string
}

export interface DataPulse {
  datasets: Map<string, DatasetPulse>
  /** Source datasets whose length/order changed (a full mark re-encode). */
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
  return types.some((t) => EXPANDING.has(t) || (t === 'bin' && false))
}

/** Grouped transforms (aggregate/window/stack) consume dirty groups in place. */
export function isGroupedTransform(type: string): boolean {
  return GROUPED.has(type)
}
