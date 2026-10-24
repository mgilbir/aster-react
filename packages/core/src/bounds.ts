/**
 * Exact port of vega-scenegraph's bounds computation (Bounds.js, bound/*,
 * marks/{rect,rule,text,group}.js bound functions, boundContext path tracing).
 *
 * The layout passes (trellis/grid layout, view layout) read these measured
 * bounds; pixel-exact parity with vega requires bit-identical arithmetic.
 * Text width uses vega's headless estimate (`~~(0.8 * len * fontSize)`),
 * matching the oracle when no canvas is available.
 */
import { SYMBOL_DEFAULT_SIZE, pushAll } from './util.js'
import type { SceneGroup, SceneItem, SceneNode } from './types.js'
import { computeAreaPath, computeLinePath, symbolPath, trailPath } from './render.js'
import { itemTextWidth } from './text-metrics.js'

// ---------------------------------------------------------------------------
// Bounds — exact port of vega-scenegraph Bounds.js
// ---------------------------------------------------------------------------

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
    this.x1 = +Number.MAX_VALUE
    this.y1 = +Number.MAX_VALUE
    this.x2 = -Number.MAX_VALUE
    this.y2 = -Number.MAX_VALUE
    return this
  }

  empty(): boolean {
    return (
      this.x1 === +Number.MAX_VALUE &&
      this.y1 === +Number.MAX_VALUE &&
      this.x2 === -Number.MAX_VALUE &&
      this.y2 === -Number.MAX_VALUE
    )
  }

  equals(b: Bounds): boolean {
    return this.x1 === b.x1 && this.y1 === b.y1 && this.x2 === b.x2 && this.y2 === b.y2
  }

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

  add(x: number, y: number): this {
    if (x < this.x1) this.x1 = x
    if (y < this.y1) this.y1 = y
    if (x > this.x2) this.x2 = x
    if (y > this.y2) this.y2 = y
    return this
  }

  /** vega Bounds.scale: multiply both extents (NaN-safe like add). */
  scale(sx: number, sy: number): this {
    this.x1 *= sx
    this.y1 *= sy
    this.x2 *= sx
    this.y2 *= sy
    return this
  }

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

  rotate(angle: number, x: number, y: number): this {
    const p = this.rotatedPoints(angle, x, y)
    return this.clear()
      .add(p[0]!, p[1]!)
      .add(p[2]!, p[3]!)
      .add(p[4]!, p[5]!)
      .add(p[6]!, p[7]!)
  }

  rotatedPoints(angle: number, x: number, y: number): number[] {
    const { x1, y1, x2, y2 } = this
    const cos = Math.cos(angle)
    const sin = Math.sin(angle)
    const cx = x - x * cos + y * sin
    const cy = y - x * sin - y * cos
    return [
      cos * x1 - sin * y1 + cx, sin * x1 + cos * y1 + cy,
      cos * x1 - sin * y2 + cx, sin * x1 + cos * y2 + cy,
      cos * x2 - sin * y1 + cx, sin * x2 + cos * y1 + cy,
      cos * x2 - sin * y2 + cx, sin * x2 + cos * y2 + cy,
    ]
  }

  union(b: Bounds): this {
    if (b.x1 < this.x1) this.x1 = b.x1
    if (b.y1 < this.y1) this.y1 = b.y1
    if (b.x2 > this.x2) this.x2 = b.x2
    if (b.y2 > this.y2) this.y2 = b.y2
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
// boundStroke — exact port of bound/boundStroke.js
// ---------------------------------------------------------------------------

export function boundStroke(bounds: Bounds, item: SceneItem, miter?: boolean): Bounds {
  const rec = item as Record<string, unknown>
  if (item.stroke && item.opacity !== 0 && item.strokeOpacity !== 0) {
    const sw = item.strokeWidth != null ? +item.strokeWidth : 1
    const cap = rec.strokeCap === 'square' ? Math.SQRT2 : 1
    let e = cap * sw / 2
    if (miter && (!(rec.strokeJoin ?? rec.strokeLineJoin) || (rec.strokeJoin ?? rec.strokeLineJoin) === 'miter')) {
      e = Math.max(e, (rec.strokeMiterLimit != null ? +rec.strokeMiterLimit : 4) * sw / 2)
    }
    bounds.expand(e)
  }
  return bounds
}

// ---------------------------------------------------------------------------
// Text metrics — port of util/text.js. The estimate below is vega's headless
// fallback; when a canvas is available (real browsers) we measure with the
// same cached measureText vega uses, so browser layout matches browser vega.
// See text-metrics.ts.
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
  return item.limit != null && item.limit > 0 && text.length ? truncate(item, text) : text
}

