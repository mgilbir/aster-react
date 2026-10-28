/**
 * Line/area shape generation — a faithful port of the d3-shape (3.2.0)
 * surface the renderer uses (line, area, and the 19 curve families Vega's
 * `interpolate` channel names) on top of a faithful port of d3-path's Path
 * serializer. Pinned by a live differential against d3-shape
 * (`conformance/scripts/differential-d3-shape.test.mts`).
 *
 * Not ported here: arc, pie, symbols, radial shapes, stack. The renderer
 * draws rects, rules and symbols with its own path builders; those shapes
 * join when the canvas renderer needs them.
 *
 * Quirks that are upstream's and therefore ours: `digits` defaults to 3
 * (every coordinate is rounded to 3 decimals in the string), `area().y0()`
 * defaults to a constant 0, monotone ignores coincident points, and an empty
 * or all-undefined line renders as `null` rather than a string.
 */

// --- d3-path: the Path serializer --------------------------------------------

const pi = Math.PI
const tau = 2 * pi
const epsilon = 1e-6
const tauEpsilon = tau - epsilon

function append(this: { _: string }, strings: TemplateStringsArray, ...values: unknown[]): void {
  this._ += strings[0]
  for (let i = 1, n = strings.length; i < n; ++i) {
    this._ += String(values[i - 1]) + strings[i]
  }
}

function appendRound(digits: number): typeof append {
  const d = Math.floor(digits)
  if (!(d >= 0)) throw new Error(`invalid digits: ${digits}`)
  if (d > 15) return append
  const k = 10 ** d
  return function (this: { _: string }, strings: TemplateStringsArray, ...values: unknown[]): void {
    this._ += strings[0]
    for (let i = 1, n = strings.length; i < n; ++i) {
      this._ += String(Math.round((values[i - 1] as number) * k) / k) + strings[i]
    }
  } as typeof append
}

export class Path {
  private _x0: number | null
  private _y0: number | null
  private _x1: number | null
  private _y1: number | null
  private _: string
  private _append: (strings: TemplateStringsArray, ...values: unknown[]) => void

  /** The rounding factor (10 ** digits) of the hot commands, or 0 for full precision; same output as `_append`. */
  private _k: number

  constructor(digits?: number) {
    this._x0 = this._y0 = // start of current subpath
    this._x1 = this._y1 = null as unknown as number // end of current subpath
    this._ = ''
    this._append = digits == null ? append : appendRound(digits)
    this._k = digits == null ? 0 : (Math.floor(digits) <= 15 ? 10 ** Math.floor(digits) : 0)
  }

  moveTo(x: number, y: number): void {
    this._x0 = this._x1 = +x
    this._y0 = this._y1 = +y
    const k = this._k
    this._ += k ? 'M' + Math.round(this._x0 * k) / k + ',' + Math.round(this._y0 * k) / k : 'M' + this._x0 + ',' + this._y0
  }

  closePath(): void {
    if (this._x1 !== null) {
      this._x1 = this._x0, this._y1 = this._y0
      this._append`Z`
    }
  }

  lineTo(x: number, y: number): void {
    this._x1 = +x
    this._y1 = +y
    const k = this._k
    this._ += k ? 'L' + Math.round(this._x1 * k) / k + ',' + Math.round(this._y1 * k) / k : 'L' + this._x1 + ',' + this._y1
  }

  quadraticCurveTo(x1: number, y1: number, x: number, y: number): void {
    this._append`Q${+x1},${+y1},${this._x1 = +x},${this._y1 = +y}`
  }

  bezierCurveTo(x1: number, y1: number, x2: number, y2: number, x: number, y: number): void {
    this._append`C${+x1},${+y1},${+x2},${+y2},${this._x1 = +x},${this._y1 = +y}`
  }

  arcTo(x1: number, y1: number, x2: number, y2: number, r: number): void {
    x1 = +x1, y1 = +y1, x2 = +x2, y2 = +y2, r = +r
    // Is the radius negative? Error.
    if (r < 0) throw new Error(`negative radius: ${r}`)
    const x0 = this._x1 as number
    const y0 = this._y1 as number
    const x21 = x2 - x1
    const y21 = y2 - y1
    const x01 = x0 - x1
    const y01 = y0 - y1
    const l01_2 = x01 * x01 + y01 * y01
    // Is this path empty? Move to (x1,y1).
    if (this._x1 === null) {
      this._append`M${this._x1 = x1},${this._y1 = y1}`
    }
    // Or, is (x1,y1) coincident with (x0,y0)? Do nothing.
    else if (!(l01_2 > epsilon)) {
      // do nothing
    }
    // Or, are (x0,y0), (x1,y1) and (x2,y2) collinear?
    // Equivalently, is (x1,y1) coincident with (x2,y2)?
    // Or, is the radius zero? Line to (x1,y1).
    else if (!(Math.abs(y01 * x21 - y21 * x01) > epsilon) || !r) {
      this._append`L${this._x1 = x1},${this._y1 = y1}`
    }
    // Otherwise, draw an arc!
    else {
      const x20 = x2 - x0
      const y20 = y2 - y0
      const l21_2 = x21 * x21 + y21 * y21
      const l20_2 = x20 * x20 + y20 * y20
      const l21 = Math.sqrt(l21_2)
      const l01 = Math.sqrt(l01_2)
      const l = r * Math.tan((pi - Math.acos((l21_2 + l01_2 - l20_2) / (2 * l21 * l01))) / 2)
      const t01 = l / l01
      const t21 = l / l21
      // If the start tangent is not coincident with (x0,y0), line to.
      if (Math.abs(t01 - 1) > epsilon) {
        this._append`L${x1 + t01 * x01},${y1 + t01 * y01}`
      }
      this._append`A${r},${r},0,0,${+(y01 * x20 > x01 * y20)},${this._x1 = x1 + t21 * x21},${this._y1 = y1 + t21 * y21}`
    }
  }

