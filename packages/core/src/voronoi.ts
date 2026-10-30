/**
 * Voronoi diagrams clipped to a rectangle, built on the Delaunay triangulation of `delaunay.ts`.
 *
 * A cell is the region closer to its point than to any other. In the dual of the triangulation, the corners of a point's
 * cell are the circumcentres of the triangles around it, taken in order. Cells of points on the hull are unbounded:
 * they are closed with rays that leave the first and last corner perpendicular to the hull edges, and then every cell
 * is clipped to the rectangle, adding the rectangle's corners where a cell's boundary runs along its edge.
 *
 * What is fixed by the output (the paths of the `voronoi` transform must equal the reference diagram's, character for
 * character) and so not free to restructure: the arithmetic of circumcentres, ray directions and intersections, the
 * order in which a cell's corners are produced and where the polygon starts, the 1e-9 threshold under which a triangle
 * is treated as degenerate (its circumcentre is sent 1e9 away from the hull's barycentre), the nudging of collinear
 * input, and the rules for 0, 1 and 2 distinct points.
 */
import { triangulate } from './delaunay.js'

export interface Rect {
  xmin: number
  ymin: number
  xmax: number
  ymax: number
}

/** A triangulation with the lookups cells need. */
interface Mesh {
  points: Float64Array
  triangles: ArrayLike<number>
  halfedges: Int32Array
  hull: Uint32Array
  /** for each point, one half-edge arriving at it (one on the hull when it has any); -1 for a point with no triangle */
  incoming: Int32Array
  /** for each hull point, its position in `hull`; -1 elsewhere */
  hullIndex: Int32Array
}

interface Diagram {
  mesh: Mesh
  rect: Rect
  /** circumcentre of each triangle, x then y */
  centers: Float64Array
  /** per point, four numbers: the direction of the ray leaving the cell's first corner, then of the one leaving the last */
  rays: Float64Array
}

// Where a point lies relative to the rectangle: one bit per side it is beyond (region), or exactly on (edge).
const LEFT = 0b0001
const RIGHT = 0b0010
const TOP = 0b0100
const BOTTOM = 0b1000

const regionOf = (r: Rect, x: number, y: number): number =>
  (x < r.xmin ? LEFT : x > r.xmax ? RIGHT : 0) | (y < r.ymin ? TOP : y > r.ymax ? BOTTOM : 0)

const edgeOf = (r: Rect, x: number, y: number): number =>
  (x === r.xmin ? LEFT : x === r.xmax ? RIGHT : 0) | (y === r.ymin ? TOP : y === r.ymax ? BOTTOM : 0)

// -- the triangulation and its lookups --------------------------------------------------------------------------------

/** Is every triangle flat (area at most 1e-10)? Then the points are on a line as far as cells are concerned. */
function allFlat(points: Float64Array, triangles: ArrayLike<number>): boolean {
  for (let t = 0; t < triangles.length; t += 3) {
    const a = 2 * triangles[t]!
    const b = 2 * triangles[t + 1]!
    const c = 2 * triangles[t + 2]!
    const cross = (points[c]! - points[a]!) * (points[b + 1]! - points[a + 1]!) - (points[b]! - points[a]!) * (points[c + 1]! - points[a + 1]!)
    if (cross > 1e-10) return false
  }
  return true
}

/**
 * Triangulate; points that lie on one line are first moved off it by a deterministic nudge, proportional to the line's
 * length, so that they still get a (thin) triangulation and cells. `points` is changed in that case.
 */
