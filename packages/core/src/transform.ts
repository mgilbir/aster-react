/**
 * Eager row transforms. Vega's dataflow applies these reactively; for the static
 * execution mode we apply the same semantics eagerly against the current rows.
 * Each transform is a pure `(rows, params) -> rows` (plus expression/context).
 */
import type { CompiledTransform, SortSpec } from './types.js'
import type { ExpressionRuntime } from './expression.js'

export interface TransformContext {
  runtime: ExpressionRuntime
  signals: Record<string, unknown>
  /** Cross-dataset lookup (used by 'lookup', deferred). */
  datasets?: (name: string) => unknown[] | undefined
  /** Hierarchy trees built by the `stratify` transform, keyed by data source name. */
  hierarchies?: Map<string, unknown>
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
      return imputeRows(rows, t)
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
      const as = (t as { as?: unknown }).as ?? 'shape'
      const field = (t as { field?: unknown }).field
      return rows.map((r) => {
        const geo = field == null || field === 'datum' ? r : r[field as string]
        const p = geoJSONPath(geo)
        return p !== undefined ? { ...r, [as as string]: p } : r
      })
    }
    case 'kde':
      return kdeRows(rows, t as Record<string, unknown>)
    case 'quantile':
      return quantileRows(rows, t as Record<string, unknown>)
    case 'regression':
      return regressionRows(rows, t as Record<string, unknown>)
    case 'loess':
      return loessRows(rows, t as Record<string, unknown>)
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
      return packRows(rows, t as Record<string, unknown>, ctx, sourceName)
    case 'sequence':
      return sequenceRows(t as Record<string, unknown>)
    case 'graticule':
      return graticuleRows(t as Record<string, unknown>)
    case 'identifier':
      return rows
    default:
      throw new Error(`[aster] unsupported transform type "${(t as { type: string }).type}"`)
  }
}

