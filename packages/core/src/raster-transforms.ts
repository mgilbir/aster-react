/**
 * The raster-grid transforms of vega-geo: `kde2d` (KDE2D: 2D kernel density estimates of point data, one raster
 * grid per group) and `isocontour` (Isocontour: the level sets of raster grids as GeoJSON MultiPolygons), ported
 * operation for operation (vega-geo 5.1.2 `util/density2D.js`, `util/quantize.js`, `util/contours.js` via the geo
 * addon's marching-squares engine). Loaded by the transforms addon; `isocontour` needs the geo addon.
 */
import { error, isArray } from './util.js'
import { fieldOf } from './transform-agg.js'
import { blurX, blurY, bwRadius, compileExprTransform, contourQuantize } from './transform.js'
import type { Row, TransformContext } from './transform.js'
import { boundedCount, meterRows } from './limits.js'
import { geoRegistry, requireGeo } from './registry.js'

type Params = Record<string, unknown>
type Get = (d: Row) => unknown

export interface RasterGrid {
  values: Float32Array
  scale: number
  width: number
  height: number
  x1: number
  y1: number
  x2: number
  y2: number
  translate?: number[]
}

/** A `field`-typed parameter: a field name, or an `{expr}` evaluated over the tuple. */
function accessorOf(f: unknown, ctx: TransformContext): Get {
  if (f !== null && typeof f === 'object' && typeof (f as { expr?: unknown }).expr === 'string') {
    return compileExprTransform((f as { expr: string }).expr, ctx) as Get
  }
  return fieldOf(f) as Get
}

const sum = (values: ArrayLike<number>): number => {
  let s = 0
  for (let i = 0; i < values.length; ++i) { const v = values[i]!; if (v != null && !isNaN(v)) s += v }
  return s
}

/** vega-geo `density2D()(data, counts)`: bin the points, blur the bins (three box blurs), scale to a density. */
function density2D(data: Row[], x: Get, y: Get, weight: Get | null, size: [number, number], cellSize: number | undefined, bandwidth: [number, number], counts: boolean): RasterGrid {
  const k = cellSize === undefined ? 2 : Math.floor(Math.log(cellSize) / Math.LN2)
  const [dx, dy] = size
  const xs = data.map((d) => +(x(d) as number))
  const ys = data.map((d) => +(y(d) as number))
  const rx = bwRadius(bandwidth[0], xs) >> k // blur x-radius
  const ry = bwRadius(bandwidth[1], ys) >> k // blur y-radius
  const ox = rx ? rx + 2 : 0 // x-offset padding for blur
  const oy = ry ? ry + 2 : 0 // y-offset padding for blur
  const n = 2 * ox + (dx >> k) // grid width
  const m = 2 * oy + (dy >> k) // grid height
  // the grid is sized by spec parameters (size, bandwidth): bound it before allocating
  meterRows(n * m, 'kde2d grid')
  const values0 = new Float32Array(n * m)
  const values1 = new Float32Array(n * m)
  let values = values0

  for (let i = 0; i < data.length; ++i) {
    const xi = ox + (xs[i]! >> k)
    const yi = oy + (ys[i]! >> k)
    if (xi >= 0 && xi < n && yi >= 0 && yi < m) values0[xi + yi * n]! += +(weight ? (weight(data[i]!) as number) : 1)
  }

  if (rx > 0 && ry > 0) {
    blurX(n, m, values0, values1, rx)
    blurY(n, m, values1, values0, ry)
    blurX(n, m, values0, values1, rx)
    blurY(n, m, values1, values0, ry)
    blurX(n, m, values0, values1, rx)
    blurY(n, m, values1, values0, ry)
  } else if (rx > 0) {
    blurX(n, m, values0, values1, rx)
    blurX(n, m, values1, values0, rx)
    blurX(n, m, values0, values1, rx)
    values = values1
  } else if (ry > 0) {
    blurY(n, m, values0, values1, ry)
    blurY(n, m, values1, values0, ry)
    blurY(n, m, values0, values1, ry)
    values = values1
  }

  // scale density estimates: density in points per square pixel or probability density
  const s = counts ? Math.pow(2, -2 * k) : 1 / sum(values)
  for (let i = 0, sz = n * m; i < sz; ++i) values[i]! *= s

  return { values, scale: 1 << k, width: n, height: m, x1: ox, y1: oy, x2: ox + (dx >> k), y2: oy + (dy >> k) }
}

