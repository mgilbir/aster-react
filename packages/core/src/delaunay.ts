/**
 * Delaunay triangulation of a point set by a radial sweep: start from the triangle formed by the point nearest the
 * centre, its nearest neighbour and the point giving the smallest circumcircle with them; add the other points in order
 * of distance from that triangle's circumcentre, each joined to the convex hull edges it can see, then repair the
 * Delaunay condition by flipping edges. This is the algorithm of the delaunator library, and for the Voronoi diagrams
 * built on it the result has to be the same triangulation, not just an equivalent one: which of several equally good
 * triangulations is chosen (cocircular points, repeated points, ties in distance) decides the vertex at which every cell
 * starts. So the choices that decide ties are fixed here and are not free to change: the seed rules, the order of
 * insertion (the sort below is not stable, and its tie order matters), the skipping of points within 2^-52 of the
 * previous one, the hash used to find a visible hull edge, and the cap on the flip stack.
 *
 * The triangulation is exposed as flat typed arrays: `triangles[3t..3t+2]` are the corners of triangle `t`
 * counter-clockwise, and `halfedges[e]` is the half-edge opposite half-edge `e` (`-1` on the hull). Half-edge `3t + k`
 * runs from corner `k` to corner `k + 1` of triangle `t`.
 */
import { orientation } from './orient.js'

export interface Triangulation {
  triangles: Uint32Array
  halfedges: Int32Array
  /** Hull vertices, counter-clockwise. For collinear input: the distinct points in order along the line, no triangles. */
  hull: Uint32Array
}

const NEAR_DUPLICATE = 2 ** -52
/** Deepest flip stack kept; a flip beyond it is dropped (only degenerate input gets near it). */
const FLIP_STACK_SIZE = 512
const flipStack = new Uint32Array(FLIP_STACK_SIZE)

const distance2 = (ax: number, ay: number, bx: number, by: number): number => (ax - bx) * (ax - bx) + (ay - by) * (ay - by)

/** An increasing function of the angle of (dx, dy) in [0, 1], without trigonometry. */
function angleKey(dx: number, dy: number): number {
  const p = dx / (Math.abs(dx) + Math.abs(dy))
  return (dy > 0 ? 3 - p : 1 + p) / 4
}

/** Squared circumradius of a, b, c (Infinity-ish or NaN when they are collinear). */
function circumradius2(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  const dx = bx - ax
  const dy = by - ay
  const ex = cx - ax
  const ey = cy - ay
  const bl = dx * dx + dy * dy
  const cl = ex * ex + ey * ey
  const d = 0.5 / (dx * ey - dy * ex)
  const x = (ey * bl - dy * cl) * d
  const y = (dx * cl - ex * bl) * d
  return x * x + y * y
}

/** Is p strictly inside the circle through a, b, c (counter-clockwise)? A plain floating point test, as the sweep needs. */
function insideCircle(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, px: number, py: number): boolean {
  const dx = ax - px
  const dy = ay - py
  const ex = bx - px
  const ey = by - py
  const fx = cx - px
  const fy = cy - py
  const ap = dx * dx + dy * dy
  const bp = ex * ex + ey * ey
  const cp = fx * fx + fy * fy
  return dx * (ey * cp - bp * fy) - dy * (ex * cp - bp * fx) + ap * (ex * fy - ey * fx) < 0
}

/** Sort `order` (point indices) by `keys[index]` in place, ascending; ties end in the order this procedure leaves them. */
function sortByKey(order: Uint32Array, keys: Float64Array, lo: number, hi: number): void {
  while (hi - lo > 20) {
    const mid = (lo + hi) >> 1
    let i = lo + 1
    let j = hi
    swap(order, mid, i)
    if (keys[order[lo]!]! > keys[order[hi]!]!) swap(order, lo, hi)
    if (keys[order[i]!]! > keys[order[hi]!]!) swap(order, i, hi)
    if (keys[order[lo]!]! > keys[order[i]!]!) swap(order, lo, i)
    const pivot = order[i]!
    const pivotKey = keys[pivot]!
    for (;;) {
      do i++
      while (keys[order[i]!]! < pivotKey)
      do j--
      while (keys[order[j]!]! > pivotKey)
      if (j < i) break
      swap(order, i, j)
    }
    order[lo + 1] = order[j]!
    order[j] = pivot
    // recurse into the smaller part, loop on the larger
    if (hi - i + 1 >= j - lo) {
      sortByKey(order, keys, i, hi)
      hi = j - 1
    } else {
      sortByKey(order, keys, lo, j - 1)
      lo = i
    }
  }
  for (let i = lo + 1; i <= hi; i++) {
    const item = order[i]!
    const key = keys[item]!
    let j = i - 1
    while (j >= lo && keys[order[j]!]! > key) {
      order[j + 1] = order[j]!
      j--
    }
    order[j + 1] = item
  }
}

function swap(a: Uint32Array, i: number, j: number): void {
  const t = a[i]!
  a[i] = a[j]!
  a[j] = t
}

