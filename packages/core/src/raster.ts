/**
 * A software 2D context that records only coverage: what a canvas would hold in its alpha channel after the same drawing
 * commands. vega-label draws the marks a label must avoid into an offscreen canvas and reads back which pixels have any
 * alpha at all; this is that canvas, in typed arrays, with no DOM and no native module, so the layout is the same in a
 * browser, in Node and in a worker. It implements the `CanvasLike` surface the scene's canvas renderer draws through
 * (`canvas.ts`), so the marks are drawn by the code that draws them on screen.
 *
 * Whether a pixel has any alpha depends on the last fraction of a percent of coverage, so the rasterizer follows the one a
 * browser canvas uses (Skia's software scan converter with analytic anti-aliasing) rather than computing exact areas:
 *
 * - Curves are cut at their vertical extrema and stepped into 2^shift lines, `shift` from the curve's distance from its chord
 *   in 26.6 fixed point (SkEdge: `diff_to_shift`, `cubic_delta_from_line`); an arc is a run of conics of at most a quarter
 *   turn (SkConic::BuildUnitArc) that become quads at a 0.25px tolerance (computeQuadPOW2), so a small circle is four quads
 *   cut into four lines each, which is not a circle.
 * - The vertices of every line are snapped in y to a quarter of a pixel (SkAnalyticEdge `SnapY`) and rounded in x to 1/256;
 *   the coverage of a pixel is then the area of the polygon in it, 8 bits of it, and the colour's alpha scales that
 *   (`SkAlphaMul(alpha, coverage + 1)`) before it is blended source-over.
 *
 * Strokes are outlined (segments, joins, caps, dashes) from flattened curves and scan converted by the same path. Text is a box
 * (see `fillText`). Clipping, blend modes, gradients and patterns are not modelled: a gradient paints opaque.
 */
import { color as parseColor } from './color.js'
import type { CanvasLike, GradientLike } from './canvas.js'

type Pt = [number, number]

/** A drawing command after the transform (device space). */
type Op =
  | { k: 'L'; x: number; y: number }
  | { k: 'Q'; cx: number; cy: number; x: number; y: number }
  | { k: 'C'; c1x: number; c1y: number; c2x: number; c2y: number; x: number; y: number }

interface Sub {
  start: Pt
  ops: Op[]
  closed: boolean
}

interface State {
  m: [number, number, number, number, number, number]
  fillStyle: unknown
  strokeStyle: unknown
  globalAlpha: number
  lineWidth: number
  lineCap: string
  lineJoin: string
  miterLimit: number
  lineDash: number[]
  lineDashOffset: number
  font: string
  textAlign: string
  textBaseline: string
}

const TOL = 0.05 // flattening tolerance of the stroker's curves, in pixels
const SUBY = 32 // sub-scanlines per pixel row of the coverage integral
const QUARTER = SUBY / 4 // ... of which this many make a quarter of a pixel row, the unit the analytic coverage is made in
const PER_SUB = 64 / QUARTER // coverage a covered pixel gets from one sub-scanline, a quarter row being 64

/** The alpha (0..1) of a paint: a colour string carries its own; a gradient or pattern paints opaque; an unparsable one is opaque black. */
function paintAlpha(style: unknown): number {
  if (typeof style !== 'string') return 1
  const c = parseColor(style)
  if (c === null) return 1
  const o = (c as { opacity: number }).opacity
  return Number.isFinite(o) ? o : 1
}

export class AlphaCanvas implements CanvasLike {
  readonly width: number
  readonly height: number
  /** The alpha channel, 0..255 per pixel, row-major. */
  readonly alpha: Uint8Array

  fillStyle: unknown = '#000000'
  strokeStyle: unknown = '#000000'
  globalAlpha = 1
  lineWidth = 1
  lineCap = 'butt'
  lineJoin = 'miter'
  miterLimit = 10
  lineDashOffset = 0
  imageSmoothingEnabled = true
  globalCompositeOperation = 'source-over'
  font = '10px sans-serif'
  textAlign = 'start'
  textBaseline = 'alphabetic'

  private m: State['m'] = [1, 0, 0, 1, 0, 0]
  private dash: number[] = []
  private stack: State[] = []
  private subs: Sub[] = []
  private cur: Sub | null = null
  private row: Float32Array
  private sum: Int32Array

  constructor(width: number, height: number) {
    this.width = Math.max(0, Math.floor(width))
    this.height = Math.max(0, Math.floor(height))
    this.alpha = new Uint8Array(this.width * this.height)
    this.row = new Float32Array(this.width + 1)
    this.sum = new Int32Array(this.width + 1)
  }

  // --- state ---------------------------------------------------------------

  save(): void {
    this.stack.push({
      m: [...this.m], fillStyle: this.fillStyle, strokeStyle: this.strokeStyle, globalAlpha: this.globalAlpha, lineWidth: this.lineWidth,
      lineCap: this.lineCap, lineJoin: this.lineJoin, miterLimit: this.miterLimit, lineDash: this.dash, lineDashOffset: this.lineDashOffset,
      font: this.font, textAlign: this.textAlign, textBaseline: this.textBaseline,
    })
  }

