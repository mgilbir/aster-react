/**
 * The extent of what a scene draws: a box type, and the bounds of every kind of item (text, rects, rules, symbols and other shaped
 * paths, arcs, images, groups). The layout passes (grids, guides, the size of the view) read these, and a view's size is a whole
 * number of pixels rounded up from them, so the arithmetic is Vega's, operation for operation: a measurement that differs in the
 * last digit can add a pixel. Text is measured with the estimate a headless Vega uses (`~~(0.8 * length * fontSize)`) unless a
 * canvas is there to measure it, as in a browser.
 */
import { SYMBOL_DEFAULT_SIZE, pushAll } from './util.js'
import type { SceneGroup, SceneItem, SceneNode } from './types.js'
import { itemArcGeometry } from './render.js'
import { areaGeometry, lineGeometry, symbolGeometry, trailGeometry, type CurveGeometry } from './geometry.js'
import { BoundsPen, cubicAt, cubicTurns } from './bounds-pen.js'
import { part } from './engine-parts.js'
import { itemTextWidth, truncateToLimit } from './text-metrics.js'
import { SHAPE_BOUNDS } from './registry.js'
import { imageBox } from './image-box.js'

/** The four numbers of a box: a `Bounds`, or one that crossed a structured clone as a plain object. */
export interface BoxLike { x1: number; y1: number; x2: number; y2: number }

// ---------------------------------------------------------------------------
// Bounds: a box that starts out empty
// ---------------------------------------------------------------------------

/**
 * An axis-aligned box. A new box is empty: its minimum is the largest number and its maximum the smallest, so that the first
 * point added becomes both. (Translating or expanding an empty box leaves it empty, because those numbers absorb the change;
 * `empty()` is how a caller tells whether anything was drawn.)
 */
export class Bounds {
  x1 = +Number.MAX_VALUE
  y1 = +Number.MAX_VALUE
  x2 = -Number.MAX_VALUE
  y2 = -Number.MAX_VALUE

  constructor(b?: Bounds) {
    if (b) this.union(b)
  }

  clone(): Bounds {
    return new Bounds(this)
  }

  /** A box with the four numbers of `b`, as they are: `b` may be a plain object (a box that crossed a structured clone). */
  static copyOf(b: BoxLike): Bounds {
    const out = new Bounds()
    out.x1 = b.x1
    out.y1 = b.y1
    out.x2 = b.x2
    out.y2 = b.y2
    return out
  }

  clear(): this {
    this.x1 = this.y1 = +Number.MAX_VALUE
    this.x2 = this.y2 = -Number.MAX_VALUE
    return this
  }

  empty(): boolean {
    return this.x1 === +Number.MAX_VALUE && this.y1 === +Number.MAX_VALUE && this.x2 === -Number.MAX_VALUE && this.y2 === -Number.MAX_VALUE
  }

  /** Make the box these corners, in whichever order they are given. */
  set(x1: number, y1: number, x2: number, y2: number): this {
    if (x2 < x1) {
      this.x2 = x1
      this.x1 = x2
    } else {
      this.x1 = x1
      this.x2 = x2
    }
    if (y2 < y1) {
      this.y2 = y1
      this.y1 = y2
    } else {
      this.y1 = y1
      this.y2 = y2
    }
    return this
  }

  /** Grow the box to include a point. */
  add(x: number, y: number): this {
    if (x < this.x1) this.x1 = x
    if (y < this.y1) this.y1 = y
    if (x > this.x2) this.x2 = x
    if (y > this.y2) this.y2 = y
    return this
  }

  /** Grow the box by `d` on every side. */
  expand(d: number): this {
    this.x1 -= d
    this.y1 -= d
    this.x2 += d
    this.y2 += d
    return this
  }

  translate(dx: number, dy: number): this {
    this.x1 += dx
    this.x2 += dx
    this.y1 += dy
    this.y2 += dy
    return this
  }

  /** The box around this one turned by `angle` (radians) about (x, y). */
  rotate(angle: number, x: number, y: number): this {
    const c = this.rotatedCorners(angle, x, y)
    return this.clear().add(c[0]!, c[1]!).add(c[2]!, c[3]!).add(c[4]!, c[5]!).add(c[6]!, c[7]!)
  }

  /** The four corners (x1,y1), (x1,y2), (x2,y1), (x2,y2) as x, y pairs, turned by `angle` (radians) about (x, y). */
  rotatedCorners(angle: number, x: number, y: number): number[] {
    const { x1, y1, x2, y2 } = this
    const cos = Math.cos(angle)
    const sin = Math.sin(angle)
    // turning about (x, y) is turning about the origin, then moving by what the origin's own turn left behind
    const cx = x - x * cos + y * sin
    const cy = y - x * sin - y * cos
    return [
      cos * x1 - sin * y1 + cx, sin * x1 + cos * y1 + cy,
      cos * x1 - sin * y2 + cx, sin * x1 + cos * y2 + cy,
      cos * x2 - sin * y1 + cx, sin * x2 + cos * y1 + cy,
      cos * x2 - sin * y2 + cx, sin * x2 + cos * y2 + cy,
    ]
  }

  /** Grow the box to include another. */
  union(b: Bounds): this {
    if (b.x1 < this.x1) this.x1 = b.x1
    if (b.y1 < this.y1) this.y1 = b.y1
    if (b.x2 > this.x2) this.x2 = b.x2
    if (b.y2 > this.y2) this.y2 = b.y2
    return this
  }

  /** Shrink the box to its overlap with another (it never grows). */
  intersect(b: Bounds): this {
    if (b.x1 > this.x1) this.x1 = b.x1
    if (b.y1 > this.y1) this.y1 = b.y1
    if (b.x2 < this.x2) this.x2 = b.x2
    if (b.y2 < this.y2) this.y2 = b.y2
    return this
  }

  width(): number {
    return this.x2 - this.x1
  }

  height(): number {
    return this.y2 - this.y1
  }
}

export const DEG_TO_RAD = Math.PI / 180

// ---------------------------------------------------------------------------
// The reach of a stroke
// ---------------------------------------------------------------------------

