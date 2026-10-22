/**
 * Eager row transforms. Vega's dataflow applies these reactively; for the static
 * execution mode we apply the same semantics eagerly against the current rows.
 * Each transform is a pure `(rows, params) -> rows` (plus expression/context).
 */
import type { CompiledTransform, SortSpec } from './types.js'
import type { ExpressionRuntime } from './expression.js'
import { geoRegistry, requireGeo, requireTransform } from './registry.js'
import { nominalTextWidth } from './text-metrics.js'
import { ownGet, safeGet } from './util.js'

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
}

export type Row = Record<string, unknown>

export function applyTransforms(
  rows: Row[],
  transforms: CompiledTransform[],
  ctx: TransformContext,
  sourceName?: string,
): Row[] {
  let out = rows
  for (const t of transforms) {
    out = applyTransform(out, t, ctx, sourceName)
  }
  return out
}

function applyTransform(rows: Row[], t: CompiledTransform, ctx: TransformContext, sourceName?: string): Row[] {
  switch (t.type) {
    case 'formula': {
      const expr = compileExprTransform(t.expr, ctx)
      return rows.map((r) => ({ ...r, [t.as]: expr(r) }))
    }
    case 'filter': {
      const expr = compileExprTransform(t.expr, ctx)
      return rows.filter((r) => expr(r))
    }
    case 'collect':
      return sortRows(rows, t.sort)
    case 'sample':
      return rows.slice(0, t.size)
    case 'fold': {
      const [asKey, asValue] = t.as
      const out: Row[] = []
      for (const r of rows) {
        for (const f of t.fields) {
          out.push({ ...r, [asKey]: f, [asValue]: r[f] })
        }
      }
      return out
    }
    case 'flatten': {
      // Vega's Flatten derives the output length as
      //   arrays.reduce((l, a) => Math.max(l, a.length), 0)
      // which collapses to NaN (→ no output rows at all) the moment any field
      // is not array-typed, and writes `null` for missing array slots.
      const fields = t.fields
      const as = t.as ?? []
      const index = (t as { index?: string }).index
      const out: Row[] = []
      for (const r of rows) {
        const arrays = fields.map((f) => r[f])
        let maxlen = 0
        for (const a of arrays) {
          const len = (a as { length?: number } | null | undefined)?.length
          maxlen = len == null ? NaN : Math.max(maxlen, len)
        }
        if (!(maxlen > 0)) continue
        for (let i = 0; i < maxlen; i++) {
          const row: Row = { ...r }
          fields.forEach((f, j) => {
            const a = arrays[j]
            const v = (a as unknown[] | null | undefined)?.[i]
            row[as[j] ?? f] = v == null ? null : v
          })
          if (index !== undefined) row[index] = i
          out.push(row)
        }
      }
      return out
    }
    case 'bin':
      return binRows(rows, t, ctx)
    case 'impute':
      return imputeRows(rows, t, ctx)
    case 'aggregate':
      return aggregateRows(rows, t)
    case 'joinaggregate':
      return joinAggregateRows(rows, t)
    case 'window':
      return windowRows(rows, t)
    case 'stack':
      return stackRows(rows, t)
    case 'extent': {
      const values = collectField(rows, t.field).filter(isFiniteNumber)
      ctx.signals[t.signal] =
        values.length === 0 ? [Infinity, -Infinity] : [Math.min(...values), Math.max(...values)]
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
      return rows.map((r) => {
        const geo = field == null || field === 'datum' ? r : r[field as string]
        const p = projection != null
          ? geoRegistry.projectedPath!(projection, geo)
          : geoJSONPath(geo)
        return p !== undefined ? { ...r, [as as string]: p } : r
      })
    }
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
    case 'geopoint':
      return requireTransform('geopoint')(rows, t as Record<string, unknown>, ctx, sourceName)
    case 'geojson':
      return requireTransform('geojson')(rows, t as Record<string, unknown>, ctx, sourceName)
    case 'linkpath':
      return requireTransform('linkpath')(rows, t as Record<string, unknown>, ctx, sourceName)
    case 'project':
      return requireTransform('project')(rows, t as Record<string, unknown>, ctx, sourceName)
    case 'quantile':
      return requireTransform('quantile')(rows, t as Record<string, unknown>, ctx, sourceName)
    case 'regression':
      return requireTransform('regression')(rows, t as Record<string, unknown>, ctx, sourceName)
    case 'loess':
      return requireTransform('loess')(rows, t as Record<string, unknown>, ctx, sourceName)
    case 'lookup':
      return lookupRows(rows, t as Record<string, unknown>, ctx)
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
    case 'treemap':
      return requireTransform('treemap')(rows, t as Record<string, unknown>, ctx, sourceName)
    case 'sequence':
      // Vega appends generated tuples to the current pulse (a sequence on a
      // non-empty source keeps the source rows first).
      return [...rows, ...sequenceRows(t as Record<string, unknown>)]
    case 'graticule':
      return graticuleRows(t as Record<string, unknown>)
    case 'contour':
      return contourRows(rows, t as Record<string, unknown>, ctx)
    case 'wordcloud':
      return requireTransform('wordcloud')(rows, t as Record<string, unknown>, ctx, sourceName)
    case 'voronoi':
      return requireTransform('voronoi')(rows, t as Record<string, unknown>, ctx, sourceName)
    case 'label':
      return labelRows(rows, t as Record<string, unknown>, ctx)
    case 'timeunit':
      return timeunitRows(rows, t as Record<string, unknown>)
    case 'identifier': {
      const as = (t.as as string | undefined) ?? 'id'
      return rows.map((r, i) => ({ ...r, [as]: (r[as] as number | undefined) ?? i + 1 }))
    }
    case 'pivot':
      return pivotRows(rows, t as Record<string, unknown>)
    default:
      throw new Error(`[aster] unsupported transform type "${(t as { type: string }).type}"`)
  }
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

function fieldValues(rows: Row[], field: string): number[] {
  const out: number[] = []
  for (const r of rows) {
    const v = r[field]
    if (typeof v === 'number' && Number.isFinite(v)) out.push(v)
  }
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

function comparator(a: Row, b: Row, field: string): number {
  const av = a[field]
  const bv = b[field]
  if (av === bv) return 0
  if (av == null) return 1
  if (bv == null) return -1
  return av < bv ? -1 : av > bv ? 1 : 0
}

export function sortRows(rows: Row[], sort?: SortSpec): Row[] {
  if (!sort?.field) return rows
  const copy = rows.slice()
  copy.sort((a, b) => compareRows(a, b, sort))
  return copy
}

/** Comparator for a `SortSpec` (used by collect and the incremental order). */
export function compareRows(a: Row, b: Row, sort?: SortSpec): number {
  if (!sort?.field) return 0
  const fields = Array.isArray(sort.field) ? sort.field : [sort.field]
  const orders = Array.isArray(sort.order)
    ? sort.order
    : [sort.order ?? 'ascending']
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i] as string
    const c = comparator(a, b, f)
    if (c !== 0) return (orders[i] ?? 'ascending') === 'descending' ? -c : c
  }
  return 0
}

/** Stable input-index order produced by a collect/sample sort. */
export function sortOrder(rows: Row[], sort?: SortSpec, limit = Infinity): number[] {
  const order = rows.map((_, i) => i)
  if (sort?.field) {
    order.sort((a, b) => compareRows(rows[a]!, rows[b]!, sort) || a - b)
  }
  return Number.isFinite(limit) ? order.slice(0, Math.max(0, limit)) : order
}

// ---------------------------------------------------------------------------
// bin
// ---------------------------------------------------------------------------