  restore(): void {
    const s = this.stack.pop()
    if (s === undefined) return
    this.m = s.m
    this.fillStyle = s.fillStyle
    this.strokeStyle = s.strokeStyle
    this.globalAlpha = s.globalAlpha
    this.lineWidth = s.lineWidth
    this.lineCap = s.lineCap
    this.lineJoin = s.lineJoin
    this.miterLimit = s.miterLimit
    this.dash = s.lineDash
    this.lineDashOffset = s.lineDashOffset
    this.font = s.font
    this.textAlign = s.textAlign
    this.textBaseline = s.textBaseline
  }

  translate(x: number, y: number): void {
    const m = this.m
    m[4] += m[0] * x + m[2] * y
    m[5] += m[1] * x + m[3] * y
  }

  scale(x: number, y: number): void {
    const m = this.m
    m[0] *= x; m[1] *= x; m[2] *= y; m[3] *= y
  }

  rotate(angle: number): void {
    const m = this.m
    const c = Math.cos(angle)
    const s = Math.sin(angle)
    const a = m[0], b = m[1], cc = m[2], d = m[3]
    m[0] = a * c + cc * s
    m[1] = b * c + d * s
    m[2] = -a * s + cc * c
    m[3] = -b * s + d * c
  }

  setLineDash(dashes: number[]): void {
    const d = dashes.map(Number)
    this.dash = d.every((v) => Number.isFinite(v) && v >= 0) ? (d.length % 2 ? [...d, ...d] : d) : []
  }

  clip(): void { /* the marks vega-label draws are not clipped */ }

  createLinearGradient(): GradientLike { return { addColorStop() {} } }
  createRadialGradient(): GradientLike { return { addColorStop() {} } }
  createPattern(): unknown { return {} }

  // --- path ----------------------------------------------------------------

  private pt(x: number, y: number): Pt {
    const m = this.m
    return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
  }

  beginPath(): void {
    this.subs = []
    this.cur = null
  }

  moveTo(x: number, y: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return
    this.cur = { start: this.pt(x, y), ops: [], closed: false }
    this.subs.push(this.cur)
  }

  lineTo(x: number, y: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return
    if (this.cur === null) { this.moveTo(x, y); return }
    const [dx, dy] = this.pt(x, y)
    this.cur.ops.push({ k: 'L', x: dx, y: dy })
  }

  closePath(): void {
    const c = this.cur
    if (c === null) return
    c.closed = true
    // the next segment starts a new subpath where this one began
    this.cur = { start: c.start, ops: [], closed: false }
    this.subs.push(this.cur)
  }

  rect(x: number, y: number, w: number, h: number): void {
    this.moveTo(x, y)
    this.lineTo(x + w, y)
    this.lineTo(x + w, y + h)
    this.lineTo(x, y + h)
    this.closePath()
  }

  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void {
    if (![cx, cy, x, y].every(Number.isFinite)) return
    if (this.cur === null) this.moveTo(cx, cy)
    const [c1x, c1y] = this.pt(cx, cy)
    const [dx, dy] = this.pt(x, y)
    this.cur!.ops.push({ k: 'Q', cx: c1x, cy: c1y, x: dx, y: dy })
  }

  bezierCurveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): void {
    if (![c1x, c1y, c2x, c2y, x, y].every(Number.isFinite)) return
    if (this.cur === null) this.moveTo(c1x, c1y)
    const [a, b] = this.pt(c1x, c1y)
    const [c, d] = this.pt(c2x, c2y)
    const [dx, dy] = this.pt(x, y)
    this.cur!.ops.push({ k: 'C', c1x: a, c1y: b, c2x: c, c2y: d, x: dx, y: dy })
  }

  /** Skia's `arcTo(oval, start, sweep)`: conics of at most a quarter turn from the start, each made into quads. */
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number, counterclockwise = false): void {
    if (![x, y, radius, startAngle, endAngle].every(Number.isFinite) || radius < 0) return
    const TAU = Math.PI * 2
    let sweep = endAngle - startAngle
    if (!counterclockwise) {
      if (sweep >= TAU) sweep = TAU
      else if (sweep < 0) sweep = ((sweep % TAU) + TAU) % TAU
    } else if (sweep <= -TAU) sweep = -TAU
    else if (sweep > 0) sweep = -((((-sweep) % TAU) + TAU) % TAU)
    const full = Math.abs(sweep) >= TAU
    const sx = x + radius * Math.cos(startAngle)
    const sy = y + radius * Math.sin(startAngle)
    if (this.cur === null) this.moveTo(sx, sy)
    else this.lineTo(sx, sy)
    if (radius === 0 || sweep === 0) return
    // the unit arc, in the frame where the start is (1, 0)
    const ux = Math.cos(startAngle)
    const uy = Math.sin(startAngle)
    const stop: Pt = full ? [ux, uy] : [Math.cos(startAngle + sweep), Math.sin(startAngle + sweep)]
    const conics = unitArc([ux, uy], stop, sweep >= 0 ? 1 : -1, full)
    const cur = this.cur!
    const m = this.m
    const tol = 0.25 / Math.max(1e-6, radius * Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])))
    for (const c of conics) {
      for (const q of conicToQuads(c, tol)) {
        const [c1x, c1y] = this.pt(x + radius * q[0], y + radius * q[1])
        const [ex, ey] = this.pt(x + radius * q[2], y + radius * q[3])
        cur.ops.push({ k: 'Q', cx: c1x, cy: c1y, x: ex, y: ey })
      }
    }
  }

  // --- painting ------------------------------------------------------------

  fill(rule: 'nonzero' | 'evenodd' = 'nonzero'): void {
    const a = paintAlpha(this.fillStyle) * this.globalAlpha
    if (!(a > 0)) return
    const edges: Edge[] = []
    for (const s of this.subs) if (s.ops.length) skiaEdges(s, edges)
    this.scan(edges, rule, a)
  }

  fillRect(x: number, y: number, w: number, h: number): void {
    const a = paintAlpha(this.fillStyle) * this.globalAlpha
    if (!(a > 0)) return
    this.scan(polygonEdges([[this.pt(x, y), this.pt(x + w, y), this.pt(x + w, y + h), this.pt(x, y + h)]]), 'nonzero', a)
  }

  stroke(): void {
    const a = paintAlpha(this.strokeStyle) * this.globalAlpha
    if (!(a > 0) || !(this.lineWidth > 0)) return
    const m = this.m
    const scale = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]))
    if (!(scale > 0)) return
    const half = (this.lineWidth * scale) / 2
    const polys: Pt[][] = []
    for (const s of this.subs) {
      const pts = flatten(s)
      if (pts.length < 2 && !s.closed) continue // (a lone moveTo draws nothing)
      const piece: Piece = { pts, closed: s.closed }
      const pieces = this.dash.length && this.dash.some((d) => d > 0) ? dashed(piece, this.dash.map((d) => d * scale), this.lineDashOffset * scale) : [piece]
      for (const p of pieces) outline(p, half, this.lineCap, this.lineJoin, this.miterLimit, polys)
    }
    this.scan(polygonEdges(polys), 'nonzero', a)
  }

  /** Text is a box from its advance width and font size (glyph coverage is not modelled); `fillText` and `strokeText` draw it. */
  fillText(text: string, x: number, y: number): void { this.textBox(text, x, y, paintAlpha(this.fillStyle)) }
  strokeText(text: string, x: number, y: number): void { this.textBox(text, x, y, paintAlpha(this.strokeStyle)) }

  private textBox(text: string, x: number, y: number, colorAlpha: number): void {
    const a = colorAlpha * this.globalAlpha
    if (!(a > 0) || !text) return
    const size = Number(/(\d+(?:\.\d+)?)px/.exec(this.font)?.[1] ?? 10)
    const w = Math.floor(0.8 * text.length * size)
    const left = this.textAlign === 'center' ? x - w / 2 : this.textAlign === 'right' || this.textAlign === 'end' ? x - w : x
    const bottom = this.textBaseline === 'top' ? y + size : this.textBaseline === 'middle' ? y + size / 2 : y
    this.scan(polygonEdges([[this.pt(left, bottom - size), this.pt(left + w, bottom - size), this.pt(left + w, bottom), this.pt(left, bottom)]]), 'nonzero', a)
  }

  drawImage(_image: unknown, dx: number, dy: number, dw?: number, dh?: number): void {
    if (dw === undefined || dh === undefined) return
    const a = this.globalAlpha
    if (!(a > 0)) return
    this.scan(polygonEdges([[this.pt(dx, dy), this.pt(dx + dw, dy), this.pt(dx + dw, dy + dh), this.pt(dx, dy + dh)]]), 'nonzero', a)
  }

  // --- scan conversion (SkScan_AAAPath: analytic coverage) -----------------------

  private scan(edges: Edge[], rule: 'nonzero' | 'evenodd', paint: number): void {
    const w = this.width
    const h = this.height
    if (!edges.length || !w || !h) return
    const paintA8 = Math.min(255, Math.max(0, Math.round(paint * 255)))
    if (paintA8 === 0) return
    let minY = Infinity
    let maxY = -Infinity
    for (const e of edges) {
      if (e.y0 < minY) minY = e.y0
      if (e.y1 > maxY) maxY = e.y1
    }
    edges.sort((e, f) => e.y0 - f.y0)
    const rowStart = Math.max(0, Math.floor(minY))
    const rowEnd = Math.min(h - 1, Math.ceil(maxY) - 1)
    const cov = this.row
    const sum = this.sum
    let next = 0
    let active: Edge[] = []
    const xs: Array<{ x: number; w: number }> = []
    for (let row = rowStart; row <= rowEnd; row++) {
      let lo = w
      let hi = -1
      for (let k = 0; k < SUBY; k++) {
        const y = row + (k + 0.5) / SUBY
        while (next < edges.length && edges[next]!.y0 <= y) active.push(edges[next++]!)
        if (active.length) {
          let kept = 0
          xs.length = 0
          for (let i = 0; i < active.length; i++) {
            const e = active[i]!
            if (e.y1 <= y) continue
            active[kept++] = e
            xs.push({ x: e.x0 + (y - e.y0) * e.slope, w: e.dir })
          }
          active.length = kept
          if (xs.length >= 2) {
            xs.sort((p, q) => p.x - q.x)
            let wind = 0
            for (let i = 0; i < xs.length - 1; i++) {
              wind = rule === 'evenodd' ? wind ^ 1 : wind + xs[i]!.w
              if (wind === 0) continue
              const xa = Math.max(0, xs[i]!.x)
              const xb = Math.min(w, xs[i + 1]!.x)
              if (!(xb > xa)) continue
              const ia = Math.floor(xa)
              const ib = Math.min(w - 1, Math.floor(xb))
              if (ia < lo) lo = ia
              if (ib > hi) hi = ib
              if (ia === ib) cov[ia] = cov[ia]! + (xb - xa) * PER_SUB
              else {
                cov[ia] = cov[ia]! + (ia + 1 - xa) * PER_SUB
                for (let px = ia + 1; px < ib; px++) cov[px] = cov[px]! + PER_SUB
                if (xb > ib) cov[ib] = cov[ib]! + (xb - ib) * PER_SUB
              }
            }
          }
        }
        // the end of a quarter of the row: analytic coverage is made a quarter row at a time and each is cut to whole 1/256ths
        if ((k + 1) % QUARTER === 0) {
          for (let px = lo; px <= hi; px++) {
            const c = cov[px]!
            if (c === 0) continue
            cov[px] = 0
            sum[px] = sum[px]! + Math.floor(c)
          }
        }
      }
      const base = row * w
      for (let px = lo; px <= hi; px++) {
        const aa = Math.min(255, sum[px]!)
        sum[px] = 0
        if (aa === 0) continue
        const srcA = (paintA8 * (aa + 1)) >> 8
        if (srcA === 0) continue
        const dst = this.alpha[base + px]!
        this.alpha[base + px] = srcA + ((dst * (256 - srcA)) >> 8)
      }
    }
  }
}

