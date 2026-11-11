// @vitest-environment node
/**
 * Vega-Lite selections end to end, through the chart session as `<Chart>` drives it (the event loop hands each store back as data, a
 * new array on every edit, and the selection's signals): what a signal change, a store change, a data change and the three together
 * keep (see packages/core/src/selection-reuse.test.ts for the engine's side).
 *
 * Every evaluation is the scene a fresh evaluation of the same inputs makes. A top-level view keeps its scales over a point
 * selection's numbered rows (its `identifier` step is kept), keeps the marks that test a store while that store's rows and the
 * signals they name are as they were, and encodes only the rows a pulse names when a signal nothing of its dataset reads moved with
 * the rows. Views inside groups (concat, facet) keep their datasets; their marks are made again, as group marks always are.
 */
import { describe, it, expect } from 'vitest'
import { compile } from '@aster-charts/vl'
import { compileChart, datasetsOfScene, evaluateChart, renderSceneToSvg, type RuntimeInput, type SceneRoot } from '@aster-charts/core'
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

interface Group { name?: string; role?: string; items?: unknown[] }
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
const keptScales = (a: SceneRoot, b: SceneRoot): string[] => [...scales(b).keys()].filter((n) => scales(a).get(n) === scales(b).get(n)).sort()
const allScales = (s: SceneRoot): string[] => [...scales(s).keys()].sort()
/** How many items of the mark are the objects they were, and whether the group is. */
function kept(a: SceneRoot, b: SceneRoot, name: string): { group: boolean; items: number; of: number } {
  const ga = markNamed(a, name)
  const gb = markNamed(b, name)
  const ib = (gb?.items ?? []) as unknown[]
  return { group: ga !== undefined && ga === gb, items: ib.filter((it, i) => it === ga?.items?.[i]).length, of: ib.length }
}
const signalOf = (spec: Spec, name: string): unknown => (spec.signals as Array<{ name: string; value?: unknown }>).find((s) => s.name === name)!.value

const ROWS: Row[] = Array.from({ length: 40 }, (_, i) => ({ a: i, b: (i * 7) % 23, c: `k${i % 4}` }))
const N = ROWS.length
/** A row inside the domains of `a` and `b`, and of a category that is there: the scales' censuses keep them. */
const inside = (rows: Row[], k: number): Row[] => [...rows, { a: (k * 7) % 39 + 0.5, b: (k * 5) % 22 + 0.5, c: 'k1' }]
const nudged = (rows: Row[], at: number): Row[] => rows.map((r, i) => (i === at ? { ...r, b: (r.b as number) + 0.25 } : r))

/** One step of a walk: the inputs it hands the session, and what it must keep of the scene before. */
interface Step {
  what: string
  input: RuntimeInput
  /** the marks whose group (and every item) is kept */
  marks: Record<string, boolean>
  /** the scales kept: all of them, or none */
  scales: 'all' | 'none' | string[]
  /** items of the mark kept by identity (the others were encoded) */
  items?: Record<string, number>
}

function walk(spec: Spec, steps: Step[], first: RuntimeInput): void {
  const session = createChartSession()
  let prev = session.evaluate(spec as never, first)
  // (the first evaluation of a session is not told how rows change: one more, unchanged but for no signal, to start from)
  prev = session.evaluate(spec as never, { ...first, signals: { ...first.signals, unused: 1 } })
  for (const step of steps) {
    const scene = session.evaluate(spec as never, step.input)
    expectFresh(spec, scene, step.input, step.what)
    for (const [m, keep] of Object.entries(step.marks)) expect(kept(prev, scene, m).group, `${step.what}: ${m} kept`).toBe(keep)
    for (const [m, n] of Object.entries(step.items ?? {})) expect(kept(prev, scene, m).items, `${step.what}: ${m} items kept`).toBe(n)
    const want = step.scales === 'all' ? allScales(scene) : step.scales === 'none' ? [] : step.scales
    expect(keptScales(prev, scene), `${step.what}: scales kept`).toEqual(want)
    prev = scene
  }
}