/** Points on one line (or all equal): their distinct members in order along it, as a degenerate hull. */
function collinearHull(coords: Float64Array, order: Uint32Array, keys: Float64Array): Triangulation {
  const n = order.length
  for (let i = 0; i < n; i++) keys[i] = coords[2 * i]! - coords[0]! || coords[2 * i + 1]! - coords[1]!
  sortByKey(order, keys, 0, n - 1)
  const hull = new Uint32Array(n)
  let size = 0
  for (let i = 0, last = -Infinity; i < n; i++) {
    const id = order[i]!
    if (keys[id]! > last) {
      hull[size++] = id
      last = keys[id]!
    }
  }
  return { triangles: new Uint32Array(0), halfedges: new Int32Array(0), hull: hull.subarray(0, size) }
}

/** `coords` is `[x0, y0, x1, y1, ...]`. */
export function triangulate(coords: Float64Array): Triangulation {
  const n = coords.length >> 1
  const order = new Uint32Array(n)
  const keys = new Float64Array(n)

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (let i = 0; i < n; i++) {
    const x = coords[2 * i]!
    const y = coords[2 * i + 1]!
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
    order[i] = i
  }
  const midX = (minX + maxX) / 2
  const midY = (minY + maxY) / 2

  // seed triangle: the point nearest the middle, its nearest other point, and the third point that gives the smallest circle
  let s0 = 0
  let s1 = 0
  let s2 = 0
  for (let i = 0, best = Infinity; i < n; i++) {
    const d = distance2(midX, midY, coords[2 * i]!, coords[2 * i + 1]!)
    if (d < best) {
      s0 = i
      best = d
    }
  }
  const s0x = coords[2 * s0]!
  const s0y = coords[2 * s0 + 1]!
  for (let i = 0, best = Infinity; i < n; i++) {
    if (i === s0) continue
    const d = distance2(s0x, s0y, coords[2 * i]!, coords[2 * i + 1]!)
    if (d < best && d > 0) {
      s1 = i
      best = d
    }
  }
  let s1x = coords[2 * s1]!
  let s1y = coords[2 * s1 + 1]!
  let smallest = Infinity
  for (let i = 0; i < n; i++) {
    if (i === s0 || i === s1) continue
    const r = circumradius2(s0x, s0y, s1x, s1y, coords[2 * i]!, coords[2 * i + 1]!)
    if (r < smallest) {
      s2 = i
      smallest = r
    }
  }
  let s2x = coords[2 * s2]!
  let s2y = coords[2 * s2 + 1]!
  if (smallest === Infinity) return collinearHull(coords, order, keys)

  if (orientation(s0x, s0y, s1x, s1y, s2x, s2y) < 0) {
    ;[s1, s2] = [s2, s1]
    ;[s1x, s2x] = [s2x, s1x]
    ;[s1y, s2y] = [s2y, s1y]
  }

  // the circumcentre of the seed triangle: the sweep's centre
  const dx = s1x - s0x
  const dy = s1y - s0y
  const ex = s2x - s0x
  const ey = s2y - s0y
  const bl = dx * dx + dy * dy
  const cl = ex * ex + ey * ey
  const inv = 0.5 / (dx * ey - dy * ex)
  const centerX = s0x + (ey * bl - dy * cl) * inv
  const centerY = s0y + (dx * cl - ex * bl) * inv
  for (let i = 0; i < n; i++) keys[i] = distance2(coords[2 * i]!, coords[2 * i + 1]!, centerX, centerY)
  sortByKey(order, keys, 0, n - 1)

  const maxTriangles = Math.max(2 * n - 5, 0)
  const triangles = new Uint32Array(maxTriangles * 3)
  const halfedges = new Int32Array(maxTriangles * 3)
  let used = 0

  /** Pair half-edges `a` and `b` (either may be -1: no neighbour). */
  const link = (a: number, b: number): void => {
    halfedges[a] = b
    if (b !== -1) halfedges[b] = a
  }
  const addTriangle = (i0: number, i1: number, i2: number, a: number, b: number, c: number): number => {
    const t = used
    triangles[t] = i0
    triangles[t + 1] = i1
    triangles[t + 2] = i2
    link(t, a)
    link(t + 1, b)
    link(t + 2, c)
    used += 3
    return t
  }

  // the advancing hull: a ring of points, with the half-edge of the triangle beside each hull edge, and a table that
  // finds a hull point by the angle around the centre
  const next = new Uint32Array(n)
  const prev = new Uint32Array(n)
  const hullEdge = new Uint32Array(n)
  const slots = Math.ceil(Math.sqrt(n))
  const byAngle = new Int32Array(slots).fill(-1)
  const slotOf = (x: number, y: number): number => Math.floor(angleKey(x - centerX, y - centerY) * slots) % slots
  let hullStart = s0
  let hullSize = 3

  next[s0] = prev[s2] = s1
  next[s1] = prev[s0] = s2
  next[s2] = prev[s1] = s0
  hullEdge[s0] = 0
  hullEdge[s1] = 1
  hullEdge[s2] = 2
  byAngle[slotOf(s0x, s0y)] = s0
  byAngle[slotOf(s1x, s1y)] = s1
  byAngle[slotOf(s2x, s2y)] = s2
  addTriangle(s0, s1, s2, -1, -1, -1)

  /** Flip edges around half-edge `start` until all satisfy the Delaunay condition; returns the half-edge to carry on from. */
  const legalize = (start: number): number => {
    let a = start
    let depth = 0
    let ar = 0
    for (;;) {
      const b = halfedges[a]!
      const a0 = a - (a % 3)
      ar = a0 + ((a + 2) % 3)
      if (b === -1) {
        if (depth === 0) break
        a = flipStack[--depth]!
        continue
      }
      const b0 = b - (b % 3)
      const al = a0 + ((a + 1) % 3)
      const bl = b0 + ((b + 2) % 3)
      const p0 = triangles[ar]!
      const pr = triangles[a]!
      const pl = triangles[al]!
      const p1 = triangles[bl]!
      if (
        insideCircle(coords[2 * p0]!, coords[2 * p0 + 1]!, coords[2 * pr]!, coords[2 * pr + 1]!, coords[2 * pl]!, coords[2 * pl + 1]!, coords[2 * p1]!, coords[2 * p1 + 1]!)
      ) {
        triangles[a] = p1
        triangles[b] = p0
        const outside = halfedges[bl]!
        if (outside === -1) {
          // the flipped edge lay on the hull: the hull must now point at `a`
          let e = hullStart
          do {
            if (hullEdge[e] === bl) {
              hullEdge[e] = a
              break
            }
            e = prev[e]!
          } while (e !== hullStart)
        }
        link(a, outside)
        link(b, halfedges[ar]!)
        link(ar, bl)
        if (depth < FLIP_STACK_SIZE) flipStack[depth++] = b0 + ((b + 1) % 3)
      } else {
        if (depth === 0) break
        a = flipStack[--depth]!
      }
    }
    return ar
  }

  for (let k = 0, lastX = 0, lastY = 0; k < n; k++) {
    const i = order[k]!
    const x = coords[2 * i]!
    const y = coords[2 * i + 1]!
    if (k > 0 && Math.abs(x - lastX) <= NEAR_DUPLICATE && Math.abs(y - lastY) <= NEAR_DUPLICATE) continue
    lastX = x
    lastY = y
    if (i === s0 || i === s1 || i === s2) continue

    // a hull point near this one's angle, then walk the hull to the first edge the point can see
    let start = 0
    for (let j = 0, slot = slotOf(x, y); j < slots; j++) {
      start = byAngle[(slot + j) % slots]!
      if (start !== -1 && start !== next[start]) break
    }
    start = prev[start]!
    let e = start
    let q: number
    // the hull is a ring of at most n points; coordinates that are not numbers can corrupt it, and a walk that has gone
    // round more than that is not going to end
    for (let steps = 0; ((q = next[e]!), orientation(x, y, coords[2 * e]!, coords[2 * e + 1]!, coords[2 * q]!, coords[2 * q + 1]!) >= 0); steps++) {
      e = q
      if (e === start || steps > n) {
        e = -1
        break
      }
    }
    if (e === -1) continue

    let t = addTriangle(e, i, next[e]!, -1, -1, hullEdge[e]!)
    hullEdge[i] = legalize(t + 2)
    hullEdge[e] = t
    hullSize++

    // extend over the hull edges further along that the point also sees
    let far = next[e]!
    for (let steps = 0; steps <= n && ((q = next[far]!), orientation(x, y, coords[2 * far]!, coords[2 * far + 1]!, coords[2 * q]!, coords[2 * q + 1]!) < 0); steps++) {
      t = addTriangle(far, i, q, hullEdge[i]!, -1, hullEdge[far]!)
      hullEdge[i] = legalize(t + 2)
      next[far] = far
      hullSize--
      far = q
    }
    // and backwards, when the first edge found was where the walk began
    if (e === start) {
      for (let steps = 0; steps <= n && ((q = prev[e]!), orientation(x, y, coords[2 * q]!, coords[2 * q + 1]!, coords[2 * e]!, coords[2 * e + 1]!) < 0); steps++) {
        t = addTriangle(q, i, e, -1, hullEdge[e]!, hullEdge[q]!)
        legalize(t + 2)
        hullEdge[q] = t
        next[e] = e
        hullSize--
        e = q
      }
    }

    hullStart = prev[i] = e
    next[e] = prev[far] = i
    next[i] = far
    byAngle[slotOf(x, y)] = i
    byAngle[slotOf(coords[2 * e]!, coords[2 * e + 1]!)] = e
  }

  const hull = new Uint32Array(hullSize)
  for (let i = 0, e = hullStart; i < hullSize; i++) {
    hull[i] = e
    e = next[e]!
  }
  return { triangles: triangles.subarray(0, used), halfedges: halfedges.subarray(0, used), hull }
}
