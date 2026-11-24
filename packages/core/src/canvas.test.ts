/**
 * Canvas renderer tests: a recording 2D-context mock captures the
 * renderer's draw commands; geometry and paint are compared against the same
 * scene's SVG serialization via shared path canonicalization.
 */
import { describe, expect, it } from 'vitest'
import './addon-transforms.js'
import './addon-geo.js'
import { renderSceneToSvg } from './render.js'
import {
  parsePathData, canonicalPath, renderSceneToCanvas, renderSceneToCanvasAppend, snapshotCanvasScene,
  type CanvasLike, type GradientLike,
} from './canvas.js'
import type { SceneGroup, SceneItem, SceneRoot } from './types.js'
import { evaluateChart } from './evaluate.js'
import { compileChart } from './compiler.js'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// ---------------------------------------------------------------------------
// Recording context
// ---------------------------------------------------------------------------

interface DrawRecord {
  kind: 'fill' | 'stroke' | 'text' | 'strokeText' | 'clip' | 'image' | 'grad'
  path: string
  paint: string
}

/**
 * A context that records what a renderer paints, in a form the SVG of the same scene can be reduced to: each fill, stroke, text,
 * stroked text, clip and image, with the whole graphics state it was drawn in. The state is saved and restored by save() / restore()
 * as a real canvas does, so a renderer that leans on a property it did not set is seen (the defaults are a real canvas's:
 * `miterLimit` is 10, the SVG renderer's 4 is set by the renderer). Geometry is recorded in device space with the translation
 * applied and the rotation kept as an angle of its own (an arc is not rotated point by point): a symbol or path that is drawn at
 * another angle is a different record, and so is a path drawn with another cap, join, dash offset or blend.
 */
function makeRecordingCtx(): { ctx: CanvasLike; records: DrawRecord[] } {
  const records: DrawRecord[] = []
  interface State {
    tx: number; ty: number; rot: number
    fillStyle: unknown; strokeStyle: unknown; globalAlpha: number; lineWidth: number; dash: number[]; dashOffset: number
    cap: string; join: string; miter: number; blend: string; font: string; textAlign: string; textBaseline: string
  }
  let st: State = {
    tx: 0, ty: 0, rot: 0, fillStyle: '#000', strokeStyle: '#000', globalAlpha: 1, lineWidth: 1, dash: [], dashOffset: 0,
    cap: 'butt', join: 'miter', miter: 10, blend: 'source-over', font: '', textAlign: 'start', textBaseline: 'alphabetic',
  }
  const stack: State[] = []
  let ops: string[] = []
  let cp: [number, number] | null = null // current point (device space)
  const fmt = (n: number): string => {
    if (!Number.isFinite(n)) return String(n)
    if (Number.isInteger(n)) return String(n)
    return String(Math.round(n * 1000) / 1000)
  }
  // (a path is built in the transform it is built under, and filled or stroked after the renderer has let the transform go:
  // the angle a path was built at is what makes it a rotated drawing)
  let pathRot = 0
  const tail = (): string => `${pathRot ? `;rot=${fmt(pathRot)}` : ''}${st.blend === 'source-over' ? '' : `;blend=${st.blend}`}`
  const lineStyle = (): string => `;sw=${fmt(st.lineWidth)};dash=${st.dash.join(',') || '-'};cap=${st.cap};join=${st.join};miter=${fmt(st.miter)};doff=${fmt(st.dashOffset)}`
  const ctx: CanvasLike = {
    save() { stack.push({ ...st, dash: [...st.dash] }) },
    restore() { const t = stack.pop(); if (t) st = t },
    translate(x, y) { st.tx += x; st.ty += y },
    scale(x) { st.tx *= x; st.ty *= x },
    beginPath() { ops = []; cp = null; pathRot = 0 },
    moveTo(x, y) { pathRot = st.rot; ops.push(`M${fmt(x + st.tx)},${fmt(y + st.ty)}`); cp = [x + st.tx, y + st.ty] },
    lineTo(x, y) { pathRot = st.rot; ops.push(`L${fmt(x + st.tx)},${fmt(y + st.ty)}`); cp = [x + st.tx, y + st.ty] },
    bezierCurveTo(a, b, c, d, x, y) { pathRot = st.rot; ops.push(`C${fmt(a + st.tx)},${fmt(b + st.ty)},${fmt(c + st.tx)},${fmt(d + st.ty)},${fmt(x + st.tx)},${fmt(y + st.ty)}`); cp = [x + st.tx, y + st.ty] },
    quadraticCurveTo(a, b, x, y) { pathRot = st.rot; ops.push(`Q${fmt(a + st.tx)},${fmt(b + st.ty)},${fmt(x + st.tx)},${fmt(y + st.ty)}`); cp = [x + st.tx, y + st.ty] },
    arc(x, y, r, a0, a1, ccw = false) {
      pathRot = st.rot
      const ax = x + st.tx, ay = y + st.ty
      // a real canvas arc() first connects the current point to the arc's start with a
      // straight line (or starts a subpath there when there is no current point)
      const sx0 = ax + r * Math.cos(a0), sy0 = ay + r * Math.sin(a0)
      if (cp === null) ops.push(`M${fmt(sx0)},${fmt(sy0)}`)
      // (a connecting line shorter than the SVG's resolution, a thousandth, is not a line the SVG could show)
      else if (Math.hypot(cp[0] - sx0, cp[1] - sy0) > 1e-3) ops.push(`L${fmt(sx0)},${fmt(sy0)}`)
      let delta = a1 - a0
      if (!ccw && delta < 0) delta += 2 * Math.PI
      if (ccw && delta > 0) delta -= 2 * Math.PI
      const x2 = ax + r * Math.cos(a1)
      const y2 = ay + r * Math.sin(a1)
      // Tolerance: semicircular caps span exactly π but the center-parameterization
      // conversion can land just below it.
      const large = Math.abs(delta) >= Math.PI - 1e-6 ? 1 : 0
      const sweep = ccw ? 0 : 1
      if (Math.abs(Math.abs(delta) - 2 * Math.PI) < 1e-9) {
        ops.push(`CIRC(${fmt(ax)},${fmt(ay)},${fmt(r)})`)
        cp = [sx0, sy0]
      } else {
        ops.push(`A${fmt(r)},${fmt(r)},0,${large},${sweep},${fmt(x2)},${fmt(y2)}`)
        cp = [x2, y2]
      }
    },
    closePath() { ops.push('Z') },
    rect(x, y, w, h) { pathRot = st.rot; ops.push(`M${fmt(x + st.tx)},${fmt(y + st.ty)}h${fmt(w)}v${fmt(h)}h${fmt(-w)}Z`); cp = [x + st.tx, y + st.ty] },
    clip() { records.push({ kind: 'clip', path: ops.join(''), paint: '' }) },
    fill() {
      records.push({ kind: 'fill', path: ops.join(''), paint: paintStr(st.fillStyle, st.globalAlpha) + tail() })
    },
    stroke() {
      records.push({ kind: 'stroke', path: ops.join(''), paint: paintStr(st.strokeStyle, st.globalAlpha) + lineStyle() + tail() })
    },
    fillRect(x, y, w, h) {
      const save = ops
      ops = []
      this.rect(x, y, w, h)
      records.push({ kind: 'fill', path: ops.join(''), paint: paintStr(st.fillStyle, st.globalAlpha) + tail() })
      ops = save
    },
    setLineDash(d) { st.dash = [...d] },
    // (the angles add up, as a real canvas's matrix does: a rotate inside a rotated group is the sum)
    rotate(a) { st.rot += a },
    fillText(text, x, y) {
      records.push({ kind: 'text', path: '', paint: `t=${text};x=${fmt(x + st.tx)};y=${fmt(y + st.ty)};align=${st.textAlign};font=${st.font}${st.rot ? `;rot=${fmt(st.rot)}` : ''};style=${paintStr(st.fillStyle, st.globalAlpha)}${st.blend === 'source-over' ? '' : `;blend=${st.blend}`}` })
    },
    strokeText(text, x, y) {
      records.push({ kind: 'strokeText', path: '', paint: `t=${text};x=${fmt(x + st.tx)};y=${fmt(y + st.ty)};align=${st.textAlign};font=${st.font}${st.rot ? `;rot=${fmt(st.rot)}` : ''};style=${paintStr(st.strokeStyle, st.globalAlpha)}${lineStyle()}${st.blend === 'source-over' ? '' : `;blend=${st.blend}`}` })
    },
    drawImage(_image, dx, dy, dw, dh) {
      records.push({ kind: 'image', path: '', paint: `x=${fmt(dx + st.tx)};y=${fmt(dy + st.ty)};w=${fmt(dw ?? 0)};h=${fmt(dh ?? 0)};alpha=${fmtA(st.globalAlpha)}${tail()}` })
    },
    createLinearGradient(): GradientLike {
      // Gradient fills are parity-checked separately (coords derive from the
      // element bbox); the recorder just returns a stop-collecting stub.
      return { addColorStop() {} }
    },
    createRadialGradient(): GradientLike {
      return { addColorStop() {} }
    },
    get fillStyle() { return st.fillStyle },
    set fillStyle(v: unknown) { st.fillStyle = v },
    get strokeStyle() { return st.strokeStyle },
    set strokeStyle(v: unknown) { st.strokeStyle = v },
    get globalAlpha() { return st.globalAlpha },
    set globalAlpha(v: number) { st.globalAlpha = v },
    get lineWidth() { return st.lineWidth },
    set lineWidth(v: number) { st.lineWidth = v },
    get lineCap() { return st.cap },
    set lineCap(v: string) { st.cap = v },
    get lineJoin() { return st.join },
    set lineJoin(v: string) { st.join = v },
    get miterLimit() { return st.miter },
    set miterLimit(v: number) { st.miter = v },
    get lineDashOffset() { return st.dashOffset },
    set lineDashOffset(v: number) { st.dashOffset = v },
    get globalCompositeOperation() { return st.blend },
    set globalCompositeOperation(v: string) { st.blend = v },
    get font() { return st.font },
    set font(v: string) { st.font = v },
    get textAlign() { return st.textAlign },
    set textAlign(v: string) { st.textAlign = v },
    get textBaseline() { return st.textBaseline },
    set textBaseline(v: string) { st.textBaseline = v },
  }
  return { ctx, records }
}

