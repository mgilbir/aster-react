/**
 * A point quadtree over bodies that move between builds, for the force layouts' Barnes-Hut and collision queries.
 *
 * Observable behaviour fixed here, because the forces' float sums follow the tree:
 *  - the root square starts at the integer corner of the lowest point and doubles until it covers the highest one;
 *  - a body descends by the midpoints `(lo + hi) / 2` of its square, `>=` going to the upper or right half;
 *  - a body exactly on an existing body's point is chained in front of it (newest first), not split;
 *  - quadrants are numbered `bottom * 2 + right`, and queries visit them in that order.
 */

/** One cell: a leaf holding a body (and the bodies chained behind it), or a branch of four quadrants. */
export class Cell<B> {
  /** The leaf's body (the head of its chain); null on a branch. */
  body: B | null
  /** The leaf's point. */
  readonly px: number
  readonly py: number
  /** The next leaf at exactly the same point. */
  next: Cell<B> | null = null
  /** A branch's quadrants; null on a leaf. */
  quads: Array<Cell<B> | null> | null = null
  /** Per-cell scratch for the force that builds the tree (a radius, or a mass and its centre). */
  radius = 0
  mass = 0
  cx = 0
  cy = 0

  constructor(body: B | null, px: number, py: number) {
    this.body = body
    this.px = px
    this.py = py
  }
}

/** Past this many nested splits two points cannot be told apart (a double has about 1100 halvings): chain them instead. */
const MAX_SPLITS = 2048

export class QuadTree<B> {
  root: Cell<B> | null = null
  private x0 = NaN
  private y0 = NaN
  private x1 = NaN
  private y1 = NaN

  /**
   * Bodies whose point is not finite are left out (a NaN point never enters; an infinite one would keep the root from
   * ever covering it).
   */
  constructor(bodies: readonly B[], xOf: (b: B) => number, yOf: (b: B) => number) {
    const n = bodies.length
    const xs = new Float64Array(n)
    const ys = new Float64Array(n)
    const live = new Uint8Array(n)
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (let i = 0; i < n; ++i) {
      const x = +xOf(bodies[i]!)
      const y = +yOf(bodies[i]!)
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue
      xs[i] = x
      ys[i] = y
      live[i] = 1
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
    if (minX > maxX) return
    this.cover(minX, minY, maxX, maxY)
    for (let i = 0; i < n; ++i) if (live[i]) this.insert(xs[i]!, ys[i]!, bodies[i]!)
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

  private insert(px: number, py: number, body: B): void {
    const leaf = new Cell<B>(body, px, py)
    if (!this.root) { this.root = leaf; return }
    let x0 = this.x0
    let y0 = this.y0
    let x1 = this.x1
    let y1 = this.y1
    let parent: Cell<B> | null = null
    let slot = 0
    let cell: Cell<B> = this.root
    // down to the first empty slot, or to the leaf in the way
    while (cell.quads) {
      const xm = (x0 + x1) / 2
      const ym = (y0 + y1) / 2
      const right = px >= xm
      const bottom = py >= ym
      if (right) x0 = xm; else x1 = xm
      if (bottom) y0 = ym; else y1 = ym
      parent = cell
      slot = (bottom ? 2 : 0) | (right ? 1 : 0)
      const below = cell.quads[slot]
      if (!below) { cell.quads[slot] = leaf; return }
      cell = below
    }
    if (px === cell.px && py === cell.py) {
      leaf.next = cell
      this.replace(parent, slot, leaf)
      return
    }
    // split the leaf's square until the old point and the new one fall in different quadrants
    let oldSlot: number
    let newSlot: number
    for (let splits = 0; ; ++splits) {
      const branch = new Cell<B>(null, NaN, NaN)
      branch.quads = [null, null, null, null]
      this.replace(parent, slot, branch)
      parent = branch
      const xm = (x0 + x1) / 2
      const ym = (y0 + y1) / 2
      const right = px >= xm
      const bottom = py >= ym
      if (right) x0 = xm; else x1 = xm
      if (bottom) y0 = ym; else y1 = ym
      newSlot = (bottom ? 2 : 0) | (right ? 1 : 0)
      oldSlot = (cell.py >= ym ? 2 : 0) | (cell.px >= xm ? 1 : 0)
      if (newSlot !== oldSlot) break
      if (splits >= MAX_SPLITS) { // indistinguishable at this scale: chain, as coincident points are
        leaf.next = cell
        branch.quads[newSlot] = leaf
        return
      }
      slot = newSlot
    }
    parent.quads![oldSlot] = cell
    parent.quads![newSlot] = leaf
  }

  private replace(parent: Cell<B> | null, slot: number, cell: Cell<B>): void {
    if (parent) parent.quads![slot] = cell
    else this.root = cell
  }

  /**
   * Pre-order walk with each cell's square. A visit returning true skips that cell's quadrants; quadrants are visited
   * in order 0..3.
   */
  walk(visit: (cell: Cell<B>, x0: number, y0: number, x1: number, y1: number) => boolean | void): void {
    if (!this.root) return
    const cells: Cell<B>[] = [this.root]
    const boxes: number[] = [this.x0, this.y0, this.x1, this.y1]
    while (cells.length) {
      const cell = cells.pop()!
      const n = boxes.length - 4
      const x0 = boxes[n]!
      const y0 = boxes[n + 1]!
      const x1 = boxes[n + 2]!
      const y1 = boxes[n + 3]!
      boxes.length = n
      if (visit(cell, x0, y0, x1, y1) || !cell.quads) continue
      const xm = (x0 + x1) / 2
      const ym = (y0 + y1) / 2
      const q = cell.quads
      let c: Cell<B> | null
      if (c = q[3]!) { cells.push(c); boxes.push(xm, ym, x1, y1) }
      if (c = q[2]!) { cells.push(c); boxes.push(x0, ym, xm, y1) }
      if (c = q[1]!) { cells.push(c); boxes.push(xm, y0, x1, ym) }
      if (c = q[0]!) { cells.push(c); boxes.push(x0, y0, xm, ym) }
    }
  }

  /** Post-order walk: every cell after all of its quadrants. */
  walkUp(visit: (cell: Cell<B>) => void): void {
    if (!this.root) return
    const stack: Cell<B>[] = [this.root]
    const done: Cell<B>[] = []
    let cell: Cell<B> | undefined
    while ((cell = stack.pop())) {
      done.push(cell)
      if (cell.quads) for (const c of cell.quads) if (c) stack.push(c)
    }
    while ((cell = done.pop())) visit(cell)
  }
}
