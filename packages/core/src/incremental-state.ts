/**
 * What a dataset's transform step leaves for the next pulse when it runs from scratch: the step's rows and its state (filter flags,
 * group membership, flatten offsets, collect order). An evaluation that keeps its state for a later one runs every step this way;
 * re-deriving a step from a pulse is the pulse path (incremental-engine.ts), which the React shells load only once a chart's data
 * changes (engine-parts.ts). The two share the state's shapes, defined here.
 */
import { carryOrder } from './tuple-order.js'
import { exprRowPass, sortOrder, type Row } from './transform.js'
import { fieldsOf, groupKeyFn } from './transform-agg.js'
import { flattenLength } from './transform-basic.js'
import type { CompiledTransform, SortSpec } from './types.js'
import { applyFresh, type StepTransformContext } from './runtime.js'

/** Persistent per-group index for incremental group transforms. */
export interface AggState {
  groupby: string[]
  /** Input row index -> group key (same length as the input rows). */
  rowKey: string[]
  /** Group key -> input row indices belonging to it. */
  keyToIdx: Map<string, number[]>
  /** Output row order (group keys, first-occurrence order). */
  outOrder: string[]
  /** Group key -> output row index (parallel to outOrder; O(1) dirty-index lookup). */
  outIdx: Map<string, number>
  /** Group key -> aggregate output row (aggregate only). */
  outByKey: Map<string, Row>
  /** Group key -> start index in the grouped output array (window/stack). */
  groupStart: Map<string, number>
  /** Group key -> number of output rows it contributes. */
  groupSize: Map<string, number>
  out: Row[]
}

/** The partition key vega's aggregate/joinaggregate use (`String(a)|b|...`): the incremental grouping must equal the fresh one. */
export function groupKeyOf(row: Row, groupby: string[]): string {
  return groupKeyFn(groupby)(row)
}

/**
 * Whether an aggregate / joinaggregate can be re-derived group by group.
 * A cross-product, a custom `key` accessor or a bootstrap interval (ci0/ci1
 * draws from one pseudo-random stream shared by all groups, so a group's value
 * depends on the groups before it) must be recomputed from scratch.
 */
export function groupwiseIncremental(t: CompiledTransform): boolean {
  const p = t as { cross?: unknown; key?: unknown; ops?: unknown }
  if (p.cross || p.key != null) return false
  const ops = Array.isArray(p.ops) ? p.ops : []
  return !ops.includes('ci0') && !ops.includes('ci1')
}

export function buildAggState(input: Row[], groupby: string[], out: Row[]): AggState {
  const rowKey = new Array<string>(input.length)
  const keyToIdx = new Map<string, number[]>()
  for (let i = 0; i < input.length; i++) {
    const k = groupKeyOf(input[i]!, groupby)
    rowKey[i] = k
    let arr = keyToIdx.get(k)
    if (!arr) keyToIdx.set(k, (arr = []))
    arr.push(i)
  }
  const outOrder = [...keyToIdx.keys()]
  const outIdx = new Map<string, number>()
  outOrder.forEach((k, idx) => outIdx.set(k, idx))
  const outByKey = new Map<string, Row>()
  outOrder.forEach((k, idx) => outByKey.set(k, out[idx]!))
  // Grouped outputs (window/stack) place a group's rows contiguously; track
  // each group's start index and size so dirty groups can be spliced in place.
  const groupStart = new Map<string, number>()
  const groupSize = new Map<string, number>()
  let pos = 0
  for (const k of outOrder) {
    const size = keyToIdx.get(k)!.length
    groupStart.set(k, pos)
    groupSize.set(k, size)
    pos += size
  }
  return { groupby, rowKey, keyToIdx, outOrder, outIdx, outByKey, groupStart, groupSize, out }
}

export interface FlattenState { sizes: number[]; offsets: number[] }

export function flattenSize(row: Row, fields: string[]): number {
  // vega's output length for one tuple; `fields` may be access paths (`a.b`, `a[0]`)
  const maxlen = flattenLength(fieldsOf(fields).map((f) => f(row)))
  return maxlen > 0 ? maxlen : 0
}

/** Transform types that keep per-step incremental state (see `deriveStepState`). */
export function keepsStepState(type: string): boolean {
  return type === 'filter' || type === 'flatten' || type === 'aggregate' || type === 'joinaggregate' || type === 'collect'
}

/**
 * The incremental state of one step, derived from scratch from the step's input
 * and output (what a fully re-derived step leaves behind for the next pulse).
 */
export function deriveStepState(t: CompiledTransform, input: Row[], output: Row[], tctx: StepTransformContext): unknown {
  switch (t.type) {
    case 'filter': {
      const fn = exprRowPass((t as { expr?: string }).expr ?? '', tctx)
      return input.map((r) => Boolean(fn(r)))
    }
    case 'flatten': {
      const fields = (t as { fields?: string[] }).fields ?? []
      const sizes = input.map((r) => flattenSize(r, fields))
      const offsets: number[] = []
      let p = 0
      for (const sz of sizes) { offsets.push(p); p += sz }
      return { sizes, offsets }
    }
    case 'aggregate': case 'joinaggregate':
      return buildAggState(input, (t as { groupby?: string[] }).groupby ?? [], output)
    case 'collect':
      return { order: sortOrder(input, (t as { sort?: SortSpec }).sort) }
    default:
      return undefined
  }
}

/** Run one transform from scratch, leaving the state the next pulse starts from. */
export function applyOneWithState(
  rows: Row[], t: CompiledTransform, tctx: StepTransformContext, sourceName: string, previous?: Row[],
): { rows: Row[]; state?: unknown } {
  if (t.type === 'filter') {
    // Predicate flags and output in one pass (same function, same errors as the
    // plain transform).
    const fn = exprRowPass((t as { expr?: string }).expr ?? '', tctx)
    const pass = new Array<boolean>(rows.length)
    const out: Row[] = []
    for (let i = 0; i < rows.length; i++) {
      const ok = Boolean(fn(rows[i]!))
      pass[i] = ok
      if (ok) out.push(rows[i]!)
    }
    carryOrder('filter', rows, out)
    return { rows: out, state: pass }
  }
  const out = applyFresh(rows, t, tctx, sourceName, previous)
  return keepsStepState(String(t.type)) ? { rows: out, state: deriveStepState(t, rows, out, tctx) } : { rows: out }
}

