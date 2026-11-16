/**
 * Line and area path geometry: the curve families named by the `interpolate` channel, run over columns of
 * points, and the path writer they draw into.
 *
 * Design. A curve is one pure function (a `Run`) that draws a single run of consecutive defined points,
 * `[lo, hi)` of two coordinate columns, into a `PathSink`. Runs are found by `traceLine` / `traceArea` from a
 * liveness column; there is no per-point state machine, no object per curve and no accessor protocol. An
 * area is its top boundary drawn forward and its bottom boundary drawn backwards, which `traceArea` obtains
 * by reversing the bottom columns once, so every curve only ever runs forwards.
 *
 * What the output pins (and therefore what is deliberately not free):
 *  - the sequence of path commands, including which runs close with `Z`, which do not, and the degenerate
 *    runs of 1 or 2 points that several curves treat specially;
 *  - the floating point expressions of every control point, operation for operation (the SVG text and the
 *    canvas coordinates show the last bit), and the three-decimal rounding of the SVG text;
 *  - how an area joins its two passes: the open curves continue the top subpath into the bottom one, the
 *    closed ones and the bundle curve close each pass on its own.
 * Everything else here is Aster's: columns instead of objects, one function per curve family, closed forms
 * for the point indexing, the sink interface shared by the SVG writer and the tests' recorders.
 *
 * Provenance. The curve arithmetic (B-spline, cardinal, Catmull-Rom, Steffen monotone, natural-spline control
 * points, step) and the path text follow the algorithms of d3-shape 3.2.0 and d3-path 3.1.0 (ISC, Mike Bostock),
 * which Vega's renderers use; their notices are in THIRD_PARTY_NOTICES.md. The code is an independent
 * implementation checked against those libraries by the differentials in
 * `conformance/scripts/differential-d3-shape*.test.mts`.
 */

import { part } from './engine-parts.js'

// --- the sink and its SVG writer ----------------------------------------------------------------

/** Where a curve draws: the four calls a canvas 2D context and the SVG writer share. */
export interface PathSink {
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  bezierCurveTo(x1: number, y1: number, x2: number, y2: number, x: number, y: number): void
  closePath(): void
}

const TAU = 2 * Math.PI
const ARC_EPSILON = 1e-6

/**
 * SVG path text. `digits` rounds every coordinate to that many decimals (`Math.round(v * 10 ** digits) / 10 **
 * digits`); `null` writes the number as JavaScript prints it. `closePath` writes `Z` once something is drawn.
 */
export class PathWriter implements PathSink {
  /** The path text so far. */
  d = ''
  private readonly scale: number

  constructor(digits: number | null) {
    this.scale = digits === null ? 0 : 10 ** digits
  }

  moveTo(x: number, y: number): void {
    const k = this.scale
    this.d += k ? 'M' + Math.round(x * k) / k + ',' + Math.round(y * k) / k : 'M' + x + ',' + y
  }

  lineTo(x: number, y: number): void {
    const k = this.scale
    this.d += k ? 'L' + Math.round(x * k) / k + ',' + Math.round(y * k) / k : 'L' + x + ',' + y
  }

  bezierCurveTo(x1: number, y1: number, x2: number, y2: number, x: number, y: number): void {
    const k = this.scale
    // appended piece by piece: one long concatenation builds a deeper rope that costs ~10% more to flatten
    if (k) {
      this.d += 'C'
      this.d += String(Math.round(x1 * k) / k) + ','
      this.d += String(Math.round(y1 * k) / k) + ','
      this.d += String(Math.round(x2 * k) / k) + ','
      this.d += String(Math.round(y2 * k) / k) + ','
      this.d += String(Math.round(x * k) / k) + ','
      this.d += String(Math.round(y * k) / k)
    } else this.d += 'C' + x1 + ',' + y1 + ',' + x2 + ',' + y2 + ',' + x + ',' + y
  }