function connect(points: Float64Array): Mesh {
  const n = points.length >> 1
  let { triangles, halfedges, hull } = triangulate(points)
  if (hull.length > 2 && allFlat(points, triangles)) {
    const byPosition = Int32Array.from({ length: n }, (_, i) => i).sort((i, j) => points[2 * i]! - points[2 * j]! || points[2 * i + 1]! - points[2 * j + 1]!)
    const first = byPosition[0]!
    const last = byPosition[n - 1]!
    const nudge = 1e-8 * Math.hypot(points[2 * last + 1]! - points[2 * first + 1]!, points[2 * last]! - points[2 * first]!)
    for (let i = 0; i < n; i++) {
      const x = points[2 * i]!
      const y = points[2 * i + 1]!
      points[2 * i] = x + Math.sin(x + y) * nudge
      points[2 * i + 1] = y + Math.cos(x - y) * nudge
    }
    ;({ triangles, halfedges, hull } = triangulate(points))
  }

  const incoming = new Int32Array(n).fill(-1)
  const hullIndex = new Int32Array(n).fill(-1)
  for (let e = 0; e < halfedges.length; e++) {
    const p = triangles[e % 3 === 2 ? e - 2 : e + 1]!
    // a point on the hull keeps an outer half-edge, so its cell starts at the open side
    if (halfedges[e] === -1 || incoming[p] === -1) incoming[p] = e
  }
  for (let i = 0; i < hull.length; i++) hullIndex[hull[i]!] = i

  let tri: ArrayLike<number> = triangles
  let half = halfedges
  if (hull.length <= 2 && hull.length > 0) {
    // one or two distinct points: a single imaginary triangle that gives each of them an incoming half-edge
    const t = new Int32Array(3).fill(-1)
    half = new Int32Array(3).fill(-1)
    t[0] = hull[0]!
    incoming[hull[0]!] = 1
    if (hull.length === 2) {
      incoming[hull[1]!] = 0
      t[1] = hull[1]!
      t[2] = hull[1]!
    }
    tri = t
  }
  return { points, triangles: tri, halfedges: half, hull, incoming, hullIndex }
}

// -- the diagram ------------------------------------------------------------------------------------------------------

function buildDiagram(mesh: Mesh, rect: Rect): Diagram {
  const { points, triangles, hull } = mesh
  const centers = new Float64Array((triangles.length / 3) * 2)
  let hullCenterX: number | undefined
  let hullCenterY = 0

  for (let t = 0, c = 0; t < triangles.length; t += 3, c += 2) {
    const i1 = triangles[t]! * 2
    const i2 = triangles[t + 1]! * 2
    const i3 = triangles[t + 2]! * 2
    const x1 = points[i1]!
    const y1 = points[i1 + 1]!
    const dx = points[i2]! - x1
    const dy = points[i2 + 1]! - y1
    const ex = points[i3]! - x1
    const ey = points[i3 + 1]! - y1
    const twiceArea = (dx * ey - dy * ex) * 2
    if (Math.abs(twiceArea) < 1e-9) {
      // a flat triangle: its circumcentre is at infinity, on the side away from the hull's barycentre
      if (hullCenterX === undefined) {
        let sx = 0
        let sy = 0
        for (const h of hull) {
          sx += points[h * 2]!
          sy += points[h * 2 + 1]!
        }
        hullCenterX = sx / hull.length
        hullCenterY = sy / hull.length
      }
      const away = 1e9 * Math.sign((hullCenterX - x1) * ey - (hullCenterY - y1) * ex)
      centers[c] = (x1 + points[i3]!) / 2 - away * ey
      centers[c + 1] = (y1 + points[i3 + 1]!) / 2 + away * ex
    } else {
      const inv = 1 / twiceArea
      const bl = dx * dx + dy * dy
      const cl = ex * ex + ey * ey
      centers[c] = x1 + (ey * bl - dy * cl) * inv
      centers[c + 1] = y1 + (dx * cl - ex * bl) * inv
    }
  }

  // the ray directions of the unbounded cells: perpendicular to each hull edge, stored on both of its end points
  const rays = new Float64Array(points.length * 2)
  let h = hull[hull.length - 1]!
  let at = h * 4
  let x = points[2 * h]!
  let y = points[2 * h + 1]!
  for (let i = 0; i < hull.length; i++) {
    h = hull[i]!
    const from = at
    const fromX = x
    const fromY = y
    at = h * 4
    x = points[2 * h]!
    y = points[2 * h + 1]!
    rays[from + 2] = rays[at] = fromY - y
    rays[from + 3] = rays[at + 1] = x - fromX
  }
  return { mesh, rect, centers, rays }
}

/** Is `(x, y)` closer to point `i` than to the neighbours of its cell? (Step towards the nearest point from `i`.) */
function nearestStep(d: Diagram, i: number, x: number, y: number): number {
  const { incoming, hull, hullIndex, halfedges, triangles, points } = d.mesh
  if (incoming[i] === -1 || !points.length) return (i + 1) % (points.length >> 1)
  let best = i
  let bestDistance = Math.pow(x - points[i * 2]!, 2) + Math.pow(y - points[i * 2 + 1]!, 2)
  const first = incoming[i]!
  let e = first
  for (let steps = 0; steps <= halfedges.length; steps++) {
    const t = triangles[e]!
    const dt = Math.pow(x - points[t * 2]!, 2) + Math.pow(y - points[t * 2 + 1]!, 2)
    if (dt < bestDistance) {
      bestDistance = dt
      best = t
    }
    e = e % 3 === 2 ? e - 2 : e + 1
    if (triangles[e] !== i) break
    e = halfedges[e]!
    if (e === -1) {
      e = hull[(hullIndex[i]! + 1) % hull.length]!
      if (e !== t && Math.pow(x - points[e * 2]!, 2) + Math.pow(y - points[e * 2 + 1]!, 2) < bestDistance) return e
      break
    }
    if (e === first) break
  }
  return best
}

