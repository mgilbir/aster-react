/**
 * What a signal change keeps beyond what signal-reuse.test.ts pins: the three cases that #136 left to a full rebuild.
 *
 *  1. A dataset with transforms is built again in a later round of a pass (once a signal that reads data resolves) and in the
 *     second pass of a view that fits its viewport. Over the same input arrays, under the same reads, it is the build before: its
 *     rows, its pulse, the numbers its `identifier`s drew, the signals it published (`keptBuild` in runtime.ts). A point selection's
 *     dataset is no longer new on every signal change, and the scales over it are kept.
 *  2. A mark whose expressions read datasets by the names they spell out (a selection test) is keyed by those datasets' rows and
 *     the signals it names, not by every signal (`markKeyOf`).
 *  3. A pulse runs through a pipeline whose reads are as they were, whichever other signals changed (`pipelineKey`), and a scale
 *     whose key is unchanged advances its census over it.
 *
 * Each test pins the scene a fresh evaluation makes (or, for the numbers an `identifier` draws, which depend on how the view got
 * there, the scene of a chart evaluated through the same states with no hint of what changed: incremental-oracle.test.ts's rule),
 * and the reuse itself: mark groups, items, scales and dataset arrays by identity, and the items each mark encodes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import './addon-transforms.js'
import { compileChart } from './compiler.js'
import { evaluateChart } from './evaluate.js'
import { registerExpressionFunction } from './expression.js'
import { createChartSession } from './session.js'
import { datasetsOfScene, renderSceneToSvg } from './index.js'
import { reuse, stepCounts } from './step-reuse.js'
import type { CompiledChart, RuntimeInput, SceneGroup, SceneItem, SceneRoot, VgSpec } from './types.js'

type Row = Record<string, unknown>

// `srCount(<mark>)` is read once per item a mark encodes.
const encodes = new Map<string, number>()
let dispose: (() => void) | undefined
beforeAll(() => {
  dispose = registerExpressionFunction('srCount', (name: string) => { encodes.set(name, (encodes.get(name) ?? 0) + 1); return 30 })
})
afterAll(() => dispose?.())
const counter = (name: string): { signal: string } => ({ signal: `srCount('${name}')` })
/** The items each mark encodes while `run` runs. */
function encodedBy(run: () => SceneRoot): { scene: SceneRoot; encoded: Record<string, number> } {
  const before = new Map(encodes)
  const scene = run()
  const encoded: Record<string, number> = {}
  for (const [k, v] of encodes) if (v !== (before.get(k) ?? 0)) encoded[k] = v - (before.get(k) ?? 0)
  return { scene, encoded }
}

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

/** `scene` is `want`: the scene itself (items, data, scales) and its SVG. */
function expectSame(scene: SceneRoot, want: SceneRoot, what: string): void {
  expect(norm(scene), what).toEqual(norm(want))
  expect(renderSceneToSvg(scene), what).toBe(renderSceneToSvg(want))
}
const expectFresh = (spec: VgSpec, scene: SceneRoot, input: RuntimeInput, what: string): void => expectSame(scene, evaluateChart(compileChart(spec), input), what)

function groupNamed(scene: SceneRoot, name: string): SceneGroup | undefined {
  const walk = (items: readonly unknown[]): SceneGroup | undefined => {
    for (const it of items) {
      const g = it as SceneGroup
      if (g.role === 'mark' && (g as { name?: string }).name === name) return g
      const inner = (g as { items?: unknown[] }).items
      if (Array.isArray(inner)) { const found = walk(inner); if (found) return found }
    }
    return undefined
  }
  return walk(scene.items)
}
const scaleOf = (scene: SceneRoot, name: string): unknown => (scene as unknown as { __scaleMap: Map<string, unknown> }).__scaleMap.get(name)
/** The mark's group is the same object, and so is every item of it. */
function keptMark(a: SceneRoot, b: SceneRoot, name: string): boolean {
  const ga = groupNamed(a, name)
  const gb = groupNamed(b, name)
  return ga !== undefined && ga === gb && (ga.items as SceneItem[]).every((it, i) => it === (gb.items as SceneItem[])[i])
}
/** How many items of the mark are the objects they were (by index). */
function keptItems(a: SceneRoot, b: SceneRoot, name: string): number {
  const ia = (groupNamed(a, name)?.items ?? []) as SceneItem[]
  const ib = (groupNamed(b, name)?.items ?? []) as SceneItem[]
  return ib.filter((it, i) => it === ia[i]).length
}
const rowsOf = (scene: SceneRoot, name: string): readonly unknown[] | null | undefined => datasetsOfScene(scene).get(name)

const quiet = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} }

// ---------------------------------------------------------------------------------------------------------------------------------
// The chart: a point selection over rows numbered by an `identifier`
// ---------------------------------------------------------------------------------------------------------------------------------

const POINT = {
  width: 200, height: 100, padding: 5, autosize: 'none',
  signals: [
    { name: 'u', value: 0 },
    { name: 'k', value: -1 },
    { name: 'op', value: 1 },
    // (reads a dataset: resolved once the datasets are built, so every evaluation builds them in two rounds, as a Vega-Lite
    // selection's `vlSelectionResolve` signal makes it)
    { name: 'picked', update: "length(data('store'))" },
  ],
  data: [
    { name: 'store', transform: [{ type: 'collect', sort: { field: '_vgsid_' } }] },
    { name: 't' },
    { name: 'd', source: 't', transform: [{ type: 'identifier', as: '_vgsid_' }, { type: 'formula', as: 'w', expr: 'datum.v * 2' }, { type: 'filter', expr: 'datum.v > k' }] },
  ],
  scales: [
    { name: 'x', type: 'linear', domain: { data: 'd', field: 'v' }, range: 'width' },
    { name: 'y', type: 'linear', domain: { data: 'd', field: 'w' }, range: 'height' },
  ],
  marks: [
    // reads no signal but the view's
    { type: 'symbol', name: 'plain', from: { data: 'd' }, encode: { update: { x: { scale: 'x', field: 'v' }, y: { scale: 'y', field: 'w' }, size: counter('plain') } } },
    // tests the selection's store, and reads `op`
    {
      type: 'symbol', name: 'tested', from: { data: 'd' },
      encode: { update: { x: { scale: 'x', field: 'v' }, opacity: [{ test: "!length(data('store')) || vlSelectionIdTest('store', datum)", signal: 'op' }, { value: 0.2 }], size: counter('tested') } },
    },
  ],
} as unknown as VgSpec

const ROWS: Row[] = Array.from({ length: 12 }, (_, i) => ({ v: i, g: `g${i % 3}` }))
const N = ROWS.length

interface PointWorld { t: Row[]; store: Row[]; u: number; k: number; op: number }
const pointInput = (w: PointWorld, extra: Partial<RuntimeInput> = {}): RuntimeInput => ({ data: { t: w.t, store: w.store }, signals: { u: w.u, k: w.k, op: w.op }, ...extra })
const pick = (...ids: number[]): Row[] => ids.map((id) => ({ unit: '', _vgsid_: id }))