/**
 * Grow `bounds` by how far the item's stroke reaches past the outline it is drawn on: half its width, more at a square cap
 * (up to the diagonal of the half width), and, where the outline's corners are mitered (`miter`, and a join that is the default
 * or `miter`), as far as a join tip goes: half the width times the miter limit. An item with no stroke, or an invisible one, adds nothing.
 */
export function boundStroke(bounds: Bounds, item: SceneItem, miter?: boolean): Bounds {
  const rec = item as Record<string, unknown>
  if (!item.stroke || item.opacity === 0 || item.strokeOpacity === 0) return bounds
  const width = item.strokeWidth != null ? +item.strokeWidth : 1
  let reach = (rec.strokeCap === 'square' ? Math.SQRT2 : 1) * width / 2
  const join = rec.strokeJoin ?? rec.strokeLineJoin
  if (miter && (!join || join === 'miter')) {
    reach = Math.max(reach, (rec.strokeMiterLimit != null ? +rec.strokeMiterLimit : 4) * width / 2)
  }
  return bounds.expand(reach)
}

// ---------------------------------------------------------------------------
// Text: lines, widths and where the baseline falls (the measuring itself is in text-metrics.ts)
// ---------------------------------------------------------------------------

export function fontSize(item: SceneItem): number {
  return item.fontSize != null ? +item.fontSize || 0 : 11
}

export function lineHeight(item: SceneItem): number {
  return item.lineHeight != null ? item.lineHeight : fontSize(item) + 2
}

function lineArray(v: unknown): unknown {
  return Array.isArray(v) ? (v.length > 1 ? v : v[0]) : v
}

export function textLines(item: SceneItem): string | string[] {
  return lineArray(
    item.lineBreak && item.text != null && !Array.isArray(item.text)
      ? String(item.text).split(item.lineBreak)
      : item.text,
  ) as string | string[]
}

export function multiLineOffset(item: SceneItem): number {
  const tl = textLines(item)
  return (Array.isArray(tl) ? tl.length - 1 : 0) * lineHeight(item)
}

export function textValue(item: SceneItem, line: unknown): string {
  const text = line == null ? '' : (line + '').trim()
  return truncateToLimit(item, text)
}

export function textWidth(item: SceneItem, line: unknown): number {
  // vega's two paths, dispatched exactly like textMetrics.width:
  //  - canvas (real browsers): 0 for fontSize <= 0 / empty text, else the
  //    cached measureText of the item's font string;
  //  - headless estimate (no canvas): `~~(0.8 * len * fontSize)` with NO
  //    fontSize guard — negative font sizes measure negative (the text bound
  //    then flips through Bounds.set), matching vega bit for bit.
  const text = textValue(item, line)
  return itemTextWidth(item, String(text ?? ''))
}

/** How far the text's baseline sits from the y it is drawn at, by the baseline it asks for. */
export function baselineOffset(item: SceneItem): number {
  const baseline = item.baseline
  const h = fontSize(item)
  const lh = item.lineHeight != null ? item.lineHeight : h + 2
  return Math.round(
    baseline === 'top' ? 0.79 * h :
    baseline === 'middle' ? 0.30 * h :
    baseline === 'bottom' ? -0.21 * h :
    baseline === 'line-top' ? 0.29 * h + 0.5 * lh :
    baseline === 'line-bottom' ? 0.29 * h - 0.5 * lh : 0,
  )
}

// ---------------------------------------------------------------------------
// The bounds of the kinds of item
// ---------------------------------------------------------------------------

/** The extent of an arc item: its sector traced through the same generator that draws it (corner radius and padding included), turned by the item's angle, stroked, and moved to the item. */
export function boundArcItem(bounds: Bounds, it: SceneItem): Bounds {
  // (the turn is the angle as it is: one vega's bound context cannot read, a NaN or a string such as "12px", turns every point to NaN)
  itemArcGeometry(it).outline.replay(new BoundsPen(bounds, (it as Record<string, unknown>).angle as number))
  return boundStroke(bounds, it, true).translate(it.x || 0, it.y || 0)
}

/**
 * Where vega's text bound anchors a text item: `x || 0`, `y || 0` as they are on the item, pushed `radius` out along `theta` (radians,
 * clockwise from twelve o'clock) -- a numeric string stays a string, and the sums vega makes with it are string sums.
 */
export function textAnchorAsIs(item: SceneItem): [number, number] {
  let x = (item.x || 0) as number
  let y = (item.y || 0) as number
  const r = (item.radius || 0) as number
  if (r) {
    const t = ((item.theta || 0) as number) - Math.PI / 2
    x += r * Math.cos(t)
    y += r * Math.sin(t)
  }
  return [x, y]
}

/**
 * The box of a text item: its lines at its alignment and baseline, turned by its angle about the anchor. The anchor and the offsets
 * are the channels as they are on the item (`x || 0`, `dx || 0`, a polar `radius` / `theta`): vega's text bound adds them as it finds
 * them, so a numeric string or a NaN makes the edges vega's do.
 */
export function boundText(bounds: Bounds, item: SceneItem): Bounds {
  let h = fontSize(item)
  const a = item.align
  const [x, y] = textAnchorAsIs(item)
  let dx = (item.dx || 0) as number
  let dy = ((item.dy || 0) as number) + baselineOffset(item) - Math.round(0.8 * h)
  const tl = textLines(item)
  let w: number

  if (Array.isArray(tl)) {
    h += lineHeight(item) * (tl.length - 1)
    w = tl.reduce((acc: number, t: string) => Math.max(acc, textWidth(item, t)), 0)
  } else {
    w = textWidth(item, tl)
  }

  if (a === 'center') dx -= w / 2
  else if (a === 'right') dx -= w

  dx += x
  dy += y
  bounds.set(dx, dy, dx + w, dy + h)

  if (item.angle) {
    bounds.rotate(item.angle * DEG_TO_RAD, x, y)
  }
  return bounds
}

/**
 * The box of a rect: from its corner (`x || 0`, `y || 0`) by its width and height, `(x + width) || 0` -- vega's arithmetic on the
 * channels as they are, so a NaN corner is the origin and a numeric-string width is added as vega adds it -- stroke included.
 */
