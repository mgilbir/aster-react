/*
 * Derived in part from Skia (https://skia.org), BSD-3-Clause: the coverage rule of `AlphaCanvas.scan` (analytic anti-aliasing in
 * quarter-row steps, `SkAlphaMul(alpha, coverage + 1)`) and, in `raster-edges.ts`, the edge setup and curve subdivision of its
 * software scan converter. Skia is Copyright The Android Open Source Project and Google Inc.; its licence text is reproduced in
 * THIRD_PARTY_NOTICES.md.
 */
/**
 * A software 2D context that records only coverage: what a canvas would hold in its alpha channel after the same drawing
 * commands. vega-label draws the marks a label must avoid into an offscreen canvas and reads back which pixels have any
 * alpha at all; this is that canvas, in typed arrays, with no DOM and no native module, so the layout is the same in a
 * browser, in Node and in a worker. It implements the `CanvasLike` surface the scene's canvas renderer draws through
 * (`canvas.ts`), so the marks are drawn by the code that draws them on screen.
 *
 * Whether a pixel has any alpha depends on the last fraction of a percent of coverage, so the coverage is made the way a browser
 * canvas makes it rather than as exact areas:
 *
 * - a path becomes line edges as `raster-edges.ts` describes (curves cut into 2^shift lines, arcs as conics made into quads,
 *   ends snapped to a quarter row in y and 1/256 in x), so a small circle is four quads cut into four lines each, which is not
 *   a circle;
 * - the scan integrates the edges in 32 sub-rows a pixel, sums them a quarter pixel at a time with each quarter cut to whole
 *   1/256ths of coverage, and the colour's alpha scales the 8-bit total before it is blended source-over.
 *
 * Strokes are outlined (`raster-stroke.ts`) and scanned by the same path. Text is a box (see `fillText`). Clipping, blend modes,
 * gradients and patterns are not modelled: a gradient paints opaque.
 */
import { color as parseColor } from './color.js'
import type { CanvasLike, GradientLike } from './canvas.js'
import { arcConics, conicQuads, pathEdges, polygonEdges, type Edge, type Op, type Pt, type Sub } from './raster-edges.js'
import { strokePolygons } from './raster-stroke.js'

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

  /** An arc as conics of at most a quarter turn from the start, each made into quads (see `raster-edges.ts`). */
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
    const conics = arcConics([ux, uy], stop, sweep >= 0 ? 1 : -1, full)
    const cur = this.cur!
    const m = this.m
    const tol = 0.25 / Math.max(1e-6, radius * Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])))
    for (const c of conics) {
      for (const q of conicQuads(c, tol)) {
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
    for (const s of this.subs) if (s.ops.length) pathEdges(s, edges)
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
    const polys = strokePolygons(this.subs, {
      half: (this.lineWidth * scale) / 2,
      cap: this.lineCap,
      join: this.lineJoin,
      miterLimit: this.miterLimit,
      dash: this.dash.map((d) => d * scale),
      dashOffset: this.lineDashOffset * scale,
    })
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

  // --- scan conversion: coverage of the edges, a quarter pixel row at a time ----------------------

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
