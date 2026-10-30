/**
 * Rare-layout transforms (stats, hierarchy layouts, wordcloud, voronoi).
 * Loaded by the `@aster/core/transforms` addon; the core bundle keeps only
 * the transforms a plain chart uses. Shared internals come from transform.ts.
 */
import { error, hasOwnProperty, minOf, maxOf, ownGet } from './util.js'
import { compareOf, fieldOf } from './transform-agg.js'
import { checkRowCount, meterTick } from './limits.js'
import type { HierNode, Row, TransformContext } from './transform.js'
import { compileExprTransform, geoPointRadius, getField, resolveSizeParam } from './transform.js'
import type { GeoProjection } from './geo-projections.js'
import type { GeoPath, PointRadius } from './geo-path.js'
import { geoRegistry, requireGeo, transformRegistry } from './registry.js'
import { registerRuntimeExpressionFunction, type ExpressionRuntime } from './expression.js'
import { countpatternRows as countpatternStatsRows, densityRows, kdeRows, loessRows, quantileRows, regressionRows } from './transform-stats.js'
import { wordcloudRows } from './wordcloud.js'
import { forceRows } from './force-layout.js'
import { heatmapRows, isocontourRows, kde2dRows } from './raster-transforms.js'
import { packRows, partitionRows, treemapRows, treeRows } from './hierarchy-layout.js'

/**
 * The vega `treelinks` transform (vega-hierarchy TreeLinks): one `{source, target}` row per edge of the backing tree
 * whose two ends are rows of this dataset (parent and child). The tuples a tree layout wrote onto are the rows of the
 * dataset the tree was built for; they are found by their position in it, or by identity when the rows were filtered.
 */
function treelinksRows(rows: Row[], _t: Record<string, unknown>, ctx: TransformContext, sourceName?: string): Row[] {
  const root = sourceName ? (ctx.hierarchies?.get(sourceName) as HierNode | undefined) : undefined
  if (!root) error('TreeLinks transform requires a tree data source.')
  const nodes: HierNode[] = []
  breadthFirst(root, (n) => nodes.push(n))
  const rowOf = treeRowLookup(rows, nodes)
  const out: Row[] = []
  for (const node of nodes) {
    const t = rowOf(node)
    const p = node.parent && rowOf(node.parent)
    if (p && t) out.push({ source: p, target: t })
  }
  return out
}

/** d3 `node.each`: the node and its descendants, breadth first. */
function breadthFirst(root: HierNode, callback: (node: HierNode) => void): void {
  const queue: HierNode[] = [root]
  for (let i = 0; i < queue.length; ++i) {
    const node = queue[i]!
    callback(node)
    for (const c of node.children) queue.push(c)
  }
}

/** The row of a dataset that stands for a tree node: the row at the node's position, when the dataset still has one row per node. */
function treeRowLookup(rows: Row[], nodes: HierNode[]): (node: HierNode) => Row | undefined {
  if (rows.length === nodes.length) return (node) => (node.idx !== undefined && node.idx >= 0 ? rows[node.idx] : undefined)
  const present = new Set(rows)
  return (node) => (present.has(node.data) ? node.data : undefined)
}

// `treePath(tree, source, target)` / `treeAncestors(tree, node)` (vega-functions tree.js): the rows on the path between
// two keyed nodes of a dataset's tree, the ancestors of one (itself first); undefined for a key the tree lacks.
interface TreeOfDataset { root: HierNode; rows: Row[] }
const treeOfDataset = (runtime: ExpressionRuntime, name: unknown): { lookup: Map<string, HierNode>; rowOf: (n: HierNode) => Row | undefined } | undefined => {
  const t = runtime.tree?.(String(name)) as TreeOfDataset | undefined
  if (!t?.root.lookup) return undefined
  const nodes: HierNode[] = []
  breadthFirst(t.root, (n) => nodes.push(n))
  return { lookup: t.root.lookup, rowOf: treeRowLookup(t.rows, nodes) }
}
const pathBetween = (s: HierNode, e: HierNode): HierNode[] => {
  // d3 `node.path(end)`: up from s to the least common ancestor, then down to e
  const up = (n: HierNode): HierNode[] => { const a: HierNode[] = [n]; for (let p = n.parent; p; p = p.parent) a.push(p); return a }
  const sa = up(s)
  const ea = up(e)
  const common = new Set(sa)
  const lca = ea.find((n) => common.has(n))!
  const out = sa.slice(0, sa.indexOf(lca) + 1)
  const down = ea.slice(0, ea.indexOf(lca)).reverse()
  return out.concat(down)
}
registerRuntimeExpressionFunction('treePath', (runtime) => (name?: unknown, source?: unknown, target?: unknown): unknown => {
  const tree = treeOfDataset(runtime, name)
  const s = tree?.lookup.get(String(source))
  const t = tree?.lookup.get(String(target))
  return tree && s && t ? pathBetween(s, t).map((n) => tree.rowOf(n) ?? n.data) : undefined
})
registerRuntimeExpressionFunction('treeAncestors', (runtime) => (name?: unknown, node?: unknown): unknown => {
  const tree = treeOfDataset(runtime, name)
  const n = tree?.lookup.get(String(node))
  if (!tree || !n) return undefined
  const out: Row[] = []
  for (let p: HierNode | null = n; p; p = p.parent) out.push(tree.rowOf(p) ?? p.data)
  return out
})


// -- voronoi (d3-delaunay Delaunay.from(...).voronoi(bounds).cellPolygon(i) port) ----

// ---------------------------------------------------------------------------
// voronoi (d3-delaunay `Delaunay.from(...).voronoi(bounds).cellPolygon(i)` port)
//
// The vega `voronoi` transform builds a Delaunay triangulation of the input
// points and emits, per tuple, an `as` field holding the tuple's Voronoi cell
// clipped to the `size`/`extent` rectangle as an SVG path. d3-delaunay cannot
// be imported directly (it is not a dependency of this package), so the
// algorithm is ported operation-for-operation from delaunator@5 + d3-delaunay@6
// (orient2d uses the plain double-precision cross product, whose sign matches
// robust-predicates for coordinates in the double-exact range).
// ---------------------------------------------------------------------------

const DELAUNATOR_EPSILON = Math.pow(2, -52)

function delaunatorOrient2d(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  return (ay - cy) * (bx - cx) - (ax - cx) * (by - cy)
}

function delaunatorPseudoAngle(dx: number, dy: number): number {
  const p = dx / (Math.abs(dx) + Math.abs(dy))
  return (dy > 0 ? 3 - p : 1 + p) / 4
}

function delaunatorDist(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx
  const dy = ay - by
  return dx * dx + dy * dy
}