export function boundRect(bounds: Bounds, item: SceneItem): Bounds {
  const x = (item.x || 0) as number
  const y = (item.y || 0) as number
  return boundStroke(bounds.set(x, y, (x + (item.width as number)) || 0, (y + (item.height as number)) || 0), item)
}

/** The box of a rule: the segment from (x, y) to (x2, y2), stroke included. */
export function boundRule(bounds: Bounds, item: SceneItem): Bounds {
  const x1 = item.x || 0
  const y1 = item.y || 0
  return boundStroke(bounds.set(x1, y1, item.x2 != null ? item.x2 : x1, item.y2 != null ? item.y2 : y1), item)
}

/** The box of an image: its width and height from its anchor, by its alignment. Its stroke paints nothing, and adds nothing. */
function boundImage(bounds: Bounds, item: SceneItem): Bounds {
  const { x, y, w, h } = imageBox(item)
  return bounds.set(x, y, x + w, y + h)
}

// ---------------------------------------------------------------------------
// The extent of path data
// ---------------------------------------------------------------------------

/**
 * The extent of a symbol shape at a radius, turned by `angle` degrees, as vega's bound context measures it: the shape's own drawing
 * calls (d3-symbol's: a square is a `rect`, the other built-in shapes their points in order, a custom shape its path scaled by `r`)
 * through a pen that turns every point. Measured once per shape, radius and angle: a legend measures the same few shapes in every
 * evaluation. A radius or an angle that is not a number draws nothing; the box is assigned as measured, an empty or half-empty one
 * included, onto a box that holds nothing yet.
 */
const SHAPE_EXTENTS = new Map<string, [number, number, number, number]>()
function addShapeExtent(bounds: Bounds, shape: string, r: number, angle?: number): void {
  const key = shape + '|' + r + '|' + angle
  let ext = SHAPE_EXTENTS.get(key)
  if (ext === undefined) {
    const b = new Bounds()
    const pen = new BoundsPen(b, angle)
    if (shape === 'square') {
      const w = 2 * r
      pen.rect(-r, -r, w, w)
    } else {
      for (const { c, n } of symbolGeometry(shape, r).exact().tokens()) {
        if (c === 'M') pen.moveTo(n[0]!, n[1]!)
        else if (c === 'L') pen.lineTo(n[0]!, n[1]!)
        else if (c === 'C') pen.bezierCurveTo(n[0]!, n[1]!, n[2]!, n[3]!, n[4]!, n[5]!)
        else if (c === 'Q') pen.quadraticCurveTo(n[0]!, n[1]!, n[2]!, n[3]!)
      }
    }
    ext = [b.x1, b.y1, b.x2, b.y2]
    if (SHAPE_EXTENTS.size > 256) SHAPE_EXTENTS.clear()
    SHAPE_EXTENTS.set(key, ext)
  }
  if (bounds.empty()) { bounds.x1 = ext[0]; bounds.y1 = ext[1]; bounds.x2 = ext[2]; bounds.y2 = ext[3] }
  else bounds.add(ext[0], ext[1]).add(ext[2], ext[3])
}

/** A command of path data with the numbers that follow its letter (however many there are). */
type PathToken = { c: string; n: number[] }


/** Where a quadratic curve, with control values p0, p1, p2 along one axis, is at its extreme there, if it turns within the curve. */
function quadraticExtreme(p0: number, p1: number, p2: number): number | undefined {
  const t = (p0 - p1) / (p0 + p2 - 2 * p1)
  return 0 < t && t < 1 ? p0 + (p1 - p0) * t : undefined
}

/** The extremes along one axis of a cubic curve with control values p0..p3: its value at each parameter where it turns. */
function cubicExtremes(p0: number, p1: number, p2: number, p3: number): number[] {
  return cubicTurns(p0, p1, p2, p3).map((t) => cubicAt(t, p0, p1, p2, p3))
}

/**
 * Grow `bounds` by the extent of SVG path data: every point it visits, the extremes of its curves, and for an arc its end points and
 * the quarter turns it passes (a full circle as its centre plus and minus its radius). `transform` puts path coordinates where the
 * bounds are measured; a curve turns where its derivative does in that space.
 *
 * A command with fewer numbers than it needs is read as far as it goes (the missing ones are NaN, which a box ignores), and a
 * path that is nothing but numbers adds nothing.
 */
export function boundsFromPath(
  bounds: Bounds,
  d: string,
  transform?: (x: number, y: number) => [number, number],
): Bounds {
  // (the path reader is a part the React shells load on demand, engine-parts.ts: a spec with path marks needs it)
  const tokens = part('svgpath').drawnPathCommands(d).map((c): PathToken => ({ c: c[0], n: c.slice(1) as number[] }))
  return boundsFromTokens(bounds, tokens, transform)
}

