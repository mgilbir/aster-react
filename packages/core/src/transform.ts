/**
 * Eager row transforms. Vega's dataflow applies these reactively; here each one
 * applies the same semantics eagerly against the current rows, and the incremental
 * path in runtime.ts keeps their results across calls. Each transform is a
 * `(rows, params) -> rows` function (plus expression/context). It may write onto rows
 * the pipeline owns instead of copying them (see `ownsOutput`), and `force` moves its
 * rows in place; rows that another dataset, a hierarchy or an index holds are not written.
 */
import type { CompiledTransform, SortSpec } from './types.js'
import type { IdCounter } from './identifier-ids.js'
import { exprRows, type ExpressionRuntime } from './expression.js'
import { type ContourFeature, SHAPE_BOUNDS, geoRegistry, requireGeo, requireTransform } from './registry.js'
import { isArray } from './util.js'
import { densityGrid, placeContours } from './raster-grid.js'
import { densitySettings } from './raster-params.js'
import { PARAM_RULES, checkParams } from './param-rules.js'
import { tickStep } from './arr.js'
import { carryOrder, orderOf, placesAt } from './tuple-order.js'
import { activeMeter, allot, copiedRows, meterTick, sortMetered } from './limits.js'
import { walkPostOrder, walkPreOrder } from './tree-walk.js'
import { compareOf, fieldOf, numberRange, required, sortBySpec } from './row-keys.js'
import type { AggregateParams } from './transform-agg.js'
import { part } from './engine-parts.js'
import { resolveTransformParams } from './param-resolve.js'
import { signalValueOf } from './transform-params.js'


/** One group's aggregate tuple (the incremental aggregate re-derives only dirty groups). */
export function aggregateGroup(group: Row[], t: CompiledTransform, random?: () => number): Row {
  return part('aggregate').aggregateRows(group, t as AggregateParams, random)[0]!
}

