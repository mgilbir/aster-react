/**
 * Rare-layout transforms (stats, hierarchy layouts, wordcloud, voronoi).
 * Loaded by the `@aster/core/transforms` addon; the core bundle keeps only
 * the transforms a plain chart uses. Shared internals come from transform.ts.
 */
import { error, hasOwnProperty, minOf, maxOf, ownGet, sortData } from './util.js'
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
import { voronoi, type Rect } from './voronoi.js'

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

/**
 * The vega `voronoi` transform: one SVG path per row, the outline of the row's Voronoi cell clipped to the `size` (from
 * the origin) or `extent` rectangle, or `[-1e5, 1e5]` on both axes without either. A row whose cell is missing, empty
 * or a single point gets `null`.
 */
function voronoiRows(rows: Row[], t: Record<string, unknown>, ctx: TransformContext): Row[] {
  const as = (t.as as string | undefined) ?? 'path'
  const xOf = fieldParam(t.x, ctx, 'x')
  const yOf = fieldParam(t.y, ctx, 'y')
  const size = resolveSizeParam(t.size, ctx)
  let bounds: Rect
  if (size) {
    bounds = { xmin: 0, ymin: 0, xmax: size[0], ymax: size[1] }
  } else if (Array.isArray(t.extent) && t.extent.length === 2) {
    const e = t.extent as [[number, number], [number, number]]
    bounds = { xmin: e[0][0], ymin: e[0][1], xmax: e[1][0], ymax: e[1][1] }
  } else {
    bounds = { xmin: -1e5, ymin: -1e5, xmax: 1e5, ymax: 1e5 }
  }
  if (!rows.length) return rows

  const points = new Float64Array(rows.length * 2)
  for (let i = 0; i < rows.length; i++) {
    points[2 * i] = xOf(rows[i]!) as number
    points[2 * i + 1] = yOf(rows[i]!) as number
  }
  const diagram = voronoi(points, bounds)
  return rows.map((row, i) => {
    meterTick('voronoi')
    return { ...row, [as]: diagram.path(i) }
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
 * The bit of one dimension, by the sorted order of its field (vega-crossfilter SortedIndex): the index permuted by the values, `<` / `>`
 * order (an incomparable pair is a tie); the tuples before the position of `from` and from the position of `to` on lie outside.
 */
function markOutsideSorted(data: Row[], f: (r: Row) => unknown, from: unknown, to: unknown, bit: number, curr: Uint32Array): void {
  const n = data.length
  const values = data.map((r) => f(r))
  const index = new Uint32Array(n)
  for (let i = 0; i < n; i++) index[i] = i
  Array.prototype.sort.call(index, (a: number, b: number) => (values[a]! < values[b]! ? -1 : values[a]! > values[b]! ? 1 : 0))
  const sorted = Array.from(index, (k) => values[k])
  const lo = bisectLeftValues(sorted, from)
  const hi = bisectLeftValues(sorted, to)
  for (let i = 0; i < lo; i++) curr[index[i]!]! |= bit
  for (let i = hi; i < n; i++) curr[index[i]!]! |= bit
}

/**
 * The same bit when no sort is needed: every value is a number (none NaN) and so is each end of the range, so the order is total and
 * a tuple sits before the position of `from` exactly when it is `< from`, and from the position of `to` on exactly when it is
 * `>= to` (an end that is NaN is the position past the last tuple: the one before it takes every tuple, the other none). Returns
 * false, having marked nothing, when a value or an end is anything else -- the sorted order of those is the sort's to say.
 */
function markOutsideNumeric(data: Row[], f: (r: Row) => unknown, from: unknown, to: unknown, bit: number, curr: Uint32Array): boolean {
  if (typeof from !== 'number' || typeof to !== 'number') return false
  const n = data.length
  const values = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const v = f(data[i]!)
    if (typeof v !== 'number' || v !== v) return false
    values[i] = v
  }
  // (an end that is NaN is the position n: below it is every tuple; from it on, none)
  const all = from !== from
  for (let i = 0; i < n; i++) {
    const v = values[i]!
    if (all || v < from || v >= to) curr[i]! |= bit
  }
  return true
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
    const range = query[d]!
    const bit = 1 << d
    if (!markOutsideNumeric(data, f, range[0], range[1], bit, curr)) markOutsideSorted(data, f, range[0], range[1], bit, curr)
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
    sortData(index, (x, y) => values[x]! - values[y]!)
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
  sortData(sorted, (p, q) => (values[p.i] as number) - (values[q.i] as number))
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