/** {@link boundsFromPath} on the tokens of path data. */
function boundsFromTokens(
  bounds: Bounds,
  tokens: readonly PathToken[],
  transform?: (x: number, y: number) => [number, number],
): Bounds {
  // the pen's place in path coordinates; where the current subpath began (a close returns there); and its place where the bounds are
  let lx = 0
  let ly = 0
  let startX = 0
  let startY = 0
  let tx = 0
  let ty = 0
  const place = (x: number, y: number): [number, number] => (transform ? transform(x, y) : [x, y])
  const visit = (x: number, y: number): void => {
    const p = place(x, y)
    bounds.add(p[0], p[1])
    tx = p[0]
    ty = p[1]
  }
  // an extreme of a curve along x widens the box in x only, and along y in y only
  const reachX = (v: number | undefined): void => { if (v !== undefined) bounds.add(v, bounds.y1) }
  const reachY = (v: number | undefined): void => { if (v !== undefined) bounds.add(bounds.x1, v) }

  const quadTo = (cx: number, cy: number, x: number, y: number): void => {
    const c = place(cx, cy)
    const e = place(x, y)
    reachX(quadraticExtreme(tx, c[0], e[0]))
    reachY(quadraticExtreme(ty, c[1], e[1]))
    visit(x, y)
  }
  const cubicTo = (x1: number, y1: number, x2: number, y2: number, x: number, y: number): void => {
    const a = place(x1, y1)
    const b = place(x2, y2)
    const e = place(x, y)
    for (const v of cubicExtremes(tx, a[0], b[0], e[0])) reachX(v)
    for (const v of cubicExtremes(ty, a[1], b[1], e[1])) reachY(v)
    visit(x, y)
  }

  // an elliptical arc from (x1, y1) to (x2, y2): found as the arc of an ellipse about a centre, then sampled
  const arcTo = (x1: number, y1: number, rx: number, ry: number, phiDeg: number, largeArc: number, sweep: number, x2: number, y2: number): void => {
    if (rx === 0 || ry === 0) {
      visit(x2, y2)
      lx = x2
      ly = y2
      return
    }
    const phi = phiDeg * DEG_TO_RAD
    const cosPhi = Math.cos(phi)
    const sinPhi = Math.sin(phi)
    const dx2 = (x1 - x2) / 2
    const dy2 = (y1 - y2) / 2
    const x1p = cosPhi * dx2 + sinPhi * dy2
    const y1p = -sinPhi * dx2 + cosPhi * dy2
    rx = Math.abs(rx)
    ry = Math.abs(ry)
    const tooSmall = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry)
    if (tooSmall > 1) {
      const grow = Math.sqrt(tooSmall)
      rx *= grow
      ry *= grow
    }
    const sign = largeArc !== sweep ? 1 : -1
    const numerator = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p
    const denominator = rx * rx * y1p * y1p + ry * ry * x1p * x1p
    const co = sign * Math.sqrt(Math.max(0, numerator / denominator))
    const cxp = co * (rx * y1p) / ry
    const cyp = -co * (ry * x1p) / rx
    const cx = cosPhi * cxp - sinPhi * cyp + (x1 + x2) / 2
    const cy = sinPhi * cxp + cosPhi * cyp + (y1 + y2) / 2

    const theta1 = Math.atan2((y1p - cyp) / ry, (x1p - cxp) / rx)
    const theta2 = Math.atan2((-y1p - cyp) / ry, (-x1p - cxp) / rx)
    const Tau = 2 * Math.PI
    const HalfPi = Math.PI / 2
    const ccw = sweep === 0
    if (Math.abs(theta2 - theta1) >= Tau - 1e-8) {
      // a full ellipse
      visit(cx - rx, cy - ry)
      visit(cx + rx, cy + ry)
    } else {
      const at = (a: number): void => {
        const px = rx * Math.cos(a)
        const py = ry * Math.sin(a)
        visit(cx + px * cosPhi - py * sinPhi, cy + px * sinPhi + py * cosPhi)
      }
      // the end angles, in the direction the arc is swept
      let sa = theta1
      let ea = theta1
      let delta = theta2 - theta1
      // (a sweep that is not finite never comes round: the loops below would not end)
      if (Number.isFinite(delta)) {
        if (ccw) while (delta > 0) delta -= Tau
        else while (delta < 0) delta += Tau
      }
      ea = theta1 + delta
      at(sa)
      at(ea)
      if (ea !== sa) {
        // then the quarter turns between them: from the smaller angle on, a quarter turn at a time
        sa = sa % Tau
        if (sa < 0) sa += Tau
        ea = ea % Tau
        if (ea < 0) ea += Tau
        let a: number
        if (ea < sa) {
          // the end came round before the start: the arc runs the other way between the two
          const flipped = !ccw
          ;[sa, ea] = [ea, sa]
          if (flipped) {
            ea -= Tau
            a = sa - (sa % HalfPi)
            for (let i = 0; i < 4 && a > ea; ++i, a -= HalfPi) at(a)
          } else {
            a = sa - (sa % HalfPi) + HalfPi
            for (let i = 0; i < 4 && a < ea; ++i, a += HalfPi) at(a)
          }
        } else if (ccw) {
          const back = ea - Tau
          a = sa - (sa % HalfPi)
          for (let i = 0; i < 4 && a > back; ++i, a -= HalfPi) at(a)
        } else {
          a = sa - (sa % HalfPi) + HalfPi
          for (let i = 0; i < 4 && a < ea; ++i, a += HalfPi) at(a)
        }
      }
    }
    lx = x2
    ly = y2
  }

  // the control point a smooth curve (S, T) reflects: the previous curve's, when it was of the same degree
  let ctlX = 0
  let ctlY = 0
  let ctlKind = ''
  const nums: number[] = []
  let read = 0
  // the next number of the command: a command that runs out of numbers gets NaN
  const next = (): number => nums[read++] as number
  for (const token of tokens) {
    const cmd = token.c
    nums.length = 0
    pushAll(nums, token.n)
    read = 0
    const rel = cmd === cmd.toLowerCase()
    const kind = cmd.toUpperCase()
    // each repeat of a command takes its numbers relative to the pen when the letter is lower case
    const nextX = (): number => next() + (rel ? lx : 0)
    const nextY = (): number => next() + (rel ? ly : 0)
    switch (kind) {
      case 'M':
        // the first pair moves the pen, later ones draw lines
        while (read < nums.length) {
          const x = nextX()
          const y = nextY()
          visit(x, y)
          lx = startX = x
          ly = startY = y
        }
        break
      case 'L':
        while (read < nums.length) {
          lx = nextX()
          ly = nextY()
          visit(lx, ly)
        }
        break
      case 'H':
        while (read < nums.length) {
          lx = nextX()
          visit(lx, ly)
        }
        break
      case 'V':
        while (read < nums.length) {
          ly = nextY()
          visit(lx, ly)
        }
        break
      case 'C':
        while (read < nums.length) {
          const x1 = nextX(), y1 = nextY(), x2 = nextX(), y2 = nextY(), x = nextX(), y = nextY()
          cubicTo(x1, y1, x2, y2, x, y)
          lx = x
          ly = y
          ctlX = x2; ctlY = y2; ctlKind = 'cubic'
        }
        break
      case 'S':
        while (read < nums.length) {
          const x2 = nextX(), y2 = nextY(), x = nextX(), y = nextY()
          const x1 = ctlKind === 'cubic' ? 2 * lx - ctlX : lx
          const y1 = ctlKind === 'cubic' ? 2 * ly - ctlY : ly
          cubicTo(x1, y1, x2, y2, x, y)
          lx = x
          ly = y
          ctlX = x2; ctlY = y2; ctlKind = 'cubic'
        }
        break
      case 'Q':
        while (read < nums.length) {
          const x1 = nextX(), y1 = nextY(), x = nextX(), y = nextY()
          quadTo(x1, y1, x, y)
          lx = x
          ly = y
          ctlX = x1; ctlY = y1; ctlKind = 'quad'
        }
        break
      case 'T':
        while (read < nums.length) {
          const x = nextX(), y = nextY()
          const x1 = ctlKind === 'quad' ? 2 * lx - ctlX : lx
          const y1 = ctlKind === 'quad' ? 2 * ly - ctlY : ly
          quadTo(x1, y1, x, y)
          lx = x
          ly = y
          ctlX = x1; ctlY = y1; ctlKind = 'quad'
        }
        break
      case 'A':
        while (read < nums.length) {
          const rx = next(), ry = next(), rotation = next(), large = next(), sweep = next()
          const x = nextX()
          const y = nextY()
          arcTo(lx, ly, rx, ry, rotation, large, sweep, x, y)
          ;[tx, ty] = place(x, y)
        }
        break
      case 'Z':
        lx = startX
        ly = startY
        break
    }
    if (kind !== 'C' && kind !== 'S' && kind !== 'Q' && kind !== 'T') ctlKind = ''
  }
  return bounds
}

