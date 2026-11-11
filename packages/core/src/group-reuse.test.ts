/**
 * Marks inside group items (a facet's cells, a group drawn from a dataset, a group with no data, a line per category) are kept by the
 * item they are in, and only the rows that changed are encoded; an unchanged group item, guide or title keeps its identity.
 *
 * Every step pins the scene a fresh evaluation makes (and its SVG), and the reuse: the items kept by identity, the items each mark
 * encodes, and the group items kept. What a kept mark reads besides its rows is pinned one read at a time: a signal it names, its
 * group item's datum through `parent`, a dataset its expression reads by name, a scale, the item's box.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { compileChart } from './compiler.js'
import { evaluateChart } from './evaluate.js'
import { registerExpressionFunction } from './expression.js'
import { createChartSession } from './session.js'
import { renderSceneToSvg } from './index.js'
import type { RuntimeInput, SceneGroup, SceneItem, SceneRoot, VgSpec } from './types.js'

type Row = Record<string, unknown>

const encodes = new Map<string, number>()
let dispose: (() => void) | undefined
beforeAll(() => {
  dispose = registerExpressionFunction('grCount', (name: string) => { encodes.set(name, (encodes.get(name) ?? 0) + 1); return 1 })
})
afterAll(() => dispose?.())
const counter = (name: string): { signal: string } => ({ signal: `grCount('${name}')` })
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
  if (typeof v === 'number') return Number.isNaN(v) ? '[NaN]' : Object.is(v, -0) ? '[-0]' : v === Infinity ? '[Inf]' : v === -Infinity ? '[-Inf]' : v
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
function expectFresh(spec: VgSpec, scene: SceneRoot, input: RuntimeInput, what: string): void {
  const want = evaluateChart(compileChart(spec), input)
  expect(norm(scene), what).toEqual(norm(want))
  expect(renderSceneToSvg(scene), what).toBe(renderSceneToSvg(want))
}

/** The leaf mark groups named `name`, anywhere, in scene order. */
function marksNamed(scene: SceneRoot, name: string): SceneGroup[] {
  const out: SceneGroup[] = []
  const walk = (items: readonly unknown[]): void => {
    for (const it of items) {
      const g = it as SceneGroup & { name?: string }
      if (g.role === 'mark' && g.marktype !== 'group') { if (g.name === name) out.push(g) } else if (Array.isArray(g.items)) walk(g.items)
    }
  }
  walk(scene.items)
  return out
}
const itemsOf = (scene: SceneRoot, name: string): SceneItem[] => marksNamed(scene, name).flatMap((g) => g.items as SceneItem[])
const keptItems = (a: SceneRoot, b: SceneRoot, name: string): number => { const was = new Set(itemsOf(a, name)); return itemsOf(b, name).filter((x) => was.has(x)).length }
/** The group items (role `scope`, the cells) anywhere, in scene order. */
function cells(scene: SceneRoot): SceneGroup[] {
  const out: SceneGroup[] = []
  const walk = (items: readonly unknown[]): void => {
    for (const it of items) {
      const g = it as SceneGroup
      if (g.marktype === 'group' && g.role !== 'mark' && Array.isArray(g.items)) { if (g.role === 'scope') out.push(g); walk(g.items) }
    }
  }
  walk(scene.items)
  return out
}

const AXIS = { orient: 'bottom', scale: 'x', grid: true, tickCount: 3 }

