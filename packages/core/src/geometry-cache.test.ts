// @vitest-environment jsdom
/**
 * The geometry caches (geometry.ts): an unchanged mark is generated once however many times it is drawn, by whichever
 * consumer; every input the generators read, changed in place on the very same objects, misses the cache: the SVG, DOM and canvas
 * output is the refactor baseline's for the changed scene (`diffScene`), and the hit index, the bounds and `intersect()` answer as
 * they do on a fresh copy of the changed scene, whose objects no cache has seen (`coldVsWarm`).
 */
import { describe, expect, it } from 'vitest'
import { compileChart } from './compiler.js'
import { evaluateChart } from './evaluate.js'
import { createChartSession } from './session.js'
import { geometryCounts } from './geometry.js'
import { renderSceneToSvg } from './render.js'
import { patchSceneDom, renderSceneToDomElement, sceneToDomDesc } from './dom.js'
import { renderSceneToCanvas } from './canvas.js'
import { renderSceneToCanvas as legacyCanvas } from './legacy-canvas.testlib.js'
import { buildHitIndex, type HitTarget } from './hit.js'
import { Bounds, boundTypedMark } from './bounds.js'
import { setTextMetricsProvider } from './text-metrics.js'
import type { SceneGroup, SceneItem, SceneRoot } from './types.js'
import { diffScene, loggingContext, marksOf, probePoints } from './geometry-differential.testlib.js'
import { sceneIntersect } from './scene-intersect.js'
import { mulberry32 } from './scene-fuzz.testlib.js'

type Counts = typeof geometryCounts
const snapshot = (): Counts => ({ ...geometryCounts })
const delta = (a: Counts): Counts => Object.fromEntries(Object.entries(geometryCounts).map(([k, v]) => [k, v - a[k as keyof Counts]])) as Counts

/** One mark of each cached kind, plus a rule that a signal moves (the hover case: the other marks are left alone). */
const SPEC = {
  width: 300, height: 200, padding: 5, autosize: 'none',
  signals: [{ name: 'hover', value: 0 }],
  data: [{ name: 't', values: Array.from({ length: 40 }, (_, i) => ({ x: i, y: Math.sin(i / 4) * 10 + 20, s: (i % 4) + 1, g: i % 2 ? 'a' : 'b' })) }],
  scales: [
    { name: 'x', type: 'linear', domain: [0, 40], range: 'width' },
    { name: 'y', type: 'linear', domain: [0, 40], range: 'height' },
  ],
  marks: [
    { type: 'group', from: { facet: { name: 'f', data: 't', groupby: 'g' } }, marks: [
      { type: 'line', from: { data: 'f' }, encode: { enter: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'y' }, stroke: { value: 'red' }, interpolate: { value: 'step-after' } } } },
      { type: 'area', from: { data: 'f' }, encode: { enter: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'y' }, y2: { scale: 'y', value: 0 }, fill: { value: 'blue' }, interpolate: { value: 'monotone' } } } },
    ] },
    { type: 'trail', from: { data: 't' }, encode: { enter: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'y' }, size: { field: 's' }, fill: { value: 'green' } } } },
    { type: 'arc', from: { data: 't' }, encode: { enter: { x: { value: 150 }, y: { value: 100 }, startAngle: { signal: 'datum.x / 7' }, endAngle: { signal: 'datum.x / 7 + 0.1' }, innerRadius: { value: 20 }, outerRadius: { value: 40 }, cornerRadius: { value: 2 }, fill: { value: 'orange' } } } },
    { type: 'symbol', from: { data: 't' }, encode: { enter: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'y' }, size: { signal: 'datum.s * 20' }, shape: { value: 'diamond' }, fill: { value: 'purple' } } } },
    { type: 'rule', encode: { update: { x: { signal: 'hover' }, x2: { signal: 'hover' }, y: { value: 0 }, y2: { value: 200 }, stroke: { value: '#000' } } } },
  ],
}


/** A copy of a scene's data, every object new (functions and the evaluation's runtime left out): no cache has seen any of it. */
function freshCopy<T>(v: T): T {
  if (Array.isArray(v)) return v.map(freshCopy) as T
  if (v === null || typeof v !== 'object') return v
  const out: Record<string, unknown> = {}
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (typeof x === 'function' || k === 'runtime' || k === 'compiled') continue
    out[k] = k === 'datum' ? x : freshCopy(x)
  }
  return out as T
}

