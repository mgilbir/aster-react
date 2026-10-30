/**
 * Eager row transforms. Vega's dataflow applies these reactively; for the static
 * execution mode we apply the same semantics eagerly against the current rows.
 * Each transform is a pure `(rows, params) -> rows` (plus expression/context).
 */
import type { CompiledTransform, SortSpec } from './types.js'
import type { ExpressionRuntime } from './expression.js'
import { type ContourFeature, SHAPE_BOUNDS, geoRegistry, requireGeo, requireTransform } from './registry.js'
import { isArray, sortData } from './util.js'
import { densityGrid, placeContours } from './raster-grid.js'
import { accessorOf, densitySettings } from './raster-params.js'
import { PARAM_RULES, checkParams } from './param-rules.js'
import { tickStep } from './arr.js'
import { activeMeter, boundedCount } from './limits.js'
import { walkPostOrder, walkPreOrder } from './tree-walk.js'
import { aggregateRows, type AggregateParams, compareOf, fieldOf, joinAggregateRows, pivotRows, sortBySpec, windowRows } from './transform-agg.js'
import {
  binRows, collectRows, d3Range, extentOfField, flattenRows, foldRows, identifierRows, imputeRows,
  lookupRows, projectRows, required, sampleRows, sequenceRows, stackRows, timeunitRows,
} from './transform-basic.js'

export { d3Range }

/** One group's aggregate tuple (the incremental aggregate re-derives only dirty groups). */
export function aggregateGroup(group: Row[], t: CompiledTransform, random?: () => number): Row {
  return aggregateRows(group, t as AggregateParams, random)[0]!
}

export interface TransformContext {
  runtime: ExpressionRuntime
  /** Signal values by name. Must be prototype-less (the runtime supplies `dict(...)`): names are spec-supplied. */
  signals: Record<string, unknown>
  /** Cross-dataset lookup (used by 'lookup', deferred). */
  datasets?: (name: string) => unknown[] | undefined
  /** Hierarchy trees built by the `stratify` transform, keyed by data source name. */
  hierarchies?: Map<string, unknown>
  /** Cartographic projections, for the `geoshape` transform's `projection` param. */
  projections?: Map<string, unknown>
  /**
   * The rows are the caller's own to change (a mark's encoded items): a layout that vega runs in place (`force`)
   * does not copy them first.
   */
  inPlace?: boolean
  /**
   * A named mark's container (`marktype` and its `items`; for a group mark, the group items): the marks the `label`
   * transform avoids. Absent where there are no marks (a dataset's transform).
   */
  marks?: (name: string) => unknown
}

export type Row = Record<string, unknown>

export function applyTransforms(
  rows: Row[],
  transforms: CompiledTransform[],
  ctx: TransformContext,
  sourceName?: string,
): Row[] {
  let out = rows
  const meter = activeMeter()
  for (const t of transforms) {
    if (meter) meter.clock.check(`transform ${t.type}`)
    out = applyTransform(out, t, ctx, sourceName)
    if (meter) {
      // Whatever a transform produced is a dataset like any other: it may not
      // exceed maxRows, and rows beyond the input count as generated (C7/C9).
      meter.checkRows(out.length, `transform ${t.type}`)
      meter.generated(out.length - rows.length, `transform ${t.type}`)
    }
  }
  return out
}

/** Whether a (nested) param value holds a `{signal: ...}` reference. */
function containsSignal(v: unknown, depth = 0): boolean {
  if (v === null || typeof v !== 'object' || depth > 6) return false
  if (isArray(v)) return (v as unknown[]).some((x) => containsSignal(x, depth + 1))
  const o = v as Record<string, unknown>
  if (typeof o.signal === 'string' && Object.keys(o).length === 1) return true
  return Object.keys(o).some((k) => containsSignal(o[k], depth + 1))
}

/** A parameter value that is a lone `{signal: <expression>}`. */
function isSignalRef(v: unknown): boolean {
  return v !== null && typeof v === 'object' && !isArray(v) && typeof (v as { signal?: unknown }).signal === 'string' && Object.keys(v as object).length === 1
}

const signalParams = new WeakMap<object, boolean>()

/**
 * Vega lets any transform parameter be a `{signal: <expression>}`; evaluate
 * those against the current signals before the transform runs. Transforms with
 * no signal param (the common case, and every row-local re-application) are
 * returned untouched.
 */
