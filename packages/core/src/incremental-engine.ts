/**
 * The incremental step engine: a dataset's transform chain driven by a pulse (what the host or the stream says changed in its
 * input), step by step, splicing the rows the steps made before, together with the state a step leaves for the next pulse.
 * A chart that is evaluated once never needs it, so it is not part of `runtime.ts`, which only declares the shape it has
 * (`IncrementalEngine`): the entries that re-evaluate a chart (`evaluate.ts`, `session.ts`) import this module and hand the engine to
 * `evaluateChartPending`.
 */
import { equalCell, rowsEqual } from './pulse.js'
import { carryOrder, isPlacing } from './tuple-order.js'
import { carryByAlignment, carryByMapping } from './identifier-ids.js'
import { applyTransforms, compileExprTransform, sortOrder, aggregateGroup, type Row } from './transform.js'
import { fieldsOf, groupKeyFn } from './transform-agg.js'
import { flattenLength } from './transform-basic.js'
import { checkRowCount } from './limits.js'
import { datasetsReadIn, lexedText } from './step-reuse.js'
import type { CompiledTransform, SortSpec } from './types.js'
import {
  applyFresh, applyIdentifier, applyOne, DATA_DEPENDENT_EXPR, idField, pulseBaseLength, withCarry,
  type DatasetState, type IncrementalEngine, type ProjectionRegistry, type StepPulse, type StepTransformContext,
} from './runtime.js'

