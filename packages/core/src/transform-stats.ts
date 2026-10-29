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
import { d3Range, required } from './transform-basic.js'
import { checkRegexInput, checkRowCount, guardedRegExp, meterTick } from './limits.js'
import { SQRT2PI, cumulativeNormal, densityNormal } from './stats-functions.js'

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
// sampleCurve (vega-statistics)
// ---------------------------------------------------------------------------

const MIN_RADIANS = 0.5 * Math.PI / 180

/** Adaptively sample an interpolated function over a domain extent. */
export function sampleCurve(f: (x: number) => number, ext: ArrayLike<unknown>, minStepsIn?: number, maxStepsIn?: number): number[][] {
  const minSteps = minStepsIn || 25
  const maxSteps = Math.max(minSteps, maxStepsIn || 200)
  // `steps`/`maxsteps` are spec parameters: bound the sample count before
  // evaluating the density that many times (C9).
  checkRowCount(maxSteps, 'density steps')

  const point = (x: number): number[] => [x, f(x)]
  const minX = ext[0] as number
  const maxX = ext[1] as number
  const span = maxX - minX
  const stop = span / maxSteps
  const prev = [point(minX)]
  const next: number[][] = []

  if (minSteps === maxSteps) {
    // no adaptation, sample uniform grid directly and return
    for (let i = 1; i < maxSteps; ++i) prev.push(point(minX + (i / minSteps) * span))
    prev.push(point(maxX))
    return prev
  }
  // sample minimum points on uniform grid, then adaptive refinement
  next.push(point(maxX))
  for (let i = minSteps; --i > 0;) next.push(point(minX + (i / minSteps) * span))

  let p0 = prev[0]!
  let p1 = next[next.length - 1]
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
    p1 = next[next.length - 1]
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
  const probs = (p.probs as number[]) || d3Range(step / 2, 1 - QUANTILE_EPSILON, step)
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
// regression (vega-statistics regression/*, vega-regression Regression)
// ---------------------------------------------------------------------------

/** A fitted model; `rSquared` is computed on demand (vega computes it eagerly, but only `params: true` reads it). */
interface Fit { coef: number[]; predict: (x: number) => number; rSquared: () => number }

/** Ordinary least squares from normalised sums. */
function ols(uX: number, uY: number, uXY: number, uX2: number): [number, number] {
  const delta = uX2 - uX * uX
  const slope = Math.abs(delta) < 1e-24 ? 0 : (uXY - uX * uY) / delta
  const intercept = uY - slope * uX
  return [intercept, slope]
}

function visitPoints(data: Row[], x: Get, y: Get, cb: (u: number, v: number, i: number) => void): void {
  let i = -1
  for (const d of data) {
    let u: unknown = x(d)
    let v: unknown = y(d)
    if (u != null && (u = +(u as number)) >= (u as number) && v != null && (v = +(v as number)) >= (v as number)) {
      cb(u as number, v as number, ++i)
    }
  }
}

/** vega-statistics regression `points`: the valid points, optionally sorted by x, plus means; data mean-centred. */
function points(dataIn: Row[], x: Get, y: Get, sort?: boolean): [Float64Array, Float64Array, number, number] {
  const data = dataIn.filter((d) => {
    let u: unknown = x(d)
    let v: unknown = y(d)
    return u != null && (u = +(u as number)) >= (u as number) && v != null && (v = +(v as number)) >= (v as number)
  })
  if (sort) data.sort((a, b) => (x(a) as number) - (x(b) as number))
  const n = data.length
  const X = new Float64Array(n)
  const Y = new Float64Array(n)
  let i = 0
  let ux = 0
  let uy = 0
  for (const d of data) {
    const xv = +(x(d) as number)
    const yv = +(y(d) as number)
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
  return [X, Y, ux, uy]
}

function rSquared(data: Row[], x: Get, y: Get, uY: number, predict: (x: number) => number): number {
  let SSE = 0
  let SST = 0
  visitPoints(data, x, y, (dx, dy) => {
    const sse = dy - predict(dx)
    const sst = dy - uY
    SSE += sse * sse
    SST += sst * sst
  })
  return 1 - SSE / SST
}

function constantFit(data: Row[], x: Get, y: Get): Fit {
  let mean = 0
  let n = 0
  for (const d of data) {
    const val = y(d) as number
    if (x(d) == null || val == null || isNaN(val)) continue
    mean += (val - mean) / ++n
  }
  return { coef: [mean], predict: () => mean, rSquared: () => 0 }
}

function linearFit(data: Row[], x: Get, y: Get): Fit {
  let X = 0
  let Y = 0
  let XY = 0
  let X2 = 0
  let n = 0
  // visitPoints, inlined (this is the hot loop of a regression over many rows)
  for (let i = 0; i < data.length; i++) {
    const d = data[i]!
    let dx: unknown = x(d)
    let dy: unknown = y(d)
    if (dx != null && (dx = +(dx as number)) >= (dx as number) && dy != null && (dy = +(dy as number)) >= (dy as number)) {
      ++n
      X += ((dx as number) - X) / n
      Y += ((dy as number) - Y) / n
      XY += ((dx as number) * (dy as number) - XY) / n
      X2 += ((dx as number) * (dx as number) - X2) / n
    }
  }
  const coef = ols(X, Y, XY, X2)
  const predict = (v: number): number => coef[0] + coef[1] * v
  return { coef, predict, rSquared: () => rSquared(data, x, y, Y, predict) }
}

function logFit(data: Row[], x: Get, y: Get): Fit {
  let X = 0
  let Y = 0
  let XY = 0
  let X2 = 0
  let n = 0
  visitPoints(data, x, y, (dxIn, dy) => {
    ++n
    const dx = Math.log(dxIn)
    X += (dx - X) / n
    Y += (dy - Y) / n
    XY += (dx * dy - XY) / n
    X2 += (dx * dx - X2) / n
  })
  const coef = ols(X, Y, XY, X2)
  const predict = (v: number): number => coef[0] + coef[1] * Math.log(v)
  return { coef, predict, rSquared: () => rSquared(data, x, y, Y, predict) }
}

function expFit(data: Row[], x: Get, y: Get): Fit {
  const [xv, , ux, uy] = points(data, x, y)
  let YL = 0
  let XY = 0
  let XYL = 0
  let X2Y = 0
  let n = 0
  visitPoints(data, x, y, (_u, dy) => {
    const dx = xv[n++]!
    const ly = Math.log(dy)
    const xy = dx * dy
    YL += (dy * ly - YL) / n
    XY += (xy - XY) / n
    XYL += (xy * ly - XYL) / n
    X2Y += (dx * xy - X2Y) / n
  })
  const [c0, c1] = ols(XY / uy, YL / uy, XYL / uy, X2Y / uy)
  const predict = (v: number): number => Math.exp(c0 + c1 * (v - ux))
  return { coef: [Math.exp(c0 - c1 * ux), c1], predict, rSquared: () => rSquared(data, x, y, uy, predict) }
}

function powFit(data: Row[], x: Get, y: Get): Fit {
  let X = 0
  let Y = 0
  let XY = 0
  let X2 = 0
  let YS = 0
  let n = 0
  visitPoints(data, x, y, (dx, dy) => {
    const lx = Math.log(dx)
    const ly = Math.log(dy)
    ++n
    X += (lx - X) / n
    Y += (ly - Y) / n
    XY += (lx * ly - XY) / n
    X2 += (lx * lx - X2) / n
    YS += (dy - YS) / n
  })
  const coef = ols(X, Y, XY, X2)
  const predict = (v: number): number => coef[0] * Math.pow(v, coef[1])
  coef[0] = Math.exp(coef[0])
  return { coef, predict, rSquared: () => rSquared(data, x, y, YS, predict) }
}

function quadFit(data: Row[], x: Get, y: Get): Fit {
  const [xv, yv, ux, uy] = points(data, x, y)
  const n = xv.length
  let X2 = 0
  let X3 = 0
  let X4 = 0
  let XY = 0
  let X2Y = 0
  for (let i = 0; i < n;) {
    const dx = xv[i]!
    const dy = yv[i++]!
    const x2 = dx * dx
    X2 += (x2 - X2) / i
    X3 += (x2 * dx - X3) / i
    X4 += (x2 * x2 - X4) / i
    XY += (dx * dy - XY) / i
    X2Y += (x2 * dy - X2Y) / i
  }
  const X2X2 = X4 - (X2 * X2)
  const d = (X2 * X2X2 - X3 * X3)
  const a = (X2Y * X2 - XY * X3) / d
  const b = (XY * X2X2 - X2Y * X3) / d
  const c = -a * X2
  const predict = (v: number): number => {
    v = v - ux
    return a * v * v + b * v + c + uy
  }
  // transform coefficients back from mean-centered space
  return {
    coef: [c - b * ux + a * ux * ux + uy, b - 2 * a * ux, a],
    predict,
    rSquared: () => rSquared(data, x, y, uy, predict),
  }
}

function polyFit(data: Row[], x: Get, y: Get, order: number): Fit {
  // use more efficient methods for lower orders
  if (order === 0) return constantFit(data, x, y)
  if (order === 1) return linearFit(data, x, y)
  if (order === 2) return quadFit(data, x, y)

  const [xv, yv, ux, uy] = points(data, x, y)
  const n = xv.length
  const lhs: number[] = []
  const rhs: Array<Float64Array | number[]> = []
  const k = order + 1
  for (let i = 0; i < k; ++i) {
    let v = 0
    for (let l = 0; l < n; ++l) v += Math.pow(xv[l]!, i) * yv[l]!
    lhs.push(v)
    const c = new Float64Array(k)
    for (let j = 0; j < k; ++j) {
      v = 0
      for (let l = 0; l < n; ++l) v += Math.pow(xv[l]!, i + j)
      c[j] = v
    }
    rhs.push(c)
  }
  rhs.push(lhs)

  const coef = gaussianElimination(rhs)
  const predict = (v: number): number => {
    v -= ux
    let out = uy + coef[0]! + coef[1]! * v + coef[2]! * v * v
    for (let i = 3; i < k; ++i) out += coef[i]! * Math.pow(v, i)
    return out
  }
  return { coef: uncenter(k, coef, -ux, uy), predict, rSquared: () => rSquared(data, x, y, uy, predict) }
}

function uncenter(k: number, a: number[], x: number, y: number): number[] {
  const z = new Array<number>(k)
  for (let i = 0; i < k; ++i) z[i] = 0
  // polynomial expansion
  for (let i = k - 1; i >= 0; --i) {
    const v = a[i]!
    let c = 1
    z[i] = z[i]! + v
    for (let j = 1; j <= i; ++j) {
      c *= (i + 1 - j) / j // binomial coefficent
      z[i - j] = z[i - j]! + v * Math.pow(x, j) * c
    }
  }
  // bias term
  z[0] = z[0]! + y
  return z
}

/** Solve A * x = b by Gaussian elimination (the augmented matrix is column-major, as upstream). */
function gaussianElimination(matrix: Array<Float64Array | number[]>): number[] {
  const n = matrix.length - 1
  const coef: number[] = []
  for (let i = 0; i < n; ++i) {
    let r = i // max row
    for (let j = i + 1; j < n; ++j) {
      if (Math.abs(matrix[i]![j]!) > Math.abs(matrix[i]![r]!)) r = j
    }
    for (let k = i; k < n + 1; ++k) {
      const t = matrix[k]![i]!
      matrix[k]![i] = matrix[k]![r]!
      matrix[k]![r] = t
    }
    for (let j = i + 1; j < n; ++j) {
      for (let k = n; k >= i; k--) {
        matrix[k]![j] = matrix[k]![j]! - (matrix[k]![i]! * matrix[i]![j]!) / matrix[i]![i]!
      }
    }
  }
  for (let j = n - 1; j >= 0; --j) {
    let t = 0
    for (let k = j + 1; k < n; ++k) t += matrix[k]![j]! * coef[k]!
    coef[j] = (matrix[n]![j]! - t) / matrix[j]![j]!
  }
  return coef
}

const REGRESSION_METHODS: Record<string, (data: Row[], x: Get, y: Get, order: number) => Fit> = {
  constant: constantFit,
  linear: linearFit,
  log: logFit,
  exp: expFit,
  pow: powFit,
  quad: quadFit,
  poly: polyFit,
}

const degreesOfFreedom = (method: string, order: number): number => (method === 'poly' ? order : method === 'quad' ? 2 : 1)

export function regressionRows(rows: Row[], p: Params): Row[] {
  required('regression', p, 'x', 'y')
  const xf = fieldOf(p.x)
  const yf = fieldOf(p.y)
  const groupby = groupbyAccessors(p)
  const groups = partitionRows(rows, groupby)
  const names = (groupby ?? []).map((g) => accessorName(g) as string)
  const method = (p.method as string) || 'linear'
  const order = p.order == null ? 3 : (p.order as number)
  const dof = degreesOfFreedom(method, order)
  const as = (p.as ?? [accessorName(xf), accessorName(yf)]) as string[]
  const values: Row[] = []
  let domain = p.extent as number[] | null | undefined

  if (!hasOwnProperty(REGRESSION_METHODS, method)) error('Invalid regression method: ' + method)
  const fit = REGRESSION_METHODS[method]!

  if (domain != null && method === 'log' && domain[0]! <= 0) domain = null // ignore extents <= 0 for log regression

  for (const g of groups) {
    const n = g.length
    if (n <= dof) continue // fewer data points than parameters: skipped (vega warns)
    const model = fit(g, xf, yf, order)
    if (p.params) {
      // if parameter vectors requested return those
      values.push({ keys: g.dims, coef: model.coef, rSquared: model.rSquared() })
      continue
    }
    const dom = (domain || vegaExtent(g, xf)) as unknown[]
    const add = (pt: unknown[]): void => {
      const t: Row = {}
      for (let i = 0; i < names.length; ++i) t[names[i]!] = g.dims![i]
      t[as[0]!] = pt[0]
      t[as[1]!] = pt[1]
      values.push(t)
    }
    if (method === 'linear' || method === 'constant') {
      // for linear or constant regression we only need the end points
      dom.forEach((x) => add([x, model.predict(x as number)]))
    } else {
      // otherwise return trend line sample points
      sampleCurve(model.predict, dom, 25, 200).forEach(add)
    }
    checkRowCount(values.length, 'regression')
  }
  return values
}

// ---------------------------------------------------------------------------
// loess (vega-statistics regression/loess.js — adapted from science.js by Jason Davies, BSD-3-Clause; see THIRD_PARTY_NOTICES.md)
// ---------------------------------------------------------------------------

const LOESS_MAX_ITERS = 2
const LOESS_EPSILON = 1e-12

const tricube = (x: number): number => (x = 1 - x * x * x) * x * x

/** Advance the sliding window of nearest neighbors over sorted x values. */
function updateInterval(xv: Float64Array, i: number, interval: [number, number]): void {
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

/** d3-array `median` of a typed array. */
function median(values: Float64Array): number | undefined {
  const v = Float64Array.from(values).sort((a, b) => (a < b ? -1 : a > b ? 1 : a >= b ? 0 : NaN))
  const n = v.length
  if (!n) return undefined
  if (n < 2) return v[0]
  const i = (n - 1) * 0.5
  const i0 = Math.floor(i)
  return v[i0]! + (v[i0 + 1]! - v[i0]!) * (i - i0)
}

function loessFit(data: Row[], x: Get, y: Get, bandwidth: number): number[][] {
  const [xv, yv, ux, uy] = points(data, x, y, true)
  const n = xv.length
  const bw = Math.max(2, ~~(bandwidth * n)) // # nearest neighbors
  const yhat = new Float64Array(n)
  const residuals = new Float64Array(n)
  const robustWeights = new Float64Array(n).fill(1)

  for (let iter = -1; ++iter <= LOESS_MAX_ITERS;) {
    const interval: [number, number] = [0, bw - 1]
    for (let i = 0; i < n; ++i) {
      const dx = xv[i]!
      const i0 = interval[0]
      const i1 = interval[1]
      const edge = (dx - xv[i0]!) > (xv[i1]! - dx) ? i0 : i1
      let W = 0
      let X = 0
      let Y = 0
      let XY = 0
      let X2 = 0
      const denom = 1 / Math.abs(xv[edge]! - dx || 1) // avoid singularity!
      // O(window) per point, O(n^2) overall at a wide bandwidth: sample the clock.
      meterTick('loess', i1 - i0 + 1)
      for (let k = i0; k <= i1; ++k) {
        const xk = xv[k]!
        const yk = yv[k]!
        const w = tricube(Math.abs(dx - xk) * denom) * robustWeights[k]!
        const xkw = xk * w
        W += w
        X += xkw
        Y += yk * w
        XY += yk * xkw
        X2 += xk * xkw
      }
      // linear regression fit
      const [a, b] = ols(X / W, Y / W, XY / W, X2 / W)
      yhat[i] = a + b * dx
      residuals[i] = Math.abs(yv[i]! - yhat[i]!)
      updateInterval(xv, i + 1, interval)
    }
    if (iter === LOESS_MAX_ITERS) break
    const medianResidual = median(residuals) as number
    if (Math.abs(medianResidual) < LOESS_EPSILON) break
    for (let i = 0; i < n; ++i) {
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
  for (let i = 0; i < n; ++i) {
    const v = xv[i]! + ux
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
    for (const pt of loessFit(g, xf, yf, (p.bandwidth as number) || 0.3)) {
      const t: Row = {}
      for (let i = 0; i < names.length; ++i) t[names[i]!] = g.dims![i]
      t[as[0]!] = pt[0]
      t[as[1]!] = pt[1]
      values.push(t)
    }
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