/** The charts: each holds a leaf mark `m` (counting its encodes) inside group items, over the host's rows `t`. */
const CHARTS: Record<string, VgSpec> = {
  'a facet by category, with a grid axis in each cell': {
    width: 300, height: 100, padding: 5, autosize: 'none',
    data: [{ name: 't' }, { name: 'd', source: 't', transform: [{ type: 'filter', expr: 'isValid(datum.v)' }] }],
    scales: [
      { name: 'x', type: 'linear', domain: [0, 100], range: [0, 60] },
      { name: 'c', type: 'ordinal', domain: { data: 'd', field: 'g', sort: true }, range: 'category' },
    ],
    marks: [{
      type: 'group', name: 'cell', from: { facet: { name: 'part', data: 'd', groupby: ['g'] } },
      encode: { update: { x: { scale: 'c', field: 'g', mult: 0 }, width: { value: 60 }, height: { value: 80 } } },
      axes: [AXIS],
      marks: [{ type: 'symbol', name: 'm', from: { data: 'part' }, encode: { update: { x: { scale: 'x', field: 'v' }, y: { value: 5 }, fill: { scale: 'c', field: 'g' }, size: counter('m') } } }],
    }],
  } as unknown as VgSpec,
  'a line per category, sorted': {
    width: 300, height: 100, padding: 5, autosize: 'none',
    data: [{ name: 't' }],
    scales: [
      { name: 'x', type: 'linear', domain: [0, 100], range: 'width' },
      { name: 'c', type: 'ordinal', domain: { data: 't', field: 'g' }, range: 'category' },
    ],
    marks: [{
      type: 'group', from: { facet: { name: 'series', data: 't', groupby: 'g' } },
      encode: { update: { width: { field: { group: 'width' } }, height: { field: { group: 'height' } } } },
      marks: [{ type: 'line', name: 'm', sort: { field: 'x' }, from: { data: 'series' }, encode: { update: { x: { scale: 'x', field: 'v' }, y: { field: 'i' }, stroke: { scale: 'c', field: 'g' }, strokeOpacity: counter('m') } } }],
    }],
  } as unknown as VgSpec,
  'a group with no data, then a group per row of another dataset': {
    width: 300, height: 100, padding: 5, autosize: 'none',
    data: [{ name: 't' }, { name: 'panes', values: [{ p: 1 }, { p: 2 }] }],
    scales: [{ name: 'x', type: 'linear', domain: [0, 100], range: [0, 100] }],
    marks: [
      { type: 'group', encode: { update: { width: { value: 100 }, height: { value: 50 } } }, axes: [AXIS],
        marks: [{ type: 'rect', name: 'm', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'v' }, width: { value: 2 }, height: { value: 3 }, fillOpacity: counter('m') } } }] },
      { type: 'group', from: { data: 'panes' }, encode: { update: { x: { field: 'p', mult: 120 }, width: { value: 100 }, height: { value: 50 } } },
        marks: [{ type: 'rect', name: 'n', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'v' }, width: { value: 2 }, height: { value: 3 }, fillOpacity: counter('n') } } }] },
    ],
  } as unknown as VgSpec,
  'a facet inside a group': {
    width: 300, height: 100, padding: 5, autosize: 'none',
    data: [{ name: 't' }],
    scales: [{ name: 'x', type: 'linear', domain: [0, 100], range: [0, 60] }],
    marks: [{
      type: 'group', encode: { update: { width: { value: 300 }, height: { value: 100 } } },
      marks: [{
        type: 'group', from: { facet: { name: 'inner', data: 't', groupby: 'g' } },
        encode: { update: { width: { value: 60 }, height: { value: 40 } } },
        marks: [{ type: 'symbol', name: 'm', from: { data: 'inner' }, encode: { update: { x: { scale: 'x', field: 'v' }, size: counter('m') } } }],
      }],
    }],
  } as unknown as VgSpec,
}

let serial = 1000
const r = (g: string, v: unknown = 50): Row => ({ i: serial++ % 97, g, v })
const ROWS: Row[] = Array.from({ length: 30 }, (_, i) => ({ i, g: ['b', 'a', 'c'][i % 3], v: i % 11 === 5 ? null : (i * 7) % 100 }))

/** A change: the next rows, how many rows it touches, and whether it adds or drops a category (every cell is then made again). */
interface Change { what: string; to: (t: Row[]) => Row[]; touches: number; categories?: boolean }
const CHANGES: Change[] = [
  { what: 'a row of a category appended', to: (t) => [...t, r('a', 40)], touches: 1 },
  { what: 'a value edited', to: (t) => t.map((x, k) => (k === 4 ? { ...x, v: 3 } : x)), touches: 1 },
  { what: 'a row moved to another category', to: (t) => t.map((x, k) => (k === 7 ? { ...x, g: 'c' } : x)), touches: 1 },
  { what: 'a row removed', to: (t) => t.filter((_, k) => k !== 9), touches: 0 },
  { what: 'two rows swapped', to: (t) => { const n = t.slice(); [n[2], n[8]] = [n[8]!, n[2]!]; return n }, touches: 2 },
  { what: 'a row inserted in the middle', to: (t) => [...t.slice(0, 12), r('b', 60), ...t.slice(12)], touches: 1 },
  { what: 'a row with no value appended', to: (t) => [...t, r('c', null)], touches: 1 },
  { what: 'a new category', to: (t) => [...t, r('z', 20)], touches: 1, categories: true },
  { what: 'the new category removed', to: (t) => t.filter((x) => x.g !== 'z'), touches: 0, categories: true },
  { what: 'the rows as they were, in a new array', to: (t) => t.map((x) => ({ ...x })), touches: 0 },
]

