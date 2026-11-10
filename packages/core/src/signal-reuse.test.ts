/**
 * A re-evaluation in which only signals a result does not read changed keeps that result: a top-level leaf mark keeps its group and
 * its items, a top-level scale keeps its object. What a mark or a scale reads is every signal its definition names, the view's size
 * and the inputs of the context fingerprint (`readsKey` in runtime.ts); the datasets it reads must be the same arrays, or, for the
 * dataset a mark is drawn from, rows equal to those its items were made from.
 *
 * What this file pins:
 *  - every evaluation (a session, and `evaluateChart` told what changed) makes the scene a fresh evaluation of the same inputs makes,
 *    when the signals that changed are read by nothing drawn, are read, or both;
 *  - the reuse itself: which mark groups, items and scales keep their objects, and how many items the encode makes, per change;
 *  - what keeps a result whatever it names: marks with transforms, marks that read datasets by an expression;
 *  - group marks (scopes, facets) and guides are made again, and read the signals as they are now.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { compileChart } from './compiler.js'
import { evaluateChart } from './evaluate.js'
import { registerExpressionFunction } from './expression.js'
import { createChartSession } from './session.js'
import { renderSceneToSvg } from './index.js'
import './addon-geo.js'
import type { RuntimeInput, SceneGroup, SceneItem, SceneRoot, VgSpec } from './types.js'

type Row = Record<string, unknown>

// Counts the items each mark encodes: `srCount(<mark>)` is read once per item encoded.
const encodes = new Map<string, number>()
let dispose: (() => void) | undefined
beforeAll(() => {
  dispose = registerExpressionFunction('srCount', (name: string) => { encodes.set(name, (encodes.get(name) ?? 0) + 1); return 30 })
})
afterAll(() => dispose?.())

const counter = (name: string): { signal: string } => ({ signal: `srCount('${name}')` })

const SPEC = {
  width: 200, height: 100, padding: 5, autosize: 'none',
  signals: [
    { name: 'a', value: 10 }, { name: 'b', value: 5 }, { name: 'c', value: 1 }, { name: 's', value: 50 }, { name: 'fmt', value: 'd' },
    { name: 'k', value: 0 }, { name: 'tc', value: 5 }, { name: 'ttl', value: 'T' }, { name: 'twice', update: 'a * 2' },
  ],
  data: [
    // (the host's rows, which a dataset with no transforms copies: the copy is kept while the session says they are the same)
    { name: 't' },
    { name: 'other' },
    { name: 'f', source: 't', transform: [{ type: 'filter', expr: 'datum.v >= k' }] },
  ],
  scales: [
    { name: 'x', type: 'linear', domain: { data: 't', field: 'v' }, range: 'width' },
    { name: 'y', type: 'linear', domain: [0, { signal: 's' }], range: 'height' },
    { name: 'color', type: 'ordinal', domain: { data: 't', field: 'g' }, range: 'category' },
    // reads a dataset from an expression: reads every signal (made again whenever one changes)
    { name: 'z', type: 'linear', domain: { signal: "[0, length(data('f'))]" }, range: [0, 50] },
  ],
  axes: [
    { orient: 'bottom', scale: 'x', tickCount: { signal: 'tc' } },
    { orient: 'left', scale: 'y', encode: { labels: { update: { fill: { signal: "c > 1 ? 'red' : 'black'" } } } } },
  ],
  legends: [{ fill: 'color', title: { signal: 'ttl' } }],
  title: { text: { signal: 'ttl' } },
  marks: [
    // reads no signal but the view's
    { type: 'symbol', name: 'plain', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'v' }, y: { value: 5 }, size: counter('plain') } } },
    // a `{signal}` channel
    { type: 'rect', name: 'bySignal', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'v' }, width: { signal: 'a' }, y: { value: 0 }, height: { value: 4 }, strokeWidth: counter('bySignal') } } },
    // a production rule's test
    { type: 'symbol', name: 'byTest', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'v' }, fill: [{ test: 'datum.v > b', value: 'red' }, { value: 'blue' }], size: counter('byTest') } } },
    // an expression, through a signal derived from another
    { type: 'text', name: 'byExpr', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'v' }, text: { signal: "format(datum.v, fmt) + ':' + twice + ':' + srCount('byExpr')" } } } },
    // a scale whose domain is a signal
    { type: 'symbol', name: 'byScale', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'v' }, y: { scale: 'y', field: 'v' }, size: counter('byScale') } } },
    // a dataset filtered by a signal
    { type: 'symbol', name: 'byData', from: { data: 'f' }, encode: { update: { x: { scale: 'x', field: 'v' }, size: counter('byData') } } },
    // the group's width, which no expression names
    { type: 'rect', name: 'byGroup', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'v' }, x2: { field: { group: 'width' } }, y: { value: 1 }, height: { value: 2 }, strokeWidth: counter('byGroup') } } },
    // reads a dataset from an expression: reads every signal (kept only when none changed)
    { type: 'text', name: 'byDataFn', from: { data: 't' }, encode: { update: { x: { value: 1 }, text: { signal: "length(data('t')) + ':' + srCount('byDataFn')" } } } },
    // a scale that reads every signal
    { type: 'symbol', name: 'byDataScale', from: { data: 't' }, encode: { update: { x: { scale: 'z', field: 'v' }, size: counter('byDataScale') } } },
    // a mark with a transform: reads every signal
    { type: 'symbol', name: 'withTransform', from: { data: 't' }, transform: [{ type: 'formula', expr: 'datum.x + 1', as: 'x2' }], encode: { update: { x: { scale: 'x', field: 'v' }, size: counter('withTransform') } } },
    // a scope whose signal is computed from `c`, which no top-level mark reads
    {
      type: 'group', name: 'scope', signals: [{ name: 'gs', update: 'c * 2' }],
      encode: { update: { width: { value: 50 }, height: { value: 50 } } },
      marks: [{ type: 'symbol', name: 'inScope', from: { data: 't' }, encode: { update: { x: { signal: 'gs' }, y: { field: 'v' }, size: counter('inScope') } } }],
    },
    // a facet whose marks read `a`
    {
      type: 'group', name: 'facet', from: { facet: { data: 't', name: 'cell', groupby: 'g' } },
      encode: { update: { width: { value: 40 }, height: { value: 20 } } },
      marks: [{ type: 'rect', name: 'inFacet', from: { data: 'cell' }, encode: { update: { x: { field: 'v' }, width: { signal: 'a' }, height: { value: 3 }, strokeWidth: counter('inFacet') } } }],
    },
  ],
} as unknown as VgSpec

const ROWS: Row[] = Array.from({ length: 8 }, (_, i) => ({ v: i, x: i * 3, g: `g${i % 3}` }))
const LEAF = ['plain', 'bySignal', 'byTest', 'byExpr', 'byScale', 'byData', 'byGroup', 'byDataFn', 'byDataScale', 'withTransform']

// Scene normalisation (as incremental-oracle.test.ts): the internals that are not the scene, and the generation stamps of items.
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

/** Asserts that `scene` is what a fresh evaluation of `input` makes: the scene itself (items, data, scales) and its SVG. */
function expectFresh(spec: VgSpec, scene: SceneRoot, input: RuntimeInput, what: string): void {
  const want = evaluateChart(compileChart(spec), input)
  expect(norm(scene), what).toEqual(norm(want))
  expect(renderSceneToSvg(scene), what).toBe(renderSceneToSvg(want))
}