export interface TransformContext {
  runtime: ExpressionRuntime
  /** Signal values by name. Must be prototype-less (the runtime supplies `dict(...)`): names are spec-supplied. */
  signals: Record<string, unknown>
  /** Cross-dataset lookup: the rows of a named dataset, read by the 'lookup' transform. */
  datasets?: (name: string) => unknown[] | undefined
  /**
   * The id counter of the view the transforms belong to, which every `identifier` draws from (see identifier-ids.ts). A context
   * that has none belongs to no view: each call of `applyTransforms` numbers from 1.
   */
  ids?: IdCounter
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

/** The aggregate ops whose result holds the row objects they were given (the others compute numbers). */
const ROW_HOLDING_OPS = new Set(['values', 'argmin', 'argmax'])

/**
 * What a transform does with the row OBJECTS it is given -- the thing that decides whether a pipeline needs rows of its own:
 *   - `subset`: reads them and returns some of them, unchanged (`filter`, `resolvefilter`, `collect`);
 *   - `fresh`: reads them and returns new rows that hold none of them (an `aggregate` of numbers);
 *   - `writes`: anything else -- it may add to them, keep them, or write them.
 * `subset` and `fresh` never write a row, which the pipeline's rows being another dataset's relies on.
 */
export type RowUse = 'subset' | 'fresh' | 'writes'
export function rowUseOf(t: CompiledTransform): RowUse {
  switch (t.type) {
    case 'filter': case 'resolvefilter': case 'collect': return 'subset'
    case 'aggregate': {
      // (ops may be a signal: not known, so not read-only)
      const ops = (t as { ops?: unknown }).ops
      if (ops === undefined) return 'fresh'
      return Array.isArray(ops) && ops.every((o) => typeof o === 'string' && !ROW_HOLDING_OPS.has(o)) ? 'fresh' : 'writes'
    }
    default: return 'writes'
  }
}

/**
 * Whether every row a transform returns is the pipeline's own -- made by the pipeline (this transform or an earlier one) and held by
 * nothing outside it -- given whether the rows it was given were. A transform handed owned rows may write onto them instead of
 * copying them first, which is what lets a chain of `bin`s or `formula`s allocate its rows once.
 *
 * Inside the pipeline the rows may be held: a window's or joinaggregate's `values`, `argmin` and `argmax` are rows of its output,
 * and a transform that goes on to write onto those rows shows its fields there, as it does in Vega where the transforms share one set
 * of tuples. A transform that makes new rows (`project`, `fold`, `flatten`, `aggregate`, `pivot`) leaves the rows it read as they were.
 * What is never owned: rows another dataset, a hierarchy or an index holds (anything not listed here).
 */
function ownsOutput(t: CompiledTransform, ownedIn: boolean): boolean {
  return makesOwnRows(t) || (ownedIn && KEEPS_ROW_OBJECTS.has(t.type as string))
}

/** The transforms that return rows made for the pipeline whatever rows they were given: none of them is a row the input held. */
export function makesOwnRows(t: CompiledTransform): boolean {
  switch (t.type) {
    case 'formula': case 'bin': case 'timeunit': case 'identifier': case 'lookup': case 'stack': case 'project':
    case 'fold': case 'flatten': case 'pivot': case 'aggregate': case 'window': case 'joinaggregate':
      return true
    default:
      return false
  }
}

/**
 * Whether a transform leaves every row object it is given as it was and returns rows of its own, none of them one of those: a
 * dataset's source rows need no copy before it. (An `aggregate` whose ops hold rows -- `values`, `argmin`, `argmax` -- returns
 * rows that hold the ones it was given.)
 */
export function copiesRows(t: CompiledTransform): boolean {
  return makesOwnRows(t) && (t.type !== 'aggregate' || rowUseOf(t) === 'fresh')
}

/** The transforms that return some of the row objects they were given (their rows are the pipeline's own when the input's were). */
const KEEPS_ROW_OBJECTS = new Set(['filter', 'collect', 'sample', 'extent', 'impute'])

/**
 * Apply `transforms` to `rows`, which are another dataset's row objects (the array itself is the caller's own), and give the result rows
 * of its own: the transforms are applied to the shared rows for as long as they only read them, and what still is one of them
 * afterwards is copied (a pipeline that ends with an aggregate copies nothing).
 */
export function applyTransformsToSharedRows(rows: Row[], transforms: CompiledTransform[], ctx: TransformContext, sourceName?: string): Row[] {
  let reading = 0
  let shared = true
  // bounded: the spec's transforms, once each
  while (reading < transforms.length) {
    const use = rowUseOf(transforms[reading]!)
    if (use === 'writes') break
    if (use === 'fresh') shared = false
    reading++
  }
  let out = reading > 0 ? applyTransforms(rows, transforms.slice(0, reading), ctx, sourceName) : rows
  if (shared) out = copiedRows(out, 'dataset rows')
  // (the rows are now the pipeline's own: copies of the shared ones, or made by an aggregate)
  return reading < transforms.length ? applyTransforms(out, transforms.slice(reading), ctx, sourceName, true) : out
}

export function applyTransforms(
  rows: Row[],
  transforms: CompiledTransform[],
  ctx: TransformContext,
  sourceName?: string,
  owned = false,
): Row[] {
  let out = rows
  const meter = activeMeter()
  // (a context that belongs to no view has no counter: the `identifier`s of one call share a counter of their own, from 1)
  const run = ctx.ids || !transforms.some((t) => t.type === 'identifier') ? ctx : { ...ctx, ids: { value: 0 } }
  for (let k = 0; k < transforms.length; k++) {
    const t = transforms[k]!
    if (meter) meter.clock.check(`transform ${t.type}`)
    const ownedIn = owned
    owned = ownsOutput(t, ownedIn)
    // (a collect that sorts, with a sort after it, leaves the order the rows were made in beside its result)
    const input = out
    out = applyTransform(out, t, run, sourceName, ownedIn, placesAt(transforms, k))
    // (a transform's `signal`: what vega binds it to, see `signalValueOf`)
    const published = (t as { signal?: unknown }).signal
    if (typeof published === 'string' && published) publishSignal(t, published, input, out, run)
    carryOrder(t.type, input, out)
    if (meter) {
      // Whatever a transform produced is a dataset like any other: it may not
      // exceed maxRows, and the rows it made beyond the rows IT was given count as generated (once: a later step that keeps
      // them makes none)
      meter.checkRows(out.length, `transform ${t.type}`)
      meter.generated(out.length - input.length, `transform ${t.type}`)
    }
  }
  return out
}

/** Bind a transform's `signal` to the value vega binds it to (the transforms that publish their own did so already). */
function publishSignal(t: CompiledTransform, name: string, input: Row[], out: Row[], ctx: TransformContext): void {
  switch (signalValueOf(t.type)) {
    case 'output': ctx.signals[name] = out; break
    case 'added': ctx.signals[name] = out.slice(input.length); break
    case 'values': {
      const field = (t as { field?: unknown }).field ? fieldOf((resolveTransformParams(t, ctx) as { field?: unknown }).field) : null
      ctx.signals[name] = input.map((r) => (field ? field(r) : 1))
      break
    }
    case 'counter': ctx.signals[name] = ctx.ids?.value; break
    case 'none': ctx.signals[name] = null; break
    case 'own': break
    default: {
      // (vega's internal state of the operator: an opaque object that stands for it, the same one every evaluation)
      let token = OPAQUE.get(t)
      if (token === undefined) OPAQUE.set(t, (token = Object.freeze({})))
      ctx.signals[name] = token
    }
  }
}
const OPAQUE = new WeakMap<object, object>()

/** A parameter value that is a lone `{signal: <expression>}`. */
function isSignalRef(v: unknown): boolean {
  return v !== null && typeof v === 'object' && !isArray(v) && typeof (v as { signal?: unknown }).signal === 'string' && Object.keys(v as object).length === 1
}

function applyTransform(rows: Row[], t0: CompiledTransform, ctx: TransformContext, sourceName: string | undefined, owned: boolean, leaveOrder: boolean): Row[] {
  const rules = PARAM_RULES.get(t0.type as string)
  if (rules) checkParams(t0 as Record<string, unknown>, rules)
  // (every parameter as vega reads it: `{signal}`s, fields written `{expr}` / `{field, as}`, comparators -- see param-resolve.ts)
  const t = resolveTransformParams(t0, ctx)
  switch (t.type) {
    case 'formula': {
      required('formula', t, 'expr', 'as')
      const expr = exprRowPass(t.expr as string, ctx, 'formula')
      const as = t.as as string
      if (owned) {
        const out = rows.slice()
        for (const r of out) r[as] = expr(r)
        return out
      }
      // (written as vega's Formula writes it, `t[as] = value`, onto a copy: an output named `__proto__` is the copy's prototype --
      // a value that is no object is no prototype and is dropped -- as it is in every other transform that names its output, never
      // Object.prototype)
      return rows.map((r) => {
        const o = { ...r }
        o[as] = expr(r)
        return o
      })
    }
    case 'filter': {
      required('filter', t, 'expr')
      const expr = exprRowPass(t.expr as string, ctx, 'filter')
      return rows.filter((r) => expr(r))
    }
    case 'collect':
      return part('reshape').collectRows(rows, t, leaveOrder)
    case 'sample':
      return part('reshape').sampleRows(rows, t, ctx.runtime.random)
    case 'fold':
      return part('reshape').foldRows(rows, t)
    case 'flatten':
      return part('reshape').flattenRows(rows, t)
    case 'bin':
      return part('reshape').binRows(rows, t, (b) => {
        if (t.signal) ctx.signals[t.signal as string] = b
      }, owned)
    case 'impute':
      return part('reshape').imputeRows(rows, t)
    case 'aggregate':
      return part('aggregate').aggregateRows(rows, t, ctx.runtime.random)
    case 'joinaggregate':
      return part('aggregate').joinAggregateRows(rows, t, ctx.runtime.random, owned)
    case 'window':
      return part('window').windowRows(rows, t, ctx.runtime.random, owned)
    case 'stack':
      return part('reshape').stackRows(rows, t, owned)
    case 'extent': {
      const ext = part('reshape').extentOfField(rows, t)
      if (t.signal) ctx.signals[t.signal as string] = ext
      return rows
    }
    case 'geoshape': {
      // Vega's geoshape transform turns the GeoJSON geometry of each tuple's field (by default
      // `datum`) into an SVG path (default output 'shape'). With a `projection` param the
      // geometry is projected first.
      const as = (t as { as?: unknown }).as ?? 'shape'
      const field = (t as { field?: unknown }).field
      const projName = (t as { projection?: unknown }).projection
      const projection = projName != null ? ctx.projections?.get(String(projName)) : undefined
      if (projection != null && !geoRegistry.projectedPath) requireGeo() // throws: addon not loaded
      const pointRadius = geoPointRadius((t as { pointRadius?: unknown }).pointRadius)
      // (a mark's transform runs on its items: the field is read off the item, `datum` -- the default -- being its data, and the
      // path is written on the item, which is the transform's own)
      const geoOf = fieldOf(field == null ? 'datum' : field)
      return rows.map((r, i) => {
        if ((i & 1023) === 1023) meterTick('geoshape', 1024)
        const geo = geoOf(r)
        // a projected shape's path and its unrounded bounds (for the bound pass) come from one pass over the geometry
        const shape = projection != null && as === 'shape' && geoRegistry.projectedShape ? geoRegistry.projectedShape(projection, geo, pointRadius) : undefined
        const p = shape
          ? shape.path
          : projection != null
            ? geoRegistry.projectedPath!(projection, geo, pointRadius)
            : geoJSONPath(geo)
        if (p === undefined) return r
        const out = owned ? r : { ...r }
        out[as as string] = p
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
      return part('reshape').projectRows(rows, t)
    case 'quantile':
      return requireTransform('quantile')(rows, t as Record<string, unknown>, ctx, sourceName)
    case 'regression':
      return requireTransform('regression')(rows, t as Record<string, unknown>, ctx, sourceName)
    case 'loess':
      return requireTransform('loess')(rows, t as Record<string, unknown>, ctx, sourceName)
    case 'density':
      return requireTransform('density')(rows, t as Record<string, unknown>, ctx, sourceName)
    case 'lookup':
      return part('reshape').lookupRows(rows, t, (ctx.datasets?.(t.from as string) ?? []) as Row[], owned)
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
    case 'nest':
      return requireTransform('nest')(rows, t as Record<string, unknown>, ctx, sourceName)
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
      return rows.length ? [...rows, ...part('reshape').sequenceRows(t)] : part('reshape').sequenceRows(t)
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
      return part('time').timeunitRows(rows, t, (info) => {
        if (t.signal) ctx.signals[t.signal as string] = info
      }, owned)
    case 'identifier':
      return part('reshape').identifierRows(rows, t, owned, ctx.ids)
    case 'pivot':
      return part('aggregate').pivotRows(rows, t as { field?: unknown; value?: unknown }, ctx.runtime.random)
    default:
      throw new Error(`[aster] unsupported transform type "${(t as { type: string }).type}"`)
  }
}

/**
 * A geo transform's `pointRadius`: a number, or a function of the GeoJSON object being drawn (written `{expr}` or `{field}`, made an
 * accessor with the other parameters: d3's path takes `+radius(object)`).
 */
export function geoPointRadius(param: unknown): unknown {
  if (typeof param !== 'function') return param
  return (feature: unknown): number => +((param as (d: unknown) => unknown)(feature) as number)
}

/**
 * An expression evaluated over a transform's rows in one loop that the caller runs now, in which nothing writes a signal (the
 * loop only evaluates, and what the expression calls is checked: see `exprRows`). What every row reads alike is read once. Not
 * to be kept past that loop: the next pass prepares its own.
 */
export function exprRowPass(expr: string, ctx: TransformContext, what = 'expression rows'): (datum: Row) => unknown {
  const pass = exprRows(ctx.runtime.expr(expr), ctx.signals)
  // Inside a limits scope every 1024 rows tick the clock: a formula or filter is a pass over the rows with an expression per row,
  // which the budget must stop inside (C514). Outside one the pass is the expression itself.
  const meter = activeMeter()
  if (!meter) return pass
  let count = 0
  return (datum) => {
    if (++count === 1024) { count = 0; meter.tick(what, 1024) }
    return pass(datum)
  }
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
  const places = c ? orderOf(rows) : null
  if (c) sortMetered(order, (a, b) => c(rows[a]!, rows[b]!) || (places ? places[a]! - places[b]! : 0) || a - b, 'collect')
  return Number.isFinite(limit) ? order.slice(0, Math.max(0, limit)) : order
}

// ---------------------------------------------------------------------------
// bin
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// impute
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// aggregate / window / stack
// ---------------------------------------------------------------------------

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
      // bounded: the rings of one polygon of a geometry the data holds
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

/**
 * The steps of a graticule line: `start, start + step, ...` below `stop`, as d3-array's `range` counts them (a count that is not a
 * positive number, from a zero or NaN step, is none). The length is checked against the limits before it is allocated.
 */
function graticuleRange(start: number, stop: number, step: number): number[] {
  return (Math.max(0, Math.ceil((stop - start) / step)) | 0) > 0 ? numberRange(start, stop, step) : []
}

/** A graticule line family: the line through one position, and how many points each line has. */
type LineFamily = ((at: number) => number[][]) & { points: number }

/** The latitude samples along a meridian (every 90 degrees, clipped to the extent). */
function graticuleX(y0: number, y1: number, dy: number): LineFamily {
  const y = graticuleRange(y0, y1 - GEO_EPSILON, dy).concat(y1)
  return Object.assign((x: number) => { meterTick('graticule', y.length); return y.map((yy) => [x, yy]) }, { points: y.length })
}

/** The longitude samples along a parallel (every `precision` degrees). */
function graticuleY(x0: number, x1: number, dx: number): LineFamily {
  const x = graticuleRange(x0, x1 - GEO_EPSILON, dx).concat(x1)
  return Object.assign((yy: number) => { meterTick('graticule', x.length); return x.map((xx) => [xx, yy]) }, { points: x.length })
}

/**
 * The vega `graticule` transform: a single GeoJSON MultiLineString of latitude/longitude grid lines, as d3-geo's `geoGraticule`
 * draws them, with the same arithmetic so the coordinates match to the bit. What is fixed by the output: the parameters are applied
 * in the order of vega's definition (extent, extentMajor, extentMinor, step, stepMajor, stepMinor, precision), not the spec's; each value is read as a number (`'45'` is 45, a list of strings is a list of numbers); an extent
 * given west-east or north-south the wrong way round is swapped; a step or precision of zero (or NaN) gives a line no samples
 * between its ends, as d3's range does.
 */
/** The graticule's parameters, in the order vega-geo's Graticule definition lists them. */
const GRATICULE_PARAMS = ['extent', 'extentMajor', 'extentMinor', 'step', 'stepMajor', 'stepMinor', 'precision'] as const

function graticuleRows(t: Record<string, unknown>): Row[] {
  let x0 = -180, x1 = 180, X0 = -180, X1 = 180
  let y0 = -80 - GEO_EPSILON, y1 = 80 + GEO_EPSILON
  let Y0 = -90 + GEO_EPSILON, Y1 = 90 - GEO_EPSILON
  let dx = 10, dy = 10, DX = 90, DY = 360
  let precision = 2.5

  const none: LineFamily = Object.assign(() => [], { points: 0 })
  let X = none
  let Y = none
  let x = none
  let y = none
  const setPrecision = (p: unknown) => {
    precision = +(p as number)
    x = graticuleX(y0, y1, 90)
    y = graticuleY(x0, x1, precision)
    X = graticuleX(Y0, Y1, 90)
    Y = graticuleY(X0, X1, precision)
  }

  type Corners = ArrayLike<ArrayLike<unknown>>
  const extentMajor = (e: Corners) => {
    X0 = +(e[0]![0] as number), X1 = +(e[1]![0] as number)
    Y0 = +(e[0]![1] as number), Y1 = +(e[1]![1] as number)
    if (X0 > X1) [X0, X1] = [X1, X0]
    if (Y0 > Y1) [Y0, Y1] = [Y1, Y0]
    setPrecision(precision)
  }
  const extentMinor = (e: Corners) => {
    x0 = +(e[0]![0] as number), x1 = +(e[1]![0] as number)
    y0 = +(e[0]![1] as number), y1 = +(e[1]![1] as number)
    if (x0 > x1) [x0, x1] = [x1, x0]
    if (y0 > y1) [y0, y1] = [y1, y0]
    setPrecision(precision)
  }
  const stepMajor = (s: ArrayLike<unknown>) => { DX = +(s[0] as number), DY = +(s[1] as number) }
  const stepMinor = (s: ArrayLike<unknown>) => { dx = +(s[0] as number), dy = +(s[1] as number) }

  // d3-geo geoGraticule default configuration
  extentMajor([[-180, -90 + GEO_EPSILON], [180, 90 - GEO_EPSILON]])
  extentMinor([[-180, -80 - GEO_EPSILON], [180, 80 + GEO_EPSILON]])

  // Apply the parameters in the order of the transform's definition, whatever order the spec writes them in (vega's parser builds
  // the parameters from the definition, and its Graticule applies them in that order)
  for (const key of GRATICULE_PARAMS) {
    if (!Object.hasOwn(t, key)) continue
    const v = t[key]
    if (v === undefined) continue
    if (key === 'extent') { extentMajor(v as Corners); extentMinor(v as Corners) }
    else if (key === 'extentMajor') extentMajor(v as Corners)
    else if (key === 'extentMinor') extentMinor(v as Corners)
    else if (key === 'step') { stepMajor(v as ArrayLike<unknown>); stepMinor(v as ArrayLike<unknown>) }
    else if (key === 'stepMajor') stepMajor(v as ArrayLike<unknown>)
    else if (key === 'stepMinor') stepMinor(v as ArrayLike<unknown>)
    else if (key === 'precision') setPrecision(v)
  }

  // The lines of each family, then their points: lines times points per line is what the steps and the precision multiply, so
  // the positions are bounded (as coordinates, like a topojson decode's) before a line is made.
  const majorX = graticuleRange(Math.ceil(X0 / DX) * DX, X1, DX)
  const majorY = graticuleRange(Math.ceil(Y0 / DY) * DY, Y1, DY)
  const minorX = graticuleRange(Math.ceil(x0 / dx) * dx, x1, dx).filter((xx) => Math.abs(xx % DX) > GEO_EPSILON)
  const minorY = graticuleRange(Math.ceil(y0 / dy) * dy, y1, dy).filter((yy) => Math.abs(yy % DY) > GEO_EPSILON)
  allot('coords', majorX.length * X.points + majorY.length * Y.points + minorX.length * x.points + minorY.length * y.points, 'graticule')
  const lines = majorX.map(X).concat(majorY.map(Y), minorX.map(x), minorY.map(y))

  return [{ type: 'MultiLineString', coordinates: lines }]
}

// ---------------------------------------------------------------------------
// timeunit — Vega-Lite's temporal binning transform
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// contour (generating transform) — vega's Contour: density2D grid -> marching
// squares (Aster's own implementation) -> coordinate post-transform. Written to match the oracle.
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
    return numberRange(start + step, stop, step)
  }
}

function contourRows(rows: Row[], t: Record<string, unknown>, ctx: TransformContext): Row[] {
  const values = t.values as ArrayLike<unknown> | undefined
  // The thresholds: given, or `count` levels spanning the values (from zero when the values are given, not estimated).
  allot('items', (t.count as number) || 10, 'contour levels')
  const quantize = contourQuantize((t.count as number) || 10, !!t.nice, !!values)
  const given = t.thresholds as number[] | undefined

  let cells: ArrayLike<unknown>
  let size = t.size as [number, number]
  let place: ((features: ContourFeature[]) => void) | null = null
  if (values) cells = values
  else {
    const settings = densitySettings(t)
    const x = t.x != null ? fieldOf(t.x) : (d: Row) => (d as unknown as unknown[])[0]
    const y = t.y != null ? fieldOf(t.y) : (d: Row) => (d as unknown as unknown[])[1]
    const weight = t.weight != null ? fieldOf(t.weight) : null
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
  allot('items', thresholds.length, 'contour thresholds')
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
  /**
   * On a tree's root: how many rows the dataset had when the tree was built. A dataset of that size still holds the rows at the
   * positions (`idx`) the tree remembers; one of another size has been filtered or extended since.
   */
  rowCount?: number
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
 * `stratify` as vega-hierarchy drives it: ids and parent ids are
 * stringified, null/empty ids are ignored, and the same errors are thrown --
 * `missing: <id>`, `ambiguous: <id>`, `multiple roots`, `no root`, `cycle`.
 * A parent/child cycle therefore throws instead of looping, and no walk here
 * is recursive (deep chains cannot overflow the stack).
 * An empty source yields vega's placeholder single-node tree.
 */
export function buildStratifyTree(rows: Row[], key?: string, parentKey?: string): HierNode {
  if (!key) throw new Error('[aster] stratify requires a key field')
  const mk = (data: Row, idx = -1): HierNode => ({ data, idx, children: [], parent: null, depth: 0, height: 0, x: 0, y: 0, r: 0, value: 0 })
  if (!rows.length) return Object.assign(mk({}), { rowCount: 0 })
  // (both are fields: paths into the row)
  const idOf = fieldOf(key)
  const parentOf = parentKey ? fieldOf(parentKey) : undefined
  const ambiguous = {} as HierNode
  const byKey = new Map<string, HierNode>()
  const nodes: HierNode[] = []
  const parentIds: Array<string | null> = []
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!
    if ((i & 1023) === 1023) meterTick('stratify', 1024)
    const node = mk(r, i)
    nodes.push(node)
    const id = idOf(r)
    if (id != null && String(id) !== '') {
      const k = String(id)
      byKey.set(k, byKey.has(k) ? ambiguous : node)
    }
    const pid = parentOf?.(r)
    parentIds.push(pid != null && String(pid) !== '' ? String(pid) : null)
  }
  let root: HierNode | null = null
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!
    const pid = parentIds[i]
    if ((i & 1023) === 1023) meterTick('stratify', 1024)
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
  for (const node of nodes) lookup.set(String(idOf(node.data)), node)
  root.lookup = lookup
  root.rowCount = rows.length
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