describe('marks inside group items are kept by the item they are in', () => {
  for (const [name, spec] of Object.entries(CHARTS)) {
    it(name, () => {
      const s = createChartSession()
      let t = ROWS
      let prev = s.evaluate(spec, { data: { t } })
      let keptCells = 0
      for (const change of CHANGES) {
        t = change.to(t)
        const input: RuntimeInput = { data: { t } }
        const what = `${name}: ${change.what}`
        const { scene, encoded } = encodedBy(() => s.evaluate(spec, input))
        expectFresh(spec, scene, input, what)
        for (const m of ['m', 'n']) {
          const total = itemsOf(scene, m).length
          if (total === 0) continue
          // (each instance of the mark, one per group item, encodes the rows the change touched)
          const touched = change.touches * marksNamed(scene, m).length
          if (change.categories && (spec as unknown as { scales: Array<{ name: string }> }).scales.some((sc) => sc.name === 'c')) {
            // (a category added or dropped moves the colour scale, which every cell reads)
            expect(encoded[m] ?? 0, `${what}: ${m} encoded`).toBe(total)
          } else {
            expect(encoded[m] ?? 0, `${what}: ${m} encoded`).toBeLessThanOrEqual(touched)
            expect(keptItems(prev, scene, m), `${what}: ${m} kept`).toBeGreaterThanOrEqual(total - touched)
          }
        }
        const was = new Set(cells(prev))
        keptCells += cells(scene).filter((c) => was.has(c)).length
        prev = scene
      }
      // (cells whose rows did not change kept their identity, guides and all)
      expect(keptCells, name).toBeGreaterThan(0)
    })
  }

  it('a cell whose rows and reads are unchanged is the same object, with its grid axis; the cell that changed is new', () => {
    const spec = CHARTS['a facet by category, with a grid axis in each cell']!
    const s = createChartSession()
    const a = s.evaluate(spec, { data: { t: ROWS } })
    const b = s.evaluate(spec, { data: { t: [...ROWS, r('a', 40)] } })
    const before = cells(a)
    const after = cells(b)
    expect(after.length).toBe(3)
    const byKey = (cs: SceneGroup[]): Map<unknown, SceneGroup> => new Map(cs.map((c) => [(c as { datum?: Row }).datum?.g, c]))
    expect(byKey(after).get('b')).toBe(byKey(before).get('b'))
    expect(byKey(after).get('c')).toBe(byKey(before).get('c'))
    expect(byKey(after).get('a')).not.toBe(byKey(before).get('a'))
    // (the cell that changed is new, its grid axis, which did not, is the one before)
    const axis = (c: SceneGroup | undefined): unknown => (c?.items as SceneGroup[] | undefined)?.find((g) => g.role === 'axis')
    expect(axis(byKey(after).get('a'))).toBeDefined()
    expect(axis(byKey(after).get('a'))).toBe(axis(byKey(before).get('a')))
  })
})

