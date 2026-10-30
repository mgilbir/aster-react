/**
 * Targeted regressions for the canvas findings (C22, C23, C96), each next to the
 * general oracle that covers its shape (canvas-append-oracle, and the Chromium
 * pixel check in packages/conformance/scripts/browser-canvas-append.mts).
 */
import { describe, it, expect } from 'vitest'
import { compileChart, evaluateChart } from './index.js'
import { renderSceneToSvg } from './render.js'
import { renderSceneToCanvas, renderSceneToCanvasAppend, snapshotCanvasScene } from './canvas.js'
import { createChartStream } from './stream.js'
import { makeRecorder, diffPaintMultisets } from './canvas-record.testlib.js'
import type { SceneGroup, SceneItem, SceneRoot } from './types.js'

const mark = (marktype: string, items: unknown[], extra: Record<string, unknown> = {}): SceneGroup =>
  ({ marktype, role: 'mark', items, ...extra }) as unknown as SceneGroup
const sceneOf = (items: SceneGroup[], extra: Record<string, unknown> = {}): SceneRoot =>
  ({ width: 220, height: 140, padding: { top: 5, right: 6, bottom: 7, left: 8 }, items, ...extra }) as unknown as SceneRoot

// ---------------------------------------------------------------------------
// C23: trail fill
// ---------------------------------------------------------------------------

describe('C23: a trail keeps its fill', () => {
  const trail = (extra: Record<string, unknown>): SceneRoot => ({
    width: 100, height: 100, padding: { top: 0, right: 0, bottom: 0, left: 0 },
    items: [{
      marktype: 'trail', role: 'mark',
      items: [
        { x: 10, y: 10, size: 6, ...extra },
        { x: 50, y: 40, size: 10, ...extra },
        { x: 90, y: 20, size: 4, ...extra },
      ],
    }],
  } as unknown as SceneRoot)

  it('the canvas paints the fill (Vega-Lite encodes trail colour as fill)', () => {
    const { ctx, records } = makeRecorder()
    renderSceneToCanvas(trail({ fill: '#4c78a8', fillOpacity: 0.5, opacity: 0.8 }), ctx)
    const fills = records.filter((r) => r.op === 'fill')
    expect(fills).toHaveLength(1)
    expect(fills[0]!.style).toContain('#4c78a8')
    expect(fills[0]!.style).toContain('a0.4') // opacity * fillOpacity
    expect(records.filter((r) => r.op === 'stroke')).toHaveLength(0)
  })

  it('stroke and fill are both painted when both are set, fill first', () => {
    const { ctx, records } = makeRecorder()
    renderSceneToCanvas(trail({ fill: '#4c78a8', stroke: '#222', strokeWidth: 2 }), ctx)
    expect(records.map((r) => r.op)).toEqual(['fill', 'stroke'])
  })
})

// ---------------------------------------------------------------------------
// C22 + guide changes + z-order: the append path equals a full repaint
// ---------------------------------------------------------------------------