/** One step of a walk: the world it makes, what it encodes, which marks keep their group, and which scales their object. */
interface PointStep { what: string; to: (w: PointWorld) => PointWorld; encodes: Record<string, number>; kept: string[]; scales: string[]; sameRows?: boolean }
const BOTH = ['plain', 'tested']
const SCALES = ['x', 'y']
const append = (rows: Row[], v: number): Row[] => [...rows, { v, g: 'g9' }]
const modify = (rows: Row[], at: number): Row[] => rows.map((r, i) => (i === at ? { ...r, g: 'gx' } : r))

const POINT_STEPS: PointStep[] = [
  { what: 'a signal nothing reads', to: (w) => ({ ...w, u: w.u + 1 }), encodes: {}, kept: BOTH, scales: SCALES, sameRows: true },
  { what: 'the store, equal rows in a new array', to: (w) => ({ ...w, store: w.store.map((r) => ({ ...r })) }), encodes: {}, kept: BOTH, scales: SCALES, sameRows: true },
  { what: 'a point picked', to: (w) => ({ ...w, store: pick(4) }), encodes: { tested: N }, kept: ['plain'], scales: SCALES, sameRows: true },
  { what: 'a signal nothing reads, a point picked', to: (w) => ({ ...w, u: w.u + 1 }), encodes: {}, kept: BOTH, scales: SCALES, sameRows: true },
  { what: 'a signal the tested mark reads', to: (w) => ({ ...w, op: 0.8 }), encodes: { tested: N }, kept: ['plain'], scales: SCALES, sameRows: true },
  // (the pulse runs through the pipeline whatever `u` is, and the census keeps the scales: only the new row is encoded)
  { what: 'a row appended and a signal nothing reads', to: (w) => ({ ...w, t: append(w.t, 5.5), u: w.u + 1 }), encodes: { plain: 1, tested: 1 }, kept: [], scales: SCALES },
  { what: 'a row modified and a signal nothing reads', to: (w) => ({ ...w, t: modify(w.t, 3), u: w.u + 1 }), encodes: { plain: 1, tested: 1 }, kept: [], scales: SCALES },
  // (14 rows: the tested mark encodes each against the new store)
  { what: 'a row appended and a point picked', to: (w) => ({ ...w, t: append(w.t, 6.5), store: pick(4, 9) }), encodes: { plain: 1, tested: N + 2 }, kept: [], scales: SCALES },
  { what: 'a row appended and a signal the tested mark reads', to: (w) => ({ ...w, t: append(w.t, 7.5), op: 0.6 }), encodes: { plain: 1, tested: N + 3 }, kept: [], scales: SCALES },
  // (the filter reads `k`: the dataset is made again, and the marks and scales with it; 12 of the 15 rows have `v > 2`, 12 of 16 `v > 3`)
  { what: 'a signal the pipeline reads', to: (w) => ({ ...w, k: 2 }), encodes: { plain: 12, tested: 12 }, kept: [], scales: [] },
  { what: 'a row appended and a signal the pipeline reads', to: (w) => ({ ...w, t: append(w.t, 8.5), k: 3 }), encodes: { plain: 12, tested: 12 }, kept: [], scales: [] },
  { what: 'nothing', to: (w) => w, encodes: {}, kept: BOTH, scales: SCALES, sameRows: true },
]