function resolveSignalParams(t: CompiledTransform, ctx: TransformContext): CompiledTransform {
  let has = signalParams.get(t)
  if (has === undefined) {
    has = containsSignal(t)
    signalParams.set(t, has)
  }
  if (!has) return t
  const resolve = (v: unknown, depth: number): unknown => {
    if (v === null || typeof v !== 'object' || depth > 6) return v
    if (isArray(v)) return (v as unknown[]).map((x) => resolve(x, depth + 1))
    const o = v as Record<string, unknown>
    if (typeof o.signal === 'string' && Object.keys(o).length === 1) {
      // (vega-parser Scope.signalRef: the name of a declared signal is that signal, not an expression -- `static`,
      // a reserved word to the expression parser, is a fine signal name)
      return Object.hasOwn(ctx.signals, o.signal) ? ctx.signals[o.signal] : ctx.runtime.expr(o.signal)({}, ctx.signals)
    }
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    for (const k of Object.keys(o)) out[k] = resolve(o[k], depth + 1)
    return out
  }
  return resolve(t, 0) as CompiledTransform
}

function applyTransform(rows: Row[], t0: CompiledTransform, ctx: TransformContext, sourceName?: string): Row[] {
  const rules = PARAM_RULES.get(t0.type as string)
  if (rules) checkParams(t0 as Record<string, unknown>, rules)
  const t = resolveSignalParams(t0, ctx)
  switch (t.type) {
    case 'formula': {
      required('formula', t, 'expr', 'as')
      const expr = compileExprTransform(t.expr as string, ctx)
      const as = t.as as string
      return rows.map((r) => ({ ...r, [as]: expr(r) }))
    }
    case 'filter': {
      required('filter', t, 'expr')
      const expr = compileExprTransform(t.expr as string, ctx)
      return rows.filter((r) => expr(r))
    }
    case 'collect':
      return collectRows(rows, t)
    case 'sample':
      return sampleRows(rows, t, ctx.runtime.random)
    case 'fold':
      return foldRows(rows, t)
    case 'flatten':
      return flattenRows(rows, t)
    case 'bin':
      return binRows(rows, t, (b) => {
        if (t.signal) ctx.signals[t.signal as string] = b
      })
    case 'impute':
      return imputeRows(rows, t)
    case 'aggregate':
      return aggregateRows(rows, t, ctx.runtime.random)
    case 'joinaggregate':
      return joinAggregateRows(rows, t, ctx.runtime.random)
    case 'window':
      return windowRows(rows, t, ctx.runtime.random)
    case 'stack':
      return stackRows(rows, t)
    case 'extent': {
      const ext = extentOfField(rows, t)
      if (t.signal) ctx.signals[t.signal as string] = ext
      return rows
    }
    case 'geoshape': {
      // Vega's geoshape transform turns each datum's GeoJSON geometry into an
      // SVG path (default field is the whole datum, default output 'shape').
      // With a `projection` param the geometry is projected first.
      const as = (t as { as?: unknown }).as ?? 'shape'
      const field = (t as { field?: unknown }).field
      const projName = (t as { projection?: unknown }).projection
      const projection = projName != null ? ctx.projections?.get(String(projName)) : undefined
      if (projection != null && !geoRegistry.projectedPath) requireGeo() // throws: addon not loaded
      const pointRadius = geoPointRadius((t as { pointRadius?: unknown }).pointRadius, ctx)
      return rows.map((r) => {
        // vega's field is read off the scenegraph ITEM (`datum["geo"]` is item.datum.geo); a row here is the item's datum
        const geo = field == null || field === 'datum' ? r : getField({ datum: r }, field as string)
        // a projected shape's path and its unrounded bounds (for the bound pass) come from one pass over the geometry
        const shape = projection != null && as === 'shape' && geoRegistry.projectedShape ? geoRegistry.projectedShape(projection, geo, pointRadius) : undefined
        const p = shape
          ? shape.path
          : projection != null
            ? geoRegistry.projectedPath!(projection, geo, pointRadius)
            : geoJSONPath(geo)
        if (p === undefined) return r
        const out = { ...r, [as as string]: p }
        if (shape) SHAPE_BOUNDS.set(out, () => shape.bounds)
        return out
      })
    }
    case 'crossfilter':
      return requireTransform('crossfilter')(rows, t as Record<string, unknown>, ctx, sourceName)
    case 'resolvefilter':
      return requireTransform('resolvefilter')(rows, t as Record<string, unknown>, ctx, sourceName)
    case 'kde':
      return requireTransform('kde')(rows, t as Record<string, unknown>, ctx, sourceName)
    case 'pie':
      return requireTransform('pie')(rows, t as Record<string, unknown>, ctx, sourceName)
    case 'cross':
      return requireTransform('cross')(rows, t as Record<string, unknown>, ctx, sourceName)
    case 'countpattern':
      return requireTransform('countpattern')(rows, t as Record<string, unknown>, ctx, sourceName)
    case 'dotbin':
      return requireTransform('dotbin')(rows, t as Record<string, unknown>, ctx, sourceName)
    case 'geopath':
      return requireTransform('geopath')(rows, t as Record<string, unknown>, ctx, sourceName)
    case 'geopoint':
      return requireTransform('geopoint')(rows, t as Record<string, unknown>, ctx, sourceName)
    case 'geojson':
      return requireTransform('geojson')(rows, t as Record<string, unknown>, ctx, sourceName)
    case 'linkpath':
      return requireTransform('linkpath')(rows, t as Record<string, unknown>, ctx, sourceName)
    case 'project':
      return projectRows(rows, t)
    case 'quantile':
      return requireTransform('quantile')(rows, t as Record<string, unknown>, ctx, sourceName)
    case 'regression':
      return requireTransform('regression')(rows, t as Record<string, unknown>, ctx, sourceName)
    case 'loess':
      return requireTransform('loess')(rows, t as Record<string, unknown>, ctx, sourceName)
    case 'density':
      return requireTransform('density')(rows, t as Record<string, unknown>, ctx, sourceName)
    case 'lookup':
      return lookupRows(rows, t, (ctx.datasets?.(t.from as string) ?? []) as Row[])
    case 'stratify': {
      // Vega's Stratify transform builds a hierarchy from flat parent/child
      // data but emits the ORIGINAL tuples unchanged: depth/height/y layout
      // fields are only added by tree layout transforms (tree, treelinks),
      // not by stratify itself. A pass-through reproduces the oracle output.
      // The built tree is stashed on the transform context (keyed by the data
      // source name) so a later tree-layout transform such as `pack` can lay
      // it out, mirroring vega's `pulse.source.root` handoff.
      if (sourceName && ctx.hierarchies) {
        const strat = t as { key?: string; parentKey?: string }
        ctx.hierarchies.set(sourceName, buildStratifyTree(rows, strat.key, strat.parentKey))
      }
      return rows
    }
    case 'pack':
      return requireTransform('pack')(rows, t as Record<string, unknown>, ctx, sourceName)
    case 'partition':
      return requireTransform('partition')(rows, t as Record<string, unknown>, ctx, sourceName)
    case 'treelinks':
      return requireTransform('treelinks')(rows, t as Record<string, unknown>, ctx, sourceName)
    case 'force': {
      // (which parameters were `{signal}`s matters to the simulation: see force-layout.ts)
      const dynamicParams = new Set(Object.keys(t0).filter((k) => {
        const v = (t0 as Record<string, unknown>)[k]
        // (an expression, not the bare name of a declared signal: that is the signal's own operator)
        return isSignalRef(v) && !Object.hasOwn(ctx.signals, (v as { signal: string }).signal)
      }))
      return requireTransform('force')(rows, t as Record<string, unknown>, { ...ctx, dynamicParams }, sourceName)
    }
    case 'tree':
      return requireTransform('tree')(rows, t as Record<string, unknown>, ctx, sourceName)
    case 'treemap':
      return requireTransform('treemap')(rows, t as Record<string, unknown>, ctx, sourceName)
    case 'sequence':
      // Vega appends generated tuples to the current pulse (a sequence on a
      // non-empty source keeps the source rows first).
      return rows.length ? [...rows, ...sequenceRows(t)] : sequenceRows(t)
    case 'graticule':
      return graticuleRows(t as Record<string, unknown>)
    case 'contour':
      return contourRows(rows, t as Record<string, unknown>, ctx)
    case 'kde2d':
      return requireTransform('kde2d')(rows, t as Record<string, unknown>, ctx, sourceName)
    case 'isocontour':
      return requireTransform('isocontour')(rows, t as Record<string, unknown>, ctx, sourceName)
    case 'heatmap':
      return requireTransform('heatmap')(rows, t as Record<string, unknown>, ctx, sourceName)
    case 'wordcloud':
      return requireTransform('wordcloud')(rows, t as Record<string, unknown>, ctx, sourceName)
    case 'voronoi':
      return requireTransform('voronoi')(rows, t as Record<string, unknown>, ctx, sourceName)
    case 'label':
      return requireTransform('label')(rows, t as Record<string, unknown>, ctx, sourceName)
    case 'timeunit':
      return timeunitRows(rows, t, (info) => {
        if (t.signal) ctx.signals[t.signal as string] = info
      })
    case 'identifier':
      return identifierRows(rows, t)
    case 'pivot':
      return pivotRows(rows, t as { field?: unknown; value?: unknown })
    default:
      throw new Error(`[aster] unsupported transform type "${(t as { type: string }).type}"`)
  }
}

