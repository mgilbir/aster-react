/**
 * The canvas painter follows vega-scenegraph's canvas draw rules (util/canvas/draw.js,
 * fill.js, stroke.js, marks/text.js, marks/image.js, markItemPath.js). A spy context
 * records every call and property write so each rule is asserted directly (audit C48),
 * independent of the SVG comparison in canvas.test.ts.
 */
import { describe, expect, it } from 'vitest'
import { renderSceneToCanvas, type CanvasLike } from './canvas.js'
import type { SceneRoot } from './types.js'

type Ev = { op: string; args: unknown[]; state: Record<string, unknown> }

/** A context that logs each call with a snapshot of the paint state at that moment. */
function spy(): { ctx: CanvasLike; log: Ev[] } {
  const log: Ev[] = []
  const state: Record<string, unknown> = {
    fillStyle: '#000', strokeStyle: '#000', globalAlpha: 1, lineWidth: 1, lineCap: 'butt', lineJoin: 'miter',
    miterLimit: 10, lineDashOffset: 0, font: '', textAlign: 'start', textBaseline: 'alphabetic', globalCompositeOperation: 'source-over',
    imageSmoothingEnabled: true, dash: [],
  }
  const stack: Array<Record<string, unknown>> = []
  const record = (op: string) => (...args: unknown[]): void => { log.push({ op, args, state: { ...state } }) }
  const methods: Record<string, unknown> = {}
  for (const m of ['beginPath', 'moveTo', 'lineTo', 'bezierCurveTo', 'quadraticCurveTo', 'arc', 'closePath', 'rect', 'clip', 'fill', 'stroke', 'fillRect', 'fillText', 'strokeText', 'drawImage', 'translate', 'rotate', 'scale']) {
    methods[m] = record(m)
  }
  methods.save = (): void => { stack.push({ ...state }); log.push({ op: 'save', args: [], state: { ...state } }) }
  methods.restore = (): void => { Object.assign(state, stack.pop()); log.push({ op: 'restore', args: [], state: { ...state } }) }
  methods.setLineDash = (d: number[]): void => { state.dash = d }
  methods.createLinearGradient = (): unknown => ({ addColorStop(): void {} })
  const ctx = new Proxy(methods, {
    get: (t, k: string) => (k in t ? t[k] : state[k]),
    set: (_t, k: string, v) => { state[k] = v; return true },
  }) as unknown as CanvasLike
  return { ctx, log }
}

const scene = (items: unknown[], extra: Record<string, unknown> = {}): SceneRoot =>
  ({ width: 200, height: 120, padding: { top: 0, right: 0, bottom: 0, left: 0 }, items, ...extra }) as unknown as SceneRoot

const mark = (marktype: string, ...items: unknown[]): unknown => ({ marktype, items })
const paints = (log: Ev[]): Ev[] => log.filter((e) => e.op === 'fill' || e.op === 'stroke')

