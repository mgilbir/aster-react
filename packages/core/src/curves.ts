/**
 * The curves of the `interpolate` channel besides `linear` (shape.ts): each a `Run` that draws one run of consecutive defined points
 * into a path sink, by the conventions of shape.ts. The engine's `curves` part (engine-parts.ts), which shape.ts reads when a line or
 * an area names one of them.
 *
 * Provenance as in shape.ts: the arithmetic follows d3-shape 3.2.0 (ISC, Mike Bostock), checked by the differentials in
 * `conformance/scripts/differential-d3-shape*.test.mts`.
 */
import { BOTTOM, LINE, end, linearClosed, open, type PathSink, type Run } from './shape.js'

// --- B-splines: basis, basis-closed, basis-open, bundle -------------------------------------------

/** The cubic piece of a uniform B-spline that ends at the average of the three points a, b, c. */
function bSpline(s: PathSink, xa: number, ya: number, xb: number, yb: number, xc: number, yc: number): void {
  s.bezierCurveTo((2 * xa + xb) / 3, (2 * ya + yb) / 3, (xa + 2 * xb) / 3, (ya + 2 * yb) / 3, (xa + 4 * xb + xc) / 6, (ya + 4 * yb + yc) / 6)
}

const basis: Run = (s, x, y, lo, hi, join) => {
  const n = hi - lo
  open(s, join, x[lo]!, y[lo]!)
  if (n >= 3) {
    s.lineTo((5 * x[lo]! + x[lo + 1]!) / 6, (5 * y[lo]! + y[lo + 1]!) / 6)
    for (let i = lo + 2; i < hi; i++) bSpline(s, x[i - 2]!, y[i - 2]!, x[i - 1]!, y[i - 1]!, x[i]!, y[i]!)
    // the last piece ends on the final point, repeated
    bSpline(s, x[hi - 2]!, y[hi - 2]!, x[hi - 1]!, y[hi - 1]!, x[hi - 1]!, y[hi - 1]!)
  }
  if (n >= 2) s.lineTo(x[hi - 1]!, y[hi - 1]!)
  end(s, join, n === 1)
}

const basisClosed: Run = (s, x, y, lo, hi) => {
  const n = hi - lo
  if (n === 1) {
    s.moveTo(x[lo]!, y[lo]!)
    s.closePath()
  } else if (n === 2) {
    const xa = x[lo]!, ya = y[lo]!, xb = x[lo + 1]!, yb = y[lo + 1]!
    s.moveTo((xa + 2 * xb) / 3, (ya + 2 * yb) / 3)
    s.lineTo((xb + 2 * xa) / 3, (yb + 2 * ya) / 3)
    s.closePath()
  } else {
    s.moveTo((x[lo]! + 4 * x[lo + 1]! + x[lo + 2]!) / 6, (y[lo]! + 4 * y[lo + 1]! + y[lo + 2]!) / 6)
    // the pieces ending at points 3 .. n+2, indexing the run as a cycle; the outline is left unclosed
    for (let k = 3; k <= n + 2; k++) {
      const a = lo + (k - 2 >= n ? k - 2 - n : k - 2)
      const b = lo + (k - 1 >= n ? k - 1 - n : k - 1)
      const c = lo + (k >= n ? k - n : k)
      bSpline(s, x[a]!, y[a]!, x[b]!, y[b]!, x[c]!, y[c]!)
    }
  }
}

const basisOpen: Run = (s, x, y, lo, hi, join) => {
  const n = hi - lo
  if (n >= 3) {
    open(s, join, (x[lo]! + 4 * x[lo + 1]! + x[lo + 2]!) / 6, (y[lo]! + 4 * y[lo + 1]! + y[lo + 2]!) / 6)
    for (let i = lo + 3; i < hi; i++) bSpline(s, x[i - 2]!, y[i - 2]!, x[i - 1]!, y[i - 1]!, x[i]!, y[i]!)
  }
  end(s, join, n === 3)
}

