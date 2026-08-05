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
}

export type Row = Record<string, unknown>

export function applyTransforms(
  rows: Row[],
  transforms: CompiledTransform[],
  ctx: TransformContext,
): Row[] {
  let out = rows
  for (const t of transforms) {
    out = applyTransform(out, t, ctx)
  }
  return out
}

function applyTransform(rows: Row[], t: CompiledTransform, ctx: TransformContext): Row[] {
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
      const fields = t.fields
      const out: Row[] = []
      for (const r of rows) {
        const arrays = fields.map((f) => r[f])
        if (arrays.some((a) => !Array.isArray(a))) {
          // no array fields: keep row as-is
          out.push(r)
          continue
        }
        const length = Math.max(...arrays.map((a) => (Array.isArray(a) ? a.length : 1)))
        for (let i = 0; i < length; i++) {
          const row: Row = { ...r }
          fields.forEach((f, j) => {
            const a = arrays[j] as unknown[]
            const key = t.as?.[j] ?? f
            row[key] = Array.isArray(a) ? a[i] : a
          })
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
    const step = t.step ?? defaultStep(keys as number[])
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

function windowRows(rows: Row[], t: Extract<CompiledTransform, { type: 'window' }>): Row[] {
  const sorted = sortRows(rows, t.sort)
  const groupby = t.groupby ?? []
  const fields = t.fields ?? []
  const ops = t.ops ?? []
  const as = t.as ?? []
  const groups = groupby.length ? groupRows(sorted, groupby) : [sorted]
  const out: Row[] = []
  for (const g of groups) {
    const n = g.length
    const cum: Record<string, number> = {}
    for (let i = 0; i < n; i++) {
      const r = { ...g[i] }
      ops.forEach((op, j) => {
        const name = as[j] ?? `${op}_${fields[j]}`
        const field = fields[j]
        const values = field == null ? [] : fieldValues(g.slice(0, i + 1), field)
        switch (op) {
          case 'row_number':
            r[name] = i + 1
            break
          case 'rank':
            r[name] = i + 1
            break
          case 'dense_rank':
            r[name] = i + 1
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
  const out: Row[] = []
  for (const g of groups) {
    const ordered = sortRows(g, t.sort)
    let acc = 0
    const total = ordered.reduce((s, r) => s + (Number(r[t.field]) || 0), 0)
    for (const r of ordered) {
      const value = Number(r[t.field]) || 0
      let start = acc
      let end = acc + value
      if (t.offset === 'normalize') {
        start = total === 0 ? 0 : start / total
        end = total === 0 ? 0 : end / total
      } else if (t.offset === 'center') {
        start -= total / 2
        end -= total / 2
      }
      acc += value
      out.push({ ...r, [startField]: start, [endField]: end })
    }
  }
  return out
}