/** The group of a mark by name, anywhere in the scene. */
function groupNamed(scene: SceneRoot, name: string): SceneGroup | undefined {
  const walk = (items: readonly unknown[]): SceneGroup | undefined => {
    for (const it of items) {
      const g = it as SceneGroup
      if (g.marktype !== undefined && (g as { name?: string }).name === name && g.role === 'mark') return g
      const inner = (g as { items?: unknown[] }).items
      if (Array.isArray(inner)) { const found = walk(inner); if (found) return found }
    }
    return undefined
  }
  return walk(scene.items)
}
const scaleOf = (scene: SceneRoot, name: string): unknown => (scene as unknown as { __scaleMap: Map<string, unknown> }).__scaleMap.get(name)

/** What one evaluation kept of the one before: the leaf marks whose group and every item are the same objects, and the scales. */
function kept(before: SceneRoot, after: SceneRoot): { marks: string[]; scales: string[] } {
  const marks = LEAF.filter((n) => {
    const a = groupNamed(before, n)
    const b = groupNamed(after, n)
    if (a === undefined || b === undefined || a !== b) return false
    const ai = a.items as SceneItem[]
    return ai.every((it, i) => it === (b.items as SceneItem[])[i])
  })
  return { marks, scales: ['x', 'y', 'color', 'z'].filter((n) => scaleOf(before, n) === scaleOf(after, n)) }
}