describe('a point selection (click) over a scatter', () => {
  const spec = compile({
    width: 300, height: 150, data: { name: 'src' },
    params: [{ name: 'pick', select: { type: 'point', on: 'click' } }, { name: 'unused', value: 1 }, { name: 'sz', value: 40 }],
    mark: { type: 'point', size: { expr: 'sz' } },
    encoding: {
      x: { field: 'a', type: 'quantitative' }, y: { field: 'b', type: 'quantitative' },
      color: { condition: { param: 'pick', field: 'c', type: 'nominal' }, value: 'grey' },
    },
  } as never)
  const picked = (...ids: number[]): Row[] => ids.map((id) => ({ unit: '', fields: [{ type: 'E', field: '_vgsid_' }], values: [id] }))
  const at = (src: Row[], store: Row[], unused: number, sz = 40): RuntimeInput => ({ data: { src, pick_store: store }, signals: { unused, sz } })

  it('keeps its scales and what reads nothing that changed, through clicks, rows and signals', () => {
    const r1 = inside(ROWS, 1)
    const r2 = nudged(r1, 3)
    const r3 = inside(r2, 2)
    walk(spec, [
      { what: 'a signal nothing reads', input: at(ROWS, [], 2), marks: { marks: true }, scales: 'all', items: { marks: N } },
      { what: 'a click', input: at(ROWS, picked(5), 2), marks: { marks: false }, scales: 'all', items: { marks: 0 } },
      { what: 'the same store, a new array', input: at(ROWS, picked(5), 2), marks: { marks: true }, scales: 'all' },
      { what: 'a signal nothing reads, a point picked', input: at(ROWS, picked(5), 3), marks: { marks: true }, scales: 'all', items: { marks: N } },
      // (the color scale is ordinal, and every category the rows add is one it has: it is kept, and only the new or changed point is
      // encoded; a click encodes every point again, which tests the store)
      { what: 'a row appended and a signal nothing reads', input: at(r1, picked(5), 4), marks: { marks: false }, scales: 'all', items: { marks: N } },
      { what: 'a row modified and a signal nothing reads', input: at(r2, picked(5), 5), marks: { marks: false }, scales: 'all', items: { marks: N } },
      { what: 'a row appended and a click', input: at(r3, picked(5, 9), 5), marks: { marks: false }, scales: 'all', items: { marks: 0 } },
      { what: 'a signal the mark reads', input: at(r3, picked(5, 9), 5, 60), marks: { marks: false }, scales: 'all', items: { marks: 0 } },
      { what: 'a signal nothing reads, after it all', input: at(r3, picked(5, 9), 6, 60), marks: { marks: true }, scales: 'all', items: { marks: N + 2 } },
    ], at(ROWS, [], 1))
  })

  it('a view that fits its container keeps them in both passes', () => {
    const fit = compile({
      width: 'container', height: 150, data: { name: 'src' },
      params: [{ name: 'pick', select: { type: 'point', on: 'click' } }, { name: 'unused', value: 1 }],
      mark: 'point',
      encoding: { x: { field: 'a', type: 'quantitative' }, y: { field: 'b', type: 'quantitative' }, opacity: { condition: { param: 'pick', value: 1 }, value: 0.3 } },
    } as never)
    const atFit = (src: Row[], store: Row[], unused: number): RuntimeInput => ({ ...at(src, store, unused), measuredSize: { width: 420, height: 150 } })
    const r1 = inside(ROWS, 3)
    walk(fit, [
      { what: 'fit: a signal nothing reads', input: atFit(ROWS, [], 2), marks: { marks: true }, scales: 'all', items: { marks: N } },
      { what: 'fit: a click', input: atFit(ROWS, picked(3), 2), marks: { marks: false }, scales: 'all' },
      // (no discrete scale: the append is a pulse through both passes, and only the new row is encoded)
      { what: 'fit: a row appended and a signal nothing reads', input: atFit(r1, picked(3), 3), marks: { marks: false }, scales: 'all', items: { marks: N } },
      { what: 'fit: a signal nothing reads, after it', input: atFit(r1, picked(3), 4), marks: { marks: true }, scales: 'all', items: { marks: N + 1 } },
    ], atFit(ROWS, [], 1))
  })
})