function paintStr(style: unknown, alpha: number): string {
  const s = typeof style === 'string'
    ? style
    : style != null && typeof style === 'object' && '__gradId' in style
      ? `url(#${(style as { __gradId: string }).__gradId})`
      : style != null ? 'grad' : 'none'
  return `style=${s};alpha=${fmtA(alpha)}`
}
function fmtA(n: number): string {
  return String(Math.round(n * 1000) / 1000)
}

// ---------------------------------------------------------------------------
// SVG-side record extraction: walk the rendered SVG string with a translate
// stack and emit the same record shapes.
// ---------------------------------------------------------------------------

/** `translate(..)` and `rotate(..)` of a transform attribute: the translation (rotations do not turn later translates, as in the recorder) and the angle in radians. */
function parseTransform(attrs: string): { tx: number; ty: number; rot: number } {
  const m = /(?:^| )transform="([^"]*)"/.exec(attrs)
  let tx = 0, ty = 0, rot = 0
  if (!m) return { tx, ty, rot }
  for (const t of m[1]!.matchAll(/(translate|rotate)\(([^)]*)\)/g)) {
    const nums = t[2]!.split(/[ ,]+/).filter(Boolean).map(Number)
    if (t[1] === 'translate') { tx += nums[0]!; ty += nums[1] ?? 0 } else rot += (nums[0]! * Math.PI) / 180
  }
  return { tx, ty, rot }
}