// ---------------------------------------------------------------------------
// Marks and groups
// ---------------------------------------------------------------------------

/** The box a line's or area's curve covers (control points and curve extremes included), measured once per geometry. */
const CURVE_EXTENTS = new WeakMap<CurveGeometry, [number, number, number, number]>()
function curveExtent(geometry: CurveGeometry | null): Bounds {
  const b = new Bounds()
  if (geometry === null) return b
  let e = CURVE_EXTENTS.get(geometry)
  if (e === undefined) {
    geometry.draw(new BoundsPen(b))
    CURVE_EXTENTS.set(geometry, (e = [b.x1, b.y1, b.x2, b.y2]))
    return b
  }
  // (the fields as measured: `set` would reorder an empty box's infinities)
  b.x1 = e[0]; b.y1 = e[1]; b.x2 = e[2]; b.y2 = e[3]
  return b
}

/**
 * The bounds vega's bounds pass leaves on a line, an area or a trail mark (`mark.bounds`; each of its items holds a copy): the shape
 * of all its items through the bound context, then the stroke of its first item, as they come out -- a NaN stroke width makes the
 * box NaN, and an empty shape stays empty. (vega draws a line 2 wide unless it says otherwise: the renderer resolves that width at
 * draw time, so the bounds measure it too.)
 */
export function multiMarkBounds(mark: SceneGroup): Bounds {
  const items = (mark.items ?? []) as SceneItem[]
  if (items.length === 0) return new Bounds()
  let drawn: Bounds
  if (mark.marktype === 'trail') {
    drawn = new Bounds()
    trailGeometry(items)?.outline.replay(new BoundsPen(drawn))
  } else drawn = curveExtent(mark.marktype === 'area' ? areaGeometry(items) : lineGeometry(items))
  const first = items[0]!
  const styled = mark.marktype === 'line' && first.stroke != null && first.strokeWidth == null ? { ...first, strokeWidth: 2 } : first
  return boundStroke(drawn, styled, true)
}

/** The bounds of a typed (non-group) mark: the union of its items' bounds (vega's `mark.bounds`), or a line's, an area's or a trail's own. */
export function boundTypedMark(bounds: Bounds, mark: SceneGroup): Bounds {
  const items = (mark.items ?? []) as SceneItem[]
  switch (mark.marktype) {
    case 'line':
    case 'area':
    case 'trail':
      return bounds.union(multiMarkBounds(mark))
    default:
      // every other mark is the union of its items' own bounds (vega's boundMark), each measured as an item of this mark's type
      for (const it of items) bounds.union(itemBounds(new Bounds(), mark.marktype ?? '', it))
      return bounds
  }
}

/**
 * The bounds vega's bounds pass leaves on one item of a mark of type `type` (its `item.bounds`), in the frame of the item's group.
 * The item is measured as that type, whatever other channels its encode gave it: a `text` or a `radius` on an arc, a `width` on a
 * symbol is inert, as it is to vega's bound of that mark. The channels are read as they are on the item and go through vega's
 * arithmetic (`x || 0`, `x + width`, `+size`, `item.angle` turning the bound context): a NaN, a null or a numeric string comes out as
 * vega's does, a NaN edge or a string edge such as `"03"` included, and the consumers (a mark's union, the canvas pick's "not
 * outside", `intersect`) read it as vega's do. A line, an area or a trail has one bound for the whole mark (`boundTypedMark`).
 */
export function itemBounds(bounds: Bounds, type: string, it: SceneItem): Bounds {
  switch (type) {
    case 'rect': return boundRect(bounds, it)
    case 'rule': return boundRule(bounds, it)
    case 'image': return boundImage(bounds, it)
    // (every item of a text mark is text, whether or not its `text` came out defined: an empty line at its anchor)
    case 'text': return boundText(bounds, it)
    case 'arc': return boundArcItem(bounds, it)
    case 'symbol': return boundSymbol(bounds, it)
    case 'path':
    case 'shape':
      return boundPathItem(bounds, it, true)
    case 'group': return boundGroupItem(bounds, it as unknown as SceneGroup)
    default: return bounds.union(boundIsolated(it))
  }
}

/**
 * `itemBounds` into `b` for the item of a mark of type `kind` (`leaf`: a guide's part, measured as its own kind). What the accessible
 * tree measures an item by, as the hit index does.
 */
export function boundItemOfKind(b: Bounds, it: SceneItem, kind: string): void {
  if (kind === 'leaf') { boundLeaf(b, it); return }
  b.union(itemBounds(new Bounds(), kind, it))
}