  arc(x: number, y: number, r: number, a0: number, a1: number, ccw?: boolean): void {
    x = +x, y = +y, r = +r, ccw = !!ccw
    // Is the radius negative? Error.
    if (r < 0) throw new Error(`negative radius: ${r}`)
    const dx = r * Math.cos(a0)
    const dy = r * Math.sin(a0)
    const x0 = x + dx
    const y0 = y + dy
    const cw = 1 ^ (ccw ? 1 : 0)
    let da = ccw ? a0 - a1 : a1 - a0
    // Is this path empty? Move to (x0,y0).
    if (this._x1 === null) {
      this._append`M${x0},${y0}`
    }
    // Or, is (x0,y0) not coincident with the previous point? Line to (x0,y0).
    else if (Math.abs((this._x1 as number) - x0) > epsilon || Math.abs((this._y1 as number) - y0) > epsilon) {
      this._append`L${x0},${y0}`
    }
    // Is this arc empty? We're done.
    if (!r) return
    // Does the angle go the wrong way? Flip the direction.
    if (da < 0) da = da % tau + tau
    // Is this a complete circle? Draw two arcs to complete the circle.
    if (da > tauEpsilon) {
      this._append`A${r},${r},0,1,${cw},${x - dx},${y - dy}A${r},${r},0,1,${cw},${this._x1 = x0},${this._y1 = y0}`
    }
    // Is this arc non-empty? Draw an arc!
    else if (da > epsilon) {
      this._append`A${r},${r},0,${+(da >= pi)},${cw},${this._x1 = x + r * Math.cos(a1)},${this._y1 = y + r * Math.sin(a1)}`
    }
  }

  rect(x: number, y: number, w: number, h: number): void {
    this._append`M${this._x0 = this._x1 = +x},${this._y0 = this._y1 = +y}h${w = +w}v${+h}h${-w}Z`
  }

  toString(): string {
    return this._
  }
}

// --- small helpers (d3-shape's constant/point/array/noop) --------------------

function constant(x: unknown): (...args: never[]) => unknown {
  return function () {
    return x
  }
}

function pointX(p: unknown): unknown {
  return (p as unknown[])[0]
}
function pointY(p: unknown): unknown {
  return (p as unknown[])[1]
}

function array(x: unknown): unknown[] {
  return typeof x === 'object' && x !== null && 'length' in (x as object)
    ? (x as unknown[])
    : Array.from(x as Iterable<unknown>)
}

// eslint-disable-next-line @typescript-eslint/no-empty-function
function noop(): void {}

// --- curve context contract ---------------------------------------------------

export interface CurveContext {
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  bezierCurveTo(x1: number, y1: number, x2: number, y2: number, x: number, y: number): void
  closePath(): void
}

export interface Curve {
  areaStart(): void
  areaEnd(): void
  lineStart(): void
  lineEnd(): void
  point(x: number, y: number): void
}

export type CurveFactory = ((context: CurveContext) => Curve) & {
  beta?(beta: number): CurveFactory
  tension?(tension: number): CurveFactory
  alpha?(alpha: number): CurveFactory
}

// --- curve/linear -------------------------------------------------------------

class Linear implements Curve {
  _context: CurveContext
  _line!: number
  _point: number
  constructor(context: CurveContext) {
    this._context = context
    this._point = 0
  }
  areaStart(): void {
    this._line = 0
  }
  areaEnd(): void {
    this._line = NaN
  }
  lineStart(): void {
    this._point = 0
  }
  lineEnd(): void {
    if (this._line || (this._line !== 0 && this._point === 1)) this._context.closePath()
    this._line = 1 - this._line
  }
  point(x: number, y: number): void {
    x = +x, y = +y
    switch (this._point) {
      case 0: this._point = 1; this._line ? this._context.lineTo(x, y) : this._context.moveTo(x, y); break
      case 1: this._point = 2 // falls through
      default: this._context.lineTo(x, y); break
    }
  }
}

export function curveLinear(context: CurveContext): Curve {
  return new Linear(context)
}

// --- curve/linearClosed -------------------------------------------------------

class LinearClosed implements Curve {
  _context: CurveContext
  _point: number
  constructor(context: CurveContext) {
    this._context = context
    this._point = 0
  }
  areaStart(): void {
    noop()
  }
  areaEnd(): void {
    noop()
  }
  lineStart(): void {
    this._point = 0
  }
  lineEnd(): void {
    if (this._point) this._context.closePath()
  }
  point(x: number, y: number): void {
    x = +x, y = +y
    if (this._point) this._context.lineTo(x, y)
    else this._point = 1, this._context.moveTo(x, y)
  }
}

export function curveLinearClosed(context: CurveContext): Curve {
  return new LinearClosed(context)
}

// --- curve/basis --------------------------------------------------------------

function basisPoint(that: Basis, x: number, y: number): void {
  that._context.bezierCurveTo(
    (2 * that._x0 + that._x1) / 3,
    (2 * that._y0 + that._y1) / 3,
    (that._x0 + 2 * that._x1) / 3,
    (that._y0 + 2 * that._y1) / 3,
    (that._x0 + 4 * that._x1 + x) / 6,
    (that._y0 + 4 * that._y1 + y) / 6,
  )
}

class Basis implements Curve {
  _context: CurveContext
  _line!: number
  _point: number
  _x0 = NaN
  _x1 = NaN
  _y0 = NaN
  _y1 = NaN
  constructor(context: CurveContext) {
    this._context = context
    this._point = 0
  }
  areaStart(): void {
    this._line = 0
  }
  areaEnd(): void {
    this._line = NaN
  }
  lineStart(): void {
    this._x0 = this._x1 =
    this._y0 = this._y1 = NaN
    this._point = 0
  }
  lineEnd(): void {
    switch (this._point) {
      case 3: basisPoint(this, this._x1, this._y1) // falls through
      case 2: this._context.lineTo(this._x1, this._y1); break
    }
    if (this._line || (this._line !== 0 && this._point === 1)) this._context.closePath()
    this._line = 1 - this._line
  }
  point(x: number, y: number): void {
    x = +x, y = +y
    switch (this._point) {
      case 0: this._point = 1; this._line ? this._context.lineTo(x, y) : this._context.moveTo(x, y); break
      case 1: this._point = 2; break
      case 2: this._point = 3; this._context.lineTo((5 * this._x0 + this._x1) / 6, (5 * this._y0 + this._y1) / 6) // falls through
      default: basisPoint(this, x, y); break
    }
    this._x0 = this._x1, this._x1 = x
    this._y0 = this._y1, this._y1 = y
  }
}

export function curveBasis(context: CurveContext): Curve {
  return new Basis(context)
}

// --- curve/basisClosed --------------------------------------------------------