  closePath(): void {
    if (this.d !== '') this.d += 'Z'
  }

  toString(): string {
    return this.d
  }
}

/**
 * An SVG path writer for outlines made of lines and circular arcs (the trail and the arc mark). It follows the current
 * point (an arc joins to it by a line when it does not start there) and the start of the subpath (`closePath` returns
 * to it), and writes an arc as SVG `A` commands: the large-arc flag is set for a sweep of half a turn or more, and a
 * full turn is drawn as two half arcs. Radii and end points are rounded like the other coordinates; `digits` is as for
 * {@link PathWriter}, and the default is full precision.
 *
 * What it decides (which commands, with which rounded numbers) is apart from how it writes them (`put*`): the text here,
 * the parsed segments in {@link ArcSegWriter}, so the two cannot disagree.
 */
export class ArcPathWriter {
  /** The path text so far. */
  d = ''
  private readonly scale: number
  private sx = 0
  private sy = 0
  private cx = 0
  private cy = 0
  /** A subpath was started with `moveTo`: `closePath` returns to a defined point. */
  private hasStart = false
  /** There is a current point. */
  private hasPoint = false

  constructor(digits: number | null = null) {
    this.scale = digits === null ? 0 : digits === 3 ? 1000 : 10 ** digits
  }

  private round(v: number): number {
    const k = this.scale
    return k ? Math.round(v * k) / k : v
  }

  /** Writes `M x,y` (numbers already rounded). */
  protected putMove(x: number, y: number): void { this.d += 'M' + x + ',' + y }
  /** Writes `L x,y`. */
  protected putLine(x: number, y: number): void { this.d += 'L' + x + ',' + y }
  /** Writes `A r,r,0,large,sweep,x,y`. */
  protected putArc(r: number, large: 0 | 1, sweep: 0 | 1, x: number, y: number): void {
    this.d += 'A' + r + ',' + r + ',0,' + large + ',' + sweep + ',' + x + ',' + y
  }
  /** Writes `Z`. */
  protected putClose(): void { this.d += 'Z' }

  moveTo(x: number, y: number): void {
    this.sx = this.cx = x
    this.sy = this.cy = y
    this.hasStart = this.hasPoint = true
    this.putMove(this.round(x), this.round(y))
  }

  lineTo(x: number, y: number): void {
    this.cx = x
    this.cy = y
    this.hasPoint = true
    this.putLine(this.round(x), this.round(y))
  }

  closePath(): void {
    if (!this.hasPoint) return
    this.cx = this.sx
    this.cy = this.sy
    this.hasPoint = this.hasStart
    this.putClose()
  }

  /**
   * A circular arc about (x, y) from angle a0 to a1, clockwise unless `ccw`, joined to the current point by a
   * line when it does not start there (and starting the path when there is none). A sweep the wrong way round
   * is taken the long way; a full turn is drawn as two half arcs; no radius, or a sweep under a millionth of a
   * radian, draws nothing but that join. A negative radius is an error.
   */
  arc(x: number, y: number, radius: number, a0: number, a1: number, ccw = false): void {
    if (radius < 0) throw new Error(`negative radius: ${radius}`)
    const dx = radius * Math.cos(a0)
    const dy = radius * Math.sin(a0)
    const x0 = x + dx
    const y0 = y + dy
    if (!this.hasPoint) this.putMove(this.round(x0), this.round(y0))
    else if (Math.abs(this.cx - x0) > ARC_EPSILON || Math.abs(this.cy - y0) > ARC_EPSILON) this.putLine(this.round(x0), this.round(y0))
    if (!radius) return
    let sweep = ccw ? a0 - a1 : a1 - a0
    if (sweep < 0) sweep = (sweep % TAU) + TAU
    const r = this.round(radius)
    const side = ccw ? 0 : 1
    if (sweep > TAU - ARC_EPSILON) {
      this.putArc(r, 1, side, this.round(x - dx), this.round(y - dy))
      this.putArc(r, 1, side, this.round(x0), this.round(y0))
      this.cx = x0
      this.cy = y0
      this.hasPoint = true
    } else if (sweep > ARC_EPSILON) {
      const ex = x + radius * Math.cos(a1)
      const ey = y + radius * Math.sin(a1)
      this.putArc(r, sweep >= Math.PI ? 1 : 0, side, this.round(ex), this.round(ey))
      this.cx = ex
      this.cy = ey
      this.hasPoint = true
    }
  }
}