describe('a point selection over numbered rows: its dataset, scales and marks across signal changes', () => {
  const START: PointWorld = { t: ROWS, store: [], u: 0, k: -1, op: 1 }
  const routes: Array<[string, (spec: VgSpec) => (w: PointWorld) => SceneRoot]> = [
    ['a session', (spec) => { const s = createChartSession(); return (w) => s.evaluate(spec, pointInput(w)) }],
    // (told what changed: the rows of `t` when they changed, a dataset nothing reads otherwise)
    ['evaluateChart told what changed', (spec) => {
      const chart = compileChart(spec)
      let was: PointWorld | undefined
      return (w) => {
        const changed = was === undefined ? [] : [...(was.t !== w.t ? ['t'] : []), ...(was.store !== w.store ? ['store'] : [])]
        was = w
        return evaluateChart(chart, pointInput(w, { changedDatasets: changed.length ? changed : ['nothing'] }))
      }
    }],
  ]
  for (const [route, make] of routes) {
    it(`${route}: each step is the scene a fresh evaluation makes, and keeps what reads nothing that changed`, () => {
      const run = make(POINT)
      let w = START
      let prev = run(w)
      expectFresh(POINT, prev, pointInput(w), `${route}: first`)
      for (const step of POINT_STEPS) {
        w = step.to(w)
        const before = stepCounts.ran
        const { scene, encoded } = encodedBy(() => run(w))
        const ran = stepCounts.ran - before
        const what = `${route}: ${step.what}`
        expectFresh(POINT, scene, pointInput(w), what)
        if (route === 'a session' || !step.what.startsWith('a row')) {
          expect(encoded, `${what}: items encoded`).toEqual(step.encodes)
          expect(BOTH.filter((m) => keptMark(prev, scene, m)), `${what}: marks kept`).toEqual(step.kept)
          expect(SCALES.filter((n) => scaleOf(prev, n) === scaleOf(scene, n)), `${what}: scales kept`).toEqual(step.scales)
        }
        if (step.sameRows) {
          // (the dataset is the array it was: no step of it ran, the `identifier` included, in either round)
          expect(rowsOf(scene, 'd'), `${what}: the dataset kept`).toBe(rowsOf(prev, 'd'))
          if (route === 'a session') expect(ran, `${what}: steps run`).toBe(0)
        }
        prev = scene
      }
    })
  }

  it('evaluateChart told what changed: a row appended keeps the items of the rows before it', () => {
    // (`changedDatasets` says which dataset changed, not how: the marks are made again but for the items the census-kept scales and
    // equal rows let them keep -- here none, as the route has no pulse; the scene is the fresh one, which is what the walk pins)
    const chart = compileChart(POINT)
    evaluateChart(chart, pointInput(START))
    const w = { ...START, t: append(START.t, 5.5), u: 1 }
    const scene = evaluateChart(chart, pointInput(w, { dataPulse: { t: { appendOnly: true, baseLength: N, changed: [] } } }))
    expectFresh(POINT, scene, pointInput(w), 'evaluateChart, a pulse and a signal nothing reads')
  })

  it('a view that fits its container keeps the dataset, the scales and the marks in both passes', () => {
    const spec = { ...POINT, autosize: { type: 'fit', contains: 'padding' } } as unknown as VgSpec
    const s = createChartSession()
    const input = (w: PointWorld): RuntimeInput => pointInput(w, { width: 300, height: 160 })
    let w = START
    let prev = s.evaluate(spec, input(w))
    const steps: Array<[string, (w: PointWorld) => PointWorld, boolean, number]> = [
      ['a signal nothing reads', (x) => ({ ...x, u: 1 }), true, N],
      ['a point picked', (x) => ({ ...x, store: pick(2) }), true, N],
      ['a row appended and a signal nothing reads', (x) => ({ ...x, t: append(x.t, 4.5), u: 2 }), false, N],
      ['a signal nothing reads, again', (x) => ({ ...x, u: 3 }), true, N + 1],
    ]
    for (const [what, to, plainKept, keptPlainItems] of steps) {
      w = to(w)
      const scene = s.evaluate(spec, input(w))
      expectFresh(spec, scene, input(w), `fit: ${what}`)
      expect(keptMark(prev, scene, 'plain'), `fit: ${what}: plain kept`).toBe(plainKept)
      expect(keptItems(prev, scene, 'plain'), `fit: ${what}: plain items kept`).toBe(keptPlainItems)
      expect(SCALES.filter((n) => scaleOf(prev, n) === scaleOf(scene, n)), `fit: ${what}: scales kept`).toEqual(SCALES)
      prev = scene
    }
  })

  it('under limits, a signal change keeps neither the dataset nor what reads it (nothing kept is counted again)', () => {
    const s = createChartSession()
    const input = (w: PointWorld): RuntimeInput => pointInput(w, { limits: { maxItems: 10_000 } })
    const a = s.evaluate(POINT, input(START))
    const w = { ...START, t: append(START.t, 5.5), u: 1 }
    const { scene, encoded } = encodedBy(() => s.evaluate(POINT, input(w)))
    expectFresh(POINT, scene, input(w), 'limits')
    expect(encoded).toEqual({ plain: N + 1, tested: N + 1 })
    expect(SCALES.filter((n) => scaleOf(a, n) === scaleOf(scene, n))).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------------------------------------------
// The numbers an `identifier` draws, and the view's id counter, when a build is kept
// ---------------------------------------------------------------------------------------------------------------------------------

describe('a kept build leaves the id counter where running it again would', () => {
  // (two numbered datasets draw from one counter, in order; `picked` reads data, so each evaluation builds them in two rounds)
  const spec = {
    width: 100, height: 50, autosize: 'none',
    signals: [{ name: 'u', value: 0 }, { name: 'picked', update: "length(data('store'))" }],
    data: [
      { name: 'store' },
      { name: 'a', transform: [{ type: 'identifier', as: 'id' }] },
      { name: 'b', transform: [{ type: 'identifier', as: 'id' }] },
    ],
    marks: [
      { type: 'symbol', from: { data: 'a' }, encode: { update: { x: { field: 'id' } } } },
      { type: 'symbol', from: { data: 'b' }, encode: { update: { x: { field: 'id' } } } },
    ],
  } as unknown as VgSpec
  const ra: Row[] = [{ v: 1 }, { v: 2 }, { v: 3 }]
  const rb: Row[] = [{ v: 10 }, { v: 20 }]
  type State = { a: Row[]; b: Row[]; u: number }
  const input = (s: State): RuntimeInput => ({ data: { store: [], a: s.a, b: s.b }, signals: { u: s.u } })
  const states: State[] = [
    { a: ra, b: rb, u: 0 },
    // (a new row of `a` is numbered past every number the view handed out: the counter moves, in both rounds)
    { a: [...ra, { v: 4 }], b: rb, u: 1 },
    { a: [...ra, { v: 4 }], b: rb, u: 2 },
    // (a new row of `b` is numbered from where the counter stands)
    { a: [...ra, { v: 4 }], b: [...rb, { v: 30 }], u: 3 },
    { a: [...ra, { v: 4 }, { v: 5 }], b: [...rb, { v: 30 }], u: 3 },
  ]

  it('the numbers are those of the chart evaluated through the same states with no hint of what changed', () => {
    const session = createChartSession()
    // (incremental-oracle.test.ts's reference for a view that numbers rows: the numbers depend on how the view got there)
    const kept = compileChart(spec) as CompiledChart
    for (const [i, s] of states.entries()) {
      const scene = session.evaluate(spec, input(s))
      const want = evaluateChart(kept, input(s))
      expectSame(scene, want, `state ${i}`)
      const ids = (name: string): unknown[] => (rowsOf(scene, name) as Row[]).map((r) => r.id)
      expect([...ids('a'), ...ids('b')], `state ${i}: no number is handed out twice`).toEqual([...new Set([...ids('a'), ...ids('b')])])
    }
  })
})

// ---------------------------------------------------------------------------------------------------------------------------------
// What a build kept from a round before reads besides its input rows
// ---------------------------------------------------------------------------------------------------------------------------------

describe('a build is kept from the round before only over the same inputs and reads', () => {
  it('a dataset whose source the round before built otherwise is copied again', () => {
    // (`s` reads a scale: the first round builds it before the scales are, the second after; `c` copies `s`, and a copy of the
    // first round's rows is not the copy of the second's)
    const spec = {
      width: 100, height: 50, autosize: 'none',
      signals: [{ name: 'u', value: 0 }, { name: 'picked', update: "length(data('store'))" }],
      scales: [{ name: 'x', type: 'linear', domain: [0, 100], range: [0, 100] }],
      data: [
        { name: 'store' }, { name: 't' },
        { name: 's', source: 't', transform: [{ type: 'filter', expr: "scale('x', datum.v) < picked" }] },
        { name: 'c', source: 's' },
        { name: 'e', source: 's', transform: [{ type: 'formula', as: 'w', expr: 'datum.v + 1' }] },
      ],
      marks: [
        { type: 'symbol', name: 'copied', from: { data: 'c' }, encode: { update: { x: { field: 'v' } } } },
        { type: 'symbol', name: 'formula', from: { data: 'e' }, encode: { update: { x: { field: 'w' } } } },
      ],
    } as unknown as VgSpec
    const s = createChartSession()
    const input = (store: number, u: number): RuntimeInput => ({ data: { t: ROWS, store: Array.from({ length: store }, (_, i) => ({ i })) }, signals: { u } })
    for (const [store, u] of [[2, 0], [2, 1], [3, 1], [3, 2], [0, 2]] as const) {
      const scene = s.evaluate(spec, input(store, u))
      expectFresh(spec, scene, input(store, u), `store ${store}, u ${u}`)
      expect((rowsOf(scene, 'c') as Row[]).length).toBe(store)
    }
  })

  it('a step that publishes a signal publishes it again when its build is kept', () => {
    const spec = {
      width: 100, height: 50, autosize: 'none',
      signals: [{ name: 'u', value: 0 }, { name: 'picked', update: "length(data('store'))" }, { name: 'span', update: 'ext ? ext[1] - ext[0] : -1' }],
      data: [
        { name: 'store' }, { name: 't' },
        { name: 'd', source: 't', transform: [{ type: 'formula', as: 'w', expr: 'datum.v * 3' }, { type: 'extent', field: 'w', signal: 'ext' }] },
      ],
      marks: [{ type: 'text', name: 'span', encode: { update: { text: { signal: "span + ':' + picked" }, x: { value: 1 } } } }],
    } as unknown as VgSpec
    const s = createChartSession()
    const input = (rows: Row[], u: number): RuntimeInput => ({ data: { t: rows, store: [] }, signals: { u } })
    for (const [rows, u] of [[ROWS, 0], [ROWS, 1], [append(ROWS, 20), 1], [append(ROWS, 20), 2]] as const) {
      const scene = s.evaluate(spec, input(rows, u))
      expectFresh(spec, scene, input(rows, u), `${rows.length} rows, u ${u}`)
    }
  })
})

// ---------------------------------------------------------------------------------------------------------------------------------
// Marks that read datasets by name
// ---------------------------------------------------------------------------------------------------------------------------------

describe('a mark that reads a dataset by name is kept while those rows and the signals it names are as they were', () => {
  // (a data function's first argument is a string literal: the expression compiler refuses any other, as vega's does, so the
  // datasets an encode reads are the ones its expressions spell out)
  const spec = {
    width: 200, height: 100, autosize: 'none',
    signals: [{ name: 'u', value: 0 }, { name: 'hl', value: 'red' }],
    data: [{ name: 't' }, { name: 'store' }, { name: 'big' }],
    marks: [
      // a selection test (by field tuples), and a signal it names
      { type: 'rect', name: 'brushed', from: { data: 't' }, encode: { update: { x: { field: 'v' }, width: { value: 2 }, height: { value: 2 }, fill: [{ test: "!length(data('store')) || vlSelectionTest('store', datum)", signal: 'hl' }, { value: 'grey' }], strokeWidth: counter('brushed') } } },
      // a dataset too long to be keyed by its rows: by the array
      { type: 'symbol', name: 'long', from: { data: 't' }, encode: { update: { x: { field: 'v' }, size: { signal: `length(data('big')) + srCount('long')` } } } },
    ],
  } as unknown as VgSpec
  const brush = (lo: number, hi: number): Row[] => [{ unit: '', fields: [{ field: 'v', type: 'R' }], values: [[lo, hi]] }]
  const BIG = Array.from({ length: 600 }, (_, i) => ({ i }))
  type W = { store: Row[]; big: Row[]; u: number; hl: string }
  const input = (w: W): RuntimeInput => ({ data: { t: ROWS, store: w.store, big: w.big }, signals: { u: w.u, hl: w.hl } })
  const steps: Array<{ what: string; to: (w: W) => W; encodes: Record<string, number> }> = [
    // (the first evaluation of a session is not told how rows change: what reads a dataset keyed by its array is made again once)
    { what: 'a signal nothing names, first', to: (w) => ({ ...w, u: 1 }), encodes: { long: N } },
    { what: 'a signal nothing names', to: (w) => ({ ...w, u: 3 }), encodes: {} },
    { what: 'the store, equal rows in a new array', to: (w) => ({ ...w, store: brush(2, 5) }), encodes: {} },
    { what: 'the brush moved', to: (w) => ({ ...w, store: brush(3, 7) }), encodes: { brushed: N } },
    { what: 'a signal the selection test names', to: (w) => ({ ...w, hl: 'blue' }), encodes: { brushed: N } },
    { what: 'the brush cleared, and a signal nothing names', to: (w) => ({ ...w, store: [], u: 2 }), encodes: { brushed: N } },
    // (a long dataset is keyed by the array: equal rows in a new array the session vouches for are the array it kept)
    { what: 'the long dataset, equal rows in a new array', to: (w) => ({ ...w, big: BIG.map((r) => ({ ...r })) }), encodes: {} },
    { what: 'the long dataset, a row more', to: (w) => ({ ...w, big: [...BIG, { i: 600 }] }), encodes: { long: N } },
    { what: 'nothing', to: (w) => w, encodes: {} },
  ]

  it('a session: each step is the scene a fresh evaluation makes, and encodes what read what changed', () => {
    const s = createChartSession()
    let w: W = { store: brush(2, 5), big: BIG, u: 0, hl: 'red' }
    let prev = s.evaluate(spec, input(w))
    for (const step of steps) {
      w = step.to(w)
      const { scene, encoded } = encodedBy(() => s.evaluate(spec, input(w)))
      expectFresh(spec, scene, input(w), step.what)
      expect(encoded, `${step.what}: items encoded`).toEqual(step.encodes)
      for (const m of ['brushed', 'long']) expect(keptMark(prev, scene, m), `${step.what}: ${m} kept`).toBe(step.encodes[m] === undefined)
      prev = scene
    }
  })

  it('evaluateChart: a store told as changed whose rows are equal keeps the mark; a long dataset told as changed does not', () => {
    const chart = compileChart(spec)
    const w: W = { store: brush(2, 5), big: BIG, u: 0, hl: 'red' }
    evaluateChart(chart, input(w))
    // (an evaluation told what changed, for the long dataset's key to be its array: see the session's first step above)
    evaluateChart(chart, { ...input(w), changedDatasets: ['t'] })
    const a = encodedBy(() => evaluateChart(chart, { ...input({ ...w, store: brush(2, 5) }), changedDatasets: ['store'] }))
    expect(a.encoded).toEqual({})
    expectFresh(spec, a.scene, input(w), 'store told, equal rows')
    const b = encodedBy(() => evaluateChart(chart, { ...input(w), changedDatasets: ['big'] }))
    expect(b.encoded).toEqual({ long: N })
    expectFresh(spec, b.scene, input(w), 'long dataset told')
    // (not told what changed, nothing is kept: an array says nothing of its rows, and neither do rows the caller did not vouch for)
    const c = encodedBy(() => evaluateChart(chart, input({ ...w, u: 5 })))
    expect(c.encoded).toEqual({ brushed: N, long: N })
    expectFresh(spec, c.scene, input({ ...w, u: 5 }), 'not told')
  })

  it('a long dataset changed in place, and told so, is not the array it was', () => {
    const s = createChartSession()
    const big = BIG.map((r) => ({ ...r }))
    const w: W = { store: [], big, u: 0, hl: 'red' }
    s.evaluate(spec, input(w))
    // (a second evaluation: the session now vouches for the array, and the mark is kept by it)
    expect(encodedBy(() => s.evaluate(spec, input({ ...w, u: 2 }))).encoded).toEqual({ long: N })
    expect(encodedBy(() => s.evaluate(spec, input({ ...w, u: 3 }))).encoded).toEqual({})
    big.push({ i: 600 })
    const { scene, encoded } = encodedBy(() => s.evaluate(spec, { ...input({ ...w, u: 1 }), dataPulse: { big: { appendOnly: true, baseLength: 600, changed: [] } } }))
    expect(encoded).toEqual({ long: N })
    expectFresh(spec, scene, input({ ...w, u: 1 }), 'in place, told')
  })

  it('a mark that reads a hierarchy by name reads every dataset', () => {
    const tree = {
      width: 100, height: 50, autosize: 'none',
      signals: [{ name: 'u', value: 0 }],
      data: [
        { name: 'tree', transform: [{ type: 'stratify', key: 'id', parentKey: 'parent' }] },
        { name: 'other' },
      ],
      marks: [{ type: 'text', name: 'path', from: { data: 'other' }, encode: { update: { x: { value: 1 }, text: { signal: "length(treePath('tree', 1, 3)) + ':' + srCount('path')" } } } }],
    } as unknown as VgSpec
    const nodes = (deep: boolean): Row[] => [{ id: 1 }, { id: 2, parent: 1 }, { id: 3, parent: deep ? 2 : 1 }]
    const s = createChartSession()
    const input = (deep: boolean, u: number): RuntimeInput => ({ data: { tree: nodes(deep), other: [{ a: 1 }] }, signals: { u } })
    s.evaluate(tree, input(false, 0))
    for (const [deep, u] of [[true, 0], [true, 1], [false, 2]] as const) {
      const { scene, encoded } = encodedBy(() => s.evaluate(tree, input(deep, u)))
      expectFresh(tree, scene, input(deep, u), `deep ${deep}, u ${u}`)
      expect(encoded, `deep ${deep}, u ${u}`).toEqual({ path: 1 })
    }
  })
})

// ---------------------------------------------------------------------------------------------------------------------------------
// The names a key holds, as the expression lexer reads them
// ---------------------------------------------------------------------------------------------------------------------------------

describe('a name read by an escape or past ASCII is a name the key holds', () => {
  const BS = String.fromCharCode(92)
  const cases: Array<[string, string, Row]> = [
    // (`a` is `a`)
    ['a signal named by an escape', `${BS}u0061 * 10`, { a: 1 }],
    ['a signal named past ASCII', 'größe * 10', { 'größe': 1 }],
  ]
  for (const [what, expr, first] of cases) {
    it(what, () => {
      const name = Object.keys(first)[0]!
      const spec = {
        width: 50, height: 50, autosize: 'none',
        signals: [{ name, value: 1 }, { name: 'u', value: 0 }],
        marks: [{ type: 'rect', name: 'r', encode: { update: { x: { signal: expr }, width: { value: 5 }, height: { value: 5 } } } }],
      } as unknown as VgSpec
      const s = createChartSession()
      s.evaluate(spec, { signals: { [name]: 1, u: 0 } })
      const input: RuntimeInput = { signals: { [name]: 2, u: 0 } }
      const scene = s.evaluate(spec, input)
      expectFresh(spec, scene, input, what)
      expect((groupNamed(scene, 'r')!.items as SceneItem[])[0]!.x).toBe(20)
    })
  }

  it('a dataset read by a function named by an escape', () => {
    const spec = {
      width: 50, height: 50, autosize: 'none',
      signals: [{ name: 'u', value: 0 }],
      data: [{ name: 'store' }],
      marks: [{ type: 'rect', name: 'r', encode: { update: { x: { signal: `length(d${BS}u0061ta('store'))` }, width: { value: 5 }, height: { value: 5 } } } }],
    } as unknown as VgSpec
    const s = createChartSession()
    s.evaluate(spec, { data: { store: [{ a: 1 }] }, signals: { u: 0 } })
    const input: RuntimeInput = { data: { store: [{ a: 1 }, { a: 2 }] }, signals: { u: 1 } }
    const scene = s.evaluate(spec, input)
    expectFresh(spec, scene, input, 'escaped data()')
    expect((groupNamed(scene, 'r')!.items as SceneItem[])[0]!.x).toBe(2)
  })

  it('a clock read by a function named by an escape keys the mark by every signal', () => {
    const spec = {
      width: 50, height: 50, autosize: 'none',
      signals: [{ name: 'u', value: 0 }],
      marks: [{ type: 'text', name: 'clock', encode: { update: { text: { signal: `n${BS}u006fw()` }, x: { value: 1 } } } }],
    } as unknown as VgSpec
    const s = createChartSession()
    const realNow = Date.now
    try {
      Date.now = () => 1000
      s.evaluate(spec, { signals: { u: 0 } })
      Date.now = () => 2000
      const scene = s.evaluate(spec, { signals: { u: 1 } })
      expect((groupNamed(scene, 'clock')!.items as SceneItem[])[0]!.text).toBe(2000)
    } finally {
      Date.now = realNow
    }
  })

  it('a scale read by a function named by an escape is a scale the mark reads', () => {
    // (the mark is drawn from rows that do not change; the scale it reads is made from rows that do)
    const spec = {
      width: 100, height: 50, autosize: 'none',
      signals: [{ name: 'u', value: 0 }],
      data: [{ name: 'pts' }, { name: 'dom' }],
      scales: [{ name: 'x', type: 'linear', domain: { data: 'dom', field: 'v' }, range: [0, 100] }],
      marks: [{ type: 'symbol', name: 'm', from: { data: 'pts' }, encode: { update: { x: { signal: `sc${BS}u0061le('x', datum.v)` } } } }],
    } as unknown as VgSpec
    const s = createChartSession()
    const pts = [{ v: 1 }, { v: 2 }]
    s.evaluate(spec, { data: { pts, dom: [{ v: 0 }, { v: 4 }] }, signals: { u: 0 } })
    for (const [hi, u] of [[8, 0], [10, 1]] as const) {
      const input: RuntimeInput = { data: { pts, dom: [{ v: 0 }, { v: hi }] }, signals: { u } }
      const scene = s.evaluate(spec, input)
      expectFresh(spec, scene, input, `domain to ${hi}, u ${u}`)
      expect((groupNamed(scene, 'm')!.items as SceneItem[])[1]!.x).toBe(200 / hi)
    }
  })

  it('a scale whose domain reads a dataset or a hierarchy by a function named by an escape is made again', () => {
    for (const [what, domain] of [['data', `[0, length(d${BS}u0061ta('t'))]`], ['treePath', `[0, length(tr${BS}u0065ePath('tree', 1, 3)) * 10]`]] as const) {
      const spec = {
        width: 100, height: 50, autosize: 'none',
        signals: [{ name: 'u', value: 0 }],
        data: [{ name: 't' }, { name: 'tree', transform: [{ type: 'stratify', key: 'id', parentKey: 'parent' }] }],
        scales: [{ name: 'x', type: 'linear', domain: { signal: domain }, range: [0, 100] }],
        marks: [{ type: 'rect', name: 'r', encode: { update: { x: { scale: 'x', value: 1 }, width: { value: 1 }, height: { value: 1 } } } }],
      } as unknown as VgSpec
      const s = createChartSession()
      const nodes = (deep: boolean): Row[] => [{ id: 1 }, { id: 2, parent: 1 }, { id: 3, parent: deep ? 2 : 1 }]
      const input = (n: number, deep: boolean, u: number): RuntimeInput => ({ data: { t: Array.from({ length: n }, (_, i) => ({ i })), tree: nodes(deep) }, signals: { u } })
      s.evaluate(spec, input(2, false, 0))
      for (const [n, deep, u] of [[4, true, 1], [5, false, 2]] as const) expectFresh(spec, s.evaluate(spec, input(n, deep, u)), input(n, deep, u), `${what}: ${n} rows, deep ${deep}, u ${u}`)
    }
  })

  it('a step that draws by a name an escape spells is not kept for another source', () => {
    const spec = {
      width: 50, height: 50, autosize: 'none',
      signals: [{ name: 'u', value: 0 }],
      data: [{ name: 't', transform: [{ type: 'formula', as: 'r', expr: `${BS}u0072andom()` }] }],
      marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { field: 'r' } } } }],
    } as unknown as VgSpec
    const s = createChartSession()
    const rows = [{ a: 1 }, { a: 2 }]
    s.evaluate(spec, { data: { t: rows }, signals: { u: 0 }, random: () => 0.25 })
    const input: RuntimeInput = { data: { t: rows }, signals: { u: 1 }, random: () => 0.75 }
    const scene = s.evaluate(spec, input)
    expect((rowsOf(scene, 't') as Row[]).map((r) => r.r)).toEqual([0.75, 0.75])
  })
})

