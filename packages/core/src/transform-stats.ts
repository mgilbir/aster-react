/**
 * Statistical transforms (vega-transforms KDE / Density / Quantile / CountPattern,
 * vega-regression Regression / Loess) and the vega-statistics pieces they use
 * (distributions, `sampleCurve`, the regression fits), ported operation for
 * operation so the output agrees with the oracle to the bit.
 *
 * Loaded by the transforms addon (`transform-extra.ts` registers them). Pinned
 * by `testdata/vectors/vega-transforms.json`. Input rows are never mutated; odd
 * values keep Vega's meaning: group support values are the RAW field values
 * (`''`, numeric strings, Dates ...) with JS coercion in the arithmetic, and
 * `partition` keys groups by `String(groupbyValues)`.
 */
import { accessorName, error, extent as vegaExtent, hasOwnProperty } from './util.js'
import { fieldOf, fieldsOf, quantiles, type Row } from './transform-agg.js'
import { numberRange, required } from './transform-basic.js'
import { checkRegexInput, checkRowCount, guardedRegExp, meterTick } from './limits.js'
import { SQRT2PI, cumulativeNormal, densityNormal } from './stats-functions.js'
import { FITS, fitParameters, loessSmooth, sampleCurve } from './curve-fits.js'

type Params = Record<string, unknown>
type Get = (d: unknown) => unknown

// ---------------------------------------------------------------------------
// partition (vega-transforms util/util.js, vega-regression partition.js)
// ---------------------------------------------------------------------------

type Dims = { dims?: unknown[] }

/** Partition field VALUES by the group-by tuple (groups keyed by `String([a, b])`). */
function partitionValues(data: Row[], groupby: Get[] | null, field: Get): Array<unknown[] & Dims> {
  const groups: Array<unknown[] & Dims> = []
  if (groupby == null) {
    groups.push(data.map(field) as unknown[] & Dims)
    return groups
  }
  const map = new Map<string, unknown[] & Dims>()
  const one = groupby.length === 1 ? groupby[0]! : null
  for (const t of data) {
    // String([v]) is '' for null/undefined and String(v) otherwise: one field needs no array to key a group
    let ks: string
    let k: unknown[] | undefined
    if (one) { const v = one(t); ks = v == null ? '' : String(v); if (!map.has(ks)) k = [v] } else { k = groupby.map((f) => f(t)); ks = String(k) }
    let g = map.get(ks)
    if (!g) {
      g = [] as unknown as unknown[] & Dims
      g.dims = k!
      map.set(ks, g)
      groups.push(g)
    }
    g.push(field(t))
  }
  return groups
}

/** Partition TUPLES by the group-by tuple (vega-regression `partition`). */
function partitionRows(data: Row[], groupby: Get[] | null): Array<Row[] & Dims> {
  if (groupby == null) return [data as Row[] & Dims]
  const groups: Array<Row[] & Dims> = []
  const map = new Map<string, Row[] & Dims>()
  const one = groupby.length === 1 ? groupby[0]! : null
  for (const t of data) {
    let ks: string
    let k: unknown[] | undefined
    if (one) { const v = one(t); ks = v == null ? '' : String(v); if (!map.has(ks)) k = [v] } else { k = groupby.map((f) => f(t)); ks = String(k) }
    let g = map.get(ks)
    if (!g) {
      g = [] as unknown as Row[] & Dims
      g.dims = k!
      map.set(ks, g)
      groups.push(g)
    }
    g.push(t)
  }
  return groups
}

/** Partition the whole row set (every dataset-wide group by the full tuple) by group-by; `null` for none given. */
export function groupbyAccessors(p: Params): Get[] | null {
  return p.groupby == null ? null : fieldsOf(p.groupby)
}

// ---------------------------------------------------------------------------
// d3-array / vega-statistics numerics
// ---------------------------------------------------------------------------