/** A basis spline through the run bent toward its chord: point i moves to beta * p + (1 - beta) * chord(i / last). */
const bundle: Run = (s, x, y, lo, hi, join, beta) => {
  if (beta === 1) return basis(s, x, y, lo, hi, join, 0)
  const n = hi - lo
  // a lone point draws nothing; in an area both passes are independent bundle lines
  if (n < 2) return
  const last = n - 1
  const x0 = x[lo]!
  const y0 = y[lo]!
  const dx = x[hi - 1]! - x0
  const dy = y[hi - 1]! - y0
  const bx = new Float64Array(n)
  const by = new Float64Array(n)
  for (let i = 0; i <= last; i++) {
    const t = i / last
    bx[i] = beta * x[lo + i]! + (1 - beta) * (x0 + t * dx)
    by[i] = beta * y[lo + i]! + (1 - beta) * (y0 + t * dy)
  }
  basis(s, bx, by, 0, n, LINE, 0)
}

// --- cardinal splines -----------------------------------------------------------------------------

/**
 * The cubic piece from b to c of a cardinal spline, a before b and d after c; `k` is (1 - tension) / 6.
 * At the ends the missing neighbour is replaced by the run's own point (see `cardinal`).
 */
function cardinalPiece(s: PathSink, k: number, x: Float64Array, y: Float64Array, a: number, b: number, c: number, d: number): void {
  s.bezierCurveTo(x[b]! + k * (x[c]! - x[a]!), y[b]! + k * (y[c]! - y[a]!), x[c]! + k * (x[b]! - x[d]!), y[c]! + k * (y[b]! - y[d]!), x[c]!, y[c]!)
}

const cardinal: Run = (s, x, y, lo, hi, join, tension) => {
  const k = (1 - tension) / 6
  const n = hi - lo
  open(s, join, x[lo]!, y[lo]!)
  if (n === 2) s.lineTo(x[hi - 1]!, y[hi - 1]!)
  else if (n >= 3) {
    // the run's first segment has no predecessor and its last no successor: each borrows the other end of itself
    for (let b = lo; b < hi - 1; b++) cardinalPiece(s, k, x, y, b > lo ? b - 1 : b + 1, b, b + 1, b + 2 < hi ? b + 2 : b)
  }
  end(s, join, n === 1)
}

const cardinalClosed: Run = (s, x, y, lo, hi, _join, tension) => {
  const k = (1 - tension) / 6
  const n = hi - lo
  if (n === 1) {
    s.moveTo(x[lo]!, y[lo]!)
    s.closePath()
  } else if (n === 2) {
    s.moveTo(x[lo + 1]!, y[lo + 1]!)
    s.lineTo(x[lo]!, y[lo]!)
    s.closePath()
  } else {
    s.moveTo(x[lo + 1]!, y[lo + 1]!)
    // one piece per point of the cycle starting at the second; the outline is left unclosed
    for (let j = 1; j <= n; j++) {
      const a = lo + j - 1
      const b = lo + (j >= n ? j - n : j)
      const c = lo + (j + 1 >= n ? j + 1 - n : j + 1)
      const d = lo + (j + 2 >= n ? j + 2 - n : j + 2)
      cardinalPiece(s, k, x, y, a, b, c, d)
    }
  }
}

const cardinalOpen: Run = (s, x, y, lo, hi, join, tension) => {
  const k = (1 - tension) / 6
  const n = hi - lo
  if (n >= 3) {
    open(s, join, x[lo + 1]!, y[lo + 1]!)
    for (let b = lo + 1; b + 2 < hi; b++) cardinalPiece(s, k, x, y, b - 1, b, b + 1, b + 2)
  }
  end(s, join, n === 3)
}

// --- Catmull-Rom splines --------------------------------------------------------------------------

const CATMULL_EPSILON = 1e-12

/**
 * The cubic piece from b to c of a Catmull-Rom spline through a, b, c, d. `la` / `l2a` are the chord lengths
 * |ab|, |bc|, |cd| raised to alpha and 2 alpha (`l01` is |ab|, `l12` is |bc|, `l23` is |cd|); a vanishing outer
 * chord leaves its control point on the end point.
 */