/** One command of parsed SVG path data, absolute (the shape `parsePathData` gives; declared here so this module needs no parser). */
export type ArcSeg =
  | { cmd: 'M' | 'L'; x: number; y: number }
  | { cmd: 'A'; rx: number; ry: number; rot: number; large: number; sweep: number; x: number; y: number }
  | { cmd: 'Z' }

/**
 * The commands an {@link ArcPathWriter} writes, as the segments `parsePathData` reads back from its text: each number as
 * the text prints it and the parser reads it (`v + 0`: the text has no negative zero). `finite` is false once a number
 * that is not finite was written (its text, `NaN` or `Infinity`, does not read back as a number: such a path has to be
 * read from the text).
 */
export class ArcSegWriter extends ArcPathWriter {
  readonly segs: ArcSeg[] = []
  finite = true
  private n(v: number): number {
    if (!Number.isFinite(v)) this.finite = false
    return v + 0
  }
  protected override putMove(x: number, y: number): void { this.segs.push({ cmd: 'M', x: this.n(x), y: this.n(y) }) }
  protected override putLine(x: number, y: number): void { this.segs.push({ cmd: 'L', x: this.n(x), y: this.n(y) }) }
  protected override putArc(r: number, large: 0 | 1, sweep: 0 | 1, x: number, y: number): void {
    const rr = this.n(r)
    this.segs.push({ cmd: 'A', rx: rr, ry: rr, rot: 0, large, sweep, x: this.n(x), y: this.n(y) })
  }
  protected override putClose(): void { this.segs.push({ cmd: 'Z' }) }
}

// --- runs ----------------------------------------------------------------------------------------

/**
 * Which pass of a shape a run is. The curves that can continue a subpath (everything but the closed families and
 * the bundle) draw a LINE run as its own subpath and close it only when it is a single point; the TOP pass of
 * an area opens a subpath and leaves it open; the BOTTOM pass continues it with a line, then closes it.
 */
export const LINE = 0
export const TOP = 1
export const BOTTOM = 2

export type Run = (s: PathSink, x: Float64Array, y: Float64Array, lo: number, hi: number, join: number, p: number) => void

export function open(s: PathSink, join: number, x: number, y: number): void {
  if (join === BOTTOM) s.lineTo(x, y)
  else s.moveTo(x, y)
}

export function end(s: PathSink, join: number, lone: boolean): void {
  if (join === BOTTOM || (join === LINE && lone)) s.closePath()
}

// --- linear --------------------------------------------------------------------------------------

const linear: Run = (s, x, y, lo, hi, join) => {
  open(s, join, x[lo]!, y[lo]!)
  for (let i = lo + 1; i < hi; i++) s.lineTo(x[i]!, y[i]!)
  end(s, join, hi - lo === 1)
}

export const linearClosed: Run = (s, x, y, lo, hi) => {
  s.moveTo(x[lo]!, y[lo]!)
  for (let i = lo + 1; i < hi; i++) s.lineTo(x[i]!, y[i]!)
  s.closePath()
}

// --- the curve table -------------------------------------------------------------------------------

/** A resolved curve: its run function and the one number that parameterizes it (beta, tension, alpha or the step position). */
export interface Curve {
  readonly run: Run
  readonly param: number
}

/**
 * The names of the curves besides `linear` (the `curves` part of the engine, curves.ts, draws them; `monotone` is one of the two
 * monotone curves, by the mark's orientation). What the detector of the parts a spec needs (addons.ts) reads.
 */