const counts = (): Record<string, number> => Object.fromEntries([...LEAF, 'inScope', 'inFacet'].map((n) => [n, encodes.get(n) ?? 0]))
const encoded = (before: Record<string, number>): Record<string, number> => {
  const now = counts()
  const out: Record<string, number> = {}
  for (const k of Object.keys(now)) if (now[k]! - before[k]! !== 0) out[k] = now[k]! - before[k]!
  return out
}

const BASE_SIGNALS = { a: 10, b: 5, c: 1, s: 50, fmt: 'd', k: 0, tc: 5, ttl: 'T' }

/** A step: the signals as they become (and the width), what it keeps and what it encodes again. */
interface Step { what: string; signals: Partial<typeof BASE_SIGNALS>; width?: number; rebuilt: string[]; scales?: string[]; encodes: Record<string, number> }
const N = ROWS.length
const ALWAYS = { byDataFn: N, byDataScale: N, withTransform: N, inScope: N, inFacet: N }
// (`z` reads a dataset from an expression: it is made again whenever a signal changes)
const ALL_SCALES = ['x', 'y', 'color']
const STEPS: Step[] = [
  { what: 'a signal nothing drawn reads (the scope does)', signals: { c: 2 }, rebuilt: ['byDataFn', 'byDataScale', 'withTransform'], encodes: ALWAYS },
  { what: 'a `{signal}` channel', signals: { a: 11 }, rebuilt: ['bySignal', 'byExpr', 'byDataFn', 'byDataScale', 'withTransform'], encodes: { ...ALWAYS, bySignal: N, byExpr: N } },
  { what: 'a production rule test', signals: { b: 2 }, rebuilt: ['byTest', 'byDataFn', 'byDataScale', 'withTransform'], encodes: { ...ALWAYS, byTest: N } },
  { what: 'an expression', signals: { fmt: '.1f' }, rebuilt: ['byExpr', 'byDataFn', 'byDataScale', 'withTransform'], encodes: { ...ALWAYS, byExpr: N } },
  { what: 'a scale domain', signals: { s: 80 }, rebuilt: ['byScale', 'byDataFn', 'byDataScale', 'withTransform'], scales: ['x', 'color'], encodes: { ...ALWAYS, byScale: N } },
  // (the filter runs again and makes rows equal to the ones before: the mark keeps its items)
  { what: 'a dataset filter whose rows stay', signals: { k: -1 }, rebuilt: ['byDataFn', 'byDataScale', 'withTransform'], encodes: ALWAYS },
  { what: 'a dataset filter whose rows change', signals: { k: 3 }, rebuilt: ['byData', 'byDataFn', 'byDataScale', 'withTransform'], encodes: { ...ALWAYS, byData: N - 3 } },
  { what: 'guides only', signals: { tc: 3, ttl: 'U' }, rebuilt: ['byDataFn', 'byDataScale', 'withTransform'], encodes: ALWAYS },
  // (every key holds the view's size: a resize makes everything again, as it did)
  { what: 'the view width', signals: {}, width: 260, rebuilt: LEAF, scales: [], encodes: { ...ALWAYS, plain: N, bySignal: N, byTest: N, byExpr: N, byScale: N, byData: N - 3, byGroup: N } },
  { what: 'read and unread together', signals: { a: 12, c: 3 }, rebuilt: ['bySignal', 'byExpr', 'byDataFn', 'byDataScale', 'withTransform'], encodes: { ...ALWAYS, bySignal: N, byExpr: N } },
  // (the session hands back the scene it made; `evaluateChart`, told that a dataset changed, makes what reads datasets again)
  { what: 'nothing', signals: {}, rebuilt: [], scales: ['x', 'y', 'color', 'z'], encodes: {} },
]
const NOTHING_TOLD: Pick<Step, 'rebuilt' | 'encodes'> = { rebuilt: ['byDataFn'], encodes: { byDataFn: N, inScope: N, inFacet: N } }