/** Does the cell of point `i` contain `(x, y)`? */
function cellContains(d: Diagram, i: number, x: number, y: number): boolean {
  if (Number.isNaN(x) || Number.isNaN(y)) return false
  return nearestStep(d, i, x, y) === i
}

/** The corners of point `i`'s cell before clipping: the circumcentres of the triangles around it, or null if it has none. */
function rawCorners(d: Diagram, i: number): number[] | null {
  const { incoming, halfedges, triangles } = d.mesh
  const first = incoming[i]!
  if (first === -1) return null
  const corners: number[] = []
  let e = first
  // a cell has at most one corner per half-edge; a mesh built from points that are not numbers can loop
  for (let steps = 0; steps <= halfedges.length; steps++) {
    const t = Math.floor(e / 3)
    corners.push(d.centers[t * 2]!, d.centers[t * 2 + 1]!)
    e = e % 3 === 2 ? e - 2 : e + 1
    if (triangles[e] !== i) break
    e = halfedges[e]!
    if (e === first || e === -1) break
  }
  return corners
}

/** The part of the segment inside the rectangle (given the region codes of its ends), or null if none. */
function clipSegment(r: Rect, x0: number, y0: number, x1: number, y1: number, c0: number, c1: number): [number, number, number, number] | null {
  // always work on the segment in one orientation, so the same segment clips the same way from either side
  const swapped = c0 < c1
  if (swapped) {
    ;[x0, y0, x1, y1, c0, c1] = [x1, y1, x0, y0, c1, c0]
  }
  for (;;) {
    if (c0 === 0 && c1 === 0) return swapped ? [x1, y1, x0, y0] : [x0, y0, x1, y1]
    if (c0 & c1) return null
    const c = c0 || c1
    let x: number
    let y: number
    if (c & BOTTOM) {
      x = x0 + ((x1 - x0) * (r.ymax - y0)) / (y1 - y0)
      y = r.ymax
    } else if (c & TOP) {
      x = x0 + ((x1 - x0) * (r.ymin - y0)) / (y1 - y0)
      y = r.ymin
    } else if (c & RIGHT) {
      y = y0 + ((y1 - y0) * (r.xmax - x0)) / (x1 - x0)
      x = r.xmax
    } else {
      y = y0 + ((y1 - y0) * (r.xmin - x0)) / (x1 - x0)
      x = r.xmin
    }
    if (c0) {
      x0 = x
      y0 = y
      c0 = regionOf(r, x0, y0)
    } else {
      x1 = x
      y1 = y
      c1 = regionOf(r, x1, y1)
    }
  }
}

/** Side and corner codes in the order a cell boundary follows the rectangle: top-left corner, top, top-right, right, ... */
const RING = [LEFT | TOP, TOP, RIGHT | TOP, RIGHT, RIGHT | BOTTOM, BOTTOM, LEFT | BOTTOM, LEFT]

/**
 * Where a clipped cell's boundary leaves the rectangle on edge `from` and re-enters on edge `to`, it follows the
 * rectangle: insert, at position `at` of `polygon`, the corners passed on the way that belong to the cell (moving on
 * from a side reaches that side's end corner: top to top-right, right to bottom-right, bottom to bottom-left, left to
 * top-left). Returns the position after the inserted corners. Codes that name no side or corner (a rectangle without
 * width or height has them) insert nothing.
 */
function addCorners(d: Diagram, i: number, from: number, to: number, polygon: number[], at: number): number {
  const r = d.rect
  let k = RING.indexOf(from)
  if (RING.indexOf(to) < 0) return at
  while (k >= 0 && RING[k] !== to) {
    if (k & 1) {
      const x = k < 4 ? r.xmax : r.xmin
      const y = k === 1 || k === 7 ? r.ymin : r.ymax
      if ((polygon[at] !== x || polygon[at + 1] !== y) && cellContains(d, i, x, y)) {
        polygon.splice(at, 0, x, y)
        at += 2
      }
    }
    k = (k + 1) % RING.length
  }
  return at
}