/** A geo transform's `pointRadius`: a number, or `{expr}` -- an expression of the GeoJSON object being drawn. */
export function geoPointRadius(param: unknown, ctx: TransformContext): unknown {
  if (param == null || typeof param !== 'object' || typeof (param as { expr?: unknown }).expr !== 'string') return param
  const radius = compileExprTransform((param as { expr: string }).expr, ctx)
  return (feature: unknown): number => +(radius(feature as Row) as number)
}

export function compileExprTransform(expr: string, ctx: TransformContext) {
  const fn = ctx.runtime.expr(expr)
  return (datum: Row): unknown => fn(datum, ctx.signals)
}

export function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

export function collectField(rows: Row[], field: string | null | undefined): unknown[] {
  if (!field) return []
  const out: unknown[] = []
  for (const r of rows) out.push(r[field])
  return out
}

/**
 * Resolve a `[w, h]` size parameter whose entries may be numbers or signal
 * references (e.g. `[{signal: "width"}, {signal: "height"}]`). Returns
 * undefined when the parameter is missing or cannot be resolved.
 */
export function resolveSizeParam(size: unknown, ctx: TransformContext): [number, number] | undefined {
  if (!Array.isArray(size) || size.length !== 2) return undefined
  const resolve = (v: unknown): number | undefined => {
    if (typeof v === 'number' && Number.isFinite(v)) return v
    if (v != null && typeof v === 'object' && 'signal' in v) {
      const sv = ctx.signals[(v as { signal: string }).signal]
      if (typeof sv === 'number' && Number.isFinite(sv)) return sv
    }
    return undefined
  }
  const a = resolve(size[0])
  const b = resolve(size[1])
  return a !== undefined && b !== undefined ? [a, b] : undefined
}