/** Bound one leaf item (or nested group/mark item) into `bounds`. */
export function boundLeaf(bounds: Bounds, it: SceneItem, miterPaths = false, kind?: string): Bounds {
  const mt = (it as SceneGroup).marktype
  const hasItems = Array.isArray((it as SceneGroup).items)
  if (mt === 'group' || (mt === undefined && hasItems)) {
    const g = it as unknown as SceneGroup
    // groups bound in isolation (their stroke expansion must not compound
    // onto the target), then union — mirrors vega's per-item bounds objects
    const b = new Bounds()
    boundGroupItem(b, g)
    return bounds.union(b)
  }
  if (mt !== undefined && hasItems) {
    // typed mark nested inside a group: its own bounds (vega's mark.bounds),
    // stroke expansion included, then unioned. Expanding the shared target
    // directly would grow whatever the group had already accumulated (its
    // box, earlier marks) by this mark's stroke.
    const b = new Bounds()
    boundTypedMark(b, it as unknown as SceneGroup)
    return bounds.union(b)
  }
  return bounds.union(kind !== undefined ? itemBounds(new Bounds(), kind, it) : boundIsolated(it, miterPaths))
}

/**
 * The bounds of an axis group as vega's layout reads them: the bounds its axis layout left on the mark (the spine plus the tick and
 * label extent, the title), which guide-axis.ts measures and the scene carries (`axis.bounds`, in the axis's frame). An axis whose
 * orient is none of the four has none: vega's axisLayout leaves its position undefined, its bounds are NaN and union into nothing.
 * An axis group that carries no measured bounds is not the engine's: it is bounded as any group is, by what it holds.
 *
 * The stored box is read by its four numbers, never by its methods: a scene that crossed a structured clone (a worker's) carries it
 * as a plain object.
 */
export function boundAxisGroup(axis: SceneGroup): Bounds {
  const meta = (axis as Record<string, unknown>).axis as { noLayout?: boolean; bounds?: BoxLike } | undefined
  if (meta?.noLayout === true) return new Bounds()
  if (meta?.bounds) return Bounds.copyOf(meta.bounds)
  return boundGroupItem(new Bounds(), axis)
}

/**
 * The bounds of a symbol item: its shape (`shape || "circle"`) at its size (`size`, 64 when there is none, read as a number: a
 * negative or non-numeric size draws nothing and measures nothing), turned by its angle, stroked with miter joins, moved to
 * `x || 0`, `y || 0` -- vega's symbol bound (d3-symbol through the bound context), operation for operation.
 */
function boundSymbol(bounds: Bounds, it: SceneItem): Bounds {
  const rec = it as Record<string, unknown>
  const r = Math.sqrt(+((it.size != null ? it.size : SYMBOL_DEFAULT_SIZE) as number)) / 2
  const shape = (rec.shape || 'circle') as string
  const angle = rec.angle as number | undefined
  if (shape === 'circle') {
    if (!angle) bounds.add(-r, -r).add(r, r)
    else {
      // (turned: what the bound context's arc does with the turn, which a NaN or a non-numeric angle makes NaN)
      const pen = new BoundsPen(bounds, angle)
      pen.moveTo(r, 0)
      pen.arc(0, 0, r, 0, 2 * Math.PI)
    }
  } else addShapeExtent(bounds, shape, r, angle)
  boundStroke(bounds, it, true)
  return bounds.translate(it.x || 0, it.y || 0)
}

/**
 * The bounds of a path or a shape item: its path drawn at `x || 0`, `y || 0`, scaled by `scaleX || 1`, `scaleY || 1` and turned by
 * the item's angle about the origin of its frame (vega's bound context turns every point, the move included), then its stroke. A
 * projected shape is measured from its unrounded geometry, as vega's bound context sees it. A `path` item with no path is the origin
 * and takes no stroke; an empty path draws nothing but still takes its stroke, which an empty box absorbs unless it is not a number.
 */
function boundPathItem(bounds: Bounds, it: SceneItem, miter: boolean, nullIsOrigin = true): Bounds {
  const rec = it as Record<string, unknown>
  if (it.path == null) return nullIsOrigin ? bounds.set(0, 0, 0, 0) : bounds
  // (the shape is the item's own when a mark's geoshape transform wrote it, its datum's when the data's did)
  const shaped = rec.angle ? undefined : it.path === rec.shape ? it : it.datum && it.path === (it.datum as Record<string, unknown>).shape ? it.datum : undefined
  const exact = shaped !== undefined ? SHAPE_BOUNDS.get(shaped as object) : undefined
  if (exact) {
    bounds.add(exact[0], exact[1])
    bounds.add(exact[2], exact[3])
    bounds.translate(it.x || 0, it.y || 0)
  } else {
    // the same replay, arcs as bezier approximations included, that draws a custom symbol
    // (the path reader is a part the React shells load on demand, engine-parts.ts: a spec with path marks needs it)
    const { svgPathCommands, renderSvgPath } = part('svgpath')
    let commands: ReturnType<typeof svgPathCommands> | null = null
    try { commands = svgPathCommands(it.path) } catch { /* a path that does not parse is measured as far as it reads */ }
    if (commands) renderSvgPath(new BoundsPen(bounds, rec.angle as number), commands, it.x || 0, it.y || 0, (rec.scaleX as number) || 1, (rec.scaleY as number) || 1)
    else {
      boundsFromPath(bounds, it.path)
      bounds.translate(it.x || 0, it.y || 0)
    }
  }
  return boundStroke(bounds, it, miter)
}

/**
 * The bounds of a guide's leaf, whose kind its channels say (`_kind` when the guide set one): a text, a rule, an arc, a path (a
 * box, a symbol's outline), a legend symbol, an image, a rect, a rule, a point symbol. A mark's item never comes here: its mark's
 * type says what it is (`itemBounds`).
 */