function catmullPiece(
  s: PathSink, x: Float64Array, y: Float64Array, a: number, b: number, c: number, d: number,
  l01a: number, l01b: number, l12a: number, l12b: number, l23a: number, l23b: number,
): void {
  const xb = x[b]!, yb = y[b]!, xc = x[c]!, yc = y[c]!
  let cx1 = xb
  let cy1 = yb
  let cx2 = xc
  let cy2 = yc
  if (l01a > CATMULL_EPSILON) {
    const p = 2 * l01b + 3 * l01a * l12a + l12b
    const q = 3 * l01a * (l01a + l12a)
    cx1 = (xb * p - x[a]! * l12b + xc * l01b) / q
    cy1 = (yb * p - y[a]! * l12b + yc * l01b) / q
  }
  if (l23a > CATMULL_EPSILON) {
    const p = 2 * l23b + 3 * l23a * l12a + l12b
    const q = 3 * l23a * (l23a + l12a)
    cx2 = (xc * p + xb * l23b - x[d]! * l12b) / q
    cy2 = (yc * p + yb * l23b - y[d]! * l12b) / q
  }
  s.bezierCurveTo(cx1, cy1, cx2, cy2, xc, yc)
}

/** |pq|^(2 alpha): the squared distance raised to alpha, taken as (p - q) like the segment that precedes q. */
function chordPow(x: Float64Array, y: Float64Array, p: number, q: number, alpha: number): number {
  const dx = x[p]! - x[q]!
  const dy = y[p]! - y[q]!
  return Math.pow(dx * dx + dy * dy, alpha)
}

/**
 * The chord table of a run: entry e + 1 holds the chord from point e to the point after it (entry 0 is the
 * absent chord before the first point, of length 0). `cycle` makes the chord after the last point return to the
 * first (and continue around); otherwise the chord after the last point is that point to itself.
 */
function chords(x: Float64Array, y: Float64Array, lo: number, n: number, alpha: number, cycle: boolean, count: number): [Float64Array, Float64Array] {
  const pow = new Float64Array(count + 1)
  const len = new Float64Array(count + 1)
  for (let e = 0; e < count; e++) {
    const from = lo + (e < n ? e : e - n)
    let to = from + 1
    if (cycle) {
      if (e + 1 >= n) to = lo + (e + 1 - n)
    } else if (e + 1 >= n) to = from
    const v = chordPow(x, y, from, to, alpha)
    pow[e + 1] = v
    len[e + 1] = Math.sqrt(v)
  }
  return [pow, len]
}

const catmullRom: Run = (s, x, y, lo, hi, join, alpha) => {
  if (!alpha) return cardinal(s, x, y, lo, hi, join, 0)
  const n = hi - lo
  open(s, join, x[lo]!, y[lo]!)
  if (n === 2) s.lineTo(x[hi - 1]!, y[hi - 1]!)
  else if (n >= 3) {
    const [pow, len] = chords(x, y, lo, n, alpha, false, n)
    for (let j = 0; j < n - 1; j++) {
      const b = lo + j
      catmullPiece(s, x, y, j > 0 ? b - 1 : b, b, b + 1, j + 2 < n ? b + 2 : b + 1, len[j]!, pow[j]!, len[j + 1]!, pow[j + 1]!, len[j + 2]!, pow[j + 2]!)
    }
  }
  end(s, join, n === 1)
}

const catmullRomClosed: Run = (s, x, y, lo, hi, join, alpha) => {
  if (!alpha) return cardinalClosed(s, x, y, lo, hi, join, 0)
  const n = hi - lo
  if (n === 1) {
    s.moveTo(x[lo]!, y[lo]!)
    s.closePath()
  } else if (n === 2) {
    s.moveTo(x[lo + 1]!, y[lo + 1]!)
    s.lineTo(x[lo]!, y[lo]!)
    s.closePath()
  } else {
    const [pow, len] = chords(x, y, lo, n, alpha, true, n + 2)
    s.moveTo(x[lo + 1]!, y[lo + 1]!)
    for (let j = 1; j <= n; j++) {
      const a = lo + j - 1
      const b = lo + (j >= n ? j - n : j)
      const c = lo + (j + 1 >= n ? j + 1 - n : j + 1)
      const d = lo + (j + 2 >= n ? j + 2 - n : j + 2)
      catmullPiece(s, x, y, a, b, c, d, len[j]!, pow[j]!, len[j + 1]!, pow[j + 1]!, len[j + 2]!, pow[j + 2]!)
    }
  }
}