function binRows(rows: Row[], t: Extract<CompiledTransform, { type: 'bin' }>, ctx: TransformContext): Row[] {
  const values = fieldValues(rows, t.field)
  const extentLo = resolveExtent(t.extent, ctx)
  let lo: number, hi: number
  if (extentLo) {
    lo = extentLo[0]
    hi = extentLo[1]
  } else if (values.length) {
    lo = Math.min(...values)
    hi = Math.max(...values)
  } else {
    lo = 0
    hi = 1
  }

  // vega-statistics bin(): resolve the step from an explicit step, a candidate
  // `steps` list, or the base/divide/minstep tuning knobs.
  const pnum = (v: unknown): number | undefined => {
    if (typeof v === 'number' && Number.isFinite(v)) return v
    if (v && typeof v === 'object' && 'signal' in (v as Record<string, unknown>)) {
      const sv = ctx.signals[(v as { signal: string }).signal]
      if (typeof sv === 'number' && Number.isFinite(sv)) return sv
    }
    return undefined
  }
  const parr = (v: unknown): number[] | undefined => {
    const a = v && typeof v === 'object' && 'signal' in (v as Record<string, unknown>)
      ? ctx.signals[(v as { signal: string }).signal]
      : v
    return Array.isArray(a) ? a.map(Number) : undefined
  }
  const maxb = pnum(t.maxbins) ?? 20
  const base = pnum(t.base) || 10
  const div = parr(t.divide) ?? [5, 2]
  const span = pnum(t.span) ?? ((hi - lo) || Math.abs(lo) || 1)
  const explicitStep = pnum(t.step)
  const steps = parr(t.steps)
  let step: number
  if (explicitStep != null && explicitStep > 0) {
    step = explicitStep
  } else if (steps && steps.length) {
    const target = span / maxb
    let i = 0
    while (i < steps.length && steps[i]! < target) i++
    step = steps[Math.max(0, i - 1)]!
  } else {
    const logb = Math.log(base)
    const level = Math.ceil(Math.log(maxb) / logb)
    const minstep = pnum(t.minstep) ?? 0
    step = Math.max(minstep, Math.pow(base, Math.round(Math.log(span) / logb) - level))
    if (!(step > 0) || !Number.isFinite(step)) step = 1
    while (Math.ceil(span / step) > maxb) step *= base
    for (const d of div) {
      const v = step / d
      if (v >= minstep && span / v <= maxb) step = v
    }
  }

  // nice extent: start = floor(lo/step)*step, stop = ceil(hi/step)*step
  const vlog = Math.log(step)
  const logb = Math.log(base)
  const precision = vlog >= 0 ? 0 : ~~(-vlog / logb) + 1
  const eps = Math.pow(base, -precision - 1)
  let start = lo
  let stop = hi
  if (t.nice !== false) {
    const v = Math.floor(lo / step + eps) * step
    start = lo < v ? v - step : v
    stop = Math.ceil(hi / step) * step
  }
  stop = start + Math.ceil((stop - start) / step) * step
  // anchor shifts the bins so one boundary lands on the requested value
  const anchor = pnum(t.anchor)
  if (anchor != null) {
    const d = anchor - (start + step * Math.floor((anchor - start) / step))
    start += d
    stop += d
  }
  if (t.signal) ctx.signals[t.signal] = { start, stop, step }

  const band = t.interval !== false
  const [startField, endField] = t.as
  return rows.map((r) => {
    const raw = r[t.field]
    const n = raw == null || raw === '' ? null : Number(raw)
    let v: number | null = n == null || Number.isNaN(n) ? null : n
    if (v == null) return band ? { ...r, [startField]: null, [endField]: null } : { ...r, [startField]: null }
    if (v < start) v = -Infinity
    else if (v > stop) v = Infinity
    else {
      const clamped = Math.max(start, Math.min(v, stop - step))
      v = start + step * Math.floor(1e-9 + (clamped - start) / step)
    }
    if (!band) return { ...r, [startField]: v }
    const end = v == null ? null : start + step * (1 + (v - start) / step)
    return { ...r, [startField]: v, [endField]: end }
  })
}

function resolveExtent(
  extent: unknown,
  ctx: TransformContext,
): [number, number] | undefined {
  if (!extent) return undefined
  if (Array.isArray(extent) && extent.length === 2) {
    const [a, b] = extent
    if (typeof a === 'number' && typeof b === 'number') return [a, b]
  }
  if (extent && typeof extent === 'object' && 'signal' in extent) {
    const v = ctx.signals[(extent as { signal: string }).signal]
    if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'number' && typeof v[1] === 'number') {
      return [v[0], v[1]]
    }
  }
  return undefined
}

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

function imputeRows(
  rows: Row[],
  t: { field: string; groupby?: string[]; key: string; method?: string; value?: unknown; step?: number; keyvals?: unknown[] | { signal: string } },
  ctx?: TransformContext,
): Row[] {
  const groups = t.groupby?.length ? groupRows(rows, t.groupby) : [rows]
  const rawKeyvals = t.keyvals && typeof t.keyvals === 'object' && !Array.isArray(t.keyvals) && 'signal' in t.keyvals
    ? ctx?.signals[(t.keyvals as { signal: string }).signal]
    : t.keyvals
  const keyvals = Array.isArray(rawKeyvals) ? rawKeyvals : []
  const domain = Array.from(new Set([...rows.map((r) => r[t.key]), ...keyvals]))
    .filter((k) => k != null)
    .sort((a, b) => (a! < b! ? -1 : a! > b! ? 1 : 0))
  // vega emits the source tuples first, then appends the imputed tuples grouped
  // by partition (each group in key order).
  const imputed: Row[] = []
  for (const g of groups) {
    const sorted = g.slice().sort((a, b) => (a[t.key]! < b[t.key]! ? -1 : a[t.key]! > b[t.key]! ? 1 : 0))
    const present = new Set(sorted.map((r) => r[t.key]))
    let value = NaN
    for (const kVal of domain) {
      if (present.has(kVal)) continue
      const v = Number.isNaN(value) ? (value = imputeStat(sorted, t)) : value
      // vega emits only the partition fields, the key and the imputed measure;
      // spreading the first source row would leak its other columns into the
      // new tuple (and change downstream scales/marks).
      const row: Row = { _impute: true }
      for (const gk of t.groupby ?? []) row[gk] = sorted[0]?.[gk]
      row[t.key] = kVal
      row[t.field] = v
      imputed.push(row)
    }
  }
  return [...rows, ...imputed]
}

function imputeStat(group: Row[], t: { field: string; method?: string; value?: unknown }): number {
  const values = fieldValues(group, t.field)
  switch (t.method) {
    case 'mean':
      return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0
    case 'median': {
      if (!values.length) return 0
      const s = values.slice().sort((a, b) => a - b)
      const m = Math.floor(s.length / 2)
      return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
    }
    case 'min':
      return values.length ? Math.min(...values) : 0
    case 'max':
      return values.length ? Math.max(...values) : 0
    default:
      return typeof t.value === 'number' ? t.value : 0
  }
}

// ---------------------------------------------------------------------------
// aggregate / window / stack
// ---------------------------------------------------------------------------

