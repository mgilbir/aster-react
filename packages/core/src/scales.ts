/**
 * Scale construction: a transcription of vega-parser's scale parsing
 * (`parsers/scale.js`: domain / range / interpolate / nice / bins) and
 * vega-encode's `Scale` transform (`scaleKey`, `configureDomain`,
 * `configureBins`, `configureRange`, `configureScheme`, `configureRangeStep`),
 * built on the owned d3-scale / vega-scale ports (`scale.ts`, `scale-d3.ts`).
 *
 * The structure follows upstream function for function so the two can be read
 * side by side; behaviour is pinned by the "scale spec -> built scale" oracle
 * vectors (`testdata/vectors/vega-scale-spec.json`), recorded from real vega.
 * Deviations are marked `DEVIATION` where they exist.
 */
import * as vs from './scale.js'
import { implicit as scaleImplicit } from './scale-d3.js'
import { interpolateRound, interpolateValue } from './interp.js'
import { range as sequence } from './arr.js'
import { aggregateGroup } from './transform.js'
import { aggregateRows } from './transform-agg.js'
import { SpecParseError } from './parse-error.js'
import { pushAll, ascending, sortData, error as raise, hasOwnProperty, isArray, isFunction, isObject, isString, peek, toNumber } from './util.js'
import type { CompiledScale } from './types.js'

export type Scale = vs.Scale

type SchemeFn = (t: number) => unknown

export interface ColorScale extends Scale {
  interpolate?(interpolator: () => SchemeFn): this
  interpolator?(fn?: SchemeFn): this | SchemeFn
}

export interface ScaleContext {
  width: number
  height: number
  /** Signal values by name. Must be prototype-less (the runtime supplies `dict(...)`): names are spec-supplied. */
  signals: Record<string, unknown>
  /** `config.range` — a named range ('category', 'ramp', ...) resolves through
   * it before the built-in aliases (vega-parser's range lookup). */
  configRange?: Record<string, unknown>
  /** Evaluate a JS expression string and return the result. */
  evaluate?: (expr: string) => unknown
  /** Collect values of `field` across a named dataset. */
  dataField: (dataName: string, field: string) => unknown[]
  /** Return all rows of a named dataset (identity keys the per-evaluation memo). */
  dataRows?: (dataName: string) => Record<string, unknown>[]
  /** True when the named dataset exists (vega refuses a domain over an unknown dataset). */
  hasData?: (dataName: string) => boolean
  /** Host/runtime domain override (vega `domainRaw`, pan/zoom, brush domains). */
  domainRaw?: unknown[]
  /**
   * Distinct-value memo keyed by the dataset rows ARRAY identity. It must live
   * exactly as long as one evaluation: the incremental path (and hosts that
   * mutate their arrays in place) reuse an array object with new contents, so a
   * process-global memo would serve stale domains.
   */
  distinctCache?: WeakMap<unknown[], Map<string, unknown[]>>
  /**
   * Present when the scale is made in a pass of a view that makes another (autosize fit). vega's Scale operator keeps its scale
   * between passes, so a pass that changes its parameters finds `bins` where the pass before left them, and a scale with bins
   * leaves the zero out of its default domain (`includeZero`): the first pass includes it, the second does not.
   */
  pass?: { prev: { key: string; bins: boolean } | undefined; record: (key: string, bins: boolean) => void }
}

/** Continuous types (the runtime's domain census and gradient legends key on these). */
export const CONTINUOUS_TYPES = new Set(['linear', 'log', 'pow', 'sqrt', 'symlog', 'time', 'utc', 'sequential', 'quantize'])

/** vega-encode's parameter object (`_`); spec keys are data (see parseScale for how they are admitted). */
type Params = Record<string, unknown>

const DEFAULT_COUNT = 5

/** vega-parser `config.range` defaults; a `config.range` key replaces the default entry wholesale. */
const DEFAULT_CONFIG_RANGE: Record<string, unknown> = Object.assign(Object.create(null), {
  category: { scheme: 'tableau10' },
  ordinal: { scheme: 'blues' },
  heatmap: { scheme: 'yellowgreenblue' },
  ramp: { scheme: 'blues' },
  diverging: { scheme: 'blueorange', extent: [1, 0] },
  symbol: ['circle', 'square', 'triangle-up', 'cross', 'diamond', 'triangle-right', 'triangle-down', 'triangle-left'],
})

// ---- signals / literals (vega-parser parseLiteral / parseArray) ----------------