function boundIsolated(it: SceneItem, miterPaths = false): Bounds {
  const bounds = new Bounds()
  if (it._kind === 'text' || (it._kind === undefined && it.text != null)) return boundText(bounds, it)
  // a guide's rule says what it is, whatever other channels (a width, a height) its encode gave it
  if (it._kind === 'rule') return boundRule(bounds, it)
  if (it.path == null && (it.outerRadius != null || it.innerRadius != null || it.startAngle != null || it.endAngle != null)) {
    return boundArcItem(bounds, it)
  }
  if (it.path != null) {
    // Miter expansion applies to a leaf that is a mark's shape; a group's background (stroke without an explicit strokeWidth)
    // expands non-miter, like vega's group stroke bound. An empty path (a geo shape entirely clipped away) bounds to nothing.
    if (it.path === '') return bounds
    return boundPathItem(bounds, it, miterPaths || it.strokeWidth != null)
  }
  if (it.shape != null && it.radius != null) {
    // a legend's symbol: its shape at its radius
    const r = it.radius
    const angle = (it as Record<string, unknown>).angle as number | undefined
    if (it.shape === 'circle') bounds.add(-r, -r).add(r, r)
    else addShapeExtent(bounds, String(it.shape), r, angle)
    boundStroke(bounds, it, true)
    return bounds.translate(it.x || 0, it.y || 0)
  }
  if (it.url != null) return boundImage(bounds, it)
  if (it.width != null || it.height != null) return boundRect(bounds, it)
  if (it.x2 != null || it.y2 != null) return boundRule(bounds, it)
  if (it.x != null || it.y != null || it.size != null) return boundSymbol(bounds, it)
  return boundRect(bounds, it)
}

/**
 * A legend mark's bounds after vega's legendLayout: the outer box
 * [x, y, x+width, y+height] (the border stroke, when the legend draws one,
 * boundStrokes it); symbol and label overhangs are not part of it.
 */
export function boundLegendGroup(g: SceneGroup): Bounds {
  const rec = g as Record<string, unknown>
  // a legend built by guide-legend.ts carries the bounds its layout left on the mark (relative to the group's position)
  // (read by its four numbers: a scene that crossed a structured clone carries it as a plain object)
  const own = rec.legendBounds as BoxLike | undefined
  if (own) {
    const placed = Bounds.copyOf(own).translate(g.x ?? 0, g.y ?? 0)
    // a legend that sits nowhere along an axis (`orient: none` with no legendX / legendY) has no extent along it
    const unplaced = rec.unplaced as { x: boolean; y: boolean } | undefined
    if (unplaced?.x) { placed.x1 = +Number.MAX_VALUE; placed.x2 = -Number.MAX_VALUE }
    if (unplaced?.y) { placed.y1 = +Number.MAX_VALUE; placed.y2 = -Number.MAX_VALUE }
    return placed
  }
  const stroked = rec._borderStroke === true
    || (rec._borderStroke === undefined
      // vega's boundStroke expands by strokeWidth/2 - a zero-width stroke (the gradient rect's #ddd) does not move the bounds
      && (g.items as SceneItem[] | undefined)?.some((it) => it.stroke != null && it.path != null && (it.strokeWidth ?? 1) > 0))
  const se = stroked ? ((g.strokeWidth != null ? g.strokeWidth : 1) / 2) : 0
  return new Bounds().set((g.x ?? 0) - se, (g.y ?? 0) - se, (g.x ?? 0) + (g.width ?? 0) + se, (g.y ?? 0) + (g.height ?? 0) + se)
}

/**
 * The bounds of the marks of a group, mark by mark, as vega's bounds pass leaves them on each mark: a typed mark's own, a group
 * mark's the union of its items' (its items sit next to each other in this scene, one node each) -- a group's bounds are the union
 * of these, so the items of a group mark meet each other before they meet anything else, which decides what a NaN or a string edge
 * does. vega-view-transforms' Bound pass ends every mark with `boundClip(mark)`: a mark with `clip` has its bounds
 * intersected with the ENCLOSING group's frame [0, 0, group.width, group.height], the width and height as the group holds them
 * (a group with none does not cut: vega-scenegraph boundClip), so what a clipped mark draws outside the frame never grows the view. A group mark is one
 * mark across all its items (they sit next to each other in the parent, flagged `markClip`); a typed mark
 * is one scene node flagged `clip`. Calls `out` once per mark (a run of group items, or one node) with
 * the mark's bounds. `measure` bounds one node and may return a shared (cached) object: it is copied
 * before any intersection.
 */
/** Does any node of `items` carry a mark-level clip (see eachMarkBounds)? A cheap guard for the common unclipped case. */
export function hasClippedMark(items: readonly SceneNode[]): boolean {
  for (let i = 0; i < items.length; i++) {
    const n = items[i] as SceneGroup
    if (n.markClip === true || (n.clip === true && n.marktype !== undefined && n.marktype !== 'group')) return true
  }
  return false
}

export function eachMarkBounds(
  items: readonly SceneNode[],
  frameW: number,
  frameH: number,
  measure: (n: SceneNode) => Bounds,
  out: (b: Bounds, first: SceneNode) => void,
): void {
  const frame = (): Bounds => new Bounds().set(0, 0, frameW, frameH)
  for (let i = 0; i < items.length;) {
    const n = items[i] as SceneGroup & Record<string, unknown>
    if (n._scope === true) {
      // a group mark: the union of its items' bounds into the mark's own box, cut to the frame when the mark clips
      const mb = new Bounds()
      let j = i
      while (j < items.length && sameGroupMark(n, items[j] as SceneGroup & Record<string, unknown>)) mb.union(measure(items[j]!)), j++
      out(n.markClip === true ? mb.intersect(frame()) : mb, n)
      i = j
      continue
    }
    const b = measure(n)
    out(n.clip === true && n.marktype !== undefined && n.marktype !== 'group' && Array.isArray(n.items) ? Bounds.copyOf(b).intersect(frame()) : b, n)
    i++
  }
}

/** Two nodes of a scene are items of one group mark: group items of the same mark, which sit next to each other. */
const sameGroupMark = (a: Record<string, unknown>, b: Record<string, unknown>): boolean =>
  b._scope === true && a.name === b.name && a.markIndex === b.markIndex && a.markClip === b.markClip

/**
 * The bounds of a typed mark, cached per mark object: a scene that has been
 * returned is never written, and a layout reads the same marks several
 * times (grid cells, guide anchors, titles), each time over every item.
 */
