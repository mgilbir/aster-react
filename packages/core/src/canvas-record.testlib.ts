/**
 * Test-only recording 2D context (excluded from the published build).
 *
 * Unlike a flat command log it tracks the transform, the graphics state and the
 * clip, and emits one record per PAINT (fill / stroke / fillText) carrying the
 * absolute geometry and the full paint state. Two paint sequences that draw the
 * same things in the same state compare equal even if they reach it through
 * different save/translate/restore nesting.
 */
import type { CanvasLike, GradientLike } from './canvas.js'

export interface PaintRecord {
  op: 'fill' | 'stroke' | 'text'
  /** Absolute geometry (current path, or the text anchor). */
  geom: string
  /** Paint state: colour, alpha, line style, font; plus the active clip. */
  style: string
  /** The path as flattened device-space polylines (fill/stroke), for geometric checks. */
  polys?: Array<{ pts: number[]; closed: boolean }>
  /** Device-space stroke width (stroke). */
  lineWidth?: number
}

type M = [number, number, number, number, number, number]
interface State {
  m: M
  fillStyle: unknown
  strokeStyle: unknown
  globalAlpha: number
  lineWidth: number
  lineCap: string
  lineJoin: string
  miterLimit: number
  font: string
  textAlign: string
  textBaseline: string
  dash: number[]
  clip: string[]
}

const r3 = (n: number): string => (Number.isFinite(n) ? String(Math.round(n * 1000) / 1000 + 0) : String(n))

function paintName(p: unknown): string {
  if (p != null && typeof p === 'object') {
    const g = p as { __gradId?: string; stops?: string }
    return `grad(${g.__gradId ?? ''}:${g.stops ?? ''})`
  }
  return String(p)
}

