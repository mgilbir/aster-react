/**
 * The extent of what a scene draws: a box type, and the bounds of every kind of item (text, rects, rules, symbols and other shaped
 * paths, arcs, images, groups). The layout passes (grids, guides, the size of the view) read these, and a view's size is a whole
 * number of pixels rounded up from them, so the arithmetic is Vega's, operation for operation: a measurement that differs in the
 * last digit can add a pixel. Text is measured with the estimate a headless Vega uses (`~~(0.8 * length * fontSize)`) unless a
 * canvas is there to measure it, as in a browser.
 */
import { SYMBOL_DEFAULT_SIZE, pushAll } from './util.js'
import type { SceneGroup, SceneItem, SceneNode } from './types.js'
import { arcInto, areaInto, lineInto, symbolPathExact, trailInto } from './render.js'
import { BoundsPen, cubicAt, cubicTurns } from './bounds-pen.js'
import { parseSvgPath, renderSvgPath } from './svg-path.js'
import { itemTextWidth, textAnchor, truncateToLimit } from './text-metrics.js'
import { SHAPE_BOUNDS } from './registry.js'
import { imageBox } from './image-box.js'

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
  const rec = it as Record<string, unknown>
  const outer = (it.outerRadius ?? it.radius ?? 0) as number
  arcInto(new BoundsPen(bounds, +(rec.angle as number) || 0), 0, 0, outer, (it.innerRadius ?? 0) as number,
    (it.startAngle as number) || 0, (it.endAngle as number) || 0, (rec.cornerRadius as number) || 0, (rec.padAngle as number) || 0)
  return boundStroke(bounds, it, true).translate(it.x || 0, it.y || 0)
}

/** The box of a text item: its lines at its alignment and baseline, turned by its angle about the anchor. */
export function boundText(bounds: Bounds, item: SceneItem): Bounds {
  const h = fontSize(item)
  const a = item.align
  const [x, y] = textAnchor(item)
  const dx = item.dx || 0
  const dy = (item.dy || 0) + baselineOffset(item) - Math.round(0.8 * h)
  const tl = textLines(item)
  let w: number
  let hh = h

  if (Array.isArray(tl)) {
    hh += lineHeight(item) * (tl.length - 1)
    w = tl.reduce((acc: number, t: string) => Math.max(acc, textWidth(item, t)), 0)
  } else {
    w = textWidth(item, tl)
  }

  let ddx = dx
  if (a === 'center') ddx -= w / 2
  else if (a === 'right') ddx -= w

  bounds.set(ddx + x, dy + y, ddx + x + w, dy + y + hh)

  if (item.angle) {
    bounds.rotate(item.angle * DEG_TO_RAD, x, y)
  }
  return bounds
}

/** The box of a rect: from its corner by its width and height (or to its x2 and y2), stroke included. */
export function boundRect(bounds: Bounds, item: SceneItem): Bounds {
  let w = (item as Record<string, unknown>).width as number | undefined
  let h = (item as Record<string, unknown>).height as number | undefined
  let x0 = item.x ?? 0
  let y0 = item.y ?? 0
  if (w == null && item.x2 != null) { w = Math.abs((item.x2 as number) - x0); x0 = Math.min(x0, item.x2 as number) }
  if (h == null && item.y2 != null) { h = Math.abs((item.y2 as number) - y0); y0 = Math.min(y0, item.y2 as number) }
  return boundStroke(bounds.set(x0, y0, (x0 + (w as number)) || 0, (y0 + (h as number)) || 0), item)
}

/** The box of a rule: the segment from (x, y) to (x2, y2), stroke included. */
export function boundRule(bounds: Bounds, item: SceneItem): Bounds {
  const x1 = item.x || 0
  const y1 = item.y || 0
  return boundStroke(bounds.set(x1, y1, item.x2 != null ? item.x2 : x1, item.y2 != null ? item.y2 : y1), item)
}

/** marks/image.js — images bound as their rect. */
function boundImage(bounds: Bounds, item: SceneItem): Bounds {
  const { x, y, w, h } = imageBox(item)
  return boundStroke(bounds.set(x, y, x + w, y + h), item)
}