function svgRecords(svgIn: string, { images = true }: { images?: boolean } = {}): DrawRecord[] {
  // the clip paths the scene defines, by id (the shape is in the frame of the element that references it)
  const clips = new Map<string, { rect: [number, number, number, number] } | { d: string }>()
  for (const c of svgIn.matchAll(/<clipPath id="([^"]*)"><(rect|path)\b([^>]*)\/><\/clipPath>/g)) {
    const at = (n: string): string | undefined => new RegExp(`(?:^| )${n}="([^"]*)"`).exec(c[3]!)?.[1]
    clips.set(c[1]!, c[2] === 'rect' ? { rect: [Number(at('x') ?? 0), Number(at('y') ?? 0), Number(at('width') ?? 0), Number(at('height') ?? 0)] } : { d: at('d') ?? '' })
  }
  // (what <defs> holds is referenced, never drawn: a radial gradient's pattern wrapper has a rect of its own)
  const svg = svgIn.replace(/<defs>[\s\S]*?<\/defs>/g, '')
  const records: DrawRecord[] = []
  const stack: Array<[number, number, number]> = [[0, 0, 0]]
  const at = (): [number, number, number] => stack[stack.length - 1]!
  const attrOf = (attrs: string, name: string): string | undefined => {
    const m = new RegExp(`(?:^| )${name}="([^"]*)"`, 'g').exec(attrs)
    return m?.[1]
  }
  /** what the canvas keeps in its graphics state besides the paint: blend, and the angle the element is drawn at */
  const tailOf = (attrs: string, rot: number): string => {
    const blend = /(?:^| )style="mix-blend-mode: ([^;"]*);?"/.exec(attrs)?.[1]
    return `${rot ? `;rot=${fmtN(rot)}` : ''}${blend && blend !== 'normal' ? `;blend=${blend}` : ''}`
  }
  /** the line style of a stroke: width, dash, cap, join, miter limit (the root writes 4) and dash offset, each with the canvas's default */
  const lineOf = (attrs: string, dash: string | undefined): string =>
    `;sw=${fmtN(Number(attrOf(attrs, 'stroke-width') ?? 1))};dash=${dash ?? '-'};cap=${attrOf(attrs, 'stroke-linecap') ?? 'butt'};join=${attrOf(attrs, 'stroke-linejoin') ?? 'miter'};miter=${fmtN(Number(attrOf(attrs, 'stroke-miterlimit') ?? 4))};doff=${fmtN(Number(attrOf(attrs, 'stroke-dashoffset') ?? 0))}`
  const tagRe = /<\/g\b[^>]*>|<g\b[^>]*>|<text\b[^>]*>[\s\S]*?<\/text>|<(path|line|circle|rect|image)\b[^>]*>/g
  let m: RegExpExecArray | null
  while ((m = tagRe.exec(svg))) {
    const tok = m[0]
    if (tok.startsWith('</g')) {
      stack.pop()
      continue
    }
    if (tok.startsWith('<g')) {
      const t = parseTransform(tok)
      const frame: [number, number, number] = [at()[0] + t.tx, at()[1] + t.ty, at()[2] + t.rot]
      stack.push(frame)
      // a clip the group carries, in the group's own frame: the clip the canvas makes where it clips
      const ref = /clip-path="url\(#([^)]*)\)"/.exec(tok)?.[1]
      if (ref !== undefined) {
        const def = clips.get(ref)
        if (!def) throw new Error(`clip-path ${ref} is not defined`)
        const path = 'rect' in def
          ? `M${fmtN(def.rect[0] + frame[0])},${fmtN(def.rect[1] + frame[1])}h${fmtN(def.rect[2])}v${fmtN(def.rect[3])}h${fmtN(-def.rect[2])}Z`
          : canonicalPath(parsePathData(def.d).map((sg) => translateSeg(sg, frame[0], frame[1])))
        records.push({ kind: 'clip', path, paint: '' })
      }
      continue
    }
    const [tx, ty, grot] = at()
    if (tok.startsWith('<text')) {
      const attrs = tok.slice(0, tok.indexOf('>'))
      const inner = tok.slice(tok.indexOf('>') + 1, tok.lastIndexOf('</text>'))
      // vega's text transform: translate(x,y) [rotate(a) [translate(dx,dy)]]
      // (the unrotated form folds dx/dy and the baseline offset into one translate)
      const tmatch = /transform="translate\(([-\d.e]+),([-\d.e]+)\)(?: rotate\(([-\d.e]+)\))?(?: translate\(([-\d.e]+),([-\d.e]+)\))?"/.exec(attrs)
      if (!tmatch) throw new Error(`text without a vega transform: ${attrs}`)
      const x = Number(tmatch[1]) + (tmatch[4] != null ? Number(tmatch[4]) : 0) + tx
      const y = Number(tmatch[2]) + (tmatch[5] != null ? Number(tmatch[5]) : 0) + ty
      const rotRad = grot + (tmatch[3] != null ? (Number(tmatch[3]) * Math.PI) / 180 : 0)
      const rot = rotRad ? `;rot=${fmtN(rotRad)}` : ''
      const anchor = attrOf(attrs, 'text-anchor') ?? 'start'
      const align = anchor === 'start' ? 'left' : anchor === 'end' ? 'right' : 'center'
      const fs = attrOf(attrs, 'font-size')
      const fsNum = fs != null ? Number(String(fs).replace(/px$/, '')) : 11
      const fw = attrOf(attrs, 'font-weight')
      const fst = attrOf(attrs, 'font-style')
      const fill = attrOf(attrs, 'fill') ?? '-'
      const stroke = attrOf(attrs, 'stroke')
      const op = Number(attrOf(attrs, 'opacity') ?? 1)
      if (op === 0) continue // vega's canvas paints nothing at opacity 0 (draw.js)
      if (inner === '') continue // vega's canvas skips empty text (marks/text.js draw)
      // multi-line text is not compared: the SVG's tspans restart at x=0 and the canvas continues at the anchor (see MULTI_LINE)
      if (inner.includes('<tspan')) continue
      // (the serializer escapes the text of the element; the canvas draws the characters)
      const content = inner.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&')
      const fam = attrOf(attrs, 'font-family') ?? 'sans-serif'
      const head = `t=${content};x=${fmtN(x)};y=${fmtN(y)};align=${align};font=${[fst, fw, `${fsNum}px`, fam].filter(Boolean).join(' ')}${rot}`
      const blend = tailOf(attrs, 0)
      records.push({ kind: 'text', path: '', paint: `${head};style=style=${fill};alpha=${fmtN(op)}${blend}` })
      // vega's canvas strokes text when it has a stroke and a width > 0 (marks/text.js draw: stroke is not skipped for fill: none)
      const so = Number(attrOf(attrs, 'stroke-opacity') ?? 1)
      if (stroke && stroke !== 'none' && Number(attrOf(attrs, 'stroke-width') ?? 1) > 0 && op * so > 0) {
        records.push({ kind: 'strokeText', path: '', paint: `${head};style=style=${stroke};alpha=${fmtN(op * so)}${lineOf(attrs, attrOf(attrs, 'stroke-dasharray'))}${blend}` })
      }
      continue
    }
    const tag = m[1]!
    const attrs = tok
    if (tag === 'path') {
      const d = attrOf(attrs, 'd')
      if (!d) continue
      const t = parseTransform(attrs)
      const segs = parsePathData(d).map((s) => translateSeg(s, tx + t.tx, ty + t.ty))
      const path = canonicalPath(segs)
      const tail = tailOf(attrs, grot + t.rot)
      const fill = attrOf(attrs, 'fill')
      const stroke = attrOf(attrs, 'stroke')
      const op = Number(attrOf(attrs, 'opacity') ?? 1)
      const fo = Number(attrOf(attrs, 'fill-opacity') ?? 1)
      const so = Number(attrOf(attrs, 'stroke-opacity') ?? 1)
      const sw = attrOf(attrs, 'stroke-width')
      const dash = attrOf(attrs, 'stroke-dasharray')
      // vega's canvas (util/canvas/draw.js, fill.js, stroke.js): opacity 0 paints
      // nothing, a fill needs alpha > 0, a stroke needs width > 0 and alpha > 0
      if (op === 0) continue
      if (fill && op * fo > 0) records.push({ kind: 'fill', path, paint: `style=${fill};alpha=${fmtN(op * fo)}${tail}` })
      if (stroke && Number(sw ?? 1) > 0 && op * so > 0) records.push({ kind: 'stroke', path, paint: `style=${stroke};alpha=${fmtN(op * so)}${lineOf(attrs, dash)}${tail}` })
    } else if (tag === 'line') {
      const x1 = Number(attrOf(attrs, 'x1') ?? 0) + tx
      const y1 = Number(attrOf(attrs, 'y1') ?? 0) + ty
      const x2 = Number(attrOf(attrs, 'x2') ?? 0) + tx
      const y2 = Number(attrOf(attrs, 'y2') ?? 0) + ty
      const path = `M${fmtN(x1)},${fmtN(y1)}L${fmtN(x2)},${fmtN(y2)}`
      const stroke = attrOf(attrs, 'stroke')
      const op = Number(attrOf(attrs, 'opacity') ?? 1)
      const sw = attrOf(attrs, 'stroke-width')
      const dash = attrOf(attrs, 'stroke-dasharray')
      const lso = Number(attrOf(attrs, 'stroke-opacity') ?? 1)
      if (op !== 0 && stroke && Number(sw ?? 1) > 0 && op * lso > 0) records.push({ kind: 'stroke', path, paint: `style=${stroke};alpha=${fmtN(op * lso)}${lineOf(attrs, dash)}${tailOf(attrs, grot)}` })
    } else if (tag === 'circle') {
      const cx = Number(attrOf(attrs, 'cx') ?? 0) + tx
      const cy = Number(attrOf(attrs, 'cy') ?? 0) + ty
      const r = Number(attrOf(attrs, 'r') ?? 0)
      const path = `CIRC(${fmtN(cx)},${fmtN(cy)},${fmtN(r)})`
      const fill = attrOf(attrs, 'fill')
      const stroke = attrOf(attrs, 'stroke')
      const op = Number(attrOf(attrs, 'opacity') ?? 1)
      const fo = Number(attrOf(attrs, 'fill-opacity') ?? 1)
      const sw = attrOf(attrs, 'stroke-width')
      const so = Number(attrOf(attrs, 'stroke-opacity') ?? 1)
      const tail = tailOf(attrs, grot)
      if (op === 0) continue
      if (fill && op * fo > 0) records.push({ kind: 'fill', path, paint: `style=${fill};alpha=${fmtN(op * fo)}${tail}` })
      if (stroke && Number(sw ?? 1) > 0 && op * so > 0) records.push({ kind: 'stroke', path, paint: `style=${stroke};alpha=${fmtN(op * so)}${lineOf(attrs, undefined)}${tail}` })
    } else if (tag === 'rect') {
      const x = Number(attrOf(attrs, 'x') ?? 0) + tx
      const y = Number(attrOf(attrs, 'y') ?? 0) + ty
      const w = Number(attrOf(attrs, 'width') ?? 0)
      const h = Number(attrOf(attrs, 'height') ?? 0)
      const fill = attrOf(attrs, 'fill')
      if (fill) {
        const path = `M${fmtN(x)},${fmtN(y)}h${fmtN(w)}v${fmtN(h)}h${fmtN(-w)}Z`
        records.push({ kind: 'fill', path, paint: `style=${fill};alpha=1${tailOf(attrs, grot)}` })
      }
    } else if (tag === 'image' && images && attrOf(attrs, 'xlink:href')) {
      // (an image with no href has no bitmap: nothing is painted. One with an href the host has not loaded is written and not painted)
      const t = parseTransform(attrs)
      const op = Number(attrOf(attrs, 'opacity') ?? 1)
      records.push({ kind: 'image', path: '', paint: `x=${fmtN(t.tx + tx)};y=${fmtN(t.ty + ty)};w=${fmtN(Number(attrOf(attrs, 'width') ?? 0))};h=${fmtN(Number(attrOf(attrs, 'height') ?? 0))};alpha=${fmtN(op)}${tailOf(attrs, grot)}` })
    }
  }
  return records
}