/** Every object of a scene named by its place (the indices from the root), so two copies can be compared item for item. */
function places(scene: SceneRoot): Map<object, string> {
  const out = new Map<object, string>()
  const walk = (v: unknown, path: string): void => {
    if (v === null || typeof v !== 'object') return
    if (out.has(v)) return
    out.set(v, path)
    const items = (v as { items?: unknown[] }).items
    if (Array.isArray(items)) items.forEach((c, i) => walk(c, `${path}/${i}`))
  }
  walk(scene, '')
  return out
}

/**
 * The hit index (both renderers' picks), the bounds of every mark and `intersect()` on `scene` -- its caches warm -- against the same
 * on a fresh copy of it: the differences (empty: the cached geometry is the geometry of the scene as it is now).
 */
function coldVsWarm(scene: SceneRoot, r: () => number): string[] {
  const copy = freshCopy(scene)
  const out: string[] = []
  const answers = (s: SceneRoot): string[] => {
    const name = places(s)
    const t = (h: HitTarget | null): string => (h === null ? 'null' : `${h.marktype}:${h.kind}:${name.get(h.item) ?? '?'}`)
    const res: string[] = []
    for (const renderer of ['svg', 'canvas'] as const) {
      const ix = buildHitIndex(s, undefined, { renderer })
      for (const [x, y] of probePoints(scene, mulberry32(3))) res.push(`${renderer} ${x},${y}: ${t(ix.query(x, y))} ${t(ix.queryMark(x, y))} ${t(ix.pick(x, y))} ${t(ix.tooltip(x, y))}`)
    }
    for (const { mark } of marksOf(s)) { const b = boundTypedMark(new Bounds(), mark); res.push(`bounds ${name.get(mark)}: ${[b.x1, b.y1, b.x2, b.y2].map(String)}`) }
    return res
  }
  const a = answers(scene)
  const b = answers(copy)
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) { out.push(`warm ${a[i]} / fresh ${b[i]}`); break }
  for (let k = 0; k < 6; k++) {
    const x = r() * 300, y = r() * 200
    const box = [[x, y], [x + r() * 200, y + r() * 150]]
    const na = places(scene), nb = places(copy)
    const wa = sceneIntersect(scene, box, null, null).map((it) => na.get(it) ?? '?').join(' ')
    const wb = sceneIntersect(copy, box, null, null).map((it) => nb.get(it) ?? '?').join(' ')
    if (wa !== wb) out.push(`intersect ${JSON.stringify(box)}: warm [${wa}] / fresh [${wb}]`)
  }
  return out
}

describe('work counts: an unchanged mark is generated once', () => {
  const consumers: Record<string, (scene: SceneRoot, svg: Element | null) => void> = {
    svg: (s) => { renderSceneToSvg(s) },
    dom: (s, svg) => { patchSceneDom(svg!, s) },
    'dom-dense': (s) => { sceneToDomDesc(s, { denseMarks: true }) },
    canvas: (s) => { renderSceneToCanvas(s, loggingContext().ctx) },
    hit: (s) => { const ix = buildHitIndex(s); ix.query(50, 50); ix.queryMark(100, 100); ix.pick(150, 100) },
    bounds: (s) => { for (const { mark } of marksOf(s)) boundTypedMark(new Bounds(), mark) },
  }
  for (const [name, consume] of Object.entries(consumers)) {
    it(`${name}: N signal updates that leave the marks alone generate each geometry once`, () => {
      // (a session, as <Chart> drives one: it hands the evaluation what did not change, so unchanged marks keep their items)
      const session = createChartSession()
      let scene = session.evaluate(structuredClone(SPEC) as never, {})
      const before = snapshot()
      // (the DOM consumer's first draw is the mount)
      const svg = name === 'dom' ? renderSceneToDomElement(scene, document) : null
      consume(scene, svg)
      const first = delta(before)
      // the first draw generates: 2 lines, 2 areas, 1 trail, 40 arcs, and the symbol shapes at their 4 sizes (if not drawn before)
      expect(first.lineTrace + first.areaTrace + first.trail + first.arc).toBeGreaterThan(0)
      const after = snapshot()
      for (let i = 1; i <= 12; i++) {
        scene = session.change({ signals: { hover: i * 10 } })!
        consume(scene, svg)
      }
      expect(delta(after)).toEqual({ lineTrace: 0, areaTrace: 0, trail: 0, arc: 0, symbol: 0 })
    })
  }

  it('every consumer of one scene shares one generation per mark', () => {
    const scene = evaluateChart(compileChart(structuredClone(SPEC) as never), {})
    const before = snapshot()
    for (const consume of Object.values(consumers)) consume(scene, renderSceneToDomElement(scene, document))
    const d = delta(before)
    // (a line or area is traced at most twice: once straight into its SVG text, once recorded for everything else)
    // (a line or area is traced by each consumer that needs it before the canvas records it -- the SVG text, the hit outline,
    // the bounds -- and replayed after: never more than four times for the six consumers, nor again for a second draw)
    expect([d.trail, d.arc]).toEqual([1, 40])
    expect(d.lineTrace).toBeLessThanOrEqual(2 * 4)
    expect(d.areaTrace).toBeLessThanOrEqual(2 * 4)
    const again = snapshot()
    for (const consume of Object.values(consumers)) consume(scene, renderSceneToDomElement(scene, document))
    expect(delta(again)).toEqual({ lineTrace: 0, areaTrace: 0, trail: 0, arc: 0, symbol: 0 })
  })
})