describe('an interval brush that highlights by condition', () => {
  const spec = compile({
    width: 300, height: 150, data: { name: 'src' },
    params: [{ name: 'brush', select: 'interval' }, { name: 'unused', value: 1 }],
    mark: 'point',
    encoding: {
      x: { field: 'a', type: 'quantitative' }, y: { field: 'b', type: 'quantitative' },
      opacity: { condition: { param: 'brush', value: 1 }, value: 0.3 },
    },
  } as never)
  const fields = signalOf(spec, 'brush_tuple_fields')
  const at = (src: Row[], brush: [number, number] | null, unused: number): RuntimeInput => ({
    data: { src, brush_store: brush ? [{ unit: '', fields, values: [brush, [0, 22]] }] : [] },
    signals: { unused, ...(brush ? { brush_x: [brush[0] * 7, brush[1] * 7], brush_y: [0, 150], brush_a: brush, brush_b: [0, 22] } : {}) },
  })
  const marks = (brush: boolean, points: boolean): Record<string, boolean> => ({ brush_brush: brush, brush_brush_bg: brush, marks: points })

  it('keeps the brush, the points and the scales while what each reads stays', () => {
    const r1 = inside(ROWS, 4)
    const r2 = nudged(r1, 7)
    const r3 = r2.filter((_, i) => i !== 11)
    walk(spec, [
      { what: 'a signal nothing reads', input: at(ROWS, null, 2), marks: marks(true, true), scales: 'all' },
      { what: 'a drag starts', input: at(ROWS, [5, 12], 2), marks: marks(false, false), scales: 'all' },
      { what: 'the drag moves', input: at(ROWS, [6, 14], 2), marks: marks(false, false), scales: 'all' },
      { what: 'a signal nothing reads, brushed', input: at(ROWS, [6, 14], 3), marks: marks(true, true), scales: 'all', items: { marks: N } },
      { what: 'a row appended and a signal nothing reads', input: at(r1, [6, 14], 4), marks: marks(true, false), scales: 'all', items: { marks: N } },
      { what: 'a row modified and a signal nothing reads', input: at(r2, [6, 14], 5), marks: marks(true, false), scales: 'all', items: { marks: N } },
      { what: 'a row removed and a signal nothing reads', input: at(r3, [6, 14], 6), marks: marks(true, false), scales: 'all', items: { marks: 11 } },
      { what: 'a row appended while the drag moves', input: at(inside(r3, 5), [7, 15], 6), marks: marks(false, false), scales: 'all', items: { marks: 0 } },
      { what: 'the brush cleared', input: at(inside(r3, 5), null, 6), marks: marks(false, false), scales: 'all' },
    ], at(ROWS, null, 1))
  })
})

describe('a selection bound to the legend', () => {
  const spec = compile({
    width: 300, height: 150, data: { name: 'src' },
    params: [{ name: 'leg', select: { type: 'point', fields: ['c'] }, bind: 'legend' }, { name: 'unused', value: 1 }],
    mark: 'point',
    encoding: {
      x: { field: 'a', type: 'quantitative' }, y: { field: 'b', type: 'quantitative' },
      color: { field: 'c', type: 'nominal' },
      opacity: { condition: { param: 'leg', value: 1 }, value: 0.2 },
    },
  } as never)
  const chosen = (...cs: string[]): Row[] => cs.map((c) => ({ unit: '', fields: [{ type: 'E', field: 'c' }], values: [c] }))
  const at = (src: Row[], store: Row[], unused: number): RuntimeInput => ({ data: { src, leg_store: store }, signals: { unused } })

  it('keeps the points and the scales while the legend selection stays', () => {
    walk(spec, [
      { what: 'a signal nothing reads', input: at(ROWS, [], 2), marks: { marks: true }, scales: 'all', items: { marks: N } },
      { what: 'a category chosen', input: at(ROWS, chosen('k2'), 2), marks: { marks: false }, scales: 'all', items: { marks: 0 } },
      { what: 'a signal nothing reads, a category chosen', input: at(ROWS, chosen('k2'), 3), marks: { marks: true }, scales: 'all' },
      { what: 'another category added', input: at(ROWS, chosen('k2', 'k3'), 3), marks: { marks: false }, scales: 'all' },
      // (the filter of the dataset publishes a pulse with a mapping, over which the color scale's census does not advance; the settings
      // it is made from are the same, so it is kept, and only the modified point is encoded)
      { what: 'a row modified and a signal nothing reads', input: at(nudged(ROWS, 9), chosen('k2', 'k3'), 4), marks: { marks: false }, scales: 'all', items: { marks: N - 1 } },
    ], at(ROWS, [], 1))
  })
})