function translateSeg(s: ReturnType<typeof parsePathData>[number], tx: number, ty: number): ReturnType<typeof parsePathData>[number] {
  const out = { ...s } as Record<string, unknown>
  if ('x' in out && typeof out.x === 'number') out.x += tx
  if ('y' in out && typeof out.y === 'number') out.y += ty
  if ('c1x' in out) { out.c1x = (out.c1x as number) + tx; out.c1y = (out.c1y as number) + ty }
  if ('c2x' in out) { out.c2x = (out.c2x as number) + tx; out.c2y = (out.c2y as number) + ty }
  if ('cx' in out && s.cmd === 'Q') { out.cx = (out.cx as number) + tx; out.cy = (out.cy as number) + ty }
  return s.cmd === 'Z' ? s : (out as typeof s)
}

function fmtN(n: number): string {
  if (!Number.isFinite(n)) return String(n)
  if (Number.isInteger(n)) return String(n)
  return String(Math.round(n * 1000) / 1000)
}

/** Expand H/V segments to L so both sides compare uniformly. */
function expandPath(canon: string): string {
  let cx = 0, cy = 0
  const out: string[] = []
  // (a circle, `CIRC(cx,cy,r)` or `O(x,y,r,sweep)`, is not path data: it is kept, its numbers rounded as the SVG's are, so what size and where it is is compared)
  for (const part of canon.split(/(CIRC\([^)]*\)|O\([^)]*\))/)) {
    if (part.startsWith('CIRC(') || part.startsWith('O(')) { out.push(part.replace(/-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/g, (x) => f(Number(x)))); continue }
    for (const s of parsePathData(part)) {
      if ('x' in s && 'y' in s) { cx = s.x; cy = s.y }
      else if ('x' in s) { cx = s.x }
      else if ('y' in s) { cy = s.y }
      switch (s.cmd) {
        case 'H': out.push(`L${f(cx)},${f(cy)}`); break
        case 'V': out.push(`L${f(cx)},${f(cy)}`); break
        default: out.push(segStr(s))
      }
    }
  }
  return out.join('')
  function f(n: number): string { return Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000) }
  function segStr(s: ReturnType<typeof parsePathData>[number]): string {
    switch (s.cmd) {
      case 'M': case 'L': return `${s.cmd}${f(s.x)},${f(s.y)}`
      case 'C': return `C${f(s.c1x)},${f(s.c1y)},${f(s.c2x)},${f(s.c2y)},${f(s.x)},${f(s.y)}`
      case 'A': return `A${f(s.rx)},${f(s.ry)},${f(s.rot)},${s.large},${s.sweep},${f(s.x)},${f(s.y)}`
      case 'Q': return `Q${f(s.cx)},${f(s.cy)},${f(s.x)},${f(s.y)}`
      case 'S': return `S${f(s.c2x)},${f(s.c2y)},${f(s.x)},${f(s.y)}`
      case 'T': return `T${f(s.x)},${f(s.y)}`
      case 'Z': return 'Z'
      default: return ''
    }
  }
}