const WHOLE_RECT = (r: Rect): number[] => [r.xmax, r.ymin, r.xmax, r.ymax, r.xmin, r.ymax, r.xmin, r.ymin]

/** Clip a closed polygon of finite corners to the rectangle; null if nothing of it is inside. */
function clipClosed(d: Diagram, i: number, corners: number[]): number[] | null {
  const r = d.rect
  const n = corners.length
  let out: number[] | null = null
  let x1 = corners[n - 2]!
  let y1 = corners[n - 1]!
  let c1 = regionOf(r, x1, y1)
  let edge1 = 0
  for (let j = 0; j < n; j += 2) {
    const x0 = x1
    const y0 = y1
    const c0 = c1
    x1 = corners[j]!
    y1 = corners[j + 1]!
    c1 = regionOf(r, x1, y1)
    if (c0 === 0 && c1 === 0) {
      edge1 = 0
      if (out) out.push(x1, y1)
      else out = [x1, y1]
      continue
    }
    let edge0: number
    let enterX = 0
    let enterY = 0
    let leaveX: number
    let leaveY: number
    if (c0 === 0) {
      const s = clipSegment(r, x0, y0, x1, y1, c0, c1)
      if (s === null) continue
      leaveX = s[2]
      leaveY = s[3]
    } else {
      const s = clipSegment(r, x1, y1, x0, y0, c1, c0)
      if (s === null) continue
      leaveX = s[0]
      leaveY = s[1]
      enterX = s[2]
      enterY = s[3]
      edge0 = edge1
      edge1 = edgeOf(r, enterX, enterY)
      if (out && edge0 && edge1) addCorners(d, i, edge0, edge1, out, out.length)
      if (out) out.push(enterX, enterY)
      else out = [enterX, enterY]
    }
    edge0 = edge1
    edge1 = edgeOf(r, leaveX, leaveY)
    if (edge0 && edge1) addCorners(d, i, edge0, edge1, out!, out!.length)
    if (out) out.push(leaveX, leaveY)
    else out = [leaveX, leaveY]
  }
  if (out) {
    const edge0 = edge1
    edge1 = edgeOf(r, out[0]!, out[1]!)
    if (edge0 && edge1) addCorners(d, i, edge0, edge1, out, out.length)
  } else if (cellContains(d, i, (r.xmin + r.xmax) / 2, (r.ymin + r.ymax) / 2)) {
    return WHOLE_RECT(r)
  }
  return out
}

/**
 * Where the ray from `(x0, y0)` in direction `(vx, vy)` first meets the rectangle's boundary, or null if it starts
 * beyond it. A direction that is not a number meets nothing: the point stays undefined, and the cell with it (the
 * diagram of points that are not numbers has no meaning, but it is a defined one).
 */
function castRay(r: Rect, x0: number, y0: number, vx: number, vy: number): [number, number] | null {
  let t = Infinity
  let x: number | undefined
  let y: number | undefined
  let c: number
  if (vy < 0) {
    if (y0 <= r.ymin) return null
    if ((c = (r.ymin - y0) / vy) < t) {
      y = r.ymin
      x = x0 + (t = c) * vx
    }
  } else if (vy > 0) {
    if (y0 >= r.ymax) return null
    if ((c = (r.ymax - y0) / vy) < t) {
      y = r.ymax
      x = x0 + (t = c) * vx
    }
  }
  if (vx > 0) {
    if (x0 >= r.xmax) return null
    if ((c = (r.xmax - x0) / vx) < t) {
      x = r.xmax
      y = y0 + (t = c) * vy
    }
  } else if (vx < 0) {
    if (x0 <= r.xmin) return null
    if ((c = (r.xmin - x0) / vx) < t) {
      x = r.xmin
      y = y0 + (t = c) * vy
    }
  }
  return [x as number, y as number]
}

