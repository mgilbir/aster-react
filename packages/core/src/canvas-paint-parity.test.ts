// @vitest-environment jsdom
/**
 * Canvas and SVG paint what one item per element paints, whatever they batch or how a paint ends (C37, C413, C412, C134, C135,
 * C228, C551):
 *  - a run of symbols painted as one path (canvas runs, the SVG renderer's `denseMarks` chunks) is only ever one whose single
 *    path paints the pixels the items paint one by one: opaque, unblended, a fill or a stroke but not both. Any other run is
 *    painted item by item, exactly as with batching off;
 *  - the canvas and SVG test a paint the same way (`''`, `transparent`, `false` paint nothing);
 *  - the canvas clips to the view's `clip` as the SVG does (the rounded box when the view has a corner radius);
 *  - an append returns true only when its paint is a full repaint's, whatever of the view's own paint changed;
 *  - a paint that throws leaves the context as it found it (every save restored);
 *  - text is drawn in the font it is measured with.
 */
import { describe, expect, it } from 'vitest'
import { renderSceneToCanvas, renderSceneToCanvasAppend, snapshotCanvasScene, type CanvasLike } from './canvas.js'
import { sceneToDomDesc, type DomDesc } from './dom.js'
import { makeRecorder, diffPaintMultisets, type PaintRecord } from './canvas-record.testlib.js'
import { fontString } from './text-metrics.js'
import { compileChart, evaluateChart, renderSceneToSvg } from './index.js'
import { createChartSession } from './session.js'
import { mulberry32, pick } from './scene-fuzz.testlib.js'
import type { SceneGroup, SceneItem, SceneRoot, VgSpec } from './types.js'

const records = (scene: SceneRoot, batchSymbols: boolean): PaintRecord[] => {
  const { ctx, records } = makeRecorder()
  renderSceneToCanvas(scene, ctx, { batchSymbols })
  return records
}

/**
 * The oracle's rule, from what compositing is: one path paints what N do only when overlaps cannot show -- nothing painted is
 * translucent or blended, and not both a fill and a stroke are painted (one path puts all its fill under all its stroke).
 */
const paints = (v: unknown): boolean => v != null && v !== false && v !== '' && v !== 'transparent'
const below1 = (a: unknown): boolean => a != null && a !== 1
const oneLikeMany = (it: Record<string, unknown>): boolean => {
  const fill = paints(it.fill), stroke = paints(it.stroke)
  if (fill && stroke) return false
  if (!fill && !stroke) return true
  return !below1(it.opacity) && !(fill && below1(it.fillOpacity)) && !(stroke && below1(it.strokeOpacity)) && it.blend == null
}
const opaqueAsWritten = (it: Record<string, unknown>): boolean => [it.opacity, it.fillOpacity, it.strokeOpacity].every((a) => a == null || a === 1) && it.blend == null
/** What a paint record says besides its geometry (the paint, alpha, line style, clip): the order of these is the picture's. */
const paintOf = (r: PaintRecord): string => `${r.op} ${r.style}`

const PAINTS = {
  fill: [undefined, 'steelblue', '', 'transparent'],
  stroke: [undefined, 'white', 'transparent'],
  opacity: [undefined, 1, 0.3],
  fillOpacity: [undefined, 1, 0.5],
  strokeOpacity: [undefined, 1, 0.4],
  blend: [undefined, 'multiply'],
} as const

function symbolScene(r: () => number, n: number): { scene: SceneRoot; paint: Record<string, unknown> } {
  const paint: Record<string, unknown> = {}
  for (const [k, vs] of Object.entries(PAINTS)) { const v = pick(r, vs as readonly unknown[]); if (v !== undefined) paint[k] = v }
  // (every item one paint: the run is the mark, overlapping)
  const shape = pick(r, ['circle', 'square'])
  const items = Array.from({ length: n }, (_, i) => ({ x: 20 + (i % 7), y: 20 + (i % 5), size: 64, shape, ...paint, datum: { i } }))
  const scene = { width: 100, height: 100, padding: { top: 0, left: 0, right: 0, bottom: 0 }, items: [{ marktype: 'symbol', role: 'mark', items }] } as unknown as SceneRoot
  return { scene, paint }
}

