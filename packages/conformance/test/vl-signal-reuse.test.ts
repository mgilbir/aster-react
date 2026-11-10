// @vitest-environment node
/**
 * Vega-Lite charts whose signals move all the time keep what reads none of them (see packages/core/src/signal-reuse.test.ts):
 *  - a `time` animation: its clock ticks at 60 fps, and the marks read the frame's rows, which change only when the frame's
 *    value does. A tick keeps the mark group, every item and every scale; a new frame makes the marks again;
 *  - interval (brush) and point (hover) selections: the brush's marks and the points test a selection's store (they read datasets
 *    from an expression), so they are made again whenever anything moves. The scales of a brushed chart are made from rows that do
 *    not move, and are kept; a point selection numbers the rows (`identifier`), which a re-evaluation makes again, and the scales
 *    made from them with them.
 * Every evaluation is the scene a fresh evaluation of the same inputs makes.
 */
import { describe, it, expect } from 'vitest'
import { compile } from '@aster-charts/vl'
import { compileChart, evaluateChart, renderSceneToSvg, type RuntimeInput, type SceneRoot } from '@aster-charts/core'
import { createChartSession } from '@aster-charts/core/dom'

type Row = Record<string, unknown>
type Spec = ReturnType<typeof compile>

const SKIP_KEYS = new Set(['runtime', 'compiled', '__scaleMap', '__gen', '__itemGen', '__domDesc', '__source'])
function norm(v: unknown, depth = 0): unknown {
  if (depth > 40) return '[deep]'
  if (v === undefined || v === null || typeof v === 'string' || typeof v === 'boolean') return v
  if (typeof v === 'number') return Number.isNaN(v) ? '[NaN]' : v === Infinity ? '[Inf]' : v === -Infinity ? '[-Inf]' : v
  if (typeof v === 'function') return '[fn]'
  if (v instanceof Date) return { $date: v.getTime() }
  if (v instanceof Map || v instanceof Set) return '[collection]'
  if (Array.isArray(v)) return v.map((x) => { const n = norm(x, depth + 1); return n === undefined ? null : n })
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(v as object).sort()) {
    if (SKIP_KEYS.has(k)) continue
    const n = norm((v as Record<string, unknown>)[k], depth + 1)
    if (n !== undefined) out[k] = n
  }
  return out
}

function expectFresh(spec: Spec, scene: SceneRoot, input: RuntimeInput, what: string): void {
  const want = evaluateChart(compileChart(spec as never), input)
  expect(norm(scene), what).toEqual(norm(want))
  expect(renderSceneToSvg(scene), what).toBe(renderSceneToSvg(want))
}

interface Group { name?: string; role?: string; marktype?: string; items?: unknown[] }
function markNamed(scene: SceneRoot, name: string): Group | undefined {
  const walk = (items: readonly unknown[]): Group | undefined => {
    for (const it of items) {
      const g = it as Group
      if (g.role === 'mark' && g.name === name) return g
      if (Array.isArray(g.items)) { const found = walk(g.items); if (found) return found }
    }
    return undefined
  }
  return walk(scene.items)
}
const scales = (scene: SceneRoot): Map<string, unknown> => (scene as unknown as { __scaleMap: Map<string, unknown> }).__scaleMap
/** The mark's group is the same object, and so is every item of it. */
function keptMark(a: SceneRoot, b: SceneRoot, name: string): boolean {
  const ga = markNamed(a, name)
  const gb = markNamed(b, name)
  return ga !== undefined && ga === gb && (ga.items ?? []).every((it, i) => it === gb.items?.[i])
}
const keptScales = (a: SceneRoot, b: SceneRoot): string[] => [...scales(b).keys()].filter((n) => scales(a).get(n) === scales(b).get(n)).sort()

describe('a vega-lite `time` animation', () => {
  const rows: Row[] = [1990, 1991, 1992].flatMap((year) => Array.from({ length: 40 }, (_, i) => ({ year, x: i, y: (i * 7 + year) % 50 })))
  const spec = compile({
    width: 300, height: 150, data: { name: 'src' },
    params: [{ name: 'anim', select: { type: 'point', on: 'timer', fields: ['year'] } }],
    transform: [{ filter: { param: 'anim' } }], mark: 'point',
    encoding: { x: { field: 'x', type: 'quantitative' }, y: { field: 'y', type: 'quantitative' }, time: { field: 'year', type: 'ordinal' } },
  } as never)
  const fields = (spec.signals as Array<{ name: string; value?: unknown }>).find((s) => s.name === 'anim_tuple_fields')!.value
  const frame = (year: number): Row[] => [{ unit: '', fields, values: [year] }]

  for (const route of ['inline values', 'host data'] as const) {
    it(`${route}: a tick keeps the marks, their items and the scales; a new frame makes the marks again; each is a fresh evaluation`, () => {
      const vg = route === 'inline values' ? { ...spec, data: (spec.data as Row[]).map((d) => (d.name === 'src' ? { ...d, values: rows } : d)) } as Spec : spec
      const session = createChartSession()
      const input = (clock: number, store: Row[]): RuntimeInput => ({ data: { ...(route === 'host data' ? { src: rows } : {}), anim_store: store }, signals: { anim_clock: clock, last_tick_at: 0 } })
      let prev = session.evaluate(vg as never, input(10, []))
      expectFresh(vg, prev, input(10, []), 'first')
      const ticks: Array<{ clock: number; store: Row[]; keeps: boolean }> = [
        { clock: 26, store: [], keeps: true },
        { clock: 42, store: [], keeps: true },
        // (the frame moves: the store holds another year, and the rows the marks read change)
        { clock: 520, store: frame(1991), keeps: false },
        // (the same frame, a new store array: the event loop copies it on every tick)
        { clock: 536, store: frame(1991), keeps: true },
        { clock: 552, store: frame(1991), keeps: true },
        { clock: 1030, store: frame(1992), keeps: false },
        { clock: 1046, store: [], keeps: false },
      ]
      for (const t of ticks) {
        const scene = session.evaluate(vg as never, input(t.clock, t.store))
        const what = `${route}: clock ${t.clock}, store ${JSON.stringify(t.store.map((r) => r.values))}`
        expectFresh(vg, scene, input(t.clock, t.store), what)
        expect(keptMark(prev, scene, 'marks'), `${what}: the marks kept`).toBe(t.keeps)
        // (the scales are made from all the rows, not the frame's)
        expect(keptScales(prev, scene), `${what}: the scales kept`).toEqual([...scales(scene).keys()].sort())
        prev = scene
      }
    })
  }
})

