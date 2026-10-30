/**
 * Curve fitting for the `regression` and `loess` transforms, and the adaptive sampling that draws a fitted or analytic curve.
 *
 *  - `FITS`: least-squares models (constant, linear, logarithmic, exponential, power, quadratic, polynomial), each a pair of
 *    coefficient list and predictor over the valid points of a group;
 *  - `loessSmooth`: locally weighted linear smoothing with robustness iterations;
 *  - `sampleCurve`: points on a function of x, denser where it bends.
 *
 * What the numbers must reproduce, and so what is fixed here: every sum is a RUNNING MEAN (`m += (v - m) / n`, not a total
 * divided at the end), the polynomial fits work on data centred on its mean, the elimination picks its pivots by magnitude and
 * the weighted sums of the smoother run in window order. Those orders decide the last bits of the coefficients and of every
 * point drawn from them. Everything else -- how the points are held, how the fits are organised -- is this module's own.
 *
 * Derived work: the loess smoother follows the local-regression algorithm of Jason Davies' science.js, the polynomial fit the
 * normal-equation method of d3-regression / regression-js (BSD-3-Clause; the notices are in THIRD_PARTY_NOTICES.md).
 */
import { checkRowCount, meterTick } from './limits.js'
import { sortData } from './util.js'
import type { Row } from './transform-agg.js'

type Get = (d: unknown) => unknown
type Pt = [number, number]

/** A fitted model: its coefficients (intercept first), the function it describes, and R-squared on demand. */
export interface Fit { coef: number[]; predict: (x: number) => number; rSquared: () => number }

// --- the points of a group ----------------------------------------------------------------------------------------------

/** The points of a group with a numeric x AND y, as parallel arrays in row order (a missing, null or NaN coordinate drops the row). */
interface Points { xs: Float64Array; ys: Float64Array }

function validPoints(rows: Row[], x: Get, y: Get, sorted = false): Points {
  const xs = new Float64Array(rows.length)
  const ys = new Float64Array(rows.length)
  let n = 0
  for (let r = 0; r < rows.length; r++) {
    const d = rows[r]!
    let u: unknown = x(d)
    let v: unknown = y(d)
    if (u != null && (u = +(u as number)) >= (u as number) && v != null && (v = +(v as number)) >= (v as number)) {
      xs[n] = u as number
      ys[n] = v as number
      n++
    }
  }
  if (!sorted) return { xs: xs.subarray(0, n), ys: ys.subarray(0, n) }
  // by x, ties staying in row order; two infinite xs of one sign compare as NaN, so the order is the builtin sort's own (sortData)
  const order = sortData(Array.from({ length: n }, (_, i) => i), (a, b) => xs[a]! - xs[b]!)
  return { xs: Float64Array.from(order, (i) => xs[i]!), ys: Float64Array.from(order, (i) => ys[i]!) }
}

/** The mean of the values as a running mean: the form in which every mean of the fits is accumulated. */
function runningMean(values: ArrayLike<number>): number {
  let mean = 0
  for (let i = 0; i < values.length; i++) mean += (values[i]! - mean) / (i + 1)
  return mean
}

/** The points moved to their means: `(x - meanX, y - meanY)`, and the means. */
function centred(p: Points): { xs: Float64Array; ys: Float64Array; meanX: number; meanY: number } {
  const meanX = runningMean(p.xs)
  const meanY = runningMean(p.ys)
  const xs = new Float64Array(p.xs.length)
  const ys = new Float64Array(p.ys.length)
  for (let i = 0; i < xs.length; i++) {
    xs[i] = p.xs[i]! - meanX
    ys[i] = p.ys[i]! - meanY
  }
  return { xs, ys, meanX, meanY }
}

// --- least squares ---------------------------------------------------------------------------------------------------

/** Intercept and slope from the means of u, v, u*v and u*u. A (near) zero variance of u gives a flat line. */
function lineFromMeans(meanU: number, meanV: number, meanUV: number, meanUU: number): [intercept: number, slope: number] {
  const variance = meanUU - meanU * meanU
  const slope = Math.abs(variance) < 1e-24 ? 0 : (meanUV - meanU * meanV) / variance
  return [meanV - slope * meanU, slope]
}