function truncate(item: SceneItem, text: string): string {
  const limit = +item.limit!
  const width = (t: string) => itemTextWidth(item, t)
  if (width(text) < limit) return text
  const ellipsis = item.ellipsis || '…'
  let lo = 0
  let hi = text.length
  let limit2 = limit - width(ellipsis)
  while (lo < hi) {
    const mid = 1 + ((lo + hi) >>> 1)
    if (width(text.slice(0, mid)) < limit2) lo = mid
    else hi = mid - 1
  }
  return text.slice(0, lo) + ellipsis
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

/** util/text.js `offset(item)` — baseline correction, exact. */
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
// Mark bounds — ports of marks/{text,rect,rule}.js bound + path tracing
// ---------------------------------------------------------------------------

/** Bbox of an annular sector (vega arc item semantics, angles from 12 o'clock). */
export function boundArcItem(bounds: Bounds, it: SceneItem): Bounds {
  const cx = it.x ?? 0
  const cy = it.y ?? 0
  const r = (it.outerRadius ?? it.radius ?? 0) as number
  const r0 = (it.innerRadius ?? 0) as number
  // d3-arc measures angles from the +y-up axis (12 o'clock); our path frame
  // rotates by -PI/2 so the path angle t maps to the direction
  // (cos(t - PI/2), sin(t - PI/2)) in y-down canvas coordinates.
  const a0 = ((it.startAngle ?? 0) as number) - Math.PI / 2
  let a1 = ((it.endAngle ?? 0) as number) - Math.PI / 2
  // sweep length in (0, 2π]: our stack emits descending arcs (start > end),
  // and the swept point set is direction-independent for bounding — vega's
  // bound context normalizes the arc the same way (swaps sa/ea, samples the
  // interior points aligned to 90°).
  let da = a1 - a0
  if (da >= 2 * Math.PI || da <= -2 * Math.PI) da = 2 * Math.PI
  else if (da < 0) da += 2 * Math.PI
  a1 = a0 + da
  const add = (rad: number, ang: number): void => {
    bounds.add(cx + rad * Math.cos(ang), cy + rad * Math.sin(ang))
  }
  add(r, a0)
  add(r, a1)
  // cardinal directions inside the span
  for (const card of [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2, 2 * Math.PI]) {
    for (const laps of [-2 * Math.PI, 0, 2 * Math.PI]) {
      const c = card + laps
      if (c > a0 && c < a1) add(r, c)
    }
  }
  if (r0 > 0) {
    add(r0, a0)
    add(r0, a1)
    for (const card of [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2, 2 * Math.PI]) {
      for (const laps of [-2 * Math.PI, 0, 2 * Math.PI]) {
        const c = card + laps
        if (c > a0 && c < a1) add(r0, c)
      }
    }
  } else {
    // pie sector: the apex is part of the shape
    bounds.add(cx, cy)
  }
  // vega's arc bound always expands with miter semantics (vega-scenegraph
  // bound/arc.js: boundStroke(bounds, item, true)) — the miterLimit default
  // of 4 makes the conservative expansion 2px per side at strokeWidth 1.
  boundStroke(bounds, it, true)
  return bounds
}

/** marks/text.js `bound` — exact (multi-line, align, angle rotation). */
export function boundText(bounds: Bounds, item: SceneItem): Bounds {
  const h = fontSize(item)
  const a = item.align
  const x = item.x || 0
  const y = item.y || 0
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

/** marks/rect.js `bound` — exact (x2/y2 resolved to width/height as vega items carry). */
export function boundRect(bounds: Bounds, item: SceneItem): Bounds {
  let w = (item as Record<string, unknown>).width as number | undefined
  let h = (item as Record<string, unknown>).height as number | undefined
  let x0 = item.x ?? 0
  let y0 = item.y ?? 0
  if (w == null && item.x2 != null) { w = Math.abs((item.x2 as number) - x0); x0 = Math.min(x0, item.x2 as number) }
  if (h == null && item.y2 != null) { h = Math.abs((item.y2 as number) - y0); y0 = Math.min(y0, item.y2 as number) }
  return boundStroke(bounds.set(x0, y0, (x0 + (w as number)) || 0, (y0 + (h as number)) || 0), item)
}

/** marks/rule.js `bound` — exact. */
export function boundRule(bounds: Bounds, item: SceneItem): Bounds {
  const x1 = item.x || 0
  const y1 = item.y || 0
  return boundStroke(bounds.set(x1, y1, item.x2 != null ? item.x2 : x1, item.y2 != null ? item.y2 : y1), item)
}

/** marks/image.js — images bound as their rect. */
function boundImage(bounds: Bounds, item: SceneItem): Bounds {
  const x = item.x || 0
  const y = item.y || 0
  return boundStroke(bounds.set(x, y, (x + (item.width ?? 0)) || 0, (y + (item.height ?? 0)) || 0), item)
}

// ---------------------------------------------------------------------------
// Path tracing — port of bound/boundContext.js applied to SVG path data
// ---------------------------------------------------------------------------

/**
 * Trace an SVG path-data string, accumulating bounds exactly as vega's
 * boundContext does for the shapes it receives from the path generators
 * (curve extrema via quadExtrema/cubicExtrema; arcs sampled at endpoints and
 * quarter-turn aligned interior points; full circles as center ± r).
 */
export function boundsFromPath(
  bounds: Bounds,
  d: string,
  transform?: (x: number, y: number) => [number, number],
): Bounds {
  let lx = 0
  let ly = 0
  let cx0 = 0 // subpath start (for Z)
  let cy0 = 0
  const add = (x: number, y: number) => {
    const p = transform ? transform(x, y) : [x, y]
    bounds.add(p[0]!, p[1]!)
  }

  const quadExtrema = (x0: number, x1: number, x2: number, onY = false) => {
    const t = (x0 - x1) / (x0 + x2 - 2 * x1)
    if (0 < t && t < 1) { const v = x0 + (x1 - x0) * t; if (onY) add(bounds.x1, v); else add(v, bounds.y1) }
  }
  const cubic = (t: number, p0: number, p1: number, p2: number, p3: number) => {
    const s = 1 - t
    const s2 = s * s
    const t2 = t * t
    return s2 * s * p0 + 3 * s2 * t * p1 + 3 * s * t2 * p2 + t2 * t * p3
  }
  const cubicExtrema = (x0: number, x1: number, x2: number, x3: number, onY = false) => {
    const a = x3 - x0 + 3 * x1 - 3 * x2
    const b = x0 + x2 - 2 * x1
    const c = x0 - x1
    let t0 = 0
    let t1 = 0
    const Epsilon = 1e-14
    if (Math.abs(a) > Epsilon) {
      const r = b * b + c * a
      if (r >= 0) {
        const r2 = Math.sqrt(r)
        t0 = (-b + r2) / a
        t1 = (-b - r2) / a
      }
    } else if (b !== 0) {
      t0 = 0.5 * c / b
    }
    for (const t of [t0, t1]) {
      if (0 < t && t < 1) { const v = cubic(t, x0, x1, x2, x3); if (onY) add(bounds.x1, v); else add(v, bounds.y1) }
    }
  }

  // SVG arc (A command) → center parameterization → sample like boundContext.arc
  const arcTo = (x1: number, y1: number, rx: number, ry: number, phiDeg: number, largeArc: number, sweep: number, x2: number, y2: number) => {
    if (rx === 0 || ry === 0) {
      add(x2, y2)
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
    const Lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry)
    if (Lambda > 1) {
      const s = Math.sqrt(Lambda)
      rx *= s
      ry *= s
    }
    const sign = largeArc !== sweep ? 1 : -1
    const numerator = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p
    const denominator = rx * rx * y1p * y1p + ry * ry * x1p * x1p
    const co = sign * Math.sqrt(Math.max(0, numerator / denominator))
    const cxp = co * (rx * y1p) / ry
    const cyp = -co * (ry * x1p) / rx
    const cx = cosPhi * cxp - sinPhi * cyp + (x1 + x2) / 2
    const cy = sinPhi * cxp + cosPhi * cyp + (y1 + y2) / 2

    // angles
    let s2 = 0
    const theta1 = Math.atan2((y1p - cyp) / ry, (x1p - cxp) / rx)
    const theta2 = Math.atan2((-y1p - cyp) / ry, (-x1p - cxp) / rx)
    // sample like vega's boundContext.arc: endpoints + quarter-turn aligned
    // interior points, walking the sweep direction (ccw for sweep=0)
    const Tau = 2 * Math.PI
    const HalfPi = Math.PI / 2
    const ccw = sweep === 0
    if (Math.abs(theta2 - theta1) >= Tau - 1e-8) {
      // full ellipse
      add(cx - rx, cy - ry)
      add(cx + rx, cy + ry)
    } else {
      const update = (a: number) => {
        const px = rx * Math.cos(a)
        const py = ry * Math.sin(a)
        add(cx + px * cosPhi - py * sinPhi, cy + px * sinPhi + py * cosPhi)
      }
      // endpoint angles in sweep direction
      let sa = theta1
      let ea = theta1
      if (ccw) {
        // walk counterclockwise: delta negative
        let delta = theta2 - theta1
        while (delta > 0) delta -= Tau
        ea = theta1 + delta
      } else {
        let delta = theta2 - theta1
        while (delta < 0) delta += Tau
        ea = theta1 + delta
      }
      update(sa)
      update(ea)
      if (ea !== sa) {
        sa = sa % Tau
        if (sa < 0) sa += Tau
        ea = ea % Tau
        if (ea < 0) ea += Tau
        if (ea < sa) {
          // vega: flip direction and swap endpoints
          const flipped = !ccw
          let tmp = sa
          sa = ea
          ea = tmp
          if (flipped) {
            ea -= Tau
            s2 = sa - (sa % HalfPi)
            for (let i = 0; i < 4 && s2 > ea; ++i, s2 -= HalfPi) update(s2)
          } else {
            s2 = sa - (sa % HalfPi) + HalfPi
            for (let i = 0; i < 4 && s2 < ea; ++i, s2 += HalfPi) update(s2)
          }
        } else if (ccw) {
          let e2 = ea - Tau
          s2 = sa - (sa % HalfPi)
          for (let i = 0; i < 4 && s2 > e2; ++i, s2 -= HalfPi) update(s2)
        } else {
          s2 = sa - (sa % HalfPi) + HalfPi
          for (let i = 0; i < 4 && s2 < ea; ++i, s2 += HalfPi) update(s2)
        }
      }
    }
    lx = x2
    ly = y2
  }

  // Tokenize
  const re = /([MmLlHhVvCcSsQqTtAaZz])|(-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/g
  let m: RegExpExecArray | null
  let cmd = ''
  const nums: number[] = []
  let i = 0

  const nextNum = (): number => {
    while (i < nums.length && Number.isNaN(nums[i])) i++
    return nums[i++] as number
  }

  // First pass: collect tokens in order
  const tokens: Array<{ c: string; n: number[] }> = []
  let cur: { c: string; n: number[] } | null = null
  while ((m = re.exec(d))) {
    if (m[1]) {
      cur = { c: m[1], n: [] }
      tokens.push(cur)
    } else if (cur) {
      cur.n.push(parseFloat(m[2]!))
    }
  }

  for (const tok of tokens) {
    cmd = tok.c
    nums.length = 0
    pushAll(nums, tok.n)
    i = 0
    const rel = cmd === cmd.toLowerCase()
    const C = cmd.toUpperCase()
    switch (C) {
      case 'M': {
        // first pair is the moveto; subsequent pairs are implicit linetos
        while (i < nums.length) {
          const x = nextNum() + (rel ? lx : 0)
          const y = nextNum() + (rel ? ly : 0)
          add(x, y)
          lx = cx0 = x
          ly = cy0 = y
        }
        break
      }
      case 'L': {
        while (i < nums.length) {
          lx = nextNum() + (rel ? lx : 0)
          ly = nextNum() + (rel ? ly : 0)
          add(lx, ly)
        }
        break
      }
      case 'H': {
        while (i < nums.length) {
          lx = nextNum() + (rel ? lx : 0)
          add(lx, ly)
        }
        break
      }
      case 'V': {
        while (i < nums.length) {
          ly = nextNum() + (rel ? ly : 0)
          add(lx, ly)
        }
        break
      }
      case 'C': {
        while (i < nums.length) {
          const x1 = nextNum() + (rel ? lx : 0)
          const y1 = nextNum() + (rel ? ly : 0)
          const x2 = nextNum() + (rel ? lx : 0)
          const y2 = nextNum() + (rel ? ly : 0)
          const x = nextNum() + (rel ? lx : 0)
          const y = nextNum() + (rel ? ly : 0)
          cubicExtrema(lx, x1, x2, x)
          cubicExtrema(ly, y1, y2, y, true)
          add(x, y)
          lx = x
          ly = y
        }
        break
      }
      case 'S': {
        while (i < nums.length) {
          const x2 = nextNum() + (rel ? lx : 0)
          const y2 = nextNum() + (rel ? ly : 0)
          const x = nextNum() + (rel ? lx : 0)
          const y = nextNum() + (rel ? ly : 0)
          // reflected control point: unknown previous control → use current point
          cubicExtrema(lx, lx, x2, x)
          cubicExtrema(ly, ly, y2, y, true)
          add(x, y)
          lx = x
          ly = y
        }
        break
      }
      case 'Q': {
        while (i < nums.length) {
          const x1 = nextNum() + (rel ? lx : 0)
          const y1 = nextNum() + (rel ? ly : 0)
          const x = nextNum() + (rel ? lx : 0)
          const y = nextNum() + (rel ? ly : 0)
          quadExtrema(lx, x1, x)
          quadExtrema(ly, y1, y, true)
          add(x, y)
          lx = x
          ly = y
        }
        break
      }
      case 'T': {
        while (i < nums.length) {
          const x = nextNum() + (rel ? lx : 0)
          const y = nextNum() + (rel ? ly : 0)
          quadExtrema(lx, lx, x)
          quadExtrema(ly, ly, y, true)
          add(x, y)
          lx = x
          ly = y
        }
        break
      }
      case 'A': {
        while (i < nums.length) {
          const rx = nextNum()
          const ry = nextNum()
          const rot = nextNum()
          const large = nextNum()
          const sweep = nextNum()
          const x = nextNum() + (rel ? lx : 0)
          const y = nextNum() + (rel ? ly : 0)
          arcTo(lx, ly, rx, ry, rot, large, sweep, x, y)
        }
        break
      }
      case 'Z': {
        lx = cx0
        ly = cy0
        break
      }
    }
  }
  return bounds
}

// ---------------------------------------------------------------------------
// Group bound — exact port of marks/group.js bound
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
      const pathInfo = mark.marktype === 'area' ? computeAreaPath(mark) : computeLinePath(mark)
      if (pathInfo) {
        boundsFromPath(bounds, pathInfo.path)
        // the renderer resolves vega's default line/area strokeWidth=2 at
        // draw time; the bound must measure the same geometry
        const it0 = { ...(items[0] ?? {}) } as Record<string, unknown>
        if (it0.stroke != null && it0.strokeWidth == null) it0.strokeWidth = 2
        boundStroke(bounds, it0 as SceneItem, true)
      }
      return bounds
    }
    case 'trail': {
      if (items.length > 1) {
        const d = trailPath(items)
        if (d) {
          boundsFromPath(bounds, d)
          boundStroke(bounds, items[0] ?? {}, true)
        }
      }
      return bounds
    }
    default:
      // vega's arc/path/symbol bounds always expand with miter semantics
      // (vega-scenegraph bound.js: boundStroke(bounds, item, true)) — the
      // miterLimit default of 4 makes the expansion miterLimit*sw/2 per side
      const miter = miterPaths || mark.marktype === 'arc' || mark.marktype === 'path' || mark.marktype === 'symbol'
      for (const it of items) boundLeaf(bounds, it, miter)
      return bounds
  }
}