describe('a run is one path only when one path paints what the items paint (C37, C413)', () => {
  it('canvas: every paint combination, at the batching size', () => {
    let batched = 0
    let unbatched = 0
    for (let seed = 1; seed <= 300; seed++) {
      const r = mulberry32(seed)
      const { scene, paint } = symbolScene(r, 300)
      const on = records(scene, true)
      const off = records(scene, false)
      if (!oneLikeMany(paint)) {
        // painted item by item, in item order, as with batching off
        expect(on.map(paintOf), JSON.stringify(paint)).toEqual(off.map(paintOf))
        expect(on.length, JSON.stringify(paint)).toBe(off.length)
        unbatched++
      } else if (opaqueAsWritten(paint) && (paints(paint.fill) || paints(paint.stroke))) {
        // (and the batch is kept where it is safe: one paint per shape run)
        expect(on.length, JSON.stringify(paint)).toBeLessThan(off.length / 10)
        batched++
      }
    }
    // (both kinds were drawn: the property is not vacuous)
    expect(batched).toBeGreaterThan(10)
    expect(unbatched).toBeGreaterThan(50)
  })

  it('SVG denseMarks: a chunk is one path only for such items; any other symbol keeps its own element', () => {
    const count = (d: DomDesc, tag: string): number => (d.tag === tag ? 1 : 0) + (d.children ?? []).reduce((n, c) => n + count(c, tag), 0)
    for (let seed = 1; seed <= 150; seed++) {
      const r = mulberry32(seed)
      const { scene, paint } = symbolScene(r, 600)
      const dense = sceneToDomDesc(scene, { denseMarks: true, denseChunkSize: 64 })
      const paths = count(dense, 'path') - 2 // (the frame and the foreground)
      if (!oneLikeMany(paint)) expect(paths, JSON.stringify(paint)).toBe(600)
      else if (opaqueAsWritten(paint) && (paints(paint.fill) || paints(paint.stroke))) expect(paths, JSON.stringify(paint)).toBeLessThan(60)
    }
  })
})

describe('one test of a paint (C412)', () => {
  it('a text and a path paint a fill / stroke under the same values', () => {
    for (const fill of ['red', '', 'transparent', false, null, undefined]) {
      for (const stroke of ['blue', '', 'transparent', false, null, undefined]) {
        const scene = {
          width: 50, height: 50, padding: { top: 0, left: 0, right: 0, bottom: 0 },
          items: [
            { marktype: 'text', role: 'mark', items: [{ x: 10, y: 10, text: 'ghost', fill, stroke }] },
            { marktype: 'rect', role: 'mark', items: [{ x: 10, y: 10, width: 5, height: 5, fill, stroke }] },
          ],
        } as unknown as SceneRoot
        const calls: string[] = []
        const ctx = new Proxy({} as Record<string, unknown>, {
          get: (t, k) => (typeof k !== 'string' ? undefined : k in t ? t[k] : k === 'measureText' ? () => ({ width: 10 }) : (...a: unknown[]) => { calls.push(String(k)); void a }),
          set: (t, k, v) => { t[k as string] = v; return true },
        }) as unknown as CanvasLike
        renderSceneToCanvas(scene, ctx)
        const label = JSON.stringify({ fill, stroke })
        expect(calls.includes('fillText'), label).toBe(calls.includes('fill'))
        expect(calls.includes('strokeText'), label).toBe(calls.includes('stroke'))
        expect(calls.includes('fill'), label).toBe(paints(fill))
      }
    }
  })
})

describe('the view\'s clip on canvas is the SVG one (C134)', () => {
  const spec = (cornerRadius: number, w: number, h: number): VgSpec => ({
    width: w, height: h, padding: 5, encode: { update: { clip: { value: true }, cornerRadius: { value: cornerRadius }, fill: { value: '#eee' } } },
    marks: [{ type: 'rect', encode: { update: { x: { value: w / 2 }, y: { value: h / 2 }, width: { value: 500 }, height: { value: 500 }, fill: { value: 'red' } } } }],
  } as unknown as VgSpec)

  it('every mark paint is under the frame clip, the rect of the SVG clipPath or its rounded path', () => {
    for (const [r, w, h] of [[0, 100, 80], [12, 100, 80], [60, 50, 30], [3.5, 31, 77]] as const) {
      const scene = evaluateChart(compileChart(spec(r, w, h)), {})
      const svg = renderSceneToSvg(scene)
      const clip = /<clipPath id="[^"]+"><(rect|path) ([^/]*)\/><\/clipPath>/.exec(svg)!
      expect(clip, `${r}`).not.toBeNull()
      const recs = records(scene, true)
      const red = recs.filter((x) => x.style.startsWith('red'))
      expect(red.length).toBe(1)
      // the clip the canvas paints the mark under: one region, in device space, and a rounded one exactly when the SVG's is
      const clipPart = red[0]!.style.split('|clip:')[1]!
      expect(clipPart, `${r}`).not.toBe('')
      expect(/A|C/.test(clipPart), `${r}: ${clipPart}`).toBe(clip[1] === 'path')
      // ... at the frame's place: the plot box starts at the padding
      expect(clipPart.startsWith(clip[1] === 'path' ? 'M' : 'R5,5'), clipPart).toBe(true)
    }
  })

  it('without a clip, none (control)', () => {
    const s = evaluateChart(compileChart({ ...spec(0, 100, 80), encode: { update: { fill: { value: '#eee' } } } } as unknown as VgSpec), {})
    expect(records(s, true).every((x) => x.style.endsWith('|clip:'))).toBe(true)
  })
})

