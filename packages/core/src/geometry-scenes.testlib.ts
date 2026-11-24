/**
 * Test-only (excluded from the published build): random hand-built scenes for the geometry differentials. They reach the
 * renderers without the evaluator's normalisation: NaN, infinities, -0, numeric strings, every curve, custom symbol paths,
 * rounded and clipped rects, arcs with corners and pads, rotated symbols, gradients, nested offset groups, legend-like leaves.
 */
import type { SceneGroup, SceneItem, SceneRoot } from './types.js'
import { int, pick } from './scene-fuzz.testlib.js'

type Rnd = () => number


const CURVES = ['linear', 'linear-closed', 'basis', 'basis-closed', 'basis-open', 'bundle', 'cardinal', 'cardinal-closed', 'cardinal-open',
  'catmull-rom', 'catmull-rom-closed', 'catmull-rom-open', 'monotone', 'monotone-x', 'monotone-y', 'natural', 'step', 'step-after', 'step-before', 'nonsense', undefined]
const SHAPES = ['circle', 'square', 'cross', 'diamond', 'triangle-up', 'triangle-down', 'triangle-right', 'triangle-left', 'stroke', 'arrow', 'wedge', 'triangle',
  undefined, 'M0,0L1,1L-1,1Z', 'M-1,-1h2v2h-2z', 'M -1 0 A 1 1 0 1 1 1 0 A 1 1 0 1 1 -1 0 Z', 'M0,-1C1,-1 1,1 0,1S-1,-1 0,-1Z', 'M-1,0Q0,-2 1,0T-1,0z', 'm0 0 l .5 .5 l -1 0 z']
const PATHS = ['M0,0L10,10L0,20Z', 'M5,5h10v10h-10z', 'M0,0 A 10 10 0 0 1 20 0 L 20 20 Z', 'M0,0C5,-10 15,-10 20,0S35,10 40,0', 'M0 0 Q10 10 20 0 T40 0', 'm1,1 l5,0 0,5 -5,0 z', '', 'M0,0']
const PAINTS = ['#4c78a8', 'red', 'rgba(0,0,0,0.5)', 'transparent', undefined, null, '']
const GRADIENT = { gradient: 'linear', x1: 0, y1: 0, x2: 1, y2: 1, stops: [{ offset: 0, color: 'red' }, { offset: 1, color: 'blue' }] }

/** Only finite numbers (set by `randomScene`). */
let tame = false

function wild(r: Rnd, scale: number): unknown {
  const p = tame ? 0.2 + 0.8 * r() : r()
  if (p < 0.025) return NaN
  if (p < 0.035) return Infinity
  if (p < 0.045) return -Infinity
  if (p < 0.06) return -0
  if (p < 0.07) return undefined
  if (p < 0.075) return null
  if (p < 0.08) return String(Math.round(r() * scale))
  if (p < 0.1) return Math.round(r() * scale)
  if (p < 0.12) return 1e-7 * r()
  return (r() - 0.1) * scale
}

function paint(r: Rnd): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (r() < 0.8) out.fill = r() < 0.06 ? GRADIENT : pick(r, PAINTS)
  if (r() < 0.6) out.stroke = r() < 0.04 ? GRADIENT : pick(r, PAINTS)
  if (r() < 0.5) out.strokeWidth = pick(r, [0, 0.5, 1, 2, 5, undefined, NaN])
  if (r() < 0.2) out.opacity = pick(r, [0, 0.5, 1])
  if (r() < 0.2) out.fillOpacity = r()
  if (r() < 0.1) out.strokeDash = [4, 2]
  if (r() < 0.1) out.strokeCap = 'round'
  return out
}