class BasisClosed implements Curve {
  _context: CurveContext
  _point: number
  _x0 = NaN; _x1 = NaN; _x2 = NaN; _x3 = NaN; _x4 = NaN
  _y0 = NaN; _y1 = NaN; _y2 = NaN; _y3 = NaN; _y4 = NaN
  constructor(context: CurveContext) {
    this._context = context
    this._point = 0
  }
  areaStart(): void {
    noop()
  }
  areaEnd(): void {
    noop()
  }
  lineStart(): void {
    this._x0 = this._x1 = this._x2 = this._x3 = this._x4 =
    this._y0 = this._y1 = this._y2 = this._y3 = this._y4 = NaN
    this._point = 0
  }
  lineEnd(): void {
    switch (this._point) {
      case 1: {
        this._context.moveTo(this._x2, this._y2)
        this._context.closePath()
        break
      }
      case 2: {
        this._context.moveTo((this._x2 + 2 * this._x3) / 3, (this._y2 + 2 * this._y3) / 3)
        this._context.lineTo((this._x3 + 2 * this._x2) / 3, (this._y3 + 2 * this._y2) / 3)
        this._context.closePath()
        break
      }
      case 3: {
        this.point(this._x2, this._y2)
        this.point(this._x3, this._y3)
        this.point(this._x4, this._y4)
        break
      }
    }
  }
  point(x: number, y: number): void {
    x = +x, y = +y
    switch (this._point) {
      case 0: this._point = 1; this._x2 = x, this._y2 = y; break
      case 1: this._point = 2; this._x3 = x, this._y3 = y; break
      case 2: this._point = 3; this._x4 = x, this._y4 = y; this._context.moveTo((this._x0 + 4 * this._x1 + x) / 6, (this._y0 + 4 * this._y1 + y) / 6); break
      default: basisPoint(this as unknown as Basis, x, y); break
    }
    this._x0 = this._x1, this._x1 = x
    this._y0 = this._y1, this._y1 = y
  }
}

export function curveBasisClosed(context: CurveContext): Curve {
  return new BasisClosed(context)
}

// --- curve/basisOpen ----------------------------------------------------------

class BasisOpen implements Curve {
  _context: CurveContext
  _line!: number
  _point: number
  _x0 = NaN; _x1 = NaN
  _y0 = NaN; _y1 = NaN
  constructor(context: CurveContext) {
    this._context = context
    this._point = 0
  }
  areaStart(): void {
    this._line = 0
  }
  areaEnd(): void {
    this._line = NaN
  }
  lineStart(): void {
    this._x0 = this._x1 =
    this._y0 = this._y1 = NaN
    this._point = 0
  }
  lineEnd(): void {
    if (this._line || (this._line !== 0 && this._point === 3)) this._context.closePath()
    this._line = 1 - this._line
  }
  point(x: number, y: number): void {
    x = +x, y = +y
    switch (this._point) {
      case 0: this._point = 1; break
      case 1: this._point = 2; break
      case 2: this._point = 3; {
        const x0 = (this._x0 + 4 * this._x1 + x) / 6
        const y0 = (this._y0 + 4 * this._y1 + y) / 6
        this._line ? this._context.lineTo(x0, y0) : this._context.moveTo(x0, y0)
        break
      }
      case 3: this._point = 4 // falls through
      default: basisPoint(this as unknown as Basis, x, y); break
    }
    this._x0 = this._x1, this._x1 = x
    this._y0 = this._y1, this._y1 = y
  }
}

export function curveBasisOpen(context: CurveContext): Curve {
  return new BasisOpen(context)
}

// --- curve/bundle -------------------------------------------------------------

class Bundle implements Curve {
  _basis: Basis
  _beta: number
  _x: number[] = []
  _y: number[] = []
  constructor(context: CurveContext, beta: number) {
    this._basis = new Basis(context)
    this._beta = beta
  }
  // upstream's Bundle prototype has no area hooks (it is a line-only curve)
  areaStart(): void {
    noop()
  }
  areaEnd(): void {
    noop()
  }
  lineStart(): void {
    this._x = []
    this._y = []
    this._basis.lineStart()
  }
  lineEnd(): void {
    const x = this._x
    const y = this._y
    const j = x.length - 1
    if (j > 0) {
      const x0 = x[0] as number
      const y0 = y[0] as number
      const dx = (x[j] as number) - x0
      const dy = (y[j] as number) - y0
      let i = -1
      let t: number
      while (++i <= j) {
        t = i / j
        this._basis.point(
          this._beta * (x[i] as number) + (1 - this._beta) * (x0 + t * dx),
          this._beta * (y[i] as number) + (1 - this._beta) * (y0 + t * dy),
        )
      }
    }
    this._x = this._y = []
    this._basis.lineEnd()
  }
  point(x: number, y: number): void {
    this._x.push(+x)
    this._y.push(+y)
  }
}

export function curveBundleCustom(beta: number): CurveFactory {
  function bundle(context: CurveContext): Curve {
    return beta === 1 ? new Basis(context) : new Bundle(context, beta)
  }
  const factory = bundle as CurveFactory
  factory.beta = function (b: number) {
    return curveBundleCustom(+b)
  }
  return factory
}

export const curveBundle = curveBundleCustom(0.85)

// --- curve/cardinal -----------------------------------------------------------

function cardinalPoint(that: Cardinal, x: number, y: number): void {
  that._context.bezierCurveTo(
    that._x1 + that._k * (that._x2 - that._x0),
    that._y1 + that._k * (that._y2 - that._y0),
    that._x2 + that._k * (that._x1 - x),
    that._y2 + that._k * (that._y1 - y),
    that._x2,
    that._y2,
  )
}

class Cardinal implements Curve {
  _context: CurveContext
  _k: number
  _line!: number
  _point: number
  _x0 = NaN; _x1 = NaN; _x2 = NaN
  _y0 = NaN; _y1 = NaN; _y2 = NaN
  constructor(context: CurveContext, tension: number) {
    this._context = context
    this._k = (1 - tension) / 6
    this._point = 0
  }
  areaStart(): void {
    this._line = 0
  }
  areaEnd(): void {
    this._line = NaN
  }
  lineStart(): void {
    this._x0 = this._x1 = this._x2 =
    this._y0 = this._y1 = this._y2 = NaN
    this._point = 0
  }
  lineEnd(): void {
    switch (this._point) {
      case 2: this._context.lineTo(this._x2, this._y2); break
      case 3: cardinalPoint(this, this._x1, this._y1); break
    }
    if (this._line || (this._line !== 0 && this._point === 1)) this._context.closePath()
    this._line = 1 - this._line
  }
  point(x: number, y: number): void {
    x = +x, y = +y
    switch (this._point) {
      case 0: this._point = 1; this._line ? this._context.lineTo(x, y) : this._context.moveTo(x, y); break
      case 1: this._point = 2; this._x1 = x, this._y1 = y; break
      case 2: this._point = 3 // falls through
      default: cardinalPoint(this, x, y); break
    }
    this._x0 = this._x1, this._x1 = this._x2, this._x2 = x
    this._y0 = this._y1, this._y1 = this._y2, this._y2 = y
  }
}