describe('a re-evaluation keeps the marks and scales that read none of the signals that changed', () => {
  // `evaluateChart` keeps a result only when told what changed: here, a dataset nothing reads
  const viaChart = (chart: ReturnType<typeof compileChart>) => (input: RuntimeInput): SceneRoot => evaluateChart(chart, { ...input, changedDatasets: ['other'] })
  const routes: Array<[string, () => (input: RuntimeInput) => SceneRoot]> = [
    ['a session', () => { const s = createChartSession(); return (input) => s.evaluate(SPEC, input) }],
    ['evaluateChart told what changed', () => viaChart(compileChart(SPEC))],
  ]
  for (const [route, make] of routes) {
    it(`${route}: each step is a fresh evaluation, and keeps exactly what reads nothing that changed`, () => {
      const run = make()
      let signals = { ...BASE_SIGNALS }
      let width = 200
      const inputOf = (): RuntimeInput => ({ data: { t: ROWS, other: [] }, signals: { ...signals }, width, height: 100 })
      let prev = run(inputOf())
      expectFresh(SPEC, prev, inputOf(), `${route}: first`)
      for (const step of STEPS) {
        signals = { ...signals, ...step.signals }
        width = step.width ?? width
        const before = counts()
        const scene = run(inputOf())
        const want = step.what === 'nothing' && route !== 'a session' ? { ...step, ...NOTHING_TOLD } : step
        expect(encoded(before), `${route}: ${step.what}: items encoded`).toEqual(want.encodes)
        expectFresh(SPEC, scene, inputOf(), `${route}: ${step.what}`)
        const k = kept(prev, scene)
        expect(k.marks, `${route}: ${step.what}: marks kept`).toEqual(LEAF.filter((n) => !want.rebuilt.includes(n)))
        expect(k.scales, `${route}: ${step.what}: scales kept`).toEqual(step.scales ?? ALL_SCALES)
        prev = scene
      }
    })
  }

  it('the scope and the facet read the signals as they are now (they are made again)', () => {
    const s = createChartSession()
    const input = (c: number, a: number): RuntimeInput => ({ data: { t: ROWS, other: [] }, signals: { ...BASE_SIGNALS, c, a } })
    s.evaluate(SPEC, input(1, 10))
    const scene = s.evaluate(SPEC, input(4, 13))
    expect((groupNamed(scene, 'inScope')!.items as SceneItem[])[0]!.x).toBe(8)
    expect((groupNamed(scene, 'inFacet')!.items as SceneItem[])[0]!.width).toBe(13)
    expectFresh(SPEC, scene, input(4, 13), 'scope and facet')
  })

  it('guides read the signals as they are now: a tick count, a label encode, a legend and a view title', () => {
    const s = createChartSession()
    const input = (sig: Partial<typeof BASE_SIGNALS>): RuntimeInput => ({ data: { t: ROWS, other: [] }, signals: { ...BASE_SIGNALS, ...sig } })
    s.evaluate(SPEC, input({}))
    const scene = s.evaluate(SPEC, input({ tc: 2, c: 5, ttl: 'Changed' }))
    const svg = renderSceneToSvg(scene)
    expect(svg).toContain('Changed')
    expect(svg).toContain('fill="red"')
    expectFresh(SPEC, scene, input({ tc: 2, c: 5, ttl: 'Changed' }), 'guides')
  })
})