const AGGR: Record<string, (values: number[], rows: Row[]) => number | undefined> = {
  count: (_v, rows) => rows.length,
  sum: (v) => (v.length ? v.reduce((a, b) => a + b, 0) : NaN),
  product: (v) => (v.length ? v.reduce((a, b) => a * b, 1) : NaN),
  mean: (v) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN),
  // vega's `average` is a pure alias of mean (AggregateOps: req ['mean'])
  average: (v) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN),
  min: (v) => Math.min(...v),
  max: (v) => Math.max(...v),
  median: (v) => {
    if (!v.length) return undefined
    const s = v.slice().sort((a, b) => a - b)
    const m = Math.floor(s.length / 2)
    return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
  },
  q1: (v) => (v.length ? quantileSorted(v.slice().filter(isFiniteNumber).sort((a, b) => a - b), 0.25) as number : undefined),
  q3: (v) => (v.length ? quantileSorted(v.slice().filter(isFiniteNumber).sort((a, b) => a - b), 0.75) as number : undefined),
  distinct: (v, rows) => new Set(v).size,
  valid: (v) => v.filter((x) => Number.isFinite(x)).length,
  missing: (v, rows) => rows.length - v.filter((x) => Number.isFinite(x)).length,
  // vega's aggregate ops (vega-transforms AggregateOps): the variance family
  // requires valid > 1 — otherwise undefined (the consuming mark renders a
  // zero-width/height rect, matching upstream)
  variance: (v) => {
    const vals = v.filter((x) => Number.isFinite(x))
    const n = vals.length
    if (n < 2) return undefined
    const m = vals.reduce((a, b) => a + b, 0) / n
    return vals.reduce((a, b) => a + (b - m) * (b - m), 0) / (n - 1)
  },
  variancep: (v) => {
    const vals = v.filter((x) => Number.isFinite(x))
    const n = vals.length
    if (!n) return NaN
    const m = vals.reduce((a, b) => a + b, 0) / n
    return vals.reduce((a, b) => a + (b - m) * (b - m), 0) / n
  },
  stdev: (v) => {
    const vals = v.filter((x) => Number.isFinite(x))
    const n = vals.length
    if (n < 2) return undefined
    const m = vals.reduce((a, b) => a + b, 0) / n
    return Math.sqrt(vals.reduce((a, b) => a + (b - m) * (b - m), 0) / (n - 1))
  },
  stdevp: (v) => {
    const vals = v.filter((x) => Number.isFinite(x))
    const n = vals.length
    if (!n) return NaN
    const m = vals.reduce((a, b) => a + b, 0) / n
    return Math.sqrt(vals.reduce((a, b) => a + (b - m) * (b - m), 0) / n)
  },
  stderr: (v) => {
    const vals = v.filter((x) => Number.isFinite(x))
    const n = vals.length
    if (n < 2) return undefined
    const m = vals.reduce((a, b) => a + b, 0) / n
    return Math.sqrt(vals.reduce((a, b) => a + (b - m) * (b - m), 0) / (n - 1)) / Math.sqrt(n)
  },
}

/** Aggregate a single (already-grouped) set of rows. Exported for the incremental
 * aggregate path, which re-derives only dirty groups and already knows their
 * membership — going through groupRows would rebuild a Map per group for nothing. */
export function aggregateGroup(rows: Row[], groupby: string[], fields: (string | null)[], ops: string[], as: string[], aggregateParams?: (number | null)[]): Row {
  const row: Row = {}
  for (const g of groupby) row[g] = rows[0]?.[g]
  ops.forEach((op, i) => {
    const field = fields[i]
    // vega's `values` op ignores the field and emits the group's tuples
    if (op === 'values') {
      row[as[i] ?? 'values'] = rows
      return
    }
    // the exponential measures fold over the rows in order with the ratio
    // from `aggregate_params` (vega Transform init(m, r)). VL emits no
    // aggregate_params, and vega's arithmetic then yields NaN (undefined is
    // not null: `undefined ** n` is NaN, `null ** n` is 0), so the aggregate
    // value is invalid and the post-aggregate filter drops every row.
    if (op === 'exponential' || op === 'exponentialb') {
      const r = aggregateParams?.[i]
      const rr = r as unknown as number
      let exp = 0
      let valid = 0
      for (const r2 of rows) {
        const v = field == null ? undefined : r2[field]
        if (v == null || !Number.isFinite(Number(v))) continue
        valid++
        exp = rr * exp + Number(v)
      }
      const oneMinusR = 1 - rr
      row[as[i] ?? `${op}_${field}`] = op === 'exponential'
        ? exp * oneMinusR / (1 - Math.pow(rr, valid))
        : exp * oneMinusR
      return
    }
    const values = field == null ? [] : fieldValues(rows, field)
    const rawValues = field == null ? [] : rows.map((r) => r[field])
    const present = rawValues.filter((v) => v != null && v !== '' && !(typeof v === 'number' && !Number.isFinite(v)))
    // String/date-bearing ops use the raw values (vega's AggregateOps measure
    // distinguishes numeric-only ops from valid/min/max/distinct).
    if (op === 'distinct') {
      // vega's distinct reads the group's stored TUPLES and stringifies every
      // value (`get(v) + ''`), so NaN/null count as their own distinct values.
      row[as[i] ?? `distinct_${field}`] = new Set(rawValues.map((v) => String(v))).size
      return
    }
    if (op === 'valid') {
      row[as[i] ?? `valid_${field}`] = present.length
      return
    }
    if (op === 'missing') {
      // vega counts only null/empty-string as missing; NaN is neither valid
      // nor missing.
      row[as[i] ?? `missing_${field}`] = rawValues.filter((v) => v == null || v === '').length
      return
    }
    if (op === 'min' || op === 'max') {
      if (!present.length) {
        row[as[i] ?? `${op}_${field}`] = undefined
        return
      }
      const cmp = (a: unknown, b: unknown): number => {
        const av = a instanceof Date ? a.getTime() : a as number | string
        const bv = b instanceof Date ? b.getTime() : b as number | string
        return av < bv ? -1 : av > bv ? 1 : 0
      }
      const best = present.reduce((a, b) => (op === 'min' ? (cmp(b, a) < 0 ? b : a) : (cmp(b, a) > 0 ? b : a)))
      row[as[i] ?? `${op}_${field}`] = best
      return
    }
    const fn = ownGet(AGGR, op)
    if (!fn) throw new Error(`[aster] unsupported aggregate op "${op}"`)
    row[as[i] ?? `${op}_${field}`] = fn(values, rows)
  })
  return row
}

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

function aggregateRows(rows: Row[], t: Extract<CompiledTransform, { type: 'aggregate' }>): Row[] {
  const groupby = t.groupby ?? []
  const fields = t.fields ?? []
  const ops = t.ops ?? []
  const as = t.as ?? []
  return groupRows(rows, groupby).map((g) => aggregateGroup(g, groupby, fields, ops, as, t.aggregate_params))
}

/**
 * Pivot: aggregate selected value fields to become new fields, one per unique
 * pivot-field value (vga's Pivot transform is an aggregate over an accessor that
 * yields `value(d)` when `key(d)===k` and NaN otherwise, so non-matching rows are
 * skipped). Pivot keys are the sorted unique values of `field` (optionally capped
 * by `limit`); the output has the `groupby` fields plus one field per key.
 */
function pivotRows(rows: Row[], t: Record<string, unknown>): Row[] {
  const keyField = t.field as string
  const valueField = t.value as string | undefined
  const op = (t.op as string | undefined) || 'sum'
  const groupby = (t.groupby as string[] | undefined) ?? []
  const limit = (t.limit as number | undefined) || 0

  const keySet = new Set<unknown>()
  for (const r of rows) keySet.add(r[keyField])
  const keys = [...keySet].filter((k) => k != null)
  keys.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const capped = limit ? keys.slice(0, limit) : keys
  if (!capped.length) return []
  const as = capped.map((k) => String(k))

  const groups = groupby.length ? groupRows(rows, groupby) : rows.length ? [rows] : []
  const out: Row[] = []
  for (const g of groups) {
    const row: Row = {}
    for (const k of groupby) row[k] = g[0]?.[k]
    capped.forEach((k, i) => {
      if (op === 'count') {
        // Vega's `count` op pivots on the number of matching rows per cell.
        row[as[i]!] = valueField == null ? g.length : g.filter((r) => r[keyField] === k).length
      } else {
        const fn = ownGet(AGGR, op)
        if (!fn) throw new Error(`[aster] unsupported aggregate op "${op}"`)
        const subset = valueField == null ? [] : g.filter((r) => r[keyField] === k)
        row[as[i]!] = fn(valueField == null ? [] : fieldValues(subset, valueField), subset)
      }
    })
    out.push(row)
  }
  return out
}