export function curveCardinalCustom(tension: number): CurveFactory {
  function cardinal(context: CurveContext): Curve {
    return new Cardinal(context, tension)
  }
  const factory = cardinal as CurveFactory
  factory.tension = function (t: number) {
    return curveCardinalCustom(+t)
  }
  return factory
}

export const curveCardinal = curveCardinalCustom(0)

// --- curve/cardinalClosed -----------------------------------------------------

class CardinalClosed implements Curve {
  _context: CurveContext
  _k: number
  _point: number
  _x0 = NaN; _x1 = NaN; _x2 = NaN; _x3 = NaN; _x4 = NaN; _x5 = NaN
  _y0 = NaN; _y1 = NaN; _y2 = NaN; _y3 = NaN; _y4 = NaN; _y5 = NaN
  constructor(context: CurveContext, tension: number) {
    this._context = context
    this._k = (1 - tension) / 6
    this._point = 0
  }
  areaStart(): void {
    noop()
  }
  areaEnd(): void {
    noop()
  }
  lineStart(): void {
    this._x0 = this._x1 = this._x2 = this._x3 = this._x4 = this._x5 =
    this._y0 = this._y1 = this._y2 = this._y3 = this._y4 = this._y5 = NaN
    this._point = 0
  }
  lineEnd(): void {
    switch (this._point) {
      case 1: {
        this._context.moveTo(this._x3, this._y3)
        this._context.closePath()
        break
      }
      case 2: {
        this._context.lineTo(this._x3, this._y3)
        this._context.closePath()
        break
      }
      case 3: {
        this.point(this._x3, this._y3)
        this.point(this._x4, this._y4)
        this.point(this._x5, this._y5)
        break
      }
    }
  }
  point(x: number, y: number): void {
    x = +x, y = +y
    switch (this._point) {
      case 0: this._point = 1; this._x3 = x, this._y3 = y; break
      case 1: this._point = 2; this._context.moveTo(this._x4 = x, this._y4 = y); break
      case 2: this._point = 3; this._x5 = x, this._y5 = y; break
      default: cardinalPoint(this as unknown as Cardinal, x, y); break
    }
    this._x0 = this._x1, this._x1 = this._x2, this._x2 = x
    this._y0 = this._y1, this._y1 = this._y2, this._y2 = y
  }
}

export function curveCardinalClosedCustom(tension: number): CurveFactory {
  function cardinal(context: CurveContext): Curve {
    return new CardinalClosed(context, tension)
  }
  const factory = cardinal as CurveFactory
  factory.tension = function (t: number) {
    return curveCardinalClosedCustom(+t)
  }
  return factory
}

export const curveCardinalClosed = curveCardinalClosedCustom(0)

// --- curve/cardinalOpen -------------------------------------------------------

class CardinalOpen implements Curve {
  _context: CurveContext
  _k: number
  _line!: number
  _point: number
  _x0 = NaN; _x1 = NaN; _x2 = NaN
  _y0 = NaN; _y1 = NaN; _y2 = NaN
  constructor(context: CurveContext, tension: number) {
    this._context = context
    this._k = (1 - tension) / 6
    this._point = 0
  }
  areaStart(): void {
    this._line = 0
  }
  areaEnd(): void {
    this._line = NaN
  }
  lineStart(): void {
    this._x0 = this._x1 = this._x2 =
    this._y0 = this._y1 = this._y2 = NaN
    this._point = 0
  }
  lineEnd(): void {
    if (this._line || (this._line !== 0 && this._point === 3)) this._context.closePath()
    this._line = 1 - this._line
  }
  point(x: number, y: number): void {
    x = +x, y = +y
    switch (this._point) {
      case 0: this._point = 1; break
      case 1: this._point = 2; break
      case 2: this._point = 3; this._line ? this._context.lineTo(this._x2, this._y2) : this._context.moveTo(this._x2, this._y2); break
      case 3: this._point = 4 // falls through
      default: cardinalPoint(this as unknown as Cardinal, x, y); break
    }
    this._x0 = this._x1, this._x1 = this._x2, this._x2 = x
    this._y0 = this._y1, this._y1 = this._y2, this._y2 = y
  }
}

export function curveCardinalOpenCustom(tension: number): CurveFactory {
  function cardinal(context: CurveContext): Curve {
    return new CardinalOpen(context, tension)
  }
  const factory = cardinal as CurveFactory
  factory.tension = function (t: number) {
    return curveCardinalOpenCustom(+t)
  }
  return factory
}

export const curveCardinalOpen = curveCardinalOpenCustom(0)

// --- curve/catmullRom ---------------------------------------------------------

const catmullEpsilon = 1e-12

function catmullPoint(that: CatmullRom | CatmullRomClosed | CatmullRomOpen, x: number, y: number): void {
  const x1 = that._x1
  const y1 = that._y1
  const x2 = that._x2
  const y2 = that._y2
  let bx1 = x1
  let by1 = y1
  let bx2 = x2
  let by2 = y2
  if (that._l01_a > catmullEpsilon) {
    const a = 2 * that._l01_2a + 3 * that._l01_a * that._l12_a + that._l12_2a
    const n = 3 * that._l01_a * (that._l01_a + that._l12_a)
    bx1 = (x1 * a - that._x0 * that._l12_2a + that._x2 * that._l01_2a) / n
    by1 = (y1 * a - that._y0 * that._l12_2a + that._y2 * that._l01_2a) / n
  }
  if (that._l23_a > catmullEpsilon) {
    const b = 2 * that._l23_2a + 3 * that._l23_a * that._l12_a + that._l12_2a
    const m = 3 * that._l23_a * (that._l23_a + that._l12_a)
    bx2 = (x2 * b + that._x1 * that._l23_2a - x * that._l12_2a) / m
    by2 = (y2 * b + that._y1 * that._l23_2a - y * that._l12_2a) / m
  }
  that._context.bezierCurveTo(bx1, by1, bx2, by2, that._x2, that._y2)
}

