/**
 * A point quadtree over bodies that move between builds, for the force layouts' Barnes-Hut and collision queries.
 *
 * Cells live in typed arrays (a cell is an integer), so building a tree per tick allocates a handful of buffers and no
 * objects. A cell is a leaf (it holds a body, and the bodies chained behind it at exactly the same point) or a branch
 * of four quadrants.
 *
 * Observable behaviour fixed here, because the forces' float sums follow the tree:
 *  - the root square starts at the integer corner of the lowest point and doubles until it covers the highest one;
 *  - a body descends by the midpoints `(lo + hi) / 2` of its square, `>=` going to the upper or right half;
 *  - a body exactly on an existing body's point is chained in front of it (newest first), not split;
 *  - quadrants are numbered `bottom * 2 + right`, and queries visit them in that order.
 */

/** Past this many nested splits two points cannot be told apart (a double has about 1100 halvings): chain them instead. */
const MAX_SPLITS = 2048

export const NO_CELL = -1

function b4(boxes: Float64Array, at: number, x0: number, y0: number, x1: number, y1: number): void {
  const i = at * 4
  boxes[i] = x0
  boxes[i + 1] = y0
  boxes[i + 2] = x1
  boxes[i + 3] = y1
}

export class QuadTree {
  /** The root cell, or NO_CELL for a tree without bodies. */
  root = NO_CELL
  /** The number of cells in use. */
  size = 0
  /** A leaf's body (an index into the array the tree was built from); -1 for a branch. */
  body: Int32Array
  /** A leaf's chain: the next leaf at exactly the same point, or NO_CELL. */
  chain: Int32Array
  /** A branch's four quadrants (`cell * 4 + quadrant`): a cell, or NO_CELL. */
  quad: Int32Array
  private px: Float64Array
  private py: Float64Array
  private x0 = NaN
  private y0 = NaN
  private x1 = NaN
  private y1 = NaN
  private maxDepth = 0
  private cells: Int32Array | null = null
  private boxes: Float64Array | null = null