function joinAggregateRows(rows: Row[], t: Extract<CompiledTransform, { type: 'joinaggregate' }>): Row[] {
  const fields = t.fields ?? []
  const ops = t.ops ?? []
  const as = t.as ?? []
  // vega's Aggregate `key` accessor replaces the groupby tuple key entirely.
  const keyField = t.key
  const groupby = keyField != null ? [keyField] : (t.groupby ?? [])
  const grouped = groupRows(rows, groupby)
  const aggregates = new Map<string, Row>()
  for (const g of grouped) {
    const key = groupby.map((k) => String(g[0]?.[k])).join('\u0000')
    aggregates.set(key, aggregateGroup(g, groupby, fields, ops, as))
  }
  return rows.map((r) => {
    const key = groupby.map((k) => String(r[k])).join('\u0000')
    return { ...r, ...(aggregates.get(key) ?? {}) }
  })
}

function sortFieldsOf(sort: SortSpec | undefined): string[] | null {
  if (!sort?.field) return null
  return Array.isArray(sort.field) ? sort.field : [sort.field]
}

/**
 * Peer test for the window `rank` / `dense_rank` ops, matching vega's window
 * comparator: two sorted rows are peers iff their sort keys are equal on every
 * sort field. With no sort, vega uses `constant(-1)` (every row is its own peer
 * group), so we return `false` to force a fresh rank each row.
 */
function isPeer(a: Row, b: Row, fields: string[] | null): boolean {
  if (!fields) return false
  for (const f of fields) {
    if (a[f] !== b[f]) return false
  }
  return true
}

function windowRows(rows: Row[], t: Extract<CompiledTransform, { type: 'window' }>): Row[] {
  const sorted = sortRows(rows, t.sort)
  const groupby = t.groupby ?? []
  const fields = t.fields ?? []
  const ops = t.ops ?? []
  const params = (t as { params?: (number | null)[] }).params ?? []
  const aggParams = (t as { aggregate_params?: (number | null)[] }).aggregate_params ?? []
  const as = t.as ?? []
  const groups = groupby.length ? groupRows(sorted, groupby) : [sorted]
  const sortFields = sortFieldsOf(t.sort)
  const frame = (t.frame ?? [null, 0]) as [number | null, number | null]
  const ignorePeers = t.ignorePeers === true
  const results = new Map<Row, Row>()

  // window op state is per partition per op
  for (const g of groups) {
    const n = g.length
    let rank = 1
    let drank = 1
    const prevValues: unknown[] = ops.map(() => null)
    const nextValues: unknown[] = ops.map(() => null)
    const nextIndex: number[] = ops.map(() => -1)
    for (let i = 0; i < n; i++) {
      if (i > 0 && !isPeer(g[i - 1]!, g[i]!, sortFields)) {
        rank = i + 1
        drank++
      }
      // frame boundaries in vega's [startOffset, endOffset] convention
      let i0 = frame[0] == null ? 0 : i + frame[0]
      let i1 = frame[1] == null ? n : i + frame[1] + 1
      i0 = Math.max(0, Math.min(n, i0))
      i1 = Math.max(0, Math.min(n, i1))
      if (t.sort && !ignorePeers) {
        // range frames expand to include peer rows
        if (i0 > 0 && isPeer(g[i0]!, g[i0 - 1]!, sortFields)) {
          while (i0 > 0 && isPeer(g[i0]!, g[i0 - 1]!, sortFields)) i0--
        }
        if (i1 > 0 && i1 < n && isPeer(g[i1 - 1]!, g[i1]!, sortFields)) {
          while (i1 < n && isPeer(g[i1 - 1]!, g[i1]!, sortFields)) i1++
        }
      }
      const r = { ...g[i]! }
      const frameRows = g.slice(i0, i1)
      const cumeDist = (): number => {
        let last = i
        while (last + 1 < n && isPeer(g[last]!, g[last + 1]!, sortFields)) last++
        return (1 + last) / n
      }
      const fieldValue = (field: string | null | undefined, row: Row | undefined): unknown =>
        field == null || row == null ? null : row[field]
      ops.forEach((op, j) => {
        const name = as[j] ?? `${op}_${fields[j]}`
        const field = fields[j]
        const param = params[j]
        switch (op) {
          case 'row_number':
            r[name] = i + 1
            break
          case 'rank':
            r[name] = rank
            break
          case 'dense_rank':
            r[name] = drank
            break
          case 'percent_rank':
            r[name] = (rank - 1) / (n - 1)
            break
          case 'cume_dist':
            r[name] = cumeDist()
            break
          case 'ntile': {
            const num = Number(param)
            r[name] = Math.ceil(num * cumeDist())
            break
          }
          case 'lag': {
            const off = Number(param) || 1
            r[name] = i - off >= 0 ? fieldValue(field, g[i - off]) : null
            break
          }
          case 'lead': {
            const off = Number(param) || 1
            r[name] = i + off < n ? fieldValue(field, g[i + off]) : null
            break
          }
          case 'first_value':
            r[name] = fieldValue(field, g[i0])
            break
          case 'last_value':
            r[name] = fieldValue(field, g[i1 - 1])
            break
          case 'nth_value': {
            const nth = Number(param)
            const idx = i0 + (nth - 1)
            r[name] = idx < i1 ? fieldValue(field, g[idx]) : null
            break
          }
          case 'prev_value': {
            const v = fieldValue(field, g[i])
            if (v != null) prevValues[j] = v
            r[name] = prevValues[j]
            break
          }
          case 'next_value': {
            if (i <= nextIndex[j]!) r[name] = nextValues[j]
            else {
              let k = i
              while (k < n && fieldValue(field, g[k]) == null) k++
              if (k >= n) { nextIndex[j] = n; nextValues[j] = null }
              else { nextIndex[j] = k; nextValues[j] = fieldValue(field, g[k]) }
              r[name] = nextValues[j]
            }
            break
          }
          case 'values':
            r[name] = frameRows
            break
          case 'count':
            r[name] = frameRows.length
            break
          default: {
            // every aggregate op resolves through the same measure port
            const agg = aggregateGroup(frameRows, [], [field ?? null], [op], [name], [aggParams[j] ?? null])
            r[name] = agg[name]
          }
        }
      })
      results.set(g[i]!, r)
    }
  }
  // vega's Window writes back to the input pulse in source order; the group and
  // sort order only drive the calculations.
  return rows.map((r) => results.get(r) ?? r)
}