class CatmullRom implements Curve {
  _context: CurveContext
  _alpha: number
  _line!: number
  _point: number
  _x0 = NaN; _x1 = NaN; _x2 = NaN
  _y0 = NaN; _y1 = NaN; _y2 = NaN
  _l01_a = 0; _l12_a = 0; _l23_a = 0
  _l01_2a = 0; _l12_2a = 0; _l23_2a = 0
  constructor(context: CurveContext, alpha: number) {
    this._context = context
    this._alpha = alpha
    this._point = 0
  }
  areaStart(): void {
    this._line = 0
  }
  areaEnd(): void {
    this._line = NaN
  }
  lineStart(): void {
    this._x0 = this._x1 = this._x2 =
    this._y0 = this._y1 = this._y2 = NaN
    this._l01_a = this._l12_a = this._l23_a =
    this._l01_2a = this._l12_2a = this._l23_2a =
    this._point = 0
  }
  lineEnd(): void {
    switch (this._point) {
      case 2: this._context.lineTo(this._x2, this._y2); break
      // through the prototype point, which recomputes the distances (x == _x2)
      case 3: this.point(this._x2, this._y2); break
    }
    if (this._line || (this._line !== 0 && this._point === 1)) this._context.closePath()
    this._line = 1 - this._line
  }
  point(x: number, y: number): void {
    x = +x, y = +y
    if (this._point) {
      const x23 = this._x2 - x
      const y23 = this._y2 - y
      this._l23_a = Math.sqrt(this._l23_2a = Math.pow(x23 * x23 + y23 * y23, this._alpha))
    }
    switch (this._point) {
      case 0: this._point = 1; this._line ? this._context.lineTo(x, y) : this._context.moveTo(x, y); break
      case 1: this._point = 2; break
      case 2: this._point = 3 // falls through
      default: catmullPoint(this, x, y); break
    }
    this._l01_a = this._l12_a, this._l12_a = this._l23_a
    this._l01_2a = this._l12_2a, this._l12_2a = this._l23_2a
    this._x0 = this._x1, this._x1 = this._x2, this._x2 = x
    this._y0 = this._y1, this._y1 = this._y2, this._y2 = y
  }
}

export function curveCatmullRomCustom(alpha: number): CurveFactory {
  function catmullRom(context: CurveContext): Curve {
    return alpha ? new CatmullRom(context, alpha) : new Cardinal(context, 0)
  }
  const factory = catmullRom as CurveFactory
  factory.alpha = function (a: number) {
    return curveCatmullRomCustom(+a)
  }
  return factory
}

export const curveCatmullRom = curveCatmullRomCustom(0.5)

// --- curve/catmullRomClosed ---------------------------------------------------

class CatmullRomClosed implements Curve {
  _context: CurveContext
  _alpha: number
  _point: number
  _x0 = NaN; _x1 = NaN; _x2 = NaN; _x3 = NaN; _x4 = NaN; _x5 = NaN
  _y0 = NaN; _y1 = NaN; _y2 = NaN; _y3 = NaN; _y4 = NaN; _y5 = NaN
  _l01_a = 0; _l12_a = 0; _l23_a = 0
  _l01_2a = 0; _l12_2a = 0; _l23_2a = 0
  constructor(context: CurveContext, alpha: number) {
    this._context = context
    this._alpha = alpha
    this._point = 0
  }
  areaStart(): void {
    noop()
  }
  areaEnd(): void {
    noop()
  }
  lineStart(): void {
    this._x0 = this._x1 = this._x2 = this._x3 = this._x4 = this._x5 =
    this._y0 = this._y1 = this._y2 = this._y3 = this._y4 = this._y5 = NaN
    this._l01_a = this._l12_a = this._l23_a =
    this._l01_2a = this._l12_2a = this._l23_2a =
    this._point = 0
  }
  lineEnd(): void {
    switch (this._point) {
      case 1: {
        this._context.moveTo(this._x3, this._y3)
        this._context.closePath()
        break
      }
      case 2: {
        this._context.lineTo(this._x3, this._y3)
        this._context.closePath()
        break
      }
      case 3: {
        this.point(this._x3, this._y3)
        this.point(this._x4, this._y4)
        this.point(this._x5, this._y5)
        break
      }
    }
  }
  point(x: number, y: number): void {
    x = +x, y = +y
    if (this._point) {
      const x23 = this._x2 - x
      const y23 = this._y2 - y
      this._l23_a = Math.sqrt(this._l23_2a = Math.pow(x23 * x23 + y23 * y23, this._alpha))
    }
    switch (this._point) {
      case 0: this._point = 1; this._x3 = x, this._y3 = y; break
      case 1: this._point = 2; this._context.moveTo(this._x4 = x, this._y4 = y); break
      case 2: this._point = 3; this._x5 = x, this._y5 = y; break
      default: catmullPoint(this, x, y); break
    }
    this._l01_a = this._l12_a, this._l12_a = this._l23_a
    this._l01_2a = this._l12_2a, this._l12_2a = this._l23_2a
    this._x0 = this._x1, this._x1 = this._x2, this._x2 = x
    this._y0 = this._y1, this._y1 = this._y2, this._y2 = y
  }
}

export function curveCatmullRomClosedCustom(alpha: number): CurveFactory {
  function catmullRom(context: CurveContext): Curve {
    return alpha ? new CatmullRomClosed(context, alpha) : new CardinalClosed(context, 0)
  }
  const factory = catmullRom as CurveFactory
  factory.alpha = function (a: number) {
    return curveCatmullRomClosedCustom(+a)
  }
  return factory
}

export const curveCatmullRomClosed = curveCatmullRomClosedCustom(0.5)

// --- curve/catmullRomOpen -----------------------------------------------------

