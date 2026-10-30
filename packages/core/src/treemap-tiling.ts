/**
 * The ways a treemap divides a rectangle among a node's children. A tiling lays the children out in the rectangle
 * (x0, y0)-(x1, y1) by writing `x0 y0 x1 y1` on each, proportionally to their `value`.
 *
 * Observable behaviour fixed here: positions are computed by running sums and products in the orders below (a row's
 * edge is `start + extent * share`, built up child by child), because rounding differs between equivalent formulas.
 */
import type { HierNode } from './transform.js'

export type Tiling = (parent: HierNode, x0: number, y0: number, x1: number, y1: number) => void

/** Lay `nodes[from, to)` (values summing to `total`) side by side across the width, each full height. */
function tileAlongX(nodes: readonly HierNode[], from: number, to: number, total: number, x0: number, y0: number, x1: number, y1: number): void {
  const k = total && (x1 - x0) / total
  for (let i = from; i < to; ++i) {
    const node = nodes[i]!
    node.y0 = y0
    node.y1 = y1
    node.x0 = x0
    node.x1 = x0 += node.value * k
  }
}

/** Lay `nodes[from, to)` (values summing to `total`) one under the other down the height, each full width. */
function tileAlongY(nodes: readonly HierNode[], from: number, to: number, total: number, x0: number, y0: number, x1: number, y1: number): void {
  const k = total && (y1 - y0) / total
  for (let i = from; i < to; ++i) {
    const node = nodes[i]!
    node.x0 = x0
    node.x1 = x1
    node.y0 = y0
    node.y1 = y0 += node.value * k
  }
}

/** Children side by side. */
export const tileColumns: Tiling = (parent, x0, y0, x1, y1) => {
  tileAlongX(parent.children, 0, parent.children.length, parent.value, x0, y0, x1, y1)
}

/** Children one under the other. */
export const tileRows: Tiling = (parent, x0, y0, x1, y1) => {
  tileAlongY(parent.children, 0, parent.children.length, parent.value, x0, y0, x1, y1)
}

/** Columns at odd depths, rows at even ones. */
export const tileAlternating: Tiling = (parent, x0, y0, x1, y1) => {
  (parent.depth & 1 ? tileRows : tileColumns)(parent, x0, y0, x1, y1)
}

/** Split the children into two halves of near equal value, then split each half across its longer side, recursively. */
export const tileBinary: Tiling = (parent, x0, y0, x1, y1) => {
  const nodes = parent.children
  const n = nodes.length
  // running totals: sums[i] is the value of the first i children
  const sums = new Float64Array(n + 1)
  let sum = 0
  for (let i = 0; i < n; ++i) sums[i + 1] = sum += nodes[i]!.value
  // work list of (from, to, value, rectangle); the halves of a range are independent
  const work: number[] = [0, n, parent.value, x0, y0, x1, y1]
  while (work.length) {
    const ay1 = work.pop()!
    const ax1 = work.pop()!
    const ay0 = work.pop()!
    const ax0 = work.pop()!
    const value = work.pop()!
    const j = work.pop()!
    const i = work.pop()!
    if (i >= j - 1) {
      const node = nodes[i]!
      node.x0 = ax0
      node.y0 = ay0
      node.x1 = ax1
      node.y1 = ay1
      continue
    }
    // the split point: the first k whose running total reaches half the range's value, or the one before when closer
    const offset = sums[i]!
    const target = value / 2 + offset
    let k = i + 1
    let hi = j - 1
    while (k < hi) {
      const mid = k + hi >>> 1
      if (sums[mid]! < target) k = mid + 1
      else hi = mid
    }
    if (target - sums[k - 1]! < sums[k]! - target && i + 1 < k) --k
    const valueLeft = sums[k]! - offset
    const valueRight = value - valueLeft
    if (ax1 - ax0 > ay1 - ay0) {
      const xk = value ? (ax0 * valueRight + ax1 * valueLeft) / value : ax1
      work.push(k, j, valueRight, xk, ay0, ax1, ay1)
      work.push(i, k, valueLeft, ax0, ay0, xk, ay1)
    } else {
      const yk = value ? (ay0 * valueRight + ay1 * valueLeft) / value : ay1
      work.push(k, j, valueRight, ax0, yk, ax1, ay1)
      work.push(i, k, valueLeft, ax0, ay0, ax1, yk)
    }
  }
}