// ---------------------------------------------------------------------------
// sorting
// ---------------------------------------------------------------------------

type RowCompare = (a: Row, b: Row) => number

const sortComparators = new WeakMap<object, RowCompare | null>()

/** The vega `compare` comparator of a sort spec (nulls first, NaN ties), or `null` when it names no field. */
function comparatorOf(sort?: SortSpec): RowCompare | null {
  if (!sort || typeof sort !== 'object') return null
  let c = sortComparators.get(sort)
  if (c === undefined) {
    c = compareOf(sort) as unknown as RowCompare | null
    sortComparators.set(sort, c)
  }
  return c
}

export function sortRows(rows: Row[], sort?: SortSpec): Row[] {
  return sortBySpec(rows, sort) ?? rows
}

/** Comparator for a `SortSpec` (used by collect and the incremental order). */
export function compareRows(a: Row, b: Row, sort?: SortSpec): number {
  const c = comparatorOf(sort)
  return c ? c(a, b) : 0
}

/** Stable input-index order produced by a collect/sample sort. */
export function sortOrder(rows: Row[], sort?: SortSpec, limit = Infinity): number[] {
  const order = rows.map((_, i) => i)
  const c = comparatorOf(sort)
  if (c) sortData(order, (a, b) => c(rows[a]!, rows[b]!) || a - b)
  return Number.isFinite(limit) ? order.slice(0, Math.max(0, limit)) : order
}

// ---------------------------------------------------------------------------
// bin
// ---------------------------------------------------------------------------