const TYPED_MARK_BOUNDS = new WeakMap<SceneGroup, Bounds>()
function typedMarkBounds(mark: SceneGroup): Bounds {
  let b = TYPED_MARK_BOUNDS.get(mark)
  if (!b) TYPED_MARK_BOUNDS.set(mark, (b = boundTypedMark(new Bounds(), mark)))
  return b
}

/**
 * Does a child of a group add to the group's bounds? Its background box never does (the group's own width and height cover it); nor does
 * a header or footer a grid layout left where it was for want of a column to put it in (`unbounded`).
 */
const countsInBounds = (child: SceneNode): boolean => {
  const c = child as Record<string, unknown>
  return c._bg !== true && c.unbounded !== true
}

/**
 * The bounds vega's Bound pass leaves on a LAID-OUT mark (`mark.bounds`),
 * recursively: a group is its box and the union of its children's, stroke
 * included, translated to its position (marks/group.js `bound`); a child axis /
 * legend mark keeps the bounds its layout gave it (axisLayout / legendLayout
 * overwrite them: the spine rect plus the tick and label extent, the padded
 * box), not the union of its raw leaves (grid rules, the domain, the baked
 * crisp-edge delta, symbol strokes); a typed mark is the union of its items.
 */
export function layoutBounds(node: SceneNode, out = new Bounds()): Bounds {
  const g = node as SceneGroup
  const isGroup = g.marktype === 'group' || (g.marktype === undefined && Array.isArray(g.items))
  if (!isGroup) return g.marktype !== undefined && Array.isArray(g.items) ? out.union(typedMarkBounds(g)) : boundLeaf(out, node as SceneItem)
  return out.union(groupLayoutBounds(g))
}

/**
 * The bounds of a laid-out group item as vega leaves them on the item (`item.bounds`), not unioned into anything: an edge that is not
 * a number stays as it came out (a group at `x: "15px"` has string edges, as vega's does), which is what vega's pick reads.
 * `fresh`: measure every mark anew rather than read the per-mark cache the layout keeps while it builds a scene -- for a reader of a
 * scene that was returned, which a host may have written into (scene-registry.ts: what is derived is made afresh when the same scene
 * is read again).
 */
export function groupLayoutBounds(g: SceneGroup, fresh = false): Bounds {
  if (g.role === 'axis' && (g as Record<string, unknown>).axis !== undefined) return boundAxisGroup(g)
  if (g.role === 'legend') return boundLegendGroup(g)
  // a title the layout placed keeps the extent it measured there (see guide-title.ts)
  if (g.role === 'title' && (g as Record<string, unknown>).titleBounds) return Bounds.copyOf((g as Record<string, unknown>).titleBounds as BoxLike)
  // a group a grid layout moved keeps the box it was measured with, moved with it (see trellis.ts `carry`)
  const laid = (g as { laidBounds?: BoxLike }).laidBounds
  if (laid !== undefined) return Bounds.copyOf(laid)
  const b = new Bounds()
  const clipped = clipsContent(g)
  if (!clipped && g.items) {
    // (each mark's own bounds, as vega leaves them: a group item's raw, which its mark's union reads -- see `eachMarkBounds`)
    const measure = (child: SceneNode): Bounds => {
      const c = child as SceneGroup
      if (c.marktype !== undefined && c.marktype !== 'group' && Array.isArray(c.items)) return fresh ? boundTypedMark(new Bounds(), c) : typedMarkBounds(c)
      return c.marktype === 'group' || (c.marktype === undefined && Array.isArray(c.items)) ? groupLayoutBounds(c, fresh) : boundLeaf(new Bounds(), child as SceneItem)
    }
    eachMarkBounds(g.items.filter((c) => countsInBounds(c)), g.width as number, g.height as number, measure, (mb) => { b.union(mb) })
  }
  if ((clipped || g.width || g.height) && !(g as Record<string, unknown>).noBound) b.add(0, 0).add(g.width || 0, g.height || 0)
  boundStroke(b, g as unknown as SceneItem)
  b.translate(g.x || 0, g.y || 0)
  return b
}

/**
 * Whether a group item clips what it holds (its `clip`): this scene keeps a clipped group item's content in a node that clips it
 * (`contentClip`), the group item itself unclipped. vega bounds a clipped group by its box alone: what it holds adds nothing.
 */
function clipsContent(g: SceneGroup): boolean {
  if (g.clip) return true
  const items = g.items ?? []
  for (let i = 0; i < items.length; i++) if ((items[i] as Record<string, unknown>).contentClip === true) return true
  return false
}

/** A node of a group as vega's bounds pass leaves its bounds: a typed mark's, a group item's (raw), a guide's leaf. */
function rawBoundsOf(child: SceneItem): Bounds {
  const c = child as unknown as SceneGroup
  if (c.marktype !== undefined && c.marktype !== 'group' && Array.isArray(c.items)) return boundTypedMark(new Bounds(), c)
  if (c.marktype === 'group' || (c.marktype === undefined && Array.isArray(c.items))) return boundGroupItem(new Bounds(), c)
  return boundLeaf(new Bounds(), child)
}

/** marks/group.js `bound` — exact (recursive, includes [0,0,w,h] rect). */
export function boundGroupItem(bounds: Bounds, group: SceneGroup): Bounds {
  const clipped = clipsContent(group)
  if (!clipped && group.items) {
    // the background is the group's own box (below), not an item: its rect and stroke are covered by the group's width/height and
    // boundStroke. Its marks are bounded mark by mark (`eachMarkBounds`): a group mark's items into the mark's box first.
    eachMarkBounds(group.items.filter((child) => countsInBounds(child)), group.width as number, group.height as number, (child) => rawBoundsOf(child as SceneItem), (mb) => { bounds.union(mb) })
  }
  if ((clipped || group.width || group.height) && !(group as Record<string, unknown>).noBound) {
    bounds.add(0, 0).add(group.width || 0, group.height || 0)
  }
  boundStroke(bounds, group as unknown as SceneItem)
  return bounds.translate(group.x || 0, group.y || 0)
}
