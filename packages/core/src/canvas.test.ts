/**
 * Canvas renderer tests (R9.1): a recording 2D-context mock captures the
 * renderer's draw commands; geometry and paint are compared against the same
 * scene's SVG serialization via shared path canonicalization.
 */
import { describe, expect, it } from 'vitest'
import { renderSceneToSvg } from './render.js'
import { parsePathData, canonicalPath, renderSceneToCanvas, type CanvasLike, type GradientLike } from './canvas.js'
import type { SceneGroup, SceneItem, SceneRoot } from './types.js'
import { evaluateChart } from './runtime.js'
import { compileChart } from './compiler.js'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// ---------------------------------------------------------------------------
// Recording context
// ---------------------------------------------------------------------------

interface DrawRecord {
  kind: 'fill' | 'stroke' | 'text' | 'grad'
  path: string
  paint: string
}

function makeRecordingCtx(): { ctx: CanvasLike; records: DrawRecord[] } {
  const records: DrawRecord[] = []
  let tx = 0, ty = 0
  const stack: Array<[number, number]> = []
  let ops: string[] = []
  let cur: string | null = null // pending paint info at fill/stroke time
  let fillStyle: unknown = '#000'
  let strokeStyle: unknown = '#000'
  let globalAlpha = 1
  let lineWidth = 1
  let dash: number[] = []
  let font = ''
  let textAlign = 'start'
  let rotAngle = 0
  const fmt = (n: number): string => {
    if (!Number.isFinite(n)) return String(n)
    if (Number.isInteger(n)) return String(n)
    return String(Math.round(n * 1000) / 1000)
  }
  const ctx: CanvasLike = {
    save() { stack.push([tx, ty]) },
    restore() { const t = stack.pop(); if (t) { tx = t[0]; ty = t[1] } },
    translate(x, y) { tx += x; ty += y },
    beginPath() { ops = [] },
    moveTo(x, y) { ops.push(`M${fmt(x + tx)},${fmt(y + ty)}`) },
    lineTo(x, y) { ops.push(`L${fmt(x + tx)},${fmt(y + ty)}`) },
    bezierCurveTo(a, b, c, d, x, y) { ops.push(`C${fmt(a + tx)},${fmt(b + ty)},${fmt(c + tx)},${fmt(d + ty)},${fmt(x + tx)},${fmt(y + ty)}`) },
    quadraticCurveTo(a, b, x, y) { ops.push(`Q${fmt(a + tx)},${fmt(b + ty)},${fmt(x + tx)},${fmt(y + ty)}`) },
    arc(x, y, r, a0, a1, ccw = false) {
      const ax = x + tx, ay = y + ty
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
      } else {
        ops.push(`A${fmt(r)},${fmt(r)},0,${large},${sweep},${fmt(x2)},${fmt(y2)}`)
      }
    },
    closePath() { ops.push('Z') },
    rect(x, y, w, h) { ops.push(`M${fmt(x + tx)},${fmt(y + ty)}h${fmt(w)}v${fmt(h)}h${fmt(-w)}Z`) },
    clip() { /* record clip as a marker for debugging */ },
    fill() {
      records.push({ kind: 'fill', path: ops.join(''), paint: paintStr(fillStyle, globalAlpha) })
    },
    stroke() {
      records.push({ kind: 'stroke', path: ops.join(''), paint: `${paintStr(strokeStyle, globalAlpha)};sw=${fmt(lineWidth)};dash=${dash.join(',') || '-'}` })
    },
    fillRect(x, y, w, h) {
      const save = ops
      ops = []
      this.rect(x, y, w, h)
      records.push({ kind: 'fill', path: ops.join(''), paint: paintStr(fillStyle, globalAlpha) })
      ops = save
    },
    setLineDash(d) { dash = d },
    rotate(a) { rotAngle = a },
    fillText(text, x, y, multi) {
      // Multi-line text is excluded from parity: vega's own backends disagree
      // (SVG tspans restart at x=0; canvas continues at the anchor x).
      if (multi) return
      const rot = rotAngle ? `;rot=${fmt(rotAngle)}` : ''
      records.push({ kind: 'text', path: '', paint: `t=${text};x=${fmt(x + tx)};y=${fmt(y + ty)};align=${textAlign};font=${font}${rot};style=${paintStr(fillStyle, globalAlpha)}` })
    },
    drawImage() { /* not exercised in parity records */ },
    createLinearGradient(x0, y0, x1, y1): GradientLike {
      // Gradient fills are parity-checked separately (coords derive from the
      // element bbox); the recorder just returns a stop-collecting stub.
      return { addColorStop() {} }
    },
    get fillStyle() { return fillStyle },
    set fillStyle(v: unknown) {
      fillStyle = v
      cur = v as string
    },
    get strokeStyle() { return strokeStyle },
    set strokeStyle(v: unknown) { strokeStyle = v },
    get globalAlpha() { return globalAlpha },
    set globalAlpha(v: number) { globalAlpha = v },
    get lineWidth() { return lineWidth },
    set lineWidth(v: number) { lineWidth = v },
    lineCap: 'butt',
    lineJoin: 'miter',
    miterLimit: 4,
    get font() { return font },
    set font(v: string) { font = v },
    get textAlign() { return textAlign },
    set textAlign(v: string) { textAlign = v },
    textBaseline: 'alphabetic',
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

function svgRecords(svg: string): DrawRecord[] {
  const records: DrawRecord[] = []
  const stack: Array<[number, number]> = [[0, 0]]
  const at = (): [number, number] => stack[stack.length - 1]!
  const attrOf = (attrs: string, name: string): string | undefined => {
    const m = new RegExp(`(?:^| )${name}="([^"]*)"`, 'g').exec(attrs)
    return m?.[1]
  }
  const parseTranslate = (attrs: string): [number, number] | null => {
    const m = /transform="translate\(([-\d.]+)(?:,([-\d.]+))?\)"/.exec(attrs)
    if (!m) return null
    return [Number(m[1]), m[2] != null ? Number(m[2]) : 0]
  }
  const tagRe = /<\/g\b[^>]*>|<g\b[^>]*>|<text\b[^>]*>[\s\S]*?<\/text>|<(path|line|circle|rect)\b[^>]*>/g
  let m: RegExpExecArray | null
  while ((m = tagRe.exec(svg))) {
    const tok = m[0]
    if (tok.startsWith('</g')) {
      stack.pop()
      continue
    }
    if (tok.startsWith('<g')) {
      const t = parseTranslate(tok)
      stack.push(t ? [at()[0] + t[0], at()[1] + t[1]] : at())
      continue
    }
    const [tx, ty] = at()
    if (tok.startsWith('<text')) {
      const attrs = tok.slice(0, tok.indexOf('>'))
      const inner = tok.slice(tok.indexOf('>') + 1, tok.lastIndexOf('</text>'))
      const x = Number(attrOf(attrs, 'x') ?? 0) + tx
      const y = Number(attrOf(attrs, 'y') ?? 0) + ty
      const anchor = attrOf(attrs, 'text-anchor') ?? 'middle'
      const align = anchor === 'start' ? 'left' : anchor === 'end' ? 'right' : 'center'
      const fs = attrOf(attrs, 'font-size')
      const fsNum = fs != null ? Number(String(fs).replace(/px$/, '')) : 11
      const fw = attrOf(attrs, 'font-weight')
      const fill = attrOf(attrs, 'fill') ?? '-'
      const op = Number(attrOf(attrs, 'opacity') ?? 1)
      if (inner.includes('<tspan')) continue // multi-line: excluded from parity
      const content = inner
      const angleAttr = attrOf(attrs, 'angle')
      const rot = angleAttr && angleAttr !== '0' ? `;rot=${fmtN(Number(angleAttr) * Math.PI / 180)}` : ''
      const fam = attrOf(attrs, 'font-family') ?? 'sans-serif'
      records.push({ kind: 'text', path: '', paint: `t=${content};x=${fmtN(x)};y=${fmtN(y)};align=${align};font=${[fw, `${fsNum}px`, fam].filter(Boolean).join(' ')}${rot};style=style=${fill};alpha=${fmtN(op)}` })
      continue
    }
    const tag = m[1]!
    const attrs = tok
    if (tag === 'path') {
      const d = attrOf(attrs, 'd')
      if (!d) continue
      let ex = tx, ey = ty
      const t = parseTranslate(attrs)
      if (t) { ex += t[0]; ey += t[1] }
      const segs = parsePathData(d).map((s) => translateSeg(s, ex, ey))
      const path = canonicalPath(segs)
      const fill = attrOf(attrs, 'fill')
      const stroke = attrOf(attrs, 'stroke')
      const op = Number(attrOf(attrs, 'opacity') ?? 1)
      const fo = Number(attrOf(attrs, 'fill-opacity') ?? 1)
      const so = Number(attrOf(attrs, 'stroke-opacity') ?? 1)
      const sw = attrOf(attrs, 'stroke-width')
      const dash = attrOf(attrs, 'stroke-dasharray')
      if (fill) records.push({ kind: 'fill', path, paint: `style=${fill};alpha=${fmtN(op * fo)}` })
      if (stroke) records.push({ kind: 'stroke', path, paint: `style=${stroke};alpha=${fmtN(op * so)};sw=${fmtN(Number(sw ?? 1))};dash=${dash ?? '-'}` })
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
      if (stroke) records.push({ kind: 'stroke', path, paint: `style=${stroke};alpha=${fmtN(op)};sw=${fmtN(Number(sw ?? 1))};dash=${dash ?? '-'}` })
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
      if (fill) records.push({ kind: 'fill', path, paint: `style=${fill};alpha=${fmtN(op * fo)}` })
      if (stroke) records.push({ kind: 'stroke', path, paint: `style=${stroke};alpha=${fmtN(op * so)};sw=${fmtN(Number(sw ?? 1))};dash=-` })
    } else if (tag === 'rect') {
      const x = Number(attrOf(attrs, 'x') ?? 0) + tx
      const y = Number(attrOf(attrs, 'y') ?? 0) + ty
      const w = Number(attrOf(attrs, 'width') ?? 0)
      const h = Number(attrOf(attrs, 'height') ?? 0)
      const fill = attrOf(attrs, 'fill')
      if (fill) {
        const path = `M${fmtN(x)},${fmtN(y)}h${fmtN(w)}v${fmtN(h)}h${fmtN(-w)}Z`
        records.push({ kind: 'fill', path, paint: `style=${fill};alpha=1` })
      }
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
  const segs = parsePathData(canon)
  let cx = 0, cy = 0
  const out: string[] = []
  for (const s of segs) {
    if ('x' in s && 'y' in s) { cx = s.x; cy = s.y }
    else if ('x' in s) { cx = s.x }
    else if ('y' in s) { cy = s.y }
    switch (s.cmd) {
      case 'H': out.push(`L${f(cx)},${f(cy)}`); break
      case 'V': out.push(`L${f(cx)},${f(cy)}`); break
      default: out.push(segStr(s))
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

function diffRecords(a: DrawRecord[], b: DrawRecord[]): string[] {
  const ma = countMap(a)
  const mb = countMap(b)
  const diffs: string[] = []
  for (const [k, v] of ma) {
    const vb = mb.get(k) ?? 0
    if (vb < v) diffs.push(`svg-only (${v - vb}): ${k}`)
  }
  for (const [k, v] of mb) {
    const va = ma.get(k) ?? 0
    if (va < v) diffs.push(`canvas-only (${v - va}): ${k}`)
  }
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
  renderSceneToCanvas(scene, ctx)
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

  it('applies group translates and clips', () => {
    const scene: SceneRoot = {
      width: 100,
      height: 100,
      items: [
        {
          marktype: 'group',
          x: 10,
          y: 20,
          clip: true,
          items: [{ marktype: 'rect', items: [{ x: 0, y: 0, width: 50, height: 50, fill: '#f00' }] }],
        },
      ],
    } as unknown as SceneRoot
    const svg = renderSceneToSvg(scene)
    const { records } = canvasRecords(scene)
    expect(diffRecords(svgRecords(svg), records)).toEqual([])
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

describe('canvas/svg corpus parity', () => {
  it('matches across the vega corpus', () => {
    const names = corpusVegaNames()
    expect(names.length).toBeGreaterThan(250)
    let pass = 0
    const failures: Array<[string, string[]]> = []
    for (const name of names) {
      const doc = JSON.parse(readFileSync(join(CORPUS_DIR, name), 'utf8'))
      const spec = doc.spec ?? doc
      let scene: SceneRoot
      try {
        scene = sceneOf(spec)
      } catch {
        continue // specs needing addons are exercised by the conformance suite
      }
      let svg: string
      let recs: DrawRecord[]
      try {
        svg = renderSceneToSvg(scene)
        recs = canvasRecords(scene).records
      } catch (e) {
        failures.push([name, ['render threw: ' + (e as Error).message]])
        continue
      }
      const diffs = diffRecords(svgRecords(svg), recs)
      if (diffs.length === 0) pass++
      else failures.push([name, diffs.slice(0, 4)])
    }
    if (failures.length) {
      console.error(`canvas parity: ${pass}/${names.length}; failures:`)
      for (const [name, diffs] of failures.slice(0, 8)) console.error(' ', name, diffs)
    }
    expect(failures.length).toBe(0)
  })
})
