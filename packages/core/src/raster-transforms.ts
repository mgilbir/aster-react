/**
 * The raster-grid transforms: `kde2d` (a density grid per group of points), `isocontour` (the level sets of grids as
 * GeoJSON MultiPolygons) and `heatmap` (a grid drawn as an image). The density estimate and the placement of
 * contours are in `raster-grid.ts`, the polygons in `contour.ts`. Loaded by the transforms addon; `isocontour`
 * needs the geo addon.
 */
import { isArray } from './util.js'
import { fieldOf } from './transform-agg.js'
import { compileExprTransform, contourQuantize } from './transform.js'
import { densityGrid, placeContours, type RasterGrid } from './raster-grid.js'
import { accessorOf as fieldAccessor, densitySettings, type DensitySettings, type Get } from './raster-params.js'
import type { Row, TransformContext } from './transform.js'
import { boundedCount } from './limits.js'
import { geoRegistry, requireGeo } from './registry.js'
import { parseExpression, type AstNode } from './expr-parser.js'
import { rgbConvert, type Rgb } from './color.js'
import { RasterImage } from './raster-image.js'

type Params = Record<string, unknown>

/** A `field`-typed parameter: a field name, or an `{expr}` evaluated over the tuple. */
const accessorOf = (f: unknown, ctx: TransformContext): Get => fieldAccessor(f, (expr) => compileExprTransform(expr, ctx) as Get)

/** The density grid of one group of points (`kde2d`). */
function densityOf(data: Row[], x: Get, y: Get, weight: Get | null, settings: DensitySettings, counts: boolean): RasterGrid {
  return densityGrid({
    xs: data.map((d) => x(d)),
    ys: data.map((d) => y(d)),
    weightAt: (i) => +(weight ? (weight(data[i]!) as number) : 1),
    size: settings.size,
    k: settings.k,
    bandwidth: settings.bandwidth,
    counts,
    label: 'kde2d grid',
  })
}

/** A density grid for each group of the points (all of them when there is no `groupby`). */
export function kde2dRows(rows: Row[], t: Params, ctx: TransformContext): Row[] {
  const settings = densitySettings(t)
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
    const out: Row = { [as]: densityOf(g, x, y, weight, settings, !!t.counts) }
    for (let i = 0; i < names.length; ++i) out[names[i]!] = g.dims![i]
    return out
  })
}

/** The largest number of a list, skipping NaN and missing entries. */
const max = (values: ArrayLike<number>): number | undefined => {
  if (values == null) throw new TypeError('values is not iterable') // (a grid with no cells)
  let m: number | undefined
  for (let i = 0; i < values.length; ++i) { const v = values[i]!; if (v != null && v >= v && (m === undefined || v > m)) m = v }
  return m
}

/** The level sets of each input grid, one tuple per level (the source's fields copied on). */
export function isocontourRows(rows: Row[], t: Params, ctx: TransformContext): Row[] {
  const field: Get = t.field == null ? (r) => r : accessorOf(t.field, ctx)
  const smooth = t.smooth !== false
  const contourRun = geoRegistry.contourRun
  if (!contourRun) requireGeo() // throws: the geo addon is not loaded

  // thresholds: given (a list, empty included), or `levels` quantized per grid (independent) or over the grids' maxima (shared)
  const quantize = contourQuantize((t.levels as number) || 10, !!t.nice, t.zero !== false)
  let tz = t.thresholds as number[] | ((values: Float32Array) => number[]) | undefined
  if (!tz) tz = t.resolve !== 'shared' ? quantize : quantize(rows.map((r) => max((field(r) as RasterGrid).values) as number))
  const as = t.as === null ? null : (t.as as string | undefined) || 'contour'

  const exprValue = (v: unknown, row: Row): unknown => {
    const e = exprOf(v)
    return e === undefined ? v : compileExprTransform(e, ctx)(row)
  }

  const out: Row[] = []
  for (const r of rows) {
    const grid = field(r) as RasterGrid
    const thresholds = isArray(tz) ? (tz as number[]) : (tz as (v: Float32Array) => number[])(grid.values)
    boundedCount(thresholds.length, 'isocontour thresholds')
    const paths = contourRun!(grid.values, thresholds, [Math.floor(grid.width), Math.floor(grid.height)], smooth)
      .map((f) => ({ type: f.type, value: f.value, coordinates: f.coordinates }))

    // `scale` and `translate` (a number or pair, or an expression of the row) place the polygons in view pixels
    const s = exprValue(t.scale || grid.scale, r)
    const tr = exprValue(t.translate || grid.translate, r) as number[] | undefined
    if (!((s === 1 || s == null) && !tr)) {
      const pair = (typeof s === 'number' ? [s, s] : s) as number[]
      placeContours(paths, [grid.x1 || 0, grid.y1 || 0], [pair[0] || 1, pair[1] || 1], [(tr && tr[0]) || 0, (tr && tr[1]) || 0])
    }
    for (const p of paths) out.push({ ...(as != null ? { [as]: p } : p), ...r })
  }
  return out
}

