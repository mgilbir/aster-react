/**
 * Contour polygons of a raster grid: the level sets that `contour` and `isocontour` publish as GeoJSON
 * MultiPolygons, found by marching squares. The grid is classified against a level one row at a time, every
 * cell's four corners pick a pair of edge midpoints to join, the segments are stitched into closed rings, and rings
 * are sorted into outer boundaries (positive area) and holes. The method is the classic one that d3-contour
 * implements; the code here is Aster's own, and the d3-contour 4.0.2 differential in `conformance/scripts` pins it.
 * It follows that algorithm closely enough to count as derived from it: d3-contour (ISC, Mike Bostock) stays in
 * THIRD_PARTY_NOTICES.md.
 *
 * What the output pins, and so what is not free to change:
 *  - the cells are visited row by row from (-1, -1), and a cell's segments are stitched in table order: the order
 *    in which fragments meet decides which end of a ring is its first point, and so every ring's coordinates;
 *  - a ring closes on a copy of its first point; the smoothing moves a point along a grid line by linear
 *    interpolation between the two cell values that straddle the level, in a fixed operation order;
 *  - thresholds are visited in ascending order whatever order they are given in;
 *  - a missing cell (null, undefined, NaN) lies below every level, except the first cell of the last row, which is
 *    tested as a plain JavaScript comparison (null counts as 0 there); a grid containing nulls reaches that
 *    difference, so it is kept.
 */

export type ContourMultiPolygon = {
  type: 'MultiPolygon'
  value: number
  coordinates: number[][][][]
}

type Point = number[]
type Ring = Point[]

/**
 * The segment joining two edge midpoints of a cell, for each of the 16 corner patterns (bit 3 top left, bit 2 top
 * right, bit 1 bottom right, bit 0 bottom left; set = at or above the level). T, R, B, L are the midpoints of the
 * cell's top, right, bottom and left edges; a segment runs from its first to its second letter, which keeps the
 * region above the level on one side of every segment (the ring orientation).
 */
const CELL_SEGMENTS = ['', 'BL', 'RB', 'RL', 'TR', 'BL TR', 'TB', 'TL', 'LT', 'BT', 'LT RB', 'RT', 'LR', 'BR', 'LB', '']

/** Edge midpoints in half-cell units, from the cell's top left corner at (1, 1)... (the cell is [0.5, 1.5]^2). */
const MIDPOINT: Record<string, readonly [number, number]> = { T: [2, 1], R: [3, 2], B: [2, 3], L: [1, 2] }

/** Per pattern, the segments as flat [x0, y0, x1, y1, ...] in half-cell units. */
const SEGMENTS: number[][] = CELL_SEGMENTS.map((pattern) =>
  pattern === '' ? [] : pattern.split(' ').flatMap(([from, to]) => [...MIDPOINT[from!]!, ...MIDPOINT[to!]!]),
)

interface Fragment {
  /** Keys of the ring's first and last point. */
  start: number
  end: number
  ring: Ring
}

/**
 * Joins cell segments into rings. The returned function takes a cell's position and corner pattern; each ring is
 * handed to `emit` once it closes. Half-cell coordinates run from -1 to 2 * columns + 1, so a point's key is its
 * position in that lattice.
 */
function ringStitcher(columns: number, emit: (ring: Ring) => void): (x: number, y: number, pattern: number) => void {
  const rowKeys = 2 * columns + 3
  const byStart = new Map<number, Fragment>()
  const byEnd = new Map<number, Fragment>()

  return (x, y, pattern) => {
    const segments = SEGMENTS[pattern]!
    for (let s = 0; s < segments.length; s += 4) {
      const sx = segments[s]!
      const sy = segments[s + 1]!
      const ex = segments[s + 2]!
      const ey = segments[s + 3]!
      const start: Point = [x + sx * 0.5, y + sy * 0.5]
      const end: Point = [x + ex * 0.5, y + ey * 0.5]
      const startKey = 2 * x + sx + 1 + (2 * y + sy + 1) * rowKeys
      const endKey = 2 * x + ex + 1 + (2 * y + ey + 1) * rowKeys

      const before = byEnd.get(startKey)
      if (before) {
        // The segment continues a ring; it may also be what the ring that starts at its end was waiting for.
        const after = byStart.get(endKey)
        byEnd.delete(before.end)
        if (after) {
          byStart.delete(after.start)
          if (before === after) {
            before.ring.push(end)
            emit(before.ring)
          } else {
            const joined = { start: before.start, end: after.end, ring: before.ring.concat(after.ring) }
            byStart.set(joined.start, joined)
            byEnd.set(joined.end, joined)
          }
        } else {
          before.ring.push(end)
          before.end = endKey
          byEnd.set(endKey, before)
        }
        continue
      }
      const ahead = byStart.get(endKey)
      if (ahead) {
        byStart.delete(ahead.start)
        ahead.ring.unshift(start)
        ahead.start = startKey
        byStart.set(startKey, ahead)
      } else {
        const fragment = { start: startKey, end: endKey, ring: [start, end] }
        byStart.set(startKey, fragment)
        byEnd.set(endKey, fragment)
      }
    }
  }
}

/** Twice the signed area of a ring (positive: an outer boundary). */
function signedArea(ring: Ring): number {
  const n = ring.length
  let area = ring[n - 1]![1]! * ring[0]![0]! - ring[n - 1]![0]! * ring[0]![1]!
  for (let i = 1; i < n; i++) area += ring[i - 1]![1]! * ring[i]![0]! - ring[i - 1]![0]! * ring[i]![1]!
  return area
}