/** d3-array `variance` (Welford), skipping null and NaN. */
function d3variance(values: ArrayLike<unknown>): number | undefined {
  let count = 0
  let delta: number
  let mean = 0
  let sum = 0
  for (let i = 0; i < values.length; i++) {
    let value: unknown = values[i]
    if (value != null && (value = +(value as number)) >= (value as number)) {
      delta = (value as number) - mean
      mean += delta / ++count
      sum += delta * ((value as number) - mean)
    }
  }
  if (count > 1) return sum / (count - 1)
  return undefined
}

function d3deviation(values: ArrayLike<unknown>): number | undefined {
  const v = d3variance(values)
  return v ? Math.sqrt(v) : v
}

/** vega-statistics `bandwidth` (Scott's rule of thumb). */
export function bandwidthOf(arr: ArrayLike<unknown>): number {
  const n = arr.length
  const d = d3deviation(arr)
  const q = quantiles(arr, [0.25, 0.5, 0.75]) as number[]
  const h = (q[2]! - q[0]!) / 1.34
  const v = Math.min(d as number, h) || d || Math.abs(q[0]!) || 1
  return 1.06 * (v as number) * Math.pow(n, -0.2)
}

// ---------------------------------------------------------------------------
// distributions (vega-statistics): normal, lognormal, uniform, mixture, kde
// ---------------------------------------------------------------------------

export interface Dist {
  pdf(x: number): number
  cdf(x: number): number
  [setter: string]: unknown
}

function normalDist(): Dist {
  let mu = 0
  let sigma = 1
  const dist: Dist = {
    mean(...a: unknown[]) { if (a.length) { mu = (a[0] as number) || 0; return dist } return mu },
    stdev(...a: unknown[]) { if (a.length) { sigma = a[0] == null ? 1 : (a[0] as number); return dist } return sigma },
    pdf: (value) => densityNormal(value, mu, sigma),
    cdf: (value) => cumulativeNormal(value, mu, sigma),
  }
  return dist
}

function lognormalDist(): Dist {
  let mu = 0
  let sigma = 1
  const dist: Dist = {
    mean(...a: unknown[]) { if (a.length) { mu = (a[0] as number) || 0; return dist } return mu },
    stdev(...a: unknown[]) { if (a.length) { sigma = a[0] == null ? 1 : (a[0] as number); return dist } return sigma },
    pdf: (value) => {
      if (value <= 0) return 0
      const m = mu || 0
      const sd = sigma == null ? 1 : sigma
      const z = (Math.log(value) - m) / sd
      return Math.exp(-0.5 * z * z) / (sd * SQRT2PI * value)
    },
    cdf: (value) => cumulativeNormal(Math.log(value), mu, sigma),
  }
  return dist
}

function uniformDist(): Dist {
  let a = 0
  let b = 1
  const dist: Dist = {
    min(...x: unknown[]) { if (x.length) { a = (x[0] as number) || 0; return dist } return a },
    max(...x: unknown[]) { if (x.length) { b = x[0] == null ? 1 : (x[0] as number); return dist } return b },
    pdf: (value) => (value >= a && value <= b ? 1 / (b - a) : 0),
    cdf: (value) => (value < a ? 0 : value > b ? 1 : (value - a) / (b - a)),
  }
  return dist
}

function mixtureDist(): Dist {
  let m = 0
  let dists: Dist[] = []
  let weights: unknown[] | undefined
  let w: number[] = []
  const normalize = (x: unknown[]): number[] => {
    const out: number[] = []
    let sum = 0
    let i: number
    for (i = 0; i < m; ++i) { sum += (out[i] = (x[i] == null ? 1 : +(x[i] as number))) }
    for (i = 0; i < m; ++i) { out[i] = out[i]! / sum }
    return out
  }
  const dist: Dist = {
    weights(...a: unknown[]) {
      if (a.length) { w = normalize((weights = ((a[0] as unknown[]) || []))); return dist }
      return weights
    },
    distributions(...a: unknown[]) {
      if (a.length) {
        if (a[0]) { m = (a[0] as Dist[]).length; dists = a[0] as Dist[] } else { m = 0; dists = [] }
        return (dist.weights as (...x: unknown[]) => unknown)(weights)
      }
      return dists
    },
    pdf(x) { let p = 0; for (let i = 0; i < m; ++i) p += w[i]! * dists[i]!.pdf(x); return p },
    cdf(x) { let p = 0; for (let i = 0; i < m; ++i) p += w[i]! * dists[i]!.cdf(x); return p },
  }
  ;(dist.distributions as (...x: unknown[]) => unknown)(dists)
  ;(dist.weights as (...x: unknown[]) => unknown)(weights)
  return dist
}