function countMap(records: DrawRecord[]): Map<string, number> {
  const map = new Map<string, number>()
  for (const r of records) {
    const key = `${r.kind}|${expandPath(r.path)}|${r.paint}`
    map.set(key, (map.get(key) ?? 0) + 1)
  }
  return map
}

/**
 * Two path keys that are the same drawing: the same commands and paint, every number within `rounding`. Only SYMBOLS are painted on
 * a canvas from unrounded numbers (as vega does), so only a symbol's coordinates, rounded here to 3 decimals, may land one step
 * (0.001) from the SVG's, which is serialised at 3 decimals. Every other mark is compared with rounding 0: exactly.
 */
const SYMBOL_ROUNDING = 0.0011
function sameDrawing(a: string, b: string, rounding: number): boolean {
  const num = /-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/g
  if (a.replace(num, '#') !== b.replace(num, '#')) return false
  const xs = a.match(num) ?? []
  const ys = b.match(num) ?? []
  return xs.length === ys.length && xs.every((x, i) => Math.abs(Number(x) - Number(ys[i])) <= rounding)
}

/**
 * A circle is two half-turn arcs in an SVG path, and on the canvas one full-turn arc about its centre (a symbol, as vega draws it) or
 * two half turns (a guide's): the same curve. Both are written as the recorder writes a full turn (`M<x+r>,<y>` then `CIRC`).
 */
function circleAsOneTurn(r: DrawRecord): DrawRecord {
  const m = /^M(-?[\d.]+),(-?[\d.]+)A([\d.]+),\3,0,1,1,(-?[\d.]+),\2A\3,\3,0,1,1,\1,\2$/.exec(r.path)
  if (m === null) return r
  const cx = Number(m[1]) - Number(m[3])
  return { ...r, path: `M${m[1]},${m[2]}CIRC(${String(Math.round(cx * 1000) / 1000)},${m[2]},${m[3]})` }
}

/**
 * A circle inside a path (a point of a geo path, `geopath`'s `pointRadius`): the SVG writes it as two half-turn arcs from the point
 * below the centre, the canvas traces the same two arcs as four cubic curves. Both are read as the circle they draw, with the point
 * it starts at and the way round it goes: `O(x,y,r,sweep)`. A curve that is not that circle (a control point off the four-curve
 * approximation of a quarter turn by more than a thousandth of the radius) is left as it is, so it shows as a difference.
 */
function circlesInPath(path: string): string {
  const n = '(-?\\d+(?:\\.\\d+)?(?:e[-+]?\\d+)?)'
  const arcs = new RegExp(`M${n},${n}A${n},\\3,0,1,([01]),${n},${n}A\\3,\\3,0,1,\\4,\\1,\\2Z?`, 'g')
  const curves = new RegExp(`M${n},${n}${`C${n},${n},${n},${n},${n},${n}`.repeat(4)}Z`, 'g')
  const r3 = (v: number): string => fmtN(Math.round(v * 1000) / 1000)
  return path
    .replace(arcs, (m, sx: string, sy: string, r: string, sweep: string) => `O(${sx},${sy},${r},${sweep})`)
    .replace(curves, (m, ...g: string[]) => {
      const v = g.slice(0, 26).map(Number)
      const [sx, sy] = [v[0]!, v[1]!]
      const end = (i: number): [number, number] => [v[2 + 6 * i + 4]!, v[2 + 6 * i + 5]!]
      const [ox, oy] = end(1) // the opposite point of the circle
      const cx = (sx + ox) / 2
      const cy = (sy + oy) / 2
      const r = Math.hypot(sx - ox, sy - oy) / 2
      const tol = 1e-3 * Math.max(1, r)
      const k = 0.5522847498 * r
      // the four quarter turns: each ends a quarter of the way round, with its controls a kappa along the tangents
      const sweep = (sx - cx) * (end(0)[1] - cy) - (sy - cy) * (end(0)[0] - cx) > 0 ? 1 : 0
      const quarter = (i: number): [number, number, number, number, number, number] => {
        const a0 = Math.atan2(sy - cy, sx - cx) + (sweep ? 1 : -1) * (Math.PI / 2) * i
        const a1 = a0 + (sweep ? 1 : -1) * (Math.PI / 2)
        const t = sweep ? 1 : -1
        return [cx + r * Math.cos(a0) - t * k * Math.sin(a0), cy + r * Math.sin(a0) + t * k * Math.cos(a0), cx + r * Math.cos(a1) + t * k * Math.sin(a1), cy + r * Math.sin(a1) - t * k * Math.cos(a1), cx + r * Math.cos(a1), cy + r * Math.sin(a1)]
      }
      for (let i = 0; i < 4; i++) {
        const want = quarter(i)
        for (let j = 0; j < 6; j++) if (Math.abs(v[2 + 6 * i + j]! - want[j]!) > tol) return m
      }
      return `O(${r3(sx)},${r3(sy)},${r3(r)},${sweep})`
    })
}