export const CURVE_NAMES: ReadonlySet<string> = new Set([
  'linear-closed', 'basis', 'basis-closed', 'basis-open', 'bundle', 'cardinal', 'cardinal-closed', 'cardinal-open',
  'catmull-rom', 'catmull-rom-closed', 'catmull-rom-open', 'monotone', 'monotone-x', 'monotone-y', 'natural', 'step', 'step-after', 'step-before',
])

const LINEAR: Curve = { run: linear, param: 0 }

/**
 * The curve a mark's `interpolate` value names. `monotone` follows the mark's orientation. `tension`, when
 * given, is the bundle's beta, the cardinal families' tension or the Catmull-Rom families' alpha. An absent or
 * unknown name is the linear curve; any other is read from the engine's `curves` part (engine-parts.ts).
 */
export function resolveCurve(interpolate: string | undefined, orient: string | undefined, tension: number | null | undefined): Curve {
  const name = interpolate || 'linear'
  if (name === 'linear' || !CURVE_NAMES.has(name)) return LINEAR
  const family = part('curves').families.get(name === 'monotone' ? (orient === 'horizontal' ? 'monotone-y' : 'monotone-x') : name)
  if (family === undefined) return LINEAR
  const [run, dflt, takesTension] = family
  return { run, param: tension != null && takesTension ? +tension : dflt }
}

// --- drivers ---------------------------------------------------------------------------------------

/** Calls `fn(lo, hi)` for every maximal run of live entries of `live` (all of `n` when it is null). */
function forEachRun(n: number, live: Uint8Array | null, fn: (lo: number, hi: number) => void): void {
  let i = 0
  while (i < n) {
    if (live !== null && !live[i]) { i++; continue }
    let j = i + 1
    while (j < n && (live === null || live[j])) j++
    fn(i, j)
    i = j
  }
}

/** Draws the line through (x[i], y[i]), one subpath per run of live points. */
export function traceLine(s: PathSink, curve: Curve, x: Float64Array, y: Float64Array, live: Uint8Array | null): void {
  const { run, param } = curve
  forEachRun(x.length, live, (lo, hi) => run(s, x, y, lo, hi, LINE, param))
}

/**
 * Draws the area between a top boundary (tx, ty) and a bottom boundary (bx, by), one outline per run of live
 * points: the top forwards, then the bottom backwards.
 */
export function traceArea(s: PathSink, curve: Curve, tx: Float64Array, ty: Float64Array, bx: Float64Array, by: Float64Array, live: Uint8Array | null): void {
  const { run, param } = curve
  const n = tx.length
  // the bottom boundary reversed once, so that a run [lo, hi) of it is [n - hi, n - lo) of the reversal
  const rx = new Float64Array(n)
  const ry = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    rx[n - 1 - i] = bx[i]!
    ry[n - 1 - i] = by[i]!
  }
  forEachRun(n, live, (lo, hi) => {
    run(s, tx, ty, lo, hi, TOP, param)
    run(s, rx, ry, n - hi, n - lo, BOTTOM, param)
  })
}

/** The path text of {@link traceLine}, rounded to `digits` decimals (`null` for none); '' when nothing is drawn. */
export function linePath(curve: Curve, x: Float64Array, y: Float64Array, live: Uint8Array | null, digits: number | null): string {
  const w = new PathWriter(digits)
  traceLine(w, curve, x, y, live)
  return w.d
}

/** The path text of {@link traceArea}, rounded to `digits` decimals (`null` for none); '' when nothing is drawn. */
export function areaPath(curve: Curve, tx: Float64Array, ty: Float64Array, bx: Float64Array, by: Float64Array, live: Uint8Array | null, digits: number | null): string {
  const w = new PathWriter(digits)
  traceArea(w, curve, tx, ty, bx, by, live)
  return w.d
}