describe('canvas painter follows vega draw/fill/stroke', () => {
  it('opacity 0 paints nothing; strokeWidth 0 skips only the stroke', () => {
    const { ctx, log } = spy()
    renderSceneToCanvas(scene([mark('rect',
      { x: 0, y: 0, width: 10, height: 10, fill: '#f00', stroke: '#00f', opacity: 0 },
      { x: 20, y: 0, width: 10, height: 10, fill: '#0f0', stroke: '#00f', strokeWidth: 0 },
    )]), ctx)
    const p = paints(log)
    expect(p.map((e) => `${e.op}:${e.state.fillStyle}`)).toEqual(['fill:#0f0'])
  })

  it('fill alpha is opacity*fillOpacity, stroke alpha opacity*strokeOpacity', () => {
    const { ctx, log } = spy()
    renderSceneToCanvas(scene([mark('rect', { x: 0, y: 0, width: 10, height: 10, fill: '#f00', stroke: '#00f', opacity: 0.5, fillOpacity: 0.5, strokeOpacity: 0.4 })]), ctx)
    const [f, s] = paints(log)
    expect(f!.op).toBe('fill')
    expect(f!.state.globalAlpha).toBeCloseTo(0.25)
    expect(s!.op).toBe('stroke')
    expect(s!.state.globalAlpha).toBeCloseTo(0.2)
  })

  it('cap, join, miter limit, dash and dash offset come from the item and never leak to the next item', () => {
    const { ctx, log } = spy()
    renderSceneToCanvas(scene([mark('rule',
      { x: 0, y: 5, x2: 10, y2: 5, stroke: '#000', strokeCap: 'round', strokeJoin: 'bevel', strokeMiterLimit: 2, strokeDash: [3, 1], strokeDashOffset: 2, strokeWidth: 4 },
      { x: 0, y: 9, x2: 10, y2: 9, stroke: '#000' },
    )]), ctx)
    const [a, b] = paints(log)
    expect(a!.state).toMatchObject({ lineCap: 'round', lineJoin: 'bevel', miterLimit: 2, lineDashOffset: 2, lineWidth: 4, dash: [3, 1] })
    expect(b!.state).toMatchObject({ lineCap: 'butt', lineJoin: 'miter', miterLimit: 4, lineDashOffset: 0, lineWidth: 1, dash: [] })
  })

  it('blend sets globalCompositeOperation for the item and resets it', () => {
    const { ctx, log } = spy()
    renderSceneToCanvas(scene([mark('rect', { x: 0, y: 0, width: 10, height: 10, fill: '#f00', blend: 'multiply' }, { x: 20, y: 0, width: 10, height: 10, fill: '#f00' })]), ctx)
    const [a, b] = paints(log)
    expect(a!.state.globalCompositeOperation).toBe('multiply')
    expect(b!.state.globalCompositeOperation).toBe('source-over')
  })

  it('the root frame is painted with its fill, stroke, dash and opacity', () => {
    const { ctx, log } = spy()
    renderSceneToCanvas(scene([], { frameFill: '#eef', frameStroke: '#a00', frameStrokeWidth: 3, frameStrokeDash: [4, 2], frameOpacity: 0.5, frameStrokeOpacity: 0.5, frameStrokeCap: 'round' }), ctx)
    const [f, s] = paints(log)
    expect(f!.state.fillStyle).toBe('#eef')
    expect(f!.state.globalAlpha).toBeCloseTo(0.5)
    expect(s!.state).toMatchObject({ strokeStyle: '#a00', lineWidth: 3, dash: [4, 2], lineCap: 'round' })
    expect(s!.state.globalAlpha).toBeCloseTo(0.25)
  })

  it('a line with a fill (closed shape) is filled, and a trail is filled too', () => {
    const { ctx, log } = spy()
    renderSceneToCanvas(scene([
      mark('line', { x: 0, y: 0, fill: '#0f0', stroke: '#000' }, { x: 10, y: 10 }, { x: 20, y: 0 }),
      mark('trail', { x: 0, y: 0, size: 3, fill: '#00f' }, { x: 10, y: 10, size: 3 }),
    ]), ctx)
    expect(paints(log).filter((e) => e.op === 'fill').map((e) => e.state.fillStyle)).toEqual(['#0f0', '#00f'])
  })
})

describe('text follows vega marks/text.js draw', () => {
  const text = (extra: Record<string, unknown> = {}): unknown => mark('text', { x: 50, y: 30, text: 'hi', fill: '#000', fontSize: 10, ...extra })

  it('textAlign defaults to left; the baseline offset moves y', () => {
    const { ctx, log } = spy()
    renderSceneToCanvas(scene([text({ baseline: 'top' })]), ctx)
    const t = log.find((e) => e.op === 'fillText')!
    expect(t.state.textAlign).toBe('left')
    expect(t.args.slice(0, 3)).toEqual(['hi', 50, 30 + 8]) // round(0.79 * 10)
  })

  it('opacity 0 and empty text paint nothing', () => {
    const { ctx, log } = spy()
    renderSceneToCanvas(scene([text({ opacity: 0 }), text({ text: '' })]), ctx)
    expect(log.some((e) => e.op === 'fillText')).toBe(false)
  })

  it('a stroked text is stroked as well as filled', () => {
    const { ctx, log } = spy()
    renderSceneToCanvas(scene([text({ stroke: '#f00', strokeWidth: 2 })]), ctx)
    expect(log.some((e) => e.op === 'fillText')).toBe(true)
    const st = log.find((e) => e.op === 'strokeText')!
    expect(st.state).toMatchObject({ strokeStyle: '#f00', lineWidth: 2 })
  })

  it('rotation translates to the anchor, rotates, then draws at the in-frame offset', () => {
    const { ctx, log } = spy()
    renderSceneToCanvas(scene([text({ angle: 90, dx: 3, dy: 4 })]), ctx)
    const ops = log.map((e) => e.op)
    const i = ops.indexOf('translate', ops.indexOf('translate') + 1) // after the root translate(pad)
    expect(ops.slice(i, i + 2)).toEqual(['translate', 'rotate'])
    const t = log.find((e) => e.op === 'fillText')!
    expect(t.args.slice(1, 3)).toEqual([3, 4])
  })
})