/**
 * The fields of `datum` an expression names (`datum.$x`, `datum['$value']`): what vega's code generator collects, and so what
 * it calls "depends on the pixel". A use it cannot see by name (`datum[name]`, `datum` handed to a function) is not one.
 */
function datumFieldsOf(expr: string): Set<string> {
  const names = new Set<string>()
  const visit = (n: unknown): void => {
    if (n === null || typeof n !== 'object') return
    if (Array.isArray(n)) { for (const x of n) visit(x); return }
    const node = n as AstNode
    if (node.type === 'MemberExpression') {
      const obj = node.object as AstNode
      const prop = node.property as AstNode
      if (obj.type === 'Identifier' && obj.name === 'datum') {
        if (!node.computed && prop.type === 'Identifier') names.add(String(prop.name))
        else if (node.computed && prop.type === 'Literal') names.add(String(prop.value))
      }
    }
    for (const k of Object.keys(node)) if (k !== 'type') visit(node[k])
  }
  visit(parseExpression(expr))
  return names
}

const exprOf = (v: unknown): string | undefined =>
  v !== null && typeof v === 'object' && typeof (v as { expr?: unknown }).expr === 'string' ? (v as { expr: string }).expr : undefined

/** What a heatmap parameter sees of a pixel: its position and cell value, and the grid's (or all grids') maximum. */
interface Pixel { $x: number; $y: number; $value: number; $max: number | undefined; [k: string]: unknown }

const PIXEL_FIELDS = ['$x', '$y', '$value', '$max']

/** A heatmap parameter: a constant, or an expression of the pixel. One that reads no pixel field is evaluated once per grid. */
interface PixelParam<T> {
  perPixel: boolean
  at(pixel: Pixel): T
}

const readsPixel = (expr: string): boolean => {
  const fields = datumFieldsOf(expr)
  return PIXEL_FIELDS.some((f) => fields.has(f))
}

function colorParam(t: Params, ctx: TransformContext): PixelParam<Rgb> {
  const expr = exprOf(t.color)
  if (expr === undefined) return { perPixel: false, at: () => rgbConvert(t.color || '#888') }
  const evaluate = compileExprTransform(expr, ctx)
  return { perPixel: readsPixel(expr), at: (pixel) => rgbConvert(evaluate(pixel as never)) }
}

function opacityParam(t: Params, ctx: TransformContext): PixelParam<number> {
  const expr = exprOf(t.opacity)
  if (expr !== undefined) {
    const evaluate = compileExprTransform(expr, ctx)
    return { perPixel: readsPixel(expr), at: (pixel) => evaluate(pixel as never) as number }
  }
  // no opacity, or a falsy one, is the gradient from 0 to the maximum
  if (!t.opacity) return { perPixel: true, at: (pixel) => (pixel.$value / (pixel.$max as number)) || 0 }
  return { perPixel: false, at: () => +(t.opacity as number) }
}

const constant = <T,>(value: T) => (): T => value

/** One RGBA pixel per cell of the grid's `[x1, x2) x [y1, y2)` window. */
function paintGrid(grid: RasterGrid, pixel: Pixel, color: PixelParam<Rgb>, opacity: PixelParam<number>): RasterImage {
  const colorOf = color.perPixel ? color.at : constant(color.at(pixel))
  const alphaOf = opacity.perPixel ? opacity.at : constant(opacity.at(pixel))

  const stride = grid.width
  const x1 = grid.x1 || 0
  const y1 = grid.y1 || 0
  const x2 = grid.x2 || stride
  const y2 = grid.y2 || grid.height
  const w = x2 - x1
  const h = y2 - y1
  boundedCount(w * h, 'heatmap pixels')
  const bytes = new Uint8ClampedArray(4 * w * h)
  const cells = grid.values
  let at = 0
  for (let j = y1; j < y2; ++j) {
    pixel.$y = j - y1
    for (let i = x1; i < x2; ++i, at += 4) {
      pixel.$x = i - x1
      pixel.$value = cells ? cells[i + j * stride]! : 0
      const rgb = colorOf(pixel)
      bytes[at] = rgb.r
      bytes[at + 1] = rgb.g
      bytes[at + 2] = rgb.b
      bytes[at + 3] = ~~(255 * alphaOf(pixel))
    }
  }
  return new RasterImage(w, h, bytes)
}

/** Each tuple's raster grid drawn as an image: colour from `color`, alpha from `opacity`, `resolve` choosing the maximum they see. */
export function heatmapRows(rows: Row[], t: Params, ctx: TransformContext): Row[] {
  const shared = t.resolve === 'shared'
  const field: Get = t.field == null ? (r) => r : accessorOf(t.field, ctx)
  const as = (t.as as string | undefined) || 'image'
  const color = colorParam(t, ctx)
  const opacity = opacityParam(t, ctx)

  const sharedMax = shared ? max(rows.map((r) => max((field(r) as RasterGrid).values) as number)) : 0
  return rows.map((r) => {
    const grid = field(r) as RasterGrid
    const pixel: Pixel = { ...r, $x: 0, $y: 0, $value: 0, $max: sharedMax }
    if (!shared) pixel.$max = max(grid.values || [])
    return { ...r, [as]: paintGrid(grid, pixel, color, opacity) }
  })
}