// ---------------------------------------------------------------------------------------------------------------------------------
// A pulse with a signal change
// ---------------------------------------------------------------------------------------------------------------------------------

describe('a pulse runs through a pipeline whose reads did not change, whichever other signals did', () => {
  const spec = {
    width: 200, height: 100, autosize: 'none',
    signals: [{ name: 'u', value: 0 }, { name: 'k', value: -1 }, { name: 'sz', value: 30 }],
    data: [
      { name: 't' },
      { name: 'd', source: 't', transform: [{ type: 'formula', as: 'w', expr: 'datum.v * 2' }, { type: 'filter', expr: 'datum.v > k' }] },
    ],
    scales: [
      { name: 'x', type: 'linear', domain: { data: 'd', field: 'v' }, range: 'width' },
      { name: 'c', type: 'ordinal', domain: { data: 'd', field: 'g' }, range: 'category' },
    ],
    marks: [
      { type: 'symbol', name: 'pulsed', from: { data: 'd' }, encode: { update: { x: { scale: 'x', field: 'v' }, size: counter('pulsed') } } },
      { type: 'symbol', name: 'sized', from: { data: 'd' }, encode: { update: { x: { scale: 'x', field: 'v' }, size: { signal: `sz + srCount('sized') * 0` } } } },
      { type: 'symbol', name: 'colored', from: { data: 'd' }, encode: { update: { x: { scale: 'x', field: 'v' }, fill: { scale: 'c', field: 'g' }, size: counter('colored') } } },
    ],
  } as unknown as VgSpec
  type W = { t: Row[]; u: number; k: number; sz: number }
  const input = (w: W): RuntimeInput => ({ data: { t: w.t }, signals: { u: w.u, k: w.k, sz: w.sz } })
  const nudge = (rows: Row[], at: number): Row[] => rows.map((r, i) => (i === at ? { ...r, v: (r.v as number) + 0.25 } : r))
  // (the ordinal scale `c` advances its census over a same-length pulse with no mapping only, which the filter after the formula never
  // publishes: any change of the rows makes it again, and the mark that reads it with it, as before this change; the linear `x`
  // advances over all three kinds)
  const steps: Array<{ what: string; to: (w: W) => W; encodes: Record<string, number>; scales: string[] }> = [
    { what: 'a row appended, a signal nothing reads', to: (w) => ({ ...w, t: [...w.t, { v: 2.5, g: 'g1' }], u: 1 }), encodes: { pulsed: 1, sized: 1, colored: 13 }, scales: ['x'] },
    { what: 'a row modified, a signal nothing reads', to: (w) => ({ ...w, t: nudge(w.t, 2), u: 2 }), encodes: { pulsed: 1, sized: 1, colored: 13 }, scales: ['x'] },
    { what: 'a row removed, a signal nothing reads', to: (w) => ({ ...w, t: w.t.filter((_, i) => i !== 4), u: 3 }), encodes: { colored: 12 }, scales: ['x'] },
    // (`sz` is read by one mark: it encodes every item, the others their changed row; the dataset keeps its pulse)
    { what: 'a row modified, a signal one mark reads', to: (w) => ({ ...w, t: nudge(w.t, 5), sz: 40 }), encodes: { pulsed: 1, sized: 12, colored: 12 }, scales: ['x'] },
    // (then no rows: the steps the pulses ran are kept by what they read, and so is everything made from them)
    { what: 'a signal nothing reads, after the pulses', to: (w) => ({ ...w, u: 4 }), encodes: {}, scales: ['x', 'c'] },
    // (`k` is read by the pipeline: the dataset is made again, and what reads it; 11 rows have `v > 0`)
    { what: 'a row modified, a signal the pipeline reads', to: (w) => ({ ...w, t: nudge(w.t, 6), k: 0 }), encodes: { pulsed: 11, sized: 11, colored: 11 }, scales: [] },
  ]

  it('a session: only the rows that changed are encoded; each step is the fresh scene', () => {
    const s = createChartSession()
    let w: W = { t: ROWS, u: 0, k: -1, sz: 30 }
    let prev = s.evaluate(spec, input(w))
    for (const step of steps) {
      w = step.to(w)
      const { scene, encoded } = encodedBy(() => s.evaluate(spec, input(w)))
      expectFresh(spec, scene, input(w), step.what)
      expect(encoded, `${step.what}: items encoded`).toEqual(step.encodes)
      expect(['x', 'c'].filter((n) => scaleOf(prev, n) === scaleOf(scene, n)), `${step.what}: scales kept`).toEqual(step.scales)
      prev = scene
    }
  })

  it('a filter that reads its own source by name judges every row again when the source grows', () => {
    // (the verdict of every row moves with `length(data('t'))`: it used to be kept for the rows before the append)
    const own = {
      width: 100, height: 50, autosize: 'none',
      data: [{ name: 't' }, { name: 'd', source: 't', transform: [{ type: 'filter', expr: "datum.v * 4 >= length(data('t'))" }] }],
      marks: [{ type: 'symbol', from: { data: 'd' }, encode: { update: { x: { field: 'v' } } } }],
    } as unknown as VgSpec
    const s = createChartSession()
    s.evaluate(own, { data: { t: ROWS } })
    const input: RuntimeInput = { data: { t: [...ROWS, ...ROWS.map((r) => ({ ...r }))] } }
    expectFresh(own, s.evaluate(own, input), input, 'own source')
  })

  it('a filter by a selection judges every row again when its store moves with the rows', () => {
    const filtered = {
      width: 100, height: 50, autosize: 'none',
      signals: [{ name: 'u', value: 0 }],
      data: [{ name: 't' }, { name: 'store' }, { name: 'd', source: 't', transform: [{ type: 'filter', expr: "!length(data('store')) || vlSelectionTest('store', datum)" }] }],
      marks: [{ type: 'symbol', from: { data: 'd' }, encode: { update: { x: { field: 'v' } } } }],
    } as unknown as VgSpec
    const brush = (lo: number, hi: number): Row[] => [{ unit: '', fields: [{ field: 'v', type: 'R' }], values: [[lo, hi]] }]
    const s = createChartSession()
    s.evaluate(filtered, { data: { t: ROWS, store: brush(0, 4) }, signals: { u: 0 } })
    for (const [rows, lo, hi, u] of [[append(ROWS, 30), 2, 8, 0], [append(append(ROWS, 30), 3), 2, 8, 1], [append(ROWS, 3), 0, 2, 2]] as const) {
      const input: RuntimeInput = { data: { t: rows, store: brush(lo, hi) }, signals: { u } }
      expectFresh(filtered, s.evaluate(filtered, input), input, `brush ${lo}-${hi}, ${rows.length} rows`)
    }
  })

  it('a filter that reads a scale judges every row again', () => {
    // (`cnt` reads a dataset no row change moves: the first round builds under no value of it, the second under the one the
    // evaluation before had, and runs the pulse; the scale moved with the rows, and so did the verdict of the rows before)
    const scaled = {
      width: 100, height: 50, autosize: 'none',
      signals: [{ name: 'u', value: 0 }, { name: 'cnt', update: "length(data('other'))" }],
      data: [{ name: 't' }, { name: 'other', values: [{ a: 1 }] }, { name: 'd', source: 't', transform: [{ type: 'filter', expr: "scale('x', datum.v) > 50" }] }],
      scales: [{ name: 'x', type: 'linear', domain: { data: 't', field: 'v' }, range: [0, 100] }],
      marks: [{ type: 'symbol', from: { data: 'd' }, encode: { update: { x: { field: 'v' } } } }],
    } as unknown as VgSpec
    const s = createChartSession()
    s.evaluate(scaled, { data: { t: ROWS }, signals: { u: 0 } })
    for (const [rows, u] of [[append(ROWS, 30), 0], [append(append(ROWS, 30), 40), 1]] as const) {
      const input: RuntimeInput = { data: { t: rows }, signals: { u } }
      expectFresh(scaled, s.evaluate(scaled, input), input, `${rows.length} rows`)
    }
  })

  it('a view whose datasets draw from an injected source takes a pulse where it always did', () => {
    const drawn = {
      width: 100, height: 50, autosize: 'none',
      signals: [{ name: 'u', value: 0 }, { name: 'picked', update: "length(data('store'))" }],
      data: [
        { name: 'store' }, { name: 't' },
        { name: 'd', source: 't', transform: [{ type: 'formula', as: 'w', expr: 'datum.v * 2' }] },
        { name: 'r', source: 'd', transform: [{ type: 'sample', size: 6 }] },
      ],
      marks: [{ type: 'symbol', from: { data: 'r' }, encode: { update: { x: { field: 'w' } } } }],
    } as unknown as VgSpec
    // (the reference keeps no step, and so no build: the numbers drawn are the ones it draws)
    const mulberry = (seed: number): (() => number) => { let a = seed; return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }
    const mine = createChartSession()
    const reference = createChartSession()
    const ra = mulberry(7)
    const rb = mulberry(7)
    let rows = ROWS
    for (let i = 0; i < 6; i++) {
      rows = i % 2 ? append(rows, 20 + i) : rows
      const input = (random: () => number): RuntimeInput => ({ data: { t: rows, store: [] }, signals: { u: i }, random })
      const got = mine.evaluate(drawn, input(ra))
      reuse.on = false
      let want: SceneRoot
      try { want = reference.evaluate(drawn, input(rb)) } finally { reuse.on = true }
      expectSame(got, want, `draw ${i}`)
    }
  })
})