/**
 * Compute a "nice" step size using the vega-statistics/bin.js algorithm.
 * This produces a step that is a power of a base (default 10), adjusted
 * so that ceil(span/step) <= maxbins, then refined by dividing by factors.
 */
export function computeBinStep(span: number, maxbins: number | undefined): number {
  if (span <= 0 || !Number.isFinite(span)) return 1
  const m = maxbins ?? 20
  if (m < 1) return span

  const base = 10
  const logb = Math.log(base)

  // Initial step: power of base that is close to span/maxbins
  const level = Math.ceil(Math.log(m) / logb)
  const raw = Math.round(Math.log(span) / logb) - level
  let step = Math.pow(base, raw)
  if (step <= 0) step = 1

  // Increase step if too many bins
  while (Math.ceil(span / step) > m) {
    step *= base
  }

  // Decrease step if allowed (try dividing by each factor)
  for (const div of [5, 2]) {
    const v = step / div
    if (v > 0 && span / v <= m) {
      step = v
    }
  }

  return step
}

/**
 * Compute epsilon for nice extent rounding.
 * Matches vega-statistics/bin.js: eps = base^(-precision-1) where precision
 * is derived from the step's log.
 */
export function computeBinEps(step: number): number {
  if (step <= 0) return 0.01
  const logb = Math.log(10)
  const vlog = Math.log(step)
  const precision = vlog >= 0 ? 0 : ~~(-vlog / logb) + 1
  return Math.pow(10, -precision - 1)
}

// ---------------------------------------------------------------------------
// impute
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// aggregate / window / stack
// ---------------------------------------------------------------------------

export function groupRows(rows: Row[], keys: string[]): Row[][] {
  if (!keys.length) return rows.length ? [rows] : []
  const map = new Map<string, Row[]>()
  for (const r of rows) {
    const key = keys.map((k) => String(r[k])).join('\u0000')
    let g = map.get(key)
    if (!g) map.set(key, (g = []))
    g.push(r)
  }
  return [...map.values()]
}

// ---------------------------------------------------------------------------
// geoshape: GeoJSON -> SVG path (identity projection)
// ---------------------------------------------------------------------------

function fmtCoord(v: unknown): string {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return String(v)
  return String(Math.round(n * 1000) / 1000)
}

/** Build the SVG path for a GeoJSON polygon ring (closing point omitted). */
function ringPath(ring: unknown[]): string {
  if (!ring.length) return ''
  const pts = ring as unknown[][]
  const n = pts.length
  let d = `M${fmtCoord(pts[0]![0])},${fmtCoord(pts[0]![1])}`
  for (let i = 1; i < n; i++) {
    // GeoJSON rings repeat the first point at the end; d3-geo omits it because
    // the path closes with Z.
    if (i === n - 1 && pts[i]![0] === pts[0]![0] && pts[i]![1] === pts[0]![1]) break
    d += `L${fmtCoord(pts[i]![0])},${fmtCoord(pts[i]![1])}`
  }
  return d + 'Z'
}

function lineStringPath(pts: unknown[][]): string {
  if (!pts.length) return ''
  let d = `M${fmtCoord(pts[0]![0])},${fmtCoord(pts[0]![1])}`
  for (let i = 1; i < pts.length; i++) d += `L${fmtCoord(pts[i]![0])},${fmtCoord(pts[i]![1])}`
  return d
}

/**
 * Convert a GeoJSON geometry (or Feature / FeatureCollection) into an SVG path
 * string using an identity projection (no projection). Returns undefined when
 * the geometry type is not handled.
 */
export function geoJSONPath(geo: unknown): string | undefined {
  if (geo == null || typeof geo !== 'object') return undefined
  const g = geo as { type?: string; geometry?: unknown; coordinates?: unknown; features?: unknown[] }
  if (g.type === 'Feature') return geoJSONPath(g.geometry)
  if (g.type === 'FeatureCollection' && Array.isArray(g.features)) {
    let out = ''
    for (const f of g.features) {
      const p = geoJSONPath(f)
      if (p !== undefined) out += p
    }
    return out || undefined
  }
  const coords = g.coordinates
  if (g.type === 'Polygon' && Array.isArray(coords)) {
    return (coords as unknown[][]).map(ringPath).join('')
  }
  if (g.type === 'MultiPolygon' && Array.isArray(coords)) {
    let out = ''
    for (const poly of coords as unknown[][][]) {
      for (const ring of poly) out += ringPath(ring)
    }
    return out
  }
  if (g.type === 'LineString' && Array.isArray(coords)) {
    return lineStringPath(coords as unknown[][])
  }
  if (g.type === 'MultiLineString' && Array.isArray(coords)) {
    let out = ''
    for (const line of coords as unknown[][][]) out += lineStringPath(line)
    return out
  }
  return undefined
}