function stackRows(rows: Row[], t: Extract<CompiledTransform, { type: 'stack' }>): Row[] {
  const groupby = t.groupby ?? []
  const groups = groupby.length ? groupRows(rows, groupby) : [rows]
  const [startField, endField] = t.as

  // vega's stack (vega-encode Stack.partition) computes the max group sum
  // across ALL groups; the `center` offset anchors each group's baseline at
  // (max - groupSum) / 2 so the largest group sits on zero and smaller groups
  // float above it (the streamgraph layout). `normalize` rescales each group
  // to [0, 1]. `zero` (default) stacks positives upward, negatives downward.
  let max = 0
  const sums: number[] = []
  for (const g of groups) {
    const s = g.reduce((a, r) => a + Math.abs(Number(r[t.field]) || 0), 0)
    sums.push(s)
    if (s > max) max = s
  }

  // vega's Stack writes the start/end fields onto each tuple IN PLACE: the
  // groups and `sort` only drive the offsets, the output keeps the input
  // (pulse) order. Emitting group by group would repaint overlapping stacked
  // marks in another order than the oracle.
  const placed = new Map<Row, [number, number]>()
  for (let gi = 0; gi < groups.length; gi++) {
    const ordered = sortRows(groups[gi]!, t.sort)
    const total = sums[gi]!
    if (t.offset === 'normalize') {
      const scale = total === 0 ? 0 : 1 / total
      let last = 0
      for (const r of ordered) {
        const start = last
        const end = (last += scale * Math.abs(Number(r[t.field]) || 0))
        placed.set(r, [start, end])
      }
    } else if (t.offset === 'center') {
      let last = (max - total) / 2
      for (const r of ordered) {
        const start = last
        const end = (last += Math.abs(Number(r[t.field]) || 0))
        placed.set(r, [start, end])
      }
    } else {
      let lastPos = 0
      let lastNeg = 0
      for (const r of ordered) {
        const v = Number(r[t.field]) || 0
        if (v < 0) {
          const start = lastNeg
          const end = (lastNeg += v)
          placed.set(r, [start, end])
        } else {
          const start = lastPos
          const end = (lastPos += v)
          placed.set(r, [start, end])
        }
      }
    }
  }
  return rows.map((r) => {
    const se = placed.get(r)
    return se ? { ...r, [startField]: se[0], [endField]: se[1] } : r
  })
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

// -- shared numeric helpers (d3-array compatible) ------------------------------

export function ascendingNum(a: number, b: number): number {
  return a == null || b == null ? NaN : a < b ? -1 : a > b ? 1 : a >= b ? 0 : NaN
}

/** d3-array `range(start, stop, step)` (numeric output only). */
export function d3Range(start: number, stop: number, step: number): number[] {
  start = +start
  stop = +stop
  step = +step
  const n = Math.max(0, Math.ceil((stop - start) / step)) | 0
  const out: number[] = new Array(n)
  for (let i = 0; i < n; i++) out[i] = start + i * step
  return out
}

// ---------------------------------------------------------------------------
// sequence / graticule (generating transforms)
// ---------------------------------------------------------------------------

/**
 * The vega `sequence` transform: generate tuples for a numeric range
 * `[start, stop)` in `step` increments (d3-array range semantics), writing each
 * value to the `as` field (default `data`).
 */
function sequenceRows(t: Record<string, unknown>): Row[] {
  const start = t.start == null ? 0 : Number(t.start)
  const stop = Number(t.stop)
  const step = t.step == null ? 1 : Number(t.step)
  const as = (t.as as string | undefined) ?? 'data'
  return d3Range(start, stop, step).map((v) => ({ [as]: v }))
}

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

function d3TickStep(start: number, stop: number, count: number): number {
  const step0 = Math.abs(stop - start) / Math.max(0, count)
  let step1 = Math.pow(10, Math.floor(Math.log(step0) / Math.LN10))
  const error = step0 / step1
  if (error >= Math.sqrt(50)) step1 *= 10
  else if (error >= Math.sqrt(10)) step1 *= 5
  else if (error >= Math.sqrt(2)) step1 *= 2
  return stop < start ? -step1 : step1
}

/** vega Contour `quantize(k, nice, zero)` -> threshold generator. */
function contourQuantize(k: number, nice: boolean, zero: boolean): (values: Float32Array | number[]) => number[] {
  return (values) => {
    let mn: number | undefined
    let mx: number | undefined
    const arr = values as ArrayLike<number>
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i]!
      if (v == null || v !== v) continue
      if (mn === undefined) { mn = v; mx = v; continue }
      if (v < mn) mn = v
      if (v > mx!) mx = v
    }
    if (mn === undefined) mn = NaN
    if (mx === undefined) mx = NaN
    const mnv = mn as number
    const mxv = mx as number
    const start = zero ? Math.min(mnv, 0) : mnv
    const stop = mxv
    const span = stop - start
    const step = nice ? d3TickStep(start, stop, k) : span / (k + 1)
    return d3Range(start + step, stop, step)
  }
}

function blurX(n: number, m: number, source: Float32Array, target: Float32Array, r: number): void {
  const w = (r << 1) + 1
  for (let j = 0; j < m; ++j) {
    for (let i = 0, sr = 0; i < n + r; ++i) {
      if (i < n) sr += source[i + j * n]!
      if (i >= r) {
        if (i >= w) sr -= source[i - w + j * n]!
        target[i - r + j * n] = sr / Math.min(i + 1, n - 1 + w - i, w)
      }
    }
  }
}
function blurY(n: number, m: number, source: Float32Array, target: Float32Array, r: number): void {
  const w = (r << 1) + 1
  for (let i = 0; i < n; ++i) {
    for (let j = 0, sr = 0; j < m + r; ++j) {
      if (j < m) sr += source[i + j * n]!
      if (j >= r) {
        if (j >= w) sr -= source[i + (j - w) * n]!
        target[i + (j - r) * n] = sr / Math.min(j + 1, m - 1 + w - j, w)
      }
    }
  }
}
/**
 * Silverman's rule-of-thumb bandwidth (vega-statistics `estimateBandwidth`):
 * 1.06 * min(sample stdev, IQR/1.34) * n^-0.2.
 */
export function estimateBandwidth(array: number[]): number {
  const n = array.length
  const d = deviationOf(array)
  const q = quartilesOf(array)
  const h = (q[2]! - q[0]!) / 1.34
  const v = Math.min(d!, h) || d || Math.abs(q[0]!) || 1
  return 1.06 * v * Math.pow(n, -0.2)
}

function quartilesOf(values: number[]): number[] {
  const filtered: number[] = []
  for (const raw of values) {
    const value = +raw
    if (value != null && value >= value) filtered.push(value)
  }
  filtered.sort(ascendingNum)
  return [
    quantileSorted(filtered, 0.25)!,
    quantileSorted(filtered, 0.5)!,
    quantileSorted(filtered, 0.75)!,
  ]
}

function bwRadius(bw: number, data: number[]): number {
  const v = bw >= 0 ? bw : estimateBandwidth(data)
  return Math.round((Math.sqrt(4 * v * v + 1) - 1) / 2)
}

interface DensityGrid { values: Float32Array; scale: number; width: number; height: number; x1: number; y1: number }

function density2D(
  xs: number[], ys: number[], weights: number[],
  dx: number, dy: number, bandwidth: [number, number], k: number,
): DensityGrid {
  const rx = bwRadius(bandwidth[0], xs) >> k
  const ry = bwRadius(bandwidth[1], ys) >> k
  const ox = rx ? rx + 2 : 0
  const oy = ry ? ry + 2 : 0
  const n = 2 * ox + (dx >> k)
  const m = 2 * oy + (dy >> k)
  const values0 = new Float32Array(n * m)
  const values1 = new Float32Array(n * m)
  let values = values0
  for (let d = 0; d < xs.length; d++) {
    const xi = ox + (xs[d]! >> k)
    const yi = oy + (ys[d]! >> k)
    if (xi >= 0 && xi < n && yi >= 0 && yi < m) values0[xi + yi * n]! += weights[d]!
  }
  if (rx > 0 && ry > 0) {
    blurX(n, m, values0, values1, rx); blurY(n, m, values1, values0, ry)
    blurX(n, m, values0, values1, rx); blurY(n, m, values1, values0, ry)
    blurX(n, m, values0, values1, rx); blurY(n, m, values1, values0, ry)
  } else if (rx > 0) {
    blurX(n, m, values0, values1, rx); blurX(n, m, values1, values0, rx); blurX(n, m, values0, values1, rx); values = values1
  } else if (ry > 0) {
    blurY(n, m, values0, values1, ry); blurY(n, m, values1, values0, ry); blurY(n, m, values0, values1, ry); values = values1
  }
  let sum = 0
  for (let i = 0; i < values.length; i++) sum += values[i]!
  const s = Math.pow(2, -2 * k)
  for (let i = 0; i < values.length; i++) values[i]! *= s
  return { values, scale: 1 << k, width: n, height: m, x1: ox, y1: oy }
}

function contourPost(grid: DensityGrid, sx: number, sy: number): (geometry: { coordinates: unknown }) => unknown {
  const x1 = grid.x1 || 0
  const y1 = grid.y1 || 0
  const flip = sx * sy < 0
  const transformPoint = (c: number[]) => { c[0] = (c[0]! - x1) * sx; c[1] = (c[1]! - y1) * sy }
  const transformRing = (c: number[][]) => { if (flip) c.reverse(); c.forEach(transformPoint) }
  const transformPolygon = (c: number[][][]) => c.forEach(transformRing)
  return (geometry) => { (geometry.coordinates as number[][][][]).forEach(transformPolygon); return geometry }
}