describe('an append is a full repaint\'s paint, whatever of the view\'s own paint changed (C135)', () => {
  const ROOT = [
    {}, { x: 30, y: 7 }, { opacity: 0.2 }, { fillOpacity: 0.1 }, { cornerRadius: 30 }, { strokeOpacity: 0.1 }, { strokeDash: [8, 8] },
    { strokeCap: 'round' }, { fill: 'black' }, { stroke: 'red' }, { strokeWidth: 3 }, { clip: true },
  ]
  // (one spec: the view's paint follows signals, so a session advances the mark's items in place and the append path is open)
  const DEFAULTS: Record<string, unknown> = { x: 0, y: 0, opacity: 1, fillOpacity: 1, cornerRadius: 0, strokeOpacity: 1, strokeDash: [1, 1], strokeCap: 'butt', fill: 'white', stroke: '#ccc', strokeWidth: 1, clip: false }
  const SPEC = {
    width: 100, height: 100, padding: 5, data: [{ name: 't' }],
    signals: Object.entries(DEFAULTS).map(([k, v]) => ({ name: `r_${k}`, value: v })),
    encode: { update: Object.fromEntries(Object.keys(DEFAULTS).map((k) => [k, { signal: `r_${k}` }])) },
    marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { field: 'x' }, y: { field: 'y' }, fill: { value: 'steelblue' } } } }],
  } as unknown as VgSpec
  const spec = (): VgSpec => structuredClone(SPEC)
  const signals = (root: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries({ ...DEFAULTS, ...root }).map(([k, v]) => [`r_${k}`, v]))
  const rows = (n: number): object[] => Array.from({ length: n }, (_, i) => ({ x: 10 + 7 * i, y: 10 + 3 * i }))

  it('every pair of view paints, with an append in the same update', () => {
    let appended = 0
    for (const a of ROOT) {
      for (const b of ROOT) {
        const session = createChartSession()
        const first = session.evaluate(spec(), { data: { t: rows(3) }, signals: signals(a) })
        const { ctx, records: painted } = makeRecorder()
        renderSceneToCanvas(first, ctx)
        const snap = snapshotCanvasScene(first)
        const next = session.evaluate(spec(), { data: { t: rows(4) }, signals: signals(b) })
        const app = makeRecorder()
        const ok = renderSceneToCanvasAppend(snap, next, app.ctx)
        const want = records(evaluateChart(compileChart(spec()), { data: { t: rows(4) }, signals: signals(b) }), true)
        if (ok) {
          appended++
          expect(diffPaintMultisets(want, painted.concat(app.records)), `${JSON.stringify(a)} -> ${JSON.stringify(b)}`).toBeNull()
        }
      }
    }
    // (an append that changes nothing of the view's own paint does take the append path)
    expect(appended).toBeGreaterThanOrEqual(ROOT.length)
  })
})