/** The least-squares line of v on u (the running means of u, v, u*v and u*u, then {@link lineFromMeans}). */
function lineThrough(us: ArrayLike<number>, vs: ArrayLike<number>): [number, number] {
  let mu = 0
  let mv = 0
  let muv = 0
  let muu = 0
  for (let i = 0; i < us.length; i++) {
    const u = us[i]!
    const v = vs[i]!
    const n = i + 1
    mu += (u - mu) / n
    mv += (v - mv) / n
    muv += (u * v - muv) / n
    muu += (u * u - muu) / n
  }
  return lineFromMeans(mu, mv, muv, muu)
}

/** 1 - SSE / SST of a predictor over the points, against `meanY`. */
function determination(p: Points, meanY: number, predict: (x: number) => number): number {
  let sse = 0
  let sst = 0
  for (let i = 0; i < p.xs.length; i++) {
    const residual = p.ys[i]! - predict(p.xs[i]!)
    const spread = p.ys[i]! - meanY
    sse += residual * residual
    sst += spread * spread
  }
  return 1 - sse / sst
}

const mapLog = (values: Float64Array): Float64Array => values.map(Math.log)

function constantFit(rows: Row[], x: Get, y: Get): Fit {
  // the one fit with its own idea of a valid row: x only has to be present, y not NaN once coerced
  let mean = 0
  let n = 0
  for (const d of rows) {
    const value = y(d) as number
    if (x(d) == null || value == null || isNaN(value)) continue
    mean += (value - mean) / ++n
  }
  return { coef: [mean], predict: () => mean, rSquared: () => 0 }
}

function linearFit(rows: Row[], x: Get, y: Get): Fit {
  const p = validPoints(rows, x, y)
  const coef = lineThrough(p.xs, p.ys)
  const predict = (v: number): number => coef[0] + coef[1] * v
  return { coef, predict, rSquared: () => determination(p, runningMean(p.ys), predict) }
}

function logarithmicFit(rows: Row[], x: Get, y: Get): Fit {
  const p = validPoints(rows, x, y)
  const coef = lineThrough(mapLog(p.xs), p.ys)
  const predict = (v: number): number => coef[0] + coef[1] * Math.log(v)
  return { coef, predict, rSquared: () => determination(p, runningMean(p.ys), predict) }
}

function powerFit(rows: Row[], x: Get, y: Get): Fit {
  const p = validPoints(rows, x, y)
  const [intercept, exponent] = lineThrough(mapLog(p.xs), mapLog(p.ys))
  const coef = [Math.exp(intercept), exponent]
  const predict = (v: number): number => coef[0]! * Math.pow(v, coef[1]!)
  return { coef, predict, rSquared: () => determination(p, runningMean(p.ys), predict) }
}

/** y = a * e^(b x), fitted on x centred on its mean with every term weighted by y (so large values count in proportion). */
function exponentialFit(rows: Row[], x: Get, y: Get): Fit {
  const p = validPoints(rows, x, y)
  const { xs: cx, meanX, meanY } = centred(p)
  let yLogY = 0
  let xy = 0
  let xyLogY = 0
  let xxy = 0
  for (let i = 0; i < cx.length; i++) {
    const n = i + 1
    const dx = cx[i]!
    const dy = p.ys[i]!
    const logY = Math.log(dy)
    const product = dx * dy
    yLogY += (dy * logY - yLogY) / n
    xy += (product - xy) / n
    xyLogY += (product * logY - xyLogY) / n
    xxy += (dx * product - xxy) / n
  }
  const [a, b] = lineFromMeans(xy / meanY, yLogY / meanY, xyLogY / meanY, xxy / meanY)
  const predict = (v: number): number => Math.exp(a + b * (v - meanX))
  return { coef: [Math.exp(a - b * meanX), b], predict, rSquared: () => determination(p, meanY, predict) }
}