const catmullRomOpen: Run = (s, x, y, lo, hi, join, alpha) => {
  if (!alpha) return cardinalOpen(s, x, y, lo, hi, join, 0)
  const n = hi - lo
  if (n >= 3) {
    open(s, join, x[lo + 1]!, y[lo + 1]!)
    const [pow, len] = chords(x, y, lo, n, alpha, false, n)
    for (let j = 1; j + 2 < n; j++) {
      const b = lo + j
      catmullPiece(s, x, y, b - 1, b, b + 1, b + 2, len[j]!, pow[j]!, len[j + 1]!, pow[j + 1]!, len[j + 2]!, pow[j + 2]!)
    }
  }
  end(s, join, n === 3)
}

// --- monotone cubic (Steffen) ---------------------------------------------------------------------

function sign(v: number): number {
  return v < 0 ? -1 : 1
}

/**
 * Steffen's slope at the middle of three points (Steffen 1990, "A simple method for monotonic interpolation in
 * one dimension"): the slope is clamped so the interpolant stays monotone between the points. A repeated
 * abscissa gives an infinite chord slope with the sign of the neighbouring step; a NaN result is 0.
 */
function steffen(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number): number {
  const h0 = x1 - x0
  const h1 = x2 - x1
  const s0 = (y1 - y0) / (h0 ? h0 : (h1 < 0 ? -0 : 0))
  const s1 = (y2 - y1) / (h1 ? h1 : (h0 < 0 ? -0 : 0))
  const p = (s0 * h1 + s1 * h0) / (h0 + h1)
  return (sign(s0) + sign(s1)) * Math.min(Math.abs(s0), Math.abs(s1), 0.5 * Math.abs(p)) || 0
}

/** The slope at the end of a segment from the chord slope and the slope at its other end. */
function endSlope(x0: number, y0: number, x1: number, y1: number, t: number): number {
  const h = x1 - x0
  return h ? (3 * (y1 - y0) / h - t) / 2 : t
}

/** The cubic Bezier of a Hermite segment from (x0, y0) to (x1, y1) with end slopes t0, t1. */
function hermite(s: PathSink, x0: number, y0: number, x1: number, y1: number, t0: number, t1: number): void {
  const dx = (x1 - x0) / 3
  s.bezierCurveTo(x0 + dx, y0 + dx * t0, x1 - dx, y1 - dx * t1, x1, y1)
}

/** `monotone-x` over (x, y); `monotone-y` calls it with the columns swapped and a sink that swaps back. */
const monotoneX: Run = (s, x, y, lo, hi, join) => {
  let kept = 0
  let x0 = NaN, y0 = NaN, x1 = NaN, y1 = NaN, t0 = NaN
  for (let i = lo; i < hi; i++) {
    const px = x[i]!
    const py = y[i]!
    if (px === x1 && py === y1) continue // a point equal to the one before it adds nothing
    let t1 = NaN
    if (kept === 0) open(s, join, px, py)
    else if (kept === 2) {
      t1 = steffen(x0, y0, x1, y1, px, py)
      hermite(s, x0, y0, x1, y1, endSlope(x0, y0, x1, y1, t1), t1)
    } else if (kept >= 3) {
      t1 = steffen(x0, y0, x1, y1, px, py)
      hermite(s, x0, y0, x1, y1, t0, t1)
    }
    if (kept < 3) kept++
    x0 = x1, x1 = px
    y0 = y1, y1 = py
    t0 = t1
  }
  if (kept === 2) s.lineTo(x1, y1)
  else if (kept === 3) hermite(s, x0, y0, x1, y1, t0, endSlope(x0, y0, x1, y1, t0))
  end(s, join, kept === 1)
}

class Transposed implements PathSink {
  constructor(private readonly s: PathSink) {}
  moveTo(x: number, y: number): void { this.s.moveTo(y, x) }
  lineTo(x: number, y: number): void { this.s.lineTo(y, x) }
  bezierCurveTo(x1: number, y1: number, x2: number, y2: number, x: number, y: number): void { this.s.bezierCurveTo(y1, x1, y2, x2, y, x) }
  closePath(): void { this.s.closePath() }
}

const monotoneY: Run = (s, x, y, lo, hi, join) => monotoneX(new Transposed(s), y, x, lo, hi, join, 0)

// --- natural cubic spline -------------------------------------------------------------------------

/**
 * First and second Bezier control coordinates of the natural cubic spline through one coordinate of the run's
 * points (the tridiagonal solve of https://www.particleincell.com/2012/bezier-splines/). `first` and `second`
 * get n - 1 entries each; `work` is scratch of the same size.
 */