/** Clip the cell of a hull point: extend its corners with the two rays to the rectangle, then clip as a closed polygon. */
function clipOpen(d: Diagram, i: number, corners: number[], startVx: number, startVy: number, endVx: number, endVy: number): number[] | null {
  const r = d.rect
  let polygon: number[] | null = corners.slice()
  let hit = castRay(r, polygon[0]!, polygon[1]!, startVx, startVy)
  if (hit) polygon.unshift(hit[0], hit[1])
  hit = castRay(r, polygon[polygon.length - 2]!, polygon[polygon.length - 1]!, endVx, endVy)
  if (hit) polygon.push(hit[0], hit[1])
  polygon = clipClosed(d, i, polygon)
  if (polygon) {
    for (let j = 0, n = polygon.length, c1 = edgeOf(r, polygon[n - 2]!, polygon[n - 1]!); j < n; j += 2) {
      const c0 = c1
      c1 = edgeOf(r, polygon[j]!, polygon[j + 1]!)
      if (c0 && c1) {
        j = addCorners(d, i, c0, c1, polygon, j)
        n = polygon.length
      }
    }
  } else if (cellContains(d, i, (r.xmin + r.xmax) / 2, (r.ymin + r.ymax) / 2)) {
    polygon = [r.xmin, r.ymin, r.xmax, r.ymin, r.xmax, r.ymax, r.xmin, r.ymax]
  }
  return polygon
}

/** Drop corners that continue a straight horizontal or vertical run. */
function simplify(polygon: number[] | null): number[] | null {
  if (polygon && polygon.length > 4) {
    for (let i = 0; i < polygon.length; i += 2) {
      const j = (i + 2) % polygon.length
      const k = (i + 4) % polygon.length
      if ((polygon[i] === polygon[j] && polygon[j] === polygon[k]) || (polygon[i + 1] === polygon[j + 1] && polygon[j + 1] === polygon[k + 1])) {
        polygon.splice(j, 2)
        i -= 2
      }
    }
    if (!polygon.length) return null
  }
  return polygon
}

/** The clipped cell of point `i` as `[x0, y0, x1, y1, ...]`, or null when it has none inside the rectangle. */
function clippedCell(d: Diagram, i: number): number[] | null {
  if (i === 0 && d.mesh.hull.length === 1) return WHOLE_RECT(d.rect)
  const corners = rawCorners(d, i)
  if (corners === null) return null
  const v = i * 4
  const ray = d.rays
  return simplify(ray[v] || ray[v + 1] ? clipOpen(d, i, corners, ray[v]!, ray[v + 1]!, ray[v + 2]!, ray[v + 3]!) : clipClosed(d, i, corners))
}

// -- public -----------------------------------------------------------------------------------------------------------

/** A coordinate as it is written in a path; an undefined one (see `castRay`) is written as nothing. */
const text = (v: number | undefined): string | number => (v === undefined ? '' : v)

export interface VoronoiDiagram {
  /** The clipped cell of point `i`: its corners, flat, as the cell's boundary is walked; null if it has none. */
  cell(i: number): number[] | null
  /**
   * The cell as an SVG path `M x,y L x,y ... Z`, with repeated corners left out; null when the cell is missing, empty
   * or a single point.
   */
  path(i: number): string | null
}

/**
 * The Voronoi diagram of `points` (`[x0, y0, x1, y1, ...]`) clipped to `rect`. The array may be modified (collinear points
 * are nudged apart). Throws if the rectangle is inverted or not a number.
 */
export function voronoi(points: Float64Array, bounds: Rect): VoronoiDiagram {
  const rect: Rect = { xmin: +bounds.xmin, ymin: +bounds.ymin, xmax: +bounds.xmax, ymax: +bounds.ymax }
  if (!(rect.xmax >= rect.xmin) || !(rect.ymax >= rect.ymin)) throw new Error('invalid bounds')
  const diagram = buildDiagram(connect(points), rect)
  return {
    cell: (i) => clippedCell(diagram, i),
    path(i) {
      const corners = clippedCell(diagram, i)
      if (corners === null || corners.length === 0) return null
      const x = corners[0]!
      const y = corners[1]!
      let end = corners.length
      while (end > 2 && corners[end - 2] === x && corners[end - 1] === y) end -= 2
      let path = 'M' + text(x) + ',' + text(y)
      let drawn = false
      for (let k = 2; k < end; k += 2) {
        if (corners[k] !== corners[k - 2] || corners[k + 1] !== corners[k - 1]) {
          path += 'L' + text(corners[k]) + ',' + text(corners[k + 1])
          drawn = true
        }
      }
      // closing back to the start repeats the first corner, which is left out as redundant -- unless a coordinate is NaN,
      // which equals nothing, itself included: then the repeat stays, and a lone corner is a path of two equal-looking ones
      const redundant = x === x && y === y
      if (!drawn && redundant) return null
      return path + (redundant ? '' : 'L' + text(x) + ',' + text(y)) + 'Z'
    },
  }
}