describe('shapes follow vega markItemPath / path / image', () => {
  it('an arc is built on the real context around the item origin (no re-derived centres)', () => {
    const { ctx, log } = spy()
    // exactly half a circle: the case where a centre re-derived from a rounded path string is ill-conditioned
    renderSceneToCanvas(scene([mark('arc', { x: 100, y: 60, startAngle: 0, endAngle: Math.PI, innerRadius: 0, outerRadius: 40, fill: '#08f' })]), ctx)
    const arcs = log.filter((e) => e.op === 'arc')
    expect(arcs.length).toBeGreaterThan(0)
    for (const a of arcs) expect(a.args.slice(0, 2)).toEqual([0, 0]) // centre at the translated origin, exactly
    const ops = log.map((e) => e.op)
    expect(ops.lastIndexOf('translate')).toBeLessThan(ops.indexOf('fill')) // transform restored BEFORE painting
  })

  it('a symbol with an angle is rotated in its own frame; strokes are painted after the transform is undone', () => {
    const { ctx, log } = spy()
    renderSceneToCanvas(scene([mark('symbol', { x: 30, y: 30, size: 100, shape: 'square', angle: 45, fill: '#f00' })]), ctx)
    expect(log.some((e) => e.op === 'rotate' && Math.abs((e.args[0] as number) - Math.PI / 4) < 1e-9)).toBe(true)
    const rotIdx = log.findIndex((e) => e.op === 'rotate')
    const fillIdx = log.findIndex((e) => e.op === 'fill')
    expect(log.slice(rotIdx, fillIdx).some((e) => e.op === 'restore')).toBe(true)
  })

  it('a path mark scales and rotates in its frame', () => {
    const { ctx, log } = spy()
    renderSceneToCanvas(scene([mark('path', { x: 10, y: 10, path: 'M0,0L10,0L10,10Z', scaleX: 2, scaleY: 3, angle: 90, fill: '#0f0' })]), ctx)
    expect(log.some((e) => e.op === 'scale' && e.args[0] === 2 && e.args[1] === 3)).toBe(true)
    expect(log.some((e) => e.op === 'rotate')).toBe(true)
  })

  it('an image draws from a host-supplied bitmap, letterboxed to its aspect ratio', () => {
    const { ctx, log } = spy()
    const bitmap = { width: 100, height: 50, complete: true }
    renderSceneToCanvas(scene([mark('image', { x: 10, y: 20, width: 100, height: 100, url: 'x.png', image: bitmap, opacity: 0.5 })]), ctx)
    const d = log.find((e) => e.op === 'drawImage')!
    expect(d.args.slice(1)).toEqual([10, 20 + 25, 100, 50]) // 2:1 bitmap in a 1:1 box: centred vertically
    expect(d.state.globalAlpha).toBe(0.5)
    // an item without a bitmap paints nothing
    const none = spy()
    renderSceneToCanvas(scene([mark('image', { x: 10, y: 20, width: 100, height: 100, url: 'x.png' })]), none.ctx)
    expect(none.log.some((e) => e.op === 'drawImage')).toBe(false)
  })

  it('an item without a size is a 64px symbol', () => {
    const { ctx, log } = spy()
    renderSceneToCanvas(scene([mark('symbol', { x: 30, y: 30, fill: '#f00' })]), ctx)
    const a = log.find((e) => e.op === 'arc')!
    expect(a.args[2]).toBeCloseTo(4) // sqrt(64) / 2
  })
})

describe('an image mark whose bitmap holds its own pixels (a heatmap\'s)', () => {
  it('is drawn from the canvas it keeps them in, at its natural size when the item has none', () => {
    const { ctx, log } = spy()
    const source = { canvas: true }
    const bitmap = { width: 40, height: 20, complete: true, toCanvasSource: () => source }
    renderSceneToCanvas(scene([mark('image', { x: 10, y: 20, image: bitmap })]), ctx)
    const d = log.find((e) => e.op === 'drawImage')!
    expect(d.args[0]).toBe(source)
    expect(d.args.slice(1)).toEqual([10, 20, 40, 20])
  })
  it('is drawn as it is where the host has no canvas to keep them in', () => {
    const { ctx, log } = spy()
    const bitmap = { width: 40, height: 20, toCanvasSource: () => null }
    renderSceneToCanvas(scene([mark('image', { x: 0, y: 0, width: 80, height: 40, aspect: false, image: bitmap })]), ctx)
    expect(log.find((e) => e.op === 'drawImage')!.args[0]).toBe(bitmap)
  })
})