// --- invalidation: every input, mutated in place, misses ---------------------------------------------------------------------

type Mutation = [label: string, kind: 'line' | 'area' | 'trail' | 'arc' | 'symbol', marktype: string, mutate: (items: SceneItem[], mark: SceneGroup) => void, prepare?: (items: SceneItem[]) => void]

const rec = (it: SceneItem): Record<string, unknown> => it as Record<string, unknown>
const MUTATIONS: Mutation[] = [
  ['line x', 'line', 'line', (its) => { its[3]!.x = (its[3]!.x as number) + 1 }],
  ['line y', 'line', 'line', (its) => { its[3]!.y = (its[3]!.y as number) + 0.001 }],
  ['line defined', 'line', 'line', (its) => { its[5]!.defined = false }],
  ['line interpolate', 'line', 'line', (its) => { rec(its[0]!).interpolate = 'basis' }],
  ['line tension', 'line', 'line', (its) => { rec(its[0]!).interpolate = 'cardinal'; rec(its[0]!).tension = 0.3 }],
  ['line orient (monotone)', 'line', 'line', (its) => { rec(its[0]!).interpolate = 'monotone'; rec(its[0]!).orient = 'horizontal' }],
  ['line append in place', 'line', 'line', (its) => { its.push({ ...its[its.length - 1]!, x: 300 }) }],
  ['line item replaced', 'line', 'line', (its) => { its[2] = { ...its[2]!, y: 3 } }],
  ['line -0', 'line', 'line', (its) => { its[1]!.x = -0; its[1]!.y = 0 }],
  ['area y', 'area', 'area', (its) => { its[4]!.y = (its[4]!.y as number) - 2 }],
  ['area height', 'area', 'area', (its) => { its[4]!.height = 7 }],
  ['area orient', 'area', 'area', (its) => { rec(its[0]!).orient = 'horizontal'; for (const it of its) it.width = 5 }],
  ['area width (horizontal)', 'area', 'area', (its) => { its[2]!.width = 9 }, (its) => { rec(its[0]!).orient = 'horizontal'; for (const it of its) it.width = 5 }],
  ['trail x', 'trail', 'trail', (its) => { its[6]!.x = 1 }],
  ['trail size', 'trail', 'trail', (its) => { its[6]!.size = 30 }],
  ['trail defined', 'trail', 'trail', (its) => { its[6]!.defined = false }],
  ['arc outerRadius', 'arc', 'arc', (its) => { its[1]!.outerRadius = 70 }],
  // (an arc reads `outerRadius` alone, as vega's does: `radius` is a text item's channel)
  ['arc outerRadius removed', 'arc', 'arc', (its) => { delete its[1]!.outerRadius }],
  ['arc innerRadius', 'arc', 'arc', (its) => { its[1]!.innerRadius = 5 }],
  ['arc startAngle', 'arc', 'arc', (its) => { its[1]!.startAngle = 0.5 }],
  ['arc endAngle', 'arc', 'arc', (its) => { its[1]!.endAngle = 3 }],
  ['arc cornerRadius', 'arc', 'arc', (its) => { rec(its[1]!).cornerRadius = 9 }],
  ['arc padAngle', 'arc', 'arc', (its) => { rec(its[1]!).padAngle = 0.05 }],
  ['symbol size', 'symbol', 'symbol', (its) => { its[1]!.size = 777 }],
  ['symbol shape', 'symbol', 'symbol', (its) => { rec(its[1]!).shape = 'M0,0L3,3L-3,3Z' }],
]