function signalValue(signal: string, ctx: ScaleContext): unknown {
  if (Object.hasOwn(ctx.signals, signal)) return ctx.signals[signal]
  // vega-parser refuses an identifier that names no signal; anything else is an expression
  if (IDENTIFIER.test(signal) && !EXPRESSION_CONSTANTS.has(signal)) raise(`Unrecognized signal name: ${signal}`)
  if (!ctx.evaluate) raise(`Unrecognized signal expression: ${signal}`)
  return ctx.evaluate!(signal)
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/
const EXPRESSION_CONSTANTS = new Set(['NaN', 'E', 'LN2', 'LN10', 'LOG2E', 'LOG10E', 'PI', 'SQRT1_2', 'SQRT2', 'MIN_VALUE', 'MAX_VALUE'])

function parseLiteral(v: unknown, ctx: ScaleContext): unknown {
  if (!isObject(v)) return v
  const s = (v as { signal?: unknown }).signal
  if (s) return signalValue(String(s), ctx)
  return raise('Unsupported object: ' + JSON.stringify(v))
}

function parseArray(v: unknown, ctx: ScaleContext): unknown {
  const s = (v as { signal?: unknown }).signal
  return s ? signalValue(String(s), ctx) : (v as unknown[]).map((x) => parseLiteral(x, ctx))
}

// ---- sort specs / aggregate field names ---------------------------------------------

interface Sort { op?: string; field?: string; order?: string }

/** vega-parser util `aggrField`. */
function aggrField(op: string | undefined, field: string | undefined): string {
  return (op || '') + (op && field ? '_' : '') + (field ? field.replace(/\W+/g, '_').replace(/^_+|_+$/g, '') : '')
}

/** vega-parser `parseSort` (signals in op/field/order resolved first). */
function parseSort(sort: unknown, multidomain: boolean, ctx: ScaleContext): Sort | undefined {
  if (!sort) return undefined
  let s: Sort
  if (isObject(sort) && !isArray(sort)) {
    const o = sort as { op?: unknown; field?: unknown; order?: unknown }
    const sig = (v: unknown): unknown => (isObject(v) && (v as { signal?: unknown }).signal ? signalValue(String((v as { signal: string }).signal), ctx) : v)
    s = { op: sig(o.op) as string | undefined, field: sig(o.field) as string | undefined, order: sig(o.order) as string | undefined }
  } else {
    s = {}
  }
  if (!s.field && !s.op) {
    s.field = 'key'
  } else if (!s.field && s.op !== 'count') {
    raise('No field provided for sort aggregate op: ' + s.op)
  } else if (multidomain && s.field) {
    if (s.op && !MULTIDOMAIN_SORT_OPS[s.op]) raise('Multiple domain scales can not be sorted using ' + s.op)
  }
  return s
}

const MULTIDOMAIN_SORT_OPS: Record<string, string> = Object.assign(Object.create(null), { min: 'min', max: 'max', count: 'sum' })

// ---- discrete domains (Aggregate groupby + Values) ----------------------------------

interface Tuple { key: unknown; count: number; [agg: string]: unknown }

/** The aggregate of one group of cell values under vega's ops (an unknown op refuses, as upstream). */
function aggregateOf(op: string, cells: unknown[]): unknown {
  return aggregateGroup(cells.map((v) => ({ v })), { type: 'aggregate', groupby: [], fields: ['v'], ops: [op], as: ['r'] }).r
}

/**
 * vega-parser `countsRef`: Aggregate groupby `key` (+ `count`, + the sort
 * aggregate) over a dataset field. Groups are keyed by the stringified value —
 * vega's cell table — so `1` and `'1'` are one group (the first value seen), and
 * the output order is cell creation order.
 */
function countsTuples(ctx: ScaleContext, data: string, field: string, sort: Sort | undefined): Tuple[] {
  const useOp = sort?.op && sort.field
  const keys = fieldValues(ctx, data, field)
  if (useOp) {
    // the aggregate engine groups (same key rule) and measures in one pass
    const vals = fieldValues(ctx, data, sort!.field!)
    const rows: Array<{ g: unknown; v: unknown }> = new Array(keys.length)
    for (let i = 0; i < keys.length; ++i) rows[i] = { g: keys[i], v: vals[i] }
    const name = aggrField(sort!.op, sort!.field)
    return aggregateRows(rows, { groupby: ['g'], fields: [null, 'v'], ops: ['count', sort!.op!], as: ['count', 'r'] })
      .map((r) => ({ key: r.g, count: r.count as number, [name]: r.r }))
  }
  const cells = new Map<string, Tuple>()
  for (let i = 0; i < keys.length; ++i) {
    const k = keys[i]
    const ck = String(k)
    let tuple = cells.get(ck)
    if (!tuple) cells.set(ck, (tuple = { key: k, count: 0 }))
    tuple.count++
  }
  return Array.from(cells.values())
}

function fieldValues(ctx: ScaleContext, data: string, field: unknown): unknown[] {
  if (ctx.hasData && !ctx.hasData(data)) raise('Can not find data set: ' + JSON.stringify(data))
  return ctx.dataField(data, fieldName(field, ctx))
}

function fieldName(field: unknown, ctx: ScaleContext): string {
  if (isString(field)) return field
  const s = isObject(field) ? (field as { signal?: unknown }).signal : undefined
  if (!s) raise('Unsupported field reference: ' + JSON.stringify(field))
  return String(signalValue(String(s), ctx))
}

/** vega-transforms `Values` with a vega-util `compare(aggrField, order)` over the tuples (stable). */
function valuesOf(tuples: Tuple[], sort: Sort | undefined): unknown[] {
  if (!sort) return tuples.map((t) => t.key)
  const name = aggrField(sort.op, sort.field)
  const sign = (sort.order || 'ascending') === 'descending' ? -1 : 1
  return sortData(
    tuples.map((t, i) => ({ t, i })),
    (a, b) => ascending(a.t[name], b.t[name]) * sign || a.i - b.i,
  ).map((e) => e.t.key)
}

// ---- domains (vega-parser parseScaleDomain) ------------------------------------------

function isDiscreteType(type: string): boolean { return !!vs.isDiscrete(type) }

/** `memo`: the per-evaluation (rows identity, field) -> tuples cache for unsorted single-field domains. */
function discreteDomain(ctx: ScaleContext, data: string, field: unknown, sort: Sort | undefined): unknown[] {
  const name = fieldName(field, ctx)
  const memoable = !(sort?.op && sort.field)
  const rows = memoable && ctx.distinctCache && ctx.dataRows ? ctx.dataRows(data) : undefined
  let tuples: Tuple[] | undefined
  if (rows) {
    let byField = ctx.distinctCache!.get(rows)
    if (!byField) ctx.distinctCache!.set(rows, (byField = new Map()))
    tuples = byField.get(name) as Tuple[] | undefined
    if (!tuples) byField.set(name, (tuples = countsTuples(ctx, data, name, undefined)))
  } else {
    tuples = countsTuples(ctx, data, name, sort)
  }
  return valuesOf(tuples, sort)
}

/** vega-transforms `Extent` over a field's values: `[min, max]`, or `[undefined, undefined]` when infinite. */
function extentOf(values: unknown[]): [number | undefined, number | undefined] {
  let min = +Infinity
  let max = -Infinity
  for (let i = 0; i < values.length; ++i) {
    const v = toNumber(values[i])
    if (v != null) {
      // NaNs will fail all comparisons!
      if (v < min) min = v
      if (v > max) max = v
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [undefined, undefined]
  return [min, max]
}

function extentOfField(ctx: ScaleContext, data: string, field: unknown): [number | undefined, number | undefined] {
  return extentOf(fieldValues(ctx, data, field))
}

/** vega-parser `parseScaleDomain`: the domain a scale spec's (or discrete range's) `domain` describes. */
function parseScaleDomain(domain: unknown, spec: { type: string; domainMin?: unknown; domainMax?: unknown }, ctx: ScaleContext): unknown {
  if (!domain) {
    if (spec.domainMin != null || spec.domainMax != null) raise('No scale domain defined for domainMin/domainMax to override.')
    return undefined // default domain
  }
  const d = domain as { signal?: unknown; fields?: unknown; data?: string; field?: unknown; sort?: unknown }
  if (d.signal) return signalValue(String(d.signal), ctx)
  if (isArray(domain)) return (domain as unknown[]).map((v) => parseLiteral(v, ctx)) // explicitDomain
  if (d.fields) return multipleDomain(d as { fields: unknown[]; data?: string; sort?: unknown }, spec, ctx)
  return singularDomain(d as { data: string; field: unknown; sort?: unknown }, spec, ctx)
}

function singularDomain(domain: { data: string; field: unknown; sort?: unknown }, spec: { type: string }, ctx: ScaleContext): unknown {
  // vega-parser's scope.getData: a domain that names no data set at all (a bare string, number or `true`, or an
  // object with no `data`) fails vega.parse itself, before any view exists
  if (typeof domain.data !== 'string') throw new SpecParseError(`Undefined data set name: ${JSON.stringify(domain.data)}`)
  if (ctx.hasData ? !ctx.hasData(domain.data) : false) raise('Can not find data set: ' + JSON.stringify(domain.data))
  if (isDiscreteType(spec.type)) return discreteDomain(ctx, domain.data, domain.field, parseSort(domain.sort, false, ctx))
  if (vs.isQuantile(spec.type)) return fieldValues(ctx, domain.data, domain.field) // domainRef: the raw values
  return extentOfField(ctx, domain.data, domain.field)
}

/** A `fields` member (vega-parser multipleDomain's reduce): a field of `data`, or a literal/signal value list. */
interface Member { data?: string; field?: unknown; literal?: unknown[] }

/**
 * The values of a literal member's `data` field once vega has ingested it (Tuple.ingest): an object is the tuple itself, so the
 * field reads its `data` property (a Date, an array have none); anything else becomes `{data: value}`.
 */
function ingested(values: readonly unknown[]): unknown[] {
  return values.map((x) => (x !== null && (typeof x === 'object' || typeof x === 'function') ? (x as { data?: unknown }).data : x))
}

function multipleDomain(domain: { fields: unknown[]; data?: string; sort?: unknown }, spec: { type: string }, ctx: ScaleContext): unknown {
  const fields: Member[] = domain.fields.map((d) => {
    if (isString(d)) return { data: domain.data, field: d }
    if (isArray(d)) return { literal: ingested(d as unknown[]) }
    const sig = (d as { signal?: unknown }).signal
    if (sig) {
      const v = signalValue(String(sig), ctx)
      // (vega: `setdata(name, signal)` ingests vega-util `array(value)` -- a scalar is one tuple, no value none)
      return { literal: ingested(v == null ? [] : isArray(v) ? (v as unknown[]) : [v]) }
    }
    return d as Member
  })
  const values = (f: Member): unknown[] => (f.literal ? f.literal : fieldValues(ctx, f.data as string, f.field))
  if (isDiscreteType(spec.type)) return ordinalMultipleDomain(domain, ctx, fields)
  if (vs.isQuantile(spec.type)) return fields.reduce<unknown[]>((all, f) => all.concat(values(f)), []) // quantileMultipleDomain
  // numericMultipleDomain: MultiExtent over each member's extent
  let min = +Infinity
  let max = -Infinity
  for (const f of fields) {
    const e = extentOf(values(f))
    if ((e[0] as number) < min) min = e[0] as number
    if ((e[1] as number) > max) max = e[1] as number
  }
  return [min, max]
}

function ordinalMultipleDomain(domain: { sort?: unknown }, ctx: ScaleContext, fields: Member[]): unknown[] {
  const sort = parseSort(domain.sort, true, ctx)
  // value counts for each member (a literal list is its own one-column dataset)
  const tuples: Tuple[] = []
  for (const f of fields) {
    if (f.literal) {
      const cells = new Map<string, Tuple>()
      for (const k of f.literal) {
        const ck = String(k)
        let tuple = cells.get(ck)
        if (!tuple) cells.set(ck, (tuple = { key: k, count: 0 }))
        tuple.count++
      }
      pushAll(tuples, Array.from(cells.values()))
    } else {
      if (ctx.hasData && !ctx.hasData(f.data as string)) raise('Can not find data set: ' + JSON.stringify(f.data))
      pushAll(tuples, countsTuples(ctx, f.data as string, fieldName(f.field, ctx), sort))
    }
  }
  // aggregate the results from each member: groupby key, summing/min/max-ing the sort column
  let a: string | undefined
  let v: string | undefined
  if (sort) {
    a = sort.op || 'count'
    v = sort.field ? aggrField(a, sort.field) : 'count'
  }
  const op = a ? MULTIDOMAIN_SORT_OPS[a] : undefined
  const cells = new Map<string, { tuple: Tuple; vals: unknown[] }>()
  for (const t of tuples) {
    const ck = String(t.key)
    let cell = cells.get(ck)
    if (!cell) cells.set(ck, (cell = { tuple: { key: t.key, count: 0 }, vals: [] }))
    cell.tuple.count++
    if (v) cell.vals.push(t[v])
  }
  const merged: Tuple[] = []
  for (const cell of cells.values()) {
    if (v && op) cell.tuple[v] = aggregateOf(op, cell.vals)
    merged.push(cell.tuple)
  }
  return valuesOf(merged, sort)
}

// ---- range (vega-parser parseScaleRange) --------------------------------------------

function parseScaleRange(spec: CompiledScale, ctx: ScaleContext, params: Params, userConfig: Record<string, unknown> | undefined, depth = 0): unknown {
  let range: unknown = spec.range
  const r = range as { signal?: unknown; scheme?: unknown; extent?: unknown; count?: unknown; step?: unknown }
  if (r && r.signal) return signalValue(String(r.signal), ctx)
  if (isString(range)) {
    // config.range (the user's block over vega's defaults) names the range; a user key replaces the default entry
    const inUser = userConfig != null && hasOwnProperty(userConfig, range)
    if (inUser || hasOwnProperty(DEFAULT_CONFIG_RANGE, range)) {
      if (depth > 32) raise('Scale range lookup cycles through config.range: ' + range)
      const entry = inUser ? userConfig![range] : DEFAULT_CONFIG_RANGE[range]
      return parseScaleRange({ ...spec, range: entry as CompiledScale['range'] }, ctx, params, userConfig, depth + 1)
    } else if (range === 'width') {
      range = [0, ctx.width]
    } else if (range === 'height') {
      range = isDiscreteType(spec.type) ? [0, ctx.height] : [ctx.height, 0]
    } else {
      raise('Unrecognized scale range value: ' + JSON.stringify(range))
    }
  } else if (r.scheme) {
    params.scheme = isArray(r.scheme) ? parseArray(r.scheme, ctx) : parseLiteral(r.scheme, ctx)
    if (r.extent) params.schemeExtent = parseArray(r.extent, ctx)
    if (r.count) params.schemeCount = parseLiteral(r.count, ctx)
    return undefined
  } else if (r.step) {
    params.rangeStep = parseLiteral(r.step, ctx)
    return undefined
  } else if (isDiscreteType(spec.type) && !isArray(range)) {
    return parseScaleDomain(range, spec, ctx)
  } else if (!isArray(range)) {
    raise('Unsupported range type: ' + JSON.stringify(range))
  }
  return (range as unknown[]).map((v) => (isArray(v) ? parseArray : parseLiteral)(v, ctx))
}

// ---- parse + Scale transform --------------------------------------------------------

/** The properties the Scale transform consumes itself (vega-encode's SKIP). */
const SKIP = new Set([
  'set', 'modified', 'clear', 'type', 'scheme', 'schemeExtent', 'schemeCount',
  'domain', 'domainMin', 'domainMid', 'domainMax',
  'domainRaw', 'domainImplicit', 'nice', 'zero', 'bins',
  'range', 'rangeStep', 'round', 'reverse', 'interpolate', 'interpolateGamma',
])

/** vega-parser `parseScale`: the scale spec as the parameter object the Scale transform receives. */
function parseScale(spec: CompiledScale, ctx: ScaleContext): Params {
  const type = spec.type || 'linear'
  if (!vs.isValidScaleType(type)) raise('Unrecognized scale type: ' + JSON.stringify(type))
  // the spec itself, read as `type`-defaulted: copying it per build costs more than the build of a literal scale
  const s = (spec.type ? spec : { ...spec, type }) as CompiledScale & Record<string, unknown>
  // a plain object (cheaper than a dictionary-mode one on every build): the keys the spec
  // contributes are copied through below with `__proto__` refused, and nothing reads a name
  // the prototype also has
  const params: Params = {}
  params.type = type
  params.domain = parseScaleDomain(s.domain, s, ctx)

  if (s.range != null) params.range = parseScaleRange(s, ctx, params, ctx.configRange)

  if (s.interpolate != null) {
    const ip = s.interpolate as { type?: unknown; gamma?: unknown }
    params.interpolate = parseLiteral((isObject(ip) && ip.type) || ip, undefinedScopeCtx(ctx))
    if (isObject(ip) && ip.gamma != null) params.interpolateGamma = parseLiteral(ip.gamma, undefinedScopeCtx(ctx))
  }

  if (s.nice != null) {
    const nice = s.nice as { signal?: unknown; interval?: unknown; step?: unknown }
    params.nice = isObject(nice) && nice.signal
      ? signalValue(String(nice.signal), ctx)
      : isObject(nice)
        ? { interval: parseLiteral(nice.interval, ctx), step: parseLiteral(nice.step, ctx) }
        : parseLiteral(nice, ctx)
  }

  if (s.bins != null) {
    const bins = s.bins as { signal?: unknown }
    params.bins = (isObject(bins) && bins.signal) || isArray(bins)
      ? parseArray(bins, ctx)
      : objectProperty(bins as Record<string, unknown>, ctx)
  }

  // everything else is copied through (parseLiteral), in spec order
  for (const key of Object.keys(s)) {
    if (hasOwnProperty(params, key) || key === 'name' || key === '__proto__') continue
    if (s[key] === undefined) continue
    params[key] = parseLiteral(s[key], ctx)
  }
  return params
}

/** vega-parser `objectProperty`: an object whose members may each be signals. */
function objectProperty(o: Record<string, unknown>, ctx: ScaleContext): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(o)) out[k] = parseLiteral(o[k], ctx)
  return out
}

/**
 * DEVIATION: vega-parser's `parseScaleInterpolate` calls `parseLiteral(x)` with
 * no scope, so a `{signal}` interpolate/gamma dies with a TypeError upstream.
 * Aster resolves it like every other literal instead of reproducing the crash.
 */
function undefinedScopeCtx(ctx: ScaleContext): ScaleContext { return ctx }

export function buildScale(c: CompiledScale, ctx: ScaleContext): Scale {
  const _ = parseScale(c, ctx)
  // Host/runtime domain override (pan/zoom, brushing): vega's `domainRaw` parameter.
  const hostRaw = ctx.domainRaw ?? c.domainRaw
  if (hostRaw != null) {
    const resolved = isObject(hostRaw) && !isArray(hostRaw) ? parseLiteral(hostRaw, ctx) : hostRaw
    if (resolved != null) _.domainRaw = resolved
  }

  const key = scaleKey(_)
  const make = vs.scale(key)
  if (!make) raise(`Unrecognized scale type: ${JSON.stringify(key)}`)
  const scale = make!()

  for (const k of Object.keys(_)) {
    if (SKIP.has(k)) continue
    // padding is a scale property for band/point but not others
    if (k === 'padding' && includePad(scale.type)) continue
    // invoke the scale property setter; an unsupported property is only a warning upstream
    if (typeof scale[k] === 'function') (scale[k] as (v: unknown) => unknown)(_[k])
  }

  // (an operator whose parameters did not change does not run again: the scale of the pass before is the scale)
  const passKey = ctx.pass !== undefined ? paramsKey(_) : ''
  if (ctx.pass?.prev?.bins === true && ctx.pass.prev.key !== passKey) scale.bins = []
  configureRange(scale, _, configureBins(scale, _, configureDomain(scale, _)))
  ctx.pass?.record(passKey, !!scale.bins)
  return scale
}

let unkeyed = 0
function paramsKey(_: Params): string {
  try {
    return JSON.stringify(_, (_k, v) => (typeof v === 'function' ? 'fn:' + v.name : v))
  } catch {
    return `#${++unkeyed}` // (not comparable: the scale is made again)
  }
}

function includeZero(scale: Scale): boolean {
  const type = scale.type
  return !scale.bins && (type === vs.Linear || type === vs.Pow || type === vs.Sqrt)
}

function includePad(type: string): boolean {
  return !!vs.isContinuous(type) && type !== vs.Sequential
}

function scaleKey(_: Params): string {
  const t = _.type as string
  let d = ''
  // backwards compatibility pre Vega 5.
  if (t === vs.Sequential) return vs.Sequential + '-' + vs.Linear
  if (isContinuousColor(_)) {
    // NB upstream reads `_.rawDomain` (never set: the parameter is `domainRaw`)
    const raw = _.rawDomain as unknown[] | undefined
    const dom = _.domain as unknown[] | undefined
    const n = raw ? raw.length : dom ? dom.length + +(_.domainMid != null) : 0
    d = n === 2 ? vs.Sequential + '-' : n === 3 ? vs.Diverging + '-' : ''
  }
  return ((d + t) || vs.Linear).toLowerCase()
}

function isContinuousColor(_: Params): boolean {
  const t = _.type as string
  const range = _.range as unknown[] | undefined
  return !!vs.isContinuous(t) && t !== vs.Time && t !== vs.UTC && !!(_.scheme || (range && range.length && range.every(isString)))
}

function configureDomain(scale: Scale, _: Params): number {
  // check raw domain, if provided use that and exit early
  const raw = rawDomain(scale, _.domainRaw)
  if (raw > -1) return raw

  let domain = _.domain as unknown[] | undefined
  const type = scale.type as string
  const zero = _.zero || (_.zero === undefined && includeZero(scale))

  if (!domain) return 0

  // adjust domain based on zero, min, max settings
  if (zero || _.domainMin != null || _.domainMax != null || _.domainMid != null) {
    // vega calls `domain.slice()` on whatever the domain is: a string slices fine (and d3 then reads it as
    // an array of its characters), a number or object throws the TypeError the dataflow logs
    domain = domain.slice()
    const n = (domain.length - 1) || 1
    if (zero) {
      if ((domain[0] as number) > 0) domain[0] = 0
      if ((domain[n] as number) < 0) domain[n] = 0
    }
    if (_.domainMin != null) domain[0] = _.domainMin
    if (_.domainMax != null) domain[n] = _.domainMax

    if (_.domainMid != null) {
      const mid = _.domainMid as number
      const i = mid > (domain[n] as number) ? n + 1 : mid < (domain[0] as number) ? 0 : n
      domain.splice(i, 0, mid)
    }
  }

  // adjust continuous domain for minimum pixel padding
  if (includePad(type) && _.padding && domain[0] !== peek(domain)) {
    domain = padDomain(type, domain, _.range as number[], _.padding as number, _.exponent as number | undefined, _.constant as number | undefined)
  }

  // set the scale domain
  scale.domain(domain)

  // if ordinal scale domain is defined, prevent implicit domain construction as side-effect of scale lookup
  if (type === vs.Ordinal) scale.unknown(_.domainImplicit ? scaleImplicit : undefined)

  // perform 'nice' adjustment as requested
  if (_.nice && scale.nice) {
    scale.nice((_.nice !== true && vs.tickCount(scale, _.nice)) || null)
  }

  // return the cardinality of the domain
  return domain.length
}

function rawDomain(scale: Scale, raw: unknown): number {
  if (raw) {
    scale.domain(raw)
    return (raw as unknown[]).length
  }
  return -1
}

/** vega-encode `padDomain`: zoom the domain so the extremes sit `pad` px inside the range. */
function padDomain(type: string, domain: unknown[], range: number[], pad: number, exponent?: number, constant?: number): unknown[] {
  const span = Math.abs((peek(range) as number) - range[0]!)
  const frac = span / (span - 2 * pad)
  const d = type === vs.Log ? zoomLog(domain as number[], frac)
    : type === vs.Sqrt ? zoomPow(domain as number[], frac, 0.5)
      : type === vs.Pow ? zoomPow(domain as number[], frac, exponent || 1)
        : type === vs.Symlog ? zoomSymlog(domain as number[], frac, constant || 1)
          : zoomLinear(domain as number[], frac)
  domain = domain.slice()
  domain[0] = d[0]
  domain[domain.length - 1] = d[1]
  return domain
}

// vega-util zoom.js (domain-space zooming for padDomain; no anchor)
const zoomExp = (sign: number) => (x: number) => sign * Math.exp(x)
const zoomLogF = (sign: number) => (x: number) => Math.log(sign * x)
const zoomSymlogF = (c: number) => (x: number) => Math.sign(x) * Math.log1p(Math.abs(x / c))
const zoomSymexpF = (c: number) => (x: number) => Math.sign(x) * Math.expm1(Math.abs(x)) * c
const zoomPowF = (exponent: number) => (x: number) => (x < 0 ? -Math.pow(-x, exponent) : Math.pow(x, exponent))

function zoomDomain(domain: number[], frac: number, lift: (x: number) => number, ground: (x: number) => number): [number, number] {
  const d0 = lift(domain[0]!)
  const d1 = lift(peek(domain) as number)
  const da = (d0 + d1) / 2
  return [ground(da + (d0 - da) * frac), ground(da + (d1 - da) * frac)]
}
const zoomLinear = (domain: number[], frac: number) => zoomDomain(domain, frac, Number, (x) => x)
const zoomLog = (domain: number[], frac: number) => {
  const sign = Math.sign(domain[0]!)
  return zoomDomain(domain, frac, zoomLogF(sign), zoomExp(sign))
}
const zoomPow = (domain: number[], frac: number, exponent: number) => zoomDomain(domain, frac, zoomPowF(exponent), zoomPowF(1 / exponent))
const zoomSymlog = (domain: number[], frac: number, constant: number) => zoomDomain(domain, frac, zoomSymlogF(constant), zoomSymexpF(constant))

function configureBins(scale: Scale, _: Params, count: number): number {
  let bins = _.bins as unknown
  if (bins && !isArray(bins)) {
    // generate bin boundary array
    const domain = scale.domain() as number[]
    const lo = domain[0]!
    const hi = peek(domain) as number
    const b = bins as { step?: number; start?: number | null; stop?: number | null }
    const step = b.step as number
    let start = b.start == null ? lo : b.start
    let stop = b.stop == null ? hi : b.stop
    if (!step) raise('Scale bins parameter missing step property.')
    if (start < lo) start = step * Math.ceil(lo / step)
    if (stop > hi) stop = step * Math.floor(hi / step)
    bins = sequence(start, stop + step / 2, step)
  }

  if (bins) {
    // assign bin boundaries to scale instance
    scale.bins = bins
  } else if (scale.bins) {
    // no current bins, remove bins if previously set
    delete scale.bins
  }

  // special handling for bin-ordinal scales
  if (scale.type === vs.BinOrdinal) {
    if (!bins) {
      // the domain specifies the bins
      scale.bins = scale.domain()
    } else if (!_.domain && !_.domainRaw) {
      // the bins specify the domain
      scale.domain(bins)
      count = (bins as unknown[]).length
    }
  }

  // return domain cardinality
  return count
}

function configureRange(scale: Scale, _: Params, count: number): void {
  const type = scale.type as string
  const round = _.round || false
  let range = _.range as unknown

  // if range step specified, calculate full range extent
  if (_.rangeStep != null) {
    range = configureRangeStep(type, _, count)
  } else if (_.scheme) {
    // else if a range scheme is defined, use that
    range = configureScheme(type, _, count)
    if (isFunction(range)) {
      if (scale.interpolator) {
        scale.interpolator(range)
        return
      }
      raise(`Scale type ${type} does not support interpolating color schemes.`)
    }
  }

  // given a range array for an interpolating scale, convert to interpolator
  if (range && vs.isInterpolating(type)) {
    scale.interpolator(vs.interpolateColors(flip(range as string[], _.reverse), _.interpolate as string | undefined, _.interpolateGamma as number | undefined))
    return
  }

  // configure rounding / interpolation
  if (range && _.interpolate && scale.interpolate) {
    scale.interpolate(vs.interpolate(_.interpolate as string, _.interpolateGamma as number | undefined))
  } else if (isFunction(scale.round)) {
    scale.round(round)
  } else if (isFunction(scale.rangeRound)) {
    scale.interpolate(round ? interpolateRound : interpolateValue)
  }

  if (range) scale.range(flip(range as unknown[], _.reverse))
}

function configureRangeStep(type: string, _: Params, count: number): number[] {
  if (type !== vs.Band && type !== vs.Point) raise('Only band and point scales support rangeStep.')
  // calculate full range based on requested step size and padding
  const outer = ((_.paddingOuter != null ? _.paddingOuter : _.padding) as number) || 0
  const inner = type === vs.Point ? 1 : (((_.paddingInner != null ? _.paddingInner : _.padding) as number) || 0)
  return [0, (_.rangeStep as number) * vs.bandSpace(count, inner, outer)]
}

function configureScheme(type: string, _: Params, count: number): unknown {
  const extent = _.schemeExtent as number[] | undefined
  let scheme: unknown
  if (isArray(_.scheme)) {
    scheme = vs.interpolateColors(_.scheme as string[], _.interpolate as string | undefined, _.interpolateGamma as number | undefined)
  } else {
    // `_.scheme.toLowerCase()` upstream: a non-string scheme is a TypeError there
    if (!isString(_.scheme)) throw new TypeError('_.scheme.toLowerCase is not a function')
    scheme = vs.scheme(_.scheme.toLowerCase())
    if (!scheme) raise(`Unrecognized scheme name: ${_.scheme}`)
  }

  // determine size for potential discrete range
  count = type === vs.Threshold ? count + 1
    : type === vs.BinOrdinal ? count - 1
      : type === vs.Quantile || type === vs.Quantize ? (+(_.schemeCount as number) || DEFAULT_COUNT)
        : count

  // adjust and/or quantize scheme as appropriate
  return vs.isInterpolating(type) ? adjustScheme(scheme, extent, _.reverse)
    : isFunction(scheme) ? vs.quantizeInterpolator(adjustScheme(scheme, extent) as SchemeFn, count)
      : type === vs.Ordinal ? scheme : (scheme as unknown[]).slice(0, count)
}

function adjustScheme(scheme: unknown, extent: number[] | undefined, reverse?: unknown): unknown {
  return isFunction(scheme) && (extent || reverse)
    ? vs.interpolateRange(scheme as SchemeFn, flip(extent || [0, 1], reverse))
    : scheme
}

function flip<T>(array: T[], reverse: unknown): T[] {
  return reverse ? array.slice().reverse() : array
}

/** Tick helpers reused from vega-scale (used by the axis runtime). */
export function scaleTicks(s: Scale, count?: number, _size?: number, _step?: number): unknown[] {
  // For time/utc scales: use the scale range width so vega-scale computes
  // an appropriate tick count that matches vega's output.
  if ((s.type === 'time' || s.type === 'utc') && count == null) {
    const range = s.range() as number[]
    if (range.length >= 2) {
      const lo = range[0]!
      const hi = range[range.length - 1] ?? 0
      const sw = Math.abs(hi - lo)
      return (vs as any).tickValues(s, undefined, sw * 1.01) as unknown[]
    }
  }
  // For linear scales with bins: use tickValues which respects scale.bins
  // If bins is set, vega-scale's tickValues uses validTicks() which generates
  // ticks from the bin boundary values instead of d3's default tick algorithm.
  if (count != null) {
    return (vs as any).tickValues(s, count) as unknown[]
  }
  // Fallback: use d3-scale's ticks with the scale range
  const range = s.range() as number[]
  if (range.length >= 2) {
    const span = Math.abs((range[range.length - 1] ?? 0) - (range[0] ?? 0))
    return (vs as any).tickValues(s, undefined, span) as unknown[]
  }
  return []
}