/** Bound one leaf item (or nested group/mark item) into `bounds`. */
export function boundLeaf(bounds: Bounds, it: SceneItem, miterPaths = false): Bounds {
  const mt = (it as SceneGroup).marktype
  const hasItems = Array.isArray((it as SceneGroup).items)
  if (mt === 'group' || (mt === undefined && hasItems)) {
    // groups bound in isolation (their stroke expansion must not compound
    // onto the target), then union — mirrors vega's per-item bounds objects
    const b = new Bounds()
    boundGroupItem(b, it as unknown as SceneGroup)
    return bounds.union(b)
  }
  if (mt !== undefined && hasItems) {
    // typed mark nested inside a group: union its per-item bounds
    return boundTypedMark(bounds, it as unknown as SceneGroup, miterPaths)
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
  const meta = (axis as Record<string, unknown>).axis as { orient: string; range: number; baseline?: number; translate?: number } | undefined
  const orient = meta?.orient ?? 'left'
  const range = meta?.range ?? 0
  // The axis line's perpendicular position: for top/bottom axes it sits at the
  // content edge (content top/bottom), not the spine's along-axis extent
  // (`range`). They diverge when autosize fit makes width != height.
  const baseline = meta?.baseline ?? (orient === 'left' || orient === 'right' ? 0 : range)
  const tickLabelBounds = new Bounds()
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
    if (!(leaf as Record<string, unknown>)._title) tickLabelBounds.union(bb)
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
    b.y1 -= 1e-8
  }
  return b
}