/** vega-geo KDE2D. */
export function kde2dRows(rows: Row[], t: Params, ctx: TransformContext): Row[] {
  if (t.size == null || t.x == null || t.y == null) error('Missing required "kde2d" parameter: size, x and y.')
  const size = (t.size as unknown[]).map((v) => +(v as number)) as [number, number]
  if (!(size[0] >= 0 && size[1] >= 0)) error('invalid size')
  if (t.cellSize != null && !(+(t.cellSize as number) >= 1)) error('invalid cell size')
  let bandwidth: [number, number] = [-1, -1]
  if (t.bandwidth != null) {
    const b = ([] as unknown[]).concat(t.bandwidth)
    if (b.length === 1) bandwidth = [+(b[0] as number), +(b[0] as number)]
    else if (b.length === 2) bandwidth = [+(b[0] as number), +(b[1] as number)]
    else error('invalid bandwidth')
  }
  const x = accessorOf(t.x, ctx)
  const y = accessorOf(t.y, ctx)
  const weight = t.weight != null ? accessorOf(t.weight, ctx) : null
  const groupby = t.groupby != null ? ([] as unknown[]).concat(t.groupby).map((g) => fieldOf(g) as Get) : null
  const names = groupby ? ([] as unknown[]).concat(t.groupby).map((g) => String(g)) : []
  const as = (t.as as string | undefined) || 'grid'

  // partition the points into groups (by the String of the key tuple, in first-appearance order)
  const groups: Array<Row[] & { dims?: unknown[] }> = []
  if (groupby == null) groups.push(rows)
  else {
    const map = new Map<string, Row[] & { dims?: unknown[] }>()
    for (const row of rows) {
      const key = groupby.map((get) => get(row))
      const ks = String(key)
      let g = map.get(ks)
      if (!g) { map.set(ks, (g = [] as Row[] & { dims?: unknown[] })); g.dims = key; groups.push(g) }
      g.push(row)
    }
  }
  return groups.map((g) => {
    const out: Row = { [as]: density2D(g, x, y, weight, size, t.cellSize == null ? undefined : +(t.cellSize as number), bandwidth, !!t.counts) }
    for (let i = 0; i < names.length; ++i) out[names[i]!] = g.dims![i]
    return out
  })
}

const max = (values: ArrayLike<number>): number | undefined => {
  let m: number | undefined
  for (let i = 0; i < values.length; ++i) { const v = values[i]!; if (v != null && v >= v && (m === undefined || v > m)) m = v }
  return m
}

/** vega-geo Isocontour: the level sets of each input grid, one tuple per level (the source's fields copied on). */
export function isocontourRows(rows: Row[], t: Params, ctx: TransformContext): Row[] {
  const field: Get = t.field == null ? (r) => r : accessorOf(t.field, ctx)
  const smooth = t.smooth !== false
  const contourRun = geoRegistry.contourRun
  if (!contourRun) requireGeo() // throws: the geo addon is not loaded

  // thresholds: given, or `levels` quantized per grid (independent) or over the grids' maxima (shared)
  const quantize = contourQuantize(+(t.levels as number) || 10, !!t.nice, t.zero !== false)
  let tz: number[] | ((values: Float32Array) => number[])
  if (t.thresholds != null) tz = ([] as unknown[]).concat(t.thresholds).map((v) => +(v as number))
  else tz = t.resolve !== 'shared' ? quantize : quantize(rows.map((r) => max((field(r) as RasterGrid).values) as number))
  const as = t.as === null ? null : (t.as as string | undefined) || 'contour'

  const out: Row[] = []
  for (const r of rows) {
    const grid = field(r) as RasterGrid
    const thresholds = isArray(tz) ? (tz as number[]) : (tz as (v: Float32Array) => number[])(grid.values)
    boundedCount(thresholds.length, 'isocontour thresholds')
    const paths = contourRun!(grid.values, thresholds, [Math.floor(grid.width), Math.floor(grid.height)], smooth)
      .map((f) => ({ type: f.type, value: f.value, coordinates: f.coordinates }))

    // adjust contour path coordinates as needed (vega-geo Isocontour transformPaths)
    let s: unknown = t.scale ?? grid.scale
    let tr: unknown = t.translate ?? grid.translate
    if (typeof s === 'object' && s !== null && typeof (s as { expr?: unknown }).expr === 'string') s = compileExprTransform((s as { expr: string }).expr, ctx)(r)
    if (typeof tr === 'object' && tr !== null && !isArray(tr) && typeof (tr as { expr?: unknown }).expr === 'string') tr = compileExprTransform((tr as { expr: string }).expr, ctx)(r)
    if (!((s === 1 || s == null) && !tr)) {
      const sx = ((typeof s === 'number' ? s : (s as number[])[0]) || 1)
      const sy = ((typeof s === 'number' ? s : (s as number[])[1]) || 1)
      const tv = tr as number[] | undefined
      const tx = (tv && tv[0]) || 0
      const ty = (tv && tv[1]) || 0
      const x1 = grid.x1 || 0
      const y1 = grid.y1 || 0
      const flip = sx * sy < 0
      for (const geometry of paths) {
        for (const polygon of geometry.coordinates as number[][][][]) {
          for (const ring of polygon) {
            if (flip) ring.reverse() // maintain winding order
            for (const point of ring) {
              point[0] = (point[0]! - x1) * sx + tx
              point[1] = (point[1]! - y1) * sy + ty
            }
          }
        }
      }
    }
    // ingest; copy source data properties to output
    for (const p of paths) out.push({ ...(as != null ? { [as]: p } : p), ...r })
  }
  return out
}
