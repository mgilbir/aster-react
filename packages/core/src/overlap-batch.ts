/**
 * Batching symbols that provably do not touch. A translucent, blended, or filled-and-stroked symbol cannot share a path with one it
 * overlaps (one path composites once where its pieces overlap, and paints all its fill before any stroke: render.ts
 * `batchablePaint`), but two symbols whose ink cannot reach the same pixel draw the same in one path as in two. A run of symbols
 * of one paint is cut where the next one's box meets a box already in the batch; every batch is then a set of pairwise disjoint
 * symbols, in their original order, so the picture is the one-element-per-item picture exactly.
 *
 * "Cannot reach the same pixel": each box is the symbol's ink (`symbolInkBox`) grown by one pixel on every side, so two boxes that
 * do not meet (boxes that touch meet: the conformance normalizer's own test of two painted boxes) are more than two pixels apart, and
 * no anti-aliased edge of one touches a pixel of the other.
 */
import type { SceneItem } from './types.js'
import { symbolInkBox } from './bounds.js'

/** Every side of a box grows by this much: the pixel an anti-aliased edge can spill into, and a hundredth over (the oracle's own boxes carry the rounding of a path's three decimals, normalize.ts). */
const PAD = 1.01
/** The grid's cell, in scene units, and the most cells one box may span on an axis (a bigger symbol keeps its own element). */
const CELL = 32
const MAX_SPAN = 8

/** Whether a symbol's paint is one a batch can carry: a gradient is relative to its own item's box. */
export function disjointBatchable(it: SceneItem, isGradient: (v: unknown) => boolean): boolean {
  const rec = it as Record<string, unknown>
  const angle = rec.angle
  return (angle == null || angle === 0) && !isGradient(it.fill) && !isGradient(it.stroke)
}

/**
 * The boxes of the batch being built: `add` takes a symbol in when its box is apart from every member. A grid of cells keyed by
 * the cell's coordinates (a collision only adds a comparison, never a wrong answer).
 */
export class DisjointBatch {
  private readonly cells = new Map<number, number[]>()
  private readonly boxes: number[] = []
  private readonly box = [0, 0, 0, 0]
  count = 0

  reset(): void {
    this.cells.clear()
    this.boxes.length = 0
    this.count = 0
  }

  /**
   * Take `it` into the batch. False, with the batch unchanged, when its ink cannot be bounded, is larger than the grid keeps, or
   * its box is not apart from a member's.
   */
  add(it: SceneItem): boolean {
    const b = this.box
    if (!symbolInkBox(it, b)) return false
    const x1 = b[0]! - PAD, y1 = b[1]! - PAD, x2 = b[2]! + PAD, y2 = b[3]! + PAD
    const cx1 = Math.floor(x1 / CELL), cx2 = Math.floor(x2 / CELL)
    const cy1 = Math.floor(y1 / CELL), cy2 = Math.floor(y2 / CELL)
    if (cx2 - cx1 >= MAX_SPAN || cy2 - cy1 >= MAX_SPAN) return false
    const boxes = this.boxes
    for (let cx = cx1; cx <= cx2; cx++) {
      for (let cy = cy1; cy <= cy2; cy++) {
        const members = this.cells.get(key(cx, cy))
        if (members === undefined) continue
        for (const m of members) {
          const o = m * 4
          if (x1 <= boxes[o + 2]! && boxes[o]! <= x2 && y1 <= boxes[o + 3]! && boxes[o + 1]! <= y2) return false
        }
      }
    }
    const index = this.count++
    boxes.push(x1, y1, x2, y2)
    for (let cx = cx1; cx <= cx2; cx++) {
      for (let cy = cy1; cy <= cy2; cy++) {
        const k = key(cx, cy)
        const members = this.cells.get(k)
        if (members === undefined) this.cells.set(k, [index])
        else members.push(index)
      }
    }
    return true
  }
}

function key(cx: number, cy: number): number {
  return (cx & 0xffff) * 0x10000 + (cy & 0xffff)
}

/**
 * Where the batch that starts at `items[from]` ends (exclusive): the longest stretch of up to `limit` items, each accepted by
 * `accept` and apart from every earlier one. `from` itself when the first cannot be batched at all; `from + 1` is a batch of one.
 */
export function disjointEnd(batch: DisjointBatch, items: SceneItem[], from: number, limit: number, accept: (it: SceneItem) => boolean): number {
  batch.reset()
  if (!accept(items[from]!) || !batch.add(items[from]!)) return from
  let to = from + 1
  while (to < items.length && to - from < limit && accept(items[to]!) && batch.add(items[to]!)) to++
  return to
}