function delaunatorInCircle(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, px: number, py: number): boolean {
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

function delaunatorCircumradius(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
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

function delaunatorCircumcenter(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): { x: number; y: number } {
  const dx = bx - ax
  const dy = by - ay
  const ex = cx - ax
  const ey = cy - ay
  const bl = dx * dx + dy * dy
  const cl = ex * ex + ey * ey
  const d = 0.5 / (dx * ey - dy * ex)
  return { x: ax + (ey * bl - dy * cl) * d, y: ay + (dx * cl - ex * bl) * d }
}

function delaunatorQuicksort(ids: Uint32Array, dists: Float64Array, left: number, right: number): void {
  if (right - left <= 20) {
    for (let i = left + 1; i <= right; i++) {
      const temp = ids[i]!
      const tempDist = dists[temp]!
      let j = i - 1
      while (j >= left && (dists[ids[j]!] as number) > tempDist) ids[j + 1] = ids[j--]!
      ids[j + 1] = temp
    }
  } else {
    const median = (left + right) >> 1
    let i = left + 1
    let j = right
    delaunatorSwap(ids, median, i)
    if ((dists[ids[left]!] as number) > (dists[ids[right]!] as number)) delaunatorSwap(ids, left, right)
    if ((dists[ids[i]!] as number) > (dists[ids[right]!] as number)) delaunatorSwap(ids, i, right)
    if ((dists[ids[left]!] as number) > (dists[ids[i]!] as number)) delaunatorSwap(ids, left, i)

    const temp = ids[i]!
    const tempDist = dists[temp]!
    while (true) {
      do i++
      while ((dists[ids[i]!] as number) < tempDist)
      do j--
      while ((dists[ids[j]!] as number) > tempDist)
      if (j < i) break
      delaunatorSwap(ids, i, j)
    }
    ids[left + 1] = ids[j]!
    ids[j] = temp

    if (right - i + 1 >= j - left) {
      delaunatorQuicksort(ids, dists, i, right)
      delaunatorQuicksort(ids, dists, left, j - 1)
    } else {
      delaunatorQuicksort(ids, dists, left, j - 1)
      delaunatorQuicksort(ids, dists, i, right)
    }
  }
}

function delaunatorSwap(arr: Uint32Array, i: number, j: number): void {
  const tmp = arr[i]!
  arr[i] = arr[j]!
  arr[j] = tmp
}

/** Port of delaunator@5's Delaunator (Bowyer-Watson incremental triangulation). */
class DelaunatorPort {
  coords: Float64Array
  _triangles: Uint32Array
  _halfedges: Int32Array
  _hashSize: number
  _hullPrev: Uint32Array
  _hullNext: Uint32Array
  _hullTri: Uint32Array
  _hullHash: Int32Array
  _ids: Uint32Array
  _dists: Float64Array
  trianglesLen = 0
  _cx = 0
  _cy = 0
  _hullStart = 0
  hull: Uint32Array
  triangles: Uint32Array
  halfedges: Int32Array

  constructor(coords: Float64Array) {
    this.coords = coords
    const n = coords.length >> 1
    const maxTriangles = Math.max(2 * n - 5, 0)
    this._triangles = new Uint32Array(maxTriangles * 3)
    this._halfedges = new Int32Array(maxTriangles * 3)
    this._hashSize = Math.ceil(Math.sqrt(n))
    this._hullPrev = new Uint32Array(n)
    this._hullNext = new Uint32Array(n)
    this._hullTri = new Uint32Array(n)
    this._hullHash = new Int32Array(this._hashSize)
    this._ids = new Uint32Array(n)
    this._dists = new Float64Array(n)
    this.hull = this._triangles
    this.triangles = this._triangles
    this.halfedges = this._halfedges
    this.update()
  }

  update(): void {
    const coords = this.coords
    const hullPrev = this._hullPrev
    const hullNext = this._hullNext
    const hullTri = this._hullTri
    const hullHash = this._hullHash
    const n = coords.length >> 1

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
      this._ids[i] = i
    }
    const cx = (minX + maxX) / 2
    const cy = (minY + maxY) / 2

    let i0 = 0
    let i1 = 0
    let i2 = 0

    for (let i = 0, minDist = Infinity; i < n; i++) {
      const d = delaunatorDist(cx, cy, coords[2 * i]!, coords[2 * i + 1]!)
      if (d < minDist) {
        i0 = i
        minDist = d
      }
    }
    const i0x = coords[2 * i0]!
    const i0y = coords[2 * i0 + 1]!

    for (let i = 0, minDist = Infinity; i < n; i++) {
      if (i === i0) continue
      const d = delaunatorDist(i0x, i0y, coords[2 * i]!, coords[2 * i + 1]!)
      if (d < minDist && d > 0) {
        i1 = i
        minDist = d
      }
    }
    let i1x = coords[2 * i1]!
    let i1y = coords[2 * i1 + 1]!

    let minRadius = Infinity
    for (let i = 0; i < n; i++) {
      if (i === i0 || i === i1) continue
      const r = delaunatorCircumradius(i0x, i0y, i1x, i1y, coords[2 * i]!, coords[2 * i + 1]!)
      if (r < minRadius) {
        i2 = i
        minRadius = r
      }
    }
    let i2x = coords[2 * i2]!
    let i2y = coords[2 * i2 + 1]!

    if (minRadius === Infinity) {
      for (let i = 0; i < n; i++) {
        this._dists[i] = (coords[2 * i]! - coords[0]!) || (coords[2 * i + 1]! - coords[1]!)
      }
      delaunatorQuicksort(this._ids, this._dists, 0, n - 1)
      const hull = new Uint32Array(n)
      let j = 0
      for (let i = 0, d0 = -Infinity; i < n; i++) {
        const id = this._ids[i]!
        const d = this._dists[id]!
        if (d > d0) {
          hull[j++] = id
          d0 = d
        }
      }
      this.hull = hull.subarray(0, j)
      this.triangles = new Uint32Array(0)
      this.halfedges = new Int32Array(0)
      return
    }

    if (delaunatorOrient2d(i0x, i0y, i1x, i1y, i2x, i2y) < 0) {
      const i = i1
      const x = i1x
      const y = i1y
      i1 = i2
      i1x = i2x
      i1y = i2y
      i2 = i
      i2x = x
      i2y = y
    }

    const center = delaunatorCircumcenter(i0x, i0y, i1x, i1y, i2x, i2y)
    this._cx = center.x
    this._cy = center.y

    for (let i = 0; i < n; i++) {
      this._dists[i] = delaunatorDist(coords[2 * i]!, coords[2 * i + 1]!, center.x, center.y)
    }
    delaunatorQuicksort(this._ids, this._dists, 0, n - 1)

    this._hullStart = i0
    let hullSize = 3

    hullNext[i0] = hullPrev[i2] = i1
    hullNext[i1] = hullPrev[i0] = i2
    hullNext[i2] = hullPrev[i1] = i0

    hullTri[i0] = 0
    hullTri[i1] = 1
    hullTri[i2] = 2

    hullHash.fill(-1)
    hullHash[this._hashKey(i0x, i0y)] = i0
    hullHash[this._hashKey(i1x, i1y)] = i1
    hullHash[this._hashKey(i2x, i2y)] = i2

    this.trianglesLen = 0
    this._addTriangle(i0, i1, i2, -1, -1, -1)

    for (let k = 0, xp = 0, yp = 0; k < this._ids.length; k++) {
      const i = this._ids[k]!
      const x = coords[2 * i]!
      const y = coords[2 * i + 1]!

      if (k > 0 && Math.abs(x - xp) <= DELAUNATOR_EPSILON && Math.abs(y - yp) <= DELAUNATOR_EPSILON) continue
      xp = x
      yp = y

      if (i === i0 || i === i1 || i === i2) continue

      let start = 0
      for (let j = 0, key = this._hashKey(x, y); j < this._hashSize; j++) {
        start = hullHash[(key + j) % this._hashSize]!
        if (start !== -1 && start !== hullNext[start]) break
      }

      start = hullPrev[start]!
      let e = start
      let q: number
      while ((q = hullNext[e]!), delaunatorOrient2d(x, y, coords[2 * e]!, coords[2 * e + 1]!, coords[2 * q]!, coords[2 * q + 1]!) >= 0) {
        e = q
        if (e === start) {
          e = -1
          break
        }
      }
      if (e === -1) continue

      let t = this._addTriangle(e, i, hullNext[e]!, -1, -1, hullTri[e]!)

      hullTri[i] = this._legalize(t + 2)
      hullTri[e] = t
      hullSize++

      let nEdge = hullNext[e]!
      while ((q = hullNext[nEdge]!), delaunatorOrient2d(x, y, coords[2 * nEdge]!, coords[2 * nEdge + 1]!, coords[2 * q]!, coords[2 * q + 1]!) < 0) {
        t = this._addTriangle(nEdge, i, q, hullTri[i]!, -1, hullTri[nEdge]!)
        hullTri[i] = this._legalize(t + 2)
        hullNext[nEdge] = nEdge
        hullSize--
        nEdge = q
      }

      if (e === start) {
        while ((q = hullPrev[e]!), delaunatorOrient2d(x, y, coords[2 * q]!, coords[2 * q + 1]!, coords[2 * e]!, coords[2 * e + 1]!) < 0) {
          t = this._addTriangle(q, i, e, -1, hullTri[e]!, hullTri[q]!)
          this._legalize(t + 2)
          hullTri[q] = t
          hullNext[e] = e
          hullSize--
          e = q
        }
      }

      this._hullStart = hullPrev[i] = e
      hullNext[e] = hullPrev[nEdge] = i
      hullNext[i] = nEdge

      hullHash[this._hashKey(x, y)] = i
      hullHash[this._hashKey(coords[2 * e]!, coords[2 * e + 1]!)] = e
    }

    this.hull = new Uint32Array(hullSize)
    for (let i = 0, e = this._hullStart; i < hullSize; i++) {
      this.hull[i] = e
      e = hullNext[e]!
    }

    this.triangles = this._triangles.subarray(0, this.trianglesLen)
    this.halfedges = this._halfedges.subarray(0, this.trianglesLen)
  }

  _hashKey(x: number, y: number): number {
    return Math.floor(delaunatorPseudoAngle(x - this._cx, y - this._cy) * this._hashSize) % this._hashSize
  }

  _legalize(a: number): number {
    const triangles = this._triangles
    const halfedges = this._halfedges
    const coords = this.coords
    const stack: number[] = []

    let i = 0
    let ar = 0
    while (true) {
      const b = halfedges[a]!

      const a0 = a - (a % 3)
      ar = a0 + ((a + 2) % 3)

      if (b === -1) {
        if (i === 0) break
        a = stack[--i]!
        continue
      }

      const b0 = b - (b % 3)
      const al = a0 + ((a + 1) % 3)
      const bl = b0 + ((b + 2) % 3)

      const p0 = triangles[ar]!
      const pr = triangles[a]!
      const pl = triangles[al]!
      const p1 = triangles[bl]!

      const illegal = delaunatorInCircle(
        coords[2 * p0]!, coords[2 * p0 + 1]!,
        coords[2 * pr]!, coords[2 * pr + 1]!,
        coords[2 * pl]!, coords[2 * pl + 1]!,
        coords[2 * p1]!, coords[2 * p1 + 1]!,
      )

      if (illegal) {
        triangles[a] = p1
        triangles[b] = p0

        const hbl = halfedges[bl]!

        if (hbl === -1) {
          let e = this._hullStart
          do {
            if (this._hullTri[e] === bl) {
              this._hullTri[e] = a
              break
            }
            e = this._hullPrev[e]!
          } while (e !== this._hullStart)
        }
        this._link(a, hbl)
        this._link(b, halfedges[ar]!)
        this._link(ar, bl)

        const br = b0 + ((b + 1) % 3)
        stack[i++] = br
      } else {
        if (i === 0) break
        a = stack[--i]!
      }
    }

    return ar
  }

  _link(a: number, b: number): void {
    this._halfedges[a] = b
    if (b !== -1) this._halfedges[b] = a
  }

  _addTriangle(i0: number, i1: number, i2: number, a: number, b: number, c: number): number {
    const t = this.trianglesLen

    this._triangles[t] = i0
    this._triangles[t + 1] = i1
    this._triangles[t + 2] = i2

    this._link(t, a)
    this._link(t + 1, b)
    this._link(t + 2, c)

    this.trianglesLen += 3

    return t
  }
}

interface DelaunayPort {
  points: Float64Array
  inedges: Int32Array
  _hullIndex: Int32Array
  halfedges: Int32Array
  hull: Uint32Array
  triangles: Uint32Array
  collinear?: Int32Array
}

/** `Delaunay.from(rows, xField, yField)` + `Delaunay._init` (d3-delaunay@6). */
function buildDelaunay(rows: Row[], xOf: (r: Row) => unknown, yOf: (r: Row) => unknown): DelaunayPort {
  const n = rows.length
  const coords = new Float64Array(n * 2)
  for (let i = 0; i < n; i++) {
    coords[i * 2] = xOf(rows[i]!) as number
    coords[i * 2 + 1] = yOf(rows[i]!) as number
  }
  const del = new DelaunatorPort(coords)
  const d: DelaunayPort = {
    points: del.coords,
    inedges: new Int32Array(n),
    _hullIndex: new Int32Array(n),
    halfedges: del.halfedges,
    hull: del.hull,
    triangles: del.triangles,
  }

  // Delaunay._init: collinear detection + jitter, then inedges / hullIndex.
  const collinearCheck = (): boolean => {
    const { triangles, points } = d
    for (let i = 0; i < triangles.length; i += 3) {
      const a = 2 * triangles[i]!
      const b = 2 * triangles[i + 1]!
      const c = 2 * triangles[i + 2]!
      const cross =
        (points[c]! - points[a]!) * (points[b + 1]! - points[a + 1]!) -
        (points[b]! - points[a]!) * (points[c + 1]! - points[a + 1]!)
      if (cross > 1e-10) return false
    }
    return true
  }

  if (d.hull.length > 2 && collinearCheck()) {
    const collinear = Int32Array.from({ length: n }, (_, i) => i).sort(
      (i, j) => d.points[2 * i]! - d.points[2 * j]! || d.points[2 * i + 1]! - d.points[2 * j + 1]!,
    )
    const e = collinear[0]!
    const f = collinear[collinear.length - 1]!
    const r = 1e-8 * Math.hypot(d.points[2 * f + 1]! - d.points[2 * e + 1]!, d.points[2 * f]! - d.points[2 * e]!)
    for (let i = 0; i < n; i++) {
      const x = d.points[2 * i]!
      const y = d.points[2 * i + 1]!
      const p: [number, number] = [x + Math.sin(x + y) * r, y + Math.cos(x - y) * r]
      d.points[2 * i] = p[0]
      d.points[2 * i + 1] = p[1]
    }
    const del2 = new DelaunatorPort(d.points)
    d.halfedges = del2.halfedges
    d.hull = del2.hull
    d.triangles = del2.triangles
    d.collinear = collinear
  } else {
    d.collinear = undefined
  }

  const inedges = d.inedges.fill(-1)
  const hullIndex = d._hullIndex.fill(-1)
  const { halfedges, hull, triangles } = d

  for (let e = 0, ne = halfedges.length; e < ne; ++e) {
    const p = triangles[e % 3 === 2 ? e - 2 : e + 1]!
    if (halfedges[e] === -1 || inedges[p] === -1) inedges[p] = e
  }
  for (let i = 0, nh = hull.length; i < nh; ++i) {
    hullIndex[hull[i]!] = i
  }

  if (hull.length <= 2 && hull.length > 0) {
    d.triangles = new Int32Array(3).fill(-1) as unknown as Uint32Array
    d.halfedges = new Int32Array(3).fill(-1)
    d.triangles[0] = hull[0]!
    inedges[hull[0]!] = 1
    if (hull.length === 2) {
      inedges[hull[1]!] = 0
      d.triangles[1] = hull[1]!
      d.triangles[2] = hull[1]!
    }
  }

  return d
}

interface VoronoiPort {
  delaunay: DelaunayPort
  circumcenters: Float64Array
  vectors: Float64Array
  xmin: number
  ymin: number
  xmax: number
  ymax: number
}

/** `delaunay.voronoi([xmin, ymin, xmax, ymax])` + Voronoi._init (d3-delaunay@6). */
function buildVoronoi(delaunay: DelaunayPort, bounds: [number, number, number, number]): VoronoiPort {
  const v: VoronoiPort = {
    delaunay,
    circumcenters: new Float64Array(delaunay.points.length * 2),
    vectors: new Float64Array(delaunay.points.length * 2),
    xmin: bounds[0],
    ymin: bounds[1],
    xmax: bounds[2],
    ymax: bounds[3],
  }
  const { points, hull, triangles } = delaunay
  const vectors = v.vectors
  let bx: number | undefined
  let by: number | undefined

  const circumcenters = (v.circumcenters = v.circumcenters.subarray(0, (triangles.length / 3) * 2))
  for (let i = 0, j = 0, n = triangles.length; i < n; i += 3, j += 2) {
    const t1 = triangles[i]! * 2
    const t2 = triangles[i + 1]! * 2
    const t3 = triangles[i + 2]! * 2
    const x1 = points[t1]!
    const y1 = points[t1 + 1]!
    const x2 = points[t2]!
    const y2 = points[t2 + 1]!
    const x3 = points[t3]!
    const y3 = points[t3 + 1]!

    const dx = x2 - x1
    const dy = y2 - y1
    const ex = x3 - x1
    const ey = y3 - y1
    const ab = (dx * ey - dy * ex) * 2

    let x: number
    let y: number
    if (Math.abs(ab) < 1e-9) {
      if (bx === undefined || by === undefined) {
        bx = 0
        by = 0
        for (const i of hull) {
          bx += points[i * 2]!
          by += points[i * 2 + 1]!
        }
        bx /= hull.length
        by /= hull.length
      }
      const a = 1e9 * Math.sign((bx - x1) * ey - (by - y1) * ex)
      x = (x1 + x3) / 2 - a * ey
      y = (y1 + y3) / 2 + a * ex
    } else {
      const d = 1 / ab
      const bl = dx * dx + dy * dy
      const cl = ex * ex + ey * ey
      x = x1 + (ey * bl - dy * cl) * d
      y = y1 + (dx * cl - ex * bl) * d
    }
    circumcenters[j] = x
    circumcenters[j + 1] = y
  }

  let h = hull[hull.length - 1]!
  let p0: number
  let p1 = h * 4
  let x0: number
  let x1 = points[2 * h]!
  let y0: number
  let y1 = points[2 * h + 1]!
  vectors.fill(0)
  for (let i = 0; i < hull.length; ++i) {
    h = hull[i]!
    p0 = p1
    x0 = x1
    y0 = y1
    p1 = h * 4
    x1 = points[2 * h]!
    y1 = points[2 * h + 1]!
    vectors[p0 + 2] = vectors[p1] = y0 - y1
    vectors[p0 + 3] = vectors[p1 + 1] = x1 - x0
  }

  return v
}

/** d3-delaunay `Voronoi._regioncode`. */
function voronoiRegioncode(v: VoronoiPort, x: number, y: number): number {
  return (x < v.xmin ? 0b0001 : x > v.xmax ? 0b0010 : 0b0000) | (y < v.ymin ? 0b0100 : y > v.ymax ? 0b1000 : 0b0000)
}

/** d3-delaunay `Voronoi._edgecode`. */
function voronoiEdgecode(v: VoronoiPort, x: number, y: number): number {
  return (x === v.xmin ? 0b0001 : x === v.xmax ? 0b0010 : 0b0000) | (y === v.ymin ? 0b0100 : y === v.ymax ? 0b1000 : 0b0000)
}

/** d3-delaunay `Voronoi._clipSegment`. */
function voronoiClipSegment(v: VoronoiPort, x0: number, y0: number, x1: number, y1: number, c0: number, c1: number): [number, number, number, number] | null {
  const flip = c0 < c1
  if (flip) {
    const t = [x1, y1, x0, y0, c1, c0]
    x0 = t[0]!
    y0 = t[1]!
    x1 = t[2]!
    y1 = t[3]!
    c0 = t[4]!
    c1 = t[5]!
  }
  while (true) {
    if (c0 === 0 && c1 === 0) return flip ? [x1, y1, x0, y0] : [x0, y0, x1, y1]
    if (c0 & c1) return null
    let x = 0
    let y = 0
    let c = c0 || c1
    if (c & 0b1000) {
      x = x0 + ((x1 - x0) * (v.ymax - y0)) / (y1 - y0)
      y = v.ymax
    } else if (c & 0b0100) {
      x = x0 + ((x1 - x0) * (v.ymin - y0)) / (y1 - y0)
      y = v.ymin
    } else if (c & 0b0010) {
      y = y0 + ((y1 - y0) * (v.xmax - x0)) / (x1 - x0)
      x = v.xmax
    } else {
      y = y0 + ((y1 - y0) * (v.xmin - x0)) / (x1 - x0)
      x = v.xmin
    }
    if (c0) {
      x0 = x
      y0 = y
      c0 = voronoiRegioncode(v, x0, y0)
    } else {
      x1 = x
      y1 = y
      c1 = voronoiRegioncode(v, x1, y1)
    }
  }
}

/** d3-delaunay `Voronoi._cell(i)`: the (unclipped) circumcenter polygon. */
function voronoiCell(v: VoronoiPort, i: number): number[] | null {
  const { circumcenters } = v
  const { inedges, halfedges, triangles } = v.delaunay
  const e0 = inedges[i]!
  if (e0 === -1) return null
  const points: number[] = []
  let e = e0
  do {
    const t = Math.floor(e / 3)
    points.push(circumcenters[t * 2]!, circumcenters[t * 2 + 1]!)
    e = e % 3 === 2 ? e - 2 : e + 1
    if (triangles[e]! !== i) break
    e = halfedges[e]!
  } while (e !== e0 && e !== -1)
  return points
}

/** d3-delaunay `Voronoi._edge(i, e0, e1, P, j)`: insert rectangle corners. */
function voronoiEdge(v: VoronoiPort, i: number, e0: number, e1: number, P: number[], j: number): number {
  while (e0 !== e1) {
    let x = 0
    let y = 0
    switch (e0) {
      case 0b0101:
        e0 = 0b0100
        continue
      case 0b0100:
        e0 = 0b0110
        x = v.xmax
        y = v.ymin
        break
      case 0b0110:
        e0 = 0b0010
        continue
      case 0b0010:
        e0 = 0b1010
        x = v.xmax
        y = v.ymax
        break
      case 0b1010:
        e0 = 0b1000
        continue
      case 0b1000:
        e0 = 0b1001
        x = v.xmin
        y = v.ymax
        break
      case 0b1001:
        e0 = 0b0001
        continue
      case 0b0001:
        e0 = 0b0101
        x = v.xmin
        y = v.ymin
        break
    }
    if ((P[j] !== x || P[j + 1] !== y) && voronoiContains(v, i, x, y)) {
      P.splice(j, 0, x, y)
      j += 2
    }
  }
  return j
}

/** d3-delaunay `Voronoi._project(x0, y0, vx, vy)`. */
function voronoiProject(v: VoronoiPort, x0: number, y0: number, vx: number, vy: number): [number, number] | null {
  let t = Infinity
  let x = 0
  let y = 0
  let c: number
  if (vy < 0) {
    if (y0 <= v.ymin) return null
    if ((c = (v.ymin - y0) / vy) < t) {
      y = v.ymin
      x = x0 + (t = c) * vx
    }
  } else if (vy > 0) {
    if (y0 >= v.ymax) return null
    if ((c = (v.ymax - y0) / vy) < t) {
      y = v.ymax
      x = x0 + (t = c) * vx
    }
  }
  if (vx > 0) {
    if (x0 >= v.xmax) return null
    if ((c = (v.xmax - x0) / vx) < t) {
      x = v.xmax
      y = y0 + (t = c) * vy
    }
  } else if (vx < 0) {
    if (x0 <= v.xmin) return null
    if ((c = (v.xmin - x0) / vx) < t) {
      x = v.xmin
      y = y0 + (t = c) * vy
    }
  }
  return [x, y]
}

/** d3-delaunay `Voronoi._clipFinite(i, points)`. */
function voronoiClipFinite(v: VoronoiPort, i: number, points: number[]): number[] | null {
  const n = points.length
  let P: number[] | null = null
  let x0 = 0
  let y0 = 0
  let x1 = points[n - 2]!
  let y1 = points[n - 1]!
  let c0 = 0
  let c1 = voronoiRegioncode(v, x1, y1)
  let e0 = 0
  let e1 = 0
  for (let j = 0; j < n; j += 2) {
    x0 = x1
    y0 = y1
    x1 = points[j]!
    y1 = points[j + 1]!
    c0 = c1
    c1 = voronoiRegioncode(v, x1, y1)
    if (c0 === 0 && c1 === 0) {
      e0 = e1
      e1 = 0
      if (P) P.push(x1, y1)
      else P = [x1, y1]
    } else {
      let S: [number, number, number, number] | null
      let sx0 = 0
      let sy0 = 0
      let sx1 = 0
      let sy1 = 0
      if (c0 === 0) {
        S = voronoiClipSegment(v, x0, y0, x1, y1, c0, c1)
        if (S === null) continue
        sx0 = S[0]
        sy0 = S[1]
        sx1 = S[2]
        sy1 = S[3]
      } else {
        S = voronoiClipSegment(v, x1, y1, x0, y0, c1, c0)
        if (S === null) continue
        sx1 = S[0]
        sy1 = S[1]
        sx0 = S[2]
        sy0 = S[3]
        e0 = e1
        e1 = voronoiEdgecode(v, sx0, sy0)
        if (P && e0 && e1) voronoiEdge(v, i, e0, e1, P, P.length)
        if (P) P.push(sx0, sy0)
        else P = [sx0, sy0]
      }
      e0 = e1
      e1 = voronoiEdgecode(v, sx1, sy1)
      if (e0 && e1) voronoiEdge(v, i, e0, e1, P!, P!.length)
      if (P) P.push(sx1, sy1)
      else P = [sx1, sy1]
    }
  }
  if (P) {
    e0 = e1
    e1 = voronoiEdgecode(v, P[0]!, P[1]!)
    if (e0 && e1) voronoiEdge(v, i, e0, e1, P, P.length)
  } else if (voronoiContains(v, i, (v.xmin + v.xmax) / 2, (v.ymin + v.ymax) / 2)) {
    return [v.xmax, v.ymin, v.xmax, v.ymax, v.xmin, v.ymax, v.xmin, v.ymin]
  }
  return P
}

/** d3-delaunay `Voronoi._clipInfinite(i, points, vx0, vy0, vxn, vyn)`. */
function voronoiClipInfinite(v: VoronoiPort, i: number, points: number[], vx0: number, vy0: number, vxn: number, vyn: number): number[] | null {
  let P: number[] | null = Array.from(points)
  let p: [number, number] | null
  if ((p = voronoiProject(v, P[0]!, P[1]!, vx0, vy0))) P.unshift(p[0], p[1])
  if ((p = voronoiProject(v, P[P.length - 2]!, P[P.length - 1]!, vxn, vyn))) P.push(p[0], p[1])
  if ((P = voronoiClipFinite(v, i, P))) {
    for (let j = 0, n = P.length, c0: number, c1 = voronoiEdgecode(v, P[n - 2]!, P[n - 1]!); j < n; j += 2) {
      c0 = c1
      c1 = voronoiEdgecode(v, P[j]!, P[j + 1]!)
      if (c0 && c1) {
        j = voronoiEdge(v, i, c0, c1, P, j)
        n = P.length
      }
    }
  } else if (voronoiContains(v, i, (v.xmin + v.xmax) / 2, (v.ymin + v.ymax) / 2)) {
    P = [v.xmin, v.ymin, v.xmax, v.ymin, v.xmax, v.ymax, v.xmin, v.ymax]
  }
  return P
}

/** d3-delaunay `Voronoi._simplify(P)`. */
function voronoiSimplify(P: number[] | null): number[] | null {
  if (P && P.length > 4) {
    for (let i = 0; i < P.length; i += 2) {
      const j = (i + 2) % P.length
      const k = (i + 4) % P.length
      if ((P[i] === P[j] && P[j] === P[k]) || (P[i + 1] === P[j + 1] && P[j + 1] === P[k + 1])) {
        P.splice(j, 2)
        i -= 2
      }
    }
    if (!P.length) P = null
  }
  return P
}

/** d3-delaunay `Voronoi.contains(i, x, y)` via `Delaunay._step`. */
function voronoiContains(v: VoronoiPort, i: number, x: number, y: number): boolean {
  return delaunayStep(v.delaunay, i, x, y) === i
}

/** d3-delaunay `Delaunay._step(i, x, y)`. */
function delaunayStep(d: DelaunayPort, i: number, x: number, y: number): number {
  const { inedges, hull, _hullIndex, halfedges, triangles, points } = d
  if (inedges[i] === -1 || !points.length) return (i + 1) % (points.length >> 1)
  let c = i
  let dc = Math.pow(x - points[i * 2]!, 2) + Math.pow(y - points[i * 2 + 1]!, 2)
  const e0 = inedges[i]!
  let e = e0
  do {
    const t = triangles[e]!
    const dt = Math.pow(x - points[t * 2]!, 2) + Math.pow(y - points[t * 2 + 1]!, 2)
    if (dt < dc) {
      dc = dt
      c = t
    }
    e = e % 3 === 2 ? e - 2 : e + 1
    if (triangles[e] !== i) break
    e = halfedges[e]!
    if (e === -1) {
      e = hull[(_hullIndex[i]! + 1) % hull.length]!
      if (e !== t) {
        if (Math.pow(x - points[e * 2]!, 2) + Math.pow(y - points[e * 2 + 1]!, 2) < dc) return e
      }
      break
    }
  } while (e !== e0)
  return c
}

/** d3-delaunay `Voronoi._clip(i)` → flat `[x0, y0, x1, y1, ...]` array. */
function voronoiClip(v: VoronoiPort, i: number): number[] | null {
  if (i === 0 && v.delaunay.hull.length === 1) {
    return [v.xmax, v.ymin, v.xmax, v.ymax, v.xmin, v.ymax, v.xmin, v.ymin]
  }
  const points = voronoiCell(v, i)
  if (points === null) return null
  const { vectors } = v
  const vv = i * 4
  return voronoiSimplify(
    vectors[vv] || vectors[vv + 1]
      ? voronoiClipInfinite(v, i, points, vectors[vv]!, vectors[vv + 1]!, vectors[vv + 2]!, vectors[vv + 3]!)
      : voronoiClipFinite(v, i, points),
  )
}

/**
 * d3-delaunay `Voronoi.renderCell` + vega's `toPathString`: build the cell
 * polygon (omitting duplicate vertices and the closing point) and serialize it
 * as an SVG path `M…L…L…Z`.
 */
function voronoiCellPath(v: VoronoiPort, i: number): string | null {
  const clipped = voronoiClip(v, i)
  if (clipped === null || clipped.length === 0) return null
  // renderCell: drop consecutive duplicate vertices, closePath appends the
  // first point (stripped by toPathString).
  const pairs: Array<[number, number]> = []
  let n = clipped.length
  while (clipped[0] === clipped[n - 2] && clipped[1] === clipped[n - 1] && n > 1) n -= 2
  for (let k = 2; k < n; k += 2) {
    if (clipped[k] !== clipped[k - 2] || clipped[k + 1] !== clipped[k - 1]) {
      pairs.push([clipped[k]!, clipped[k + 1]!])
    }
  }
  const first: [number, number] = [clipped[0]!, clipped[1]!]
  if (pairs.length === 0) return null
  const last = pairs[pairs.length - 1]!
  if (last[0] === first[0] && last[1] === first[1]) pairs.pop()
  if (pairs.length === 0) return null
  return 'M' + first.join(',') + pairs.map((p) => 'L' + p.join(',')).join('') + 'Z'
}

/** The vega `voronoi` transform: Delaunay triangulation → clipped cell paths. */
/** A vega `field` parameter: a field name, `{field}`, or an `{expr}` evaluated per row (vega-lite's voronoi reads `datum.datum.x || 0`). */
function fieldParam(param: unknown, ctx: TransformContext, what: string): (r: Row) => unknown {
  if (typeof param === 'string') return (r) => getField(r, param)
  if (param !== null && typeof param === 'object') {
    const p = param as { field?: unknown; expr?: unknown }
    if (typeof p.field === 'string') return (r) => getField(r, p.field as string)
    if (typeof p.expr === 'string') {
      const f = ctx.runtime.expr(p.expr)
      return (r) => f(r, ctx.signals)
    }
  }
  throw new Error(`voronoi: the ${what} parameter must be a field name, {field} or {expr}`)
}

function voronoiRows(rows: Row[], t: Record<string, unknown>, ctx: TransformContext): Row[] {
  const as = (t.as as string | undefined) ?? 'path'
  const xOf = fieldParam(t.x, ctx, 'x')
  const yOf = fieldParam(t.y, ctx, 'y')
  const size = resolveSizeParam(t.size, ctx)
  let bounds: [number, number, number, number]
  if (size) {
    bounds = [0, 0, size[0], size[1]]
  } else if (Array.isArray(t.extent) && t.extent.length === 2) {
    const e = t.extent as [[number, number], [number, number]]
    bounds = [e[0][0], e[0][1], e[1][0], e[1][1]]
  } else {
    bounds = [-1e5, -1e5, 1e5, 1e5]
  }

  // Nothing to do if no data (matches vega's early return).
  if (!rows.length) return rows

  const delaunay = buildDelaunay(rows, xOf, yOf)
  const voronoi = buildVoronoi(delaunay, bounds)
  return rows.map((r, i) => {
    meterTick('voronoi')
    const clipped = voronoiClip(voronoi, i)
    const isPoint = clipped !== null && clipped.length === 4 && clipped[0] === clipped[2] && clipped[1] === clipped[3]
    const path = isPoint ? null : voronoiCellPath(voronoi, i)
    return { ...r, [as]: path }
  })
}


// -- crossfilter / resolvefilter (vega-crossfilter) ----------------------------------

/** What `crossfilter` publishes as its `signal`: the per-tuple filter bitmaps `resolvefilter` reads (vega-crossfilter Bitmaps). */
export interface CrossfilterBitmaps { mask: number; data(): Row[]; curr(): Uint32Array }

const ascendingValues = (a: unknown, b: unknown): number => (a == null || b == null ? NaN : (a as number) < (b as number) ? -1 : (a as number) > (b as number) ? 1 : (a as number) >= (b as number) ? 0 : NaN)

/** d3-array `bisectLeft` (the comparable-self check included): the position of `x` among the sorted `a`. */
function bisectLeftValues(a: readonly unknown[], x: unknown): number {
  let lo = 0
  let hi = a.length
  if (lo < hi) {
    if (ascendingValues(x, x) !== 0) return hi
    do {
      const mid = (lo + hi) >>> 1
      if (ascendingValues(a[mid], x) < 0) lo = mid + 1
      else hi = mid
    } while (lo < hi)
  }
  return lo
}

/**
 * An indexed multi-dimensional filter (vega-crossfilter CrossFilter): bit `i` of a tuple's state is set when the tuple lies outside
 * `query[i]` -- below it or at/above its end, by the sorted order of `fields[i]` -- so a tuple passes when no bit is set. The
 * tuples go on (each carrying its `_index`), the bitmaps are the transform's `signal`.
 */
function crossfilterRows(rows: Row[], t: Record<string, unknown>, ctx: TransformContext): Row[] {
  const fields = ([] as unknown[]).concat(t.fields ?? [])
  const query = ([] as unknown[]).concat(t.query ?? []) as Array<[unknown, unknown]>
  if (!fields.length) error('[aster] crossfilter requires "fields"')
  const m = query.length
  const data = rows.map((r, i) => ({ ...r, _index: i }))
  const n = data.length
  const curr = new Uint32Array(n)
  for (let d = 0; d < m; d++) {
    const f = fieldOf(fields[d])
    const values = data.map((r) => f(r))
    const index = new Uint32Array(n)
    for (let i = 0; i < n; i++) index[i] = i
    // vega-crossfilter SortedIndex: the index permuted by the values, `<` / `>` order (an incomparable pair is a tie)
    Array.prototype.sort.call(index, (a: number, b: number) => (values[a]! < values[b]! ? -1 : values[a]! > values[b]! ? 1 : 0))
    const sorted = Array.from(index, (k) => values[k])
    const lo = bisectLeftValues(sorted, query[d]![0])
    const hi = bisectLeftValues(sorted, query[d]![1])
    const bit = 1 << d
    for (let i = 0; i < lo; i++) curr[index[i]!]! |= bit
    for (let i = hi; i < n; i++) curr[index[i]!]! |= bit
  }
  if (typeof t.signal === 'string') {
    // (the mask is all that is hashed with the signals: the arrays stay out of reach of a context fingerprint)
    const bits = { mask: m ? (1 << m) - 1 : 0 } as CrossfilterBitmaps
    Object.defineProperties(bits, { data: { value: () => data }, curr: { value: () => curr } })
    ctx.signals[t.signal] = bits
  }
  return data
}

/**
 * Tuples that pass a crossfilter's bitmaps, ignoring some dimensions (vega-crossfilter ResolveFilter): `ignore` is a bit mask of the
 * dimensions to leave out. When every dimension that changed is ignored, nothing propagates -- the first evaluation changed them all.
 */
function resolvefilterRows(rows: Row[], t: Record<string, unknown>): Row[] {
  const bitmap = t.filter as CrossfilterBitmaps | undefined
  if (!bitmap || typeof bitmap.curr !== 'function') error('[aster] resolvefilter requires a "filter" from a crossfilter transform')
  const ignore = ~(Number(t.ignore) || 0)
  if ((bitmap.mask & ignore) === 0) return []
  const curr = bitmap.curr()
  return rows.filter((r) => !(curr[(r as { _index: number })._index]! & ignore))
}

// -- addon registration ------------------------------------------------------
transformRegistry.set('crossfilter', crossfilterRows)
transformRegistry.set('resolvefilter', (rows, t) => resolvefilterRows(rows, t))
transformRegistry.set('kde', kdeRows)
transformRegistry.set('density', (rows, t, ctx) => densityRows(rows, t, ctx?.datasets))
transformRegistry.set('quantile', quantileRows)
transformRegistry.set('regression', regressionRows)
transformRegistry.set('loess', loessRows)
transformRegistry.set('pack', packRows)
transformRegistry.set('partition', partitionRows)
transformRegistry.set('treemap', treemapRows)
transformRegistry.set('tree', treeRows)
transformRegistry.set('force', forceRows)
transformRegistry.set('kde2d', kde2dRows)
transformRegistry.set('isocontour', isocontourRows)
transformRegistry.set('heatmap', heatmapRows)
transformRegistry.set('treelinks', treelinksRows)
transformRegistry.set('wordcloud', wordcloudRows)
transformRegistry.set('voronoi', voronoiRows)

// ---------------------------------------------------------------------------
// pie (vega Pie layout) — modifies rows with start/end angle fields
// ---------------------------------------------------------------------------

/** Pie and donut chart layout (vega Pie, ported operation-for-operation). */
function pieRows(rows: Row[], t: Record<string, unknown>): Row[] {
  const as = (t.as as [string, string]) ?? ['startAngle', 'endAngle']
  const startAngleField = as[0]!
  const endAngleField = as[1]!
  const field = (t.field as string | undefined) ?? null
  const start = (t.startAngle as number | undefined) ?? 0
  const stop = (t.endAngle as number | undefined) != null ? (t.endAngle as number) : 2 * Math.PI
  const values = rows.map((r) => (field ? (getField(r, field) as number) : 1))
  const n = values.length
  let a = start
  const k = (stop - start) / values.reduce((acc, v) => acc + (+v || 0), 0)
  const index = Array.from({ length: n }, (_, i) => i)
  if (t.sort) {
    index.sort((x, y) => values[x]! - values[y]!)
  }
  const out = rows.map((r) => ({ ...r }))
  for (let i = 0; i < n; ++i) {
    const v = values[index[i]!]!
    out[index[i]!]![startAngleField] = a
    a += v * k
    out[index[i]!]![endAngleField] = a
  }
  return out
}

// ---------------------------------------------------------------------------
// cross (vega Cross: self cross-product, generating)
// ---------------------------------------------------------------------------

function crossRows(rows: Row[], t: Record<string, unknown>, ctx: TransformContext): Row[] {
  const as = (t.as as [string, string]) ?? ['a', 'b']
  const a = as[0]!
  const b = as[1]!
  const filter = t.filter as string | undefined
  const test = filter && ctx.runtime.expr(filter)
  const out: Row[] = []
  const n = rows.length
  // Without a filter the output is exactly n*n rows: refuse it up front. With a
  // filter the n*n candidates are still evaluated, so the wall clock is sampled
  // inside the inner loop (C7).
  if (!test) checkRowCount(n * n, 'cross')
  for (let i = 0; i < n; ++i) {
    const left = rows[i]!
    meterTick('cross', n)
    for (let j = 0; j < n; ++j) {
      const cand: Row = { [a]: left, [b]: rows[j]! }
      if (!test || test(cand, ctx.signals)) {
        out.push(cand)
      }
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// dotbin (vega DotBin) — dot density binning (Wilkinson 1999), ported from
// vega's util/dotbin.js including the variance-smoothing pass.
// ---------------------------------------------------------------------------

function dotbinValues(array: number[], step: number, smooth: boolean): Float64Array {
  const n = array.length
  const v = new Float64Array(n)
  let i = 0
  let j = 1
  let a = array[0]!
  let b = a
  let w = a + step
  for (; j < n; ++j) {
    const x = array[j]!
    if (x >= w) {
      b = (a + b) / 2
      for (; i < j; ++i) v[i] = b
      w = x + step
      a = x
    }
    b = x
  }
  b = (a + b) / 2
  for (; i < j; ++i) v[i] = b
  if (smooth) {
    // smoothing: swap points between adjacent stacks (within step*1.25)
    const thresh = step + step / 4
    let sa = 0
    let sb = 1
    while (sb < n && v[sb] === v[sa]) ++sb
    while (sb < n) {
      let sc = sb + 1
      while (sc < n && v[sb] === v[sc]) ++sc
      if (v[sb]! - v[sb - 1]! < thresh) {
        const d = sb + ((sa + sc - sb - sb) >> 1)
        let dd = d
        while (dd < sb) v[dd++] = v[sb]!
        dd = d
        while (dd > sb) v[dd--] = v[sa]!
      }
      sa = sb
      sb = sc
    }
  }
  return v
}

function dotbinRows(rows: Row[], t: Record<string, unknown>, ctx: TransformContext): Row[] {
  const field = t.field as string
  const as = (t.as as string | undefined) ?? 'bin'
  const groupby = (t.groupby as string[] | undefined) ?? []
  const values = rows.map((r) => getField(r, field) as number)
  const extent = values.reduce<[number, number]>(([lo, hi], v) => [Math.min(lo, v), Math.max(hi, v)], [Infinity, -Infinity])
  const step = (t.step as number | undefined) ?? (extent[1] - extent[0]) / 30
  const smooth = t.smooth === true
  // stable sort by field value within groups (vega stableCompare)
  const groups = new Map<string, number[]>()
  if (groupby.length) {
    for (let i = 0; i < rows.length; ++i) {
      const key = groupby.map((f) => String(getField(rows[i]!, f))).join('|')
      let g = groups.get(key)
      if (!g) { g = []; groups.set(key, g) }
      g.push(i)
    }
  } else {
    groups.set('', rows.map((_, i) => i))
  }
  const sorted = rows.map((r, i) => ({ r, i }))
  sorted.sort((p, q) => (values[p.i] as number) - (values[q.i] as number))
  // compute bins per group over the sorted indices
  const out = rows.map((r) => ({ ...r }))
  const groupIndices = new Map<string, number[]>()
  for (const { i } of sorted) {
    const key = groupby.map((f) => String(getField(rows[i]!, f))).join('|')
    let g = groupIndices.get(key)
    if (!g) { g = []; groupIndices.set(key, g) }
    g.push(i)
  }
  for (const g of groupIndices.values()) {
    const gvals = g.map((i) => values[i] as number)
    const bins = dotbinValues(gvals, step, smooth)
    for (let k = 0; k < g.length; ++k) {
      out[g[k]!]![as] = bins[k]
    }
  }
  void ctx
  return out
}

// ---------------------------------------------------------------------------
// geopoint (vega-geo GeoPoint) — lon/lat -> x/y through a named projection
// ---------------------------------------------------------------------------

/**
 * A vega `field` parameter on a geo transform: a field name (an access path), or `{expr}` -- an
 * expression evaluated per datum (vega-lite writes a `datum` / `value` position this way).
 */
function geoAccessor(f: unknown, ctx: TransformContext): (r: Row) => unknown {
  if (f !== null && typeof f === 'object' && typeof (f as { expr?: unknown }).expr === 'string') {
    return compileExprTransform((f as { expr: string }).expr, ctx)
  }
  return (r) => getField(r, f as string)
}

function geopointRows(rows: Row[], t: Record<string, unknown>, ctx: TransformContext): Row[] {
  const projName = String(t.projection)
  const projection = ctx.projections?.get(projName) as GeoProjection | undefined
  if (!projection) throw new Error(`[aster] geopoint: unknown projection "${projName}"`)
  const fields = (t.fields as [unknown, unknown]) ?? ['lon', 'lat']
  const lon = geoAccessor(fields[0], ctx)
  const lat = geoAccessor(fields[1], ctx)
  const as = (t.as as [string, string]) ?? ['x', 'y']
  return rows.map((r) => {
    const xy = projection.project(lon(r) as number, lat(r) as number)
    return xy ? { ...r, [as[0]!]: xy[0], [as[1]!]: xy[1] } : { ...r, [as[0]!]: undefined, [as[1]!]: undefined }
  })
}

// ---------------------------------------------------------------------------
// geopath (vega-geo GeoPath) — the SVG path of each row's GeoJSON through a named projection
// ---------------------------------------------------------------------------

function geopathRows(rows: Row[], t: Record<string, unknown>, ctx: TransformContext): Row[] {
  // (a geopath without a projection draws with the default path: the coordinates as they are)
  let path: GeoPath | undefined
  if (t.projection == null) {
    if (!geoRegistry.defaultPath) requireGeo() // throws: the geo addon is not loaded
    path = geoRegistry.defaultPath!() as GeoPath
  } else {
    const projName = String(t.projection)
    path = (ctx.projections?.get(projName) as GeoProjection | undefined)?.path
    if (!path) throw new Error(`[aster] geopath: unknown projection "${projName}"`)
  }
  // (no field: the row itself is the GeoJSON feature)
  const field = t.field == null ? (r: Row): unknown => r : geoAccessor(t.field, ctx)
  const as = (t.as as string | undefined) || 'path'
  const radius = t.pointRadius != null ? (geoPointRadius(t.pointRadius, ctx) as PointRadius) : undefined
  return rows.map((r) => ({ ...r, [as]: path.draw(field(r), radius) }))
}

// ---------------------------------------------------------------------------
// geojson (vega-geo GeoJSON) — consolidate points/features into one GeoJSON
// object (the transform's value, published as the `signal` param, consumed by projection fit); rows unchanged.
// ---------------------------------------------------------------------------

function geojsonRows(rows: Row[], t: Record<string, unknown>, ctx: TransformContext): Row[] {
  const fields = t.fields as [unknown, unknown] | undefined
  const lon = fields ? geoAccessor(fields[0], ctx) : undefined
  const lat = fields ? geoAccessor(fields[1], ctx) : undefined
  // vega-geo: `geojson || (!fields && identity)` -- with neither, each row is itself a feature
  const geojson: ((r: Row) => unknown) | undefined = t.geojson != null ? geoAccessor(t.geojson, ctx) : fields ? undefined : (r) => r
  let features: unknown[] = []
  const points: [number, number][] = []
  if (geojson) for (const r of rows) features.push(geojson(r))
  if (lon && lat) {
    for (const r of rows) {
      let x = lon(r)
      let y = lat(r)
      if (x != null && y != null && (x = +(x as number)) === x && (y = +(y as number)) === y) points.push([x as number, y as number])
    }
    features = features.concat({ type: 'Feature', geometry: { type: 'MultiPoint', coordinates: points } })
  }
  if (typeof t.signal === 'string') {
    ctx.signals[t.signal] = { type: 'FeatureCollection', features }
    // a projection that fits this value is stale now
    ;(ctx.projections as { touch?: () => void } | undefined)?.touch?.()
  }
  return rows
}

// ---------------------------------------------------------------------------
// linkpath (vega-geo LinkPath) — edge paths between source/target points
// ---------------------------------------------------------------------------

const linkLine = (sx: number, sy: number, tx: number, ty: number) => 'M' + sx + ',' + sy + 'L' + tx + ',' + ty
const linkLineR = (sa: number, sr: number, ta: number, tr: number) => linkLine(sr * Math.cos(sa), sr * Math.sin(sa), tr * Math.cos(ta), tr * Math.sin(ta))
const linkArc = (sx: number, sy: number, tx: number, ty: number) => {
  const dx = tx - sx
  const dy = ty - sy
  const rr = Math.hypot(dx, dy) / 2
  const ra = (180 * Math.atan2(dy, dx)) / Math.PI
  return 'M' + sx + ',' + sy + 'A' + rr + ',' + rr + ' ' + ra + ' 0 1' + ' ' + tx + ',' + ty
}
const linkArcR = (sa: number, sr: number, ta: number, tr: number) => linkArc(sr * Math.cos(sa), sr * Math.sin(sa), tr * Math.cos(ta), tr * Math.sin(ta))
const linkCurve = (sx: number, sy: number, tx: number, ty: number) => {
  const dx = tx - sx
  const dy = ty - sy
  const ix = 0.2 * (dx + dy)
  const iy = 0.2 * (dy - dx)
  return 'M' + sx + ',' + sy + 'C' + (sx + ix) + ',' + (sy + iy) + ' ' + (tx + iy) + ',' + (ty - ix) + ' ' + tx + ',' + ty
}
const linkCurveR = (sa: number, sr: number, ta: number, tr: number) => linkCurve(sr * Math.cos(sa), sr * Math.sin(sa), tr * Math.cos(ta), tr * Math.sin(ta))
const linkOrthoX = (sx: number, sy: number, tx: number, ty: number) => 'M' + sx + ',' + sy + 'V' + ty + 'H' + tx
const linkOrthoY = (sx: number, sy: number, tx: number, ty: number) => 'M' + sx + ',' + sy + 'H' + tx + 'V' + ty
const linkOrthoR = (sa: number, sr: number, ta: number, tr: number) => {
  const sc = Math.cos(sa)
  const ss = Math.sin(sa)
  const tc = Math.cos(ta)
  const ts = Math.sin(ta)
  const sf = Math.abs(ta - sa) > Math.PI ? ta <= sa : ta > sa
  return 'M' + sr * sc + ',' + sr * ss + 'A' + sr + ',' + sr + ' 0 0,' + (sf ? 1 : 0) + ' ' + sr * tc + ',' + sr * ts + 'L' + tr * tc + ',' + tr * ts
}
const linkDiagonalX = (sx: number, sy: number, tx: number, ty: number) => {
  const m = (sx + tx) / 2
  return 'M' + sx + ',' + sy + 'C' + m + ',' + sy + ' ' + m + ',' + ty + ' ' + tx + ',' + ty
}
const linkDiagonalY = (sx: number, sy: number, tx: number, ty: number) => {
  const m = (sy + ty) / 2
  return 'M' + sx + ',' + sy + 'C' + sx + ',' + m + ' ' + tx + ',' + m + ' ' + tx + ',' + ty
}
const linkDiagonalR = (sa: number, sr: number, ta: number, tr: number) => {
  const sc = Math.cos(sa)
  const ss = Math.sin(sa)
  const tc = Math.cos(ta)
  const ts = Math.sin(ta)
  const mr = (sr + tr) / 2
  return 'M' + sr * sc + ',' + sr * ss + 'C' + mr * sc + ',' + mr * ss + ' ' + mr * tc + ',' + mr * ts + ' ' + tr * tc + ',' + tr * ts
}

const LINK_PATHS: Record<string, (sx: number, sy: number, tx: number, ty: number) => string> = {
  line: linkLine,
  'line-radial': linkLineR,
  arc: linkArc,
  'arc-radial': linkArcR,
  curve: linkCurve,
  'curve-radial': linkCurveR,
  'orthogonal-horizontal': linkOrthoX,
  'orthogonal-vertical': linkOrthoY,
  'orthogonal-radial': linkOrthoR,
  'diagonal-horizontal': linkDiagonalX,
  'diagonal-vertical': linkDiagonalY,
  'diagonal-radial': linkDiagonalR,
}

function linkpathRows(rows: Row[], t: Record<string, unknown>, ctx: TransformContext): Row[] {
  // (each endpoint is a field or an `{expr}`, like any vega `field` parameter)
  const sx = geoAccessor(t.sourceX ?? 'source.x', ctx)
  const sy = geoAccessor(t.sourceY ?? 'source.y', ctx)
  const tx = geoAccessor(t.targetX ?? 'target.x', ctx)
  const ty = geoAccessor(t.targetY ?? 'target.y', ctx)
  const as = (t.as as string | undefined) ?? 'path'
  const orient = (t.orient as string | undefined) ?? 'vertical'
  const shape = (t.shape as string | undefined) ?? 'line'
  const path = ownGet(LINK_PATHS, shape + '-' + orient) ?? ownGet(LINK_PATHS, shape)
  if (!path) throw new Error(`[aster] linkpath unsupported type: ${shape}${t.orient ? '-' + orient : ''}`)
  return rows.map((r) => ({ ...r, [as]: path(sx(r) as number, sy(r) as number, tx(r) as number, ty(r) as number) }))
}

// -- addon registration ------------------------------------------------------
transformRegistry.set('pie', pieRows)
transformRegistry.set('cross', crossRows)
transformRegistry.set('countpattern', countpatternStatsRows)
transformRegistry.set('dotbin', dotbinRows)
transformRegistry.set('geopoint', geopointRows)
transformRegistry.set('geopath', geopathRows)
transformRegistry.set('geojson', geojsonRows)
transformRegistry.set('linkpath', linkpathRows)