describe('what a kept mark reads besides its signals', () => {
  it('a dataset it names that a signal moved is not the one its items were made from', () => {
    // (`lookup`-free: the mark names dataset `f` in a string of its own, besides its `from`)
    const spec = {
      width: 100, height: 50, autosize: 'none', signals: [{ name: 'k', value: 0 }, { name: 'u', value: 0 }],
      data: [{ name: 't', values: [] }, { name: 'f', source: 't', transform: [{ type: 'filter', expr: 'datum.v >= k' }] }],
      marks: [{ type: 'text', from: { data: 't' }, encode: { update: { x: { field: 'v' }, text: { value: 'f' }, size: counter('names') } } }],
    } as unknown as VgSpec
    const s = createChartSession()
    const input = (k: number, u: number): RuntimeInput => ({ data: { t: ROWS }, signals: { k, u } })
    const a = s.evaluate(spec, input(0, 0))
    // (`f` is made again, so the mark that names it is too: a name is read as a dataset wherever it is)
    const b = s.evaluate(spec, input(2, 0))
    expect(b.items[0]).not.toBe(a.items[0])
    expectFresh(spec, b, input(2, 0), 'named dataset')
    // (an unread signal alone keeps it)
    const c = s.evaluate(spec, input(2, 1))
    expect(c.items[0]).toBe(b.items[0])
    // (a row of its own changes, with `f` moved: the items are not taken over row by row either)
    const before = encodes.get('names') ?? 0
    const next = ROWS.map((r, i) => (i === 2 ? { ...r, v: 2.5 } : r))
    const d = s.evaluate(spec, { data: { t: next }, signals: { k: 3, u: 1 } })
    expect((encodes.get('names') ?? 0) - before).toBe(N)
    expectFresh(spec, d, { data: { t: next }, signals: { k: 3, u: 1 } }, 'named dataset and a row')
  })

  it('an image keeps its items only under the URL policy it was made under', () => {
    const spec = {
      width: 100, height: 50, autosize: 'none', signals: [{ name: 'u', value: 0 }],
      marks: [{ type: 'image', encode: { update: { url: { value: 'https://example.com/a.png' }, width: { value: 10 }, height: { value: 10 } } } }],
    } as unknown as VgSpec
    const s = createChartSession()
    const allow = { allow: () => true }
    const deny = { allow: () => false }
    const a = s.evaluate(spec, { signals: { u: 0 }, urlPolicy: allow })
    const b = s.evaluate(spec, { signals: { u: 1 }, urlPolicy: allow })
    expect(b.items[0]).toBe(a.items[0])
    // (a fresh evaluation under a policy that refuses the url refuses the view)
    expect(() => evaluateChart(compileChart(spec), { signals: { u: 2 }, urlPolicy: deny })).toThrow(/url denied/)
    expect(() => s.evaluate(spec, { signals: { u: 2 }, urlPolicy: deny })).toThrow(/url denied/)
  })

  it('a sorted mark whose sort moved its items is made again when its rows are new rows, even equal ones', () => {
    const spec = {
      width: 100, height: 50, autosize: 'none', signals: [{ name: 'k', value: 0 }],
      data: [{ name: 't' }, { name: 'f', source: 't', transform: [{ type: 'filter', expr: 'datum.v >= k' }] }],
      marks: [{ type: 'symbol', from: { data: 'f' }, sort: { field: 'datum.x', order: 'descending' }, encode: { update: { x: { field: 'x' }, size: counter('sorted') } } }],
    } as unknown as VgSpec
    const s = createChartSession()
    const input = (k: number): RuntimeInput => ({ data: { t: ROWS }, signals: { k } })
    s.evaluate(spec, input(0))
    const before = encodes.get('sorted') ?? 0
    const b = s.evaluate(spec, input(-1))
    expect((encodes.get('sorted') ?? 0) - before).toBe(N)
    expectFresh(spec, b, input(-1), 'sorted')
  })

  it('without being told what changes (evaluateChart alone), nothing is kept', () => {
    const chart = compileChart(SPEC)
    const input = (c: number): RuntimeInput => ({ data: { t: ROWS, other: [] }, signals: { ...BASE_SIGNALS, c } })
    const a = evaluateChart(chart, input(1))
    const b = evaluateChart(chart, input(2))
    expect(kept(a, b)).toEqual({ marks: [], scales: [] })
    expectFresh(SPEC, b, input(2), 'untold')
  })

  it('under limits, a signal change keeps nothing (a kept result is not counted against them again)', () => {
    const s = createChartSession()
    const input = (c: number): RuntimeInput => ({ data: { t: ROWS, other: [] }, signals: { ...BASE_SIGNALS, c }, limits: { maxItems: 1000 } })
    const a = s.evaluate(SPEC, input(1))
    const b = s.evaluate(SPEC, input(2))
    expect(kept(a, b)).toEqual({ marks: [], scales: [] })
  })
})