class CatmullRomOpen implements Curve {
  _context: CurveContext
  _alpha: number
  _line!: number
  _point: number
  _x0 = NaN; _x1 = NaN; _x2 = NaN
  _y0 = NaN; _y1 = NaN; _y2 = NaN
  _l01_a = 0; _l12_a = 0; _l23_a = 0
  _l01_2a = 0; _l12_2a = 0; _l23_2a = 0
  constructor(context: CurveContext, alpha: number) {
    this._context = context
    this._alpha = alpha
    this._point = 0
  }
  areaStart(): void {
    this._line = 0
  }
  areaEnd(): void {
    this._line = NaN
  }
  lineStart(): void {
    this._x0 = this._x1 = this._x2 =
    this._y0 = this._y1 = this._y2 = NaN
    this._l01_a = this._l12_a = this._l23_a =
    this._l01_2a = this._l12_2a = this._l23_2a =
    this._point = 0
  }
  lineEnd(): void {
    if (this._line || (this._line !== 0 && this._point === 3)) this._context.closePath()
    this._line = 1 - this._line
  }
  point(x: number, y: number): void {
    x = +x, y = +y
    if (this._point) {
      const x23 = this._x2 - x
      const y23 = this._y2 - y
      this._l23_a = Math.sqrt(this._l23_2a = Math.pow(x23 * x23 + y23 * y23, this._alpha))
    }
    switch (this._point) {
      case 0: this._point = 1; break
      case 1: this._point = 2; break
      case 2: this._point = 3; this._line ? this._context.lineTo(this._x2, this._y2) : this._context.moveTo(this._x2, this._y2); break
      case 3: this._point = 4 // falls through
      default: catmullPoint(this, x, y); break
    }
    this._l01_a = this._l12_a, this._l12_a = this._l23_a
    this._l01_2a = this._l12_2a, this._l12_2a = this._l23_2a
    this._x0 = this._x1, this._x1 = this._x2, this._x2 = x
    this._y0 = this._y1, this._y1 = this._y2, this._y2 = y
  }
}

export function curveCatmullRomOpenCustom(alpha: number): CurveFactory {
  function catmullRom(context: CurveContext): Curve {
    return alpha ? new CatmullRomOpen(context, alpha) : new CardinalOpen(context, 0)
  }
  const factory = catmullRom as CurveFactory
  factory.alpha = function (a: number) {
    return curveCatmullRomOpenCustom(+a)
  }
  return factory
}

export const curveCatmullRomOpen = curveCatmullRomOpenCustom(0.5)

// --- curve/monotone -----------------------------------------------------------

function sign(x: number): number {
  return x < 0 ? -1 : 1
}

// Calculate the slopes of the tangents (Hermite-type interpolation) based on
// the following paper: Steffen, M. 1990. A Simple Method for Monotonic
// Interpolation in One Dimension. Astronomy and Astrophysics, Vol. 239, NO.
// NOV(II), P. 443, 1990.
function slope3(that: MonotoneX, x2: number, y2: number): number {
  const h0 = that._x1 - that._x0
  const h1 = x2 - that._x1
  const s0 = (that._y1 - that._y0) / (h0 ? h0 : (h1 < 0 ? -0 : 0))
  const s1 = (y2 - that._y1) / (h1 ? h1 : (h0 < 0 ? -0 : 0))
  const p = (s0 * h1 + s1 * h0) / (h0 + h1)
  return (sign(s0) + sign(s1)) * Math.min(Math.abs(s0), Math.abs(s1), 0.5 * Math.abs(p)) || 0
}

// Calculate a one-sided slope.
function slope2(that: MonotoneX, t: number): number {
  const h = that._x1 - that._x0
  return h ? (3 * (that._y1 - that._y0) / h - t) / 2 : t
}

// According to https://en.wikipedia.org/wiki/Cubic_Hermite_spline#Representations
// "you can express cubic Hermite interpolation in terms of cubic Bézier curves
// with respect to the four values p0, p0 + m0 / 3, p1 - m1 / 3, p1".
function monotonePoint(that: MonotoneX, t0: number, t1: number): void {
  const x0 = that._x0
  const y0 = that._y0
  const x1 = that._x1
  const y1 = that._y1
  const dx = (x1 - x0) / 3
  that._context.bezierCurveTo(x0 + dx, y0 + dx * t0, x1 - dx, y1 - dx * t1, x1, y1)
}

class MonotoneX implements Curve {
  _context: CurveContext
  _line!: number
  _point: number
  _x0 = NaN; _x1 = NaN
  _y0 = NaN; _y1 = NaN
  _t0 = NaN
  constructor(context: CurveContext) {
    this._context = context
    this._point = 0
  }
  areaStart(): void {
    this._line = 0
  }
  areaEnd(): void {
    this._line = NaN
  }
  lineStart(): void {
    this._x0 = this._x1 =
    this._y0 = this._y1 =
    this._t0 = NaN
    this._point = 0
  }
  lineEnd(): void {
    switch (this._point) {
      case 2: this._context.lineTo(this._x1, this._y1); break
      case 3: monotonePoint(this, this._t0, slope2(this, this._t0)); break
    }
    if (this._line || (this._line !== 0 && this._point === 1)) this._context.closePath()
    this._line = 1 - this._line
  }
  point(x: number, y: number): void {
    let t1 = NaN
    x = +x, y = +y
    if (x === this._x1 && y === this._y1) return // Ignore coincident points.
    switch (this._point) {
      case 0: this._point = 1; this._line ? this._context.lineTo(x, y) : this._context.moveTo(x, y); break
      case 1: this._point = 2; break
      case 2: this._point = 3; monotonePoint(this, slope2(this, t1 = slope3(this, x, y)), t1); break
      default: monotonePoint(this, this._t0, t1 = slope3(this, x, y)); break
    }
    this._x0 = this._x1, this._x1 = x
    this._y0 = this._y1, this._y1 = y
    this._t0 = t1
  }
}

class ReflectContext implements CurveContext {
  _context: CurveContext
  constructor(context: CurveContext) {
    this._context = context
  }
  moveTo(x: number, y: number): void { this._context.moveTo(y, x) }
  closePath(): void { this._context.closePath() }
  lineTo(x: number, y: number): void { this._context.lineTo(y, x) }
  bezierCurveTo(x1: number, y1: number, x2: number, y2: number, x: number, y: number): void {
    this._context.bezierCurveTo(y1, x1, y2, x2, y, x)
  }
}

class MonotoneY implements Curve {
  private _monotone: MonotoneX
  constructor(context: CurveContext) {
    this._monotone = new MonotoneX(new ReflectContext(context))
  }
  areaStart(): void { this._monotone.areaStart() }
  areaEnd(): void { this._monotone.areaEnd() }
  lineStart(): void { this._monotone.lineStart() }
  lineEnd(): void { this._monotone.lineEnd() }
  point(x: number, y: number): void { this._monotone.point(y, x) }
}

export function curveMonotoneX(context: CurveContext): Curve {
  return new MonotoneX(context)
}

export function curveMonotoneY(context: CurveContext): Curve {
  return new MonotoneY(context)
}

// --- curve/natural ------------------------------------------------------------