/** Persistent per-group index for incremental group transforms. */
interface AggState {
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
function groupKeyOf(row: Row, groupby: string[]): string {
  return groupKeyFn(groupby)(row)
}

/**
 * Whether an aggregate / joinaggregate can be re-derived group by group.
 * A cross-product, a custom `key` accessor or a bootstrap interval (ci0/ci1
 * draws from one pseudo-random stream shared by all groups, so a group's value
 * depends on the groups before it) must be recomputed from scratch.
 */
function groupwiseIncremental(t: CompiledTransform): boolean {
  const p = t as { cross?: unknown; key?: unknown; ops?: unknown }
  if (p.cross || p.key != null) return false
  const ops = Array.isArray(p.ops) ? p.ops : []
  return !ops.includes('ci0') && !ops.includes('ci1')
}

function buildAggState(input: Row[], groupby: string[], out: Row[]): AggState {
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

interface FlattenState { sizes: number[]; offsets: number[] }

function flattenSize(row: Row, fields: string[]): number {
  // vega's output length for one tuple; `fields` may be access paths (`a.b`, `a[0]`)
  const maxlen = flattenLength(fieldsOf(fields).map((f) => f(row)))
  return maxlen > 0 ? maxlen : 0
}

/** Transform types that keep per-step incremental state (see `deriveStepState`). */
function keepsStepState(type: string): boolean {
  return type === 'filter' || type === 'flatten' || type === 'aggregate' || type === 'joinaggregate' || type === 'collect'
}

/**
 * The incremental state of one step, derived from scratch from the step's input
 * and output (what a fully re-derived step leaves behind for the next pulse).
 */
function deriveStepState(t: CompiledTransform, input: Row[], output: Row[], tctx: StepTransformContext): unknown {
  switch (t.type) {
    case 'filter': {
      const fn = compileExprTransform((t as { expr?: string }).expr ?? '', tctx)
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
function applyOneWithState(
  rows: Row[], t: CompiledTransform, tctx: StepTransformContext, sourceName: string, previous?: Row[],
): { rows: Row[]; state?: unknown } {
  if (t.type === 'filter') {
    // Predicate flags and output in one pass (same function, same errors as the
    // plain transform).
    const fn = compileExprTransform((t as { expr?: string }).expr ?? '', tctx)
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

/** New-value indices that were inserted (mapping `-1`). */
function addedRangesOf(from: number[]): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (let i = 0; i < from.length; i++) {
    if (from[i]! >= 0) continue
    const start = i
    while (i + 1 < from.length && from[i + 1]! < 0) i++
    out.push([start, i + 1])
  }
  return out
}

function removedRangesOf(to: number[] | undefined): Array<[number, number]> {
  if (!to) return []
  const out: Array<[number, number]> = []
  for (let i = 0; i < to.length; i++) {
    if (to[i]! >= 0) continue
    const start = i
    while (i + 1 < to.length && to[i + 1]! < 0) i++
    out.push([start, i + 1])
  }
  return out
}

/** Derive a pulse from a new->old mapping and the changed output indices. */
function pulseOfMapping(from: number[], to: number[] | undefined, changed: number[]): StepPulse {
  return { changed, from, ...(to ? { to } : {}), added: addedRangesOf(from), removed: removedRangesOf(to) }
}

/** Identity mapping of length `n`. */
function identityMapping(n: number): number[] {
  const from = new Array<number>(n)
  for (let i = 0; i < n; i++) from[i] = i
  return from
}

/** Old-index -> new-index inverse (with -1 for removed rows). */
function inverseMapping(from: number[], oldLen: number): number[] {
  const to = new Array<number>(oldLen).fill(-1)
  for (let i = 0; i < from.length; i++) if (from[i]! >= 0) to[from[i]!] = i
  return to
}

function isModified(pulse: StepPulse): Set<number> {
  return new Set(pulse.changed)
}

/** Expand a compact append pulse to the full new->old mapping (on demand). */
function mappingFromPulse(pulse: StepPulse, newLen: number): number[] {
  if (pulse.from) return pulse.from
  const base = Math.min(pulseBaseLength(pulse), newLen)
  const from = new Array<number>(newLen)
  for (let i = 0; i < base; i++) from[i] = i
  for (let i = base; i < newLen; i++) from[i] = -1
  return from
}

/** Stable append pulse from a base length and new length. */
function appendPulse(baseLength: number, newLen: number, changed: number[]): StepPulse {
  return {
    changed,
    appendOnly: true,
    baseLength,
    ...(newLen > baseLength ? { added: [[baseLength, newLen]] } : {}),
  }
}

/**
 * Row-local transforms (`formula`, `timeunit`, fixed-extent `bin`, an
 * unaffected `lookup`, and the 1:1 geo transforms) derive only the added /
 * modified rows and splice the cached output for the retained ones.
 */
function rowLocalPulse(
  rows: Row[], t: CompiledTransform, tctx: StepTransformContext, sourceName: string,
  input: StepPulse, prev: Row[] | undefined,
): { rows: Row[]; pulse: StepPulse } | null {
  const from = input.from!
  const modified = isModified(input)
  const out = new Array<Row>(rows.length)
  const changed: number[] = []
  for (let i = 0; i < rows.length; i++) {
    const old = from[i]!
    if (old >= 0 && !modified.has(i) && prev && prev[old] !== undefined) {
      out[i] = prev[old]!
      continue
    }
    const derived = applyOne([rows[i]!], t, tctx, sourceName)
    if (derived.length !== 1) return null
    out[i] = derived[0]!
    changed.push(i)
  }
  return { rows: out, pulse: pulseOfMapping(from, input.to, changed) }
}

/**
 * Append-only fast paths. These mutate the cached step output (persistent-scene
 * semantics): unchanged rows keep their already-transformed row objects, and
 * new rows are appended, so the cost is O(appended + changed).
 */
function rowLocalAppendPulse(
  rows: Row[], t: CompiledTransform, tctx: StepTransformContext, sourceName: string,
  input: StepPulse, prev: Row[] | undefined,
): { rows: Row[]; pulse: StepPulse } | null {
  const base = pulseBaseLength(input)
  if (!prev || prev.length !== base) return null
  const changed: number[] = []
  for (const i of input.changed) {
    if (i < 0 || i >= base) continue
    const derived = applyOne([rows[i]!], t, tctx, sourceName)
    if (derived.length !== 1) return null
    prev[i] = derived[0]!
    changed.push(i)
  }
  for (let i = base; i < rows.length; i++) {
    const derived = applyOne([rows[i]!], t, tctx, sourceName)
    if (derived.length !== 1) return null
    prev.push(derived[0]!)
  }
  return { rows: prev, pulse: appendPulse(base, rows.length, changed) }
}

function filterAppendPulse(
  rows: Row[], t: CompiledTransform, tctx: StepTransformContext, sourceName: string,
  input: StepPulse, prev: Row[] | undefined, prevPass: boolean[] | undefined,
): { rows: Row[]; pulse: StepPulse; state?: unknown } | null {
  const base = pulseBaseLength(input)
  if (input.changed.length || !prev || !prevPass || prevPass.length !== base) return null
  const expr = (t as { expr?: string }).expr ?? ''
  const exprFn = compileExprTransform(expr, tctx)
  const fn = (row: Row): boolean => Boolean(exprFn(row))
  const outBase = prev.length
  for (let i = base; i < rows.length; i++) {
    const passed = fn(rows[i]!)
    prevPass.push(passed)
    if (passed) prev.push(rows[i]!)
  }
  return { rows: prev, pulse: appendPulse(outBase, prev.length, []), state: prevPass }
}

function foldAppendPulse(
  rows: Row[], t: CompiledTransform, tctx: StepTransformContext, sourceName: string,
  input: StepPulse, prev: Row[] | undefined,
): { rows: Row[]; pulse: StepPulse } | null {
  const n = ((t as { fields?: unknown[] }).fields ?? []).length
  if (!n || !prev) return null
  const base = pulseBaseLength(input)
  if (prev.length !== base * n) return null
  const changed: number[] = []
  for (const i of input.changed) {
    if (i < 0 || i >= base) continue
    const derived = applyOne([rows[i]!], t, tctx, sourceName)
    if (derived.length !== n) return null
    for (let j = 0; j < n; j++) {
      prev[i * n + j] = derived[j]!
      changed.push(i * n + j)
    }
  }
  const outBase = base * n
  for (let i = base; i < rows.length; i++) {
    const derived = applyOne([rows[i]!], t, tctx, sourceName)
    if (derived.length !== n) return null
    for (let j = 0; j < n; j++) prev.push(derived[j]!)
  }
  return { rows: prev, pulse: appendPulse(outBase, prev.length, changed) }
}

/** `rowsEqual`, leaving the fields in `ignore` out of both rows. */
function rowsEqualBut(a: Row, b: Row, ignore: ReadonlySet<string>): boolean {
  let n = 0
  for (const k in a) {
    if (ignore.has(k)) continue
    n++
    if (!equalCell(a[k], b[k])) return false
  }
  let m = 0
  for (const k in b) if (!ignore.has(k)) m++
  return n === m
}

/**
 * Re-derive a transform whose output stays 1:1 with its input (layout/pie/
 * dotbin/label), then reuse the previous output row object wherever the value
 * is unchanged. This is how a global layout participates in the pulse graph:
 * the mapping survives, so downstream items still splice.
 */
function rederiveAligned(
  rows: Row[], t: CompiledTransform, tctx: StepTransformContext, sourceName: string,
  input: StepPulse, prev: Row[] | undefined, ignore?: ReadonlySet<string>,
): { rows: Row[]; pulse: StepPulse } | null {
  const out = applyOne(rows, t, tctx, sourceName)
  const from = input.from!
  if (out.length !== from.length) return null
  const modified = isModified(input)
  const changed: number[] = []
  const reused = new Array<Row>(out.length)
  for (let i = 0; i < out.length; i++) {
    const old = from[i]!
    const canReuse = old >= 0 && !modified.has(i) && prev && prev[old] !== undefined
    if (canReuse && (ignore === undefined ? rowsEqual(out[i]!, prev![old]!) : rowsEqualBut(out[i]!, prev![old]!, ignore))) {
      reused[i] = prev![old]!
    } else {
      reused[i] = out[i]!
      changed.push(i)
    }
  }
  return { rows: reused, pulse: pulseOfMapping(from, input.to, changed) }
}

function filterPulse(
  rows: Row[], t: CompiledTransform, tctx: StepTransformContext, sourceName: string,
  input: StepPulse, prev: Row[] | undefined, prevPass: boolean[] | undefined,
): { rows: Row[]; pulse: StepPulse; state?: unknown } | null {
  const from = input.from!
  const oldLen = input.to?.length ?? -1
  if (!prevPass || prevPass.length !== oldLen) return null
  // Old output index for each old input index (the filter preserves input order).
  const oldOut = new Array<number>(oldLen).fill(-1)
  let acc = 0
  for (let i = 0; i < oldLen; i++) if (prevPass[i]) oldOut[i] = acc++
  const expr = (t as { expr?: string }).expr ?? ''
  const exprFn = compileExprTransform(expr, tctx)
  const fn = (row: Row): boolean => Boolean(exprFn(row))
  const modified = isModified(input)
  const pass = new Array<boolean>(rows.length)
  const out: Row[] = []
  const outFrom: number[] = []
  const changed: number[] = []
  for (let i = 0; i < rows.length; i++) {
    const old = from[i]!
    const retained = old >= 0 && !modified.has(i) && prevPass[old] !== undefined
    pass[i] = retained ? prevPass![old]! : fn(rows[i]!)
    if (!pass[i]) continue
    // (a modified row that passed before and passes now is the same row in a new state: it keeps its place in the mapping,
    // and is listed as changed, so a transform after the filter can tell it from a row that is new)
    const oldIdx = old >= 0 ? oldOut[old]! : -1
    const outIdx = out.length
    if (retained && oldIdx >= 0 && prev && prev[oldIdx] !== undefined) out.push(prev[oldIdx]!)
    else out.push(rows[i]!)
    if (!retained || modified.has(i)) changed.push(outIdx)
    outFrom.push(oldIdx)
  }
  const to = new Array<number>(prev ? prev.length : 0).fill(-1)
  for (let i = 0; i < outFrom.length; i++) if (outFrom[i]! >= 0) to[outFrom[i]!] = i
  return { rows: out, pulse: pulseOfMapping(outFrom, to, changed), state: pass }
}

function foldPulse(
  rows: Row[], t: CompiledTransform, tctx: StepTransformContext, sourceName: string,
  input: StepPulse, prev: Row[] | undefined,
): { rows: Row[]; pulse: StepPulse } | null {
  const n = ((t as { fields?: unknown[] }).fields ?? []).length
  if (!n) return null
  const from = input.from!
  const modified = isModified(input)
  const out: Row[] = []
  const outFrom: number[] = []
  const changed: number[] = []
  for (let i = 0; i < rows.length; i++) {
    const old = from[i]!
    const start = out.length
    const canReuse = old >= 0 && !modified.has(i) && prev && prev.length === from.length * n
    if (canReuse) {
      for (let j = 0; j < n; j++) {
        out.push(prev![old * n + j]!)
        outFrom.push(old * n + j)
      }
      continue
    }
    const derived = applyOne([rows[i]!], t, tctx, sourceName)
    if (derived.length !== n) return null
    for (let j = 0; j < n; j++) {
      out.push(derived[j]!)
      outFrom.push(-1)
      changed.push(start + j)
    }
  }
  const to = new Array<number>(prev ? prev.length : 0).fill(-1)
  for (let i = 0; i < outFrom.length; i++) if (outFrom[i]! >= 0) to[outFrom[i]!] = i
  return { rows: out, pulse: pulseOfMapping(outFrom, to, changed) }
}

function flattenPulse(
  rows: Row[], t: CompiledTransform, tctx: StepTransformContext, sourceName: string,
  input: StepPulse, prev: Row[] | undefined, prevState: FlattenState | undefined,
): { rows: Row[]; pulse: StepPulse; state?: unknown } | null {
  const fields = (t as { fields?: string[] }).fields ?? []
  const from = input.from!
  const modified = isModified(input)
  if (!prevState || prevState.sizes.length !== (input.to?.length ?? -1)) return null
  const sizes = new Array<number>(rows.length)
  for (let i = 0; i < rows.length; i++) {
    const old = from[i]!
    if (old >= 0 && !modified.has(i)) {
      sizes[i] = prevState.sizes[old]!
    } else {
      sizes[i] = flattenSize(rows[i]!, fields)
      if (old >= 0 && sizes[i] !== prevState.sizes[old]) return null
    }
  }
  const offsets = new Array<number>(rows.length)
  let pos = 0
  for (let i = 0; i < rows.length; i++) { offsets[i] = pos; pos += sizes[i]! }
  if (prev && prev.length !== prevState.offsets.reduce((a, o, i) => Math.max(a, o + prevState.sizes[i]!), 0)) {
    // The cached output length does not line up with the cached state; fall back.
    if (prev.length !== prevState.offsets.length && prev.length < pos) return null
  }
  const out: Row[] = []
  const outFrom: number[] = []
  const changed: number[] = []
  for (let i = 0; i < rows.length; i++) {
    const old = from[i]!
    const size = sizes[i]!
    const start = out.length
    const canReuse = old >= 0 && !modified.has(i) && prev && prevState.sizes[old] === size
    if (canReuse) {
      for (let j = 0; j < size; j++) {
        const oldIdx = prevState.offsets[old]! + j
        out.push(prev![oldIdx]!)
        outFrom.push(oldIdx)
      }
      continue
    }
    const derived = applyOne([rows[i]!], t, tctx, sourceName)
    for (let j = 0; j < size; j++) {
      out.push(derived[j] ?? rows[i]!)
      outFrom.push(-1)
      changed.push(start + j)
    }
  }
  const to = new Array<number>(prev ? prev.length : 0).fill(-1)
  for (let i = 0; i < outFrom.length; i++) if (outFrom[i]! >= 0) to[outFrom[i]!] = i
  return { rows: out, pulse: pulseOfMapping(outFrom, to, changed), state: { sizes, offsets } }
}

/**
 * Incremental aggregate: rebuild the group membership index, recompute only the
 * dirty groups, and key the output by group so unchanged groups keep their row
 * objects and output positions.
 */
function aggregatePulse(
  rows: Row[], t: CompiledTransform, tctx: StepTransformContext, sourceName: string,
  input: StepPulse, prev: Row[] | undefined, prevState: AggState | undefined,
): { rows: Row[]; pulse: StepPulse; state?: unknown } | null {
  if (!prevState) return null
  const groupby = (t as { groupby?: string[] }).groupby ?? []
  const from = input.from!
  const oldLen = input.to?.length ?? -1
  if (prevState.rowKey.length !== oldLen) return null
  const dirty = new Set<string>()
  for (let i = 0; i < from.length; i++) if (from[i]! < 0) dirty.add(groupKeyOf(rows[i]!, groupby))
  if (input.to) for (let i = 0; i < input.to.length; i++) if (input.to[i]! < 0) dirty.add(prevState.rowKey[i]!)
  const modified = isModified(input)
  for (const i of modified) {
    if (i < 0 || i >= rows.length) return null
    dirty.add(groupKeyOf(rows[i]!, groupby))
    const old = from[i]!
    if (old >= 0 && old < prevState.rowKey.length) dirty.add(prevState.rowKey[old]!)
  }

  const rowKey = new Array<string>(rows.length)
  const keyToIdx = new Map<string, number[]>()
  for (let i = 0; i < rows.length; i++) {
    const k = groupKeyOf(rows[i]!, groupby)
    rowKey[i] = k
    let arr = keyToIdx.get(k)
    if (!arr) keyToIdx.set(k, (arr = []))
    arr.push(i)
  }
  // Output order is the FIRST-OCCURRENCE order of the groups in the current
  // rows, exactly like the full aggregate. Surviving groups that moved
  // are expressed through the pulse mapping (`outFrom`), not by keeping their
  // previous position.
  const outOrder = [...keyToIdx.keys()]

  const outByKey = new Map<string, Row>()
  const out: Row[] = []
  const outFrom: number[] = []
  const changed: number[] = []
  const outIdx = new Map<string, number>()
  for (const k of outOrder) {
    const idxs = keyToIdx.get(k)!
    const oldIdx = prevState.outIdx.get(k)
    const oldRow = oldIdx != null ? prevState.outByKey.get(k) : undefined
    let next: Row
    if (!dirty.has(k) && oldRow) next = oldRow
    else {
      next = aggregateGroup(idxs.map((i) => rows[i]!), t)
      if (oldRow && rowsEqual(next, oldRow)) next = oldRow
    }
    const at = out.length
    outIdx.set(k, at)
    outByKey.set(k, next)
    out.push(next)
    if (oldIdx != null) {
      outFrom.push(oldIdx)
      if (next !== oldRow) changed.push(at)
    } else {
      outFrom.push(-1)
    }
  }
  const to = new Array<number>(prev ? prev.length : 0).fill(-1)
  for (let i = 0; i < outFrom.length; i++) if (outFrom[i]! >= 0) to[outFrom[i]!] = i
  // Refresh the persistent state for the next pulse.
  const state = buildAggState(rows, groupby, out)
  state.outByKey = outByKey
  return { rows: out, pulse: pulseOfMapping(outFrom, to, changed), state }
}

/** Incremental joinaggregate: 1:1 with the input; only dirty groups re-derive. */
function joinAggregatePulse(
  rows: Row[], t: CompiledTransform, tctx: StepTransformContext, sourceName: string,
  input: StepPulse, prev: Row[] | undefined, prevState: AggState | undefined,
): { rows: Row[]; pulse: StepPulse; state?: unknown } | null {
  if (!prevState) return null
  const groupby = (t as { groupby?: string[] }).groupby ?? []
  const from = input.from!
  const oldLen = input.to?.length ?? -1
  if (prevState.rowKey.length !== oldLen) return null
  const dirty = new Set<string>()
  for (let i = 0; i < from.length; i++) if (from[i]! < 0) dirty.add(groupKeyOf(rows[i]!, groupby))
  if (input.to) for (let i = 0; i < input.to.length; i++) if (input.to[i]! < 0) dirty.add(prevState.rowKey[i]!)
  const modified = isModified(input)
  for (const i of modified) {
    if (i < 0 || i >= rows.length) return null
    dirty.add(groupKeyOf(rows[i]!, groupby))
    const old = from[i]!
    if (old >= 0 && old < prevState.rowKey.length) dirty.add(prevState.rowKey[old]!)
  }
  const keyToIdx = new Map<string, number[]>()
  for (let i = 0; i < rows.length; i++) {
    const k = groupKeyOf(rows[i]!, groupby)
    let arr = keyToIdx.get(k)
    if (!arr) keyToIdx.set(k, (arr = []))
    arr.push(i)
  }
  const out = new Array<Row>(rows.length)
  const changed: number[] = []
  for (const k of dirty) {
    const idxs = keyToIdx.get(k)
    if (!idxs) continue
    const derived = applyOne(idxs.map((i) => rows[i]!), t, tctx, sourceName)
    if (derived.length !== idxs.length) return null
    for (let j = 0; j < idxs.length; j++) {
      out[idxs[j]!] = derived[j]!
      changed.push(idxs[j]!)
    }
  }
  for (let i = 0; i < rows.length; i++) {
    if (out[i] !== undefined) continue
    const old = from[i]!
    if (old >= 0 && !modified.has(i) && prev && prev[old] !== undefined) out[i] = prev[old]!
    else out[i] = rows[i]!
  }
  const state = buildAggState(rows, groupby, out)
  return { rows: out, pulse: pulseOfMapping(from, input.to, changed), state }
}

/** Incremental aggregate for an append-only pulse (no group removals). */
function aggregateAppendPulse(
  rows: Row[], t: CompiledTransform, tctx: StepTransformContext, sourceName: string,
  input: StepPulse, prev: Row[] | undefined, prevState: AggState | undefined,
): { rows: Row[]; pulse: StepPulse; state?: unknown } | null {
  const base = pulseBaseLength(input)
  if (!prevState || !prev || prevState.rowKey.length !== base || prev.length !== prevState.outOrder.length) return null
  const groupby = (t as { groupby?: string[] }).groupby ?? []
  const keyToIdx = prevState.keyToIdx
  const rowKey = prevState.rowKey
  const dirty = new Set<string>()
  for (const i of input.changed) {
    if (i < 0 || i >= base) continue
    const k = groupKeyOf(rows[i]!, groupby)
    if (prevState.rowKey[i] !== k) return null
    dirty.add(k)
  }
  const newKeys: string[] = []
  for (let i = base; i < rows.length; i++) {
    const k = groupKeyOf(rows[i]!, groupby)
    rowKey.push(k)
    let idxs = keyToIdx.get(k)
    if (!idxs) { keyToIdx.set(k, (idxs = [])); newKeys.push(k) }
    idxs.push(i)
    dirty.add(k)
  }
  const outOrder = [...prevState.outOrder, ...newKeys]
  const outByKey = new Map(prevState.outByKey)
  const outIdx = new Map<string, number>()
  const out: Row[] = []
  const outFrom: number[] = []
  const changed: number[] = []
  for (const k of outOrder) {
    const oldIdx = prevState.outIdx.get(k)
    const oldRow = prevState.outByKey.get(k)
    let next: Row
    if (!dirty.has(k) && oldRow) next = oldRow
    else {
      const idxs = keyToIdx.get(k)!
      next = aggregateGroup(idxs.map((i) => rows[i]!), t)
      if (oldRow && rowsEqual(next, oldRow)) next = oldRow
    }
    const at = out.length
    outIdx.set(k, at)
    outByKey.set(k, next)
    out.push(next)
    if (oldIdx != null) {
      outFrom.push(oldIdx)
      if (next !== oldRow) changed.push(at)
    } else outFrom.push(-1)
  }
  const state: AggState = {
    groupby, rowKey, keyToIdx, outOrder, outIdx, outByKey,
    groupStart: prevState.groupStart, groupSize: prevState.groupSize, out,
  }
  void sourceName; void tctx; void outFrom
  return { rows: out, pulse: appendPulse(prev.length, out.length, changed), state }
}

/** Incremental joinaggregate for an append-only pulse. */
function joinAggregateAppendPulse(
  rows: Row[], t: CompiledTransform, tctx: StepTransformContext, sourceName: string,
  input: StepPulse, prev: Row[] | undefined, prevState: AggState | undefined,
): { rows: Row[]; pulse: StepPulse; state?: unknown } | null {
  const base = pulseBaseLength(input)
  if (!prevState || !prev || prev.length !== base || prevState.rowKey.length !== base) return null
  const groupby = (t as { groupby?: string[] }).groupby ?? []
  const keyToIdx = prevState.keyToIdx
  const rowKey = prevState.rowKey
  const dirty = new Set<string>()
  for (const i of input.changed) {
    if (i < 0 || i >= base) continue
    const k = groupKeyOf(rows[i]!, groupby)
    if (prevState.rowKey[i] !== k) return null
    dirty.add(k)
  }
  const newKeys: string[] = []
  for (let i = base; i < rows.length; i++) {
    const k = groupKeyOf(rows[i]!, groupby)
    rowKey.push(k)
    let idxs = keyToIdx.get(k)
    if (!idxs) { keyToIdx.set(k, (idxs = [])); newKeys.push(k) }
    idxs.push(i)
    dirty.add(k)
  }
  const changed: number[] = []
  for (const k of dirty) {
    const idxs = keyToIdx.get(k)
    if (!idxs) continue
    const derived = applyOne(idxs.map((i) => rows[i]!), t, tctx, sourceName)
    if (derived.length !== idxs.length) return null
    for (let j = 0; j < idxs.length; j++) {
      const i = idxs[j]!
      const old = prev[i]
      if (i < base) {
        if (old !== undefined && rowsEqual(derived[j]!, old)) continue
        changed.push(i)
      }
      prev[i] = derived[j]!
    }
  }
  const outOrder = [...prevState.outOrder, ...newKeys]
  const outIdx = new Map(prevState.outIdx)
  for (const k of newKeys) outIdx.set(k, outIdx.size)
  const state: AggState = {
    groupby, rowKey, keyToIdx, outOrder, outIdx, outByKey: prevState.outByKey,
    groupStart: prevState.groupStart, groupSize: prevState.groupSize, out: prev,
  }
  return { rows: prev, pulse: appendPulse(base, rows.length, changed), state }
}

/** Incremental collect/sample: only the order permutation changes. */
function orderedAppendPulse(
  rows: Row[], t: CompiledTransform, input: StepPulse, prev: Row[] | undefined,
  prevState: { order: number[] } | undefined,
): { rows: Row[]; pulse: StepPulse; state?: unknown } | null {
  const base = pulseBaseLength(input)
  if (!prev || !prevState || prevState.order.length !== base || prev.length !== base) return null
  const sort = (t as { sort?: SortSpec }).sort
  const order = sortOrder(rows, sort)
  const oldPos = new Map<number, number>()
  for (let i = 0; i < prevState.order.length; i++) oldPos.set(prevState.order[i]!, i)
  const modified = isModified(input)
  const out: Row[] = new Array(order.length)
  const from = new Array<number>(order.length).fill(-1)
  const changed: number[] = []
  for (let j = 0; j < order.length; j++) {
    const idx = order[j]!
    const old = idx < base ? oldPos.get(idx) : undefined
    if (old != null && prev[old] !== undefined && !modified.has(idx)) {
      out[j] = prev[old]!
      from[j] = old
    } else {
      out[j] = rows[idx]!
      // (a modified row is the same row in a new state: it keeps its place in the mapping and is listed as changed)
      if (old != null && prev[old] !== undefined) from[j] = old
      changed.push(j)
    }
  }
  const to = new Array<number>(prev.length).fill(-1)
  for (let i = 0; i < from.length; i++) if (from[i]! >= 0) to[from[i]!] = i
  return { rows: out, pulse: pulseOfMapping(from, to, changed), state: { order } }
}

/** sequence appends generated rows after the source rows; the tail is stable. */
function sequencePulse(
  rows: Row[], t: CompiledTransform, tctx: StepTransformContext, sourceName: string,
  input: StepPulse, prev: Row[] | undefined,
): { rows: Row[]; pulse: StepPulse } | null {
  const from = input.from!
  // A removal/replacement in the source shifts the generated tail; fall back.
  if (input.to && input.to.some((v) => v < 0)) return null
  if (input.changed.length) return null
  const generated = (applyTransforms([], [t], tctx, sourceName) as Row[])
  const oldLen = input.to?.length ?? -1
  const out: Row[] = []
  const outFrom: number[] = []
  const changed: number[] = []
  for (let i = 0; i < rows.length; i++) {
    const old = from[i]!
    if (old >= 0 && prev && prev[old] !== undefined) { out.push(prev[old]!); outFrom.push(old) }
    else { out.push(rows[i]!); outFrom.push(-1); changed.push(out.length - 1) }
  }
  for (let j = 0; j < generated.length; j++) {
    const oldIdx = oldLen + j
    if (prev && prev[oldIdx] !== undefined) { out.push(prev[oldIdx]!); outFrom.push(oldIdx) }
    else { out.push(generated[j]!); outFrom.push(-1); changed.push(out.length - 1) }
  }
  const to = new Array<number>(prev ? prev.length : oldLen + generated.length).fill(-1)
  for (let i = 0; i < outFrom.length; i++) if (outFrom[i]! >= 0) to[outFrom[i]!] = i
  return { rows: out, pulse: pulseOfMapping(outFrom, to, changed) }
}

/** A generating transform whose output is independent of the input rows. */
function generatingPulse(
  rows: Row[], t: CompiledTransform, tctx: StepTransformContext, sourceName: string,
  prev: Row[] | undefined,
): { rows: Row[]; pulse: StepPulse } {
  const out = applyOne(rows, t, tctx, sourceName)
  if (prev && out.length === prev.length && out.every((r, i) => rowsEqual(r, prev[i]!))) {
    return { rows: prev, pulse: pulseOfMapping(identityMapping(prev.length), identityMapping(prev.length), []) }
  }
  return { rows: out, pulse: { changed: [], full: true } }
}

/**
 * True when a transform's output row depends only on its own input row (plus
 * the params the dataset fingerprint already covers), so the rows a pulse does
 * not name keep their cached output. Anything that reads other rows, other
 * datasets or writes a signal is NOT row-local (bin with a data-derived extent,
 * a lookup into a dataset that changed, a formula calling data()/indata(),
 * ...).
 */
/** Expression functions that read a scale (see runtime.ts `SCALE_FN_EXPR`). */
const READS_SCALE = /\b(scale|bandwidth|bandspace|invert|domain|range|copy|gradient)\s*\(/

/**
 * Whether a filter's verdict on a row is a function of the row (and of what does not change in this evaluation): a row it kept or
 * dropped before keeps its verdict. Not when its expression reads a scale (which may be another), or a dataset this evaluation
 * changes (`length(data("t"))` over its own source, a selection's store edited with the rows): every row is judged again.
 */
function filterIsRowLocal(t: CompiledTransform, tctx: StepTransformContext): boolean {
  const expr = (t as { expr?: unknown }).expr
  if (typeof expr !== 'string') return true
  if (READS_SCALE.test(lexedText(expr))) return false
  const read = datasetsReadIn(expr)
  return read !== null && !read.some((n) => tctx.affectedDatasets?.has(n) === true)
}

function rowLocal(t: CompiledTransform, tctx: StepTransformContext): boolean {
  const type = String(t.type)
  switch (type) {
    case 'formula':
      return !DATA_DEPENDENT_EXPR.test((t as { expr?: string }).expr ?? '')
    case 'timeunit':
      // without explicit units vega bins the data extent (global); inferUnits looks at every row
      // (a `signal` output is a side effect a skipped re-run would lose, and covers every row)
      return (t as { units?: unknown }).units != null && !(t as { inferUnits?: unknown }).inferUnits && (t as { extent?: unknown }).extent === undefined && !(t as { signal?: unknown }).signal
    case 'geoshape': case 'geopath': case 'geopoint':
      // a projection that fits data moves with the data: a derived x/y or path is only valid for the fit it was made under
      return !(tctx.projections as ProjectionRegistry | undefined)?.fitNames?.has(String((t as { projection?: unknown }).projection))
    case 'linkpath': case 'project':
      return true
    case 'bin':
      // A fixed numeric extent makes the bins constant; a `signal` output is a
      // side effect a skipped re-run would lose.
      return Array.isArray((t as { extent?: unknown }).extent) && !(t as { signal?: unknown }).signal
    case 'lookup':
      return !tctx.affectedDatasets?.has((t as { from?: string }).from ?? '')
    default:
      return false
  }
}

/**
 * `identifier` over an append-only pulse. Vega numbers only the tuples that are new, in order, from the view's counter, so the
 * new rows continue from where the counter stands (other datasets' `identifier`s may have moved it since); a modified earlier
 * row, which keeps its number, falls back to the pulse that carries the mapping.
 */
function identifierAppendPulse(
  rows: Row[], t: CompiledTransform, tctx: StepTransformContext, input: StepPulse, prev: Row[] | undefined,
): { rows: Row[]; pulse: StepPulse } | null {
  const base = pulseBaseLength(input)
  if (!prev || prev.length !== base || input.changed.length) return null
  const as = (t as { as?: string }).as
  if (as === undefined) return null
  const ids = tctx.ids
  if (!ids) return null
  for (let i = base; i < rows.length; i++) {
    const row = { ...rows[i]! }
    row[as] = row[as] || ++ids.value
    prev.push(row)
  }
  return { rows: prev, pulse: appendPulse(base, rows.length, []) }
}

/**
 * `identifier` over a pulse with a mapping. A pulse that only modifies rows (the same rows, some in a new state) leaves every row
 * its number. One that adds or removes rows cannot say which of the rows it lists as changed are modified and which replaced
 * (the diff that makes it pairs rows by position), so the rows are found by what they hold, as when no pulse says anything.
 */
function identifierPulse(
  rows: Row[], t: CompiledTransform, tctx: StepTransformContext, sourceName: string, input: StepPulse, prev: Row[] | undefined,
): { rows: Row[]; pulse: StepPulse } | null {
  const from = input.from!
  const structural = from.includes(-1) || (input.to?.includes(-1) ?? false)
  return withCarry(tctx, structural ? carryByAlignment(rows, prev, idField(t)) : carryByMapping(from, prev, idField(t)),
    () => rederiveAligned(rows, t, tctx, sourceName, input, prev))
}

/**
 * Apply one transform to a length-changing pulse. Returns `null` when the
 * transform cannot publish a mapping (the caller then re-derives the rest).
 */
function applyStepWithPulse(
  rows: Row[], t: CompiledTransform, tctx: StepTransformContext, sourceName: string,
  input: StepPulse, prev: Row[] | undefined, prevStepState: unknown, aliased?: ReadonlySet<string>,
): { rows: Row[]; pulse: StepPulse | null; state?: unknown } {
  const type = String(t.type)
  if ((type === 'aggregate' || type === 'joinaggregate') && !groupwiseIncremental(t)) {
    return { rows: applyOne(rows, t, tctx, sourceName), pulse: null }
  }
  if (input.appendOnly) {
    // Fast paths that never need the full mapping.
    const appendLocal = rowLocal(t, tctx)
    if (appendLocal) {
      const fast = rowLocalAppendPulse(rows, t, tctx, sourceName, input, prev)
      if (fast) return fast
    } else if (type === 'identifier') {
      const fast = identifierAppendPulse(rows, t, tctx, input, prev)
      if (fast) return fast
    } else if (type === 'filter') {
      const fast = filterIsRowLocal(t, tctx) ? filterAppendPulse(rows, t, tctx, sourceName, input, prev, prevStepState as boolean[] | undefined) : null
      if (fast) return fast
    } else if (type === 'fold') {
      const fast = foldAppendPulse(rows, t, tctx, sourceName, input, prev)
      if (fast) return fast
    } else if (type === 'aggregate') {
      const fast = aggregateAppendPulse(rows, t, tctx, sourceName, input, prev, prevStepState as AggState | undefined)
      if (fast) return fast
    } else if (type === 'joinaggregate') {
      const fast = joinAggregateAppendPulse(rows, t, tctx, sourceName, input, prev, prevStepState as AggState | undefined)
      if (fast) return fast
    } else if (type === 'collect' && !isPlacing(t)) {
      const fast = orderedAppendPulse(rows, t, input, prev, prevStepState as { order: number[] } | undefined)
      if (fast) return fast
    } else if (type === 'geojson' || type === 'extent' || type === 'stratify') {
      const out = applyOne(rows, t, tctx, sourceName)
      return { rows: out, pulse: out.length === rows.length ? input : null }
    }
    // Everything else needs old<->new indices; synthesise them only here.
    const from = mappingFromPulse(input, rows.length)
    input = { ...input, from, to: inverseMapping(from, pulseBaseLength(input)), appendOnly: undefined, baseLength: undefined }
  }
  switch (type) {
    case 'formula':
    case 'timeunit':
    case 'geoshape':
    case 'geopath':
    case 'geopoint':
    case 'linkpath':
    case 'project':
    case 'bin':
    case 'lookup':
      // Row-local transforms re-derive only the added/modified rows; the others
      // of the same type (data-extent bin, a lookup into a changed dataset, a
      // formula that reads datasets) are global and re-derive aligned.
      if (rowLocal(t, tctx)) {
        return rowLocalPulse(rows, t, tctx, sourceName, input, prev) ?? { rows: applyOne(rows, t, tctx, sourceName), pulse: null }
      }
      if (type === 'bin') return rederiveAligned(rows, t, tctx, sourceName, input, prev, aliased) ?? { rows: applyOne(rows, t, tctx, sourceName), pulse: null }
      return { rows: applyOne(rows, t, tctx, sourceName), pulse: null }
    case 'identifier':
      // The rows that were there keep their numbers (a modified one too), the new ones are numbered from the view's counter.
      return identifierPulse(rows, t, tctx, sourceName, input, prev) ?? { rows: applyIdentifier(rows, t, tctx, sourceName, undefined), pulse: null }
    case 'geojson':
    case 'extent':
    case 'stratify': {
      const out = applyOne(rows, t, tctx, sourceName)
      return { rows: out, pulse: out.length === rows.length ? input : null }
    }
    case 'filter':
      return (filterIsRowLocal(t, tctx) ? filterPulse(rows, t, tctx, sourceName, input, prev, prevStepState as boolean[] | undefined) : null)
        ?? { rows: applyOne(rows, t, tctx, sourceName), pulse: null }
    case 'fold':
      return foldPulse(rows, t, tctx, sourceName, input, prev)
        ?? { rows: applyOne(rows, t, tctx, sourceName), pulse: null }
    case 'flatten':
      return flattenPulse(rows, t, tctx, sourceName, input, prev, prevStepState as FlattenState | undefined)
        ?? { rows: applyOne(rows, t, tctx, sourceName), pulse: null }
    case 'aggregate':
      return aggregatePulse(rows, t, tctx, sourceName, input, prev, prevStepState as AggState | undefined)
        ?? { rows: applyOne(rows, t, tctx, sourceName), pulse: null }
    case 'joinaggregate':
      return joinAggregatePulse(rows, t, tctx, sourceName, input, prev, prevStepState as AggState | undefined)
        ?? { rows: applyOne(rows, t, tctx, sourceName), pulse: null }
    case 'window':
      // Window writes its results back in SOURCE order (1:1 with the input,
      // whatever the partition/sort), so it aligns like any other index-
      // preserving transform; a row's value can change without the row itself
      // changing (its partition-mates did), which the content comparison finds.
      return rederiveAligned(rows, t, tctx, sourceName, input, prev)
        ?? { rows: applyOne(rows, t, tctx, sourceName), pulse: null }
    case 'stack':
      // vega's stack writes y0/y1 onto each tuple in place: 1:1 with the input, in input order
      return rederiveAligned(rows, t, tctx, sourceName, input, prev)
        ?? { rows: applyOne(rows, t, tctx, sourceName), pulse: null }
    case 'pie':
    case 'dotbin':
    case 'label':
    case 'pack':
    case 'partition':
    case 'treemap':
    case 'tree':
    case 'voronoi':
      return rederiveAligned(rows, t, tctx, sourceName, input, prev)
        ?? { rows: applyOne(rows, t, tctx, sourceName), pulse: null }
    case 'sequence':
      return sequencePulse(rows, t, tctx, sourceName, input, prev)
        ?? { rows: applyOne(rows, t, tctx, sourceName), pulse: null }
    case 'graticule':
      return generatingPulse(rows, t, tctx, sourceName, prev)
    default:
      // Global generators/fitters (kde/regression/loess/wordcloud/contour/...)
      // cannot expose a row mapping.
      return { rows: applyOne(rows, t, tctx, sourceName), pulse: null }
  }
}

/**
 * Apply a transform chain driven by a pulse, step by step. Reads the COMMITTED
 * step outputs/state (`prevDS`) and records this evaluation's into `state`;
 * once a step cannot publish a mapping (`pulse` becomes null) the remaining
 * steps run from scratch but still leave their state behind.
 */
function applyPipelineWithPulse(
  rows: Row[], transforms: CompiledTransform[], tctx: StepTransformContext, sourceName: string,
  input: StepPulse, prevDS: DatasetState, state: DatasetState,
): { rows: Row[]; pulse: StepPulse | null } {
  let cur = rows
  let pulse: StepPulse | null = input
  for (let k = 0; k < transforms.length; k++) {
    const t = transforms[k]!
    const key = `${sourceName}#${k}`
    if (!pulse) {
      const res = applyOneWithState(cur, t, tctx, sourceName, prevDS.steps[k])
      cur = res.rows
      checkRowCount(cur.length, `transform ${String(t.type)}`)
      state.steps.push(cur)
      if (res.state !== undefined) state.stepState.set(key, res.state)
      continue
    }
    const stepInput = cur
    const res = applyStepWithPulse(cur, t, tctx, sourceName, pulse, prevDS.steps[k], prevDS.stepState.get(key), prevDS.aliased?.[k])
    if (prevDS.aliased?.[k] !== undefined) (state.aliased ??= [])[k] = prevDS.aliased[k]
    cur = res.rows
    checkRowCount(cur.length, `transform ${String(t.type)}`)
    pulse = res.pulse
    state.steps.push(cur)
    const next = res.state !== undefined ? res.state
      : keepsStepState(String(t.type)) ? deriveStepState(t, stepInput, cur, tctx) : undefined
    if (next !== undefined) state.stepState.set(key, next)
  }
  return { rows: cur, pulse }
}

export const incrementalEngine: IncrementalEngine = { applyPipelineWithPulse, applyOneWithState }