// ---------------------------------------------------------------------------
// kde / quantile / regression
//
// These are "generating" transforms: they consume the input rows and produce a
// fresh set of tuples (each output row carries only the groupby dims plus the
// transform's own `as` fields), matching vega's semantics. The arithmetic below
// mirrors vega-statistics (and the d3-array functions it wraps) operation for
// operation so the conformance oracle and our output agree to the bit.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// sequence / graticule (generating transforms)
// ---------------------------------------------------------------------------

const GEO_EPSILON = 1e-6

/** d3-geo graticuleX: latitude samples along a meridian (step 90, clipped). */
function graticuleX(y0: number, y1: number, dy: number): (x: number) => number[][] {
  const y = d3Range(y0, y1 - GEO_EPSILON, dy).concat(y1)
  return (x) => y.map((yy) => [x, yy])
}

/** d3-geo graticuleY: longitude samples along a parallel (precision spacing). */
function graticuleY(x0: number, x1: number, dx: number): (y: number) => number[][] {
  const x = d3Range(x0, x1 - GEO_EPSILON, dx).concat(x1)
  return (yy) => x.map((xx) => [xx, yy])
}

/**
 * The vega `graticule` transform: generate a single GeoJSON MultiLineString
 * geometry of latitude/longitude grid lines (d3-geo `geoGraticule` algorithm).
 * Reproduced operation-for-operation so the generated coordinates (and the
 * identity-projected SVG paths rendered from them) match the oracle to the bit.
 */
function graticuleRows(t: Record<string, unknown>): Row[] {
  let x0 = -180, x1 = 180, X0 = -180, X1 = 180
  let y0 = -80 - GEO_EPSILON, y1 = 80 + GEO_EPSILON
  let Y0 = -90 + GEO_EPSILON, Y1 = 90 - GEO_EPSILON
  let dx = 10, dy = 10, DX = 90, DY = 360
  let precision = 2.5

  const recompute = () => {
    X = graticuleX(Y0, Y1, 90)
    Y = graticuleY(X0, X1, precision)
    x = graticuleX(y0, y1, 90)
    y = graticuleY(x0, x1, precision)
  }
  let X: (v: number) => number[][] = () => []
  let Y: (v: number) => number[][] = () => []
  let x: (v: number) => number[][] = () => []
  let y: (v: number) => number[][] = () => []

  const extentMajor = (e: number[][]) => {
    X0 = e[0]![0]!, X1 = e[1]![0]!, Y0 = e[0]![1]!, Y1 = e[1]![1]!
    recompute()
  }
  const extentMinor = (e: number[][]) => {
    x0 = e[0]![0]!, x1 = e[1]![0]!, y0 = e[0]![1]!, y1 = e[1]![1]!
    recompute()
  }
  const stepMajor = (s: number[]) => { DX = s[0]!, DY = s[1]! }
  const stepMinor = (s: number[]) => { dx = s[0]!, dy = s[1]! }

  // d3-geo geoGraticule default configuration
  extentMajor([[-180, -90 + GEO_EPSILON], [180, 90 - GEO_EPSILON]])
  extentMinor([[-180, -80 - GEO_EPSILON], [180, 80 + GEO_EPSILON]])

  // Apply spec parameters in key order (as vega's Graticule.transform does).
  for (const key of Object.keys(t)) {
    const v = t[key]
    if (key === 'extent' && Array.isArray(v)) { extentMajor(v as number[][]); extentMinor(v as number[][]) }
    else if (key === 'extentMajor' && Array.isArray(v)) extentMajor(v as number[][])
    else if (key === 'extentMinor' && Array.isArray(v)) extentMinor(v as number[][])
    else if (key === 'step' && Array.isArray(v)) { stepMajor(v as number[]); stepMinor(v as number[]) }
    else if (key === 'stepMajor' && Array.isArray(v)) stepMajor(v as number[])
    else if (key === 'stepMinor' && Array.isArray(v)) stepMinor(v as number[])
    else if (key === 'precision' && typeof v === 'number') { precision = v; recompute() }
  }

  const lines = (): number[][][] =>
    d3Range(Math.ceil(X0 / DX) * DX, X1, DX).map(X)
      .concat(d3Range(Math.ceil(Y0 / DY) * DY, Y1, DY).map(Y))
      .concat(d3Range(Math.ceil(x0 / dx) * dx, x1, dx).filter((xx) => Math.abs(xx % DX) > GEO_EPSILON).map(x))
      .concat(d3Range(Math.ceil(y0 / dy) * dy, y1, dy).filter((yy) => Math.abs(yy % DY) > GEO_EPSILON).map(y))

  return [{ type: 'MultiLineString', coordinates: lines() }]
}