  /**
   * `xs[i]`, `ys[i]` are body i's point; a body whose point is not finite is left out (a NaN point never enters; an
   * infinite one would keep the root from ever covering it).
   */
  constructor(xs: Float64Array, ys: Float64Array) {
    const n = xs.length
    const capacity = 2 * n + 4
    this.body = new Int32Array(capacity)
    this.chain = new Int32Array(capacity)
    this.quad = new Int32Array(capacity * 4).fill(NO_CELL)
    this.px = new Float64Array(capacity)
    this.py = new Float64Array(capacity)
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (let i = 0; i < n; ++i) {
      const x = xs[i]!
      const y = ys[i]!
      if (!Number.isFinite(x) || !Number.isFinite(y)) { xs[i] = NaN; continue }
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
    if (minX > maxX) return
    this.cover(minX, minY, maxX, maxY)
    for (let i = 0; i < n; ++i) if (!Number.isNaN(xs[i]!)) this.insert(i, xs[i]!, ys[i]!)
  }

  /** The root square: the integer corner of the lowest point, grown by doubling until it holds the highest. */
  private cover(minX: number, minY: number, maxX: number, maxY: number): void {
    const x0 = Math.floor(minX)
    const y0 = Math.floor(minY)
    let x1 = x0 + 1
    let y1 = y0 + 1
    let size = x1 - x0 || 1
    while (maxX >= x1 || maxY >= y1) {
      size *= 2
      x1 = x0 + size
      y1 = y0 + size
    }
    this.x0 = x0
    this.y0 = y0
    this.x1 = x1
    this.y1 = y1
  }

  private grow(): void {
    const capacity = this.body.length * 2
    const body = new Int32Array(capacity)
    body.set(this.body)
    this.body = body
    const chain = new Int32Array(capacity)
    chain.set(this.chain)
    this.chain = chain
    const quad = new Int32Array(capacity * 4).fill(NO_CELL)
    quad.set(this.quad)
    this.quad = quad
    const px = new Float64Array(capacity)
    px.set(this.px)
    this.px = px
    const py = new Float64Array(capacity)
    py.set(this.py)
    this.py = py
  }

  private newCell(body: number, px: number, py: number): number {
    if (this.size === this.body.length) this.grow()
    const cell = this.size++
    this.body[cell] = body
    this.chain[cell] = NO_CELL
    this.px[cell] = px
    this.py[cell] = py
    return cell
  }

  private replace(parent: number, slot: number, cell: number): void {
    if (parent === NO_CELL) this.root = cell
    else this.quad[parent * 4 + slot] = cell
  }

  private insert(body: number, px: number, py: number): void {
    const leaf = this.newCell(body, px, py)
    if (this.root === NO_CELL) { this.root = leaf; this.maxDepth = Math.max(this.maxDepth, 1); return }
    let x0 = this.x0
    let y0 = this.y0
    let x1 = this.x1
    let y1 = this.y1
    let parent = NO_CELL
    let slot = 0
    let cell = this.root
    let depth = 1
    // down to the first empty slot, or to the leaf in the way
    while (this.body[cell]! < 0) {
      const xm = (x0 + x1) / 2
      const ym = (y0 + y1) / 2
      const right = px >= xm
      const bottom = py >= ym
      if (right) x0 = xm; else x1 = xm
      if (bottom) y0 = ym; else y1 = ym
      parent = cell
      slot = (bottom ? 2 : 0) | (right ? 1 : 0)
      const below = this.quad[parent * 4 + slot]!
      ++depth
      if (below === NO_CELL) { this.quad[parent * 4 + slot] = leaf; this.maxDepth = Math.max(this.maxDepth, depth); return }
      cell = below
    }
    if (px === this.px[cell] && py === this.py[cell]) {
      this.chain[leaf] = cell
      this.replace(parent, slot, leaf)
      this.maxDepth = Math.max(this.maxDepth, depth)
      return
    }
    // split the leaf's square until the old point and the new one fall in different quadrants
    const oldX = this.px[cell]!
    const oldY = this.py[cell]!
    let oldSlot: number
    let newSlot: number
    for (let splits = 0; ; ++splits) {
      const branch = this.newCell(-1, NaN, NaN)
      this.replace(parent, slot, branch)
      parent = branch
      ++depth
      const xm = (x0 + x1) / 2
      const ym = (y0 + y1) / 2
      const right = px >= xm
      const bottom = py >= ym
      if (right) x0 = xm; else x1 = xm
      if (bottom) y0 = ym; else y1 = ym
      newSlot = (bottom ? 2 : 0) | (right ? 1 : 0)
      oldSlot = (oldY >= ym ? 2 : 0) | (oldX >= xm ? 1 : 0)
      if (newSlot !== oldSlot) break
      if (splits >= MAX_SPLITS) { // indistinguishable at this scale: chain, as coincident points are
        this.chain[leaf] = cell
        this.quad[parent * 4 + newSlot] = leaf
        this.maxDepth = Math.max(this.maxDepth, depth + 1)
        return
      }
      slot = newSlot
    }
    this.quad[parent * 4 + oldSlot] = cell
    this.quad[parent * 4 + newSlot] = leaf
    this.maxDepth = Math.max(this.maxDepth, depth + 1)
  }

  /**
   * Pre-order walk with each cell's square. A visit returning true skips that cell's quadrants; quadrants are visited
   * in order 0..3.
   */
  walk(visit: (cell: number, x0: number, y0: number, x1: number, y1: number) => boolean | void): void {
    if (this.root === NO_CELL) return
    const quad = this.quad
    const body = this.body
    // (the stacks are kept: a force walks the same tree once per body)
    if (!this.cells) {
      const room = 3 * this.maxDepth + 8
      this.cells = new Int32Array(room)
      this.boxes = new Float64Array(room * 4)
    }
    const cells = this.cells
    const boxes = this.boxes!
    cells[0] = this.root
    boxes[0] = this.x0
    boxes[1] = this.y0
    boxes[2] = this.x1
    boxes[3] = this.y1
    let top = 1
    while (top > 0) {
      --top
      const cell = cells[top]!
      const b = top * 4
      const x0 = boxes[b]!
      const y0 = boxes[b + 1]!
      const x1 = boxes[b + 2]!
      const y1 = boxes[b + 3]!
      if (visit(cell, x0, y0, x1, y1) || body[cell]! >= 0) continue
      const xm = (x0 + x1) / 2
      const ym = (y0 + y1) / 2
      const q = cell * 4
      let c: number
      // (pushed last to first, so that quadrant 0 is visited first)
      if ((c = quad[q + 3]!) !== NO_CELL) { cells[top] = c; b4(boxes, top, xm, ym, x1, y1); ++top }
      if ((c = quad[q + 2]!) !== NO_CELL) { cells[top] = c; b4(boxes, top, x0, ym, xm, y1); ++top }
      if ((c = quad[q + 1]!) !== NO_CELL) { cells[top] = c; b4(boxes, top, xm, y0, x1, ym); ++top }
      if ((c = quad[q]!) !== NO_CELL) { cells[top] = c; b4(boxes, top, x0, y0, xm, ym); ++top }
    }
  }

  /** Walk every cell after all of its quadrants (the quadrants themselves in no particular order). */
  walkUp(visit: (cell: number) => void): void {
    if (this.root === NO_CELL) return
    const quad = this.quad
    const body = this.body
    // a pre-order list, replayed backwards: a parent precedes its quadrants in it, so follows them in the replay
    const order = new Int32Array(this.size)
    const stack = new Int32Array(3 * this.maxDepth + 8)
    let count = 0
    let top = 0
    stack[top++] = this.root
    while (top > 0) {
      const cell = stack[--top]!
      order[count++] = cell
      if (body[cell]! >= 0) continue
      for (let k = 0; k < 4; ++k) {
        const c = quad[cell * 4 + k]!
        if (c !== NO_CELL) stack[top++] = c
      }
    }
    while (count > 0) visit(order[--count]!)
  }
}

/** A tree over `bodies`, each at the point (`xOf(body)`, `yOf(body)`) it has now. */
export function buildQuadTree<B>(bodies: readonly B[], xOf: (b: B) => number, yOf: (b: B) => number): QuadTree {
  const n = bodies.length
  const xs = new Float64Array(n)
  const ys = new Float64Array(n)
  for (let i = 0; i < n; ++i) {
    xs[i] = +xOf(bodies[i]!)
    ys[i] = +yOf(bodies[i]!)
  }
  return new QuadTree(xs, ys)
}