/** vega-statistics `randomKDE`: a Gaussian kernel density estimate of the RAW support values. */
function kdeDist(support?: unknown[], bandwidth?: number): Dist {
  // the standard-normal kernel (mean 0, stdev 1): `gaussian()` with its defaults
  // the pdf loop inlines the kernel: (value - 0) / 1 === value and 1 * SQRT2PI === SQRT2PI exactly, so it is densityNormal(z, 0, 1) bit for bit
  const kernelCdf = (z: number): number => cumulativeNormal(z, 0, 1)
  let n = 0
  const dist: Dist = {
    data(...a: unknown[]) {
      if (a.length) {
        support = a[0] as unknown[]
        n = support ? support.length : 0
        return (dist.bandwidth as (...x: unknown[]) => unknown)(bandwidth)
      }
      return support
    },
    bandwidth(...a: unknown[]) {
      if (!a.length) return bandwidth
      bandwidth = a[0] as number
      if (!bandwidth && support) bandwidth = bandwidthOf(support)
      return dist
    },
    pdf(x) {
      const sup = support as number[]
      const bw = bandwidth as number
      const m = n
      let y = 0
      for (let i = 0; i < m; ++i) {
        const z = (x - sup[i]!) / bw
        y += Math.exp(-0.5 * z * z) / SQRT2PI // kernelPdf, inlined
      }
      meterTick('kde', m)
      return y / bw / m
    },
    cdf(x) {
      const sup = support as number[]
      const bw = bandwidth as number
      const m = n
      let y = 0
      for (let i = 0; i < m; ++i) y += kernelCdf((x - sup[i]!) / bw)
      meterTick('kde', m)
      return y / m
    },
  }
  return (dist.data as (...x: unknown[]) => Dist)(support)
}

const DISTRIBUTIONS: Record<string, () => Dist> = {
  kde: () => kdeDist(),
  mixture: mixtureDist,
  normal: normalDist,
  lognormal: lognormalDist,
  uniform: uniformDist,
}

/** vega-transforms `util/Distributions.parse`: build a distribution from its spec object. */
function parseDist(def: Params, data: () => Row[], datasets?: (name: string) => unknown[] | undefined): Dist {
  const func = def.function as string
  // vega rejects this when it parses the `distribution` param, before the transform runs
  if (!hasOwnProperty(DISTRIBUTIONS, func)) error('Unsupported parameter: ' + JSON.stringify(def))
  const d = DISTRIBUTIONS[func]!()
  for (const name of Object.keys(def)) {
    if (name === 'field') {
      const src = def.from != null ? ((typeof def.from === 'string' ? datasets?.(def.from) : def.from) ?? []) as Row[] : data()
      const f = fieldOf(def[name])
      ;(d.data as (x: unknown) => unknown)(src.map(f))
    } else if (name === 'distributions') {
      ;(d.distributions as (x: unknown) => unknown)((def[name] as Params[]).map((x) => parseDist(x, data, datasets)))
    } else if (typeof d[name] === 'function') {
      ;(d[name] as (x: unknown) => unknown)(def[name])
    }
  }
  return d
}

// ---------------------------------------------------------------------------
// kde, density, quantile
// ---------------------------------------------------------------------------