describe('invalidation: an input changed in place misses the cache', () => {
  for (const [label, kind, marktype, mutate, prepare] of MUTATIONS) {
    it(label, () => {
      const scene = evaluateChart(compileChart(structuredClone(SPEC) as never), {})
      if (prepare) prepare(marksOf(scene).find((m) => m.mark.marktype === marktype)!.mark.items as SceneItem[])
      // draw everything once: every cache is warm
      expect(diffScene(scene)).toEqual([])
      expect(coldVsWarm(scene, mulberry32(1))).toEqual([])
      const { mark } = marksOf(scene).find((m) => m.mark.marktype === marktype)!
      mutate(mark.items as SceneItem[], mark)
      const before = snapshot()
      // the same objects, drawn again: the old implementation draws the changed scene from scratch
      expect(diffScene(scene)).toEqual([])
      expect(coldVsWarm(scene, mulberry32(2))).toEqual([])
      const d = delta(before)
      expect(kind === 'line' ? d.lineTrace : kind === 'area' ? d.areaTrace : d[kind]).toBeGreaterThan(0)
    })
  }

  it('a mark moved by its group (the hit placement) and a context at another pixel ratio', () => {
    const scene = evaluateChart(compileChart(structuredClone(SPEC) as never), {})
    expect(diffScene(scene)).toEqual([])
      expect(coldVsWarm(scene, mulberry32(1))).toEqual([])
    const facet = (scene.items as SceneGroup[]).find((g) => g.marktype === 'group')!
    const cell = facet.items![0] as SceneGroup
    cell.x = (cell.x ?? 0) + 13
    cell.y = (cell.y ?? 0) - 4
    expect(diffScene(scene)).toEqual([])
    expect(coldVsWarm(scene, mulberry32(2))).toEqual([])
    // (diffScene compared the legacy renderer at dpr 1 and 2, drawing the scene as it caches its geometry: a context at 3 must draw
    // what the legacy renderer draws at 3 on the scene warmed at the other ratios, and the same again)
    const warm = loggingContext()
    renderSceneToCanvas(scene, warm.ctx, { dpr: 3 })
    const legacy = loggingContext()
    legacyCanvas(scene, legacy.ctx, { dpr: 3 })
    expect(warm.log).toEqual(legacy.log)
    expect(warm.log.length).toBeGreaterThan(0)
    const again = loggingContext()
    renderSceneToCanvas(scene, again.ctx, { dpr: 3 })
    expect(again.log, 'the same scene drawn again').toEqual(legacy.log)
    // the ratio is in the drawing: dpr 3 is not what dpr 1 draws
    const one = loggingContext()
    renderSceneToCanvas(scene, one.ctx, { dpr: 1 })
    expect(one.log).not.toEqual(legacy.log)
  })

  it('a new text-metrics provider is seen by every consumer (nothing here caches text)', () => {
    const spec = { width: 100, height: 50, marks: [{ type: 'text', encode: { enter: { x: { value: 10 }, y: { value: 20 }, text: { value: 'hello world' }, fill: { value: '#000' } } } }] }
    const scene = evaluateChart(compileChart(spec as never), {})
    expect(diffScene(scene)).toEqual([])
      expect(coldVsWarm(scene, mulberry32(1))).toEqual([])
    setTextMetricsProvider({ measureWidth: (text: string) => text.length * 13 } as never)
    try {
      expect(diffScene(scene)).toEqual([])
      expect(coldVsWarm(scene, mulberry32(2))).toEqual([])
    } finally {
      setTextMetricsProvider(null)
    }
  })
})