describe('a paint that throws leaves the context as it found it (C228)', () => {
  /** A context that keeps its save depth and transform, and throws at the n-th call of `method`. */
  function throwingCtx(method: string, n: number): { ctx: CanvasLike; depth: () => number; matrix: () => number[] } {
    let depth = 0
    let calls = 0
    let m = [1, 0, 0, 1, 0, 0]
    const stack: number[][] = []
    const ctx = new Proxy({} as Record<string, unknown>, {
      get(t, k) {
        if (typeof k !== 'string') return undefined
        if (k in t) return t[k]
        const call = (...a: unknown[]): unknown => {
          if (k === method && ++calls === n) throw new Error(`${method} refused`)
          if (k === 'save') { depth++; stack.push(m.slice()) }
          if (k === 'restore') { depth--; m = stack.pop() ?? m }
          if (k === 'translate') m = [m[0]!, m[1]!, m[2]!, m[3]!, m[4]! + (a[0] as number), m[5]! + (a[1] as number)]
          if (k === 'scale') m = [m[0]! * (a[0] as number), m[1]!, m[2]!, m[3]! * (a[1] as number), m[4]!, m[5]!]
          if (k === 'rotate') m = [...m.slice(0, 4).map((x) => x + 1e-9 * (a[0] as number)), m[4]!, m[5]!]
          if (k === 'measureText') return { width: 10 }
          if (k.startsWith('create')) return { addColorStop() { if (method === 'addColorStop' && ++calls === n) throw new Error('stop refused') } }
          return undefined
        }
        return call
      },
      set(t, k, v) { t[k as string] = v; return true },
    }) as unknown as CanvasLike
    return { ctx, depth: () => depth, matrix: () => m }
  }

  const scene = (): SceneRoot => evaluateChart(compileChart({
    width: 120, height: 90, padding: 5, encode: { update: { clip: { value: true }, fill: { value: '#eee' } } },
    data: [{ name: 't', values: [{ a: 1, b: 'x' }, { a: 2, b: 'y' }, { a: 3, b: 'z' }] }],
    scales: [{ name: 'x', type: 'linear', domain: [0, 4], range: 'width' }],
    axes: [{ orient: 'bottom', scale: 'x' }],
    marks: [
      { type: 'arc', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'a' }, y: { value: 30 }, outerRadius: { value: 10 }, endAngle: { value: 2 }, angle: { value: 20 }, fill: { value: { gradient: 'linear', stops: [{ offset: 0, color: 'red' }, { offset: 1, color: 'blue' }] } } } } },
      { type: 'text', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'a' }, y: { value: 50 }, text: { field: 'b' }, angle: { value: 30 } } } },
      { type: 'group', encode: { update: { x: { value: 5 }, y: { value: 5 }, width: { value: 20 }, height: { value: 20 }, clip: { value: true } } }, marks: [{ type: 'rect', encode: { update: { width: { value: 30 }, height: { value: 30 }, fill: { value: 'red' }, strokeDash: { value: [2, 1] }, stroke: { value: 'black' } } } }] },
    ],
  } as unknown as VgSpec), {})

  it('at every call of every method a context may refuse, with and without a device pixel ratio', () => {
    let threw = 0
    for (const method of ['fill', 'stroke', 'fillText', 'setLineDash', 'arc', 'rect', 'clip', 'translate', 'rotate', 'addColorStop', 'createLinearGradient', 'moveTo', 'lineTo', 'bezierCurveTo']) {
      for (let n = 1; n <= 12; n++) {
        for (const dpr of [1, 2]) {
          const t = throwingCtx(method, n)
          try { renderSceneToCanvas(scene(), t.ctx, { dpr }) } catch { threw++ }
          expect(t.depth(), `${method} #${n} dpr ${dpr}`).toBe(0)
          expect(t.matrix(), `${method} #${n} dpr ${dpr}`).toEqual([1, 0, 0, 1, 0, 0])
        }
      }
    }
    expect(threw).toBeGreaterThan(100)
  })
})

describe('text is drawn in the font it is measured with (C551)', () => {
  it('the canvas font is the measurer\'s, for every font property form', () => {
    const fonts: Array<Record<string, unknown>> = []
    for (const font of [undefined, '', 'Georgia', 'a b']) for (const fontSize of [undefined, 12, '14', 'x', 0]) for (const fontWeight of [undefined, 'bold', 300]) for (const fontStyle of [undefined, 'italic']) fonts.push({ font, fontSize, fontWeight, fontStyle, fontVariant: 'small-caps' })
    for (const f of fonts) {
      const item = { x: 10, y: 10, text: 'abc', fill: 'black', ...f } as unknown as SceneItem
      const scene = { width: 50, height: 50, padding: { top: 0, left: 0, right: 0, bottom: 0 }, items: [{ marktype: 'text', role: 'mark', items: [item] } as SceneGroup] } as unknown as SceneRoot
      const { ctx, records: recs } = makeRecorder()
      renderSceneToCanvas(scene, ctx)
      const text = recs.find((x) => x.op === 'text')
      if (text === undefined) continue // (a size of 0 draws nothing)
      expect(text.style.split('|')[2], JSON.stringify(f)).toBe(fontString(item))
    }
  })
})