// ---------------------------------------------------------------------------
// timeunit — Vega-Lite's temporal binning transform
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// contour (generating transform) — vega's Contour: density2D grid -> d3-contour
// marching squares -> coordinate post-transform. Ported to match the oracle.
// ---------------------------------------------------------------------------

/**
 * The thresholds `levels` evenly spaced over a grid's values, from the smallest value (or from zero, when `zero`) to the
 * largest: `nice` rounds the spacing to a tick step, otherwise the span is cut into `levels + 1` parts. Missing values
 * are skipped; the rest are compared as they are, so the spacing is arithmetic on whatever the cells hold.
 */
export function contourQuantize(levels: number, nice: boolean, zero: boolean): (values: ArrayLike<unknown>) => number[] {
  return (values) => {
    let lowest: number | undefined
    let highest: number | undefined
    for (let i = 0; i < values.length; i++) {
      const v = values[i] as number
      if (v == null || v !== v) continue
      if (lowest === undefined) { lowest = highest = v; continue }
      if (v < lowest) lowest = v
      if (v > highest!) highest = v
    }
    const start = zero ? Math.min(lowest as number, 0) : (lowest as number)
    const stop = highest as number
    const step = nice ? tickStep(start, stop, levels) : (stop - start) / (levels + 1)
    return d3Range(start + step, stop, step)
  }
}

function contourRows(rows: Row[], t: Record<string, unknown>, ctx: TransformContext): Row[] {
  const values = t.values as ArrayLike<unknown> | undefined
  // The thresholds: given, or `count` levels spanning the values (from zero when the values are given, not estimated).
  const quantize = contourQuantize((t.count as number) || 10, !!t.nice, !!values)
  const given = t.thresholds as number[] | undefined

  let cells: ArrayLike<unknown>
  let size = t.size as [number, number]
  let place: ((features: ContourFeature[]) => void) | null = null
  if (values) cells = values
  else {
    const settings = densitySettings(t)
    const compile = (expr: string): ((d: Row) => unknown) => compileExprTransform(expr, ctx)
    const x = t.x != null ? accessorOf(t.x, compile) : (d: Row) => (d as unknown as unknown[])[0]
    const y = t.y != null ? accessorOf(t.y, compile) : (d: Row) => (d as unknown as unknown[])[1]
    const weight = t.weight != null ? accessorOf(t.weight, compile) : null
    const grid = densityGrid({
      xs: rows.map((r) => x(r)),
      ys: rows.map((r) => y(r)),
      weightAt: (i) => +(weight ? (weight(rows[i]!) as number) : 1),
      size: settings.size, k: settings.k, bandwidth: settings.bandwidth, counts: true, label: 'contour density grid',
    })
    cells = grid.values
    size = [grid.width, grid.height]
    // the polygons are in grid cells: back to view pixels
    place = (features) => placeContours(features, [grid.x1 || 0, grid.y1 || 0], [grid.scale || 1, grid.scale || 1], [0, 0])
  }

  const thresholds = given || quantize(cells as Float32Array)
  boundedCount(thresholds.length, 'contour thresholds')
  const contourRun = geoRegistry.contourRun
  if (!contourRun) requireGeo() // throws: geo addon not loaded
  const features = contourRun!(cells as Float32Array, thresholds, size, t.smooth !== false)
  place?.(features)
  // Each contour is a tuple of its own (`as` is ignored).
  return features.map((f) => ({ type: f.type, value: f.value, coordinates: f.coordinates }) as Row)
}