describe('C22: canvas append paint equals a full repaint', () => {
  const twoDatasets = {
    width: 200, height: 100, padding: 0, autosize: 'none', data: [{ name: 'a' }, { name: 'b' }],
    scales: [{ name: 'x', type: 'linear', domain: [0, 100], range: [0, 200] }, { name: 'y', type: 'linear', domain: [0, 10], range: [100, 0] }],
    marks: [
      { type: 'symbol', from: { data: 'a' }, encode: { update: { x: { scale: 'x', field: 'x' }, y: { value: 20 }, size: { value: 30 }, fill: { value: '#4c78a8' } } } },
      { type: 'symbol', from: { data: 'b' }, encode: { update: { x: { scale: 'x', field: 'x' }, y: { value: 70 }, size: { value: 30 }, fill: { value: '#e45756' } } } },
    ],
  }
  const full = (scene: SceneRoot) => { const r = makeRecorder(); renderSceneToCanvas(scene, r.ctx, { batchSymbols: false }); return r.records }

  it('an append in one group together with an in-place move in ANOTHER group is not painted as a pure append', () => {
    const s = createChartStream(twoDatasets as never, { initial: { data: { a: [{ x: 10 }, { x: 20 }], b: [{ x: 30 }, { x: 40 }] } } })
    const first = s.flush()!.scene
    const snap = snapshotCanvasScene(first)
    let painted = full(first)
    s.push({ data: { a: [{ x: 10 }, { x: 20 }, { x: 50 }], b: [{ x: 30 }, { x: 45 }] } })
    const next = s.flush()!.scene
    const rec = makeRecorder()
    const ok = renderSceneToCanvasAppend(snap, next, rec.ctx, { dpr: 1, batchSymbols: false })
    painted = ok ? painted.concat(rec.records) : full(next)
    const fresh = evaluateChart(compileChart(twoDatasets as never), { data: { a: [{ x: 10 }, { x: 20 }, { x: 50 }], b: [{ x: 30 }, { x: 45 }] } })
    expect(diffPaintMultisets(full(fresh), painted)).toBeNull()
  })

  it('a guide that changes after the marks is not repainted on top of its old self', () => {
    const spec = {
      width: 200, height: 100, padding: 5, autosize: 'none', data: [{ name: 't' }],
      scales: [
        { name: 'x', type: 'linear', domain: [0, 100], range: [0, 190] }, { name: 'y', type: 'linear', domain: [0, 10], range: [90, 0] },
        { name: 'c', type: 'ordinal', domain: { data: 't', field: 'g' }, range: ['#4c78a8', '#e45756', '#54a24b'] },
      ],
      legends: [{ fill: 'c' }],
      marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'x' }, y: { value: 20 }, size: { value: 30 }, fill: { value: '#777' } } } }],
    }
    const s = createChartStream(spec as never, { initial: { data: { t: [{ x: 10, g: 'A' }, { x: 20, g: 'B' }] } } })
    const first = s.flush()!.scene
    const snap = snapshotCanvasScene(first)
    s.push({ append: { t: [{ x: 30, g: 'C' }] } })
    const next = s.flush()!.scene
    const rec = makeRecorder()
    const ok = renderSceneToCanvasAppend(snap, next, rec.ctx, { dpr: 1, batchSymbols: false })
    // the legend gained an entry: painting it over the old legend would ghost it, so the renderer must decline
    expect(ok).toBe(false)
  })

  it('appended marks that land on a later (higher z-order) group are declined; clear ones are painted', () => {
    const noPad = { padding: { top: 0, right: 0, bottom: 0, left: 0 } }
    const stamp = (scene: SceneRoot, gen: number): SceneRoot => { (scene as unknown as { __itemGen: number }).__itemGen = gen; return scene }
    // A full repaint draws the rule group ABOVE the symbols; appending a symbol that
    // lands on the rule must not draw it over the rule.
    const build = (ruleY: number): { snap: ReturnType<typeof snapshotCanvasScene>; next: SceneRoot } => {
      const items: SceneItem[] = [{ x: 10, y: 50, size: 100, fill: '#4c78a8', __gen: 1 } as SceneItem]
      const sym = mark('symbol', items)
      const rule = mark('rule', [{ x: 0, y: ruleY, x2: 200, y2: ruleY, stroke: '#000', strokeWidth: 2 }])
      const snap = snapshotCanvasScene(stamp(sceneOf([sym, rule], noPad), 1))
      items.push({ x: 40, y: 50, size: 100, fill: '#4c78a8', __gen: 2 } as SceneItem)
      return { snap, next: stamp(sceneOf([{ ...sym, items }, rule], noPad), 2) }
    }
    const hit = build(50)
    expect(renderSceneToCanvasAppend(hit.snap, hit.next, makeRecorder().ctx, { dpr: 1 })).toBe(false)
    const clear = build(120)
    expect(renderSceneToCanvasAppend(clear.snap, clear.next, makeRecorder().ctx, { dpr: 1 })).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// C96: no per-frame JSON.stringify of item arrays
// ---------------------------------------------------------------------------

describe('C96: the append path never serialises item arrays', () => {
  it('does not call JSON.stringify while deciding/painting an append with guides present', () => {
    const spec = {
      width: 300, height: 200, padding: 10, autosize: 'none', title: { text: 'T' }, data: [{ name: 't' }],
      scales: [{ name: 'x', type: 'linear', domain: [0, 1000], range: 'width' }, { name: 'y', type: 'linear', domain: [0, 10], range: 'height' }],
      axes: [{ scale: 'x', orient: 'bottom' }, { scale: 'y', orient: 'left' }],
      marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'y' }, size: { value: 8 } } } }],
    }
    const rows = (n: number, from = 0): { x: number; y: number }[] => Array.from({ length: n }, (_, i) => ({ x: (from + i) % 1000, y: ((from + i) * 7) % 10 }))
    const s = createChartStream(spec as never, { initial: { data: { t: rows(3000) } } })
    let scene = s.flush()!.scene
    let snap = snapshotCanvasScene(scene)
    const real = JSON.stringify
    let calls = 0
    let appended = 0
    for (let i = 0; i < 10; i++) {
      s.push({ append: { t: rows(1, 3000 + i) } })
      scene = s.flush()!.scene
      // only the canvas decision/paint is under the spy (the session fingerprints its own spec)
      JSON.stringify = ((...a: Parameters<typeof JSON.stringify>) => { calls++; return real(...a) }) as typeof JSON.stringify
      try {
        if (renderSceneToCanvasAppend(snap, scene, makeRecorder().ctx, { dpr: 1 })) appended++
      } finally {
        JSON.stringify = real
      }
      snap = snapshotCanvasScene(scene)
    }
    expect(appended).toBeGreaterThan(5)
    expect(calls).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Nightly Firefox parity: a line/area is drawn from the UNROUNDED coordinates
// ---------------------------------------------------------------------------

describe('line and area canvas paths use full-precision coordinates (vega canvas parity)', () => {
  // vega's canvas draws a line/area through d3-shape with the canvas as the path context (no
  // rounding); only its SVG `d` is rounded to 3 decimals. Rounding the canvas path moved vertices by up
  // to 5e-4px, which Firefox's rasteriser amplified at acute miter joins (vlx-order-channel-line,
  // vlx-tr-window: 0.09% of pixels differ, bit-exact once the coordinates match).
  const pts = [
    { x: 85.71428571428571, y: 133.33333333333334 },
    { x: 300, y: 0.0004999 },
    { x: 171.42857142857142, y: 88.88888888888889 },
    { x: 0, y: 155.55555555555557 },
  ]
  const polyOf = (records: ReturnType<typeof makeRecorder>['records'], op: 'fill' | 'stroke'): number[] =>
    records.filter((r) => r.op === op).flatMap((r) => r.polys!.flatMap((p) => p.pts))
  const flat = (xy: Array<{ x: number; y: number }>): number[] => xy.flatMap((p) => [p.x + 8, p.y + 5])

  for (const interpolate of [undefined, 'monotone', 'step']) {
    it(`line (${interpolate ?? 'linear'}): no coordinate is rounded; the SVG still is`, () => {
      const items = pts.map((p) => ({ ...p, stroke: '#4c78a8', strokeWidth: 2, ...(interpolate ? { interpolate } : {}) }))
      const scene = sceneOf([mark('line', items)])
      const { ctx, records } = makeRecorder()
      renderSceneToCanvas(scene, ctx)
      const drawn = polyOf(records, 'stroke')
      expect(drawn.length).toBeGreaterThan(0)
      // every raw vertex coordinate appears verbatim among the drawn points
      // step/monotone synthesise vertices; only the linear form passes the input vertices through
      if (!interpolate) for (const v of flat(pts)) expect(drawn.some((d) => Math.abs(d - v) < 1e-9)).toBe(true)
      expect(drawn.some((d) => Math.abs(d * 1000 - Math.round(d * 1000)) > 1e-6)).toBe(true)
      expect(renderSceneToSvg(scene)).toContain('85.714,133.333')
    })
  }

  it('line vertices are drawn verbatim (linear)', () => {
    const items = pts.map((p) => ({ ...p, stroke: '#000', strokeWidth: 2 }))
    const { ctx, records } = makeRecorder()
    renderSceneToCanvas(sceneOf([mark('line', items)]), ctx)
    expect(polyOf(records, 'stroke')).toEqual(flat(pts))
  })

  it('area outline is not rounded either; the SVG still is', () => {
    const items = pts.map((p) => ({ x: p.x, y: p.y, y2: 140, fill: '#4c78a8' }))
    const scene = sceneOf([mark('area', items)])
    const { ctx, records } = makeRecorder()
    renderSceneToCanvas(scene, ctx)
    const drawn = polyOf(records, 'fill')
    for (const v of flat(pts)) expect(drawn.some((d) => Math.abs(d - v) < 1e-9)).toBe(true)
    expect(renderSceneToSvg(scene)).toContain('85.714,133.333')
  })
})

describe('shape generators: the digits of a path', () => {
  it('null keeps full precision, 1 rounds to one decimal', async () => {
    const { areaPath, linePath, resolveCurve } = await import('./shape.js')
    const x = Float64Array.of(1.23456, 3.45678)
    const y = Float64Array.of(2.34567, 4.56789)
    const linear = resolveCurve('linear', undefined, undefined)
    expect(linePath(linear, x, y, null, null)).toBe('M1.23456,2.34567L3.45678,4.56789')
    expect(linePath(linear, x, y, null, 1)).toBe('M1.2,2.3L3.5,4.6')
    expect(areaPath(linear, x, y, x, new Float64Array(2), null, null)).toContain('1.23456')
  })
})

// ---------------------------------------------------------------------------
// A symbol whose position is not a number is drawn at 0, as vega's canvas draws it (`item.x || 0`)
// ---------------------------------------------------------------------------

describe('a symbol at a NaN position', () => {
  const sym = (n: number, y: number): SceneRoot =>
    sceneOf([mark('symbol', Array.from({ length: n }, (_, i) => ({ x: 10 + i, y, size: 30, fill: '#4c78a8' })))])

  for (const n of [3, 300]) {
    it(`draws where y = 0 draws it (${n} items: ${n >= 256 ? 'batched run' : 'one by one'})`, () => {
      const a = makeRecorder()
      renderSceneToCanvas(sym(n, Number.NaN), a.ctx)
      const b = makeRecorder()
      renderSceneToCanvas(sym(n, 0), b.ctx)
      expect(a.records.filter((r) => r.op === 'fill').length).toBeGreaterThan(0)
      expect(a.records).toEqual(b.records)
    })
  }
})