function naturalControls(v: Float64Array, lo: number, n: number, first: Float64Array, second: Float64Array, work: Float64Array): void {
  const m = n - 1
  first[0] = 0, second[0] = 2, work[0] = v[lo]! + 2 * v[lo + 1]!
  for (let i = 1; i < m - 1; ++i) first[i] = 1, second[i] = 4, work[i] = 4 * v[lo + i]! + 2 * v[lo + i + 1]!
  first[m - 1] = 2, second[m - 1] = 7, work[m - 1] = 8 * v[lo + m - 1]! + v[lo + m]!
  for (let i = 1; i < m; ++i) {
    const ratio = first[i]! / second[i - 1]!
    second[i] = second[i]! - ratio
    work[i] = work[i]! - ratio * work[i - 1]!
  }
  first[m - 1] = work[m - 1]! / second[m - 1]!
  for (let i = m - 2; i >= 0; --i) first[i] = (work[i]! - first[i + 1]!) / second[i]!
  second[m - 1] = (v[lo + m]! + first[m - 1]!) / 2
  for (let i = 0; i < m - 1; ++i) second[i] = 2 * v[lo + i + 1]! - first[i + 1]!
}

const natural: Run = (s, x, y, lo, hi, join) => {
  const n = hi - lo
  open(s, join, x[lo]!, y[lo]!)
  if (n === 2) s.lineTo(x[hi - 1]!, y[hi - 1]!)
  else if (n >= 3) {
    const m = n - 1
    const ax = new Float64Array(m), bx = new Float64Array(m), ay = new Float64Array(m), by = new Float64Array(m), work = new Float64Array(m)
    naturalControls(x, lo, n, ax, bx, work)
    naturalControls(y, lo, n, ay, by, work)
    for (let i = 0; i < m; i++) s.bezierCurveTo(ax[i]!, ay[i]!, bx[i]!, by[i]!, x[lo + i + 1]!, y[lo + i + 1]!)
  }
  end(s, join, n === 1)
}

// --- steps ----------------------------------------------------------------------------------------

/** A staircase that turns at fraction `at` of each interval (0 before, 1 after, 0.5 centred); the bottom pass of an area mirrors it. */
const step: Run = (s, x, y, lo, hi, join, at) => {
  const t = join === BOTTOM ? 1 - at : at
  const n = hi - lo
  open(s, join, x[lo]!, y[lo]!)
  let px = x[lo]!
  let py = y[lo]!
  for (let i = lo + 1; i < hi; i++) {
    const nx = x[i]!
    const ny = y[i]!
    if (t <= 0) {
      s.lineTo(px, ny)
      s.lineTo(nx, ny)
    } else {
      const mid = px * (1 - t) + nx * t
      s.lineTo(mid, py)
      s.lineTo(mid, ny)
    }
    px = nx
    py = ny
  }
  if (0 < t && t < 1 && n >= 2) s.lineTo(px, py)
  end(s, join, n === 1)
}

/** interpolate name -> [run, default parameter, whether `tension` sets the parameter]. */
export const FAMILIES: ReadonlyMap<string, readonly [Run, number, boolean]> = new Map<string, readonly [Run, number, boolean]>([
  ['linear-closed', [linearClosed, 0, false]],
  ['basis', [basis, 0, false]],
  ['basis-closed', [basisClosed, 0, false]],
  ['basis-open', [basisOpen, 0, false]],
  ['bundle', [bundle, 0.85, true]],
  ['cardinal', [cardinal, 0, true]],
  ['cardinal-closed', [cardinalClosed, 0, true]],
  ['cardinal-open', [cardinalOpen, 0, true]],
  ['catmull-rom', [catmullRom, 0.5, true]],
  ['catmull-rom-closed', [catmullRomClosed, 0.5, true]],
  ['catmull-rom-open', [catmullRomOpen, 0.5, true]],
  ['monotone-x', [monotoneX, 0, false]],
  ['monotone-y', [monotoneY, 0, false]],
  ['natural', [natural, 0, false]],
  ['step', [step, 0.5, false]],
  ['step-after', [step, 1, false]],
  ['step-before', [step, 0, false]],
])