describe('what a mark inside a group item reads besides its rows', () => {
  // (`boxed`: the cell's box moves with its count, so a mark that reads its box reads the count; otherwise the box stays)
  const facet = (inner: Record<string, unknown>, extra: Partial<Record<string, unknown>> = {}, boxed = true): VgSpec => ({
    width: 300, height: 100, padding: 5, autosize: 'none',
    signals: [{ name: 'k', value: 1 }, { name: 'u', value: 0 }],
    data: [{ name: 't' }, { name: 'store' }],
    scales: [{ name: 'x', type: 'linear', domain: { signal: '[0, 100 * k]' }, range: [0, 60] }],
    ...extra,
    marks: [{
      type: 'group', from: { facet: { name: 'part', data: 't', groupby: 'g' } },
      encode: { update: { ...(boxed ? { x: { field: 'count', mult: 3 } } : {}), width: { value: 60 }, height: { value: 40 } } },
      marks: [{ type: 'symbol', name: 'm', from: { data: 'part' }, encode: { update: { size: counter('m'), ...inner } } }],
    }],
  } as unknown as VgSpec)
  const cases: Array<{ what: string; spec: VgSpec; step: (w: { t: Row[]; k: number; u: number; store: Row[] }) => { t: Row[]; k: number; u: number; store: Row[] }; all: boolean }> = [
    { what: 'a signal it names', spec: facet({ x: { signal: 'datum.v * k' } }), step: (w) => ({ ...w, k: 2 }), all: true },
    { what: 'a signal it does not name', spec: facet({ x: { signal: 'datum.v * k' } }), step: (w) => ({ ...w, u: 3 }), all: false },
    { what: 'a scale', spec: facet({ x: { scale: 'x', field: 'v' } }), step: (w) => ({ ...w, k: 2 }), all: true },
    { what: 'its group item through `parent` (the count of the cell)', spec: facet({ x: { signal: 'parent.count' } }), step: (w) => ({ ...w, t: [...w.t, r('a', 1)] }), all: true },
    { what: 'its group item through a field reference', spec: facet({ x: { field: { parent: 'count' } } }, {}, false), step: (w) => ({ ...w, t: [...w.t, r('a', 1)] }), all: true },
    { what: 'its group item\'s box', spec: facet({ x: { field: { group: 'x' } } }), step: (w) => ({ ...w, t: [...w.t, r('a', 1)] }), all: true },
    // (a mark's transform runs on its items: a row removed renumbers the rows after it)
    { what: 'its own transform over its items', spec: { ...facet({ x: { field: 'rn' } }), marks: [{
      type: 'group', from: { facet: { name: 'part', data: 't', groupby: 'g' } },
      encode: { update: { width: { value: 60 }, height: { value: 40 } } },
      marks: [{ type: 'symbol', name: 'm', from: { data: 'part' }, transform: [{ type: 'window', ops: ['row_number'], as: ['rn'] }], encode: { update: { size: counter('m'), x: { field: 'v' } } } }],
    }] } as unknown as VgSpec, step: (w) => ({ ...w, t: w.t.filter((x, i) => !(i === 1 && x.g === 'a')) }), all: true },
    { what: 'a dataset its expression reads by name', spec: facet({ opacity: { signal: "length(data('store')) ? 0.5 : 1" } }), step: (w) => ({ ...w, store: [{ s: 1 }] }), all: true },
  ]
  for (const c of cases) {
    it(c.what, () => {
      const input = (w: { t: Row[]; k: number; u: number; store: Row[] }): RuntimeInput => ({ data: { t: w.t, store: w.store }, signals: { k: w.k, u: w.u } })
      const s = createChartSession()
      let w = { t: ROWS.filter((x) => x.v !== null), k: 1, u: 0, store: [] as Row[] }
      s.evaluate(c.spec, input(w))
      w = c.step(w)
      const { scene, encoded } = encodedBy(() => s.evaluate(c.spec, input(w)))
      expectFresh(c.spec, scene, input(w), c.what)
      const a = itemsOf(scene, 'm').filter((it) => ((it as { datum?: Row }).datum?.g === 'a')).length
      if (c.all) expect(encoded.m ?? 0, c.what).toBeGreaterThanOrEqual(a)
      else expect(encoded.m ?? 0, c.what).toBe(0)
    })
  }
})

describe('a group per row of a dataset', () => {
  it('a mark that reads its row through `parent` in an expression is made again when the row changes, and kept when it does not', () => {
    const spec = {
      width: 300, height: 100, padding: 5, autosize: 'none',
      data: [{ name: 't' }, { name: 'panes' }],
      marks: [{ type: 'group', from: { data: 'panes' }, encode: { update: { width: { value: 100 }, height: { value: 50 } } },
        marks: [{ type: 'rect', name: 'm', from: { data: 't' }, encode: { update: { x: { signal: 'parent.w + datum.i' }, width: { value: 2 }, height: { value: 3 }, fillOpacity: counter('m') } } }] }],
    } as unknown as VgSpec
    const s = createChartSession()
    const t = ROWS.slice(0, 6)
    s.evaluate(spec, { data: { t, panes: [{ w: 1 }, { w: 2 }] } })
    for (const [panes, encodedWant] of [[[{ w: 1 }, { w: 2 }], 0], [[{ w: 1 }, { w: 5 }], 6], [[{ w: 1 }, { w: 5 }, { w: 7 }], 6]] as const) {
      const input: RuntimeInput = { data: { t, panes: panes.map((p) => ({ ...p })) } }
      const { scene, encoded } = encodedBy(() => s.evaluate(spec, input))
      expectFresh(spec, scene, input, JSON.stringify(panes))
      expect(encoded.m ?? 0, JSON.stringify(panes)).toBe(encodedWant)
    }
  })
})