describe('vega-lite selections', () => {
  const rows: Row[] = Array.from({ length: 30 }, (_, i) => ({ a: i, b: (i * 7) % 11, c: `k${i % 3}` }))
  const spec = compile({
    width: 200, height: 100, data: { name: 'src' },
    params: [
      { name: 'brush', select: 'interval' },
      { name: 'hover', select: { type: 'point', on: 'pointerover' } },
      { name: 'unused', value: 1 },
    ],
    mark: 'point',
    encoding: {
      x: { field: 'a', type: 'quantitative' }, y: { field: 'b', type: 'quantitative' },
      color: { condition: { param: 'brush', field: 'c', type: 'nominal' }, value: 'grey' },
      size: { condition: { param: 'hover', empty: false, value: 200 }, value: 50 },
    },
  } as never)
  const signal = (name: string): unknown => (spec.signals as Array<{ name: string; value?: unknown }>).find((s) => s.name === name)!.value
  const brushTuple = (lo: number, hi: number): Row => ({ unit: '', fields: signal('brush_tuple_fields'), values: [[lo, hi], [0, 10]] })
  const hoverTuple = (i: number): Row => ({ unit: '', fields: [{ type: 'E', field: '_vgsid_' }], values: [i + 1] })

  it('a brush drag, a hover and a signal no mark reads make the scene a fresh evaluation makes', () => {
    const session = createChartSession()
    type World = { brush: [number, number] | null; hover: number | null; unused: number }
    const input = (w: World): RuntimeInput => ({
      data: { src: rows, brush_store: w.brush ? [brushTuple(w.brush[0], w.brush[1])] : [], hover_store: w.hover !== null ? [hoverTuple(w.hover)] : [] },
      signals: { unused: w.unused, ...(w.brush ? { brush_x: [w.brush[0] * 6, w.brush[1] * 6], brush_y: [0, 100] } : {}) },
    })
    const worlds: World[] = [
      { brush: [2, 9], hover: null, unused: 1 },
      { brush: [2, 9], hover: null, unused: 2 },
      { brush: [3, 12], hover: null, unused: 2 },
      { brush: [3, 12], hover: 4, unused: 2 },
      { brush: [3, 12], hover: 4, unused: 3 },
      { brush: [3, 12], hover: 7, unused: 4 },
      { brush: null, hover: 7, unused: 4 },
    ]
    let prev = session.evaluate(spec as never, input({ brush: null, hover: null, unused: 1 }))
    for (const w of worlds) {
      const scene = session.evaluate(spec as never, input(w))
      const what = JSON.stringify(w)
      expectFresh(spec, scene, input(w), what)
      for (const mark of ['brush_brush', 'brush_brush_bg', 'marks']) expect(keptMark(prev, scene, mark), `${what}: ${mark} kept`).toBe(false)
      prev = scene
    }
  })

  it('a brushed chart keeps its scales through a drag and a signal no mark reads', () => {
    const brushed = compile({
      width: 200, height: 100, data: { name: 'src' },
      params: [{ name: 'brush', select: 'interval' }, { name: 'unused', value: 1 }],
      mark: 'point',
      encoding: { x: { field: 'a', type: 'quantitative' }, y: { field: 'b', type: 'quantitative' }, color: { condition: { param: 'brush', field: 'c', type: 'nominal' }, value: 'grey' } },
    } as never)
    const session = createChartSession()
    const input = (lo: number, unused: number): RuntimeInput => ({
      data: { src: rows, brush_store: [brushTuple(lo, 9)] }, signals: { unused, brush_x: [lo * 6, 54], brush_y: [0, 100] },
    })
    let prev = session.evaluate(brushed as never, input(2, 1))
    for (const [lo, unused] of [[2, 2], [3, 2], [3, 3]] as const) {
      const scene = session.evaluate(brushed as never, input(lo, unused))
      expectFresh(brushed, scene, input(lo, unused), `brush ${lo}, unused ${unused}`)
      expect(keptScales(prev, scene)).toEqual(['color', 'x', 'y'])
      prev = scene
    }
  })
})