function quadraticFit(rows: Row[], x: Get, y: Get): Fit {
  const p = validPoints(rows, x, y)
  const { xs: cx, ys: cy, meanX, meanY } = centred(p)
  let x2 = 0
  let x3 = 0
  let x4 = 0
  let xy = 0
  let x2y = 0
  for (let i = 0; i < cx.length;) {
    const dx = cx[i]!
    const dy = cy[i++]!
    const sq = dx * dx
    x2 += (sq - x2) / i
    x3 += (sq * dx - x3) / i
    x4 += (sq * sq - x4) / i
    xy += (dx * dy - xy) / i
    x2y += (sq * dy - x2y) / i
  }
  const x2Spread = x4 - (x2 * x2)
  const det = (x2 * x2Spread - x3 * x3)
  const a = (x2y * x2 - xy * x3) / det
  const b = (xy * x2Spread - x2y * x3) / det
  const c = -a * x2
  const predict = (v: number): number => {
    v = v - meanX
    return a * v * v + b * v + c + meanY
  }
  // back from centred coordinates: a (v - mx)^2 + b (v - mx) + c + my, expanded in v
  return { coef: [c - b * meanX + a * meanX * meanX + meanY, b - 2 * a * meanX, a], predict, rSquared: () => determination(p, meanY, predict) }
}

/**
 * The polynomial of `order` by the normal equations on centred data. An order that is not a whole number is not refused: the
 * system is sized by whatever `order + 1` gives, and an unusable size yields NaN coefficients, as it always has.
 */
function polynomialFit(rows: Row[], x: Get, y: Get, order: number): Fit {
  if (order === 0) return constantFit(rows, x, y)
  if (order === 1) return linearFit(rows, x, y)
  if (order === 2) return quadraticFit(rows, x, y)

  const p = validPoints(rows, x, y)
  const { xs: cx, ys: cy, meanX, meanY } = centred(p)
  const n = cx.length
  const size = order + 1
  // the augmented system, stored by column: columns[j][i] is the entry of row i in column j (the matrix is symmetric); the last
  // column is the right-hand side
  const columns: Array<Float64Array | number[]> = []
  const rhs: number[] = []
  for (let i = 0; i < size; ++i) {
    let moment = 0
    for (let l = 0; l < n; ++l) moment += Math.pow(cx[l]!, i) * cy[l]!
    rhs.push(moment)
    const column = new Float64Array(size)
    for (let j = 0; j < size; ++j) {
      moment = 0
      for (let l = 0; l < n; ++l) moment += Math.pow(cx[l]!, i + j)
      column[j] = moment
    }
    columns.push(column)
  }
  columns.push(rhs)

  const centredCoef = solve(columns)
  const predict = (v: number): number => {
    v -= meanX
    let out = meanY + centredCoef[0]! + centredCoef[1]! * v + centredCoef[2]! * v * v
    for (let i = 3; i < size; ++i) out += centredCoef[i]! * Math.pow(v, i)
    return out
  }
  return { coef: shiftPolynomial(size, centredCoef, -meanX, meanY), predict, rSquared: () => determination(p, meanY, predict) }
}

/** The coefficients of `sum(a[i] * t^i)` as a polynomial in `t + shift`, plus `lift` (binomial expansion, highest term first). */
function shiftPolynomial(size: number, a: number[], shift: number, lift: number): number[] {
  const z = new Array<number>(size)
  for (let i = 0; i < size; ++i) z[i] = 0
  for (let i = size - 1; i >= 0; --i) {
    const v = a[i]!
    let binomial = 1
    z[i] = z[i]! + v
    for (let j = 1; j <= i; ++j) {
      binomial *= (i + 1 - j) / j
      z[i - j] = z[i - j]! + v * Math.pow(shift, j) * binomial
    }
  }
  z[0] = z[0]! + lift
  return z
}

/**
 * Solve the augmented system (by column, see {@link polynomialFit}) by elimination with partial pivoting: the largest entry
 * of the column below the diagonal is swapped up, the rows below are cleared by `entry - (pivotRowEntry * entry) / pivot`
 * working from the right-hand side leftwards, and the unknowns are found from the bottom up.
 */