const catchOverflow = (a: number): number => a - (a >> 8)

// --- edges (SkEdge, SkAnalyticEdge) -----------------------------------------------

/** A line edge: y0 < y1 (snapped to a quarter pixel), x at y0, dx/dy, and the winding direction. */
interface Edge { y0: number; y1: number; x0: number; slope: number; dir: number }

/** SkAnalyticEdge::SnapY: a quarter pixel. */
const snapY = (y: number): number => Math.floor(y * 4 + 0.5) / 4
/** x as the analytic edge holds it: 1/256 of a pixel. */
const roundX = (x: number): number => Math.round(x * 256) / 256

const toFDot6 = (v: number): number => Math.round(v * 256)

/** SkAnalyticEdge::setLine: a line from (x0, y0) to (x1, y1) in pixels, or null when it is flat after snapping. */
function lineEdge(px0: number, py0: number, px1: number, py1: number): Edge | null {
  let x0 = roundX(px0), y0 = snapY(py0), x1 = roundX(px1), y1 = snapY(py1)
  let dir = 1
  if (y0 > y1) { [x0, x1] = [x1, x0]; [y0, y1] = [y1, y0]; dir = -1 }
  if (y0 === y1) return null
  return { y0, y1, x0, slope: (x1 - x0) / (y1 - y0), dir }
}

/** A line whose y's are already where the analytic edge keeps them (a piece of a curve, see `quadLines`). */
function rawEdge(x0: number, y0: number, x1: number, y1: number): Edge | null {
  let dir = 1
  x0 = roundX(x0); x1 = roundX(x1)
  if (y0 > y1) { [x0, x1] = [x1, x0]; [y0, y1] = [y1, y0]; dir = -1 }
  if (y0 === y1) return null
  return { y0, y1, x0, slope: (x1 - x0) / (y1 - y0), dir }
}

function polygonEdges(polys: Pt[][]): Edge[] {
  const out: Edge[] = []
  for (const p of polys) {
    for (let i = 0; i < p.length; i++) {
      const [ax, ay] = p[i]!
      const [bx, by] = p[(i + 1) % p.length]!
      if (!Number.isFinite(ax + ay + bx + by)) continue
      const e = lineEdge(ax, ay, bx, by)
      if (e !== null) out.push(e)
    }
  }
  return out
}

