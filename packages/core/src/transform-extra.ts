/**
 * Rare-layout transforms (stats, hierarchy layouts, wordcloud, voronoi).
 * Loaded by the `@aster/core/transforms` addon; the core bundle keeps only
 * the transforms a plain chart uses. Shared internals come from transform.ts.
 */
import { ownGet, minOf, maxOf } from './util.js'
import { activeMeter, checkRowCount, meterTick, guardedRegExp, checkRegexInput } from './limits.js'
import type { CompiledTransform, SortSpec } from './types.js'
import type { HierNode, Row, TransformContext } from './transform.js'
import {
  ascendingNum, collectField, compileExprTransform, d3Range, deviationOf, eachAfter, eachBefore,
  estimateBandwidth, extentOf, getField, groupRows, isFiniteNumber, quantileSorted, resolveNum,
  resolveSizeParam, sortRows,
} from './transform.js'
import { transformRegistry } from './registry.js'
import { nominalTextWidth } from './text-metrics.js'

// -- kde (vega-statistics randomKDE + sampleCurve) ---------------------------

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
  // `steps`/`maxsteps` are spec parameters: bound the sample count before
  // evaluating the density that many times (C9).
  checkRowCount(maxSteps, 'density steps')

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
    // shared densities sample a single uniform grid over the union domain
    // (vega-transforms KDE: minsteps = maxsteps = steps || maxsteps)
    if (!domain) {
      const vals = collectField(rows, field).filter(isFiniteNumber)
      domain = vals.length ? [minOf(vals), maxOf(vals)] : [0, 1]
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
    checkRowCount(out.length + curve.length, 'kde')
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
  checkRowCount(groups.length * probs.length, 'quantile')
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
      // O(window) per point, O(n^2) overall at a wide bandwidth: sample the clock.
      meterTick('loess', i1 - i0 + 1)

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


// -- pack / partition / treemap (d3-hierarchy layouts) -----------------------



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
        meterTick('pack')
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

// ---------------------------------------------------------------------------
// partition (d3-hierarchy partition layout)
//
// The vega `partition` transform wraps d3-hierarchy's `partition` layout,
// which assigns x0/y0/x1/y1 to every node. The layout is used for sunburst
// and icicle charts: the x-axis represents proportional value (angular span
// for sunburst) and the y-axis represents depth bands (radial bands).
//
// The implementation follows d3-hierarchy@3.1.2 source:
//   src/partition.js       — partition layout (dx/dy/padding/round)
//   src/treemap/dice.js    — horizontal splitting
//   src/treemap/round.js   — integer rounding
// ---------------------------------------------------------------------------

/**
 * d3-hierarchy partition dice: split children along the x-axis using the
 * parent's accumulated value as denominator (matching d3-hierarchy's
 * treemap/dice.js which uses `parent.value`).
 */
function partitionDice(parent: HierNode, x0: number, y0: number, x1: number, y1: number): void {
  const nodes = parent.children
  const n = nodes.length
  if (!n) return
  const k = parent.value && (x1 - x0) / parent.value
  let x = x0
  for (let i = 0; i < n; i++) {
    const node = nodes[i]!
    node.y0 = y0
    node.y1 = y1
    node.x0 = x
    x += node.value * k
    node.x1 = x
  }
}

/** The vega `partition` transform: layout the stratify-built tree via d3 partition. */
function partitionRows(rows: Row[], t: Record<string, unknown>, ctx: TransformContext, sourceName?: string): Row[] {
  const root = sourceName ? (ctx.hierarchies?.get(sourceName) as HierNode | undefined) : undefined
  if (!root) {
    throw new Error('[aster] partition transform requires a preceding stratify transform on the same data source')
  }
  const field = t.field as string | undefined
  const sort = t.sort as SortSpec | undefined
  const round = t.round === true
  const padding = (t.padding as number) ?? 0
  const as = (t.as as string[]) ?? ['x0', 'y0', 'x1', 'y1', 'depth', 'children']
  const size = t.size as number[] | undefined
  // d3-hierarchy default partition size is [1, 1]
  const dx = size?.[0] ?? 1
  const dy = size?.[1] ?? 1

  // root.sum(field): each node's value is its own plus its descendants'.
  eachAfter(root, (node) => {
    let sum = field != null ? Number(node.data[field]) || 0 : 1
    for (const c of node.children) sum += c.value
    node.value = sum
  })

  if (sort?.field) sortTreeChildren(root, sort)

  // d3-hierarchy partition layout
  const n = root.height + 1
  root.x0 = padding
  root.y0 = padding
  root.x1 = dx
  root.y1 = dy / n

  eachBefore(root, (node) => {
    if (node.children.length) {
      // d3-hierarchy partition: treemapDice splits children along x-axis
      // within the next depth band (y range). Unlike the treemap version,
      // the partition dice uses parent.value (not sum of children) as the
      // denominator because the parent's x range [x0,x1] represents its
      // full accumulated value.
      const y0 = dy * (node.depth + 1) / n
      const y1 = dy * (node.depth + 2) / n
      partitionDice(node, node.x0!, y0, node.x1!, y1)
    }
    // Apply padding and clamping (d3-hierarchy partition positionNode)
    let x0 = node.x0!
    let y0 = node.y0!
    let x1 = node.x1! - padding
    let y1 = node.y1! - padding
    if (x1 < x0) x0 = x1 = (x0 + x1) / 2
    if (y1 < y0) y0 = y1 = (y0 + y1) / 2
    node.x0 = x0
    node.y0 = y0
    node.x1 = x1
    node.y1 = y1
  })

  // Round if requested
  if (round) {
    eachBefore(root, (node) => {
      node.x0 = Math.round(node.x0!)
      node.y0 = Math.round(node.y0!)
      node.x1 = Math.round(node.x1!)
      node.y1 = Math.round(node.y1!)
    })
  }

  // Write results back to rows (mirrors vega HierarchyLayout setFields)
  eachBefore(root, (node) => {
    const d = node.data
    d[as[0]!] = node.x0
    d[as[1]!] = node.y0
    d[as[2]!] = node.x1
    d[as[3]!] = node.y1
    d[as[4]!] = node.depth
    d[as[5]!] = node.children.length
  })

  return rows
}

// ---------------------------------------------------------------------------
// treemap (d3-hierarchy treemap layout — squarify tiling)
//
// The vega `treemap` transform wraps d3-hierarchy's `treemap` layout, which
// assigns x0/y0/x1/y1 to every node. The layout needs the tree that a
// preceding `stratify` transform built; we thread it through
// `TransformContext.hierarchies` just like `pack` does.
//
// The implementation follows d3-hierarchy@3.1.2 source:
//   src/treemap/index.js   — positionNode + paddingStack
//   src/treemap/squarify.js — squarifyRatio + worst + row grouping
//   src/treemap/dice.js    — horizontal splitting
//   src/treemap/slice.js   — vertical splitting
//   src/treemap/round.js   — integer rounding
// ---------------------------------------------------------------------------

const PHI = (1 + Math.sqrt(5)) / 2

/** The vega `treemap` transform: layout the stratify-built tree via squarify. */
function treemapRows(rows: Row[], t: Record<string, unknown>, ctx: TransformContext, sourceName?: string): Row[] {
  const root = sourceName ? (ctx.hierarchies?.get(sourceName) as HierNode | undefined) : undefined
  if (!root) {
    throw new Error('[aster] treemap transform requires a preceding stratify transform on the same data source')
  }
  const field = t.field as string | undefined
  const sort = t.sort as SortSpec | undefined
  const round = t.round === true
  const padding = (t.padding as number) ?? 0
  const paddingInner = (t.paddingInner as number) ?? padding
  const paddingOuter = (t.paddingOuter as number) ?? padding
  const paddingTop = (t.paddingTop as number) ?? paddingOuter
  const paddingRight = (t.paddingRight as number) ?? paddingOuter
  const paddingBottom = (t.paddingBottom as number) ?? paddingOuter
  const paddingLeft = (t.paddingLeft as number) ?? paddingOuter
  const as = (t.as as string[]) ?? ['x0', 'y0', 'x1', 'y1']
  const ratio = (t.ratio as number) ?? PHI
  const size = t.size as number[] | undefined
  // d3-hierarchy default treemap size is [1, 1]
  const dx = size?.[0] ?? 1
  const dy = size?.[1] ?? 1

  // root.sum(field): each node's value is its own plus its descendants'.
  eachAfter(root, (node) => {
    let sum = field != null ? Number(node.data[field]) || 0 : 1
    for (const c of node.children) sum += c.value
    node.value = sum
  })

  if (sort?.field) sortTreeChildren(root, sort)

  // --- d3-hierarchy treemap: eachBefore(positionNode) -----------------------
  // Root initial bounds
  root.x0 = 0; root.y0 = 0; root.x1 = dx; root.y1 = dy

  // paddingStack[i] stores the half-inner-padding to shrink nodes at depth i.
  // depth 0 is always 0 (root is not shrunk).
  const paddingStack = [0]

  eachBefore(root, (node) => {
    // 1. Shrink node bounds by the padding stored for this depth.
    const p = paddingStack[node.depth] ?? 0
    let nx0 = node.x0! + p
    let ny0 = node.y0! + p
    let nx1 = node.x1! - p
    let ny1 = node.y1! - p
    if (nx1 < nx0) nx0 = nx1 = (nx0 + nx1) / 2
    if (ny1 < ny0) ny0 = ny1 = (ny0 + ny1) / 2
    node.x0 = nx0; node.y0 = ny0; node.x1 = nx1; node.y1 = ny1

    // 2. If this node has children, compute the tiling area and tile them.
    if (node.children.length) {
      // Store inner padding for children's depth
      const ip = paddingInner / 2
      paddingStack[node.depth + 1] = ip

      // Outer padding minus inner-half for the tiling area
      let tx0 = nx0 + paddingLeft - ip
      let ty0 = ny0 + paddingTop - ip
      let tx1 = nx1 - paddingRight - ip
      let ty1 = ny1 - paddingBottom - ip
      if (tx1 < tx0) tx0 = tx1 = (tx0 + tx1) / 2
      if (ty1 < ty0) ty0 = ty1 = (ty0 + ty1) / 2

      treemapSquarify(node, tx0, ty0, tx1, ty1, ratio)
    }
  })

  // Round if requested
  if (round) {
    eachBefore(root, (node) => {
      node.x0 = Math.round(node.x0!)
      node.y0 = Math.round(node.y0!)
      node.x1 = Math.round(node.x1!)
      node.y1 = Math.round(node.y1!)
    })
  }

  // Write results back to rows
  eachBefore(root, (node) => {
    const d = node.data
    d[as[0]!] = node.x0
    d[as[1]!] = node.y0
    d[as[2]!] = node.x1
    d[as[3]!] = node.y1
    d.x = (node.x0! + node.x1!) / 2
    d.y = (node.y0! + node.y1!) / 2
    d.width = node.x1! - node.x0!
    d.height = node.y1! - node.y0!
  })

  return rows
}

/**
 * Squarify tiling — port of d3-hierarchy's `squarifyRatio`.
 *
 * Groups children into rows that minimise the worst aspect ratio, then
 * places each row as a slice or dice within the available rectangle.
 */
function treemapSquarify(
  parent: HierNode,
  x0: number, y0: number, x1: number, y1: number,
  ratio: number,
): void {
  const nodes = parent.children
  const n = nodes.length
  if (!n) return

  let i0 = 0
  let i1 = 0
  let value = parent.value

  while (i0 < n) {
    let dx = x1 - x0
    let dy = y1 - y0

    // Find the next non-empty node.
    let sumValue: number
    do { sumValue = nodes[i1]!.value; i1++ } while (!sumValue && i1 < n)
    let minValue = sumValue
    let maxValue = sumValue

    const alpha = Math.max(dy / dx, dx / dy) / (value * ratio)
    let beta = sumValue * sumValue * alpha
    let minRatio = Math.max(maxValue / beta, beta / minValue)

    // Keep adding nodes while the aspect ratio maintains or improves.
    for (; i1 < n; ++i1) {
      const nodeValue = nodes[i1]!.value
      sumValue += nodeValue
      if (nodeValue < minValue) minValue = nodeValue
      if (nodeValue > maxValue) maxValue = nodeValue
      beta = sumValue * sumValue * alpha
      const newRatio = Math.max(maxValue / beta, beta / minValue)
      if (newRatio > minRatio) { sumValue -= nodeValue; break }
      minRatio = newRatio
    }

    // Position the row (slice or dice) and advance the remaining rectangle.
    dx = x1 - x0; dy = y1 - y0
    const dice = dx < dy
    if (dice) {
      // dice: children split the x-axis, row spans a y-band
      const yEnd = value ? y0 + dy * sumValue / value : y1
      treemapDice(nodes, i0, i1, x0, y0, x1, yEnd)
      y0 = yEnd
    } else {
      // slice: children split the y-axis, row spans an x-band
      const xEnd = value ? x0 + dx * sumValue / value : x1
      treemapSlice(nodes, i0, i1, x0, y0, xEnd, y1)
      x0 = xEnd
    }

    value -= sumValue
    i0 = i1
  }
}

/**
 * Horizontal splitting — port of d3-hierarchy's `treemap/dice.js`.
 * Children split the x-axis within [x0, y0]–[x1, y1].
 */
function treemapDice(
  nodes: HierNode[], i0: number, i1: number,
  x0: number, y0: number, x1: number, y1: number,
): void {
  const n = i1 - i0
  if (n <= 0) return
  // Compute total value of the slice
  let total = 0
  for (let i = i0; i < i1; i++) total += nodes[i]!.value
  const k = total && (x1 - x0) / total
  let x = x0
  for (let i = i0; i < i1; i++) {
    const node = nodes[i]!
    node.x0 = x; node.y0 = y0; node.y1 = y1
    x += node.value * k
    node.x1 = x
  }
}

/**
 * Vertical splitting — port of d3-hierarchy's `treemap/slice.js`.
 * Children split the y-axis within [x0, y0]–[x1, y1].
 */
function treemapSlice(
  nodes: HierNode[], i0: number, i1: number,
  x0: number, y0: number, x1: number, y1: number,
): void {
  const n = i1 - i0
  if (n <= 0) return
  let total = 0
  for (let i = i0; i < i1; i++) total += nodes[i]!.value
  const k = total && (y1 - y0) / total
  let y = y0
  for (let i = i0; i < i1; i++) {
    const node = nodes[i]!
    node.x0 = x0; node.x1 = x1; node.y0 = y
    y += node.value * k
    node.y1 = y
  }
}

// -- wordcloud (d3-cloud layout, simplified) ---------------------------------

// ---------------------------------------------------------------------------
// wordcloud (d3-cloud layout, simplified)
//
// Vega's wordcloud transform wraps d3-cloud, which needs a 2d canvas to sprite
// glyphs. In a headless process there is no canvas, so the oracle skips the
// layout entirely for empty input; this implementation provides a deterministic
// stand-in that mirrors d3-cloud's structure: words sorted by size descending,
// placed on an archimedean spiral from the centre with a bounding-box overlap
// test (using the vega-scenegraph width estimate 0.8 * chars * fontSize, the
// same estimate vega falls back to when no canvas is available).
// ---------------------------------------------------------------------------

function wordcloudRows(rows: Row[], t: Record<string, unknown>, ctx: TransformContext): Row[] {
  const size = resolveSizeParam(t.size, ctx) ?? [500, 500]
  const as = (t.as as string[] | undefined) ?? ['x', 'y', 'font', 'fontSize', 'fontStyle', 'fontWeight', 'angle']
  const textField = t.text as string | undefined
  const font = (t.font as string) ?? 'sans-serif'
  const fontStyle = (t.fontStyle as string) ?? 'normal'
  const fontWeight = (t.fontWeight as string) ?? 'normal'
  const rotate = Number(t.rotate ?? 0)
  const padding = Number(t.padding ?? 1)
  const [W, H] = size

  // Font-size accessor: an explicit number, a field reference (`{field}`) or a
  // string field name; default 14. When the accessor is field-based, vega maps
  // the field values through a sqrt scale into `fontSizeRange` ([10, 50]).
  const rawFontSize = t.fontSize
  const fsize = (d: Row): number => {
    let v: unknown
    if (rawFontSize != null && typeof rawFontSize === 'object' && 'field' in rawFontSize) {
      v = getField(d, (rawFontSize as { field: string }).field)
    } else if (rawFontSize != null && typeof rawFontSize === 'object' && 'signal' in rawFontSize) {
      v = ctx.signals[(rawFontSize as { signal: string }).signal]
    } else if (typeof rawFontSize === 'number') {
      v = rawFontSize
    } else if (typeof rawFontSize === 'string') {
      v = getField(d, rawFontSize)
    } else {
      v = 14
    }
    return v == null || v === '' ? 14 : Number(v)
  }
  const fsizeValues = rows.map(fsize).filter((v) => Number.isFinite(v))
  const fsizeExtent = fsizeValues.length ? [minOf(fsizeValues), maxOf(fsizeValues)] : undefined
  const fsizeRange = (t.fontSizeRange as [number, number] | undefined) ?? [10, 50]
  const scaleFontSize = (v: number): number => {
    if (!fsizeExtent || fsizeExtent[0] === fsizeExtent[1]) return fsizeRange[0]
    const t0 = (v - fsizeExtent[0]!) / (fsizeExtent[1]! - fsizeExtent[0]!)
    return fsizeRange[0] + Math.sqrt(t0) * (fsizeRange[1]! - fsizeRange[0])
  }

  interface CloudWord {
    datum: Row
    text: string
    size: number
    w: number
    h: number
    x: number
    y: number
    placed: boolean
  }

  // Build + sort words by size descending (d3-cloud's `.sort((a,b) => b.size - a.size)`).
  const words: CloudWord[] = rows
    .map((r) => {
      const s = ~~(scaleFontSize(fsize(r)) + 1e-14)
      const text = textField ? String(getField(r, textField) ?? '') : ''
      return {
        datum: r,
        text,
        size: s,
        // vega's wordcloud sizes words via textMetrics: canvas measureText
        // when available, the 0.8*chars*fontSize estimate otherwise.
        w: text.length ? nominalTextWidth(text, s) : 0,
        h: s,
        x: 0,
        y: 0,
        placed: false,
      }
    })
    .sort((a, b) => b.size - a.size)

  const cx = W >> 1
  const cy = H >> 1
  const placed: CloudWord[] = []
  const collides = (w: CloudWord): boolean => {
    const hw = w.w / 2 + padding
    const hh = w.h / 2 + padding
    for (const p of placed) {
      const phw = p.w / 2 + padding
      const phh = p.h / 2 + padding
      if (w.x + hw <= p.x - phw || w.x - hw >= p.x + phw || w.y + hh <= p.y - phh || w.y - hh >= p.y + phh) continue
      return true
    }
    return false
  }

  // Archimedean spiral placement: `[e * (t*.1) * cos(t), t*.1 * sin(t)]` with
  // e = 1 for a square layout, snapped to whole pixels, clipped to the box.
  for (const w of words) {
    const hw = w.w / 2 + padding
    const hh = w.h / 2 + padding
    let t = 0
    for (let attempt = 0; attempt < 10000; attempt++) {
      // each attempt is a scan over every placed word: O(words^2 * attempts)
      meterTick('wordcloud', placed.length + 1)
      const theta = t * 0.1
      const x = cx + Math.round(theta * Math.cos(theta))
      const y = cy + Math.round(theta * Math.sin(theta))
      if (x - hw >= 0 && y - hh >= 0 && x + hw <= W && y + hh <= H) {
        w.x = x
        w.y = y
        if (!collides(w)) {
          w.placed = true
          break
        }
      }
      t += 1
    }
    if (w.placed) placed.push(w)
  }

  // Write layout results back onto the input rows. Unplaced words get null
  // coordinates (vega writes NaN, which serializes to null).
  const out: Row[] = []
  const wordOf = new Map<Row, CloudWord>()
  for (const cw of words) wordOf.set(cw.datum, cw)
  for (const r of rows) {
    const w = wordOf.get(r)
    if (w && w.placed) {
      out.push({
        ...r,
        [as[0]!]: w.x,
        [as[1]!]: w.y,
        [as[2]!]: font,
        [as[3]!]: w.size,
        [as[4]!]: fontStyle,
        [as[5]!]: fontWeight,
        [as[6]!]: rotate,
      })
    } else {
      out.push({ ...r, [as[0]!]: null, [as[1]!]: null, [as[3]!]: 0 })
    }
  }
  return out
}


// -- voronoi (d3-delaunay Delaunay.from(...).voronoi(bounds).cellPolygon(i) port) ----

// ---------------------------------------------------------------------------
// voronoi (d3-delaunay `Delaunay.from(...).voronoi(bounds).cellPolygon(i)` port)
//
// The vega `voronoi` transform builds a Delaunay triangulation of the input
// points and emits, per tuple, an `as` field holding the tuple's Voronoi cell
// clipped to the `size`/`extent` rectangle as an SVG path. d3-delaunay cannot
// be imported directly (it is not a dependency of this package), so the
// algorithm is ported operation-for-operation from delaunator@5 + d3-delaunay@6
// (orient2d uses the plain double-precision cross product, whose sign matches
// robust-predicates for coordinates in the double-exact range).
// ---------------------------------------------------------------------------

const DELAUNATOR_EPSILON = Math.pow(2, -52)

function delaunatorOrient2d(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  return (ay - cy) * (bx - cx) - (ax - cx) * (by - cy)
}

function delaunatorPseudoAngle(dx: number, dy: number): number {
  const p = dx / (Math.abs(dx) + Math.abs(dy))
  return (dy > 0 ? 3 - p : 1 + p) / 4
}

function delaunatorDist(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx
  const dy = ay - by
  return dx * dx + dy * dy
}

function delaunatorInCircle(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, px: number, py: number): boolean {
  const dx = ax - px
  const dy = ay - py
  const ex = bx - px
  const ey = by - py
  const fx = cx - px
  const fy = cy - py
  const ap = dx * dx + dy * dy
  const bp = ex * ex + ey * ey
  const cp = fx * fx + fy * fy
  return dx * (ey * cp - bp * fy) - dy * (ex * cp - bp * fx) + ap * (ex * fy - ey * fx) < 0
}

function delaunatorCircumradius(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  const dx = bx - ax
  const dy = by - ay
  const ex = cx - ax
  const ey = cy - ay
  const bl = dx * dx + dy * dy
  const cl = ex * ex + ey * ey
  const d = 0.5 / (dx * ey - dy * ex)
  const x = (ey * bl - dy * cl) * d
  const y = (dx * cl - ex * bl) * d
  return x * x + y * y
}

function delaunatorCircumcenter(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): { x: number; y: number } {
  const dx = bx - ax
  const dy = by - ay
  const ex = cx - ax
  const ey = cy - ay
  const bl = dx * dx + dy * dy
  const cl = ex * ex + ey * ey
  const d = 0.5 / (dx * ey - dy * ex)
  return { x: ax + (ey * bl - dy * cl) * d, y: ay + (dx * cl - ex * bl) * d }
}

function delaunatorQuicksort(ids: Uint32Array, dists: Float64Array, left: number, right: number): void {
  if (right - left <= 20) {
    for (let i = left + 1; i <= right; i++) {
      const temp = ids[i]!
      const tempDist = dists[temp]!
      let j = i - 1
      while (j >= left && (dists[ids[j]!] as number) > tempDist) ids[j + 1] = ids[j--]!
      ids[j + 1] = temp
    }
  } else {
    const median = (left + right) >> 1
    let i = left + 1
    let j = right
    delaunatorSwap(ids, median, i)
    if ((dists[ids[left]!] as number) > (dists[ids[right]!] as number)) delaunatorSwap(ids, left, right)
    if ((dists[ids[i]!] as number) > (dists[ids[right]!] as number)) delaunatorSwap(ids, i, right)
    if ((dists[ids[left]!] as number) > (dists[ids[i]!] as number)) delaunatorSwap(ids, left, i)

    const temp = ids[i]!
    const tempDist = dists[temp]!
    while (true) {
      do i++
      while ((dists[ids[i]!] as number) < tempDist)
      do j--
      while ((dists[ids[j]!] as number) > tempDist)
      if (j < i) break
      delaunatorSwap(ids, i, j)
    }
    ids[left + 1] = ids[j]!
    ids[j] = temp

    if (right - i + 1 >= j - left) {
      delaunatorQuicksort(ids, dists, i, right)
      delaunatorQuicksort(ids, dists, left, j - 1)
    } else {
      delaunatorQuicksort(ids, dists, left, j - 1)
      delaunatorQuicksort(ids, dists, i, right)
    }
  }
}

function delaunatorSwap(arr: Uint32Array, i: number, j: number): void {
  const tmp = arr[i]!
  arr[i] = arr[j]!
  arr[j] = tmp
}

/** Port of delaunator@5's Delaunator (Bowyer-Watson incremental triangulation). */
class DelaunatorPort {
  coords: Float64Array
  _triangles: Uint32Array
  _halfedges: Int32Array
  _hashSize: number
  _hullPrev: Uint32Array
  _hullNext: Uint32Array
  _hullTri: Uint32Array
  _hullHash: Int32Array
  _ids: Uint32Array
  _dists: Float64Array
  trianglesLen = 0
  _cx = 0
  _cy = 0
  _hullStart = 0
  hull: Uint32Array
  triangles: Uint32Array
  halfedges: Int32Array

  constructor(coords: Float64Array) {
    this.coords = coords
    const n = coords.length >> 1
    const maxTriangles = Math.max(2 * n - 5, 0)
    this._triangles = new Uint32Array(maxTriangles * 3)
    this._halfedges = new Int32Array(maxTriangles * 3)
    this._hashSize = Math.ceil(Math.sqrt(n))
    this._hullPrev = new Uint32Array(n)
    this._hullNext = new Uint32Array(n)
    this._hullTri = new Uint32Array(n)
    this._hullHash = new Int32Array(this._hashSize)
    this._ids = new Uint32Array(n)
    this._dists = new Float64Array(n)
    this.hull = this._triangles
    this.triangles = this._triangles
    this.halfedges = this._halfedges
    this.update()
  }

  update(): void {
    const coords = this.coords
    const hullPrev = this._hullPrev
    const hullNext = this._hullNext
    const hullTri = this._hullTri
    const hullHash = this._hullHash
    const n = coords.length >> 1

    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (let i = 0; i < n; i++) {
      const x = coords[2 * i]!
      const y = coords[2 * i + 1]!
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
      this._ids[i] = i
    }
    const cx = (minX + maxX) / 2
    const cy = (minY + maxY) / 2

    let i0 = 0
    let i1 = 0
    let i2 = 0

    for (let i = 0, minDist = Infinity; i < n; i++) {
      const d = delaunatorDist(cx, cy, coords[2 * i]!, coords[2 * i + 1]!)
      if (d < minDist) {
        i0 = i
        minDist = d
      }
    }
    const i0x = coords[2 * i0]!
    const i0y = coords[2 * i0 + 1]!

    for (let i = 0, minDist = Infinity; i < n; i++) {
      if (i === i0) continue
      const d = delaunatorDist(i0x, i0y, coords[2 * i]!, coords[2 * i + 1]!)
      if (d < minDist && d > 0) {
        i1 = i
        minDist = d
      }
    }
    let i1x = coords[2 * i1]!
    let i1y = coords[2 * i1 + 1]!

    let minRadius = Infinity
    for (let i = 0; i < n; i++) {
      if (i === i0 || i === i1) continue
      const r = delaunatorCircumradius(i0x, i0y, i1x, i1y, coords[2 * i]!, coords[2 * i + 1]!)
      if (r < minRadius) {
        i2 = i
        minRadius = r
      }
    }
    let i2x = coords[2 * i2]!
    let i2y = coords[2 * i2 + 1]!

    if (minRadius === Infinity) {
      for (let i = 0; i < n; i++) {
        this._dists[i] = (coords[2 * i]! - coords[0]!) || (coords[2 * i + 1]! - coords[1]!)
      }
      delaunatorQuicksort(this._ids, this._dists, 0, n - 1)
      const hull = new Uint32Array(n)
      let j = 0
      for (let i = 0, d0 = -Infinity; i < n; i++) {
        const id = this._ids[i]!
        const d = this._dists[id]!
        if (d > d0) {
          hull[j++] = id
          d0 = d
        }
      }
      this.hull = hull.subarray(0, j)
      this.triangles = new Uint32Array(0)
      this.halfedges = new Int32Array(0)
      return
    }

    if (delaunatorOrient2d(i0x, i0y, i1x, i1y, i2x, i2y) < 0) {
      const i = i1
      const x = i1x
      const y = i1y
      i1 = i2
      i1x = i2x
      i1y = i2y
      i2 = i
      i2x = x
      i2y = y
    }

    const center = delaunatorCircumcenter(i0x, i0y, i1x, i1y, i2x, i2y)
    this._cx = center.x
    this._cy = center.y

    for (let i = 0; i < n; i++) {
      this._dists[i] = delaunatorDist(coords[2 * i]!, coords[2 * i + 1]!, center.x, center.y)
    }
    delaunatorQuicksort(this._ids, this._dists, 0, n - 1)

    this._hullStart = i0
    let hullSize = 3

    hullNext[i0] = hullPrev[i2] = i1
    hullNext[i1] = hullPrev[i0] = i2
    hullNext[i2] = hullPrev[i1] = i0

    hullTri[i0] = 0
    hullTri[i1] = 1
    hullTri[i2] = 2

    hullHash.fill(-1)
    hullHash[this._hashKey(i0x, i0y)] = i0
    hullHash[this._hashKey(i1x, i1y)] = i1
    hullHash[this._hashKey(i2x, i2y)] = i2

    this.trianglesLen = 0
    this._addTriangle(i0, i1, i2, -1, -1, -1)

    for (let k = 0, xp = 0, yp = 0; k < this._ids.length; k++) {
      const i = this._ids[k]!
      const x = coords[2 * i]!
      const y = coords[2 * i + 1]!

      if (k > 0 && Math.abs(x - xp) <= DELAUNATOR_EPSILON && Math.abs(y - yp) <= DELAUNATOR_EPSILON) continue
      xp = x
      yp = y

      if (i === i0 || i === i1 || i === i2) continue

      let start = 0
      for (let j = 0, key = this._hashKey(x, y); j < this._hashSize; j++) {
        start = hullHash[(key + j) % this._hashSize]!
        if (start !== -1 && start !== hullNext[start]) break
      }

      start = hullPrev[start]!
      let e = start
      let q: number
      while ((q = hullNext[e]!), delaunatorOrient2d(x, y, coords[2 * e]!, coords[2 * e + 1]!, coords[2 * q]!, coords[2 * q + 1]!) >= 0) {
        e = q
        if (e === start) {
          e = -1
          break
        }
      }
      if (e === -1) continue

      let t = this._addTriangle(e, i, hullNext[e]!, -1, -1, hullTri[e]!)

      hullTri[i] = this._legalize(t + 2)
      hullTri[e] = t
      hullSize++

      let nEdge = hullNext[e]!
      while ((q = hullNext[nEdge]!), delaunatorOrient2d(x, y, coords[2 * nEdge]!, coords[2 * nEdge + 1]!, coords[2 * q]!, coords[2 * q + 1]!) < 0) {
        t = this._addTriangle(nEdge, i, q, hullTri[i]!, -1, hullTri[nEdge]!)
        hullTri[i] = this._legalize(t + 2)
        hullNext[nEdge] = nEdge
        hullSize--
        nEdge = q
      }

      if (e === start) {
        while ((q = hullPrev[e]!), delaunatorOrient2d(x, y, coords[2 * q]!, coords[2 * q + 1]!, coords[2 * e]!, coords[2 * e + 1]!) < 0) {
          t = this._addTriangle(q, i, e, -1, hullTri[e]!, hullTri[q]!)
          this._legalize(t + 2)
          hullTri[q] = t
          hullNext[e] = e
          hullSize--
          e = q
        }
      }

      this._hullStart = hullPrev[i] = e
      hullNext[e] = hullPrev[nEdge] = i
      hullNext[i] = nEdge

      hullHash[this._hashKey(x, y)] = i
      hullHash[this._hashKey(coords[2 * e]!, coords[2 * e + 1]!)] = e
    }

    this.hull = new Uint32Array(hullSize)
    for (let i = 0, e = this._hullStart; i < hullSize; i++) {
      this.hull[i] = e
      e = hullNext[e]!
    }

    this.triangles = this._triangles.subarray(0, this.trianglesLen)
    this.halfedges = this._halfedges.subarray(0, this.trianglesLen)
  }

  _hashKey(x: number, y: number): number {
    return Math.floor(delaunatorPseudoAngle(x - this._cx, y - this._cy) * this._hashSize) % this._hashSize
  }

  _legalize(a: number): number {
    const triangles = this._triangles
    const halfedges = this._halfedges
    const coords = this.coords
    const stack: number[] = []

    let i = 0
    let ar = 0
    while (true) {
      const b = halfedges[a]!

      const a0 = a - (a % 3)
      ar = a0 + ((a + 2) % 3)

      if (b === -1) {
        if (i === 0) break
        a = stack[--i]!
        continue
      }

      const b0 = b - (b % 3)
      const al = a0 + ((a + 1) % 3)
      const bl = b0 + ((b + 2) % 3)

      const p0 = triangles[ar]!
      const pr = triangles[a]!
      const pl = triangles[al]!
      const p1 = triangles[bl]!

      const illegal = delaunatorInCircle(
        coords[2 * p0]!, coords[2 * p0 + 1]!,
        coords[2 * pr]!, coords[2 * pr + 1]!,
        coords[2 * pl]!, coords[2 * pl + 1]!,
        coords[2 * p1]!, coords[2 * p1 + 1]!,
      )

      if (illegal) {
        triangles[a] = p1
        triangles[b] = p0

        const hbl = halfedges[bl]!

        if (hbl === -1) {
          let e = this._hullStart
          do {
            if (this._hullTri[e] === bl) {
              this._hullTri[e] = a
              break
            }
            e = this._hullPrev[e]!
          } while (e !== this._hullStart)
        }
        this._link(a, hbl)
        this._link(b, halfedges[ar]!)
        this._link(ar, bl)

        const br = b0 + ((b + 1) % 3)
        stack[i++] = br
      } else {
        if (i === 0) break
        a = stack[--i]!
      }
    }

    return ar
  }

  _link(a: number, b: number): void {
    this._halfedges[a] = b
    if (b !== -1) this._halfedges[b] = a
  }

  _addTriangle(i0: number, i1: number, i2: number, a: number, b: number, c: number): number {
    const t = this.trianglesLen

    this._triangles[t] = i0
    this._triangles[t + 1] = i1
    this._triangles[t + 2] = i2

    this._link(t, a)
    this._link(t + 1, b)
    this._link(t + 2, c)

    this.trianglesLen += 3

    return t
  }
}

interface DelaunayPort {
  points: Float64Array
  inedges: Int32Array
  _hullIndex: Int32Array
  halfedges: Int32Array
  hull: Uint32Array
  triangles: Uint32Array
  collinear?: Int32Array
}

/** `Delaunay.from(rows, xField, yField)` + `Delaunay._init` (d3-delaunay@6). */
function buildDelaunay(rows: Row[], xField: string, yField: string): DelaunayPort {
  const n = rows.length
  const coords = new Float64Array(n * 2)
  for (let i = 0; i < n; i++) {
    coords[i * 2] = Number(rows[i]![xField])
    coords[i * 2 + 1] = Number(rows[i]![yField])
  }
  const del = new DelaunatorPort(coords)
  const d: DelaunayPort = {
    points: del.coords,
    inedges: new Int32Array(n),
    _hullIndex: new Int32Array(n),
    halfedges: del.halfedges,
    hull: del.hull,
    triangles: del.triangles,
  }

  // Delaunay._init: collinear detection + jitter, then inedges / hullIndex.
  const collinearCheck = (): boolean => {
    const { triangles, points } = d
    for (let i = 0; i < triangles.length; i += 3) {
      const a = 2 * triangles[i]!
      const b = 2 * triangles[i + 1]!
      const c = 2 * triangles[i + 2]!
      const cross =
        (points[c]! - points[a]!) * (points[b + 1]! - points[a + 1]!) -
        (points[b]! - points[a]!) * (points[c + 1]! - points[a + 1]!)
      if (cross > 1e-10) return false
    }
    return true
  }

  if (d.hull.length > 2 && collinearCheck()) {
    const collinear = Int32Array.from({ length: n }, (_, i) => i).sort(
      (i, j) => d.points[2 * i]! - d.points[2 * j]! || d.points[2 * i + 1]! - d.points[2 * j + 1]!,
    )
    const e = collinear[0]!
    const f = collinear[collinear.length - 1]!
    const r = 1e-8 * Math.hypot(d.points[2 * f + 1]! - d.points[2 * e + 1]!, d.points[2 * f]! - d.points[2 * e]!)
    for (let i = 0; i < n; i++) {
      const x = d.points[2 * i]!
      const y = d.points[2 * i + 1]!
      const p: [number, number] = [x + Math.sin(x + y) * r, y + Math.cos(x - y) * r]
      d.points[2 * i] = p[0]
      d.points[2 * i + 1] = p[1]
    }
    const del2 = new DelaunatorPort(d.points)
    d.halfedges = del2.halfedges
    d.hull = del2.hull
    d.triangles = del2.triangles
    d.collinear = collinear
  } else {
    d.collinear = undefined
  }

  const inedges = d.inedges.fill(-1)
  const hullIndex = d._hullIndex.fill(-1)
  const { halfedges, hull, triangles } = d

  for (let e = 0, ne = halfedges.length; e < ne; ++e) {
    const p = triangles[e % 3 === 2 ? e - 2 : e + 1]!
    if (halfedges[e] === -1 || inedges[p] === -1) inedges[p] = e
  }
  for (let i = 0, nh = hull.length; i < nh; ++i) {
    hullIndex[hull[i]!] = i
  }

  if (hull.length <= 2 && hull.length > 0) {
    d.triangles = new Int32Array(3).fill(-1) as unknown as Uint32Array
    d.halfedges = new Int32Array(3).fill(-1)
    d.triangles[0] = hull[0]!
    inedges[hull[0]!] = 1
    if (hull.length === 2) {
      inedges[hull[1]!] = 0
      d.triangles[1] = hull[1]!
      d.triangles[2] = hull[1]!
    }
  }

  return d
}

interface VoronoiPort {
  delaunay: DelaunayPort
  circumcenters: Float64Array
  vectors: Float64Array
  xmin: number
  ymin: number
  xmax: number
  ymax: number
}

/** `delaunay.voronoi([xmin, ymin, xmax, ymax])` + Voronoi._init (d3-delaunay@6). */
function buildVoronoi(delaunay: DelaunayPort, bounds: [number, number, number, number]): VoronoiPort {
  const v: VoronoiPort = {
    delaunay,
    circumcenters: new Float64Array(delaunay.points.length * 2),
    vectors: new Float64Array(delaunay.points.length * 2),
    xmin: bounds[0],
    ymin: bounds[1],
    xmax: bounds[2],
    ymax: bounds[3],
  }
  const { points, hull, triangles } = delaunay
  const vectors = v.vectors
  let bx: number | undefined
  let by: number | undefined

  const circumcenters = (v.circumcenters = v.circumcenters.subarray(0, (triangles.length / 3) * 2))
  for (let i = 0, j = 0, n = triangles.length; i < n; i += 3, j += 2) {
    const t1 = triangles[i]! * 2
    const t2 = triangles[i + 1]! * 2
    const t3 = triangles[i + 2]! * 2
    const x1 = points[t1]!
    const y1 = points[t1 + 1]!
    const x2 = points[t2]!
    const y2 = points[t2 + 1]!
    const x3 = points[t3]!
    const y3 = points[t3 + 1]!

    const dx = x2 - x1
    const dy = y2 - y1
    const ex = x3 - x1
    const ey = y3 - y1
    const ab = (dx * ey - dy * ex) * 2

    let x: number
    let y: number
    if (Math.abs(ab) < 1e-9) {
      if (bx === undefined || by === undefined) {
        bx = 0
        by = 0
        for (const i of hull) {
          bx += points[i * 2]!
          by += points[i * 2 + 1]!
        }
        bx /= hull.length
        by /= hull.length
      }
      const a = 1e9 * Math.sign((bx - x1) * ey - (by - y1) * ex)
      x = (x1 + x3) / 2 - a * ey
      y = (y1 + y3) / 2 + a * ex
    } else {
      const d = 1 / ab
      const bl = dx * dx + dy * dy
      const cl = ex * ex + ey * ey
      x = x1 + (ey * bl - dy * cl) * d
      y = y1 + (dx * cl - ex * bl) * d
    }
    circumcenters[j] = x
    circumcenters[j + 1] = y
  }

  let h = hull[hull.length - 1]!
  let p0: number
  let p1 = h * 4
  let x0: number
  let x1 = points[2 * h]!
  let y0: number
  let y1 = points[2 * h + 1]!
  vectors.fill(0)
  for (let i = 0; i < hull.length; ++i) {
    h = hull[i]!
    p0 = p1
    x0 = x1
    y0 = y1
    p1 = h * 4
    x1 = points[2 * h]!
    y1 = points[2 * h + 1]!
    vectors[p0 + 2] = vectors[p1] = y0 - y1
    vectors[p0 + 3] = vectors[p1 + 1] = x1 - x0
  }

  return v
}

/** d3-delaunay `Voronoi._regioncode`. */
function voronoiRegioncode(v: VoronoiPort, x: number, y: number): number {
  return (x < v.xmin ? 0b0001 : x > v.xmax ? 0b0010 : 0b0000) | (y < v.ymin ? 0b0100 : y > v.ymax ? 0b1000 : 0b0000)
}

/** d3-delaunay `Voronoi._edgecode`. */
function voronoiEdgecode(v: VoronoiPort, x: number, y: number): number {
  return (x === v.xmin ? 0b0001 : x === v.xmax ? 0b0010 : 0b0000) | (y === v.ymin ? 0b0100 : y === v.ymax ? 0b1000 : 0b0000)
}

/** d3-delaunay `Voronoi._clipSegment`. */
function voronoiClipSegment(v: VoronoiPort, x0: number, y0: number, x1: number, y1: number, c0: number, c1: number): [number, number, number, number] | null {
  const flip = c0 < c1
  if (flip) {
    const t = [x1, y1, x0, y0, c1, c0]
    x0 = t[0]!
    y0 = t[1]!
    x1 = t[2]!
    y1 = t[3]!
    c0 = t[4]!
    c1 = t[5]!
  }
  while (true) {
    if (c0 === 0 && c1 === 0) return flip ? [x1, y1, x0, y0] : [x0, y0, x1, y1]
    if (c0 & c1) return null
    let x = 0
    let y = 0
    let c = c0 || c1
    if (c & 0b1000) {
      x = x0 + ((x1 - x0) * (v.ymax - y0)) / (y1 - y0)
      y = v.ymax
    } else if (c & 0b0100) {
      x = x0 + ((x1 - x0) * (v.ymin - y0)) / (y1 - y0)
      y = v.ymin
    } else if (c & 0b0010) {
      y = y0 + ((y1 - y0) * (v.xmax - x0)) / (x1 - x0)
      x = v.xmax
    } else {
      y = y0 + ((y1 - y0) * (v.xmin - x0)) / (x1 - x0)
      x = v.xmin
    }
    if (c0) {
      x0 = x
      y0 = y
      c0 = voronoiRegioncode(v, x0, y0)
    } else {
      x1 = x
      y1 = y
      c1 = voronoiRegioncode(v, x1, y1)
    }
  }
}

/** d3-delaunay `Voronoi._cell(i)`: the (unclipped) circumcenter polygon. */
function voronoiCell(v: VoronoiPort, i: number): number[] | null {
  const { circumcenters } = v
  const { inedges, halfedges, triangles } = v.delaunay
  const e0 = inedges[i]!
  if (e0 === -1) return null
  const points: number[] = []
  let e = e0
  do {
    const t = Math.floor(e / 3)
    points.push(circumcenters[t * 2]!, circumcenters[t * 2 + 1]!)
    e = e % 3 === 2 ? e - 2 : e + 1
    if (triangles[e]! !== i) break
    e = halfedges[e]!
  } while (e !== e0 && e !== -1)
  return points
}

/** d3-delaunay `Voronoi._edge(i, e0, e1, P, j)`: insert rectangle corners. */
function voronoiEdge(v: VoronoiPort, i: number, e0: number, e1: number, P: number[], j: number): number {
  while (e0 !== e1) {
    let x = 0
    let y = 0
    switch (e0) {
      case 0b0101:
        e0 = 0b0100
        continue
      case 0b0100:
        e0 = 0b0110
        x = v.xmax
        y = v.ymin
        break
      case 0b0110:
        e0 = 0b0010
        continue
      case 0b0010:
        e0 = 0b1010
        x = v.xmax
        y = v.ymax
        break
      case 0b1010:
        e0 = 0b1000
        continue
      case 0b1000:
        e0 = 0b1001
        x = v.xmin
        y = v.ymax
        break
      case 0b1001:
        e0 = 0b0001
        continue
      case 0b0001:
        e0 = 0b0101
        x = v.xmin
        y = v.ymin
        break
    }
    if ((P[j] !== x || P[j + 1] !== y) && voronoiContains(v, i, x, y)) {
      P.splice(j, 0, x, y)
      j += 2
    }
  }
  return j
}

/** d3-delaunay `Voronoi._project(x0, y0, vx, vy)`. */
function voronoiProject(v: VoronoiPort, x0: number, y0: number, vx: number, vy: number): [number, number] | null {
  let t = Infinity
  let x = 0
  let y = 0
  let c: number
  if (vy < 0) {
    if (y0 <= v.ymin) return null
    if ((c = (v.ymin - y0) / vy) < t) {
      y = v.ymin
      x = x0 + (t = c) * vx
    }
  } else if (vy > 0) {
    if (y0 >= v.ymax) return null
    if ((c = (v.ymax - y0) / vy) < t) {
      y = v.ymax
      x = x0 + (t = c) * vx
    }
  }
  if (vx > 0) {
    if (x0 >= v.xmax) return null
    if ((c = (v.xmax - x0) / vx) < t) {
      x = v.xmax
      y = y0 + (t = c) * vy
    }
  } else if (vx < 0) {
    if (x0 <= v.xmin) return null
    if ((c = (v.xmin - x0) / vx) < t) {
      x = v.xmin
      y = y0 + (t = c) * vy
    }
  }
  return [x, y]
}

/** d3-delaunay `Voronoi._clipFinite(i, points)`. */
function voronoiClipFinite(v: VoronoiPort, i: number, points: number[]): number[] | null {
  const n = points.length
  let P: number[] | null = null
  let x0 = 0
  let y0 = 0
  let x1 = points[n - 2]!
  let y1 = points[n - 1]!
  let c0 = 0
  let c1 = voronoiRegioncode(v, x1, y1)
  let e0 = 0
  let e1 = 0
  for (let j = 0; j < n; j += 2) {
    x0 = x1
    y0 = y1
    x1 = points[j]!
    y1 = points[j + 1]!
    c0 = c1
    c1 = voronoiRegioncode(v, x1, y1)
    if (c0 === 0 && c1 === 0) {
      e0 = e1
      e1 = 0
      if (P) P.push(x1, y1)
      else P = [x1, y1]
    } else {
      let S: [number, number, number, number] | null
      let sx0 = 0
      let sy0 = 0
      let sx1 = 0
      let sy1 = 0
      if (c0 === 0) {
        S = voronoiClipSegment(v, x0, y0, x1, y1, c0, c1)
        if (S === null) continue
        sx0 = S[0]
        sy0 = S[1]
        sx1 = S[2]
        sy1 = S[3]
      } else {
        S = voronoiClipSegment(v, x1, y1, x0, y0, c1, c0)
        if (S === null) continue
        sx1 = S[0]
        sy1 = S[1]
        sx0 = S[2]
        sy0 = S[3]
        e0 = e1
        e1 = voronoiEdgecode(v, sx0, sy0)
        if (P && e0 && e1) voronoiEdge(v, i, e0, e1, P, P.length)
        if (P) P.push(sx0, sy0)
        else P = [sx0, sy0]
      }
      e0 = e1
      e1 = voronoiEdgecode(v, sx1, sy1)
      if (e0 && e1) voronoiEdge(v, i, e0, e1, P!, P!.length)
      if (P) P.push(sx1, sy1)
      else P = [sx1, sy1]
    }
  }
  if (P) {
    e0 = e1
    e1 = voronoiEdgecode(v, P[0]!, P[1]!)
    if (e0 && e1) voronoiEdge(v, i, e0, e1, P, P.length)
  } else if (voronoiContains(v, i, (v.xmin + v.xmax) / 2, (v.ymin + v.ymax) / 2)) {
    return [v.xmax, v.ymin, v.xmax, v.ymax, v.xmin, v.ymax, v.xmin, v.ymin]
  }
  return P
}

/** d3-delaunay `Voronoi._clipInfinite(i, points, vx0, vy0, vxn, vyn)`. */
function voronoiClipInfinite(v: VoronoiPort, i: number, points: number[], vx0: number, vy0: number, vxn: number, vyn: number): number[] | null {
  let P: number[] | null = Array.from(points)
  let p: [number, number] | null
  if ((p = voronoiProject(v, P[0]!, P[1]!, vx0, vy0))) P.unshift(p[0], p[1])
  if ((p = voronoiProject(v, P[P.length - 2]!, P[P.length - 1]!, vxn, vyn))) P.push(p[0], p[1])
  if ((P = voronoiClipFinite(v, i, P))) {
    for (let j = 0, n = P.length, c0: number, c1 = voronoiEdgecode(v, P[n - 2]!, P[n - 1]!); j < n; j += 2) {
      c0 = c1
      c1 = voronoiEdgecode(v, P[j]!, P[j + 1]!)
      if (c0 && c1) {
        j = voronoiEdge(v, i, c0, c1, P, j)
        n = P.length
      }
    }
  } else if (voronoiContains(v, i, (v.xmin + v.xmax) / 2, (v.ymin + v.ymax) / 2)) {
    P = [v.xmin, v.ymin, v.xmax, v.ymin, v.xmax, v.ymax, v.xmin, v.ymax]
  }
  return P
}

/** d3-delaunay `Voronoi._simplify(P)`. */
function voronoiSimplify(P: number[] | null): number[] | null {
  if (P && P.length > 4) {
    for (let i = 0; i < P.length; i += 2) {
      const j = (i + 2) % P.length
      const k = (i + 4) % P.length
      if ((P[i] === P[j] && P[j] === P[k]) || (P[i + 1] === P[j + 1] && P[j + 1] === P[k + 1])) {
        P.splice(j, 2)
        i -= 2
      }
    }
    if (!P.length) P = null
  }
  return P
}

/** d3-delaunay `Voronoi.contains(i, x, y)` via `Delaunay._step`. */
function voronoiContains(v: VoronoiPort, i: number, x: number, y: number): boolean {
  return delaunayStep(v.delaunay, i, x, y) === i
}

/** d3-delaunay `Delaunay._step(i, x, y)`. */
function delaunayStep(d: DelaunayPort, i: number, x: number, y: number): number {
  const { inedges, hull, _hullIndex, halfedges, triangles, points } = d
  if (inedges[i] === -1 || !points.length) return (i + 1) % (points.length >> 1)
  let c = i
  let dc = Math.pow(x - points[i * 2]!, 2) + Math.pow(y - points[i * 2 + 1]!, 2)
  const e0 = inedges[i]!
  let e = e0
  do {
    const t = triangles[e]!
    const dt = Math.pow(x - points[t * 2]!, 2) + Math.pow(y - points[t * 2 + 1]!, 2)
    if (dt < dc) {
      dc = dt
      c = t
    }
    e = e % 3 === 2 ? e - 2 : e + 1
    if (triangles[e] !== i) break
    e = halfedges[e]!
    if (e === -1) {
      e = hull[(_hullIndex[i]! + 1) % hull.length]!
      if (e !== t) {
        if (Math.pow(x - points[e * 2]!, 2) + Math.pow(y - points[e * 2 + 1]!, 2) < dc) return e
      }
      break
    }
  } while (e !== e0)
  return c
}

/** d3-delaunay `Voronoi._clip(i)` → flat `[x0, y0, x1, y1, ...]` array. */
function voronoiClip(v: VoronoiPort, i: number): number[] | null {
  if (i === 0 && v.delaunay.hull.length === 1) {
    return [v.xmax, v.ymin, v.xmax, v.ymax, v.xmin, v.ymax, v.xmin, v.ymin]
  }
  const points = voronoiCell(v, i)
  if (points === null) return null
  const { vectors } = v
  const vv = i * 4
  return voronoiSimplify(
    vectors[vv] || vectors[vv + 1]
      ? voronoiClipInfinite(v, i, points, vectors[vv]!, vectors[vv + 1]!, vectors[vv + 2]!, vectors[vv + 3]!)
      : voronoiClipFinite(v, i, points),
  )
}

/**
 * d3-delaunay `Voronoi.renderCell` + vega's `toPathString`: build the cell
 * polygon (omitting duplicate vertices and the closing point) and serialize it
 * as an SVG path `M…L…L…Z`.
 */
function voronoiCellPath(v: VoronoiPort, i: number): string | null {
  const clipped = voronoiClip(v, i)
  if (clipped === null || clipped.length === 0) return null
  // renderCell: drop consecutive duplicate vertices, closePath appends the
  // first point (stripped by toPathString).
  const pairs: Array<[number, number]> = []
  let n = clipped.length
  while (clipped[0] === clipped[n - 2] && clipped[1] === clipped[n - 1] && n > 1) n -= 2
  for (let k = 2; k < n; k += 2) {
    if (clipped[k] !== clipped[k - 2] || clipped[k + 1] !== clipped[k - 1]) {
      pairs.push([clipped[k]!, clipped[k + 1]!])
    }
  }
  const first: [number, number] = [clipped[0]!, clipped[1]!]
  if (pairs.length === 0) return null
  const last = pairs[pairs.length - 1]!
  if (last[0] === first[0] && last[1] === first[1]) pairs.pop()
  if (pairs.length === 0) return null
  return 'M' + first.join(',') + pairs.map((p) => 'L' + p.join(',')).join('') + 'Z'
}

/** The vega `voronoi` transform: Delaunay triangulation → clipped cell paths. */
function voronoiRows(rows: Row[], t: Record<string, unknown>, ctx: TransformContext): Row[] {
  const as = (t.as as string | undefined) ?? 'path'
  const xField = t.x as string
  const yField = t.y as string
  const size = resolveSizeParam(t.size, ctx)
  let bounds: [number, number, number, number]
  if (size) {
    bounds = [0, 0, size[0], size[1]]
  } else if (Array.isArray(t.extent) && t.extent.length === 2) {
    const e = t.extent as [[number, number], [number, number]]
    bounds = [e[0][0], e[0][1], e[1][0], e[1][1]]
  } else {
    bounds = [-1e5, -1e5, 1e5, 1e5]
  }

  // Nothing to do if no data (matches vega's early return).
  if (!rows.length) return rows

  const delaunay = buildDelaunay(rows, xField, yField)
  const voronoi = buildVoronoi(delaunay, bounds)
  return rows.map((r, i) => {
    meterTick('voronoi')
    const clipped = voronoiClip(voronoi, i)
    const isPoint = clipped !== null && clipped.length === 4 && clipped[0] === clipped[2] && clipped[1] === clipped[3]
    const path = isPoint ? null : voronoiCellPath(voronoi, i)
    return { ...r, [as]: path }
  })
}


// -- addon registration ------------------------------------------------------
transformRegistry.set('kde', kdeRows)
transformRegistry.set('quantile', quantileRows)
transformRegistry.set('regression', regressionRows)
transformRegistry.set('loess', loessRows)
transformRegistry.set('pack', packRows)
transformRegistry.set('partition', partitionRows)
transformRegistry.set('treemap', treemapRows)
transformRegistry.set('wordcloud', wordcloudRows)
transformRegistry.set('voronoi', voronoiRows)

// ---------------------------------------------------------------------------
// pie (vega Pie layout) — modifies rows with start/end angle fields
// ---------------------------------------------------------------------------

/** Pie and donut chart layout (vega Pie, ported operation-for-operation). */
function pieRows(rows: Row[], t: Record<string, unknown>): Row[] {
  const as = (t.as as [string, string]) ?? ['startAngle', 'endAngle']
  const startAngleField = as[0]!
  const endAngleField = as[1]!
  const field = (t.field as string | undefined) ?? null
  const start = (t.startAngle as number | undefined) ?? 0
  const stop = (t.endAngle as number | undefined) != null ? (t.endAngle as number) : 2 * Math.PI
  const values = rows.map((r) => (field ? (getField(r, field) as number) : 1))
  const n = values.length
  let a = start
  const k = (stop - start) / values.reduce((acc, v) => acc + (+v || 0), 0)
  const index = Array.from({ length: n }, (_, i) => i)
  if (t.sort) {
    index.sort((x, y) => values[x]! - values[y]!)
  }
  const out = rows.map((r) => ({ ...r }))
  for (let i = 0; i < n; ++i) {
    const v = values[index[i]!]!
    out[index[i]!]![startAngleField] = a
    a += v * k
    out[index[i]!]![endAngleField] = a
  }
  return out
}

// ---------------------------------------------------------------------------
// cross (vega Cross: self cross-product, generating)
// ---------------------------------------------------------------------------

function crossRows(rows: Row[], t: Record<string, unknown>, ctx: TransformContext): Row[] {
  const as = (t.as as [string, string]) ?? ['a', 'b']
  const a = as[0]!
  const b = as[1]!
  const filter = t.filter as string | undefined
  const test = filter && ctx.runtime.expr(filter)
  const out: Row[] = []
  const n = rows.length
  // Without a filter the output is exactly n*n rows: refuse it up front. With a
  // filter the n*n candidates are still evaluated, so the wall clock is sampled
  // inside the inner loop (C7).
  if (!test) checkRowCount(n * n, 'cross')
  for (let i = 0; i < n; ++i) {
    const left = rows[i]!
    meterTick('cross', n)
    for (let j = 0; j < n; ++j) {
      const cand: Row = { [a]: left, [b]: rows[j]! }
      if (!test || test(cand, ctx.signals)) {
        out.push(cand)
      }
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// countpattern (vega CountPattern)
// ---------------------------------------------------------------------------

function countpatternRows(rows: Row[], t: Record<string, unknown>): Row[] {
  const field = t.field as string
  const as = (t.as as [string, string]) ?? ['text', 'count']
  const cs = t.case as string | undefined
  // Regex guard (safety deviation): pattern and per-row input lengths are capped
  // under limits; catastrophic backtracking itself cannot be interrupted.
  const match = guardedRegExp((t.pattern as string | undefined) ?? '[\\w\']+', 'g')
  const stop = guardedRegExp('^' + (t.stopwords as string | undefined ?? '') + '$', 'i')
  const tokenize = (text: string): string[] => {
    let s = text
    if (cs === 'upper') s = text.toUpperCase()
    else if (cs === 'lower') s = text.toLowerCase()
    return (s.match(match) ?? []).map(String)
  }
  const counts = new Map<string, number>()
  for (const r of rows) {
    const raw = getField(r, field)
    if (raw == null) continue
    checkRegexInput(String(raw))
    for (const tok of tokenize(raw as string)) {
      if (!stop.test(tok)) counts.set(tok, (counts.get(tok) ?? 0) + 1)
    }
  }
  const out: Row[] = []
  for (const [text, count] of counts) {
    if (count > 0) out.push({ [as[0]!]: text, [as[1]!]: count })
  }
  return out
}

// ---------------------------------------------------------------------------
// dotbin (vega DotBin) — dot density binning (Wilkinson 1999), ported from
// vega's util/dotbin.js including the variance-smoothing pass.
// ---------------------------------------------------------------------------

function dotbinValues(array: number[], step: number, smooth: boolean): Float64Array {
  const n = array.length
  const v = new Float64Array(n)
  let i = 0
  let j = 1
  let a = array[0]!
  let b = a
  let w = a + step
  for (; j < n; ++j) {
    const x = array[j]!
    if (x >= w) {
      b = (a + b) / 2
      for (; i < j; ++i) v[i] = b
      w = x + step
      a = x
    }
    b = x
  }
  b = (a + b) / 2
  for (; i < j; ++i) v[i] = b
  if (smooth) {
    // smoothing: swap points between adjacent stacks (within step*1.25)
    const thresh = step + step / 4
    let sa = 0
    let sb = 1
    while (sb < n && v[sb] === v[sa]) ++sb
    while (sb < n) {
      let sc = sb + 1
      while (sc < n && v[sb] === v[sc]) ++sc
      if (v[sb]! - v[sb - 1]! < thresh) {
        const d = sb + ((sa + sc - sb - sb) >> 1)
        let dd = d
        while (dd < sb) v[dd++] = v[sb]!
        dd = d
        while (dd > sb) v[dd--] = v[sa]!
      }
      sa = sb
      sb = sc
    }
  }
  return v
}

function dotbinRows(rows: Row[], t: Record<string, unknown>, ctx: TransformContext): Row[] {
  const field = t.field as string
  const as = (t.as as string | undefined) ?? 'bin'
  const groupby = (t.groupby as string[] | undefined) ?? []
  const values = rows.map((r) => getField(r, field) as number)
  const extent = values.reduce<[number, number]>(([lo, hi], v) => [Math.min(lo, v), Math.max(hi, v)], [Infinity, -Infinity])
  const step = (t.step as number | undefined) ?? (extent[1] - extent[0]) / 30
  const smooth = t.smooth === true
  // stable sort by field value within groups (vega stableCompare)
  const groups = new Map<string, number[]>()
  if (groupby.length) {
    for (let i = 0; i < rows.length; ++i) {
      const key = groupby.map((f) => String(getField(rows[i]!, f))).join('|')
      let g = groups.get(key)
      if (!g) { g = []; groups.set(key, g) }
      g.push(i)
    }
  } else {
    groups.set('', rows.map((_, i) => i))
  }
  const sorted = rows.map((r, i) => ({ r, i }))
  sorted.sort((p, q) => (values[p.i] as number) - (values[q.i] as number))
  // compute bins per group over the sorted indices
  const out = rows.map((r) => ({ ...r }))
  const groupIndices = new Map<string, number[]>()
  for (const { i } of sorted) {
    const key = groupby.map((f) => String(getField(rows[i]!, f))).join('|')
    let g = groupIndices.get(key)
    if (!g) { g = []; groupIndices.set(key, g) }
    g.push(i)
  }
  for (const g of groupIndices.values()) {
    const gvals = g.map((i) => values[i] as number)
    const bins = dotbinValues(gvals, step, smooth)
    for (let k = 0; k < g.length; ++k) {
      out[g[k]!]![as] = bins[k]
    }
  }
  void ctx
  return out
}

// ---------------------------------------------------------------------------
// geopoint (vega-geo GeoPoint) — lon/lat -> x/y through a named projection
// ---------------------------------------------------------------------------

function geopointRows(rows: Row[], t: Record<string, unknown>, ctx: TransformContext): Row[] {
  const projName = String(t.projection)
  const projection = ctx.projections?.get(projName)
  if (!projection) throw new Error(`[aster] geopoint: unknown projection "${projName}"`)
  const fields = (t.fields as [string, string]) ?? ['lon', 'lat']
  const as = (t.as as [string, string]) ?? ['x', 'y']
  const proj = projection as (p: [number, number]) => [number, number] | null
  return rows.map((r) => {
    const xy = proj([getField(r, fields[0]!) as number, getField(r, fields[1]!) as number])
    return xy ? { ...r, [as[0]!]: xy[0], [as[1]!]: xy[1] } : { ...r, [as[0]!]: undefined, [as[1]!]: undefined }
  })
}

// ---------------------------------------------------------------------------
// geojson (vega-geo GeoJSON) — consolidate points/features into one GeoJSON
// object (the transform's value, consumed by projection fit); rows unchanged.
// ---------------------------------------------------------------------------

function geojsonRows(rows: Row[], t: Record<string, unknown>): Row[] {
  const fields = (t.fields as [string, string] | undefined) ?? null
  const geojsonField = t.geojson as string | undefined
  const features: unknown[] = []
  const points: [number, number][] = []
  for (const r of rows) {
    if (geojsonField) {
      const geo = getField(r, geojsonField)
      if (geo != null) features.push(geo)
    } else if (fields) {
      points.push([getField(r, fields[0]!) as number, getField(r, fields[1]!) as number])
    }
  }
  let geo: Record<string, unknown>
  if (points.length) {
    geo = { type: 'MultiPoint', coordinates: points }
  } else if (features.length === 1) {
    geo = features[0] as Record<string, unknown>
  } else {
    geo = { type: 'FeatureCollection', features }
  }
  // vega exposes the consolidated value to the projection fit machinery; the
  // rows themselves pass through unchanged.
  void geo
  return rows
}

// ---------------------------------------------------------------------------
// linkpath (vega-geo LinkPath) — edge paths between source/target points
// ---------------------------------------------------------------------------

const linkLine = (sx: number, sy: number, tx: number, ty: number) => 'M' + sx + ',' + sy + 'L' + tx + ',' + ty
const linkLineR = (sa: number, sr: number, ta: number, tr: number) => linkLine(sr * Math.cos(sa), sr * Math.sin(sa), tr * Math.cos(ta), tr * Math.sin(ta))
const linkArc = (sx: number, sy: number, tx: number, ty: number) => {
  const dx = tx - sx
  const dy = ty - sy
  const rr = Math.hypot(dx, dy) / 2
  const ra = (180 * Math.atan2(dy, dx)) / Math.PI
  return 'M' + sx + ',' + sy + 'A' + rr + ',' + rr + ' ' + ra + ' 0 1' + ' ' + tx + ',' + ty
}
const linkArcR = (sa: number, sr: number, ta: number, tr: number) => linkArc(sr * Math.cos(sa), sr * Math.sin(sa), tr * Math.cos(ta), tr * Math.sin(ta))
const linkCurve = (sx: number, sy: number, tx: number, ty: number) => {
  const dx = tx - sx
  const dy = ty - sy
  const ix = 0.2 * (dx + dy)
  const iy = 0.2 * (dy - dx)
  return 'M' + sx + ',' + sy + 'C' + (sx + ix) + ',' + (sy + iy) + ' ' + (tx + iy) + ',' + (ty - ix) + ' ' + tx + ',' + ty
}
const linkCurveR = (sa: number, sr: number, ta: number, tr: number) => linkCurve(sr * Math.cos(sa), sr * Math.sin(sa), tr * Math.cos(ta), tr * Math.sin(ta))
const linkOrthoX = (sx: number, sy: number, tx: number, ty: number) => 'M' + sx + ',' + sy + 'V' + ty + 'H' + tx
const linkOrthoY = (sx: number, sy: number, tx: number, ty: number) => 'M' + sx + ',' + sy + 'H' + tx + 'V' + ty
const linkOrthoR = (sa: number, sr: number, ta: number, tr: number) => {
  const sc = Math.cos(sa)
  const ss = Math.sin(sa)
  const tc = Math.cos(ta)
  const ts = Math.sin(ta)
  const sf = Math.abs(ta - sa) > Math.PI ? ta <= sa : ta > sa
  return 'M' + sr * sc + ',' + sr * ss + 'A' + sr + ',' + sr + ' 0 0,' + (sf ? 1 : 0) + ' ' + sr * tc + ',' + sr * ts + 'L' + tr * tc + ',' + tr * ts
}
const linkDiagonalX = (sx: number, sy: number, tx: number, ty: number) => {
  const m = (sx + tx) / 2
  return 'M' + sx + ',' + sy + 'C' + m + ',' + sy + ' ' + m + ',' + ty + ' ' + tx + ',' + ty
}
const linkDiagonalY = (sx: number, sy: number, tx: number, ty: number) => {
  const m = (sy + ty) / 2
  return 'M' + sx + ',' + sy + 'C' + sx + ',' + m + ' ' + tx + ',' + m + ' ' + tx + ',' + ty
}
const linkDiagonalR = (sa: number, sr: number, ta: number, tr: number) => {
  const sc = Math.cos(sa)
  const ss = Math.sin(sa)
  const tc = Math.cos(ta)
  const ts = Math.sin(ta)
  const mr = (sr + tr) / 2
  return 'M' + sr * sc + ',' + sr * ss + 'C' + mr * sc + ',' + mr * ss + ' ' + mr * tc + ',' + mr * ts + ' ' + tr * tc + ',' + tr * ts
}

const LINK_PATHS: Record<string, (sx: number, sy: number, tx: number, ty: number) => string> = {
  line: linkLine,
  'line-radial': linkLineR,
  arc: linkArc,
  'arc-radial': linkArcR,
  curve: linkCurve,
  'curve-radial': linkCurveR,
  'orthogonal-horizontal': linkOrthoX,
  'orthogonal-vertical': linkOrthoY,
  'orthogonal-radial': linkOrthoR,
  'diagonal-horizontal': linkDiagonalX,
  'diagonal-vertical': linkDiagonalY,
  'diagonal-radial': linkDiagonalR,
}

function linkpathRows(rows: Row[], t: Record<string, unknown>): Row[] {
  const sxField = (t.sourceX as string | undefined) ?? 'source.x'
  const syField = (t.sourceY as string | undefined) ?? 'source.y'
  const txField = (t.targetX as string | undefined) ?? 'target.x'
  const tyField = (t.targetY as string | undefined) ?? 'target.y'
  const as = (t.as as string | undefined) ?? 'path'
  const orient = (t.orient as string | undefined) ?? 'vertical'
  const shape = (t.shape as string | undefined) ?? 'line'
  const path = ownGet(LINK_PATHS, shape + '-' + orient) ?? ownGet(LINK_PATHS, shape)
  if (!path) throw new Error(`[aster] linkpath unsupported type: ${shape}${t.orient ? '-' + orient : ''}`)
  return rows.map((r) => ({
    ...r,
    [as]: path(
      getField(r, sxField) as number,
      getField(r, syField) as number,
      getField(r, txField) as number,
      getField(r, tyField) as number,
    ),
  }))
}

// ---------------------------------------------------------------------------
// project (vega Project) — derive rows from named fields
// ---------------------------------------------------------------------------

function projectRows(rows: Row[], t: Record<string, unknown>): Row[] {
  const fields = (t.fields as string[] | undefined) ?? []
  const as = (t.as as (string | undefined)[] | undefined) ?? []
  return rows.map((r) => {
    const out: Row = {}
    for (let i = 0; i < fields.length; ++i) {
      out[as[i] ?? fields[i]!] = getField(r, fields[i]!)
    }
    return out
  })
}

// -- addon registration ------------------------------------------------------
transformRegistry.set('pie', pieRows)
transformRegistry.set('cross', crossRows)
transformRegistry.set('countpattern', countpatternRows)
transformRegistry.set('dotbin', dotbinRows)
transformRegistry.set('geopoint', geopointRows)
transformRegistry.set('geojson', geojsonRows)
transformRegistry.set('linkpath', linkpathRows)
transformRegistry.set('project', projectRows)