// ---------------------------------------------------------------------------
// The extent of path data
// ---------------------------------------------------------------------------

/**
 * The extent of a symbol shape's path at a radius, traced once: a legend measures the same few shapes in every evaluation.
 * (Adding the two corners of the extent to the box is adding every point of the path to it.)
 */
const SHAPE_EXTENTS = new Map<string, [number, number, number, number]>()
function addShapeExtent(bounds: Bounds, shape: string, r: number, pathOf: (shape: string, r: number) => unknown, angle = 0): void {
  const key = shape + '|' + r + '|' + (pathOf === symbolPathExact ? 'e' : 'p') + (angle ? '|' + angle : '')
  let ext = SHAPE_EXTENTS.get(key)
  if (ext === undefined) {
    const b = new Bounds()
    boundsFromPath(b, angle ? rotatePath(String(pathOf(shape, r)), angle) : String(pathOf(shape, r)))
    ext = [b.x1, b.y1, b.x2, b.y2]
    if (SHAPE_EXTENTS.size > 256) SHAPE_EXTENTS.clear()
    SHAPE_EXTENTS.set(key, ext)
  }
  if (ext[0] <= ext[2] && ext[1] <= ext[3]) bounds.add(ext[0], ext[1]).add(ext[2], ext[3])
}

const PATH_TOKEN = /([MmLlHhVvCcSsQqTtAaZz])|(-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/g

/** Path data as its commands, each with the numbers that follow its letter (however many there are). */
function pathTokens(d: string): Array<{ c: string; n: number[] }> {
  const tokens: Array<{ c: string; n: number[] }> = []
  let current: { c: string; n: number[] } | null = null
  PATH_TOKEN.lastIndex = 0
  for (let m = PATH_TOKEN.exec(d); m; m = PATH_TOKEN.exec(d)) {
    if (m[1]) tokens.push((current = { c: m[1], n: [] }))
    else if (current) current.n.push(parseFloat(m[2]!))
  }
  return tokens
}

/**
 * A path with every point rotated about the origin, in absolute commands. The bounds of a rotated shape come from its rotated
 * points (control points too) and the extrema of the curves they make, which are not those of its unrotated box turned; an arc
 * keeps its radii and takes the turn on its x-axis rotation.
 */
export function rotatePath(d: string, deg: number): string {
  const rot = deg * (Math.PI / 180)
  const cos = Math.cos(rot)
  const sin = Math.sin(rot)
  const px = (x: number, y: number): string => `${cos * x - sin * y},${sin * x + cos * y}`
  let x = 0
  let y = 0
  let sx = 0
  let sy = 0
  let out = ''
  for (const t of pathTokens(d)) {
    const rel = t.c === t.c.toLowerCase()
    const n = t.n
    switch (t.c.toUpperCase()) {
      case 'M':
        for (let i = 0; i + 1 < n.length; i += 2) {
          x = n[i]! + (rel ? x : 0); y = n[i + 1]! + (rel ? y : 0)
          if (i === 0) { sx = x; sy = y }
          out += (i === 0 ? 'M' : 'L') + px(x, y)
        }
        break
      case 'L':
        for (let i = 0; i + 1 < n.length; i += 2) { x = n[i]! + (rel ? x : 0); y = n[i + 1]! + (rel ? y : 0); out += 'L' + px(x, y) }
        break
      case 'H':
        for (const v of n) { x = v + (rel ? x : 0); out += 'L' + px(x, y) }
        break
      case 'V':
        for (const v of n) { y = v + (rel ? y : 0); out += 'L' + px(x, y) }
        break
      case 'C':
        for (let i = 0; i + 5 < n.length; i += 6) {
          const o = rel ? [x, y] : [0, 0]
          out += `C${px(n[i]! + o[0]!, n[i + 1]! + o[1]!)},${px(n[i + 2]! + o[0]!, n[i + 3]! + o[1]!)},${px(n[i + 4]! + o[0]!, n[i + 5]! + o[1]!)}`
          x = n[i + 4]! + o[0]!; y = n[i + 5]! + o[1]!
        }
        break
      case 'S':
        // (the control point the tracer assumes without a previous curve: the current point)
        for (let i = 0; i + 3 < n.length; i += 4) {
          const o = rel ? [x, y] : [0, 0]
          out += `C${px(x, y)},${px(n[i]! + o[0]!, n[i + 1]! + o[1]!)},${px(n[i + 2]! + o[0]!, n[i + 3]! + o[1]!)}`
          x = n[i + 2]! + o[0]!; y = n[i + 3]! + o[1]!
        }
        break
      case 'Q':
        for (let i = 0; i + 3 < n.length; i += 4) {
          const o = rel ? [x, y] : [0, 0]
          out += `Q${px(n[i]! + o[0]!, n[i + 1]! + o[1]!)},${px(n[i + 2]! + o[0]!, n[i + 3]! + o[1]!)}`
          x = n[i + 2]! + o[0]!; y = n[i + 3]! + o[1]!
        }
        break
      case 'T':
        for (let i = 0; i + 1 < n.length; i += 2) {
          const nx = n[i]! + (rel ? x : 0)
          const ny = n[i + 1]! + (rel ? y : 0)
          out += `Q${px(x, y)},${px(nx, ny)}`
          x = nx; y = ny
        }
        break
      case 'A':
        for (let i = 0; i + 6 < n.length; i += 7) {
          x = n[i + 5]! + (rel ? x : 0); y = n[i + 6]! + (rel ? y : 0)
          out += `A${n[i]},${n[i + 1]},${n[i + 2]! + deg},${n[i + 3]},${n[i + 4]},${px(x, y)}`
        }
        break
      case 'Z':
        x = sx; y = sy
        out += 'Z'
        break
    }
  }
  return out
}

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
      if (ccw) while (delta > 0) delta -= Tau
      else while (delta < 0) delta += Tau
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
  for (const token of pathTokens(d)) {
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

/**
 * Compute a mark's bounds (union of item bounds), matching vega's
 * mark-level bound: group items recurse via boundGroupItem; typed marks
 * union their leaf items' bounds (line/area/trail trace the emitted path).
 */
export function boundMark(node: SceneNode, out?: Bounds): Bounds {
  const bounds = out ?? new Bounds()
  const type = (node as SceneGroup).marktype
  if (type === 'group' || (type === undefined && Array.isArray((node as SceneGroup).items))) {
    return boundGroupItem(bounds, node as SceneGroup)
  }
  return boundTypedMark(bounds, node as SceneGroup)
}

/** Bound a typed (non-group) mark: per-type geometry. */
export function boundTypedMark(bounds: Bounds, mark: SceneGroup, miterPaths = false): Bounds {
  const items = (mark.items ?? []) as SceneItem[]
  switch (mark.marktype) {
    case 'line':
    case 'area': {
      // an area is bounded by its filled polygon (top edge AND baseline), a line
      // by its polyline: computeLinePath on an area dropped the baseline, so
      // autosize:pad clipped areas that extend below/above their top edge
      const drawn = new Bounds()
      const pen = new BoundsPen(drawn)
      if (mark.marktype === 'area') areaInto(pen, items)
      else lineInto(pen, items)
      if (!drawn.empty()) {
        // the renderer resolves vega's default line strokeWidth=2 at
        // draw time; the bound must measure the same geometry
        const it0 = { ...(items[0] ?? {}) } as Record<string, unknown>
        if (mark.marktype === 'line' && it0.stroke != null && it0.strokeWidth == null) it0.strokeWidth = 2
        bounds.union(boundStroke(drawn, it0 as SceneItem, true))
      }
      return bounds
    }
    case 'trail': {
      if (items.length > 1) {
        const drawn = new Bounds()
        trailInto(new BoundsPen(drawn), items)
        if (!drawn.empty()) boundStroke(drawn, items[0] ?? {}, true)
        bounds.union(drawn)
      }
      return bounds
    }
    case 'text': {
      // marks/text.js bound: every item of a text mark is text, whether or not its `text` came out defined (a text
      // mark positioned and filled from a signal that holds nothing still has the bounds of an empty line at (0, 0))
      for (const it of items) bounds.union(boundText(new Bounds(), { ...it, _kind: 'text' } as SceneItem))
      return bounds
    }
    case 'path':
      // an item with no path draws nothing and measures nothing, not even its stroke: it stands at the origin
      for (const it of items) {
        if (it.path == null) bounds.add(0, 0)
        else boundLeaf(bounds, it, true)
      }
      return bounds
    default:
      // vega's arc/path/symbol bounds always expand with miter semantics
      // (vega-scenegraph bound.js: boundStroke(bounds, item, true)) — the
      // miterLimit default of 4 makes the expansion miterLimit*sw/2 per side
      const miter = miterPaths || mark.marktype === 'arc' || mark.marktype === 'path' || mark.marktype === 'symbol' || mark.marktype === 'shape' || (mark.marktype as string) === 'geoshape'
      for (const it of items) boundLeaf(bounds, it, miter)
      return bounds
  }
}

/** Bound one leaf item (or nested group/mark item) into `bounds`. */
export function boundLeaf(bounds: Bounds, it: SceneItem, miterPaths = false): Bounds {
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
    boundTypedMark(b, it as unknown as SceneGroup, miterPaths)
    return bounds.union(b)
  }
  return bounds.union(boundIsolated(it, miterPaths))
}

/**
 * Bound an axis group the way vega's layout reads it: the axis mark bounds
 * are (ticks ∪ labels) ∪ spine ∪ title, measured in the axis-internal frame.
 * Our scene bakes the 0.5px axis delta into the axis leaves (shift it back
 * out) and renders the domain as a leaf (vega's axisLayout excludes the
 * domain from its bounds — the spine rect covers the axis line instead).
 */
export function boundAxisGroup(axis: SceneGroup): Bounds {
  const b = new Bounds()
  const meta = (axis as Record<string, unknown>).axis as { orient: string; range: number; baseline?: number; translate?: number; noLayout?: boolean; bounds?: Bounds } | undefined
  // an axis built by guide-axis.ts carries the bounds its layout left on the mark (vega's `item.mark.bounds`)
  if (meta?.bounds) return meta.noLayout === true ? b : meta.bounds.clone()
  // an axis whose orient is none of the four: axisLayout's `default` branch leaves its position undefined, so its
  // bounds are NaN and union into nothing
  if (meta?.noLayout === true) return b
  const orient = meta?.orient ?? 'left'
  const range = meta?.range ?? 0
  // The axis line's perpendicular position: for top/bottom axes it sits at the
  // content edge (content top/bottom), not the spine's along-axis extent
  // (`range`). They diverge when autosize fit makes width != height.
  const baseline = meta?.baseline ?? (orient === 'left' || orient === 'right' ? 0 : range)
  const tickLabelBounds = new Bounds()
  const titleBounds = new Bounds()
  let axisTitleText = ''
  for (const it of axis.items ?? []) {
    const leaf = it as SceneItem
    if ((leaf as Record<string, unknown>)._domain) continue
    if ((leaf as Record<string, unknown>)._grid) continue
    if ((leaf as Record<string, unknown>)._title && typeof leaf.text === 'string') axisTitleText = leaf.text
    // vega's bound pass skips overlap-hidden (opacity 0) labels: the
    // invisible huge tick labels of a temporal/numeric x axis must not widen
    // the view, while the visible end label's overhang does.
    if (leaf.opacity === 0) continue
    const bb = new Bounds()
    // Guide leaves carry vega's raw item positions (the baseline shift is the
    // renderer's bake), so boundText's baseline-aware boxing applies directly.
    boundLeaf(bb, leaf)
    bb.translate(-(meta?.translate ?? 0.5), -(meta?.translate ?? 0.5))
    b.union(bb)
    if ((leaf as Record<string, unknown>)._title) titleBounds.union(bb)
    else tickLabelBounds.union(bb)
  }
  // spine rect per orient; s = tick/label extent beyond the axis line,
  // clamped by the axis minExtent/maxExtent (vega axisLayout:
  // s = max(minExtent, min(maxExtent, bound)))
  const metaX = (axis as Record<string, unknown>).axis as { minExtent?: number; maxExtent?: number } | undefined
  const minE = metaX?.minExtent ?? 0
  const maxE = metaX?.maxExtent ?? 200
  const clampS = (v: number): number => Math.max(minE, Math.min(maxE, v))
  let s: number
  // `position` anchors the axis along its line (vega axisLayout applies the
  // group translate (x, y) to the whole bounds, spine rect included).
  const pos = (meta as { position?: number } | undefined)?.position ?? 0
  if (orient === 'left') {
    s = tickLabelBounds.empty() ? 0 : clampS(-Math.min(0, tickLabelBounds.x1))
    b.add(-s, pos).add(0, pos + range)
  } else if (orient === 'right') {
    s = tickLabelBounds.empty() ? 0 : clampS(Math.max(range, tickLabelBounds.x2) - range)
    b.add(range, pos).add(range + s, pos + range)
  } else if (orient === 'top') {
    s = tickLabelBounds.empty() ? 0 : clampS(-Math.min(0, tickLabelBounds.y1))
    b.add(pos, -s).add(pos + range, baseline)
  } else {
    s = tickLabelBounds.empty() ? 0 : clampS(Math.max(baseline, tickLabelBounds.y2) - baseline)
    b.add(pos, baseline).add(pos + range, baseline + s)
  }
  // A long rotated guide title can carry our fp residue just past an integer
  // where vega's arithmetic is exact (or vice versa). When the endpoint is not
  // exactly integral, nudge it past the margin's epsilon guard so ceil() keeps
  // vega's extra pixel; an exactly integral endpoint must stay put.
  if (axisTitleText.length >= 14) {
    // The along-axis extent (y1 for a top margin, x1 for a left margin) is the
    // one that can land exactly on an integer. Our rotated-title x residue is
    // the only value that must stay put when exact (a variancep title lands on
    // -86 while a count title carries -46.00000000000001).
    if (b.x1 !== Math.trunc(b.x1)) b.x1 -= 1e-8
    // The same for y1, and only when the TITLE is what sets it: a title that stays inside the axis (a 16-character
    // count title on a 200px axis) carries no residue, and nudging the tick labels' exact -5 past it made the margin
    // one pixel too tall.
    if (!titleBounds.empty() && titleBounds.y1 <= b.y1) b.y1 -= 1e-8
  }
  return b
}

/** Bound a single leaf item into an isolated Bounds (vega's per-item bounds). */
function boundIsolated(it: SceneItem, miterPaths = false): Bounds {
  const bounds = new Bounds()
  // Text first: a text mark inherits `radius`/`outerRadius` from the mark def
  // and config.text (e.g. config.text.outerRadius), but vega bounds text as
  // text -- those arc properties are inert for it. (A guide leaf is a text item
  // like any other: its font size is the item's, 11 when it has none.)
  if (it._kind === 'text' || (it._kind === undefined && it.text != null)) return boundText(bounds, it)
  // a guide's rule says what it is, whatever other channels (a width, a height) its encode gave it
  if (it._kind === 'rule') return boundRule(bounds, it)
  // Arc items: the geometry is angular (outerRadius/innerRadius/angles), not a
  // stored path — bound the annular sector analytically (vega bounds the
  // d3-arc path through the recording context; the analytic bbox matches to
  // the canonical precision).
  if (it.path == null && (it.outerRadius != null || it.innerRadius != null || it.startAngle != null || it.endAngle != null)) {
    return boundArcItem(bounds, it)
  }
  if (it.path != null) {
    // path/symbol/arc/geoshape items: trace the emitted path, then
    // boundStroke, then translate by item x/y (markItemPath bound).
    // Miter expansion applies only to mark items; our baked group-background
    // paths (stroke without an explicit strokeWidth) expand non-miter, like
    // vega's group stroke bound.
    // An empty path (a geo shape entirely clipped away) bounds to nothing:
    // vega's boundPath leaves the bounds untouched, so no stroke expansion.
    if (it.path === '') return bounds
    const rec = it as Record<string, unknown>
    // a projected shape bounds from its unrounded geometry, as vega's bound context sees it, not from the path string
    const exact = !rec.angle && it.datum && it.path === (it.datum as Record<string, unknown>).shape ? SHAPE_BOUNDS.get(it.datum as object)?.() : undefined
    if (exact) {
      bounds.add(exact[0], exact[1])
      bounds.add(exact[2], exact[3])
      bounds.translate(it.x || 0, it.y || 0)
    } else {
      // the path as it is drawn: scaled about its own origin, moved to the item, then turned by the item's angle (the turn is the
      // pen's); the same replay, arcs as bezier approximations included, that draws a custom symbol
      let commands: ReturnType<typeof parseSvgPath> | null = null
      try { commands = parseSvgPath(it.path) } catch { /* a path that does not parse is measured as far as it reads */ }
      if (commands) renderSvgPath(new BoundsPen(bounds, +(rec.angle as number) || 0), commands, it.x || 0, it.y || 0, (rec.scaleX as number) || 1, (rec.scaleY as number) || 1)
      else {
        boundsFromPath(bounds, it.path)
        bounds.translate(it.x || 0, it.y || 0)
      }
    }
    boundStroke(bounds, it, miterPaths || it.strokeWidth != null)
    return bounds
  }
  if (it.shape != null && it.radius != null) {
    // Symbol: vega bounds the shape path rotated about the item origin, then
    // inflates by the stroke and translates to the item position.
    const r = it.radius
    const x = it.x || 0
    const y = it.y || 0
    const angle = (it as Record<string, unknown>).angle as number | undefined
    if (it.shape === 'circle') {
      bounds.add(-r, -r)
      bounds.add(r, r)
    } else {
      addShapeExtent(bounds, String(it.shape), r, symbolPathExact, angle)
    }
    boundStroke(bounds, it, true)
    return bounds.translate(x, y)
  }
  if (it.url != null) {
    return boundImage(bounds, it)
  }
  if (it.width != null || it.height != null) {
    return boundRect(bounds, it)
  }
  if (it.x2 != null || it.y2 != null) {
    // rule (x2/y2 line segment)
    return boundRule(bounds, it)
  }
  if (it.x != null || it.y != null || it.size != null) {
    // point symbol: size 64 / shape circle by default (vega's `sz` default). A symbol with a null position (a geopoint the
    // projection refused) still bounds as a circle at (0,0): vega's `x - r`
    // coerces null to 0 (albersusa sweep case).
    const r = Math.sqrt(((it.size as number) ?? SYMBOL_DEFAULT_SIZE)) / 2
    // vega's symbol field accessors coerce a NaN/null position to 0 (`x || 0`);
    // a degenerate scale (log/symlog at zero) still paints the mark at the
    // origin, and its bounds drive the view padding just like any other symbol.
    const x = it.x || 0
    const y = it.y || 0
    const shape = (it as Record<string, unknown>).shape as string | undefined
    const angle = (it as Record<string, unknown>).angle as number | undefined
    // 'point' is not a symbol name: vega's d3-symbol fallback is a circle,
    // whose bounds are rotation-invariant.
    // (every other shape is traced, rotated or not: vega's symbol bound is the shape's path through boundContext)
    if (!shape || shape === 'circle' || shape === 'point') {
      bounds.add(-r, -r)
      bounds.add(r, r)
    } else {
      addShapeExtent(bounds, shape, r, symbolPathExact, angle)
    }
    boundStroke(bounds, it, true)
    return bounds.translate(x, y)
  }
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
  const own = rec.legendBounds as Bounds | undefined
  if (own) return own.clone().translate(g.x ?? 0, g.y ?? 0)
  const stroked = rec._borderStroke === true
    || (rec._borderStroke === undefined
      // vega's boundStroke expands by strokeWidth/2 - a zero-width stroke (the gradient rect's #ddd) does not move the bounds
      && (g.items as SceneItem[] | undefined)?.some((it) => it.stroke != null && it.path != null && (it.strokeWidth ?? 1) > 0))
  const se = stroked ? ((g.strokeWidth != null ? g.strokeWidth : 1) / 2) : 0
  return new Bounds().set((g.x ?? 0) - se, (g.y ?? 0) - se, (g.x ?? 0) + (g.width ?? 0) + se, (g.y ?? 0) + (g.height ?? 0) + se)
}

/**
 * vega-view-transforms' Bound pass ends every mark with `boundClip(mark)`: a mark with `clip` has its bounds
 * intersected with the ENCLOSING group's frame [0, 0, group.width, group.height] (vega-scenegraph
 * boundClip), so what a clipped mark draws outside the frame never grows the view. A group mark is one
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
    const n = items[i] as SceneGroup
    if (n.markClip === true && n.marktype === 'group') {
      const mb = new Bounds()
      let j = i
      while (j < items.length && (items[j] as SceneGroup).markClip === true && (items[j] as SceneGroup).name === n.name) mb.union(measure(items[j]!)), j++
      out(mb.intersect(frame()), n)
      i = j
      continue
    }
    const b = measure(n)
    out(n.clip === true && n.marktype !== undefined && n.marktype !== 'group' && Array.isArray(n.items) ? new Bounds().union(b).intersect(frame()) : b, n)
    i++
  }
}

/**
 * The bounds of a typed mark, cached per mark object: a scene that has been
 * returned is never written (C52), and a layout reads the same marks several
 * times (grid cells, guide anchors, titles), each time over every item.
 */
const TYPED_MARK_BOUNDS = new WeakMap<SceneGroup, Bounds>()
function typedMarkBounds(mark: SceneGroup): Bounds {
  let b = TYPED_MARK_BOUNDS.get(mark)
  if (!b) TYPED_MARK_BOUNDS.set(mark, (b = boundTypedMark(new Bounds(), mark)))
  return b
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
  if (g.role === 'axis' && (g as Record<string, unknown>).axis !== undefined) return out.union(boundAxisGroup(g))
  if (g.role === 'legend') return out.union(boundLegendGroup(g))
  const b = new Bounds()
  if (!g.clip && g.items) {
    const measure = (child: SceneNode): Bounds => {
      const c = child as SceneGroup
      return c.marktype !== undefined && c.marktype !== 'group' && Array.isArray(c.items) ? typedMarkBounds(c) : layoutBounds(child)
    }
    if (hasClippedMark(g.items)) {
      eachMarkBounds(g.items.filter((child) => (child as Record<string, unknown>)._bg !== true), g.width || 0, g.height || 0, measure, (mb) => { b.union(mb) })
    } else {
      for (const child of g.items) {
        if ((child as Record<string, unknown>)._bg === true) continue
        const c = child as SceneGroup
        if (c.marktype !== undefined && c.marktype !== 'group' && Array.isArray(c.items)) b.union(typedMarkBounds(c))
        else layoutBounds(child, b)
      }
    }
  }
  if ((g.clip || g.width || g.height) && !(g as Record<string, unknown>).noBound) b.add(0, 0).add(g.width || 0, g.height || 0)
  boundStroke(b, g as unknown as SceneItem)
  b.translate(g.x || 0, g.y || 0)
  return out.union(b)
}

/** marks/group.js `bound` — exact (recursive, includes [0,0,w,h] rect). */
export function boundGroupItem(bounds: Bounds, group: SceneGroup): Bounds {
  if (!group.clip && group.items) {
    // the background is the group's own box (below), not an item: its rect and
    // stroke are covered by the group's width/height and boundStroke
    const items = group.items
    if (hasClippedMark(items)) {
      eachMarkBounds(items.filter((child) => (child as Record<string, unknown>)._bg !== true), group.width || 0, group.height || 0, (child) => boundLeaf(new Bounds(), child as SceneItem), (mb) => { bounds.union(mb) })
    } else {
      for (let j = 0; j < items.length; ++j) {
        if ((items[j] as Record<string, unknown>)._bg === true) continue
        boundLeaf(bounds, items[j] as SceneItem)
      }
    }
  }
  if ((group.clip || group.width || group.height) && !(group as Record<string, unknown>).noBound) {
    bounds.add(0, 0).add(group.width || 0, group.height || 0)
  }
  boundStroke(bounds, group as unknown as SceneItem)
  return bounds.translate(group.x || 0, group.y || 0)
}

/**
 * Compute the bounds of a scene node in its parent's coordinate frame
 * (group items' bounds include their own x/y translate; leaf marks' bounds
 * include item x/y as vega computes them).
 */
export function boundsOf(node: SceneNode): Bounds {
  return boundMark(node, new Bounds())
}