const cheapDistance = (dx: number, dy: number): number => {
  dx = Math.abs(dx); dy = Math.abs(dy)
  return dx > dy ? dx + (dy >> 1) : dy + (dx >> 1)
}

/** SkEdge.cpp `diff_to_shift`. */
function diffToShift(dx: number, dy: number): number {
  let dist = cheapDistance(dx, dy)
  dist = (dist + (1 << 4)) >> (3 + 2) // 2: the anti-aliasing shift (4x)
  return (32 - Math.clz32(dist)) >> 1
}

const MAX_COEFF_SHIFT = 6

/** The lines of a subpath the way Skia's edge builder makes them (closed implicitly). */
function skiaEdges(s: Sub, out: Edge[]): void {
  let [px, py] = s.start
  const add: AddLine = (x0, y0, x1, y1, raw) => {
    const e = raw ? rawEdge(x0, y0, x1, y1) : lineEdge(x0, y0, x1, y1)
    if (e !== null) out.push(e)
  }
  for (const o of s.ops) {
    if (o.k === 'L') add(px, py, o.x, o.y, false)
    else if (o.k === 'Q') for (const q of chopQuadAtY([px, py], [o.cx, o.cy], [o.x, o.y])) quadLines(q, add)
    else for (const c of chopCubicAtY([px, py], [o.c1x, o.c1y], [o.c2x, o.c2y], [o.x, o.y])) cubicLines(c, add)
    px = o.x
    py = o.y
  }
  add(px, py, s.start[0], s.start[1], false)
}

/** `raw`: the y's are final (the first and last of a curve are snapped, the ones between ride on the first). */
type AddLine = (x0: number, y0: number, x1: number, y1: number, raw: boolean) => void

function quadLines(q: [Pt, Pt, Pt], add: AddLine): void {
  const [p0, p1, p2] = q
  const y0 = toFDot6(p0[1]), y2 = toFDot6(p2[1])
  if (((y0 + 32) >> 6) === ((y2 + 32) >> 6)) { add(p0[0], p0[1], p2[0], p2[1], false); return }
  const x0 = toFDot6(p0[0]), x1 = toFDot6(p1[0]), x2 = toFDot6(p2[0]), y1 = toFDot6(p1[1])
  const dx = ((x1 << 1) - x0 - x2) >> 2
  const dy = ((y1 << 1) - y0 - y2) >> 2
  let shift = diffToShift(dx, dy)
  if (shift === 0) shift = 1
  else if (shift > MAX_COEFF_SHIFT) shift = MAX_COEFF_SHIFT
  const n = 1 << shift
  // SkAnalyticQuadraticEdge: only the first and the last y are snapped; the points between keep their distance from the first
  const sy0 = snapY(p0[1])
  let [ax, ay] = [p0[0], sy0]
  for (let i = 1; i <= n; i++) {
    const t = i / n
    const u = 1 - t
    const bx = i === n ? p2[0] : u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0]
    const by = i === n ? snapY(p2[1]) : sy0 + (u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1] - p0[1])
    add(ax, ay, bx, by, true)
    ax = bx
    ay = by
  }
}

const cubicDeltaFromLine = (a: number, b: number, c: number, d: number): number => {
  // cheap calc of distance from center of p0-p2 to the center of the curve
  const oneThird = ((a * 8 - b * 15 + 6 * c + d) * 19) >> 9
  const twoThird = ((a + 6 * b - c * 15 + d * 8) * 19) >> 9
  return Math.max(Math.abs(oneThird), Math.abs(twoThird))
}

function cubicLines(c: [Pt, Pt, Pt, Pt], add: AddLine): void {
  const [p0, p1, p2, p3] = c
  const y0 = toFDot6(p0[1]), y3 = toFDot6(p3[1])
  if (((y0 + 32) >> 6) === ((y3 + 32) >> 6)) { add(p0[0], p0[1], p3[0], p3[1], false); return }
  const dx = cubicDeltaFromLine(toFDot6(p0[0]), toFDot6(p1[0]), toFDot6(p2[0]), toFDot6(p3[0]))
  const dy = cubicDeltaFromLine(y0, toFDot6(p1[1]), toFDot6(p2[1]), y3)
  let shift = diffToShift(dx, dy) + 1
  if (shift > MAX_COEFF_SHIFT) shift = MAX_COEFF_SHIFT
  const n = 1 << shift
  const sy0 = snapY(p0[1])
  let [ax, ay] = [p0[0], sy0]
  for (let i = 1; i <= n; i++) {
    const t = i / n
    const u = 1 - t
    const a = u * u * u
    const b = 3 * u * u * t
    const cc = 3 * u * t * t
    const d = t * t * t
    const bx = i === n ? p3[0] : a * p0[0] + b * p1[0] + cc * p2[0] + d * p3[0]
    const by = i === n ? snapY(p3[1]) : sy0 + (a * p0[1] + b * p1[1] + cc * p2[1] + d * p3[1] - p0[1])
    add(ax, ay, bx, by, true)
    ax = bx
    ay = by
  }
}