function solve(columns: Array<Float64Array | number[]>): number[] {
  const n = columns.length - 1
  for (let i = 0; i < n; ++i) {
    let pivotRow = i
    for (let j = i + 1; j < n; ++j) {
      if (Math.abs(columns[i]![j]!) > Math.abs(columns[i]![pivotRow]!)) pivotRow = j
    }
    for (let c = i; c < n + 1; ++c) {
      const held = columns[c]![i]!
      columns[c]![i] = columns[c]![pivotRow]!
      columns[c]![pivotRow] = held
    }
    for (let j = i + 1; j < n; ++j) {
      for (let c = n; c >= i; c--) {
        columns[c]![j] = columns[c]![j]! - (columns[c]![i]! * columns[i]![j]!) / columns[i]![i]!
      }
    }
  }
  const solution: number[] = []
  for (let j = n - 1; j >= 0; --j) {
    let known = 0
    for (let c = j + 1; c < n; ++c) known += columns[c]![j]! * solution[c]!
    solution[j] = (columns[n]![j]! - known) / columns[j]![j]!
  }
  return solution
}

/** The regression methods by name; `order` is read by `poly` only. */
export const FITS: Record<string, (rows: Row[], x: Get, y: Get, order: number) => Fit> = {
  constant: constantFit,
  linear: linearFit,
  log: logarithmicFit,
  exp: exponentialFit,
  pow: powerFit,
  quad: quadraticFit,
  poly: polynomialFit,
}

/** The number of coefficients a method estimates, the least a group must exceed in size to be fitted. */
export const fitParameters = (method: string, order: number): number => (method === 'poly' ? order : method === 'quad' ? 2 : 1)

// --- loess --------------------------------------------------------------------------------------------------------------

const LOESS_PASSES = 2 // robustness re-fits after the first, at most
const TINY_WEIGHT = 1e-12 // what a heavily deviating point keeps of its weight, and the residual below which the fit is exact

const tricube = (u: number): number => {
  const c = 1 - u * u * u
  return c * c * c
}

/** The median of the values (by linear interpolation between the middle two), or undefined for none. */
function medianOf(values: Float64Array): number | undefined {
  const v = Float64Array.from(values).sort((a, b) => (a < b ? -1 : a > b ? 1 : a >= b ? 0 : NaN))
  const n = v.length
  if (!n) return undefined
  if (n < 2) return v[0]
  const position = (n - 1) * 0.5
  const lowIndex = Math.floor(position)
  return v[lowIndex]! + (v[lowIndex + 1]! - v[lowIndex]!) * (position - lowIndex)
}

/**
 * Locally weighted linear smoothing. The `bandwidth` fraction of the points (at least 2) nearest each x, found by sliding a
 * window of that many consecutive points along the sorted x, are fitted with a line, weights falling off by the tricube of the
 * distance to the window's far edge; then up to two more passes down-weight the points the previous fit left far behind.
 * Returns one point per distinct x (ties are averaged), at the data's own coordinates.
 */
export function loessSmooth(rows: Row[], x: Get, y: Get, bandwidth: number): Pt[] {
  const sorted = validPoints(rows, x, y, true)
  const { xs, ys, meanX, meanY } = centred(sorted)
  const n = xs.length
  const span = Math.max(2, ~~(bandwidth * n))
  const fitted = new Float64Array(n)
  const residuals = new Float64Array(n)
  const robust = new Float64Array(n).fill(1)

  for (let pass = 0; pass <= LOESS_PASSES; pass++) {
    let first = 0
    let last = span - 1
    for (let i = 0; i < n; ++i) {
      const at = xs[i]!
      const far = (at - xs[first]!) > (xs[last]! - at) ? first : last
      let sw = 0
      let sx = 0
      let sy = 0
      let sxy = 0
      let sxx = 0
      const reach = 1 / Math.abs(xs[far]! - at || 1) // a zero reach (all the window at one x) counts as 1
      meterTick('loess', last - first + 1)
      for (let k = first; k <= last; ++k) {
        const xk = xs[k]!
        const yk = ys[k]!
        const w = tricube(Math.abs(at - xk) * reach) * robust[k]!
        const xw = xk * w
        sw += w
        sx += xw
        sy += yk * w
        sxy += yk * xw
        sxx += xk * xw
      }
      const [intercept, slope] = lineFromMeans(sx / sw, sy / sw, sxy / sw, sxx / sw)
      fitted[i] = intercept + slope * at
      residuals[i] = Math.abs(ys[i]! - fitted[i]!)
      // slide the window for the next point: while the point just right of it is no farther from that point than the
      // window's left end is, move the window right (ties move it too, so runs of equal x do not pin it)
      const next = xs[i + 1]!
      let right = last + 1
      if (right < n) {
        while (i + 1 > first && (xs[right]! - next) <= (next - xs[first]!)) {
          first++
          last = right
          right++
        }
      }
    }
    if (pass === LOESS_PASSES) break
    const typical = medianOf(residuals) as number
    if (Math.abs(typical) < TINY_WEIGHT) break
    for (let i = 0; i < n; ++i) {
      const ratio = residuals[i]! / (6 * typical)
      if (ratio >= 1) robust[i] = TINY_WEIGHT
      else {
        const bisquare = 1 - ratio * ratio
        robust[i] = bisquare * bisquare
      }
    }
  }

  // one point per distinct x: a run of equal x is averaged online, and the y shift is applied once the run is closed
  const out: Pt[] = []
  let run = 0
  for (let i = 0; i < n; ++i) {
    const px = xs[i]! + meanX
    const tail = out[out.length - 1]
    if (tail !== undefined && tail[0] === px) {
      tail[1] = tail[1] + (fitted[i]! - tail[1]) / ++run
    } else {
      run = 0
      out.push([px, fitted[i]!])
    }
  }
  for (const point of out) point[1] = point[1] + meanY
  return out
}

