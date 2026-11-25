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
import { arcConics, conicQuads, pathEdges, polygonEdges, type Edge, type Pt, type Sub } from './raster-edges.js'
import { strokeHairlines, strokePolygons } from './raster-stroke.js'
import { allot, meterTick } from './limits.js'

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

/**
 * Sort the first `m` crossings (x, with the winding direction riding along, and the edge that made it) by x, stably. The edges
 * stay in the order of the last sub-row's crossings, and crossings move little from one sub-row to the next, so an insertion sort
 * does it in about m steps with no comparator call or allocation. A drawing whose edges cross each other over and over (a dense
 * polygon) would make that quadratic: past a budget of moves it is the engine's own sort instead.
 */
export function sortCrossings(x: Float64Array, wd: Int8Array, ed: Edge[], m: number): void {
  let budget = 4 * m + 64
  // bounded: one pass over the m crossings, each moving at most as far as the budget allows
  for (let i = 1; i < m; i++) {
    const xi = x[i]!
    const wi = wd[i]!
    const ei = ed[i]!
    let j = i - 1
    // bounded: j counts down from i - 1, and the budget ends it
    while (j >= 0 && x[j]! > xi) {
      if (--budget < 0) { sortWhole(x, wd, ed, m, xi, wi, ei, j); return }
      x[j + 1] = x[j]!; wd[j + 1] = wd[j]!; ed[j + 1] = ed[j]!
      j--
    }
    x[j + 1] = xi
    wd[j + 1] = wi
    ed[j + 1] = ei
  }
}

/** The rest of {@link sortCrossings} when its moves ran out: the crossing in hand is put down where it stopped, then everything is sorted. */
function sortWhole(x: Float64Array, wd: Int8Array, ed: Edge[], m: number, xi: number, wi: number, ei: Edge, j: number): void {
  x[j + 1] = xi
  wd[j + 1] = wi
  ed[j + 1] = ei
  const order = Array.from({ length: m }, (_, i) => i).sort((p, q) => x[p]! - x[q]!)
  const sx = order.map((i) => x[i]!)
  const sw = order.map((i) => wd[i]!)
  const se = order.map((i) => ed[i]!)
  // bounded: m crossings, at most as many as the edges (the sub-row's tick has them as its cost)
  for (let i = 0; i < m; i++) { x[i] = sx[i]!; wd[i] = sw[i]!; ed[i] = se[i]! }
}

/**
 * The coverage a stroke of `width` under the transform `m` is drawn with when Skia draws it as a hairline (every stroke whose pen
 * is a pixel or less across, both ways: SkDrawTreatAsHairline), else 0. A hairline is one pixel wide whatever the pen's width, and
 * the alpha it is drawn with is scaled by this.
 */