// See https://www.particleincell.com/2012/bezier-splines/ for derivation.
function controlPoints(x: number[]): [number[], number[]] {
  let m: number
  const n = x.length - 1
  const a = new Array(n)
  const b = new Array(n)
  const r = new Array(n)
  a[0] = 0, b[0] = 2, r[0] = x[0] as number + 2 * (x[1] as number)
  for (let i = 1; i < n - 1; ++i) a[i] = 1, b[i] = 4, r[i] = 4 * (x[i] as number) + 2 * (x[i + 1] as number)
  a[n - 1] = 2, b[n - 1] = 7, r[n - 1] = 8 * (x[n - 1] as number) + (x[n] as number)
  for (let i = 1; i < n; ++i) m = (a[i] as number) / (b[i - 1] as number), b[i] = (b[i] as number) - m, r[i] = (r[i] as number) - m * (r[i - 1] as number)
  a[n - 1] = (r[n - 1] as number) / (b[n - 1] as number)
  for (let i = n - 2; i >= 0; --i) a[i] = ((r[i] as number) - (a[i + 1] as number)) / (b[i] as number)
  b[n - 1] = ((x[n] as number) + (a[n - 1] as number)) / 2
  for (let i = 0; i < n - 1; ++i) b[i] = 2 * (x[i + 1] as number) - (a[i + 1] as number)
  return [a as number[], b as number[]]
}

class Natural implements Curve {
  _context: CurveContext
  _line!: number
  _x: number[] = []
  _y: number[] = []
  constructor(context: CurveContext) {
    this._context = context
  }
  areaStart(): void {
    this._line = 0
  }
  areaEnd(): void {
    this._line = NaN
  }
  lineStart(): void {
    this._x = []
    this._y = []
  }
  lineEnd(): void {
    const x = this._x
    const y = this._y
    const n = x.length
    if (n) {
      this._line ? this._context.lineTo(x[0] as number, y[0] as number) : this._context.moveTo(x[0] as number, y[0] as number)
      if (n === 2) {
        this._context.lineTo(x[1] as number, y[1] as number)
      } else {
        const px = controlPoints(x)
        const py = controlPoints(y)
        for (let i0 = 0, i1 = 1; i1 < n; ++i0, ++i1) {
          this._context.bezierCurveTo(px[0][i0] as number, py[0][i0] as number, px[1][i0] as number, py[1][i0] as number, x[i1] as number, y[i1] as number)
        }
      }
    }
    if (this._line || (this._line !== 0 && n === 1)) this._context.closePath()
    this._line = 1 - this._line
    this._x = this._y = []
  }
  point(x: number, y: number): void {
    this._x.push(+x)
    this._y.push(+y)
  }
}

export function curveNatural(context: CurveContext): Curve {
  return new Natural(context)
}

// --- curve/step ---------------------------------------------------------------

class Step implements Curve {
  _context: CurveContext
  _t: number
  _line!: number
  _point: number
  _x = NaN
  _y = NaN
  constructor(context: CurveContext, t: number) {
    this._context = context
    this._t = t
    this._point = 0
  }
  areaStart(): void {
    this._line = 0
  }
  areaEnd(): void {
    this._line = NaN
  }
  lineStart(): void {
    this._x = this._y = NaN
    this._point = 0
  }
  lineEnd(): void {
    if (0 < this._t && this._t < 1 && this._point === 2) this._context.lineTo(this._x, this._y)
    if (this._line || (this._line !== 0 && this._point === 1)) this._context.closePath()
    if ((this._line as number) >= 0) this._t = 1 - this._t, this._line = 1 - this._line
  }
  point(x: number, y: number): void {
    x = +x, y = +y
    switch (this._point) {
      case 0: this._point = 1; this._line ? this._context.lineTo(x, y) : this._context.moveTo(x, y); break
      case 1: this._point = 2 // falls through
      default: {
        if (this._t <= 0) {
          this._context.lineTo(this._x, y)
          this._context.lineTo(x, y)
        } else {
          const x1 = this._x * (1 - this._t) + x * this._t
          this._context.lineTo(x1, this._y)
          this._context.lineTo(x1, y)
        }
        break
      }
    }
    this._x = x, this._y = y
  }
}

export function curveStep(context: CurveContext): Curve {
  return new Step(context, 0.5)
}

export function curveStepAfter(context: CurveContext): Curve {
  return new Step(context, 1)
}

export function curveStepBefore(context: CurveContext): Curve {
  return new Step(context, 0)
}

// --- line and area ------------------------------------------------------------

export interface LineGenerator {
  (data: Iterable<unknown>): string | null
  x(accessor: (d: unknown, i: number, data: unknown[]) => number): LineGenerator
  y(accessor: (d: unknown, i: number, data: unknown[]) => number): LineGenerator
  defined(accessor: (d: unknown, i: number, data: unknown[]) => boolean): LineGenerator
  curve(factory: CurveFactory): LineGenerator
  digits(): number | null
  digits(n: number | null): LineGenerator
}

export interface AreaGenerator {
  (data: Iterable<unknown>): string | null
  x(accessor: (d: unknown, i: number, data: unknown[]) => number): AreaGenerator
  x0(accessor: (d: unknown, i: number, data: unknown[]) => number): AreaGenerator
  x1(accessor: ((d: unknown, i: number, data: unknown[]) => number) | null): AreaGenerator
  y(accessor: (d: unknown, i: number, data: unknown[]) => number): AreaGenerator
  y0(accessor: (d: unknown, i: number, data: unknown[]) => number): AreaGenerator
  y1(accessor: ((d: unknown, i: number, data: unknown[]) => number) | null): AreaGenerator
  defined(accessor: (d: unknown, i: number, data: unknown[]) => boolean): AreaGenerator
  curve(factory: CurveFactory): AreaGenerator
  digits(): number | null
  digits(n: number | null): AreaGenerator
}

type Accessor = (d: unknown, i: number, data: unknown[]) => number

/** The shapes' shared digits state (d3-shape's `withPath`). */
function makePathFactory(shape: { digits?: (n: number | null) => unknown }): () => Path {
  let digits: number | null = 3
  // `shape` is the generator function itself, so this IS its public `.digits` (d3-shape's `withPath`).
  ;(shape as Record<string, unknown>).digits = function (_?: number | null) {
    if (arguments.length === 0) return digits
    if (_ == null) {
      digits = null
    } else {
      const d = Math.floor(_)
      if (!(d >= 0)) throw new RangeError(`invalid digits: ${_}`)
      digits = d
    }
    return shape
  }
  return () => new Path(digits as number | undefined)
}