export function makeRecorder(): { ctx: CanvasLike; records: PaintRecord[] } {
  const records: PaintRecord[] = []
  let st: State = {
    m: [1, 0, 0, 1, 0, 0], fillStyle: '#000', strokeStyle: '#000', globalAlpha: 1, lineWidth: 1, lineCap: 'butt',
    lineJoin: 'miter', miterLimit: 10, font: '10px sans-serif', textAlign: 'start', textBaseline: 'alphabetic', dash: [], clip: [],
  }
  const stack: State[] = []
  let path: string[] = []
  let polys: Array<{ pts: number[]; closed: boolean }> = []
  let cur: { pts: number[]; closed: boolean } | null = null
  let lastX = 0, lastY = 0, startX = 0, startY = 0
  const dev = (x: number, y: number): [number, number] => [st.m[0] * x + st.m[2] * y + st.m[4], st.m[1] * x + st.m[3] * y + st.m[5]]
  const start = (x: number, y: number): void => {
    const [dx, dy] = dev(x, y)
    cur = { pts: [dx, dy], closed: false }
    polys.push(cur)
    lastX = x; lastY = y; startX = x; startY = y
  }
  const add = (x: number, y: number): void => {
    if (!cur) { start(x, y); return }
    const [dx, dy] = dev(x, y)
    cur.pts.push(dx, dy)
    lastX = x; lastY = y
  }
  const pt = (x: number, y: number): string => `${r3(st.m[0] * x + st.m[2] * y + st.m[4])},${r3(st.m[1] * x + st.m[3] * y + st.m[5])}`
  const styleKey = (kind: 'fill' | 'stroke' | 'text'): string => {
    const paint = kind === 'stroke' ? paintName(st.strokeStyle) : paintName(st.fillStyle)
    const sx = Math.hypot(st.m[0], st.m[1])
    const line = kind === 'stroke' ? `|w${r3(st.lineWidth * sx)}|d${st.dash.map((d) => r3(d * sx)).join(',')}|${st.lineCap}|${st.lineJoin}|${r3(st.miterLimit)}` : ''
    const font = kind === 'text' ? `|${st.font}|${st.textAlign}|${st.textBaseline}` : ''
    return `${paint}|a${r3(st.globalAlpha)}${line}${font}|clip:${st.clip.join(';')}`
  }
  const ctx: CanvasLike = {
    save() { stack.push({ ...st, m: [...st.m] as M, dash: [...st.dash], clip: [...st.clip] }) },
    restore() { const s = stack.pop(); if (s) st = s },
    translate(x, y) { st.m = [st.m[0], st.m[1], st.m[2], st.m[3], st.m[0] * x + st.m[2] * y + st.m[4], st.m[1] * x + st.m[3] * y + st.m[5]] },
    scale(x, y) { st.m = [st.m[0] * x, st.m[1] * x, st.m[2] * y, st.m[3] * y, st.m[4], st.m[5]] },
    rotate(a) {
      const c = Math.cos(a), s = Math.sin(a)
      st.m = [st.m[0] * c + st.m[2] * s, st.m[1] * c + st.m[3] * s, st.m[2] * c - st.m[0] * s, st.m[3] * c - st.m[1] * s, st.m[4], st.m[5]]
    },
    beginPath() { path = []; polys = []; cur = null },
    moveTo(x, y) { path.push(`M${pt(x, y)}`); start(x, y) },
    lineTo(x, y) { path.push(`L${pt(x, y)}`); add(x, y) },
    bezierCurveTo(a, b, c, d, x, y) {
      path.push(`C${pt(a, b)},${pt(c, d)},${pt(x, y)}`)
      const x0 = lastX, y0 = lastY
      for (let i = 1; i <= 16; i++) { const t = i / 16, u = 1 - t; add(u * u * u * x0 + 3 * u * u * t * a + 3 * u * t * t * c + t * t * t * x, u * u * u * y0 + 3 * u * u * t * b + 3 * u * t * t * d + t * t * t * y) }
    },
    quadraticCurveTo(a, b, x, y) {
      path.push(`Q${pt(a, b)},${pt(x, y)}`)
      const x0 = lastX, y0 = lastY
      for (let i = 1; i <= 12; i++) { const t = i / 12, u = 1 - t; add(u * u * x0 + 2 * u * t * a + t * t * x, u * u * y0 + 2 * u * t * b + t * t * y) }
    },
    arc(x, y, r, a0, a1, ccw = false) {
      path.push(`A${pt(x, y)},r${r3(r * Math.hypot(st.m[0], st.m[1]))},${r3(a0)},${r3(a1)},${ccw ? 1 : 0}`)
      let da = a1 - a0
      if (!ccw && da < 0) da = (da % (2 * Math.PI)) + 2 * Math.PI
      if (ccw && da > 0) da = (da % (2 * Math.PI)) - 2 * Math.PI
      if (Math.abs(da) > 2 * Math.PI) da = Math.sign(da) * 2 * Math.PI
      const n = Math.max(8, Math.ceil(Math.abs(da) / (Math.PI / 32)))
      for (let i = 0; i <= n; i++) { const a = a0 + (da * i) / n; add(x + r * Math.cos(a), y + r * Math.sin(a)) }
    },
    closePath() { path.push('Z'); if (cur) { cur.closed = true; cur = null; lastX = startX; lastY = startY } },
    rect(x, y, w, h) {
      path.push(`R${pt(x, y)},${pt(x + w, y)},${pt(x + w, y + h)},${pt(x, y + h)}`)
      start(x, y); add(x + w, y); add(x + w, y + h); add(x, y + h); if (cur) { (cur as { closed: boolean }).closed = true; cur = null }
    },
    clip() { st.clip.push(path.join('')) },
    fill() { records.push({ op: 'fill', geom: path.join(''), style: styleKey('fill'), polys: polys.map((p) => ({ pts: p.pts.slice(), closed: p.closed })) }) },
    stroke() { records.push({ op: 'stroke', geom: path.join(''), style: styleKey('stroke'), polys: polys.map((p) => ({ pts: p.pts.slice(), closed: p.closed })), lineWidth: st.lineWidth * Math.hypot(st.m[0], st.m[1]) }) },
    fillRect(x, y, w, h) { records.push({ op: 'fill', geom: `R${pt(x, y)},${pt(x + w, y)},${pt(x + w, y + h)},${pt(x, y + h)}`, style: styleKey('fill') }) },
    setLineDash(d) { st.dash = [...d] },
    fillText(text, x, y) { records.push({ op: 'text', geom: `${JSON.stringify(text)}@${pt(x, y)}`, style: styleKey('text') }) },
    createLinearGradient(x0, y0, x1, y1): GradientLike {
      const stops: string[] = []
      const g = { addColorStop(o: number, c: string) { stops.push(`${r3(o)}:${c}`) }, get stops() { return stops.join('/') } }
      void x0; void y0; void x1; void y1
      return g as GradientLike
    },
    get fillStyle() { return st.fillStyle },
    set fillStyle(v) { st.fillStyle = v },
    get strokeStyle() { return st.strokeStyle },
    set strokeStyle(v) { st.strokeStyle = v },
    get globalAlpha() { return st.globalAlpha },
    set globalAlpha(v) { st.globalAlpha = v },
    get lineWidth() { return st.lineWidth },
    set lineWidth(v) { st.lineWidth = v },
    get lineCap() { return st.lineCap },
    set lineCap(v) { st.lineCap = v },
    get lineJoin() { return st.lineJoin },
    set lineJoin(v) { st.lineJoin = v },
    get miterLimit() { return st.miterLimit },
    set miterLimit(v) { st.miterLimit = v },
    get font() { return st.font },
    set font(v) { st.font = v },
    get textAlign() { return st.textAlign },
    set textAlign(v) { st.textAlign = v },
    get textBaseline() { return st.textBaseline },
    set textBaseline(v) { st.textBaseline = v },
  }
  return { ctx, records }
}

/** Multiset equality of paint records; returns a description of the first difference or null. */
export function diffPaintMultisets(want: PaintRecord[], got: PaintRecord[]): string | null {
  const key = (r: PaintRecord): string => `${r.op} ${r.geom} ${r.style}`
  const count = new Map<string, number>()
  for (const r of want) count.set(key(r), (count.get(key(r)) ?? 0) + 1)
  for (const r of got) count.set(key(r), (count.get(key(r)) ?? 0) - 1)
  const missing: string[] = []
  const extra: string[] = []
  for (const [k, n] of count) {
    if (n > 0) missing.push(`${n}x ${k}`)
    else if (n < 0) extra.push(`${-n}x ${k}`)
  }
  if (!missing.length && !extra.length) return null
  return `append-painted canvas differs from a full repaint: ${missing.length} missing, ${extra.length} extra.\n    missing: ${missing[0]?.slice(0, 160) ?? '-'}\n    extra:   ${extra[0]?.slice(0, 160) ?? '-'}`
}