function contourRows(rows: Row[], t: Record<string, unknown>, ctx: TransformContext): Row[] {
  // size: [w, h] numbers, signal objects, or a single signal expression.
  let size: [number, number]
  if (Array.isArray(t.size)) {
    const rs = resolveSizeParam(t.size, ctx)
    size = rs ?? [Number(resolveNum(t.size[0], ctx)) || 500, Number(resolveNum(t.size[1], ctx)) || 500]
  } else {
    const resolved = resolveNum(t.size, ctx)
    size = Array.isArray(resolved) ? [Number(resolved[0]), Number(resolved[1])] : [resolved ?? 500, resolved ?? 500]
  }
  const [dx, dy] = size
  const k = t.cellSize ? Math.floor(Math.log(Number(t.cellSize)) / Math.LN2) : 2

  // Build the value grid either from a raw `values` array or from point tuples.
  let gridValues: Float32Array | number[]
  let post: ((g: { coordinates: unknown }) => unknown) | null = null
  let gridSize: [number, number] = size
  if (Array.isArray(t.values)) {
    gridValues = t.values as number[]
  } else {
    const xf = t.x != null ? accessorField(String(t.x)) : null
    const yf = t.y != null ? accessorField(String(t.y)) : null
    const wf = t.weight != null ? accessorField(String(t.weight)) : null
    const xs: number[] = []
    const ys: number[] = []
    const ws: number[] = []
    for (const r of rows) {
      xs.push(Number(xf ? xf(r) : (r as { x?: unknown }).x))
      ys.push(Number(yf ? yf(r) : (r as { y?: unknown }).y))
      ws.push(Number(wf ? wf(r) : 1))
    }
    const bw: [number, number] = Array.isArray(t.bandwidth) ? [Number(t.bandwidth[0]), Number((t.bandwidth as number[])[1] ?? t.bandwidth[0])]
      : t.bandwidth != null ? [Number(t.bandwidth), Number(t.bandwidth)] : [-1, -1]
    const grid = density2D(xs, ys, ws, dx, dy, bw, k)
    gridValues = grid.values
    gridSize = [grid.width, grid.height]
    post = contourPost(grid, grid.scale, grid.scale)
  }

  const thresholds = Array.isArray(t.thresholds) ? (t.thresholds as number[])
    : contourQuantize(Number(t.count ?? 10), !!t.nice, false)(gridValues)

  const contourRun = geoRegistry.contourRun
  if (!contourRun) requireGeo() // throws: geo addon not loaded
  const features = contourRun!(gridValues, thresholds, gridSize, t.smooth !== false)
  // d3-contour returns {type, value, coordinates} directly; vega ingests each
  // as the tuple (top-level fields), after a coordinate post-transform that
  // maps grid indices back to pixel space. `as` is ignored by vega's Contour.
  return features.map((f) => {
    if (post) (post as (g: { coordinates: unknown }) => unknown)({ coordinates: f.coordinates })
    return { type: f.type, value: f.value, coordinates: f.coordinates } as Row
  })
}

export function resolveNum(v: unknown, ctx: TransformContext): number | number[] | undefined {
  if (typeof v === 'number') return v
  if (v && typeof v === 'object' && 'signal' in (v as Record<string, unknown>)) {
    try {
      const r = ctx.runtime.expr(String((v as { signal: string }).signal))({}, ctx.signals)
      return Array.isArray(r) ? (r as number[]) : (typeof r === 'number' ? r : undefined)
    } catch { return undefined }
  }
  return undefined
}
function accessorField(name: string): (row: Row) => unknown {
  return (row) => getField(row, name)
}

/**
 * Canonical order of time units from coarsest to finest (matches vega-time).
 * The "finest" unit in a set determines what gets incremented for the end date.
 */
const TIME_UNIT_ORDER = ['year', 'quarter', 'month', 'week', 'date', 'hours', 'minutes', 'seconds', 'milliseconds']

function timeunitRows(rows: Row[], t: Record<string, unknown>): Row[] {
  const field = t.field as string
  const units = (t.units as string[]) ?? []
  const as = (t.as as [string, string]) ?? [field + '_start', field + '_end']

  return rows.map((r) => {
    const v = r[field]
    const d = v instanceof Date ? v : new Date(v as string | number)
    if (!Number.isFinite(d.getTime())) {
      // vega's timeunit transform emits an invalid Date for unparseable input
      // (its legend/axis formatters then render the unit-specific NaN string,
      // e.g. "0NaN"/"WNaN").
      const bad = new Date(NaN)
      return { ...r, [as[0]]: bad, [as[1]]: bad }
    }
    const start = timeFloor(d, units)
    const end = timeOffset(start, units)
    return { ...r, [as[0]]: start, [as[1]]: end }
  })
}

/**
 * Floor a Date to the start of the specified time unit(s).
 * E.g. timeFloor(date, ['month']) → 1st of the month 00:00:00.000 UTC.
 */
function timeFloor(d: Date, units: string[]): Date {
  // vega-time's floor.js: units missing a coarser context fall back to a
  // canonical year (2012), month zero, and date 1. DAY/WEEK/DAYOFYEAR are
  // projected onto that canonical year rather than reset to Jan 1.
  const u = new Set(units)
  const year = u.has('year') ? d.getUTCFullYear() : 2012
  const month = u.has('month')
    ? d.getUTCMonth()
    : u.has('quarter') ? 3 * Math.floor(d.getUTCMonth() / 3) : 0
  const firstDay = (y: number): number => new Date(Date.UTC(y, 0, 1)).getUTCDay()
  const dayOfYear = (x: Date): number => {
    const y = Date.UTC(x.getUTCFullYear(), 0, 1)
    return Math.floor((x.getTime() - (y - 1)) / 86400000) + 1
  }
  const weekNum = (x: Date): number => {
    const y = Date.UTC(x.getUTCFullYear(), 0, 1)
    const sunday = new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate() - x.getUTCDay()))
    return Math.floor((sunday.getTime() - (y - 1)) / 604800000) + 1
  }
  const weekday = (week: number, day: number, first: number): number =>
    day + week * 7 - (first + 6) % 7
  let date: number
  if (u.has('week') && u.has('day')) date = weekday(weekNum(d), d.getUTCDay(), firstDay(year))
  else if (u.has('week')) date = weekday(weekNum(d), 0, firstDay(year))
  else if (u.has('day')) date = weekday(1, d.getUTCDay(), firstDay(year))
  else if (u.has('date')) date = d.getUTCDate()
  else if (u.has('dayofyear')) date = dayOfYear(d)
  else date = 1
  const hours = u.has('hours') ? d.getUTCHours() : 0
  const minutes = u.has('minutes') ? d.getUTCMinutes() : 0
  const seconds = u.has('seconds') ? d.getUTCSeconds() : 0
  const ms = u.has('milliseconds') ? d.getUTCMilliseconds() : 0
  return new Date(Date.UTC(year, month, date, hours, minutes, seconds, ms))
}

/**
 * Offset a Date by one step of the finest time unit in the set.
 * E.g. timeOffset(date, ['month']) → 1st of the next month.
 */
function timeOffset(d: Date, units: string[]): Date {
  const u = new Date(d.getTime())
  // Find the finest unit
  let finestIdx = TIME_UNIT_ORDER.length
  for (const unit of units) {
    const idx = TIME_UNIT_ORDER.indexOf(unit)
    if (idx >= 0 && idx < finestIdx) finestIdx = idx
  }
  if (finestIdx >= TIME_UNIT_ORDER.length) {
    // No recognized units — just add 1ms
    u.setTime(u.getTime() + 1)
    return u
  }
  const finest = TIME_UNIT_ORDER[finestIdx]!

  switch (finest) {
    case 'year': u.setUTCFullYear(u.getUTCFullYear() + 1); break
    case 'quarter': u.setUTCMonth(u.getUTCMonth() + 3); break
    case 'month': u.setUTCMonth(u.getUTCMonth() + 1); break
    case 'week': u.setUTCDate(u.getUTCDate() + 7); break
    case 'date': u.setUTCDate(u.getUTCDate() + 1); break
    case 'hours': u.setUTCHours(u.getUTCHours() + 1); break
    case 'minutes': u.setUTCMinutes(u.getUTCMinutes() + 1); break
    case 'seconds': u.setUTCSeconds(u.getUTCSeconds() + 1); break
    case 'milliseconds': u.setUTCMilliseconds(u.getUTCMilliseconds() + 1); break
  }
  return u
}