/** SkChopQuadAtYExtrema: monotonic pieces. */
function chopQuadAtY(p0: Pt, p1: Pt, p2: Pt): Array<[Pt, Pt, Pt]> {
  const a = p0[1] - p1[1]
  const b = p1[1] - p2[1]
  if (a * b < 0) {
    const d = p0[1] - 2 * p1[1] + p2[1]
    const t = a / d
    if (t > 0 && t < 1) {
      const m = (p: Pt, q: Pt): Pt => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]
      const ab = m(p0, p1)
      const bc = m(p1, p2)
      const abc = m(ab, bc)
      return [[p0, ab, abc], [abc, bc, p2]]
    }
  }
  return [[p0, p1, p2]]
}

/** SkChopCubicAtYExtrema: monotonic pieces. */
function chopCubicAtY(p0: Pt, p1: Pt, p2: Pt, p3: Pt): Array<[Pt, Pt, Pt, Pt]> {
  // roots of the derivative of y: A t^2 + B t + C
  const A = p3[1] - p0[1] + 3 * (p1[1] - p2[1])
  const B = 2 * (p0[1] - p1[1] - p1[1] + p2[1])
  const C = p1[1] - p0[1]
  const ts: number[] = []
  if (Math.abs(A) < 1e-12) {
    if (Math.abs(B) > 1e-12) ts.push(-C / B)
  } else {
    const disc = B * B - 4 * A * C
    if (disc >= 0) {
      const sq = Math.sqrt(disc)
      ts.push((-B - sq) / (2 * A), (-B + sq) / (2 * A))
    }
  }
  const cuts = ts.filter((t) => t > 0 && t < 1).sort((u, v) => u - v)
  if (!cuts.length) return [[p0, p1, p2, p3]]
  const out: Array<[Pt, Pt, Pt, Pt]> = []
  let cur: [Pt, Pt, Pt, Pt] = [p0, p1, p2, p3]
  let consumed = 0
  for (const t0 of cuts) {
    const t = (t0 - consumed) / (1 - consumed)
    const lerp = (p: Pt, q: Pt): Pt => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]
    const ab = lerp(cur[0], cur[1])
    const bc = lerp(cur[1], cur[2])
    const cd = lerp(cur[2], cur[3])
    const abc = lerp(ab, bc)
    const bcd = lerp(bc, cd)
    const m = lerp(abc, bcd)
    out.push([cur[0], ab, abc, m])
    cur = [m, bcd, cd, cur[3]]
    consumed = t0
  }
  out.push(cur)
  return out
}

// --- conics (SkConic) -------------------------------------------------------

interface Conic { p0: Pt; p1: Pt; p2: Pt; w: number }

/** SkConic::BuildUnitArc: conics (weight sqrt(2)/2 for a quarter turn) from `uStart` towards `uStop` in a direction, on the unit circle. */
function unitArc(uStart: Pt, uStop: Pt, dir: 1 | -1, full: boolean): Conic[] {
  // rotate so that uStart is (1, 0)
  let x = uStart[0] * uStop[0] + uStart[1] * uStop[1]
  let y = uStart[0] * uStop[1] - uStart[1] * uStop[0]
  if (!full && Math.abs(y) <= 1.0 / 4096 && x > 0 && ((y >= 0 && dir === 1) || (y <= 0 && dir === -1))) return []
  if (dir === -1) y = -y
  let quadrant = 0
  if (full) { quadrant = 4; x = 1; y = 0 } else if (y === 0) quadrant = 2
  else if (x === 0) quadrant = y > 0 ? 1 : 3
  else {
    if (y < 0) quadrant += 2
    if ((x < 0) !== (y < 0)) quadrant += 1
  }
  const q: Pt[] = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]]
  const conics: Conic[] = []
  const R = Math.SQRT1_2
  for (let i = 0; i < quadrant; i++) conics.push({ p0: q[i * 2]!, p1: q[i * 2 + 1]!, p2: q[(i * 2 + 2) % 8]!, w: R })
  if (!full) {
    const lastQ = q[quadrant * 2]!
    const dot = lastQ[0] * x + lastQ[1] * y
    if (dot < 1) {
      let ox = lastQ[0] + x
      let oy = lastQ[1] + y
      const cosHalf = Math.sqrt((1 + dot) / 2)
      const len = Math.hypot(ox, oy)
      ox = ox / len / cosHalf
      oy = oy / len / cosHalf
      if (Math.abs(lastQ[0] - ox) > 1.0 / 4096 || Math.abs(lastQ[1] - oy) > 1.0 / 4096) conics.push({ p0: lastQ, p1: [ox, oy], p2: [x, y], w: cosHalf })
    }
  }
  // rotate by the start vector, mirror for a counter-clockwise arc
  const [c, s] = uStart
  const map = (p: Pt): Pt => {
    const py = dir === -1 ? -p[1] : p[1]
    return [c * p[0] - s * py, s * p[0] + c * py]
  }
  return conics.map((k) => ({ p0: map(k.p0), p1: map(k.p1), p2: map(k.p2), w: k.w }))
}

