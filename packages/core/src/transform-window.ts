/**
 * The `window` transform: rank, offset and running-aggregate columns computed over a sliding frame of each sorted partition.
 *
 * The output rows are the input rows in input order, each gaining its columns: first the aggregate measures of the frame, then the
 * rank/offset functions, whatever order the ops were listed in. A frame is `[from, to]` row offsets relative to the current row
 * (`null` for unbounded); under a sort, and unless `ignorePeers`, each end grows to take in the rows tied with the row it lands on.
 */
import { accessorName, array, error } from './util.js'
import { meterTick } from './limits.js'
import {
  compareOf, fieldOf, lcg, MeasureGroup, outputName, partitionRows, planMeasures, SEED, stableSortBy,
  type Compare, type MeasureSet, type Row,
} from './transform-agg.js'
import type { Accessor } from './util.js'

type Get = (d: unknown) => unknown

/** Where a window function is asked its value: the current row of the sorted partition and the frame around it. */
interface Position {
  rows: Row[]
  /** Index of the current row. */
  index: number
  /** The frame is `rows[lo]` up to but not including `rows[hi]`. */
  lo: number
  hi: number
  compare: Compare
}

/** A window function builds its state per partition: calling the maker starts it afresh. */
type FunctionMaker = () => (at: Position) => unknown

/** The rank of the current row among its peers (rows tied under the sort share a rank; the next distinct row's rank skips ahead). */
function rankFunction(): (at: Position) => number {
  let rank = 1
  return ({ rows, index, compare }) => (index && compare(rows[index - 1], rows[index]) ? (rank = index + 1) : rank)
}

/** The share of the partition at or before the current row's last peer. */
function cumulativeShare(): (at: Position) => number {
  let last = 0
  return ({ rows, index, compare }) => {
    let i = index
    if (last < i) {
      while (i + 1 < rows.length && !compare(rows[i], rows[i + 1])) ++i
      last = i
    }
    return (1 + last) / rows.length
  }
}

const positive = (name: string, param: unknown, message: string): number => {
  const n = +(param as number)
  if (!(n > 0)) error(`${name} ${message} must be greater than zero.`)
  return n
}

const WINDOW_FUNCTIONS: Record<string, (get: Get | undefined, param: unknown) => FunctionMaker> = {
  row_number: () => () => ({ index }) => index + 1,
  rank: () => rankFunction,
  dense_rank: () => () => {
    let dense = 1
    return ({ rows, index, compare }) => (index && compare(rows[index - 1], rows[index]) ? ++dense : dense)
  },
  percent_rank: () => () => {
    const rank = rankFunction()
    return (at) => (rank(at) - 1) / (at.rows.length - 1)
  },
  cume_dist: () => cumulativeShare,
  ntile: (_get, param) => {
    const buckets = positive('ntile', param, 'num')
    return () => {
      const share = cumulativeShare()
      return (at) => Math.ceil(buckets * share(at))
    }
  },
  lag: (get, param) => {
    const back = +(param as number) || 1
    return () => ({ rows, index }) => (index - back >= 0 ? get!(rows[index - back]) : null)
  },
  lead: (get, param) => {
    const ahead = +(param as number) || 1
    return () => ({ rows, index }) => (index + ahead < rows.length ? get!(rows[index + ahead]) : null)
  },
  first_value: (get) => () => ({ rows, lo }) => get!(rows[lo]),
  last_value: (get) => () => ({ rows, hi }) => get!(rows[hi - 1]),
  nth_value: (get, param) => {
    const nth = positive('nth_value', param, 'nth')
    return () => ({ rows, lo, hi }) => (lo + (nth - 1) < hi ? get!(rows[lo + (nth - 1)]) : null)
  },
  prev_value: (get) => () => {
    let prev: unknown = null
    return ({ rows, index }) => {
      const v = get!(rows[index])
      return v != null ? (prev = v) : prev
    }
  },
  next_value: (get) => () => {
    let next: unknown = null
    let from = -1
    return ({ rows, index }) => {
      if (index <= from) return next
      from = firstPresent(get!, rows, index)
      if (from < 0) { from = rows.length; return (next = null) }
      return (next = get!(rows[from]))
    }
  },
}

/** Position of the first row at or after `from` whose value is present (not null/undefined), `-1` if none. */
function firstPresent(get: Get, rows: Row[], from: number): number {
  for (let i = from; i < rows.length; i++) if (get(rows[i]) != null) return i
  return -1
}