export function line(): LineGenerator {
  let x: Accessor = pointX as Accessor
  let y: Accessor = pointY as Accessor
  let defined = constant(true) as unknown as (d: unknown, i: number, data: unknown[]) => boolean
  let curve: CurveFactory = curveLinear
  let context: CurveContext | null = null
  let output: Curve | null = null
  const path = makePathFactory(line as unknown as { digits?: (n: number | null) => unknown })

  function line(data: Iterable<unknown>): string | null {
    let d: unknown
    let defined0 = false
    let buffer: Path | undefined
    const arr = array(data)
    const n = arr.length
    if (context == null) output = curve(buffer = path())
    for (let i = 0; i <= n; ++i) {
      if (!(i < n && defined(d = arr[i], i, arr)) === defined0) {
        if ((defined0 = !defined0)) output!.lineStart()
        else output!.lineEnd()
      }
      if (defined0) output!.point(+(x(d, i, arr) as number), +(y(d, i, arr) as number))
    }
    if (buffer) return output = null, buffer + '' || null
    return null
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const gen = line as unknown as LineGenerator & Record<string, any>
  gen.x = function (_?: ((d: unknown, i: number, data: unknown[]) => number) | number) {
    return (arguments.length ? (x = (typeof _ === 'function' ? _ : constant(+(_ as number))) as Accessor, gen as LineGenerator) : x) as never
  }
  gen.y = function (_?: ((d: unknown, i: number, data: unknown[]) => number) | number) {
    return (arguments.length ? (y = (typeof _ === 'function' ? _ : constant(+(_ as number))) as Accessor, gen as LineGenerator) : y) as never
  }
  gen.defined = function (_?: ((d: unknown, i: number, data: unknown[]) => boolean) | boolean) {
    return (arguments.length ? (defined = (typeof _ === 'function' ? _ : constant(!!_)) as typeof defined, gen as LineGenerator) : defined) as never
  }
  gen.curve = function (_?: CurveFactory) {
    return (arguments.length ? (curve = _ as CurveFactory, context != null && (output = curve(context)), gen as LineGenerator) : curve) as never
  }
  gen.context = function (_?: CurveContext | null) {
    return (arguments.length ? (_ == null ? context = output = null : output = curve(context = _ as CurveContext), gen as LineGenerator) : context) as never
  }
  return gen
}

export function area(): AreaGenerator {
  let x0: Accessor = pointX as Accessor
  let x1: ((d: unknown, i: number, data: unknown[]) => number) | null = null
  let y0: Accessor = constant(0) as unknown as Accessor
  let y1: Accessor = pointY as Accessor
  let defined = constant(true) as unknown as (d: unknown, i: number, data: unknown[]) => boolean
  let curve: CurveFactory = curveLinear
  let context: CurveContext | null = null
  let output: Curve | null = null
  const path = makePathFactory(area as unknown as { digits?: (n: number | null) => unknown })

  function area(data: Iterable<unknown>): string | null {
    let d: unknown
    let defined0 = false
    let buffer: Path | undefined
    let j = 0
    const arr = array(data)
    const n = arr.length
    const x0z = new Float64Array(n)
    const y0z = new Float64Array(n)
    if (context == null) output = curve(buffer = path())
    for (let i = 0; i <= n; ++i) {
      if (!(i < n && defined(d = arr[i], i, arr)) === defined0) {
        if ((defined0 = !defined0)) {
          j = i
          output!.areaStart()
          output!.lineStart()
        } else {
          output!.lineEnd()
          output!.lineStart()
          for (let k = i - 1; k >= j; --k) {
            output!.point(x0z[k] as number, y0z[k] as number)
          }
          output!.lineEnd()
          output!.areaEnd()
        }
      }
      if (defined0) {
        x0z[i] = +(x0(d, i, arr) as number)
        y0z[i] = +(y0(d, i, arr) as number)
        output!.point(x1 ? +(x1(d, i, arr) as number) : x0z[i] as number, y1 ? +(y1(d, i, arr) as number) : y0z[i] as number)
      }
    }
    if (buffer) return output = null, buffer + '' || null
    return null
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const gen = area as unknown as AreaGenerator & Record<string, any>
  gen.x = function (_?: ((d: unknown, i: number, data: unknown[]) => number) | number) {
    return (arguments.length ? (x0 = (typeof _ === 'function' ? _ : constant(+(_ as number))) as Accessor, x1 = null as unknown as Accessor, gen as AreaGenerator) : x0) as never
  }
  gen.x0 = function (_?: ((d: unknown, i: number, data: unknown[]) => number) | number) {
    return (arguments.length ? (x0 = (typeof _ === 'function' ? _ : constant(+(_ as number))) as Accessor, gen as AreaGenerator) : x0) as never
  }
  gen.x1 = function (_?: ((d: unknown, i: number, data: unknown[]) => number) | number | null) {
    return (arguments.length ? (x1 = (_ == null ? null : (typeof _ === 'function' ? _ : constant(+(_ as number)))) as unknown as Accessor, gen as AreaGenerator) : x1) as never
  }
  gen.y = function (_?: ((d: unknown, i: number, data: unknown[]) => number) | number) {
    return (arguments.length ? (y0 = (typeof _ === 'function' ? _ : constant(+(_ as number))) as Accessor, y1 = null as unknown as Accessor, gen as AreaGenerator) : y0) as never
  }
  gen.y0 = function (_?: ((d: unknown, i: number, data: unknown[]) => number) | number) {
    return (arguments.length ? (y0 = (typeof _ === 'function' ? _ : constant(+(_ as number))) as Accessor, gen as AreaGenerator) : y0) as never
  }
  gen.y1 = function (_?: ((d: unknown, i: number, data: unknown[]) => number) | number | null) {
    return (arguments.length ? (y1 = (_ == null ? null : (typeof _ === 'function' ? _ : constant(+(_ as number)))) as unknown as Accessor, gen as AreaGenerator) : y1) as never
  }
  gen.defined = function (_?: ((d: unknown, i: number, data: unknown[]) => boolean) | boolean) {
    return (arguments.length ? (defined = (typeof _ === 'function' ? _ : constant(!!_)) as typeof defined, gen as AreaGenerator) : defined) as never
  }
  gen.curve = function (_?: CurveFactory) {
    return (arguments.length ? (curve = _ as CurveFactory, context != null && (output = curve(context)), gen as AreaGenerator) : curve) as never
  }
  gen.context = function (_?: CurveContext | null) {
    return (arguments.length ? (_ == null ? context = output = null : output = curve(context = _ as CurveContext), gen as AreaGenerator) : context) as never
  }
  return gen
}