/** The golden ratio: the default aspect ratio a squarified row aims for. */
export const GOLDEN_RATIO = (1 + Math.sqrt(5)) / 2

/** One row of a squarified layout: the children it holds, whether it runs along x, and their total value. */
interface SquarifiedRow {
  nodes: HierNode[]
  alongX: boolean
  value: number
}

/**
 * Squarified tiling (Bruls et al.): grow a row along the shorter side while its worst aspect ratio does not get worse,
 * lay it out, and continue in what is left. Returns the rows when `keepRows` (resquarify replays them).
 */
function squarify(ratio: number, parent: HierNode, x0: number, y0: number, x1: number, y1: number, keepRows: boolean): SquarifiedRow[] {
  const rows: SquarifiedRow[] = []
  const nodes = parent.children
  const n = nodes.length
  let value = parent.value
  let from = 0
  let to = 0
  while (from < n) {
    const dx = x1 - x0
    const dy = y1 - y0
    // the row starts at the next child with a value (the empty ones before it ride along)
    let total: number
    do total = nodes[to++]!.value; while (!total && to < n)
    let min = total
    let max = total
    const alpha = Math.max(dy / dx, dx / dy) / (value * ratio)
    let beta = total * total * alpha
    let worst = Math.max(max / beta, beta / min)
    for (; to < n; ++to) {
      const v = nodes[to]!.value
      total += v
      if (v < min) min = v
      if (v > max) max = v
      beta = total * total * alpha
      const next = Math.max(max / beta, beta / min)
      if (next > worst) { total -= v; break }
      worst = next
    }
    const alongX = dx < dy
    if (keepRows) rows.push({ nodes: nodes.slice(from, to), alongX, value: total })
    if (alongX) tileAlongX(nodes, from, to, total, x0, y0, x1, value ? y0 += dy * total / value : y1)
    else tileAlongY(nodes, from, to, total, x0, y0, value ? x0 += dx * total / value : x1, y1)
    value -= total
    from = to
  }
  return rows
}

/** Squarified tiling aiming at width : height = `ratio` (never less than 1). */
export function squarified(ratio: number): Tiling {
  return (parent, x0, y0, x1, y1) => { squarify(ratio, parent, x0, y0, x1, y1, false) }
}

/** The rows a parent was last squarified into by `resquarified`, and the ratio they were made with. */
const remembered = new WeakMap<HierNode, { ratio: number; rows: SquarifiedRow[] }>()

/**
 * Squarified tiling that keeps its rows on the parent: laid out again (with new values) with the same ratio it keeps
 * the rows and only re-scales them, so the layout stays put as the values change. A different ratio starts afresh.
 */
export function resquarified(ratio: number): Tiling {
  return (parent, x0, y0, x1, y1) => {
    const memo = remembered.get(parent)
    if (memo && memo.ratio === ratio) {
      let value = parent.value
      for (const row of memo.rows) {
        row.value = 0
        for (let i = 0; i < row.nodes.length; ++i) row.value += row.nodes[i]!.value
        if (row.alongX) tileAlongX(row.nodes, 0, row.nodes.length, row.value, x0, y0, x1, value ? y0 += (y1 - y0) * row.value / value : y1)
        else tileAlongY(row.nodes, 0, row.nodes.length, row.value, x0, y0, value ? x0 += (x1 - x0) * row.value / value : x1, y1)
        value -= row.value
      }
    } else {
      remembered.set(parent, { ratio, rows: squarify(ratio, parent, x0, y0, x1, y1, true) })
    }
  }
}

/** The tilings by their `method` name; `squarify` and `resquarify` take a `ratio`. */
export const TILINGS: Record<string, { tile: (ratio: number) => Tiling; ratioParam: boolean }> = {
  binary: { tile: () => tileBinary, ratioParam: false },
  dice: { tile: () => tileColumns, ratioParam: false },
  slice: { tile: () => tileRows, ratioParam: false },
  slicedice: { tile: () => tileAlternating, ratioParam: false },
  squarify: { tile: squarified, ratioParam: true },
  resquarify: { tile: resquarified, ratioParam: true },
}
