/**
 * Exact port of vega-scenegraph's bounds computation (Bounds.js, bound/*,
 * marks/{rect,rule,text,group}.js bound functions, boundContext path tracing).
 *
 * The layout passes (trellis/grid layout, view layout) read these measured
 * bounds; pixel-exact parity with vega requires bit-identical arithmetic.
 * Text width uses vega's headless estimate (`~~(0.8 * len * fontSize)`),
 * matching the oracle when no canvas is available.
 */
import type { SceneGroup, SceneItem, SceneNode } from './types.js'
import { computeLinePath, trailPath } from './render.js'

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
    if (miter && (!rec.strokeLineJoin || rec.strokeLineJoin === 'miter')) {
      e = Math.max(e, (rec.strokeMiterLimit != null ? +rec.strokeMiterLimit : 4) * sw / 2)
    }
    bounds.expand(e)
  }
  return bounds
}

// ---------------------------------------------------------------------------
// Text metrics — exact port of util/text.js (headless estimate path)
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
  const width = (t: string) => estimateWidth(t, fontSize(item))
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

function estimateWidth(text: string, currentFontHeight: number): number {
  return ~~(0.8 * text.length * currentFontHeight)
}

export function textWidth(item: SceneItem, line: unknown): number {
  return fontSize(item) <= 0 || !(line = textValue(item, line)) ? 0 : estimateWidth(line as string, fontSize(item))
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
export function boundsFromPath(bounds: Bounds, d: string): Bounds {
  let lx = 0
  let ly = 0
  let cx0 = 0 // subpath start (for Z)
  let cy0 = 0
  const add = (x: number, y: number) => bounds.add(x, y)

  const quadExtrema = (x0: number, x1: number, x2: number) => {
    const t = (x0 - x1) / (x0 + x2 - 2 * x1)
    if (0 < t && t < 1) add(x0 + (x1 - x0) * t, bounds.y1)
  }
  const cubic = (t: number, p0: number, p1: number, p2: number, p3: number) => {
    const s = 1 - t
    const s2 = s * s
    const t2 = t * t
    return s2 * s * p0 + 3 * s2 * t * p1 + 3 * s * t2 * p2 + t2 * t * p3
  }
  const cubicExtrema = (x0: number, x1: number, x2: number, x3: number) => {
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
    if (0 < t0 && t0 < 1) add(cubic(t0, x0, x1, x2, x3), bounds.y1)
    if (0 < t1 && t1 < 1) add(cubic(t1, x0, x1, x2, x3), bounds.y1)
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
    nums.push(...tok.n)
    i = 0
    const rel = cmd === cmd.toLowerCase()
    const C = cmd.toUpperCase()
    switch (C) {
      case 'M': {
        // first pair is the moveto; subsequent pairs are implicit linetos
        while (i < nums.length) {
          const x = nextNum() + (rel ? lx : 0)
          const y = nextNum() + (rel ? ly : 0)
          bounds.add(x, y)
          lx = cx0 = x
          ly = cy0 = y
        }
        break
      }
      case 'L': {
        while (i < nums.length) {
          lx = nextNum() + (rel ? lx : 0)
          ly = nextNum() + (rel ? ly : 0)
          bounds.add(lx, ly)
        }
        break
      }
      case 'H': {
        while (i < nums.length) {
          lx = nextNum() + (rel ? lx : 0)
          bounds.add(lx, ly)
        }
        break
      }
      case 'V': {
        while (i < nums.length) {
          ly = nextNum() + (rel ? ly : 0)
          bounds.add(lx, ly)
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
          cubicExtrema(ly, y1, y2, y)
          bounds.add(x, y)
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
          cubicExtrema(ly, ly, y2, y)
          bounds.add(x, y)
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
          quadExtrema(ly, y1, y)
          bounds.add(x, y)
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
          quadExtrema(ly, ly, y)
          bounds.add(x, y)
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
export function boundTypedMark(bounds: Bounds, mark: SceneGroup): Bounds {
  const items = (mark.items ?? []) as SceneItem[]
  switch (mark.marktype) {
    case 'line':
    case 'area': {
      const pathInfo = computeLinePath(mark)
      if (pathInfo) {
        boundsFromPath(bounds, pathInfo.path)
        boundStroke(bounds, items[0] ?? {}, true)
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
      for (const it of items) boundLeaf(bounds, it)
      return bounds
  }
}

/** Bound one leaf item (or nested group/mark item) into `bounds`. */
export function boundLeaf(bounds: Bounds, it: SceneItem): Bounds {
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
    return boundTypedMark(bounds, it as unknown as SceneGroup)
  }
  return bounds.union(boundIsolated(it))
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
  const meta = (axis as Record<string, unknown>).axis as { orient: string; range: number; baseline?: number } | undefined
  const orient = meta?.orient ?? 'left'
  const range = meta?.range ?? 0
  // The axis line's perpendicular position: for top/bottom axes it sits at the
  // content edge (content top/bottom), not the spine's along-axis extent
  // (`range`). They diverge when autosize fit makes width != height.
  const baseline = meta?.baseline ?? (orient === 'left' || orient === 'right' ? 0 : range)
  const tickLabelBounds = new Bounds()
  for (const it of axis.items ?? []) {
    const leaf = it as SceneItem
    if ((leaf as Record<string, unknown>)._domain) continue
    const bb = new Bounds()
    // Axis labels render via renderLeaf, which emits the item `y` as the glyph
    // baseline with no offset, so the guide builders bake vega's baseline
    // shift into `y`. boundLeaf only undoes that bake for middle-baseline
    // leaves (left/right axes); bottom/top-axis labels (fontSize 10, baseline
    // top/bottom) need the same unbake or their extent lands off. Vega boxes
    // text around the *item* position, so subtract the baked baseline offset.
    const fsLeaf = (leaf.fontSize as number | undefined) ?? 11
    const leafBaseline = leaf.baseline as string | undefined
    if (
      leaf.text != null &&
      (leaf as SceneGroup).marktype === undefined &&
      (fsLeaf === 10 || fsLeaf === 11) &&
      (leafBaseline === 'top' || leafBaseline === 'bottom')
    ) {
      const savedY = leaf.y
      ;(leaf as Record<string, unknown>).y = (leaf.y ?? 0) - baselineOffset(leaf)
      boundText(bb, leaf)
      ;(leaf as Record<string, unknown>).y = savedY
    } else {
      boundLeaf(bb, leaf)
    }
    bb.translate(-0.5, -0.5)
    b.union(bb)
    tickLabelBounds.union(bb)
  }
  // spine rect per orient; s = tick/label extent beyond the axis line
  let s: number
  if (orient === 'left') {
    s = tickLabelBounds.empty() ? 0 : -Math.min(0, tickLabelBounds.x1)
    b.add(-s, 0).add(0, range)
  } else if (orient === 'right') {
    s = tickLabelBounds.empty() ? 0 : Math.max(range, tickLabelBounds.x2) - range
    b.add(range, 0).add(range + s, range)
  } else if (orient === 'top') {
    s = tickLabelBounds.empty() ? 0 : -Math.min(0, tickLabelBounds.y1)
    b.add(0, -s).add(range, baseline)
  } else {
    s = tickLabelBounds.empty() ? 0 : Math.max(baseline, tickLabelBounds.y2) - baseline
    b.add(0, baseline).add(range, baseline + s)
  }
  return b
}

/** Bound a single leaf item into an isolated Bounds (vega's per-item bounds). */
function boundIsolated(it: SceneItem): Bounds {
  const bounds = new Bounds()
  if (it.path != null) {
    // path/symbol/arc/geoshape items: trace the emitted path, then
    // boundStroke, then translate by item x/y (markItemPath bound).
    // Miter expansion applies only to mark items; our baked group-background
    // paths (stroke without an explicit strokeWidth) expand non-miter, like
    // vega's group stroke bound.
    boundsFromPath(bounds, it.path)
    boundStroke(bounds, it, it.strokeWidth != null)
    return bounds.translate(it.x || 0, it.y || 0)
  }
  if (it.text != null && (it as SceneGroup).marktype === undefined) {
    // Bare text leaves render via renderLeaf, which emits the item y as the
    // glyph baseline with no baseline offset; our guide builders bake vega's
    // baseline offset into the leaf y. Vega boxes text around the *item*
    // position, so undo the baked offset (guide-label fontSize 10) and box
    // with vega's formula.
    const fsLeaf = (it.fontSize as number | undefined)
    let yItem = it.y ?? 0
    let fsEff = fsLeaf ?? 11
    if (fsLeaf == null && it.baseline === 'middle') {
      // guide-label leaves render at the glyph baseline (renderLeaf applies no
      // offset; the builder baked vega's middle offset into y) — undo it
      yItem = (it.y ?? 0) - Math.round(0.30 * 10)
      fsEff = 10
    }
    const savedY = it.y
    const savedFs = it.fontSize
    ;(it as Record<string, unknown>).y = yItem
    ;(it as Record<string, unknown>).fontSize = fsEff
    const out = boundText(bounds, it)
    ;(it as Record<string, unknown>).y = savedY
    ;(it as Record<string, unknown>).fontSize = savedFs
    return out
  }
  if (it.text != null) {
    return boundText(bounds, it)
  }
  if (it.shape != null && it.radius != null) {
    // circle symbol: full circle bounds
    const r = it.radius
    const x = it.x || 0
    const y = it.y || 0
    bounds.add(x - r, y - r)
    bounds.add(x + r, y + r)
    return boundStroke(bounds, it, true)
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
  if (it.x != null || it.y != null) {
    // point symbol without an explicit shape/radius: default circle, size 30
    // (our symbol renderer defaults `size ?? 30`)
    const r = Math.sqrt(((it.size as number) ?? 30)) / 2
    const x = it.x ?? 0
    const y = it.y ?? 0
    bounds.add(x - r, y - r)
    bounds.add(x + r, y + r)
    return boundStroke(bounds, it, true)
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