export function kdeRows(rows: Row[], p: Params): Row[] {
  required('kde', p, 'field')
  const field = fieldOf(p.field)
  const groupby = groupbyAccessors(p)
  const groups = partitionValues(rows, groupby, field)
  const names = (groupby ?? []).map((g) => accessorName(g) as string)
  const bandwidth = p.bandwidth as number
  const method = p.cumulative ? 'cdf' : 'pdf'
  const as = (p.as ?? ['value', 'density']) as string[]
  const values: Row[] = []

  let domain = p.extent as unknown[] | undefined
  let minsteps = (p.steps as number) || (p.minsteps as number) || 25
  let maxsteps = (p.steps as number) || (p.maxsteps as number) || 200

  if (p.resolve === 'shared') {
    if (!domain) domain = vegaExtent(rows, field) as unknown[]
    minsteps = maxsteps = (p.steps as number) || maxsteps
  }

  for (const g of groups) {
    const density = (kdeDist(g, bandwidth) as unknown as Record<string, (x: number) => number>)[method]!
    const scale = p.counts ? g.length : 1
    const local = domain || (vegaExtent(g) as unknown[])
    for (const v of sampleCurve(density, local, minsteps, maxsteps)) {
      const t: Row = {}
      for (let i = 0; i < names.length; ++i) t[names[i]!] = g.dims![i]
      t[as[0]!] = v[0]
      t[as[1]!] = v[1]! * scale
      values.push(t)
    }
    checkRowCount(values.length, 'kde')
  }
  return values
}

export function densityRows(rows: Row[], p: Params, datasets?: (name: string) => unknown[] | undefined): Row[] {
  const minsteps = (p.steps as number) || (p.minsteps as number) || 25
  const maxsteps = (p.steps as number) || (p.maxsteps as number) || 200
  const dist = parseDist((p.distribution ?? {}) as Params, () => rows, datasets)
  const method = (p.method as string) || 'pdf'
  if (method !== 'pdf' && method !== 'cdf') error('Invalid density method: ' + method)
  if (!p.extent && !dist.data) error('Missing density extent parameter.')
  const f = dist[method] as (x: number) => number
  const as = (p.as ?? ['value', 'density']) as string[]
  const domain = (p.extent as unknown[]) || (vegaExtent((dist.data as () => unknown[])()) as unknown[])
  return sampleCurve(f, domain, minsteps, maxsteps).map((v) => {
    const tuple: Row = {}
    tuple[as[0]!] = v[0]
    tuple[as[1]!] = v[1]
    return tuple
  })
}

const QUANTILE_EPSILON = 1e-14

export function quantileRows(rows: Row[], p: Params): Row[] {
  required('quantile', p, 'field')
  const field = fieldOf(p.field)
  const as = (p.as ?? ['prob', 'value']) as string[]
  const groupby = groupbyAccessors(p)
  const groups = partitionValues(rows, groupby, field)
  const names = (groupby ?? []).map((g) => accessorName(g) as string)
  const step = (p.step as number) || 0.01
  const probs = (p.probs as number[]) || numberRange(step / 2, 1 - QUANTILE_EPSILON, step)
  const n = probs.length
  checkRowCount(groups.length * n, 'quantile')
  const values: Row[] = []
  for (const g of groups) {
    const q = quantiles(g, probs)
    for (let i = 0; i < n; ++i) {
      const t: Row = {}
      for (let j = 0; j < names.length; ++j) t[names[j]!] = g.dims![j]
      t[as[0]!] = probs[i]
      t[as[1]!] = q[i]
      values.push(t)
    }
  }
  return values
}

// ---------------------------------------------------------------------------
// regression and loess: the rows around the fits of curve-fits.ts
// ---------------------------------------------------------------------------

/** One output row of a fitted curve: the group's key values, then the point under the output field names. */
function curveRow(names: string[], dims: unknown[] | undefined, as: string[], px: unknown, py: unknown): Row {
  const row: Row = {}
  for (let i = 0; i < names.length; ++i) row[names[i]!] = dims![i]
  row[as[0]!] = px
  row[as[1]!] = py
  return row
}