describe('views inside groups', () => {
  it('a brush that filters another view (a concat): every step is the fresh scene, and the datasets an unread signal leaves are kept', () => {
    const spec = compile({
      data: { name: 'src' },
      params: [{ name: 'unused', value: 1 }],
      vconcat: [
        { width: 200, height: 80, params: [{ name: 'brush', select: { type: 'interval', encodings: ['x'] } }], mark: 'point', encoding: { x: { field: 'a', type: 'quantitative' }, y: { field: 'b', type: 'quantitative' } } },
        { width: 200, height: 80, transform: [{ filter: { param: 'brush' } }], mark: 'point', encoding: { x: { field: 'a', type: 'quantitative' }, y: { field: 'b', type: 'quantitative' } } },
      ],
    } as never)
    // (the brush's signals are the first view's own: its fields are written here as that view declares them)
    const fields = [{ field: 'a', channel: 'x', type: 'R' }]
    const at = (src: Row[], brush: [number, number] | null, unused: number): RuntimeInput => ({
      data: { src, brush_store: brush ? [{ unit: 'concat_0', fields, values: [brush] }] : [] },
      signals: { unused },
    })
    const session = createChartSession()
    let prev = session.evaluate(spec as never, at(ROWS, null, 1))
    prev = session.evaluate(spec as never, at(ROWS, null, 2))
    const steps: Array<[string, RuntimeInput, boolean]> = [
      ['a signal nothing reads', at(ROWS, null, 3), true],
      ['a brush', at(ROWS, [4, 20], 3), false],
      ['a signal nothing reads, brushed', at(ROWS, [4, 20], 4), true],
      ['the brush moves and a row is appended', at(inside(ROWS, 6), [6, 22], 4), false],
      ['a row appended and a signal nothing reads', at(inside(inside(ROWS, 6), 7), [6, 22], 5), false],
      ['a signal nothing reads, after it', at(inside(inside(ROWS, 6), 7), [6, 22], 6), true],
    ]
    for (const [what, input, same] of steps) {
      const scene = session.evaluate(spec as never, input)
      expectFresh(spec, scene, input, what)
      const a = datasetsOfScene(prev)
      const b = datasetsOfScene(scene)
      const sameArrays = [...b.keys()].filter((n) => b.get(n) !== null && a.get(n) === b.get(n))
      if (same) expect(sameArrays.sort(), `${what}: datasets kept`).toEqual([...b.keys()].filter((n) => b.get(n) !== null).sort())
      prev = scene
    }
  })

  it('a point selection in a faceted view: every step is the fresh scene, and an unread signal keeps the numbered rows', () => {
    const spec = compile({
      data: { name: 'src' },
      params: [{ name: 'pick', select: { type: 'point', on: 'click' } }, { name: 'unused', value: 1 }],
      facet: { column: { field: 'c', type: 'nominal' } },
      spec: {
        width: 80, height: 60, mark: 'point',
        encoding: { x: { field: 'a', type: 'quantitative' }, y: { field: 'b', type: 'quantitative' }, opacity: { condition: { param: 'pick', value: 1 }, value: 0.3 } },
      },
    } as never)
    const picked = (...ids: number[]): Row[] => ids.map((id) => ({ unit: 'child__column_c', fields: [{ type: 'E', field: '_vgsid_' }], values: [id] }))
    const at = (src: Row[], store: Row[], unused: number): RuntimeInput => ({ data: { src, pick_store: store }, signals: { unused } })
    const session = createChartSession()
    let prev = session.evaluate(spec as never, at(ROWS, [], 1))
    prev = session.evaluate(spec as never, at(ROWS, [], 2))
    // (`true`: the numbered rows are the array they were; a pulse advances the engine's array in place, so a step that changes rows
    // is checked by the scene alone)
    const steps: Array<[string, RuntimeInput, boolean | null]> = [
      ['a signal nothing reads', at(ROWS, [], 3), true],
      // (a click edits the store, which the numbered rows do not read)
      ['a click', at(ROWS, picked(4), 3), true],
      ['a signal nothing reads, a point picked', at(ROWS, picked(4), 4), true],
      ['a row appended and a signal nothing reads', at(inside(ROWS, 8), picked(4), 5), null],
      ['a row modified, a click', at(nudged(inside(ROWS, 8), 2), picked(4, 7), 5), null],
      ['a signal nothing reads, after them', at(nudged(inside(ROWS, 8), 2), picked(4, 7), 6), true],
    ]
    for (const [what, input, same] of steps) {
      const scene = session.evaluate(spec as never, input)
      expectFresh(spec, scene, input, what)
      const numbered = [...datasetsOfScene(scene).entries()].filter(([, rows]) => (rows as Row[] | null)?.some((r) => '_vgsid_' in r)).map(([n]) => n)
      expect(numbered.length, `${what}: a numbered dataset`).toBeGreaterThan(0)
      if (same !== null) for (const n of numbered) expect(datasetsOfScene(scene).get(n) === datasetsOfScene(prev).get(n), `${what}: ${n} kept`).toBe(same)
      prev = scene
    }
  })
})