/** SkConic::computeQuadPOW2 and chopIntoQuadsPOW2: the quads (control, end) a conic becomes at a tolerance. */
function conicToQuads(c: Conic, tol: number): Array<[number, number, number, number]> {
  const a = c.w - 1
  const k = a / (4 * (2 + a))
  const ex = k * (c.p0[0] - 2 * c.p1[0] + c.p2[0])
  const ey = k * (c.p0[1] - 2 * c.p1[1] + c.p2[1])
  let error = Math.sqrt(ex * ex + ey * ey)
  let pow2 = 0
  for (; pow2 < 5; ++pow2) {
    if (error <= tol) break
    error *= 0.25
  }
  const out: Array<[number, number, number, number]> = []
  const rec = (k2: Conic, level: number): void => {
    if (level === 0) { out.push([k2.p1[0], k2.p1[1], k2.p2[0], k2.p2[1]]); return }
    const scale = 1 / (1 + k2.w)
    const newW = Math.sqrt(0.5 + k2.w * 0.5)
    const wp1: Pt = [k2.w * k2.p1[0], k2.w * k2.p1[1]]
    const m: Pt = [((k2.p0[0] + 2 * wp1[0] + k2.p2[0]) * scale) / 2, ((k2.p0[1] + 2 * wp1[1] + k2.p2[1]) * scale) / 2]
    rec({ p0: k2.p0, p1: [(k2.p0[0] + wp1[0]) * scale, (k2.p0[1] + wp1[1]) * scale], p2: m, w: newW }, level - 1)
    rec({ p0: m, p1: [(wp1[0] + k2.p2[0]) * scale, (wp1[1] + k2.p2[1]) * scale], p2: k2.p2, w: newW }, level - 1)
  }
  rec(c, pow2)
  return out
}

// --- the stroker's view of a path: curves flattened finely ---------------------

function flatten(s: Sub): Pt[] {
  const pts: Pt[] = [s.start]
  let [px, py] = s.start
  for (const o of s.ops) {
    if (o.k === 'L') pts.push([o.x, o.y])
    else if (o.k === 'Q') {
      const n = curveSteps(Math.hypot(o.cx - px, o.cy - py) + Math.hypot(o.x - o.cx, o.y - o.cy))
      for (let i = 1; i <= n; i++) {
        const t = i / n
        const u = 1 - t
        pts.push([u * u * px + 2 * u * t * o.cx + t * t * o.x, u * u * py + 2 * u * t * o.cy + t * t * o.y])
      }
    } else {
      const n = curveSteps(Math.hypot(o.c1x - px, o.c1y - py) + Math.hypot(o.c2x - o.c1x, o.c2y - o.c1y) + Math.hypot(o.x - o.c2x, o.y - o.c2y))
      for (let i = 1; i <= n; i++) {
        const t = i / n
        const u = 1 - t
        const a = u * u * u
        const b = 3 * u * u * t
        const c = 3 * u * t * t
        const d = t * t * t
        pts.push([a * px + b * o.c1x + c * o.c2x + d * o.x, a * py + b * o.c1y + c * o.c2y + d * o.y])
      }
    }
    px = o.x
    py = o.y
  }
  return pts
}

function curveSteps(length: number): number {
  return Math.max(2, Math.min(64, Math.ceil(Math.sqrt(length / TOL) / 2)))
}

interface Piece {
  pts: Pt[]
  closed: boolean
}

/** Cut a polyline into dashes (device units). */
function dashed(s: Piece, pattern: number[], offset: number): Piece[] {
  const out: Piece[] = []
  const total = pattern.reduce((p, q) => p + q, 0)
  if (!(total > 0)) return [s]
  const pts = s.closed && s.pts.length > 1 ? [...s.pts, s.pts[0]!] : s.pts
  let idx = 0
  let into = ((offset % total) + total) % total
  while (into >= pattern[idx]!) {
    into -= pattern[idx]!
    idx = (idx + 1) % pattern.length
  }
  let remaining = pattern[idx]! - into
  let on = idx % 2 === 0
  let cur: Pt[] = on ? [pts[0]!] : []
  for (let i = 1; i < pts.length; i++) {
    let [x0, y0] = pts[i - 1]!
    const [x1, y1] = pts[i]!
    let len = Math.hypot(x1 - x0, y1 - y0)
    if (len === 0) continue
    const ux = (x1 - x0) / len
    const uy = (y1 - y0) / len
    while (len > remaining) {
      x0 += ux * remaining
      y0 += uy * remaining
      len -= remaining
      if (on) { cur.push([x0, y0]); out.push({ pts: cur, closed: false }); cur = [] } else cur = [[x0, y0]]
      on = !on
      idx = (idx + 1) % pattern.length
      remaining = pattern[idx]!
    }
    remaining -= len
    if (on) cur.push([x1, y1])
  }
  if (on && cur.length > 1) out.push({ pts: cur, closed: false })
  return out
}