/** d3-array `quantileSorted(values, p)` — values must be sorted ascending. */
export function quantileSorted(values: number[], p: number): number | undefined {
  const n = values.length
  if (!n || Number.isNaN((p = +p))) return undefined
  if (p <= 0 || n < 2) return +values[0]!
  if (p >= 1) return +values[n - 1]!
  const i = (n - 1) * p
  const i0 = Math.floor(i)
  const value0 = +values[i0]!
  const value1 = +values[i0 + 1]!
  return value0 + (value1 - value0) * (i - i0)
}

/** d3-array `variance` (sample variance, Welford-style online update). */
function varianceSample(values: number[]): number | undefined {
  let count = 0
  let mean = 0
  let sum = 0
  for (let raw of values) {
    const value = +raw
    if (value != null && value >= value) {
      const delta = value - mean
      mean += delta / ++count
      sum += delta * (value - mean)
    }
  }
  if (count > 1) return sum / (count - 1)
  return undefined
}

/** d3-array `deviation` (sample standard deviation). */
export function deviationOf(values: number[]): number | undefined {
  const v = varianceSample(values)
  return v ? Math.sqrt(v) : v
}

/** d3-array `extent` over numeric field values. */
export function extentOf(values: unknown[]): [number, number] | undefined {
  let min: number | undefined
  let max: number | undefined
  for (const raw of values) {
    if (raw != null) {
      const value = +raw
      if (min === undefined) {
        if (value >= value) min = max = value
      } else {
        if (min > value) min = value
        if (max! < value) max = value
      }
    }
  }
  return min === undefined ? undefined : [min, max!]
}

// ---------------------------------------------------------------------------
// lookup (vega-transforms Lookup)
// ---------------------------------------------------------------------------

/**
 * Extend tuples by joining them with values from a lookup table (by key).
 * Without an explicit `values` list each `as` field receives the entire matched
 * row object; with `values` it receives the named sub-field of the match.
 * A failed lookup yields the `default` (null unless specified).
 */
function lookupRows(rows: Row[], t: Record<string, unknown>, ctx: TransformContext): Row[] {
  const from = t.from as string
  const key = t.key as string
  const fields = (t.fields as string[]) ?? []
  const as = (t.as as string[] | undefined) ?? fields
  const values = t.values as string[] | undefined
  const defaultValue = t.default == null ? null : t.default

  const source = (ctx.datasets?.(from) ?? []) as Row[]
  const index = new Map<unknown, Row>()
  for (const r of source) {
    const k = r[key]
    if (k !== undefined && !index.has(k)) index.set(k, r)
  }

  const n = fields.length
  const m = values?.length ?? 0
  return rows.map((r) => {
    const out: Row = { ...r }
    if (values) {
      for (let i = 0; i < n; i++) {
        const v = index.get(r[fields[i]!])
        for (let j = 0; j < m; j++) {
          out[as[i * m + j]!] = v == null ? defaultValue : (v as Row)[values[j]!]
        }
      }
    } else {
      for (let i = 0; i < n; i++) {
        out[as[i]!] = index.get(r[fields[i]!]) ?? defaultValue
      }
    }
    return out
  })
}

// ---------------------------------------------------------------------------
// stratify / pack (d3-hierarchy circle packing)
//
// The vega `pack` transform wraps d3-hierarchy's `pack` layout, which assigns
// x/y/r to every node. To match the oracle bit-for-bit the d3 algorithm is
// ported operation-for-operation (packSiblingsRandom + the Welzl-style
// minimal-enclosing-circle computation in pack/enclose.js). The layout needs
// the tree that a preceding `stratify` transform built; vega threads it through
// `pulse.source.root`, we thread it through `TransformContext.hierarchies`.
// ---------------------------------------------------------------------------

export interface HierNode {
  data: Row
  children: HierNode[]
  parent: HierNode | null
  depth: number
  height: number
  x: number
  y: number
  r: number
  value: number
  /** Treemap bounding rectangle (d3-hierarchy node.x0/x1/y0/y1). */
  x0?: number
  y0?: number
  x1?: number
  y1?: number
}

/** Pre-order traversal (d3 `node.eachBefore`). */
export function eachBefore(root: HierNode, fn: (node: HierNode) => void): void {
  const nodes: (HierNode | undefined)[] = [root]
  let node: HierNode | undefined
  while ((node = nodes.pop()) != null) {
    fn(node)
    const children = node.children
    if (children.length) {
      for (let i = children.length - 1; i >= 0; i--) nodes.push(children[i])
    }
  }
}

/** Post-order traversal (d3 `node.eachAfter`). */
export function eachAfter(root: HierNode, fn: (node: HierNode) => void): void {
  const nodes: (HierNode | undefined)[] = [root]
  const next: HierNode[] = []
  let node: HierNode | undefined = root
  while (node != null) {
    next.push(node)
    const children = node.children
    if (children.length) {
      for (let i = children.length - 1; i >= 0; i--) nodes.push(children[i])
    }
    node = nodes.pop()
  }
  while ((node = next.pop()) != null) fn(node)
}

/** Build a hierarchy tree from flat id/parent-id tuples (d3 `stratify`). */
export function buildStratifyTree(rows: Row[], key?: string, parentKey?: string): HierNode {
  if (!key) throw new Error('[aster] stratify requires a key field')
  const byKey = new Map<unknown, HierNode>()
  for (const r of rows) {
    byKey.set(r[key], { data: r, children: [], parent: null, depth: 0, height: 0, x: 0, y: 0, r: 0, value: 0 })
  }
  let root: HierNode | null = null
  for (const r of rows) {
    const node = byKey.get(r[key])
    if (!node) continue
    const pid = parentKey ? r[parentKey] : undefined
    if (pid == null || pid === '') {
      root = node
    } else {
      const parent = byKey.get(pid)
      if (parent) {
        parent.children.push(node)
        node.parent = parent
      }
    }
  }
  if (!root) root = byKey.get(rows[0]?.[key]) ?? null
  if (!root) throw new Error('[aster] stratify: no root node found')
  eachBefore(root, (node) => {
    node.depth = node.parent ? node.parent.depth + 1 : 0
  })
  eachAfter(root, (node) => {
    node.height = node.children.length ? Math.max(...node.children.map(c => c.height)) + 1 : 0
  })
  return root
}

// ---------------------------------------------------------------------------
// label (vega-label, plain-data path)
//
// The vega `label` transform places each datum's text label relative to its
// base-mark boundary. For plain data tuples (no mark context — `marktype` is
// undefined) the boundary is the tuple's own (x, y), and labels are placed
// anchor-by-anchor (default order starts top-left with offset 1) into a
// coarse bitmap used for overlap detection. This port covers exactly that
// path (the mark-based path needs a canvas and is not reachable in a headless
// process). Output fields default to [x, y, opacity, align, baseline].
// ---------------------------------------------------------------------------

const LABEL_ANCHOR_CODE: Record<string, number> = {
  'top-left': 0x0,
  top: 0x1,
  'top-right': 0x2,
  left: 0x4,
  middle: 0x5,
  right: 0x6,
  'bottom-left': 0x8,
  bottom: 0x9,
  'bottom-right': 0xa,
}

const LABEL_ALIGNS = ['right', 'center', 'left']
const LABEL_BASELINES = ['bottom', 'middle', 'top']