describe('a pass that failed', () => {
  it('keeps nothing: what it makes is what a fresh evaluation makes of the same inputs', () => {
    const spec = {
      width: 100, height: 50, autosize: 'none',
      signals: [{ name: 'u', value: 0 }, { name: 'bad', update: 'u == 1 ? null[0] : 1' }],
      // (a dataset whose transform throws stops the pass before every mark: none is made, whatever it reads)
      data: [{ name: 't' }, { name: 't2', values: [{ a: 1 }], transform: [{ type: 'formula', as: 'b', expr: 'u == 3 ? null[0] : 1' }] }],
      scales: [
        { name: 'x', type: 'linear', domain: { data: 't', field: 'v' }, range: 'width' },
        // (a scale that throws stops the pass: no mark after it is made, whatever it reads)
        { name: 'z', type: 'linear', domain: { signal: 'u == 2 ? null[0] : [0, 1]' }, range: [0, 1] },
      ],
      marks: [
        { type: 'symbol', name: 'plain', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'v' }, size: counter('failPlain') } } },
        { type: 'symbol', name: 'readsBad', from: { data: 't' }, encode: { update: { x: { signal: 'bad' } } } },
      ],
    } as unknown as VgSpec
    const quiet = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} }
    const s = createChartSession()
    const input = (u: number): RuntimeInput => ({ data: { t: ROWS }, signals: { u }, logger: quiet })
    s.evaluate(spec, input(0))
    for (const u of [1, 0, 2, 0, 3, 0, 3]) expectFresh(spec, s.evaluate(spec, input(u)), input(u), `failed pass, u ${u}`)
  })
})

describe('a dataset that throws on an update told what changed', () => {
  it('stops the pass before the marks: none is kept (one used to be)', () => {
    const spec = {
      width: 100, height: 50, autosize: 'none',
      data: [{ name: 't' }, { name: 'o' }, { name: 'o2', source: 'o', transform: [{ type: 'formula', as: 'b', expr: 'datum.a == 1 ? null[0] : 1' }] }],
      marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { field: 'v' } } } }],
    } as unknown as VgSpec
    const quiet = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} }
    const chart = compileChart(spec)
    evaluateChart(chart, { data: { t: ROWS, o: [{ a: 0 }] }, logger: quiet })
    const input: RuntimeInput = { data: { t: ROWS, o: [{ a: 1 }] }, logger: quiet }
    const scene = evaluateChart(chart, { ...input, changedDatasets: ['o'] })
    expect(scene.items.filter((g) => g.role === 'mark')).toEqual([])
    expectFresh(spec, scene, input, 'dataset threw')
  })
})

describe('a mark that reads the items of another, kept, mark', () => {
  it('reads the items the kept mark has (they used to be missing)', () => {
    const spec = {
      width: 100, height: 100, autosize: 'none',
      data: [{ name: 't' }, { name: 'u' }],
      marks: [
        { type: 'symbol', name: 'a', from: { data: 't' }, encode: { update: { x: { field: 'x' } } } },
        { type: 'rect', from: { data: 'u' }, encode: { update: { x: { field: 'y' } } } },
        { type: 'text', from: { data: 'a' }, encode: { update: { x: { field: 'x' }, text: { value: 'l' } } } },
      ],
    } as unknown as VgSpec
    const chart = compileChart(spec)
    const t = [{ x: 1 }, { x: 2 }]
    evaluateChart(chart, { data: { t, u: [{ y: 1 }] } })
    const input: RuntimeInput = { data: { t, u: [{ y: 5 }] } }
    const scene = evaluateChart(chart, { ...input, changedDatasets: ['u'] })
    expect((scene.items.find((g) => g.marktype === 'text')!.items as SceneItem[]).length).toBe(2)
    expectFresh(spec, scene, input, 'mark items')
  })
})