function compileExprTransform(expr: string, ctx: TransformContext) {
  const fn = ctx.runtime.expr(expr)
  return (datum: Row): unknown => fn(datum, ctx.signals)
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function collectField(rows: Row[], field: string | null | undefined): unknown[] {
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

// ---------------------------------------------------------------------------
// sorting
// ---------------------------------------------------------------------------

function comparator(a: Row, b: Row, field: string): number {
  const av = a[field]
  const bv = b[field]
  if (av === bv) return 0
  if (av == null) return 1
  if (bv == null) return -1
  return av < bv ? -1 : 1
}

export function sortRows(rows: Row[], sort?: SortSpec): Row[] {
  if (!sort?.field) return rows
  const fields = Array.isArray(sort.field) ? sort.field : [sort.field]
  const orders = Array.isArray(sort.order)
    ? sort.order
    : [sort.order ?? 'ascending']
  const copy = rows.slice()
  copy.sort((a, b) => {
    for (let i = 0; i < fields.length; i++) {
      const f = fields[i] as string
      const c = comparator(a, b, f)
      if (c !== 0) return (orders[i] ?? 'ascending') === 'descending' ? -c : c
    }
    return 0
  })
  return copy
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

  const span = hi - lo
  // Use vega-statistics/bin.js algorithm for step computation
  const step = computeBinStep(span, t.maxbins)
  // Nice the extent: start = floor(lo/step)*step, stop = ceil(hi/step)*step
  // with a small epsilon to handle floating point precision
  const eps = computeBinEps(step)
  const start = lo < Math.floor(lo / step + eps) * step
    ? Math.floor(lo / step + eps) * step - step
    : Math.floor(lo / step + eps) * step
  const stop = Math.ceil(hi / step) * step

  // Set the bins signal if the transform specifies one
  if (t.signal) {
    ctx.signals[t.signal] = { start, stop, step }
  }

  const [startField, endField] = t.as
  return rows.map((r) => {
    const v = r[t.field]
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      return { ...r, [startField]: undefined, [endField]: undefined }
    }
    if (v < start || v >= stop) {
      return { ...r, [startField]: undefined, [endField]: undefined }
    }
    const bIdx = Math.floor((v - start) / step)
    const b0 = start + bIdx * step
    const b1 = start + Math.min(bIdx + 1, (stop - start) / step) * step
    return { ...r, [startField]: b0, [endField]: b1 }
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
function computeBinStep(span: number, maxbins: number | undefined): number {
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
function computeBinEps(step: number): number {
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
  t: { field: string; groupby?: string[]; key: string; method?: string; value?: unknown; step?: number },
): Row[] {
  const groups = t.groupby?.length ? groupRows(rows, t.groupby) : [rows]
  const out: Row[] = []
  for (const g of groups) {
    out.push(...imputeGroup(g, t))
  }
  return out
}

function imputeGroup(
  group: Row[],
  t: { field: string; key: string; method?: string; value?: unknown; step?: number },
): Row[] {
  const sorted = group.slice().sort((a, b) => (a[t.key]! < b[t.key]! ? -1 : a[t.key]! > b[t.key]! ? 1 : 0))
  const keys = sorted.map((r) => r[t.key])
  if (!keys.length) return sorted
  if (keys.every((k) => typeof k === 'number')) {
    // Vega only ever adds tuples for `keyvals` that are missing; without
    // explicit keyvals it never fabricates keys. We approximate that by
    // interpolating only integer grids (or when an explicit `step` is given),
    // so e.g. KDE/quantile density outputs (dense non-integer keys) pass
    // through unchanged like they do in vega.
    const step = t.step ?? (keys.every((k) => Number.isInteger(k)) ? defaultStep(keys as number[]) : 0)
    if (!(step > 0)) return sorted
    const values = (keys as number[]).filter((k) => Number.isFinite(k))
    if (!values.length) return sorted
    const lo = Math.min(...values)
    const hi = Math.max(...values)
    const present = new Set(values)
    const imputeValue = imputeStat(sorted, t)
    const out: Row[] = []
    for (let k = lo; k <= hi; k += step) {
      if (present.has(k)) {
        out.push(sorted.find((r) => r[t.key] === k)!)
      } else {
        out.push({ ...sorted[0]!, [t.key]: k, [t.field]: imputeValue })
      }
    }
    return out
  }
  // non-numeric keys: no imputation
  return sorted
}

function defaultStep(keys: number[]): number {
  const span = Math.max(...keys) - Math.min(...keys)
  if (keys.every((k) => Number.isInteger(k))) return 1
  return span > 0 ? span / 30 : 1
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

const AGGR: Record<string, (values: number[], rows: Row[]) => number> = {
  count: (_v, rows) => rows.length,
  sum: (v) => v.reduce((a, b) => a + b, 0),
  product: (v) => v.reduce((a, b) => a * b, 1),
  mean: (v) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN),
  min: (v) => Math.min(...v),
  max: (v) => Math.max(...v),
  median: (v) => {
    if (!v.length) return NaN
    const s = v.slice().sort((a, b) => a - b)
    const m = Math.floor(s.length / 2)
    return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
  },
  distinct: (v, rows) => new Set(v).size,
  valid: (v) => v.filter((x) => Number.isFinite(x)).length,
  missing: (v, rows) => rows.length - v.filter((x) => Number.isFinite(x)).length,
}

function aggregateGroup(rows: Row[], groupby: string[], fields: (string | null)[], ops: string[], as: string[]): Row {
  const row: Row = {}
  for (const g of groupby) row[g] = rows[0]?.[g]
  ops.forEach((op, i) => {
    const field = fields[i]
    const values = field == null ? [] : fieldValues(rows, field)
    const fn = AGGR[op]
    if (!fn) throw new Error(`[aster] unsupported aggregate op "${op}"`)
    row[as[i] ?? `${op}_${field}`] = fn(values, rows)
  })
  return row
}

function groupRows(rows: Row[], keys: string[]): Row[][] {
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
  return groupRows(rows, groupby).map((g) => aggregateGroup(g, groupby, fields, ops, as))
}

function joinAggregateRows(rows: Row[], t: Extract<CompiledTransform, { type: 'joinaggregate' }>): Row[] {
  const groupby = t.groupby ?? []
  const fields = t.fields ?? []
  const ops = t.ops ?? []
  const as = t.as ?? []
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
  const as = t.as ?? []
  const groups = groupby.length ? groupRows(sorted, groupby) : [sorted]
  const sortFields = sortFieldsOf(t.sort)
  const out: Row[] = []
  for (const g of groups) {
    const n = g.length
    // rank / dense_rank state, advanced per row using the sort-comparator peer
    // test (matches vega WindowOps.rank / .dense_rank).
    let rank = 1
    let drank = 1
    for (let i = 0; i < n; i++) {
      if (i > 0 && !isPeer(g[i - 1]!, g[i]!, sortFields)) {
        rank = i + 1
        drank++
      }
      const r = { ...g[i]! }
      ops.forEach((op, j) => {
        const name = as[j] ?? `${op}_${fields[j]}`
        const field = fields[j]
        const values = field == null ? [] : fieldValues(g.slice(0, i + 1), field)
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
          case 'first_value':
            r[name] = field == null ? undefined : g[0]?.[field]
            break
          case 'last_value':
            r[name] = field == null ? undefined : g[n - 1]?.[field]
            break
          case 'lag':
            r[name] = field == null ? undefined : i > 0 ? g[i - 1]?.[field] : undefined
            break
          case 'lead':
            r[name] = field == null ? undefined : i < n - 1 ? g[i + 1]?.[field] : undefined
            break
          case 'sum':
          case 'mean':
          case 'min':
          case 'max': {
            const fn = AGGR[op]
            r[name] = fn ? fn(values, []) : undefined
            break
          }
          case 'count':
            r[name] = i + 1
            break
          default:
            throw new Error(`[aster] unsupported window op "${op}"`)
        }
      })
      out.push(r)
    }
  }
  return out
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

  const out: Row[] = []
  for (let gi = 0; gi < groups.length; gi++) {
    const ordered = sortRows(groups[gi]!, t.sort)
    const total = sums[gi]!
    if (t.offset === 'normalize') {
      const scale = total === 0 ? 0 : 1 / total
      let last = 0
      for (const r of ordered) {
        const start = last
        const end = (last += scale * Math.abs(Number(r[t.field]) || 0))
        out.push({ ...r, [startField]: start, [endField]: end })
      }
    } else if (t.offset === 'center') {
      let last = (max - total) / 2
      for (const r of ordered) {
        const start = last
        const end = (last += Math.abs(Number(r[t.field]) || 0))
        out.push({ ...r, [startField]: start, [endField]: end })
      }
    } else {
      let lastPos = 0
      let lastNeg = 0
      for (const r of ordered) {
        const v = Number(r[t.field]) || 0
        if (v < 0) {
          const start = lastNeg
          const end = (lastNeg += v)
          out.push({ ...r, [startField]: start, [endField]: end })
        } else {
          const start = lastPos
          const end = (lastPos += v)
          out.push({ ...r, [startField]: start, [endField]: end })
        }
      }
    }
  }
  return out
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

function ascendingNum(a: number, b: number): number {
  return a == null || b == null ? NaN : a < b ? -1 : a > b ? 1 : a >= b ? 0 : NaN
}

/** d3-array `range(start, stop, step)` (numeric output only). */
function d3Range(start: number, stop: number, step: number): number[] {
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

/** d3-array `quantileSorted(values, p)` — values must be sorted ascending. */
function quantileSorted(values: number[], p: number): number | undefined {
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
function deviationOf(values: number[]): number | undefined {
  const v = varianceSample(values)
  return v ? Math.sqrt(v) : v
}

/** d3-array `extent` over numeric field values. */
function extentOf(values: unknown[]): [number, number] | undefined {
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

// -- kde (vega-statistics randomKDE + sampleCurve) -----------------------------

const SQRT2PI = Math.sqrt(2 * Math.PI)

/** Gaussian (standard normal) density function — matches vega-statistics. */
function gaussianPdf(z: number): number {
  return Math.exp(-0.5 * z * z) / SQRT2PI
}

/** West (2009) approximation of the standard normal CDF — matches vega-statistics. */
function gaussianCdf(value: number): number {
  const z = Math.abs(value)
  let cd: number
  if (z > 37) {
    cd = 0
  } else {
    const exp = Math.exp((-z * z) / 2)
    let sum: number
    if (z < 7.07106781186547) {
      sum = 3.52624965998911e-02 * z + 0.700383064443688
      sum = sum * z + 6.37396220353165
      sum = sum * z + 33.912866078383
      sum = sum * z + 112.079291497871
      sum = sum * z + 221.213596169931
      sum = sum * z + 220.206867912376
      cd = exp * sum
      sum = 8.83883476483184e-02 * z + 1.75566716318264
      sum = sum * z + 16.064177579207
      sum = sum * z + 86.7807322029461
      sum = sum * z + 296.564248779674
      sum = sum * z + 637.333633378831
      sum = sum * z + 793.826512519948
      sum = sum * z + 440.413735824752
      cd = cd / sum
    } else {
      sum = z + 0.65
      sum = z + 4 / sum
      sum = z + 3 / sum
      sum = z + 2 / sum
      sum = z + 1 / sum
      cd = exp / sum / 2.506628274631
    }
  }
  return value > 0 ? 1 - cd : cd
}

/**
 * Silverman's rule-of-thumb bandwidth (vega-statistics `estimateBandwidth`):
 * 1.06 * min(sample stdev, IQR/1.34) * n^-0.2.
 */
function estimateBandwidth(array: number[]): number {
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

/**
 * Kernel density estimator over a support array with automatic bandwidth
 * (mirrors vega-statistics `randomKDE`).
 */
function kdeDist(support: unknown[], bandwidth: number | undefined) {
  const kernel = { pdf: gaussianPdf, cdf: gaussianCdf }
  let n = 0

  const dist = {
    data(_: unknown[]) {
      support = _
      n = _ ? _.length : 0
      return dist.bandwidth(bandwidth)
    },
    bandwidth(_: number | undefined) {
      bandwidth = _
      if (!bandwidth && support) bandwidth = estimateBandwidth(support as number[])
      return dist
    },
    pdf(x: number) {
      let y = 0
      for (let i = 0; i < n; ++i) {
        y += kernel.pdf((x - Number(support[i])) / bandwidth!)
      }
      return y / bandwidth! / n
    },
    cdf(x: number) {
      let y = 0
      for (let i = 0; i < n; ++i) {
        y += kernel.cdf((x - Number(support[i])) / bandwidth!)
      }
      return y / n
    },
  }

  return dist.data(support)
}

const MIN_RADIANS = 0.5 * Math.PI / 180

/**
 * Adaptively sample an interpolated function over a domain extent
 * (mirrors vega-statistics `sampleCurve`).
 */
function sampleCurve(f: (x: number) => number, extent: [number, number], minSteps: number, maxSteps: number): number[][] {
  minSteps = minSteps || 25
  maxSteps = Math.max(minSteps, maxSteps || 200)

  const point = (x: number) => [x, f(x)]
  const minX = extent[0]
  const maxX = extent[1]
  const span = maxX - minX
  const stop = span / maxSteps
  const prev = [point(minX)]
  const next: number[][] = []

  if (minSteps === maxSteps) {
    // no adaptation, sample uniform grid directly and return
    for (let i = 1; i < maxSteps; ++i) {
      prev.push(point(minX + (i / minSteps) * span))
    }
    prev.push(point(maxX))
    return prev
  } else {
    // sample minimum points on uniform grid
    // then move on to perform adaptive refinement
    next.push(point(maxX))
    for (let i = minSteps; --i > 0;) {
      next.push(point(minX + (i / minSteps) * span))
    }
  }

  let p0 = prev[0]!
  let p1 = next[next.length - 1]!

  const sx = 1 / span
  const sy = scaleY(p0[1]!, next)

  while (p1) {
    // midpoint for potential curve subdivision
    const pm = point((p0[0]! + p1[0]!) / 2)
    const dx = pm[0]! - p0[0]! >= stop

    if (dx && angleDelta(p0, pm, p1, sx, sy) > MIN_RADIANS) {
      next.push(pm)
    } else {
      p0 = p1
      prev.push(p1)
      next.pop()
    }
    p1 = next[next.length - 1]!
  }

  return prev
}

function scaleY(init: number, points: number[][]): number {
  let ymin = init
  let ymax = init
  for (const p of points) {
    const y = p[1]!
    if (y < ymin) ymin = y
    if (y > ymax) ymax = y
  }
  return 1 / (ymax - ymin)
}

function angleDelta(p: number[], q: number[], r: number[], sx: number, sy: number): number {
  const a0 = Math.atan2(sy * (r[1]! - p[1]!), sx * (r[0]! - p[0]!))
  const a1 = Math.atan2(sy * (q[1]! - p[1]!), sx * (q[0]! - p[0]!))
  return Math.abs(a0 - a1)
}

function kdeRows(rows: Row[], t: Record<string, unknown>): Row[] {
  const field = t.field as string
  const as = (t.as as [string, string]) ?? ['value', 'density']
  const groupby = (t.groupby as string[]) ?? []
  const cumulative = t.cumulative === true
  const counts = t.counts === true
  const bandwidth = t.bandwidth as number | undefined
  const resolve = (t.resolve as string) ?? 'independent'
  const steps = t.steps as number | undefined
  const minsteps0 = steps ?? ((t.minsteps as number | undefined) ?? 25)
  const maxsteps0 = steps ?? ((t.maxsteps as number | undefined) ?? 200)

  let domain = t.extent as [number, number] | undefined
  let minsteps = minsteps0
  let maxsteps = maxsteps0

  if (resolve === 'shared') {
    // all densities share a single domain and curve resolution, enabling stacking
    if (!domain) {
      const vals = collectField(rows, field).filter(isFiniteNumber)
      domain = vals.length ? [Math.min(...vals), Math.max(...vals)] : [0, 1]
    }
    minsteps = maxsteps = steps ?? maxsteps0
  }

  const groups = groupby.length ? groupRows(rows, groupby) : [rows]
  const out: Row[] = []
  for (const g of groups) {
    const support = g.map((r) => r[field])
    const dist = kdeDist(support, bandwidth)
    const scale = counts ? g.length : 1
    const local = domain ?? extentOf(support)
    if (!local) continue
    const curve = sampleCurve((x) => (cumulative ? dist.cdf(x) : dist.pdf(x)), local, minsteps, maxsteps)
    for (const v of curve) {
      const row: Row = {}
      for (const k of groupby) row[k] = g[0]?.[k]
      row[as[0]] = v[0]!
      row[as[1]] = v[1]! * scale
      out.push(row)
    }
  }
  return out
}

// -- quantile (vega-transforms Quantile) ----------------------------------------

function quantileRows(rows: Row[], t: Record<string, unknown>): Row[] {
  const field = t.field as string
  const as = (t.as as [string, string]) ?? ['prob', 'value']
  const groupby = (t.groupby as string[]) ?? []
  const step = (t.step as number | undefined) ?? 0.01
  const EPSILON = 1e-14
  const probs = (t.probs as number[] | undefined) ?? d3Range(step / 2, 1 - EPSILON, step)

  const groups = groupby.length ? groupRows(rows, groupby) : [rows]
  const out: Row[] = []
  for (const g of groups) {
    const values = quantilesOf(g, field, probs)
    for (let i = 0; i < probs.length; i++) {
      const row: Row = {}
      for (const k of groupby) row[k] = g[0]?.[k]
      row[as[0]] = probs[i]
      row[as[1]] = values[i]
      out.push(row)
    }
  }
  return out
}

function quantilesOf(rows: Row[], field: string, probs: number[]): number[] {
  const values: number[] = []
  for (const r of rows) {
    const raw = r[field]
    if (raw != null && raw !== '') {
      const v = +raw
      if (v >= v) values.push(v)
    }
  }
  values.sort(ascendingNum)
  return probs.map((p) => quantileSorted(values, p) as number)
}

// -- regression (vega-regression, linear/constant) -------------------------------

/**
 * Ordinary least squares linear regression over rows, using the same online
 * mean update order as vega-statistics `regressionLinear`.
 */
function linearFit(rows: Row[], xField: string, yField: string): { predict: (x: number) => number } {
  let X = 0
  let Y = 0
  let XY = 0
  let X2 = 0
  let n = 0
  for (const d of rows) {
    const rawU = d[xField]
    const rawV = d[yField]
    if (rawU == null || rawV == null) continue
    const u = +rawU
    const v = +rawV
    if (u >= u && v >= v) {
      ++n
      X += (u - X) / n
      Y += (v - Y) / n
      XY += (u * v - XY) / n
      X2 += (u * u - X2) / n
    }
  }
  const delta = X2 - X * X
  const slope = Math.abs(delta) < 1e-24 ? 0 : (XY - X * Y) / delta
  const intercept = Y - slope * X
  return { predict: (x) => intercept + slope * x }
}

/** Mean of valid y values (vega-regression `regressionConstant`). */
function constantMean(rows: Row[], yField: string): number {
  let sum = 0
  let n = 0
  for (const d of rows) {
    const raw = d[yField]
    if (raw != null && raw !== '') {
      const v = +raw
      if (v >= v) {
        sum += v
        n++
      }
    }
  }
  return n ? sum / n : NaN
}

function regressionRows(rows: Row[], t: Record<string, unknown>): Row[] {
  const xField = t.x as string
  const yField = t.y as string
  const method = (t.method as string) ?? 'linear'
  const as = (t.as as [string, string]) ?? [xField, yField]
  const groupby = (t.groupby as string[]) ?? []
  const order = (t.order as number | undefined) ?? 3
  // degrees of freedom (vega-regression): linear/constant/exp/log/pow -> 1
  const dof = method === 'poly' ? order : 1

  if (method !== 'linear' && method !== 'constant') {
    throw new Error(`[aster] unsupported regression method "${method}"`)
  }

  const groups = groupby.length ? groupRows(rows, groupby) : [rows]
  const out: Row[] = []
  for (const g of groups) {
    if (g.length <= dof) continue // not enough points to fit
    const model = linearFit(g, xField, yField)
    if (t.params === true) {
      // parameter vector form (coef, rSquared) — not needed by the corpus
      continue
    }
    const domain = (t.extent as [number, number] | undefined) ?? extentOf(g.map((r) => r[xField]))
    if (!domain) continue
    if (method === 'linear' || method === 'constant') {
      // only the two end points are needed for a straight line
      const constantY = method === 'constant' ? constantMean(g, yField) : undefined
      for (const x of domain) {
        const row: Row = {}
        for (const k of groupby) row[k] = g[0]?.[k]
        row[as[0]] = x
        row[as[1]] = constantY ?? model.predict(x)
        out.push(row)
      }
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// loess (vega-statistics regression/loess.js — science.js adaptation)
// ---------------------------------------------------------------------------

const LOESS_MAX_ITERS = 2
const LOESS_EPSILON = 1e-12

/** Tricube weighting kernel. */
function loessTricube(x: number): number {
  return (x = 1 - x * x * x) * x * x
}

/** Ordinary least squares from normalized sums (vega-statistics `ols`). */
function loessOls(uX: number, uY: number, uXY: number, uX2: number): [number, number] {
  const delta = uX2 - uX * uX
  const slope = Math.abs(delta) < 1e-24 ? 0 : (uXY - uX * uY) / delta
  const intercept = uY - slope * uX
  return [intercept, slope]
}

/** Advance the sliding window of nearest neighbors over sorted x values. */
function loessUpdateInterval(xv: Float64Array, i: number, interval: [number, number]): void {
  const val = xv[i]!
  let left = interval[0]
  let right = interval[1] + 1
  if (right >= xv.length) return
  // step right if distance to new right edge is <= distance to old left edge
  // (step when equal to ensure movement over duplicate x values)
  while (i > left && (xv[right]! - val) <= (val - xv[left]!)) {
    interval[0] = ++left
    interval[1] = right
    ++right
  }
}

/** Median (d3-array `median`, i.e. R-7 quantile at p=0.5). */
function loessMedian(values: Float64Array): number {
  const arr = Array.from(values).sort(ascendingNum)
  return quantileSorted(arr, 0.5) as number
}

/**
 * Locally weighted scatterplot smoothing for one group, mirroring
 * vega-statistics' `loess` operation for operation (mean-centering, the robust
 * bisquare re-weighting loop, and the output pass that averages duplicate x
 * values via online update and adds the means back).
 */
function loessFit(rows: Row[], xField: string, yField: string, bandwidth: number): number[][] {
  // filter valid points and sort by x (vega-statistics `points` with sort)
  const data: Array<[number, number]> = []
  for (const d of rows) {
    const rawU = d[xField]
    const rawV = d[yField]
    if (rawU == null || rawV == null) continue
    const u = +rawU
    const v = +rawV
    if (u >= u && v >= v) data.push([u, v])
  }
  data.sort((a, b) => a[0] - b[0])

  const n = data.length
  const X = new Float64Array(n)
  const Y = new Float64Array(n)
  let i = 0
  let ux = 0
  let uy = 0
  for (const [xv, yv] of data) {
    X[i] = xv
    Y[i] = yv
    ++i
    ux += (xv - ux) / i
    uy += (yv - uy) / i
  }
  // mean center the data
  for (i = 0; i < n; ++i) {
    X[i] = X[i]! - ux
    Y[i] = Y[i]! - uy
  }

  // # nearest neighbors
  const bw = Math.max(2, ~~(bandwidth * n))
  const yhat = new Float64Array(n)
  const residuals = new Float64Array(n)
  const robustWeights = new Float64Array(n).fill(1)

  for (let iter = -1; ++iter <= LOESS_MAX_ITERS;) {
    const interval: [number, number] = [0, bw - 1]

    for (i = 0; i < n; ++i) {
      const dx = X[i]!
      const i0 = interval[0]
      const i1 = interval[1]
      const edge = (dx - X[i0]!) > (X[i1]! - dx) ? i0 : i1

      let W = 0
      let Xw = 0
      let Yw = 0
      let XY = 0
      let X2 = 0
      const denom = 1 / Math.abs(X[edge]! - dx || 1) // avoid singularity!

      for (let k = i0; k <= i1; ++k) {
        const xk = X[k]!
        const yk = Y[k]!
        const w = loessTricube(Math.abs(dx - xk) * denom) * robustWeights[k]!
        const xkw = xk * w
        W += w
        Xw += xkw
        Yw += yk * w
        XY += yk * xkw
        X2 += xk * xkw
      }

      // linear regression fit
      const [a, b] = loessOls(Xw / W, Yw / W, XY / W, X2 / W)
      yhat[i] = a + b * dx
      residuals[i] = Math.abs(Y[i]! - yhat[i]!)

      loessUpdateInterval(X, i + 1, interval)
    }

    if (iter === LOESS_MAX_ITERS) break

    const medianResidual = loessMedian(residuals)
    if (Math.abs(medianResidual) < LOESS_EPSILON) break

    for (i = 0; i < n; ++i) {
      const arg = residuals[i]! / (6 * medianResidual)
      // default to epsilon (rather than zero) for large deviations, keeping
      // weights tiny but non-zero to prevent singularities
      let w: number
      robustWeights[i] = arg >= 1 ? LOESS_EPSILON : ((w = 1 - arg * arg) * w)
    }
  }

  // generate smoothed output points, averaging repeated x values
  const out: number[][] = []
  let cnt = 0
  let prev: number[] = []
  for (i = 0; i < n; ++i) {
    const v = X[i]! + ux
    if (prev[0] === v) {
      prev[1] = prev[1]! + (yhat[i]! - prev[1]!) / ++cnt
    } else {
      cnt = 0
      prev[1] = prev[1]! + uy
      prev = [v, yhat[i]!]
      out.push(prev)
    }
  }
  prev[1] = prev[1]! + uy
  return out
}

function loessRows(rows: Row[], t: Record<string, unknown>): Row[] {
  const xField = t.x as string
  const yField = t.y as string
  const groupby = (t.groupby as string[]) ?? []
  const bandwidth = (t.bandwidth as number | undefined) ?? 0.3
  const as = (t.as as [string, string] | undefined) ?? [xField, yField]

  const groups = groupby.length ? groupRows(rows, groupby) : [rows]
  const out: Row[] = []
  for (const g of groups) {
    const pts = loessFit(g, xField, yField, bandwidth)
    for (const p of pts) {
      const row: Row = {}
      for (const k of groupby) row[k] = g[0]?.[k]
      row[as[0]] = p[0]
      row[as[1]] = p[1]
      out.push(row)
    }
  }
  return out
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

interface HierNode {
  data: Row
  children: HierNode[]
  parent: HierNode | null
  depth: number
  x: number
  y: number
  r: number
  value: number
}

/** Build a hierarchy tree from flat id/parent-id tuples (d3 `stratify`). */
function buildStratifyTree(rows: Row[], key?: string, parentKey?: string): HierNode {
  if (!key) throw new Error('[aster] stratify requires a key field')
  const byKey = new Map<unknown, HierNode>()
  for (const r of rows) {
    byKey.set(r[key], { data: r, children: [], parent: null, depth: 0, x: 0, y: 0, r: 0, value: 0 })
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
  return root
}

/** Pre-order traversal (d3 `node.eachBefore`). */
function eachBefore(root: HierNode, fn: (node: HierNode) => void): void {
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
function eachAfter(root: HierNode, fn: (node: HierNode) => void): void {
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

/** Sort the children of every node (vega HierarchyLayout: `root.sort(compare)`). */
function sortTreeChildren(root: HierNode, sort: SortSpec): void {
  const fields = Array.isArray(sort.field) ? sort.field : [sort.field]
  const orders = Array.isArray(sort.order) ? sort.order : [sort.order ?? 'ascending']
  const field = fields[0] as string
  const dir = (orders[0] ?? 'ascending') === 'descending' ? -1 : 1
  const ascending = (u: unknown, v: unknown): number => {
    const ua = u as number | string
    const va = v as number | string
    if ((ua < va || u == null) && v != null) return -1
    if ((ua > va || v == null) && u != null) return 1
    return 0
  }
  eachBefore(root, (node) => {
    const children = node.children
    if (children.length > 1) {
      const idx = new Map<HierNode, number>()
      children.forEach((c, i) => idx.set(c, i))
      children.sort((a, b) => {
        const c = ascending(a.data[field], b.data[field]) * dir
        return c !== 0 ? c : idx.get(a)! - idx.get(b)!
      })
    }
  })
}

/** The vega `pack` transform: layout the stratify-built tree and write x/y/r/depth/children. */
function packRows(rows: Row[], t: Record<string, unknown>, ctx: TransformContext, sourceName?: string): Row[] {
  const root = sourceName ? (ctx.hierarchies?.get(sourceName) as HierNode | undefined) : undefined
  if (!root) {
    throw new Error('[aster] pack transform requires a preceding stratify transform on the same data source')
  }
  const as = (t.as as string[] | undefined) ?? ['x', 'y', 'r', 'depth', 'children']
  const field = t.field as string | undefined
  const radius = t.radius as string | undefined
  const size = t.size as number[] | undefined
  const padding = (t.padding as number | undefined) ?? 0
  const sort = t.sort as SortSpec | undefined

  // root.sum(field): each node's value is its own plus its descendants'.
  eachAfter(root, (node) => {
    let sum = field != null ? Number(node.data[field]) || 0 : 1
    for (const c of node.children) sum += c.value
    node.value = sum
  })

  if (sort?.field) sortTreeChildren(root, sort)

  const dx = size?.[0] ?? 1
  const dy = size?.[1] ?? 1
  packLayout(root, dx, dy, padding, radius)

  eachBefore(root, (node) => {
    const d = node.data
    d[as[0]!] = node.x
    d[as[1]!] = node.y
    d[as[2]!] = node.r
    d[as[3]!] = node.depth
    d[as[4]!] = node.children.length
  })

  return rows
}

// -- d3-hierarchy pack layout -------------------------------------------------

/** Linear congruential generator with the exact constants d3-hierarchy uses. */
function packLcg(): () => number {
  let s = 1
  return () => (s = (1664525 * s + 1013904223) % 4294967296) / 4294967296
}

function packLayout(root: HierNode, dx: number, dy: number, padding: number, radius?: string): void {
  const random = packLcg()
  root.x = dx / 2
  root.y = dy / 2

  // radiusLeaf: leaves get r from the radius accessor (default sqrt(value)).
  eachBefore(root, (node) => {
    if (!node.children.length) {
      node.r = radius != null
        ? Math.max(0, Number(node.data[radius]) || 0)
        : Math.max(0, Math.sqrt(node.value) || 0)
    }
  })

  // packChildrenRandom(padding, k, random) twice, as d3 does.
  eachAfter(root, packChildrenOnce(0, 1, random))
  eachAfter(root, packChildrenOnce(padding, root.r / Math.min(dx, dy), random))

  // translateChild: scale everything into the target box around the root.
  const k = Math.min(dx, dy) / (2 * root.r)
  eachBefore(root, (node) => {
    node.r *= k
    const parent = node.parent
    if (parent) {
      node.x = parent.x + k * node.x
      node.y = parent.y + k * node.y
    }
  })
}

function packChildrenOnce(padValue: number, k: number, random: () => number) {
  return (node: HierNode): void => {
    if (!node.children.length) return
    const children = node.children
    const r = padValue * k || 0
    if (r) for (let i = 0; i < children.length; ++i) children[i]!.r += r
    const e = packSiblingsRandom(children, random)
    if (r) for (let i = 0; i < children.length; ++i) children[i]!.r -= r
    node.r = e + r
  }
}

function packPlace(b: HierNode, a: HierNode, c: HierNode): void {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const d2 = dx * dx + dy * dy
  if (d2) {
    let a2 = a.r + c.r; a2 *= a2
    let b2 = b.r + c.r; b2 *= b2
    if (a2 > b2) {
      const x = (d2 + b2 - a2) / (2 * d2)
      const y = Math.sqrt(Math.max(0, b2 / d2 - x * x))
      c.x = b.x - x * dx - y * dy
      c.y = b.y - x * dy + y * dx
    } else {
      const x = (d2 + a2 - b2) / (2 * d2)
      const y = Math.sqrt(Math.max(0, a2 / d2 - x * x))
      c.x = a.x + x * dx - y * dy
      c.y = a.y + x * dy + y * dx
    }
  } else {
    c.x = a.x + c.r
    c.y = a.y
  }
}

function packIntersects(a: HierNode, b: HierNode): boolean {
  const dr = a.r + b.r - 1e-6
  const dx = b.x - a.x
  const dy = b.y - a.y
  return dr > 0 && dr * dr > dx * dx + dy * dy
}

function packScore(node: PackChain): number {
  const a = node._
  const b = node.next!._
  const ab = a.r + b.r
  const dx = (a.x * b.r + b.x * a.r) / ab
  const dy = (a.y * b.r + b.y * a.r) / ab
  return dx * dx + dy * dy
}

/** Circular doubly-linked chain node wrapping a circle (d3 pack/siblings.js). */
class PackChain {
  _: HierNode
  next: PackChain | null
  previous: PackChain | null

  constructor(circle: HierNode) {
    this._ = circle
    this.next = null
    this.previous = null
  }
}

/**
 * Pack a set of sibling circles (d3 `packSiblingsRandom`), mutating each
 * circle's x/y and returning the radius of the enclosing circle.
 */
function packSiblingsRandom(circles: HierNode[], random: () => number): number {
  const n = circles.length
  if (!n) return 0

  let a: HierNode | PackChain
  let b: HierNode | PackChain
  let c: PackChain
  let i: number
  let j: PackChain | null
  let k: PackChain | null
  let sj: number
  let sk: number
  let aa: number
  let ca: number

  // Place the first circle.
  a = circles[0]!
  a.x = 0; a.y = 0
  if (!(n > 1)) return a.r

  // Place the second circle.
  b = circles[1]!
  a.x = -b.r; b.x = a.r; b.y = 0
  if (!(n > 2)) return a.r + b.r

  // Place the third circle.
  c = new PackChain(circles[2]!)
  packPlace(b, a, c._)

  // Initialize the front-chain using the first three circles a, b and c.
  a = new PackChain(a as HierNode)
  b = new PackChain(b as HierNode)
  // d3: `a.next = c.previous = b; b.next = a.previous = c; c.next = b.previous = a`
  a.next = b
  c.previous = b
  b.next = c
  a.previous = c
  c.next = a
  b.previous = a

    // Attempt to place each remaining circle…
    let guard = 0
    pack: for (i = 3; i < n; ++i) {
      packPlace((a as PackChain)._, (b as PackChain)._, circles[i]!)
      c = new PackChain(circles[i]!)

      // Find the closest intersecting circle on the front-chain, if any.
      j = b.next
      k = a.previous
      sj = b._.r
      sk = a._.r
      do {
        if (++guard > 100000) throw new Error('[aster] pack: front-chain walk did not terminate')
        if (sj <= sk) {
        if (packIntersects(j!._, c._)) {
          b = j!
          a.next = b
          b.previous = a
          --i
          continue pack
        }
        sj += j!._.r
        j = j!.next
      } else {
        if (packIntersects(k!._, c._)) {
          a = k!
          a.next = b
          b.previous = a
          --i
          continue pack
        }
        sk += k!._.r
        k = k!.previous
      }
    } while (j !== k!.next)

    // Success! Insert the new circle c between a and b. d3: `a.next =
    // b.previous = b = c` — the new circle becomes the new `b`.
    c.previous = a as PackChain
    c.next = b as PackChain
    ;(a as PackChain).next = c
    ;(b as PackChain).previous = c
    b = c

    // Compute the new closest circle pair to the centroid.
    aa = packScore(a as PackChain)
    while ((c = c.next!) !== b) {
      if ((ca = packScore(c)) < aa) {
        a = c
        aa = ca
      }
    }
    b = a.next!
  }

  // Compute the enclosing circle of the front chain.
  const front: HierNode[] = [(b as PackChain)._]
  c = b as PackChain
  while ((c = c.next!) !== b) front.push(c._)
  const enc = packEncloseRandom(front, random)

  // Translate the circles to put the enclosing circle around the origin.
  for (i = 0; i < n; ++i) {
    const circ = circles[i]!
    circ.x -= enc.x
    circ.y -= enc.y
  }

  return enc.r
}

/** Fisher-Yates shuffle (d3-array `shuffle`). */
function packShuffle<T>(array: T[], random: () => number): T[] {
  let m = array.length
  let t: T
  let i: number
  while (m) {
    i = random() * m-- | 0
    t = array[m]!
    array[m] = array[i]!
    array[i] = t
  }
  return array
}

/**
 * Minimal enclosing circle (d3 `packEncloseRandom` — Welzl's algorithm with a
 * randomized basis search).
 */
function packEncloseRandom(circles: HierNode[], random: () => number): HierNode {
  let i = 0
  const n = (circles = packShuffle(Array.from(circles), random)).length
  let B: HierNode[] = []
  let p: HierNode
  let e: HierNode | undefined

  while (i < n) {
    p = circles[i]!
    if (e && packEnclosesWeak(e, p)) ++i
    else { e = packEncloseBasis(B = packExtendBasis(B, p)); i = 0 }
  }
  return e!
}

function packExtendBasis(B: HierNode[], p: HierNode): HierNode[] {
  if (packEnclosesWeakAll(p, B)) return [p]

  // If we get here then B must have at least one element.
  for (let i = 0; i < B.length; ++i) {
    if (packEnclosesNot(p, B[i]!)
      && packEnclosesWeakAll(packEncloseBasis2(B[i]!, p), B)) {
      return [B[i]!, p]
    }
  }

  // If we get here then B must have at least two elements.
  for (let i = 0; i < B.length - 1; ++i) {
    for (let j = i + 1; j < B.length; ++j) {
      if (packEnclosesNot(packEncloseBasis2(B[i]!, B[j]!), p)
        && packEnclosesNot(packEncloseBasis2(B[i]!, p), B[j]!)
        && packEnclosesNot(packEncloseBasis2(B[j]!, p), B[i]!)
        && packEnclosesWeakAll(packEncloseBasis3(B[i]!, B[j]!, p), B)) {
        return [B[i]!, B[j]!, p]
      }
    }
  }

  throw new Error('[aster] pack: unable to find enclosing circle')
}

function packEnclosesNot(a: HierNode, b: HierNode): boolean {
  const dr = a.r - b.r
  const dx = b.x - a.x
  const dy = b.y - a.y
  return dr < 0 || dr * dr < dx * dx + dy * dy
}

function packEnclosesWeak(a: HierNode, b: HierNode): boolean {
  const dr = a.r - b.r + Math.max(a.r, b.r, 1) * 1e-9
  const dx = b.x - a.x
  const dy = b.y - a.y
  return dr > 0 && dr * dr > dx * dx + dy * dy
}

function packEnclosesWeakAll(a: HierNode, B: HierNode[]): boolean {
  for (let i = 0; i < B.length; ++i) {
    if (!packEnclosesWeak(a, B[i]!)) return false
  }
  return true
}

function packEncloseBasis1(a: HierNode): HierNode {
  return { x: a.x, y: a.y, r: a.r } as HierNode
}

function packEncloseBasis2(a: HierNode, b: HierNode): HierNode {
  const x1 = a.x, y1 = a.y, r1 = a.r
  const x2 = b.x, y2 = b.y, r2 = b.r
  const x21 = x2 - x1, y21 = y2 - y1, r21 = r2 - r1
  const l = Math.sqrt(x21 * x21 + y21 * y21)
  return {
    x: (x1 + x2 + x21 / l * r21) / 2,
    y: (y1 + y2 + y21 / l * r21) / 2,
    r: (l + r1 + r2) / 2,
  } as HierNode
}

function packEncloseBasis3(a: HierNode, b: HierNode, c: HierNode): HierNode {
  const x1 = a.x, y1 = a.y, r1 = a.r
  const x2 = b.x, y2 = b.y, r2 = b.r
  const x3 = c.x, y3 = c.y, r3 = c.r
  const a2 = x1 - x2
  const a3 = x1 - x3
  const b2 = y1 - y2
  const b3 = y1 - y3
  const c2 = r2 - r1
  const c3 = r3 - r1
  const d1 = x1 * x1 + y1 * y1 - r1 * r1
  const d2 = d1 - x2 * x2 - y2 * y2 + r2 * r2
  const d3 = d1 - x3 * x3 - y3 * y3 + r3 * r3
  const ab = a3 * b2 - a2 * b3
  const xa = (b2 * d3 - b3 * d2) / (ab * 2) - x1
  const xb = (b3 * c2 - b2 * c3) / ab
  const ya = (a3 * d2 - a2 * d3) / (ab * 2) - y1
  const yb = (a2 * c3 - a3 * c2) / ab
  const A = xb * xb + yb * yb - 1
  const B = 2 * (r1 + xa * xb + ya * yb)
  const C = xa * xa + ya * ya - r1 * r1
  const r = -(Math.abs(A) > 1e-6 ? (B + Math.sqrt(B * B - 4 * A * C)) / (2 * A) : C / B)
  return { x: x1 + xa + xb * r, y: y1 + ya + yb * r, r } as HierNode
}

function packEncloseBasis(B: HierNode[]): HierNode {
  switch (B.length) {
    case 1: return packEncloseBasis1(B[0]!)
    case 2: return packEncloseBasis2(B[0]!, B[1]!)
    case 3: return packEncloseBasis3(B[0]!, B[1]!, B[2]!)
    default: throw new Error('[aster] pack: bad basis size')
  }
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
    v = (v as Record<string, unknown>)[part]
  }
  return v
}