/** Row-major bit array (vega-label `util/Bitmap.js`). */
function labelBitmap(w: number, h: number) {
  const SIZE = 32
  const RIGHT0 = new Uint32Array(SIZE + 1)
  const RIGHT1 = new Uint32Array(SIZE + 1)
  RIGHT1[0] = 0
  RIGHT0[0] = ~RIGHT1[0]
  for (let i = 1; i <= SIZE; ++i) {
    RIGHT1[i] = (RIGHT1[i - 1]! << 1) | 1
    RIGHT0[i] = ~RIGHT1[i]!
  }
  const array = new Uint32Array(~~((w * h + SIZE) / SIZE))
  return {
    array,
    outOfBounds: (x: number, y: number, x2: number, y2: number): boolean => x < 0 || y < 0 || y2 >= h || x2 >= w,
    getRange: (x: number, y: number, x2: number, y2: number): boolean => {
      let r = y2
      for (; r >= y; --r) {
        const start = r * w + x
        const end = r * w + x2
        const indexStart = start >>> 5
        const indexEnd = end >>> 5
        if (indexStart === indexEnd) {
          if (array[indexStart]! & RIGHT0[start & 31]! & RIGHT1[(end & 31) + 1]!) return true
        } else {
          if (array[indexStart]! & RIGHT0[start & 31]!) return true
          if (array[indexEnd]! & RIGHT1[(end & 31) + 1]!) return true
          for (let i = indexStart + 1; i < indexEnd; ++i) {
            if (array[i]) return true
          }
        }
      }
      return false
    },
    setRange: (x: number, y: number, x2: number, y2: number): void => {
      for (; y <= y2; ++y) {
        const start = y * w + x
        const end = y * w + x2
        const indexStart = start >>> 5
        const indexEnd = end >>> 5
        if (indexStart === indexEnd) {
          array[indexStart]! |= RIGHT0[start & 31]! & RIGHT1[(end & 31) + 1]!
        } else {
          array[indexStart]! |= RIGHT0[start & 31]!
          array[indexEnd]! |= RIGHT1[(end & 31) + 1]!
          for (let i = indexStart + 1; i < indexEnd; ++i) array[i] = 0xffffffff
        }
      }
    },
  }
}

/**
 * The vega `label` transform. Each datum's label is placed relative to its own
 * (x, y): the default anchor sweep starts at top-left with offset 1, which for
 * well-separated points is free — each label lands at `x - offset/√2` with
 * `y` NaN (the datum carries no `fontSize`), which vega serializes as `null`.
 */
function labelRows(rows: Row[], t: Record<string, unknown>, ctx: TransformContext): Row[] {
  if (!rows.length) return rows
  const size = resolveSizeParam(t.size, ctx)
  if (!size || size.length !== 2) {
    throw new Error('[aster] label transform requires a [width, height] size parameter')
  }

  const as = (t.as as string[] | undefined) ?? ['x', 'y', 'opacity', 'align', 'baseline']
  const rawOffset = t.offset == null ? 1 : t.offset
  const offsets = (Array.isArray(rawOffset) ? rawOffset : [rawOffset]).map((v) => Number(v) || 0)
  const anchors = (t.anchor as string[] | undefined) ?? [
    'top-left', 'left', 'bottom-left', 'top', 'bottom', 'top-right', 'right', 'bottom-right',
  ]
  const positions = Math.max(offsets.length, anchors.length)
  const offs: number[] = []
  const anc: number[] = []
  for (let i = 0; i < positions; i++) {
    offs[i] = offsets[Math.min(i, offsets.length - 1)]!
    const name = anchors[Math.min(i, anchors.length - 1)]!
    anc[i] = (Object.hasOwn(LABEL_ANCHOR_CODE, name) ? LABEL_ANCHOR_CODE[name] : undefined) ?? 0
  }

  // scaler (vega-label `util/scaler.js`) with padding 0.
  const [width, height] = size
  const ratio = Math.max(1, Math.sqrt((width * height) / 1e6))
  const bw = ~~((width + ratio) / ratio)
  const bh = ~~((height + ratio) / ratio)
  const scale = (_: number): number => ~~(_ / ratio)

  // baseBitmaps: mark each datum's anchor point (x, y) in the bitmap.
  const bm = labelBitmap(bw, bh)
  for (const r of rows) {
    const x = ~~(Number(r.x) / ratio)
    const y = ~~(Number(r.y) / ratio)
    if (x >= 0 && y >= 0 && x < bw && y < bh) {
      bm.array[(y * bw + x) >>> 5]! |= 1 << ((y * bw + x) & 31)
    }
  }

  const n = positions
  const boundary = (r: Row): number[] => {
    const x = Number(r.x)
    const y = Number(r.y)
    return [x, x, x, y, y, y]
  }

  const out: Row[] = []
  for (const r of rows) {
    const b = boundary(r)
    const textHeight = r.fontSize as number | undefined
    const rawText = r.text as string | undefined
    let placedX: number | undefined
    let placedY: number | undefined
    let placedAnchor = -1
    let textWidth = 0

    for (let i = 0; i < n; ++i) {
      const dx = (anc[i]! & 0x3) - 1
      const dy = ((anc[i]! >>> 2) & 0x3) - 1

      const sizeFactor = dx && dy ? Math.SQRT1_2 : 1
      const insideFactor = offs[i]! < 0 ? -1 : 1

      const x1 = b[1 + dx]! + offs[i]! * dx * sizeFactor
      // `textHeight` is the datum's fontSize (undefined for plain data → NaN
      // in the y arithmetic, exactly as vega computes it).
      const yc = b[4 + dy]! + (insideFactor * (textHeight as number) * dy) / 2 + offs[i]! * dy * sizeFactor
      const y1 = yc - (textHeight as number) / 2
      const y2 = yc + (textHeight as number) / 2

      const _x1 = scale(x1)
      const _y1 = scale(y1)
      const _y2 = scale(y2)

      if (!textWidth) {
        if (bm.outOfBounds(_x1, _x1, _y1, _y2) || bm.getRange(_x1, _y1, _x1, _y2)) {
          continue
        }
        // vega textMetrics: canvas measureText when available, the headless
        // estimate (`0.8 * chars * fontSize`) otherwise.
        textWidth = nominalTextWidth(String(rawText ?? ''), (textHeight as number | undefined) ?? 11)
      }

      const xc = x1 + (insideFactor * textWidth * dx) / 2
      const nx1 = xc - textWidth / 2
      const nx2 = xc + textWidth / 2

      const _nx1 = scale(nx1)
      const _nx2 = scale(nx2)

      if (bm.outOfBounds(_nx1, _y1, _nx2, _y2) || bm.getRange(_nx1, _y1, _nx2, _y2)) {
        continue
      }

      placedX = !dx ? xc : dx * insideFactor < 0 ? nx2 : nx1
      placedY = !dy ? yc : dy * insideFactor < 0 ? y2 : y1
      placedAnchor = i
      bm.setRange(_nx1, _y1, _nx2, _y2)
      break
    }

    if (placedAnchor === -1) {
      out.push({
        ...r,
        [as[0]!]: null,
        [as[1]!]: null,
        [as[2]!]: 0,
        [as[3]!]: undefined,
        [as[4]!]: undefined,
      })
    } else {
      const dx = (anc[placedAnchor]! & 0x3) - 1
      const dy = ((anc[placedAnchor]! >>> 2) & 0x3) - 1
      const insideFactor = offs[placedAnchor]! < 0 ? -1 : 1
      out.push({
        ...r,
        [as[0]!]: placedX ?? null,
        [as[1]!]: Number.isFinite(placedY as number) ? (placedY as number) : null,
        [as[2]!]: 1,
        [as[3]!]: LABEL_ALIGNS[dx * insideFactor + 1],
        [as[4]!]: LABEL_BASELINES[dy * insideFactor + 1],
      })
    }
  }
  return out
}

/**
 * Resolve a (possibly dotted) field path against a row. Vega treats dotted
 * field names as nested-object access (e.g. `lookup_result.label` reads
 * `datum["lookup_result"]["label"]`).
 */
export function getField(row: Row, path: string): unknown {
  if (!path.includes('.')) return row[path]
  let v: unknown = row
  for (const part of path.split('.')) {
    if (v == null || typeof v !== 'object') return undefined
    v = safeGet(v, part)
  }
  return v
}