describe('a view that fits its container', () => {
  it('keeps what reads no signal that changed in both passes, and makes the fresh scene', () => {
    const spec = { ...SPEC, autosize: { type: 'fit', contains: 'padding' } } as unknown as VgSpec
    const s = createChartSession()
    const input = (c: number, a: number): RuntimeInput => ({ data: { t: ROWS, other: [] }, signals: { ...BASE_SIGNALS, c, a }, width: 300, height: 160 })
    const a = s.evaluate(spec, input(1, 10))
    const b = s.evaluate(spec, input(2, 10))
    expect(kept(a, b).marks).toEqual(LEAF.filter((n) => !['byDataFn', 'byDataScale', 'withTransform'].includes(n)))
    expectFresh(spec, b, input(2, 10), 'fit: unread')
    const c = s.evaluate(spec, input(2, 14))
    expect(kept(b, c).marks).toEqual(LEAF.filter((n) => !['bySignal', 'byExpr', 'byDataFn', 'byDataScale', 'withTransform'].includes(n)))
    expectFresh(spec, c, input(2, 14), 'fit: read')
  })
})

describe('a scale with bins in a view that fits its container', () => {
  it('is made again in each pass: what it leaves the next pass is the pass\'s own', () => {
    const spec = {
      width: 300, height: 120, autosize: { type: 'fit', contains: 'padding' },
      signals: [{ name: 'u', value: 0 }, { name: 'fmt', value: 'd' }, { name: 'bs', value: { start: 0, stop: 20, step: 5 } }],
      data: [{ name: 't' }],
      scales: [
        { name: 'x', type: 'linear', domain: { data: 't', field: 'v' }, bins: { signal: 'bs' }, range: 'width' },
        { name: 'y', type: 'linear', domain: { data: 't', field: 'v' }, range: 'height' },
      ],
      // (the left axis's labels are as wide as its format makes them: the overflow, and the fitted width, move with it)
      axes: [{ orient: 'left', scale: 'y', format: { signal: 'fmt' } }, { orient: 'bottom', scale: 'x' }],
      marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'v' }, size: counter('binned') } } }],
    } as unknown as VgSpec
    const rows = Array.from({ length: 12 }, (_, i) => ({ v: 4 + i }))
    const s = createChartSession()
    const input = (u: number, fmt: string): RuntimeInput => ({ data: { t: rows }, signals: { u, fmt } })
    s.evaluate(spec, input(0, 'd'))
    for (const [u, fmt] of [[1, 'd'], [1, '.6f'], [2, '.6f'], [2, 'd']] as const) expectFresh(spec, s.evaluate(spec, input(u, fmt)), input(u, fmt), `bins, u ${u}, ${fmt}`)
  })
})

describe('a mark that reads a projection', () => {
  it('is made again when a signal of the projection changes, by a geo function or by its clip', () => {
    const spec = {
      width: 100, height: 100, autosize: 'none',
      signals: [{ name: 'ps', value: 100 }, { name: 'u', value: 0 }],
      projections: [{ name: 'proj', type: 'mercator', scale: { signal: 'ps' }, translate: [50, 50] }],
      data: [{ name: 'pts', values: [{ lon: 10, lat: 20 }, { lon: -30, lat: 5 }] }],
      marks: [
        { type: 'symbol', name: 'centroid', from: { data: 'pts' }, encode: { update: { x: { signal: "geoCentroid('proj', {type: 'Point', coordinates: [datum.lon, datum.lat]})[0]" }, y: { value: 1 } } } },
        { type: 'rect', name: 'clipped', clip: { sphere: 'proj' }, encode: { update: { x: { value: 0 }, width: { value: 100 }, height: { value: 100 } } } },
      ],
    } as unknown as VgSpec
    const s = createChartSession()
    const input = (ps: number, u: number): RuntimeInput => ({ signals: { ps, u } })
    const a = s.evaluate(spec, input(100, 0))
    const b = s.evaluate(spec, input(150, 0))
    expect(groupNamed(b, 'centroid')).not.toBe(groupNamed(a, 'centroid'))
    expect(groupNamed(b, 'clipped')).not.toBe(groupNamed(a, 'clipped'))
    expectFresh(spec, b, input(150, 0), 'projection')
    // (a signal no projection reads: a projection's reads are not known, so these marks read every signal)
    const c = s.evaluate(spec, input(150, 1))
    expect(groupNamed(c, 'centroid')).not.toBe(groupNamed(b, 'centroid'))
    expectFresh(spec, c, input(150, 1), 'projection, unread')
  })
})