export interface WindowParams {
  sort?: unknown
  groupby?: unknown
  ops?: unknown
  params?: unknown
  aggregate_params?: unknown
  fields?: unknown
  as?: unknown
  frame?: unknown
  ignorePeers?: unknown
}

interface WindowPlan {
  functions: Array<{ out: string; make: FunctionMaker }>
  /** The aggregate measures (any op that is not a window function), `null` when there are none. */
  measures: MeasureSet | null
}

function planWindow(p: WindowParams): WindowPlan {
  const ops = array(p.ops) as string[]
  const fields = array(p.fields).map((f) => (f == null ? null : fieldOf(f)))
  const params = array(p.params)
  const aggParams = array(p.aggregate_params)
  const as = array(p.as) as Array<string | null>
  const functions: WindowPlan['functions'] = []
  const aggOps: string[] = []
  const aggFields: Array<Accessor | null> = []
  const aggAs: Array<string | null> = []
  const aggParam: unknown[] = []
  ops.forEach((op, i) => {
    const get = fields[i]
    if (Object.hasOwn(WINDOW_FUNCTIONS, op)) {
      functions.push({ out: outputName(op, accessorName(get), as[i]), make: WINDOW_FUNCTIONS[op]!(get ?? undefined, params[i]) })
    } else {
      aggOps.push(op)
      aggFields.push(get ?? null)
      aggAs.push(as[i] ?? null)
      aggParam.push(aggParams[i] ?? null)
    }
  })
  return { functions, measures: aggOps.length ? planMeasures(aggOps, aggFields, aggAs, aggParam) : null }
}

const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x)

/** First index whose row does not sort before `target`. */
function lowerBound(rows: Row[], target: Row, compare: Compare): number {
  let lo = 0
  let hi = rows.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (compare(rows[mid], target) < 0) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** First index whose row sorts after `target`. */
function upperBound(rows: Row[], target: Row, compare: Compare): number {
  let lo = 0
  let hi = rows.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (compare(rows[mid], target) <= 0) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * vega `window`. The rows written are copies of the input rows (or the rows themselves when the pipeline owns them), in input order.
 *
 * Deviation: where a frame lies wholly outside its partition (it starts after the last row, or ends before the first) Vega's peer
 * stretch reads a row that is not there and the transform fails with a TypeError; here the frame is simply left as the offsets put it.
 */
export function windowRows(rows: readonly Row[], p: WindowParams, random: () => number = lcg(SEED), owned = false): Row[] {
  const out = owned ? rows.slice() : rows.map((r) => ({ ...r }))
  const sort = compareOf(p.sort) as Compare | null
  const plan = planWindow(p)
  const [from, to] = (Array.isArray(p.frame) ? p.frame : [null, 0]) as [number | null, number | null]
  const peerOrder = p.ignorePeers ? null : sort
  const noOrder: Compare = () => -1
  const measures = plan.measures && new MeasureGroup(plan.measures, random)

  for (const partition of partitionRows(out, p.groupby)) {
    const sorted = sort ? stableSortBy(partition, sort) : partition
    const n = sorted.length
    const at: Position = { rows: sorted, index: 0, lo: 0, hi: 0, compare: sort || noOrder }
    const functions = plan.functions.map((f) => f.make())
    measures?.reset()
    for (let i = 0; i < n; ++i) {
      const prevLo = at.lo
      const prevHi = at.hi
      let lo = clamp(from == null ? 0 : i + from, 0, n)
      let hi = clamp(to == null ? n : i + to + 1, 0, n)
      if (peerOrder) {
        const first = lo
        const last = hi - 1
        if (first > 0 && first <= n - 1 && !peerOrder(sorted[first], sorted[first - 1])) lo = lowerBound(sorted, sorted[first]!, peerOrder)
        if (last < n - 1 && last >= 0 && !peerOrder(sorted[last], sorted[last + 1])) hi = upperBound(sorted, sorted[last]!, peerOrder)
      }
      at.index = i
      at.lo = lo
      at.hi = hi
      const row = sorted[i]!
      if (measures) {
        for (let j = prevLo; j < lo; ++j) measures.remove(sorted[j]!)
        for (let j = prevHi; j < hi; ++j) measures.add(sorted[j]!)
        measures.writeTo(row)
      }
      for (let j = 0; j < functions.length; ++j) row[plan.functions[j]!.out] = functions[j]!(at)
      meterTick('window', 1)
    }
  }
  return out
}