// ---------------------------------------------------------------------------
// lookup (vega-transforms Lookup)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// stratify and the hierarchy tree
//
// The layouts of the hierarchy transforms (pack, partition, treemap, tree: hierarchy-layout.ts) work on the tree that a
// preceding `stratify` built; vega threads it through `pulse.source.root`, we thread it through
// `TransformContext.hierarchies`.
// ---------------------------------------------------------------------------

export interface HierNode {
  data: Row
  /** Index of `data` in the rows the tree was built from (-1 for the empty-source placeholder). */
  idx?: number
  children: HierNode[]
  parent: HierNode | null
  depth: number
  height: number
  x: number
  y: number
  r: number
  value: number
  /** On a tree's root: the nodes by their `key` value (vega-hierarchy `lookup`), for `treePath` / `treeAncestors`. */
  lookup?: Map<string, HierNode>
  /** Treemap bounding rectangle (d3-hierarchy node.x0/x1/y0/y1). */
  x0?: number
  y0?: number
  x1?: number
  y1?: number
}

/**
 * Build a hierarchy tree from flat id/parent-id tuples. Mirrors d3-hierarchy
 * `stratify` as vega-hierarchy drives it (C8): ids and parent ids are
 * stringified, null/empty ids are ignored, and the same errors are thrown --
 * `missing: <id>`, `ambiguous: <id>`, `multiple roots`, `no root`, `cycle`.
 * A parent/child cycle therefore throws instead of looping, and no walk here
 * is recursive (deep chains cannot overflow the stack).
 * An empty source yields vega's placeholder single-node tree.
 */
export function buildStratifyTree(rows: Row[], key?: string, parentKey?: string): HierNode {
  if (!key) throw new Error('[aster] stratify requires a key field')
  const mk = (data: Row, idx = -1): HierNode => ({ data, idx, children: [], parent: null, depth: 0, height: 0, x: 0, y: 0, r: 0, value: 0 })
  if (!rows.length) return mk({})
  const ambiguous = {} as HierNode
  const byKey = new Map<string, HierNode>()
  const nodes: HierNode[] = []
  const parentIds: Array<string | null> = []
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!
    const node = mk(r, i)
    nodes.push(node)
    const id = r[key]
    if (id != null && String(id) !== '') {
      const k = String(id)
      byKey.set(k, byKey.has(k) ? ambiguous : node)
    }
    const pid = parentKey ? r[parentKey] : undefined
    parentIds.push(pid != null && String(pid) !== '' ? String(pid) : null)
  }
  let root: HierNode | null = null
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!
    const pid = parentIds[i]
    if (pid != null) {
      const parent = byKey.get(pid)
      if (!parent) throw new Error(`[aster] stratify: missing: ${pid}`)
      if (parent === ambiguous) throw new Error(`[aster] stratify: ambiguous: ${pid}`)
      parent.children.push(node)
      node.parent = parent
    } else {
      if (root) throw new Error('[aster] stratify: multiple roots')
      root = node
    }
  }
  if (!root) throw new Error('[aster] stratify: no root')
  // Nodes on a cycle are unreachable from the root; counting the reachable
  // ones is how d3 detects it.
  let reached = 0
  walkPreOrder(root, (node) => {
    reached++
    node.depth = node.parent ? node.parent.depth + 1 : 0
  })
  if (reached < nodes.length) throw new Error('[aster] stratify: cycle')
  // (vega-hierarchy lookup(): every node by its key, the last of equal keys winning)
  const lookup = new Map<string, HierNode>()
  for (const node of nodes) lookup.set(String(node.data[key]), node)
  root.lookup = lookup
  walkPostOrder(root, (node) => {
    let h = 0
    for (const c of node.children) if (c.height + 1 > h) h = c.height + 1
    node.height = h
  })
  return root
}

/**
 * Resolve a (possibly dotted) field path against a row. Vega treats dotted
 * field names as nested-object access (e.g. `lookup_result.label` reads
 * `datum["lookup_result"]["label"]`).
 */
export function getField(row: Row, path: string): unknown {
  // plain names (the overwhelmingly common case) skip the access-path parser
  if (typeof path !== 'string' || !/[.[\]\\]/.test(path)) return row[path]
  return fieldOf(path)(row)
}