/** Whether `p` lies on the segment a-b. */
function onSegment(a: Point, b: Point, p: Point): boolean {
  if ((b[0]! - a[0]!) * (p[1]! - a[1]!) !== (p[0]! - a[0]!) * (b[1]! - a[1]!)) return false
  const axis = a[0] === b[0] ? 1 : 0
  const lo = a[axis]!
  const mid = p[axis]!
  const hi = b[axis]!
  return (lo <= mid && mid <= hi) || (hi <= mid && mid <= lo)
}

/** Where a point lies against a ring: 1 inside, 0 on the boundary, -1 outside. */
function sideOf(ring: Ring, p: Point): number {
  const x = p[0]!
  const y = p[1]!
  let side = -1
  for (let i = 0, n = ring.length, j = n - 1; i < n; j = i++) {
    const pi = ring[i]!
    const pj = ring[j]!
    if (onSegment(pi, pj, p)) return 0
    const xi = pi[0]!
    const yi = pi[1]!
    const xj = pj[0]!
    const yj = pj[1]!
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) side = -side
  }
  return side
}

/** Whether a hole belongs to a ring: the first of its points that is not on the boundary decides. */
function holeInside(outer: Ring, hole: Ring): boolean {
  for (const p of hole) {
    const side = sideOf(outer, p)
    if (side !== 0) return side !== -1
  }
  return true
}

/** A cell value as a number, a missing one as -Infinity. */
function numberOrLowest(v: unknown): number {
  if (v == null) return -Infinity
  const n = +(v as number)
  return n !== n ? -Infinity : n
}

/** Where, between two cells, the level falls: the offset of a boundary point from the lattice line it sits on. */
function crossing(at: number, below: number, above: number, level: number): number {
  const a = level - below
  const b = above - below
  const d = isFinite(a) || isFinite(b) ? a / b : Math.sign(a) / Math.sign(b)
  return d !== d ? at : at + d - 0.5
}

/** Moves each point that sits on a grid line to where the level crosses between the two cells it separates. */
function smoothRing(ring: Ring, values: ArrayLike<unknown>, stride: number, height: number, level: number): void {
  for (const point of ring) {
    const x = point[0]!
    const y = point[1]!
    const xt = x | 0
    const yt = y | 0
    const here = numberOrLowest(values[yt * stride + xt])
    if (x > 0 && x < stride && xt === x) point[0] = crossing(x, numberOrLowest(values[yt * stride + xt - 1]), here, level)
    if (y > 0 && y < height && yt === y) point[1] = crossing(y, numberOrLowest(values[(yt - 1) * stride + xt]), here, level)
  }
}

function polygonsAt(values: ArrayLike<unknown>, level: number, stride: number, height: number, smooth: boolean): number[][][][] {
  // The scan covers at least one column and one row of corners; the row stride stays the true width.
  const columns = Math.max(stride, 1)
  const rows = Math.max(height, 1)
  const outers: Ring[][] = []
  const holes: Ring[] = []
  const stitch = ringStitcher(columns, (ring) => {
    if (smooth) smoothRing(ring, values, stride, height, level)
    if (signedArea(ring) > 0) outers.push([ring])
    else holes.push(ring)
  })

  // Corner rows, padded by one outside column on each side: entry c + 1 is column c, and outside reads as below.
  let upper = new Uint8Array(columns + 2)
  let lower = new Uint8Array(columns + 2)
  for (let y = -1; y < rows; y++) {
    if (y + 1 < rows) {
      for (let c = 0, at = (y + 1) * stride; c < columns; c++) {
        const v = values[at + c]
        lower[c + 1] = v != null && +(v as number) >= level ? 1 : 0
      }
    } else lower.fill(0)
    // The first corner of the last row is compared as it stands (null reads as 0), in both cells that share it.
    if (y === rows - 1) upper[1] = +((values[y * stride] as number) >= level)
    for (let x = -1; x < columns; x++) stitch(x, y, (upper[x + 1]! << 3) | (upper[x + 2]! << 2) | (lower[x + 2]! << 1) | lower[x + 1]!)
    ;[upper, lower] = [lower, upper]
  }

  for (const hole of holes) {
    const owner = outers.find((polygon) => holeInside(polygon[0]!, hole))
    if (owner) owner.push(hole)
  }
  return outers
}

/**
 * The contour polygons of `values` (a `size[0]` by `size[1]` grid, row-major) at each threshold, in ascending
 * threshold order. Throws `invalid size` for a negative or NaN size and `invalid value: <v>` for a threshold that
 * is not a number.
 */
export function contourPolygons(
  values: ArrayLike<unknown>,
  thresholds: ArrayLike<number>,
  size: readonly [number, number],
  smooth: boolean,
): ContourMultiPolygon[] {
  const width = Math.floor(size[0])
  const height = Math.floor(size[1])
  if (!(width >= 0 && height >= 0)) throw new Error('invalid size')
  return Array.from(thresholds)
    .sort((a, b) => a - b)
    .map((value) => {
      const level = value == null ? NaN : +value
      if (isNaN(level)) throw new Error(`invalid value: ${value}`)
      return { type: 'MultiPolygon', value, coordinates: polygonsAt(values, level, width, height, smooth) }
    })
}
