/**
 * A top-level leaf mark over the rows its items were made from evaluates again only the channels that read what changed; a mark
 * drawn from another mark's items is made again only when what it reads of them, or anything else it reads, changed.
 *
 * The chart is the Vega-Lite multi-series tooltip's shape: a rule per row whose `opacity` tests a selection store, with a tooltip and a
 * description formatted from the row, and a voronoi path per rule item, drawn from the rule's items, with its own tooltip. Counting
 * functions sit in the channels that read nothing that changes. After every step the scene (every property of every node, and the
 * order of each node's keys), the SVG and the datasets equal a fresh evaluation of the same input.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { compileChart } from './compiler.js'
import { evaluateChart } from './evaluate.js'
import { registerExpressionFunction } from './expression.js'
import { createChartSession } from './session.js'
import { datasetsOfScene, renderSceneToSvg } from './index.js'
import './addon-transforms.js'
import type { RuntimeInput, SceneGroup, SceneItem, SceneRoot, VgSpec } from './types.js'

type Row = Record<string, unknown>

const counts = new Map<string, number>()
let dispose: (() => void) | undefined
beforeAll(() => { dispose = registerExpressionFunction('crCount', (name: string) => { counts.set(name, (counts.get(name) ?? 0) + 1); return name }) })
afterAll(() => dispose?.())
const counted = (run: () => SceneRoot): { scene: SceneRoot; ran: Record<string, number> } => {
  const before = new Map(counts)
  const scene = run()
  const ran: Record<string, number> = {}
  for (const [k, v] of counts) if (v !== (before.get(k) ?? 0)) ran[k] = v - (before.get(k) ?? 0)
  return { scene, ran }
}

const SKIP = new Set(['runtime', 'compiled', '__scaleMap', '__gen', '__itemGen', '__domDesc', '__source'])
function norm(v: unknown, depth = 0): unknown {
  if (depth > 40) return '[deep]'
  if (v === undefined || v === null || typeof v === 'string' || typeof v === 'boolean') return v
  if (typeof v === 'number') return Number.isNaN(v) ? '[NaN]' : Object.is(v, -0) ? '[-0]' : v
  if (typeof v === 'function') return '[fn]'
  if (v instanceof Map || v instanceof Set) return '[collection]'
  if (Array.isArray(v)) return v.map((x) => norm(x, depth + 1) ?? null)
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(v as object).sort()) {
    if (SKIP.has(k)) continue
    const n = norm((v as Row)[k], depth + 1)
    if (n !== undefined) out[k] = n
  }
  return out
}
function keyOrders(v: unknown, out: string[] = [], depth = 0): string[] {
  if (v === null || typeof v !== 'object' || depth > 40) return out
  if (Array.isArray(v)) { for (const x of v) keyOrders(x, out, depth + 1); return out }
  const keys = Object.keys(v).filter((k) => !SKIP.has(k))
  out.push(keys.join(','))
  for (const k of keys) keyOrders((v as Row)[k], out, depth + 1)
  return out
}
function expectFresh(spec: VgSpec, scene: SceneRoot, input: RuntimeInput, what: string): void {
  const fresh = evaluateChart(compileChart(spec), input)
  expect(norm(scene), what).toEqual(norm(fresh))
  expect(keyOrders(scene.items), `${what}: key order`).toEqual(keyOrders(fresh.items))
  expect(renderSceneToSvg(scene), what).toBe(renderSceneToSvg(fresh))
  expect(norm(Object.fromEntries(datasetsOfScene(scene))), what).toEqual(norm(Object.fromEntries(datasetsOfScene(fresh))))
}

const ROWS: Row[] = Array.from({ length: 30 }, (_, i) => ({ x: i * 3 + (i % 4), a: ((i * 37) % 100) / 100, b: ((i * 11) % 100) / 100 }))

const SPEC: VgSpec = {
  width: 300, height: 200, padding: 5, autosize: 'none',
  signals: [
    { name: 'lo', value: 0 },
    { name: 'w', value: 1 },
    { name: 'tag', value: 'on' },
    { name: 'other', value: 0 },
  ],
  data: [{ name: 'store' }, { name: 't', values: ROWS }],
  scales: [
    { name: 'x', type: 'linear', domain: { data: 't', field: 'x' }, domainRaw: { signal: 'lo > 0 ? [lo, 100] : null' }, range: 'width', zero: false },
    { name: 'sw', type: 'linear', domain: [0, { signal: 'w * 10' }], range: [1, 5] },
  ],
  marks: [
    {
      type: 'rule', name: 'rules', from: { data: 't' },
      encode: { update: {
        x: { scale: 'x', field: 'x' }, y: { value: 0 }, y2: { signal: 'height' }, stroke: { value: 'black' },
        strokeWidth: { scale: 'sw', field: 'x' },
        tooltip: { signal: "{x: format(datum.x, ''), a: format(datum.a, '.3f'), b: format(datum.b, '.3f'), n: crCount('ruleTip')}" },
        description: { signal: "'x ' + format(datum.x, '') + crCount('ruleDesc')" },
        opacity: [{ test: "length(data('store')) && indata('store', 'x', datum.x)", value: 0.3 }, { value: 0 }],
        // (a channel that comes out undefined for some rows and some signal values: the item's keys change, it is encoded whole)
        href: { signal: "tag === 'on' && datum.x % 3 ? 'https://example.com/' + datum.x : datum.nothing" },
        cursor: { value: 'pointer' },
      } },
    },
    {
      type: 'path', name: 'cells', from: { data: 'rules' },
      encode: { update: { fill: { value: 'transparent' }, stroke: { value: 'transparent' }, isVoronoi: { value: true }, tooltip: { signal: "{x: format(datum.datum.x, ''), n: crCount('cellTip')}" } } },
      transform: [{ type: 'voronoi', x: { expr: 'datum.datum.x || 0' }, y: { expr: 'datum.datum.a * 100' }, size: [{ signal: 'width' }, { signal: 'height' }] }],
    },
    { type: 'text', encode: { update: { text: { signal: "'o' + other" }, x: { value: 1 }, y: { value: 1 } } } },
  ],
} as unknown as VgSpec

const at = (x: number | null): Row[] => (x === null ? [] : [{ x }])

describe('only what reads what changed is evaluated again', () => {
  it('a store, a scale, a signal and an undefined channel, step by step', () => {
    const s = createChartSession()
    let input: RuntimeInput = { data: { t: ROWS, store: at(null) }, signals: {} }
    s.evaluate(SPEC, input)
    const N = ROWS.length
    const steps: Array<{ what: string; signals?: Row; store?: number | null; ran: Record<string, number> }> = [
      // (only the opacity tests the store: the rule items are copies with it evaluated again; the voronoi reads none of what moved)
      { what: 'a point in the store', store: 12, ran: {} },
      { what: 'another point', store: 24, ran: {} },
      { what: 'a signal nothing reads', signals: { other: 1 }, ran: {} },
      // (the stroke width's scale is made again: that channel is evaluated again, nothing else)
      { what: "the width scale's domain", signals: { other: 1, w: 3 }, ran: {} },
      // (both at once: the store's opacity and the scale's stroke width are evaluated again, on the same copies)
      { what: 'a point and the scale together', signals: { other: 1, w: 4 }, store: 12, ran: {} },
      { what: 'the scale as it was', signals: { other: 1, w: 3 }, ran: {} },
      // (some rows' href comes out undefined now: those items are encoded whole, the others keep their tooltip and description; the
      // items encoded whole hold new copies of their rows, which the voronoi reads (`datum.datum`), so it is made again)
      { what: 'a channel that comes out undefined', signals: { other: 1, w: 3, tag: 'off' }, ran: { ruleTip: N / 2, ruleDesc: N / 2, cellTip: N } },
      { what: 'and back', signals: { other: 1, w: 3, tag: 'on' }, ran: { ruleTip: N / 2, ruleDesc: N / 2, cellTip: N } },
      // (the x scale changes: `x` is coupled to the item's geometry, so every rule item is encoded whole, and the voronoi made again)
      { what: "the x scale's domain", signals: { other: 1, w: 3, tag: 'on', lo: 5 }, ran: { ruleTip: N, ruleDesc: N, cellTip: N } },
      { what: 'the store emptied', store: null, ran: {} },
    ]
    let store: number | null = null
    let signals: Row = {}
    for (const step of steps) {
      if (step.signals) signals = step.signals
      if (step.store !== undefined) store = step.store
      input = { data: { t: ROWS, store: at(store) }, signals }
      const { scene, ran } = counted(() => s.evaluate(SPEC, input))
      expectFresh(SPEC, scene, input, step.what)
      expect(ran, `${step.what}: what ran`).toEqual(step.ran)
    }
  })

  it('a voronoi drawn from rule items whose position changed is made again; its datums are the items as they are now', () => {
    const s = createChartSession()
    const input = (store: number | null, lo: number): RuntimeInput => ({ data: { t: ROWS, store: at(store) }, signals: { lo } })
    s.evaluate(SPEC, input(null, 0))
    const kept = s.evaluate(SPEC, input(12, 0))
    // (the voronoi items read the rule items' datums and positions, unchanged: the paths are the ones before, the datums are new)
    const cells = (scene: SceneRoot): SceneItem[] => (scene.items.find((g) => g.name === 'cells') as SceneGroup).items as SceneItem[]
    const rule12 = cells(kept).find((it) => ((it.datum as Row).datum as Row).x === 12)
    expect((rule12?.datum as Row).opacity).toBe(0.3)
    expectFresh(SPEC, kept, input(12, 0), 'kept')
    const moved = counted(() => s.evaluate(SPEC, input(12, 5)))
    expect(moved.ran.cellTip).toBe(ROWS.length)
    expectFresh(SPEC, moved.scene, input(12, 5), 'moved')
  })

  it('a channel that throws for a row in a step is reported as a whole encode reports it', () => {
    const errors: unknown[][] = []
    const logger = { error: (...a: unknown[]) => { errors.push(a) }, warn: () => {}, info: () => {}, debug: () => {} }
    const spec = {
      ...SPEC,
      marks: [{ ...(SPEC.marks![0] as object), encode: { update: { ...((SPEC.marks![0] as { encode: { update: object } }).encode.update), opacity: { signal: "w > 2 && datum.x > 40 ? datum.nope.deeper : w / 10" } } } }],
    } as unknown as VgSpec
    const s = createChartSession()
    s.evaluate(spec, { data: { t: ROWS, store: [] }, signals: { w: 1 }, logger })
    const scene = s.evaluate(spec, { data: { t: ROWS, store: [] }, signals: { w: 3 }, logger })
    const freshErrors: unknown[][] = []
    const fresh = evaluateChart(compileChart(spec), { data: { t: ROWS, store: [] }, signals: { w: 3 }, logger: { ...logger, error: (...a: unknown[]) => { freshErrors.push(a) } } })
    expect(norm(scene)).toEqual(norm(fresh))
    expect(errors.map((e) => String(e[0]))).toEqual(freshErrors.map((e) => String(e[0])))
    expect(errors.length).toBeGreaterThan(0)
  })
})