function diffRecords(svg: DrawRecord[], b: DrawRecord[], rounding = 0): string[] {
  const norm = (r: DrawRecord): DrawRecord => { const c = circleAsOneTurn(r); return { ...c, path: circlesInPath(c.path) } }
  const a = svg.map(norm)
  const ma = countMap(a)
  const mb = countMap(b.map(norm))
  const onlyA: Array<[string, number]> = []
  const onlyB: Array<[string, number]> = []
  for (const [k, v] of ma) {
    const vb = mb.get(k) ?? 0
    if (vb < v) onlyA.push([k, v - vb])
  }
  for (const [k, v] of mb) {
    const va = ma.get(k) ?? 0
    if (va < v) onlyB.push([k, v - va])
  }
  // what is left on both sides may be the same drawing rounded differently: pair those up, one for one
  for (const ea of onlyA) {
    for (const eb of onlyB) {
      while (ea[1] > 0 && eb[1] > 0 && sameDrawing(ea[0], eb[0], rounding)) { ea[1]--; eb[1]-- }
    }
  }
  const diffs: string[] = []
  for (const [k, v] of onlyA) if (v > 0) diffs.push(`svg-only (${v}): ${k}`)
  for (const [k, v] of onlyB) if (v > 0) diffs.push(`canvas-only (${v}): ${k}`)
  return diffs
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sceneOf(vg: unknown): SceneRoot {
  return evaluateChart(compileChart(vg as never), {})
}

function canvasRecords(scene: SceneRoot): { records: DrawRecord[] } {
  const { ctx, records } = makeRecordingCtx()
  renderSceneToCanvas(scene, ctx, { batchSymbols: false })
  return { records }
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

describe('parsePathData / canonicalPath', () => {
  it('parses absolute and relative commands', () => {
    const segs = parsePathData('M0,0h47v163h-49Z')
    expect(canonicalPath(segs)).toBe('M0,0H47V163H-2Z')
  })

  it('carries the current point across relative H/V commands', () => {
    // Rect paths are M…h…v…h…Z; a V relative to an H must add to the previous
    // y, not reset it to 0 (this made every rect paint from y-height).
    const segs = parsePathData('M5,10h10v20h-10Z')
    expect(canonicalPath(segs)).toBe('M5,10H15V30H5Z')
    expect(canonicalPath(parsePathData('M0,0v10h10v-5Z'))).toBe('M0,0V10H10V5Z')
  })

  it('parses arc commands', () => {
    const segs = parsePathData('M1,0A1,1,0,1,1,-1,0A1,1,0,1,1,1,0')
    expect(segs.length).toBe(3)
    expect(canonicalPath(segs)).toBe('M1,0A1,1,0,1,1,-1,0A1,1,0,1,1,1,0')
  })

  it('parses cubic curves and implicit lineto after M', () => {
    const segs = parsePathData('M0,0C1,2,3,4,5,6 7,8 9,10 11,12')
    expect(canonicalPath(segs)).toBe('M0,0C1,2,3,4,5,6C7,8,9,10,11,12')
  })
})

describe('renderSceneToCanvas', () => {
  it('renders a bar chart with matching geometry and paint', () => {
    const vg = {
      $schema: 'https://vega.github.io/schema/vega/v5.json',
      width: 100,
      height: 100,
      data: [{ name: 'table', values: [{ x: 'a', y: 5 }, { x: 'b', y: 3 }] }],
      scales: [
        { name: 'x', type: 'band', domain: { data: 'table', field: 'x' }, range: 'width' },
        { name: 'y', type: 'linear', domain: { data: 'table', field: 'y' }, range: [100, 0] },
      ],
      axes: [{ orient: 'bottom', scale: 'x' }],
      marks: [{
        type: 'rect',
        from: { data: 'table' },
        encode: {
          enter: { x: { scale: 'x', field: 'x' }, width: { scale: 'x', band: 1 }, y: { scale: 'y', field: 'y' }, y2: { scale: 'y', value: 0 }, fill: { value: '#4c78a8' } },
        },
      }],
    }
    const scene = sceneOf(vg)
    const svg = renderSceneToSvg(scene)
    const { records } = canvasRecords(scene)
    const diffs = diffRecords(svgRecords(svg), records)
    expect(diffs).toEqual([])
  })

  it('renders line, symbol, text, rule and rect marks with parity', () => {
    const scene: SceneRoot = {
      width: 200,
      height: 100,
      padding: { top: 0, right: 0, bottom: 0, left: 0 },
      items: [
        {
          marktype: 'group',
          items: [
            {
              marktype: 'rect',
              items: [
                { x: 0, y: 10, width: 40, height: 90, fill: '#4c78a8' },
                { x: 50, y: 30, width: 40, height: 70, fill: '#e45756', opacity: 0.5 },
              ],
            },
            {
              marktype: 'line',
              items: [
                { x: 0, y: 10 }, { x: 50, y: 40 }, { x: 100, y: 20 },
              ],
            },
            {
              marktype: 'symbol',
              items: [
                { x: 10, y: 90, size: 100, fill: 'transparent', stroke: '#4c78a8', strokeWidth: 2 },
                { x: 30, y: 70, size: 49, shape: 'square', fill: '#54a24b', stroke: undefined },
              ],
            },
            {
              marktype: 'text',
              items: [
                { x: 100, y: 10, text: 'hello', align: 'center', fontSize: 12, fill: '#000' },
                { x: 100, y: 30, text: 'bold', baseline: 'middle', fontWeight: 'bold', fill: '#333' },
              ],
            },
            {
              marktype: 'rule',
              items: [{ x: 0, y: 99.5, x2: 200, y2: 99.5, stroke: '#888', strokeWidth: 1 }],
            },
          ],
        },
      ],
    } as unknown as SceneRoot
    const svg = renderSceneToSvg(scene)
    const { records } = canvasRecords(scene)
    const diffs = diffRecords(svgRecords(svg), records)
    if (diffs.length) console.log(diffs.join('\n'))
    expect(diffs).toEqual([])
  })

  it('applies group translates and clips: a clipped group and a clipped mark each clip once, to the frame the SVG clips to', () => {
    const spec = (mark: unknown): unknown => ({
      $schema: 'https://vega.github.io/schema/vega/v5.json', width: 100, height: 100, padding: 0, autosize: 'none', marks: [mark],
    })
    const overflow = { type: 'rect', encode: { enter: { x: { value: 0 }, y: { value: 0 }, width: { value: 200 }, height: { value: 200 }, fill: { value: '#f00' } } } }
    // a group that is clipped to its own 40 x 30 box, at (10, 20); a mark clipped to the 100 x 100 frame of the group around it
    const clippedGroup = spec({ type: 'group', encode: { enter: { x: { value: 10 }, y: { value: 20 }, width: { value: 40 }, height: { value: 30 }, clip: { value: true } } }, marks: [overflow] })
    const clippedMark = spec({ type: 'group', encode: { enter: { x: { value: 10 }, y: { value: 20 }, width: { value: 100 }, height: { value: 100 } } }, marks: [{ ...overflow, clip: true }] })
    for (const [name, vg, clip] of [['group', clippedGroup, 'M10,20h40v30h-40Z'], ['mark', clippedMark, 'M10,20h100v100h-100Z']] as const) {
      const scene = sceneOf(vg)
      const sides = [svgRecords(renderSceneToSvg(scene)), canvasRecords(scene).records]
      for (const records of sides) expect(records.filter((r) => r.kind === 'clip').map((r) => r.path), name).toEqual([clip])
      expect(diffRecords(sides[0]!, sides[1]!), name).toEqual([])
    }
  })

  describe('the comparison sees every difference of a paint (a scene compared with one that paints otherwise is not equal)', () => {
    const one = (marktype: string, item: Record<string, unknown>): SceneRoot =>
      ({ width: 100, height: 100, padding: { top: 0, right: 0, bottom: 0, left: 0 }, items: [{ marktype, items: [item] }] }) as unknown as SceneRoot
    const path = (extra: Record<string, unknown> = {}): SceneRoot => one('path', { x: 10, y: 10, path: 'M0,0L10,10L0,10Z', fill: '#f00', stroke: '#000', strokeWidth: 2, strokeDash: [2, 1], ...extra })
    const symbol = (extra: Record<string, unknown> = {}): SceneRoot => one('symbol', { x: 20, y: 20, size: 200, shape: 'square', fill: '#f00', stroke: '#000', ...extra })
    const text = (extra: Record<string, unknown> = {}): SceneRoot => one('text', { x: 20, y: 20, text: 'hi', fontSize: 12, fill: '#000', ...extra })
    const bitmap = { width: 20, height: 20, complete: true, src: 'a.png' }
    const image = (extra: Record<string, unknown> = {}): SceneRoot => one('image', { x: 5, y: 5, width: 20, height: 20, image: bitmap, ...extra })
    const clipped = (clip: boolean): SceneRoot => ({
      width: 100, height: 100, items: [{ marktype: 'rect', clip, markClip: clip, items: [{ x: 0, y: 0, width: 50, height: 50, fill: '#f00' }] }],
    }) as unknown as SceneRoot
    const PAIRS: Array<[string, SceneRoot, SceneRoot]> = [
      ['path angle', path({ angle: 0 }), path({ angle: 40 })],
      ['symbol angle', symbol({ angle: 0 }), symbol({ angle: 40 })],
      ['stroke cap', path({ strokeCap: 'butt' }), path({ strokeCap: 'round' })],
      ['stroke join', path({ strokeJoin: 'miter' }), path({ strokeJoin: 'bevel' })],
      ['miter limit', path({ strokeMiterLimit: 4 }), path({ strokeMiterLimit: 2 })],
      ['dash offset', path({ strokeDashOffset: 0 }), path({ strokeDashOffset: 3 })],
      ['blend', path({}), path({ blend: 'multiply' })],
      ['text stroke', text({}), text({ stroke: '#f00' })],
      ['text angle', text({ angle: 0 }), text({ angle: 30 })],
      ['text blend', text({}), text({ blend: 'multiply' })],
      ['image present', image(), one('image', { x: 5, y: 5, width: 20, height: 20 })],
      ['image position', image(), image({ x: 6 })],
      ['mark clip', clipped(true), clipped(false)],
      // the controls: what the comparison has always seen
      ['control: fill colour', path({ fill: '#f00' }), path({ fill: '#0f0' })],
      ['control: stroke width', path({ strokeWidth: 2 }), path({ strokeWidth: 3 })],
    ]
    it.each(PAIRS)('%s', (_name, a, b) => {
      const svgA = svgRecords(renderSceneToSvg(a))
      const canvasA = canvasRecords(a).records
      const canvasB = canvasRecords(b).records
      const svgB = svgRecords(renderSceneToSvg(b))
      expect(svgA.length + canvasA.length, 'the scene painted something').toBeGreaterThan(0)
      // each scene is the same as itself (the SVG of A is what the canvas paints for A, and B's for B: a correct rotated symbol
      // is not a difference) ...
      expect(diffRecords(svgA, canvasA, SYMBOL_ROUNDING)).toEqual([])
      expect(diffRecords(svgB, canvasB, SYMBOL_ROUNDING)).toEqual([])
      // ... and the SVG of A is not what the canvas paints for B
      expect(diffRecords(svgA, canvasB, SYMBOL_ROUNDING).length).toBeGreaterThan(0)
    })
  })

  it('skips unpainted rect items like the SVG renderer', () => {
    const scene: SceneRoot = {
      width: 100,
      height: 100,
      items: [{ marktype: 'rect', items: [{ x: 0, y: 0, width: 10, height: 10 }] }],
    } as unknown as SceneRoot
    const { records } = canvasRecords(scene)
    expect(records.filter((r) => r.kind !== 'text')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Corpus parity: vega + vega-lite corpus scenes rendered through both
// backends must produce identical draw records.
// ---------------------------------------------------------------------------

const CORPUS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../conformance/corpus')

function corpusVegaNames(): string[] {
  try {
    return readdirSync(CORPUS_DIR).filter((f) => f.endsWith('.vg.json'))
  } catch {
    return []
  }
}

describe('incremental canvas append', () => {
  it('paints only appended items and falls back when old items changed', () => {
    const mark: SceneGroup = {
      marktype: 'symbol', role: 'mark',
      items: [{ x: 10, y: 10, size: 100, fill: '#4c78a8', __gen: 1 } as SceneItem],
    }
    const scene: SceneRoot = { width: 100, height: 100, items: [mark] } as SceneRoot
    ;(scene as unknown as { __itemGen: number }).__itemGen = 1
    const snap = snapshotCanvasScene(scene)
    ;(mark.items as SceneItem[]).push({ x: 20, y: 20, size: 100, fill: '#4c78a8', __gen: 2 } as SceneItem)
    ;(scene as unknown as { __itemGen: number }).__itemGen = 2
    const first = makeRecordingCtx()
    expect(renderSceneToCanvasAppend(snap, scene, first.ctx)).toBe(true)
    expect(first.records.filter((r) => r.kind === 'fill')).toHaveLength(1)

    // A changed old item invalidates the append fast path.
    const prev2 = snapshotCanvasScene(scene)
    ;(mark.items as SceneItem[])[0] = { x: 11, y: 11, size: 100, fill: '#f58518', __gen: 3 } as SceneItem
    ;(mark.items as SceneItem[]).push({ x: 30, y: 30, size: 100, fill: '#4c78a8', __gen: 3 } as SceneItem)
    ;(scene as unknown as { __itemGen: number }).__itemGen = 3
    const second = makeRecordingCtx()
    expect(renderSceneToCanvasAppend(prev2, scene, second.ctx)).toBe(false)
  })
})

describe('the record comparison', () => {
  const rec = (path: string): DrawRecord[] => [{ kind: 'fill', path, paint: 'red' }]
  it('accepts the 3-decimal rounding of a coordinate only when asked to, and nothing larger', () => {
    expect(diffRecords(rec('M217.977,15A4.153,4.153,0,1,1,209.671,15'), rec('M217.977,15A4.153,4.153,0,1,1,209.67,15'), SYMBOL_ROUNDING)).toEqual([])
    expect(diffRecords(rec('M217.977,15A4.153,4.153,0,1,1,209.671,15'), rec('M217.977,15A4.153,4.153,0,1,1,209.67,15'))).toHaveLength(2)
    expect(diffRecords(rec('M217.977,15A4.153,4.153,0,1,1,209.671,15'), rec('M217.977,15A4.153,4.153,0,1,1,209.66,15'), SYMBOL_ROUNDING)).toHaveLength(2)
    expect(diffRecords(rec('M1,2L3,4'), rec('M1,2L3,4L5,6'))).toHaveLength(2)
    expect(diffRecords(rec('M1,2L3,4'), [{ kind: 'fill', path: 'M1,2L3,4', paint: 'blue' }])).toHaveLength(2)
  })
  it('pairs rounded drawings one for one', () => {
    expect(diffRecords([...rec('M1,2L3,4'), ...rec('M1,2L3,4')], [...rec('M1.001,2L3,4'), ...rec('M1,2L3,4')], SYMBOL_ROUNDING)).toEqual([])
    expect(diffRecords([...rec('M1,2L3,4'), ...rec('M1,2L3,4')], rec('M1.001,2L3,4'), SYMBOL_ROUNDING)).toHaveLength(1)
  })
})

/** The scene with only the symbol marks (or only the other marks) left: a copy, the marks it drops emptied; groups stay, so positions do. */
function only(scene: SceneRoot, symbols: boolean): SceneRoot {
  const mark = (m: SceneGroup): SceneGroup => {
    const nested = (m.items ?? []).some((g) => Array.isArray((g as { items?: unknown }).items) && ((g as { items: SceneGroup[] }).items).every((c) => c && typeof c.marktype === 'string'))
    // (a guide group - axis, legend, title - holds its parts as flat items and has no symbols)
    if (m.marktype === 'group' && !nested) return symbols ? { ...m, items: [] } : m
    if (m.marktype === 'group') {
      return {
        ...m,
        items: (m.items ?? []).map((g) => {
          const item = g as SceneItem & { items?: SceneGroup[] }
          return { ...item, ...(symbols ? { fill: undefined, stroke: undefined } : {}), ...(item.items ? { items: item.items.map(mark) } : {}) } as SceneItem
        }),
      }
    }
    // (a shape mark of points draws circles from unrounded numbers as a symbol does)
    return (m.marktype === 'symbol' || m.marktype === 'shape') === symbols ? m : { ...m, items: [] }
  }
  return { ...scene, items: (scene.items as SceneGroup[]).map(mark) } as SceneRoot
}

/**
 * Scenes with multi-line text are not compared: vega's own backends disagree (the SVG's tspans restart at x=0, the canvas continues
 * at the anchor x), and the browser canvas gate covers the single-line case. Each is checked to still hold what excuses it, so an
 * exclusion cannot outlive its reason.
 */
const MULTI_LINE = ['text-linebreak.vg.json', 'axis-label-list-value.vg.json']
/**
 * vega's SVG backend serialises a non-colour paint as fill="false" (which rasterises black); its canvas backend skips it. The SVG
 * conformance gate follows the SVG oracle; the browser canvas gate follows the canvas one.
 */
const NON_COLOUR_PAINT = ['expr-fns.vg.json']
/**
 * A path whose data holds an elliptical-arc command (`linkpath` with `shape: 'arc'`): the SVG writes the `A` command, the canvas traces
 * the arc as cubic curves, and this test's recorder compares commands, not the curves they draw. (The circle of a geo point has its own
 * reading above.) The pixels are compared in Chromium by `pnpm conformance:canvas`, where this spec passes.
 */
const ARC_PATH = ['tree-links-shapes.vg.json']

describe('canvas/svg corpus parity (the vega corpus; the Vega-Lite corpus is compiled by @aster-charts/vl, which core does not import: the Chromium gates compare its scenes)', () => {
  it('matches across the vega corpus, every scene of it compared but the named ones', () => {
    const names = corpusVegaNames()
    expect(names.length).toBeGreaterThan(380)
    const compared: string[] = []
    const failures: Array<[string, string[]]> = []
    const unloadable: string[] = []
    const excluded = new Set([...MULTI_LINE, ...NON_COLOUR_PAINT, ...ARC_PATH])
    for (const name of names) {
      const doc = JSON.parse(readFileSync(join(CORPUS_DIR, name), 'utf8'))
      const spec = doc.spec ?? doc
      let scene: SceneRoot
      try {
        scene = sceneOf(spec)
      } catch (e) {
        // a spec whose data is a URL has no data to draw here (the conformance suite loads it); any other throw is a failure
        if (/no data was loaded/.test((e as Error).message)) { unloadable.push(name); continue }
        failures.push([name, ['threw: ' + (e as Error).message]])
        continue
      }
      const svg = renderSceneToSvg(scene)
      if (MULTI_LINE.includes(name) && !svg.includes('<tspan')) failures.push([name, ['excluded for multi-line text, and has none']])
      if (NON_COLOUR_PAINT.includes(name) && !svg.includes('fill="false"')) failures.push([name, ['excluded for a non-colour paint, and has none']])
      if (ARC_PATH.includes(name) && !/ d="[^"]*A[\d.]/.test(svg)) failures.push([name, ['excluded for an arc command, and has none']])
      if (excluded.has(name)) continue
      let diffs: string[]
      try {
        // symbols apart from every other mark: the others are compared exactly, the symbols to the SVG's own rounding
        // (a corpus image has no bitmap on the canvas: the host loads it, and the SVG writes it either way)
        const rest = only(scene, false)
        const symbols = only(scene, true)
        diffs = [
          ...diffRecords(svgRecords(renderSceneToSvg(rest), { images: false }), canvasRecords(rest).records, 0).map((d) => 'rest ' + d),
          ...diffRecords(svgRecords(renderSceneToSvg(symbols), { images: false }), canvasRecords(symbols).records, SYMBOL_ROUNDING),
        ]
      } catch (e) {
        failures.push([name, ['render threw: ' + (e as Error).message]])
        continue
      }
      if (diffs.length === 0) compared.push(name)
      else failures.push([name, diffs.slice(0, 4)])
    }
    if (failures.length) {
      console.error(`canvas parity: ${compared.length}/${names.length}; failures:`)
      for (const [name, diffs] of failures.slice(0, 8)) console.error(' ', name, diffs)
    }
    expect(failures).toEqual([])
    // every spec is accounted for: compared, excluded for a named reason, or without its data (the two url datasets)
    expect(compared.length + excluded.size + unloadable.length).toBe(names.length)
    expect(unloadable).toEqual(['data-url-csv.vg.json', 'data-url-signal.vg.json'])
    expect(compared.length).toBeGreaterThanOrEqual(385)
  })
})