function randomItems(r: Rnd, type: string, n: number): SceneItem[] {
  const items: SceneItem[] = []
  const shared = paint(r)
  const interpolate = pick(r, CURVES)
  const tension = r() < 0.3 ? r() : undefined
  const orient = r() < 0.3 ? 'horizontal' : r() < 0.5 ? 'vertical' : undefined
  const shape = pick(r, SHAPES)
  const size = r() < 0.5 ? pick(r, [0, 1, 30, 64, 100, -4, NaN, undefined]) : undefined
  for (let i = 0; i < n; i++) {
    const it: Record<string, unknown> = { datum: { i } }
    switch (type) {
      case 'line':
      case 'area':
        Object.assign(it, i === 0 ? { ...shared, interpolate, tension, orient } : {})
        it.x = r() < 0.9 ? i * 7 + r() * 5 : wild(r, 300)
        it.y = wild(r, 200)
        if (type === 'area') { if (orient === 'horizontal') it.width = wild(r, 60); else it.height = wild(r, 60) }
        if (r() < 0.08) it.defined = false
        break
      case 'trail':
        Object.assign(it, i === 0 ? shared : {})
        it.x = i * 9 + r() * 4
        it.y = wild(r, 200)
        it.size = r() < 0.8 ? r() * 12 : wild(r, 20)
        if (r() < 0.1) it.defined = false
        break
      case 'arc':
        Object.assign(it, paint(r), { x: wild(r, 300), y: wild(r, 200) })
        it.outerRadius = wild(r, 80)
        if (r() < 0.6) it.innerRadius = wild(r, 40)
        it.startAngle = wild(r, 7)
        it.endAngle = wild(r, 7)
        if (r() < 0.3) it.cornerRadius = wild(r, 12)
        if (r() < 0.3) it.padAngle = wild(r, 0.2)
        if (r() < 0.2) it.angle = wild(r, 90)
        if (r() < 0.1) { delete it.outerRadius; it.radius = wild(r, 50) }
        break
      case 'rect':
        Object.assign(it, paint(r), { x: wild(r, 300), y: wild(r, 200), width: wild(r, 60), height: wild(r, 60) })
        if (r() < 0.25) it.cornerRadius = wild(r, 10)
        if (r() < 0.15) it.cornerRadiusTopLeft = wild(r, 10)
        if (r() < 0.15) it.cornerRadiusBottomRight = pick(r, [3, 0, 'round', undefined])
        if (r() < 0.1) it.clip = true
        break
      case 'symbol':
        // (a dense mark -- what the DOM batches -- is mostly one opaque paint, with a few odd ones out)
        if (n >= 512) Object.assign(it, r() < 0.92 ? { fill: '#4c78a8', stroke: r() < 0.5 ? '#000' : undefined } : paint(r), { x: wild(r, 300), y: wild(r, 200) })
        else Object.assign(it, i === 0 || r() < 0.3 ? paint(r) : shared, { x: wild(r, 300), y: wild(r, 200) })
        it.shape = r() < 0.85 ? shape : pick(r, SHAPES)
        it.size = r() < 0.7 ? size : wild(r, 200)
        if (r() < 0.1) it.angle = wild(r, 90)
        break
      case 'path':
      case 'shape':
        Object.assign(it, paint(r), { x: wild(r, 100), y: wild(r, 100), path: pick(r, PATHS) })
        if (r() < 0.2) it.scaleX = wild(r, 3)
        if (r() < 0.2) it.scaleY = wild(r, 3)
        if (r() < 0.2) it.angle = wild(r, 90)
        break
      case 'rule':
        Object.assign(it, paint(r), { x: wild(r, 300), y: wild(r, 200), x2: wild(r, 300), y2: wild(r, 200) })
        break
      case 'text':
        Object.assign(it, { x: wild(r, 300), y: wild(r, 200), text: pick(r, ['a', 'hello', '', 42]), fill: '#000', angle: r() < 0.3 ? 30 : undefined })
        break
    }
    items.push(it as SceneItem)
  }
  return items
}

const TYPES = ['line', 'area', 'trail', 'arc', 'rect', 'symbol', 'path', 'shape', 'rule', 'text']

/**
 * A random scene; `finite` keeps every number finite. The differential feeds the legacy `intersect()` only those: its copy walks
 * a non-finite arc without end (seed 112, box 1). The current `sceneIntersect` on the non-finite scenes is pinned on its own
 * (geometry-differential.test.ts, 'sceneIntersect on non-finite scenes').
 */
export function randomScene(r: Rnd, finite = false): SceneRoot {
  tame = finite
  const marks: SceneGroup[] = []
  const nMarks = int(r, 1, 6)
  for (let m = 0; m < nMarks; m++) {
    const type = pick(r, TYPES)
    const n = type === 'symbol' && r() < 0.25 ? (r() < 0.5 ? int(r, 256, 400) : int(r, 512, 700)) : int(r, 0, 30)
    const mark: SceneGroup = { marktype: type, role: 'mark', items: randomItems(r, type, n) } as SceneGroup
    if (r() < 0.15) mark.clip = true
    if (r() < 0.3) {
      // nested in a group item, offset
      marks.push({ marktype: 'group', role: 'scope', items: [{ x: wild(r, 40), y: wild(r, 40), width: 200, height: 150, items: [mark] } as unknown as SceneItem] } as SceneGroup)
    } else marks.push(mark)
  }
  if (r() < 0.3) {
    // legend-like leaves: path and symbol leaves in a plain group
    marks.push({ marktype: 'group', role: 'legend', items: [{ x: 10, y: 10, items: [
      { path: pick(r, PATHS), x: 3, y: 4, fill: 'red', stroke: '#000' },
      { shape: pick(r, SHAPES.filter((s) => s !== undefined)), radius: r() * 6, x: 20, y: 5, fill: 'blue' },
    ] } as unknown as SceneItem] } as SceneGroup)
  }
  return {
    // (now and then a view narrower than its padding: the frame's closing edge for a negative width)
    width: r() < 0.08 ? 4 : 320, height: 240, padding: { top: 5, left: 7, right: 3, bottom: 2 },
    frameCornerRadius: r() < 0.2 ? 6 : undefined, frameStroke: r() < 0.3 ? '#ccc' : undefined,
    items: marks,
  } as unknown as SceneRoot
}