// --- sampling a curve ---------------------------------------------------------------------------------------------------

const BEND_LIMIT = 0.5 * Math.PI / 180 // the turn, in radians, past which a stretch of curve is split again

/** Direction change at `mid` between the chords start->mid and start->end, with the axes scaled to unit extent. */
function bend(start: Pt, mid: Pt, end: Pt, sx: number, sy: number): number {
  const toEnd = Math.atan2(sy * (end[1] - start[1]), sx * (end[0] - start[0]))
  const toMid = Math.atan2(sy * (mid[1] - start[1]), sx * (mid[0] - start[0]))
  return Math.abs(toEnd - toMid)
}

/**
 * Sample `f` over the extent `ext` (its two ends): `minSteps` evenly spaced points first, then any stretch whose midpoint turns
 * the curve by more than half a degree (axes scaled to the box of the first samples) is split, down to a step of
 * `extent / maxSteps`. With equal step counts the grid is simply uniform. Points come back ordered by x.
 */
export function sampleCurve(f: (x: number) => number, ext: ArrayLike<unknown>, minStepsIn?: number, maxStepsIn?: number): Pt[] {
  const minSteps = minStepsIn || 25
  const maxSteps = Math.max(minSteps, maxStepsIn || 200)
  // `steps` and `maxsteps` are spec parameters: bound the sample count before evaluating the function that many times
  checkRowCount(maxSteps, 'density steps')

  const at = (x: number): Pt => [x, f(x)]
  const minX = ext[0] as number
  const maxX = ext[1] as number
  const span = maxX - minX
  const smallestStep = span / maxSteps
  const settled: Pt[] = [at(minX)]

  if (minSteps === maxSteps) {
    for (let i = 1; i < maxSteps; ++i) settled.push(at(minX + (i / minSteps) * span))
    settled.push(at(maxX))
    return settled
  }
  // the points still to be placed, nearest-to-the-end first so that the one on top is the next in x order
  const pending: Pt[] = [at(maxX)]
  for (let i = minSteps; --i > 0;) pending.push(at(minX + (i / minSteps) * span))

  let from = settled[0]!
  let to = pending[pending.length - 1]
  const sx = 1 / span
  let yMin = from[1]
  let yMax = from[1]
  for (const p of pending) {
    if (p[1] < yMin) yMin = p[1]
    if (p[1] > yMax) yMax = p[1]
  }
  const sy = 1 / (yMax - yMin)
  while (to) {
    const mid = at((from[0] + to[0]) / 2)
    if (mid[0] - from[0] >= smallestStep && bend(from, mid, to, sx, sy) > BEND_LIMIT) {
      pending.push(mid)
    } else {
      from = to
      settled.push(to)
      pending.pop()
    }
    to = pending[pending.length - 1]
  }
  return settled
}