describe('what a kept build or a keyed pulse must not take over', () => {
  it('a build of the round before whose id counter stood elsewhere is not kept', () => {
    // (`a` reads a scale, so its rows differ between the two rounds, and so does where the counter stands when `b` is built: `b`
    // runs again, and the counter ends where running it ends; the reference keeps no build)
    const spec = {
      width: 100, height: 50, autosize: 'none',
      signals: [{ name: 'u', value: 0 }],
      scales: [{ name: 'x', type: 'linear', domain: { data: 't', field: 'v' }, range: [0, 100] }],
      data: [
        { name: 't' },
        { name: 'a', source: 't', transform: [{ type: 'filter', expr: "scale('x', datum.v) > 50" }, { type: 'identifier', as: 'id' }] },
        { name: 'b', transform: [{ type: 'identifier', as: 'id' }] },
      ],
      marks: [
        { type: 'symbol', from: { data: 'a' }, encode: { update: { x: { field: 'id' } } } },
        { type: 'symbol', from: { data: 'b' }, encode: { update: { x: { field: 'id' } } } },
      ],
    } as unknown as VgSpec
    const t = Array.from({ length: 5 }, (_, i) => ({ v: i }))
    const mine = createChartSession()
    const reference = createChartSession()
    let b: Row[] = [{ w: 1 }, { w: 2 }]
    for (let i = 0; i < 5; i++) {
      if (i >= 2) b = [...b, { w: 10 + i }]
      const input: RuntimeInput = { data: { t, b }, signals: { u: i } }
      const got = mine.evaluate(spec, input)
      reuse.on = false
      let want: SceneRoot
      try { want = reference.evaluate(spec, input) } finally { reuse.on = true }
      expectSame(got, want, `evaluation ${i}`)
    }
  })

  it('a dataset a signal moved, read by name, is read again by a pipeline a pulse runs through', () => {
    // (`s` is filtered by `k`; `d` keeps the rows of `t2` that `s` holds: `k` and the rows of `t2` change together)
    const spec = {
      width: 100, height: 50, autosize: 'none',
      signals: [{ name: 'k', value: 0 }],
      data: [
        { name: 't' }, { name: 't2' },
        { name: 's', source: 't', transform: [{ type: 'filter', expr: 'datum.v > k' }] },
        { name: 'd', source: 't2', transform: [{ type: 'filter', expr: "indata('s', 'v', datum.w)" }] },
      ],
      marks: [{ type: 'symbol', from: { data: 'd' }, encode: { update: { x: { field: 'w' } } } }],
    } as unknown as VgSpec
    const t2 = Array.from({ length: 8 }, (_, i) => ({ w: i }))
    const s = createChartSession()
    s.evaluate(spec, { data: { t: ROWS, t2 }, signals: { k: 0 } })
    const steps: Array<[Row[], number]> = [[[...t2, { w: 9 }], 4], [[...t2, { w: 9 }, { w: 3 }], 2]]
    for (const [rows, k] of steps) {
      const input: RuntimeInput = { data: { t: ROWS, t2: rows }, signals: { k } }
      expectFresh(spec, s.evaluate(spec, input), input, `k ${k}, ${rows.length} rows`)
    }
  })

  it('a long dataset a pulse updated in place is not the array it was to what reads it by name', () => {
    const spec = {
      width: 100, height: 50, autosize: 'none',
      signals: [{ name: 'u', value: 0 }],
      data: [{ name: 't' }, { name: 'big' }, { name: 'big2', source: 'big', transform: [{ type: 'formula', as: 'j', expr: 'datum.i * 2' }] }],
      marks: [{ type: 'symbol', name: 'long', from: { data: 't' }, encode: { update: { x: { field: 'v' }, size: { signal: `length(data('big2')) + srCount('long2')` } } } }],
    } as unknown as VgSpec
    const s = createChartSession()
    let big = Array.from({ length: 600 }, (_, i) => ({ i }))
    s.evaluate(spec, { data: { t: ROWS, big }, signals: { u: 0 } })
    s.evaluate(spec, { data: { t: ROWS, big }, signals: { u: 1 } })
    big = [...big, { i: 600 }]
    const input: RuntimeInput = { data: { t: ROWS, big }, signals: { u: 2 } }
    const { scene, encoded } = encodedBy(() => s.evaluate(spec, input))
    expectFresh(spec, scene, input, 'in place')
    expect(encoded).toEqual({ long2: N })
  })

  it('a view that fits its container hands a pass the pulse of the pass before only over the rows its items were made from', () => {
    // (`wide` reads the width, which the two passes see apart: under `m` 380 the first pass holds `z` as `v`, the second as 0; under
    // `m` 100 both hold it as `v`, and the second keeps the first's build -- whose pulse says how the first pass's rows changed)
    const spec = {
      width: 400, height: 120, autosize: { type: 'fit', contains: 'padding' },
      signals: [{ name: 'm', value: 380 }, { name: 'wide', update: 'width > m ? 1 : 0' }],
      data: [{ name: 't' }, { name: 'd', source: 't', transform: [{ type: 'formula', as: 'z', expr: 'datum.v * wide' }] }],
      scales: [{ name: 'y', type: 'linear', domain: [0, 1e9], range: 'height' }],
      axes: [{ orient: 'left', scale: 'y', format: ',.0f' }],
      marks: [{ type: 'symbol', name: 'z', from: { data: 'd' }, encode: { update: { x: { field: 'z' }, y: { value: 5 } } } }],
    } as unknown as VgSpec
    const s = createChartSession()
    const input = (rows: Row[], m: number): RuntimeInput => ({ data: { t: rows }, signals: { m } })
    s.evaluate(spec, input(ROWS, 380))
    const first = s.evaluate(spec, input(ROWS, 380))
    // (the passes see the width apart: the second pass's rows hold 0)
    expect(((groupNamed(first, 'z')!.items as SceneItem[])[3]!.datum as Row).z).toBe(0)
    const next = append(ROWS, 3.5)
    const scene = s.evaluate(spec, input(next, 100))
    expectFresh(spec, scene, input(next, 100), 'both passes agree, a row appended')
  })

  it('under limits a kept build would count its rows once: none is kept, and the limit is where it was', () => {
    // (each round of the evaluation runs the fold: 10 rows generated twice)
    const spec = {
      width: 100, height: 50, autosize: 'none',
      signals: [{ name: 'u', value: 0 }, { name: 'picked', update: "length(data('store'))" }],
      data: [{ name: 'store' }, { name: 't' }, { name: 'f', source: 't', transform: [{ type: 'fold', fields: ['a', 'b'] }] }],
      marks: [{ type: 'symbol', from: { data: 'f' }, encode: { update: { x: { field: 'value' } } } }],
    } as unknown as VgSpec
    const t = Array.from({ length: 10 }, (_, i) => ({ a: i, b: i * 2 }))
    for (const [limit, throws] of [[19, true], [20, false]] as const) {
      const input = (u: number): RuntimeInput => ({ data: { t, store: [] }, signals: { u }, limits: { maxGeneratedRows: limit } })
      const s = createChartSession()
      const first = (): SceneRoot => s.evaluate(spec, input(0))
      const second = (): SceneRoot => s.evaluate(spec, input(1))
      if (throws) {
        expect(first).toThrow(/maxGeneratedRows/)
        expect(second).toThrow(/maxGeneratedRows/)
      } else {
        expect(first).not.toThrow()
        expect(second).not.toThrow()
      }
    }
  })

  it('a step that draws from no injected source draws again in every round', () => {
    // (vega's own `random` is the host's: a build that draws is never kept, so each round of each evaluation draws its numbers
    // again, as a session that keeps nothing does)
    const spec = {
      width: 100, height: 50, autosize: 'none',
      signals: [{ name: 'u', value: 0 }, { name: 'picked', update: "length(data('store'))" }],
      data: [{ name: 'store' }, { name: 't' }, { name: 'd', source: 't', transform: [{ type: 'formula', as: 'r', expr: 'random()' }] }],
      marks: [{ type: 'symbol', from: { data: 'd' }, encode: { update: { x: { field: 'r' } } } }],
    } as unknown as VgSpec
    const realRandom = Math.random
    const mine = createChartSession()
    const reference = createChartSession()
    try {
      let rows = ROWS
      for (let i = 0; i < 4; i++) {
        if (i === 2) rows = append(rows, 30)
        const input: RuntimeInput = { data: { t: rows, store: [] }, signals: { u: i } }
        let n = 0
        Math.random = () => (++n % 97) / 97
        const got = mine.evaluate(spec, input)
        n = 0
        reuse.on = false
        let want: SceneRoot
        try { want = reference.evaluate(spec, input) } finally { reuse.on = true }
        expectSame(got, want, `evaluation ${i}`)
      }
    } finally {
      Math.random = realRandom
    }
  })
})

describe('a pass that failed keeps no build', () => {
  it('a dataset that throws in the first round is built again in the second', () => {
    const spec = {
      width: 100, height: 50, autosize: 'none',
      signals: [{ name: 'u', value: 0 }, { name: 'picked', update: "length(data('store'))" }],
      data: [{ name: 'store' }, { name: 't' }, { name: 'd', source: 't', transform: [{ type: 'formula', as: 'w', expr: 'picked > 0 ? datum.v : null[0]' }] }],
      marks: [{ type: 'symbol', from: { data: 'd' }, encode: { update: { x: { field: 'w' } } } }],
    } as unknown as VgSpec
    const s = createChartSession()
    for (const [store, u] of [[1, 0], [1, 1], [0, 1], [1, 2]] as const) {
      const input: RuntimeInput = { data: { t: ROWS, store: Array.from({ length: store }, () => ({ a: 1 })) }, signals: { u }, logger: quiet }
      expectFresh(spec, s.evaluate(spec, input), input, `store ${store}, u ${u}`)
    }
  })
})