function hairlineCoverage(width: number, m: readonly number[]): number {
  const len = (x: number, y: number): number => {
    const ax = Math.abs(x)
    const ay = Math.abs(y)
    return Math.max(ax, ay) + Math.min(ax, ay) / 2
  }
  const l0 = len(m[0]! * width, m[1]! * width)
  const l1 = len(m[2]! * width, m[3]! * width)
  return l0 <= 1 && l1 <= 1 ? (l0 + l1) / 2 : 0
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
  private crossX = new Float64Array(0)
  private crossW = new Int8Array(0)

  constructor(width: number, height: number) {
    this.width = Math.max(0, Math.floor(width))
    this.height = Math.max(0, Math.floor(height))
    // the size is a transform's (`label` / `wordcloud` `size`, from the spec): bounded before a byte of it is allocated
    this.alpha = new Uint8Array(allot('pixels', this.width * this.height, 'raster canvas'))
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
      // bounded: at most 4 quarter arcs of at most 32 quads each (conicQuads stops at 5 halvings)
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
    const pen = {
      half: (this.lineWidth * scale) / 2,
      cap: this.lineCap,
      join: this.lineJoin,
      miterLimit: this.miterLimit,
      dash: this.dash.map((d) => d * scale),
      dashOffset: this.lineDashOffset * scale,
      canvas: [0, 0, this.width, this.height] as [number, number, number, number],
    }
    // a pen of a pixel or less is a hairline to Skia: a line one pixel thick whose alpha is scaled by the pen's width (SkDraw)
    const wide = hairlineCoverage(this.lineWidth, m)
    if (wide > 0) {
      const hairs = strokeHairlines(this.subs, pen)
      // (the colour's alpha as 8 bits, then scaled by the coverage and cut, as the paint of a hairline is)
      const alpha = Math.min(255, Math.max(0, Math.floor(Math.round(a * 255) * wide + 1e-9)))
      if (alpha === 0) return
      const lines = hairs.lines
      // bounded: the segments the stroker made (it ticks as it makes them)
      for (let i = 0; i < lines.length; i += 4) this.hairline(lines[i]!, lines[i + 1]!, lines[i + 2]!, lines[i + 3]!, alpha)
      for (const cap of hairs.caps) this.scan(polygonEdges([cap]), 'nonzero', alpha / 255)
      return
    }
    this.scan(polygonEdges(strokePolygons(this.subs, pen)), 'nonzero', a)
  }

  /**
   * One segment as Skia's anti-aliased hairline draws it (SkScan_Antihair): along the axis it runs more along, every pixel of the
   * line takes the position of the line across it at its centre, in 1/64ths, and splits the pixel's share of the line's length
   * between the two pixels the one-pixel-thick line covers there, the nearer row or column more. The ends count the part of their
   * pixel the line covers. `alpha` is the paint's, 0..255; each pixel is blended source-over.
   */
  private hairline(x0: number, y0: number, x1: number, y1: number, alpha: number): void {
    let X0 = Math.trunc(x0 * 64)
    let Y0 = Math.trunc(y0 * 64)
    let X1 = Math.trunc(x1 * 64)
    let Y1 = Math.trunc(y1 * 64)
    if (![X0, Y0, X1, Y1].every(Number.isFinite)) return
    const across = Math.abs(X1 - X0) <= Math.abs(Y1 - Y0) // the segment runs more along y: pixels are walked down it
    if (across) { [X0, Y0] = [Y0, X0]; [X1, Y1] = [Y1, X1] }
    if (X0 > X1) { [X0, X1] = [X1, X0]; [Y0, Y1] = [Y1, Y0] }
    const major = across ? this.height : this.width // the extent along the walked axis
    const minor = across ? this.width : this.height
    const first = Math.max(0, Math.floor(X0 / 64)) // (not a shift: the coordinates may be past 32 bits)
    const stop = Math.min(major, Math.ceil(X1 / 64))
    if (!(stop > first)) return
    meterTick('raster', stop - first)
    // 16.16 fixed point as the scan walks it: the slope per pixel, and the line's position at the centre of the first pixel
    const slope = X1 === X0 ? 0 : Math.trunc(((Y1 - Y0) * 65536) / (X1 - X0))
    const start = Math.floor(X0 / 64)
    const fstart = Y0 * 1024 + (Y0 === Y1 ? 0 : Math.floor((slope * (32 - (((X0 % 64) + 64) % 64)) + 32) / 64))
    // (a pixel's share of the line, 0..255, scaled by the paint's alpha the way a blitter scales a coverage: (c + 1) of 256ths)
    const alphaOf = (c: number): number => ((c + 1) * alpha) >> 8
    // bounded: pixels of one row or column of the canvas, ticked for above
    for (let i = first; i < stop; i++) {
      const lo = Math.max(X0, i * 64)
      const hi = Math.min(X1, (i + 1) * 64)
      const share = X1 === X0 ? 64 : hi - lo // 1/64ths of the pixel the segment spans
      if (share <= 0) continue
      const at = fstart + slope * (i - start) + 32768 // the line's position at the pixel's centre, a whole number a boundary
      const near = Math.floor(at / 65536)
      const a8 = Math.floor(at / 256) & 255
      const cLow = (a8 * share) >> 6
      const cHigh = ((255 - a8) * share) >> 6
      if (near >= 0 && near < minor) this.blend(across ? near : i, across ? i : near, alphaOf(cLow))
      if (near - 1 >= 0 && near - 1 < minor) this.blend(across ? near - 1 : i, across ? i : near - 1, alphaOf(cHigh))
    }
  }

  private blend(x: number, y: number, srcA: number): void {
    if (srcA === 0) return
    const k = y * this.width + x
    const dst = this.alpha[k]!
    this.alpha[k] = srcA + ((dst * (256 - srcA)) >> 8)
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
    // the crossings of one sub-row, x and winding direction side by side (a sub-row is at most as wide as the edges are many)
    if (this.crossX.length < edges.length) { this.crossX = new Float64Array(edges.length); this.crossW = new Int8Array(edges.length) }
    const crossX = this.crossX
    const crossW = this.crossW
    for (let row = rowStart; row <= rowEnd; row++) {
      meterTick('raster', w)
      let lo = w
      let hi = -1
      for (let k = 0; k < SUBY; k++) {
        const y = row + (k + 0.5) / SUBY
        meterTick('raster', active.length + 1)
        // bounded: each edge enters the active list once over the whole scan
        while (next < edges.length && edges[next]!.y0 <= y) active.push(edges[next++]!)
        if (active.length) {
          let kept = 0
          let m = 0
          // bounded: the active edges, which the sub-row's tick above has as its cost
          for (let i = 0; i < active.length; i++) {
            const e = active[i]!
            if (e.y1 <= y) continue
            active[kept++] = e
            crossX[m] = e.x0 + (y - e.y0) * e.slope
            crossW[m++] = e.dir
          }
          active.length = kept
          if (m >= 2) {
            sortCrossings(crossX, crossW, active, m)
            let wind = 0
            // bounded: the crossings of this sub-row, one per active edge ticked for above
            for (let i = 0; i < m - 1; i++) {
              wind = rule === 'evenodd' ? wind ^ 1 : wind + crossW[i]!
              if (wind === 0) continue
              const xa = Math.max(0, crossX[i]!)
              const xb = Math.min(w, crossX[i + 1]!)
              if (!(xb > xa)) continue
              const ia = Math.floor(xa)
              const ib = Math.min(w - 1, Math.floor(xb))
              if (ia < lo) lo = ia
              if (ib > hi) hi = ib
              if (ia === ib) cov[ia] = cov[ia]! + (xb - xa) * PER_SUB
              else {
                cov[ia] = cov[ia]! + (ia + 1 - xa) * PER_SUB
                // bounded: a run of pixels of this row: at most the canvas width the row ticked for
                for (let px = ia + 1; px < ib; px++) cov[px] = cov[px]! + PER_SUB
                if (xb > ib) cov[ib] = cov[ib]! + (xb - ib) * PER_SUB
              }
            }
          }
        }
        // the end of a quarter of the row: analytic coverage is made a quarter row at a time and each is cut to whole 1/256ths
        if ((k + 1) % QUARTER === 0) {
          // bounded: the pixels of this row the edges reached: at most the canvas width the row ticked for
          for (let px = lo; px <= hi; px++) {
            const c = cov[px]!
            if (c === 0) continue
            cov[px] = 0
            sum[px] = sum[px]! + Math.floor(c)
          }
        }
      }
      const base = row * w
      // bounded: the pixels of this row the edges reached: at most the canvas width the row ticked for
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