/** Bound a single leaf item into an isolated Bounds (vega's per-item bounds). */
function boundIsolated(it: SceneItem, miterPaths = false): Bounds {
  const bounds = new Bounds()
  // Text first: a text mark inherits `radius`/`outerRadius` from the mark def
  // and config.text (e.g. config.text.outerRadius), but vega bounds text as
  // text — those arc properties are inert for it.
  if (it.text != null && (it as SceneGroup).marktype === undefined) {
    // Bare text leaves carry vega's raw item y (the baseline shift is the
    // renderer's bake) and vega's guide-label fontSize — 10 when the builder
    // left it unset on a baseline-shifted label, 11 otherwise (guide titles).
    const fsLeaf = it.fontSize as number | undefined
    const fsEff = fsLeaf ?? (it.baseline != null && it.baseline !== 'alphabetic' ? 10 : 11)
    const savedFs = it.fontSize
    ;(it as Record<string, unknown>).fontSize = fsEff
    const out = boundText(bounds, it)
    ;(it as Record<string, unknown>).fontSize = savedFs
    return out
  }
  if (it.text != null) {
    return boundText(bounds, it)
  }
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
    const sxP = (it as Record<string, unknown>).scaleX as number | undefined
    const syP = (it as Record<string, unknown>).scaleY as number | undefined
    const angleP = (it as Record<string, unknown>).angle as number | undefined
    if (angleP) {
      // vega's path bound runs pathRender through boundContext: every path
      // coordinate is scaled, translated by item x/y, then rotated as a point
      // (unlike the SVG transform, which rotates in the item-local frame).
      // Trace with that exact point transform so rotated extrema match.
      const a = angleP * Math.PI / 180
      const cos = Math.cos(a)
      const sin = Math.sin(a)
      const tx = it.x || 0
      const ty = it.y || 0
      const sx = sxP ?? 1
      const sy = syP ?? 1
      boundsFromPath(bounds, it.path, (x, y) => {
        const px = x * sx + tx
        const py = y * sy + ty
        return [cos * px - sin * py, sin * px + cos * py]
      })
    } else {
      boundsFromPath(bounds, it.path)
      // path marks carry scaleX/scaleY: vega's path bound renders the parsed
      // path through pathRender(ctx, x, y, sx, sy) — the path scales about its
      // local origin before the item translate.
      if ((sxP != null && sxP !== 1) || (syP != null && syP !== 1)) {
        bounds.scale(sxP ?? 1, syP ?? 1)
      }
      bounds.translate(it.x || 0, it.y || 0)
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
    if (it.shape === 'circle' || !angle) {
      bounds.add(-r, -r)
      bounds.add(r, r)
    } else {
      boundsFromPath(bounds, symbolPath(String(it.shape), r))
      bounds.rotate(angle * Math.PI / 180, 0, 0)
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
    if (!shape || shape === 'circle' || shape === 'point' || !angle) {
      bounds.add(-r, -r)
      bounds.add(r, r)
    } else {
      boundsFromPath(bounds, symbolPath(shape, r))
      bounds.rotate(angle * Math.PI / 180, 0, 0)
    }
    boundStroke(bounds, it, true)
    return bounds.translate(x, y)
  }
  return boundRect(bounds, it)
}

/** marks/group.js `bound` — exact (recursive, includes [0,0,w,h] rect). */
export function boundGroupItem(bounds: Bounds, group: SceneGroup): Bounds {
  if (!group.clip && group.items) {
    const items = group.items
    for (let j = 0; j < items.length; ++j) {
      boundLeaf(bounds, items[j] as SceneItem)
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