const orient = (poly: Pt[]): Pt[] => {
  let area = 0
  for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i]!
    const [bx, by] = poly[(i + 1) % poly.length]!
    area += ax * by - bx * ay
  }
  return area < 0 ? poly.reverse() : poly
}

function disk(cx: number, cy: number, r: number): Pt[] {
  const n = Math.max(8, Math.ceil(Math.PI / Math.acos(1 - Math.min(0.5, TOL / Math.max(r, TOL)))))
  const p: Pt[] = []
  for (let i = 0; i < n; i++) p.push([cx + r * Math.cos((i * 2 * Math.PI) / n), cy + r * Math.sin((i * 2 * Math.PI) / n)])
  return p
}

/** The polygons (all positively oriented, so the non-zero rule unions them) of a stroked polyline. */
function outline(s: Piece, half: number, cap: string, join: string, miterLimit: number, out: Pt[][]): void {
  // drop repeated points
  const pts: Pt[] = []
  for (const p of s.pts) {
    const q = pts[pts.length - 1]
    if (q === undefined || q[0] !== p[0] || q[1] !== p[1]) pts.push(p)
  }
  const closed = s.closed && pts.length > 2
  if (closed) {
    const a = pts[0]!
    const b = pts[pts.length - 1]!
    if (a[0] === b[0] && a[1] === b[1]) pts.pop()
  }
  if (pts.length === 1) {
    // a point: a round cap is a disk, a square cap a square, a butt cap nothing
    const [x, y] = pts[0]!
    if (cap === 'round') out.push(disk(x, y, half))
    else if (cap === 'square') out.push(orient([[x - half, y - half], [x + half, y - half], [x + half, y + half], [x - half, y + half]]))
    return
  }
  const n = pts.length
  const segs = closed ? n : n - 1
  const dirs: Pt[] = []
  for (let i = 0; i < segs; i++) {
    const [ax, ay] = pts[i]!
    const [bx, by] = pts[(i + 1) % n]!
    const len = Math.hypot(bx - ax, by - ay)
    dirs.push([(bx - ax) / len, (by - ay) / len])
  }
  for (let i = 0; i < segs; i++) {
    const [ax, ay] = pts[i]!
    const [bx, by] = pts[(i + 1) % n]!
    const [ux, uy] = dirs[i]!
    const nx = -uy * half
    const ny = ux * half
    let sx = ax
    let sy = ay
    let ex = bx
    let ey = by
    if (!closed && cap === 'square') {
      if (i === 0) { sx -= ux * half; sy -= uy * half }
      if (i === segs - 1) { ex += ux * half; ey += uy * half }
    }
    out.push(orient([[sx + nx, sy + ny], [ex + nx, ey + ny], [ex - nx, ey - ny], [sx - nx, sy - ny]]))
  }
  if (!closed && cap === 'round') {
    out.push(disk(pts[0]![0], pts[0]![1], half))
    out.push(disk(pts[n - 1]![0], pts[n - 1]![1], half))
  }
  const joins = closed ? n : n - 2
  for (let j = 0; j < joins; j++) {
    const vi = closed ? j : j + 1
    const [vx, vy] = pts[vi]!
    const d0 = dirs[closed ? (vi + segs - 1) % segs : vi - 1]!
    const d1 = dirs[closed ? vi % segs : vi]!
    const cross = d0[0] * d1[1] - d0[1] * d1[0]
    const dot = d0[0] * d1[0] + d0[1] * d1[1]
    if (Math.abs(cross) < 1e-12 && dot > 0) continue // straight on
    if (join === 'round') { out.push(disk(vx, vy, half)); continue }
    // the outer side of the turn: left of d0 when the path turns right (y down), and the reverse
    const sgn = cross > 0 ? -1 : 1
    const ax = vx + sgn * -d0[1] * half
    const ay = vy + sgn * d0[0] * half
    const bx = vx + sgn * -d1[1] * half
    const by = vy + sgn * d1[0] * half
    if (join === 'miter') {
      const cosHalf = Math.sqrt(Math.max(0, (1 + dot) / 2)) // cos(phi/2) of the turn phi: the miter is half / cos(phi/2) long
      if (cosHalf > 0 && 1 / cosHalf <= miterLimit) {
        const mx = ax + bx - 2 * vx
        const my = ay + by - 2 * vy
        const ml = Math.hypot(mx, my)
        if (ml > 0) {
          const k = half / cosHalf / ml
          out.push(orient([[vx, vy], [ax, ay], [vx + mx * k, vy + my * k], [bx, by]]))
          continue
        }
      }
    }
    out.push(orient([[vx, vy], [ax, ay], [bx, by]]))
  }
}