export function regressionRows(rows: Row[], p: Params): Row[] {
  required('regression', p, 'x', 'y')
  const xf = fieldOf(p.x)
  const yf = fieldOf(p.y)
  const groupby = groupbyAccessors(p)
  const groups = partitionRows(rows, groupby)
  const names = (groupby ?? []).map((g) => accessorName(g) as string)
  const method = (p.method as string) || 'linear'
  const order = p.order == null ? 3 : (p.order as number)
  const parameters = fitParameters(method, order)
  const as = (p.as ?? [accessorName(xf), accessorName(yf)]) as string[]
  const values: Row[] = []
  let domain = p.extent as number[] | null | undefined

  if (!hasOwnProperty(FITS, method)) error('Invalid regression method: ' + method)
  const fit = FITS[method]!

  // a logarithm has no values at or below zero: such an extent is ignored
  if (domain != null && method === 'log' && domain[0]! <= 0) domain = null

  for (const g of groups) {
    if (g.length <= parameters) continue // not more rows than parameters: nothing to fit
    const model = fit(g, xf, yf, order)
    if (p.params) {
      values.push({ keys: g.dims, coef: model.coef, rSquared: model.rSquared() })
      continue
    }
    const ends = (domain || vegaExtent(g, xf)) as unknown[]
    // a straight line is its two ends; any other curve is sampled where it bends
    const curve: Array<[unknown, unknown]> = method === 'linear' || method === 'constant'
      ? ends.map((end) => [end, model.predict(end as number)])
      : sampleCurve(model.predict, ends, 25, 200)
    for (const [px, py] of curve) values.push(curveRow(names, g.dims, as, px, py))
    checkRowCount(values.length, 'regression')
  }
  return values
}

export function loessRows(rows: Row[], p: Params): Row[] {
  required('loess', p, 'x', 'y')
  const xf = fieldOf(p.x)
  const yf = fieldOf(p.y)
  const groupby = groupbyAccessors(p)
  const groups = partitionRows(rows, groupby)
  const names = (groupby ?? []).map((g) => accessorName(g) as string)
  const as = (p.as ?? [accessorName(xf), accessorName(yf)]) as string[]
  const values: Row[] = []
  for (const g of groups) {
    for (const [px, py] of loessSmooth(g, xf, yf, (p.bandwidth as number) || 0.3)) values.push(curveRow(names, g.dims, as, px, py))
    checkRowCount(values.length, 'loess')
  }
  return values
}

// ---------------------------------------------------------------------------
// countpattern
// ---------------------------------------------------------------------------

export function countpatternRows(rows: Row[], p: Params): Row[] {
  required('countpattern', p, 'field')
  const f = fieldOf(p.field)
  const tcase = (p.case as string | undefined) || 'mixed'
  // Regex guard (safety deviation): pattern and per-row input lengths are capped
  // under limits; catastrophic backtracking itself cannot be interrupted.
  const match = guardedRegExp(((p.pattern as string | undefined) || '[\\w\']+'), 'g')
  const stop = guardedRegExp('^' + ((p.stopwords as string | undefined) || '') + '$', 'i')
  const as = (p.as ?? ['text', 'count']) as string[]
  // own-key table (a token such as `constructor` is data, not an inherited member)
  const counts = new Map<string, number>()
  for (const tuple of rows) {
    let text = f(tuple) as string
    checkRegexInput(String(text))
    if (tcase === 'upper') text = text.toUpperCase()
    else if (tcase === 'lower') text = text.toLowerCase()
    const tokens = text.match(match) || []
    for (let i = 0, n = tokens.length; i < n; ++i) {
      const tk = tokens[i]!
      if (!stop.test(tk)) counts.set(tk, 1 + (counts.get(tk) || 0))
    }
    meterTick('countpattern', 1)
  }
  // output follows object-key iteration order (integer-like tokens ascending, then first seen)
  const keys = [...counts.keys()]
  const isIndex = (s: string): boolean => /^(0|[1-9]\d*)$/.test(s) && +s < 4294967295
  const ordered = keys.filter(isIndex).sort((x, y) => +x - +y).concat(keys.filter((k) => !isIndex(k)))
  checkRowCount(ordered.length, 'countpattern')
  const out: Row[] = []
  for (const w of ordered) {
    const c = counts.get(w) || 0
    if (c) {
      const t: Row = {}
      t[as[0]!] = w
      t[as[1]!] = c
      out.push(t)
    }
  }
  return out
}

