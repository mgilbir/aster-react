/**
 * A discrete scale whose domain comes from data is kept when an update leaves it as it was, and only then.
 *
 * Every step of every walk below pins (a) the scene a fresh evaluation of the same inputs makes, and every observable of the scale
 * (domain, range, the value of each category and of an unknown one, bandwidth, step, paddings, align, round, `unknown`), and (b) the
 * reuse rule itself: the scale is the object of the step before exactly when a fresh evaluation's scale is the same as at the step
 * before, and when it is kept, the marks that read it encode no more than the rows the step touched.
 *
 * The walks cover each discrete scale type (ordinal colour, shape, size and strokeDash; band; point) × each kind of change (rows of
 * a category appended, a new category, rows removed, the last row of a category removed, the category added again, values and
 * categories edited, rows reordered and inserted) × pipelines with and without row-mapping steps (a validity filter, formulas,
 * an identifier, a stack, an aggregate) × sorted and unsorted domains (by key, by count, by an aggregate of another field), and
 * domains of several fields, of several datasets, with a literal member, and under a host `domainRaw`.
 *
 * Two routes prove a domain unchanged: a census of the categories advanced over a pulse that keeps every row's index (rows edited or
 * appended: `advanceDiscCensus` in runtime.ts), and the settings of the scale read again and found the same as the ones it was made
 * from (`sameSettings` in scales.ts), for every other change.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import './addon-transforms.js'
import { compileChart } from './compiler.js'
import { evaluateChart } from './evaluate.js'
import { registerExpressionFunction } from './expression.js'
import { createChartSession } from './session.js'
import { createChartStream } from './stream.js'
import { renderSceneToSvg } from './index.js'
import type { RuntimeInput, SceneGroup, SceneItem, SceneRoot, VgSpec } from './types.js'

type Row = Record<string, unknown>

// `dsCount(<mark>)` is read once per item a mark encodes.
const encodes = new Map<string, number>()
let dispose: (() => void) | undefined
beforeAll(() => {
  dispose = registerExpressionFunction('dsCount', (name: string) => { encodes.set(name, (encodes.get(name) ?? 0) + 1); return 1 })
})
afterAll(() => dispose?.())
const counter = (name: string): { signal: string } => ({ signal: `dsCount('${name}')` })
function encodedBy(run: () => SceneRoot): { scene: SceneRoot; encoded: Record<string, number> } {
  const before = new Map(encodes)
  const scene = run()
  const encoded: Record<string, number> = {}
  for (const [k, v] of encodes) if (v !== (before.get(k) ?? 0)) encoded[k] = v - (before.get(k) ?? 0)
  return { scene, encoded }
}

const SKIP_KEYS = new Set(['runtime', 'compiled', '__scaleMap', '__gen', '__itemGen', '__domDesc', '__source'])
const NUMBERED_SKIP = new Set([...SKIP_KEYS, 'id'])
function norm(v: unknown, depth = 0, skip: ReadonlySet<string> = SKIP_KEYS): unknown {
  if (depth > 40) return '[deep]'
  if (v === undefined || v === null || typeof v === 'string' || typeof v === 'boolean') return v
  if (typeof v === 'number') return Number.isNaN(v) ? '[NaN]' : Object.is(v, -0) ? '[-0]' : v === Infinity ? '[Inf]' : v === -Infinity ? '[-Inf]' : v
  if (typeof v === 'function') return '[fn]'
  if (v instanceof Date) return { $date: v.getTime() }
  if (v instanceof Map || v instanceof Set) return '[collection]'
  if (Array.isArray(v)) return v.map((x) => { const n = norm(x, depth + 1, skip); return n === undefined ? null : n })
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(v as object).sort()) {
    if (skip.has(k)) continue
    const n = norm((v as Record<string, unknown>)[k], depth + 1, skip)
    if (n !== undefined) out[k] = n
  }
  return out
}

type ScaleFn = ((x: unknown) => unknown) & Record<string, (...a: unknown[]) => unknown>
const scaleOf = (scene: SceneRoot, name: string): ScaleFn | undefined => (scene as unknown as { __scaleMap: Map<string, ScaleFn> }).__scaleMap.get(name)

/** Everything a reader sees of a scale; values kept as they are (a number and its text differ, so do 0 and -0). */
function scaleView(s: ScaleFn | undefined): unknown {
  if (!s) return undefined
  const read = (m: string): unknown => (typeof s[m] === 'function' ? s[m]!() : undefined)
  const domain = s.domain!() as unknown[]
  const unknownOf = read('unknown')
  // (an ordinal scale whose unknown is `implicit` adds what it is asked for: it is not asked for a stranger)
  const grows = typeof unknownOf === 'symbol'
  return {
    type: (s as unknown as { type: string }).type,
    domain,
    range: read('range'),
    mapped: domain.map((d) => s(d)),
    stranger: grows ? '[grows]' : s('\u0000not a category'),
    bandwidth: read('bandwidth'),
    step: read('step'),
    paddingInner: read('paddingInner'),
    paddingOuter: read('paddingOuter'),
    align: read('align'),
    round: read('round'),
    unknown: typeof unknownOf === 'function' ? '[scale]' : grows ? '[implicit]' : unknownOf,
  }
}

/** Equal by `Object.is` at the leaves (a Date is a leaf: two of one instant are two values, as the scale's settings tell them). */
function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (a instanceof Date || b instanceof Date) return false
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => same(x, b[i]))
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const ka = Object.keys(a)
    const kb = Object.keys(b)
    return ka.length === kb.length && ka.every((k) => same((a as Row)[k], (b as Row)[k]))
  }
  return false
}

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
const itemCount = (scene: SceneRoot, name: string): number => (groupNamed(scene, name)?.items ?? []).length
/** How many items of the mark are objects the scene before held (anywhere in the mark). */
function keptItems(a: SceneRoot, b: SceneRoot, name: string): number {
  const was = new Set((groupNamed(a, name)?.items ?? []) as SceneItem[])
  return ((groupNamed(b, name)?.items ?? []) as SceneItem[]).filter((it) => was.has(it)).length
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The charts
// ---------------------------------------------------------------------------------------------------------------------------------

/** The scale under test, `s`, by the channel that reads it. */
type Kind = 'color' | 'shape' | 'size' | 'strokeDash' | 'band' | 'point'
const KINDS: Kind[] = ['color', 'shape', 'size', 'strokeDash', 'band', 'point']

/** The steps between the rows the host gives (`t`) and the dataset of the scale's domain (`d`). */
const PIPELINES: Record<string, { tr: unknown[] | null; rowWise: boolean }> = {
  // (the scale reads `t` itself)
  direct: { tr: null, rowWise: true },
  copy: { tr: [], rowWise: true },
  // (Vega-Lite's validity filter; `v` is null in some rows)
  filter: { tr: [{ type: 'filter', expr: 'isValid(datum["v"]) && isFinite(+datum["v"])' }], rowWise: true },
  'formula+filter': {
    tr: [{ type: 'formula', expr: 'toNumber(datum["v"])', as: 'v' }, { type: 'formula', expr: 'upper(datum.g)', as: 'G' },
      { type: 'filter', expr: 'isValid(datum["v"]) && isFinite(+datum["v"])' }],
    rowWise: true,
  },
  // (an identifier after a filter follows every row on a pulse other than an append: its marks may encode more than the rows touched)
  'filter+identifier': { tr: [{ type: 'filter', expr: 'datum.v != null' }, { type: 'identifier', as: 'id' }], rowWise: false },
  stack: { tr: [{ type: 'stack', groupby: ['g'], field: 'v', as: ['v0', 'v1'] }, { type: 'filter', expr: 'isValid(datum["v"])' }], rowWise: false },
  aggregate: { tr: [{ type: 'aggregate', groupby: ['g'], fields: ['v', 'v'], ops: ['count', 'sum'], as: ['n', 'v'] }], rowWise: false },
}

const SORTS: Record<string, unknown> = {
  none: undefined,
  key: true,
  'key desc': { order: 'descending' },
  'field key desc': { field: 'key', order: 'descending' },
  // (no category has such a column: the order of appearance)
  'absent column': { field: 'zz' },
  // (a column named `count` without an op is the count)
  'count column': { field: 'count' },
  count: { op: 'count' },
  'count desc': { op: 'count', order: 'descending' },
  'sum of v desc': { op: 'sum', field: 'v', order: 'descending' },
  'min of i': { op: 'min', field: 'i' },
}

const RANGES: Record<Kind, unknown> = {
  color: 'category',
  shape: 'symbol',
  size: [10, 40, 90, 160, 250, 360],
  strokeDash: [[1, 0], [4, 2], [2, 2], [6, 1, 1, 1], [3, 3], [8, 2]],
  band: 'width',
  point: 'width',
}

interface Variant { kind: Kind; pipeline: string; sort: string; domain?: 'field' | 'fields' | 'datalist' | 'literal' }

function chart(v: Variant): VgSpec {
  const p = PIPELINES[v.pipeline]!
  const ds = p.tr === null ? 't' : 'd'
  const sort = SORTS[v.sort]
  const field = v.pipeline === 'formula+filter' && v.kind === 'band' ? 'G' : 'g'
  const domain = v.domain === 'fields' ? { data: ds, fields: [field, 'h'] }
    : v.domain === 'datalist' ? { fields: [{ data: ds, field }, { data: 'e', field: 'g' }] }
    : v.domain === 'literal' ? { fields: [['zz', 'c'], { data: ds, field }] }
    : { data: ds, field, ...(sort !== undefined ? { sort } : {}) }
  const scale: Row = { name: 's', type: v.kind === 'band' ? 'band' : v.kind === 'point' ? 'point' : 'ordinal', domain, range: RANGES[v.kind] }
  if (v.kind === 'band') scale.padding = 0.1
  if (v.kind === 'point') scale.padding = 0.5
  const positional = v.kind === 'band' || v.kind === 'point'
  const channel = (from: string): Row => positional
    ? { x: { scale: 's', field: from }, width: { scale: 's', band: 1 }, y: { scale: 'y', value: 50 }, height: { value: 5 } }
    : { x: { scale: 'x', field: 'i' }, y: { scale: 'y', value: 50 },
      [v.kind === 'color' ? 'fill' : v.kind]: { scale: 's', field: from } }
  const markType = positional ? 'rect' : 'symbol'
  const enc = (name: string, from: string): Row => ({ update: { ...channel(from), opacity: counter(name) } })
  return {
    width: 300, height: 100, padding: 5, autosize: 'none',
    data: [
      { name: 't' },
      { name: 'u' },
      ...(p.tr !== null ? [{ name: 'd', source: 't', transform: p.tr }] : []),
      // (a second dataset that reads the scale; with a `datalist` domain it feeds it too)
      { name: 'e', source: 'u', transform: [{ type: 'filter', expr: 'datum.g != null' }] },
    ],
    scales: [
      { name: 's', ...scale },
      { name: 'x', type: 'linear', domain: [0, 100], range: 'width' },
      { name: 'y', type: 'linear', domain: [0, 100], range: 'height' },
    ],
    ...(positional ? { axes: [{ orient: 'bottom', scale: 's' }] } : { legends: [{ [v.kind === 'color' ? 'fill' : v.kind]: 's' }] }),
    marks: [
      { type: markType, name: 'pts', from: { data: ds }, encode: enc('pts', field) },
      { type: markType, name: 'others', from: { data: 'e' }, encode: enc('others', 'g') },
    ],
  } as unknown as VgSpec
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------------------------------------------------------------

interface World { t: Row[]; u: Row[]; raw?: unknown[] }
let serial = 1000
const r = (g: unknown, v: unknown = 10, h: unknown = 'x'): Row => ({ i: serial++ % 100, g, v, h })
const T0: Row[] = Array.from({ length: 24 }, (_, i) => ({ i, g: ['c', 'a', 'd', 'b'][i % 4], v: i % 7 === 3 ? null : 5 + i, h: i % 5 === 0 ? 'y' : 'x' }))
const U0: Row[] = [{ i: 1, g: 'a', v: 1 }, { i: 2, g: 'q', v: 2 }, { i: 3, g: null, v: 3 }]

const at = (rows: Row[], i: number, patch: Row): Row[] => rows.map((x, k) => (k === i ? { ...x, ...patch } : x))
const without = (rows: Row[], keep: (x: Row, k: number) => boolean): Row[] => rows.filter(keep)
const firstOf = (rows: Row[], g: unknown): number => rows.findIndex((x) => x.g === g)
const lastOf = (rows: Row[], g: unknown): number => rows.map((x) => x.g).lastIndexOf(g)

/** A step: the next world, and how many rows of `t` or `u` it touches (rows appended, inserted or edited). */
interface Step { what: string; to: (w: World) => World; touches: number }
const STEPS: Step[] = [
  { what: 'a row of a category appended', to: (w) => ({ ...w, t: [...w.t, r('a', 20)] }), touches: 1 },
  { what: 'rows of two categories appended', to: (w) => ({ ...w, t: [...w.t, r('b', 21), r('c', 22)] }), touches: 2 },
  { what: 'a row appended that the filter drops', to: (w) => ({ ...w, t: [...w.t, r('new-dropped', null)] }), touches: 1 },
  { what: 'a value edited', to: (w) => ({ ...w, t: at(w.t, 9, { v: 33 }) }), touches: 1 },
  { what: 'a category edited to one that comes before it', to: (w) => ({ ...w, t: at(w.t, 14, { g: 'c' }) }), touches: 1 },
  { what: 'a category edited to one that first comes after it', to: (w) => ({ ...w, t: at(w.t, 1 + 4, { g: lastG(w.t) }) }), touches: 1 },
  { what: 'a row removed that is not its category\'s last', to: (w) => ({ ...w, t: without(w.t, (_, k) => k !== 6) }), touches: 0 },
  { what: 'a new category appended', to: (w) => ({ ...w, t: [...w.t, r('e', 25)] }), touches: 1 },
  { what: 'rows of the new category appended', to: (w) => ({ ...w, t: [...w.t, r('e', 26), r('e', 27)] }), touches: 2 },
  { what: 'the new category removed', to: (w) => ({ ...w, t: without(w.t, (x) => x.g !== 'e') }), touches: 0 },
  { what: 'the new category added again', to: (w) => ({ ...w, t: [...w.t, r('e', 28)] }), touches: 1 },
  { what: 'the last row of a category edited away', to: (w) => ({ ...w, t: at(w.t, lastOf(w.t, 'e'), { g: 'a' }) }), touches: 1 },
  { what: 'many rows of one category appended (a count sort moves)', to: (w) => ({ ...w, t: [...w.t, ...Array.from({ length: 6 }, (_, k) => r('d', 2 + k))] }), touches: 6 },
  { what: 'a large value appended (a sum sort moves)', to: (w) => ({ ...w, t: [...w.t, r('b', 900)] }), touches: 1 },
  { what: 'two rows swapped (the first category moves)', to: (w) => { const t = w.t.slice(); const j = firstOf(t, 'a'); [t[0], t[j]] = [t[j]!, t[0]!]; return { ...w, t } }, touches: 2 },
  { what: 'two rows of one category swapped', to: (w) => { const t = w.t.slice(); const a = lastOf(t, 'b'); const b = t.slice(0, a).map((x) => x.g).lastIndexOf('b'); [t[a], t[b]] = [t[b]!, t[a]!]; return { ...w, t } }, touches: 2 },
  { what: 'a row inserted in the middle', to: (w) => ({ ...w, t: [...w.t.slice(0, 10), r('d', 11), ...w.t.slice(10)] }), touches: 1 },
  { what: 'the first row of a category removed', to: (w) => ({ ...w, t: without(w.t, (_, k) => k !== firstOf(w.t, 'd')) }), touches: 0 },
  { what: 'the first row of a category edited', to: (w) => ({ ...w, t: at(w.t, firstOf(w.t, 'b'), { g: 'c' }) }), touches: 1 },
  { what: 'a category of the other dataset appended', to: (w) => ({ ...w, u: [...w.u, { i: 9, g: 'a', v: 9 }] }), touches: 1 },
  { what: 'a new category in the other dataset', to: (w) => ({ ...w, u: [...w.u, { i: 10, g: 'w', v: 10 }] }), touches: 1 },
  { what: 'the other dataset\'s new category removed', to: (w) => ({ ...w, u: w.u.filter((x) => x.g !== 'w') }), touches: 0 },
  { what: 'another field of a row edited', to: (w) => ({ ...w, t: at(w.t, 3, { h: 'z' }) }), touches: 1 },
  { what: 'the rows as they were, in a new array', to: (w) => ({ ...w, t: w.t.map((x) => ({ ...x })) }), touches: 0 },
  { what: 'every row replaced', to: (w) => ({ ...w, t: T0.map((x) => ({ ...x })) }), touches: Infinity },
]
const lastG = (t: Row[]): unknown => {
  const order: unknown[] = []
  for (const x of t) if (!order.includes(x.g)) order.push(x.g)
  return order[order.length - 1]
}

/**
 * What changed from `a` to `b`, told to the engine instead of found by the session: the rows of the same length that are not the same
 * object, or the rows appended. (The session finds a change by `===`, which does not tell `0` from `-0`.)
 */
function hintsOf(a: Row[], b: Row[]): Partial<RuntimeInput> {
  if (a.length === b.length) return { dataChanges: { t: b.flatMap((x, i) => (x === a[i] ? [] : [i])) } }
  if (b.length > a.length && a.every((x, i) => x === b[i])) return { dataPulse: { t: { changed: [], appendOnly: true, baseLength: a.length, added: [[a.length, b.length]] } } }
  throw new Error('hintsOf: neither an edit nor an append')
}

const input = (w: World): RuntimeInput => ({ data: { t: w.t, u: w.u }, ...(w.raw ? { domainRaw: { s: w.raw } } : {}) })

/**
 * Walk `steps` through a session (as `<Chart>` drives it: a new array per update, diffed by the session), checking each step against
 * a fresh evaluation, and the reuse rule. Returns how many steps kept the scale and how many made it again.
 */
function walk(v: Variant, steps: Step[], start: World = { t: T0, u: U0 }, hinted = false): { kept: number; made: number } {
  const spec = chart(v)
  const label = `${v.kind} / ${v.pipeline} / sort ${v.sort} / ${v.domain ?? 'field'}`
  const s = createChartSession()
  let w = start
  let prev = s.evaluate(spec, input(w))
  let prevFresh = evaluateChart(compileChart(spec), input(w))
  let prevT = w.t
  let kept = 0
  let made = 0
  for (const step of steps) {
    w = step.to(w)
    const what = `${label}: ${step.what}`
    const hints = hinted ? hintsOf(prevT, w.t) : {}
    prevT = w.t
    const { scene, encoded } = encodedBy(() => s.evaluate(spec, { ...input(w), ...hints }))
    const fresh = evaluateChart(compileChart(spec), input(w))
    // (a) the scene and the scale are a fresh evaluation's
    // (an identifier's numbers depend on how the view got there, not on the rows alone: a fresh evaluation numbers the rows
    // from the start, while the view keeps a row's number as the rows change. Nothing here reads them: they are left out)
    const skip = v.pipeline === 'filter+identifier' ? NUMBERED_SKIP : SKIP_KEYS
    expect(norm(scene, 0, skip), what).toEqual(norm(fresh, 0, skip))
    expect(renderSceneToSvg(scene), what).toBe(renderSceneToSvg(fresh))
    expect(same(scaleView(scaleOf(scene, 's')), scaleView(scaleOf(fresh, 's'))), `${what}: the scale`).toBe(true)
    // (b) kept exactly when a fresh evaluation's scale is as it was
    const unchanged = same(scaleView(scaleOf(fresh, 's')), scaleView(scaleOf(prevFresh, 's')))
    const isKept = scaleOf(scene, 's') === scaleOf(prev, 's')
    // (an ordinal scale that adds what it is asked for to its domain, as one given a `domainRaw` does, is never kept: what reads it
    // changes it)
    // (the session hands back the scene it made when the inputs are the very same: everything is kept)
    const grows = typeof scaleOf(fresh, 's')!.unknown?.() === 'symbol'
    expect(isKept, `${what}: kept`).toBe(scene === prev || (unchanged && !grows))
    if (isKept) kept++
    else made++
    const n = itemCount(scene, 'pts') + itemCount(scene, 'others')
    const e = (encoded.pts ?? 0) + (encoded.others ?? 0)
    if (!isKept) {
      // (everything that reads the scale is made again, as a fresh evaluation makes it)
      expect(e, `${what}: encoded`).toBe(n)
    } else if (PIPELINES[v.pipeline]!.rowWise && step.touches !== Infinity) {
      expect(e, `${what}: encoded`).toBeLessThanOrEqual(step.touches)
      expect(keptItems(prev, scene, 'pts') + keptItems(prev, scene, 'others'), `${what}: items kept`).toBeGreaterThanOrEqual(n - step.touches)
    }
    prev = scene
    prevFresh = fresh
  }
  return { kept, made }
}

describe('a discrete scale over data is kept exactly when its result is unchanged', () => {
  for (const kind of KINDS) {
    for (const pipeline of Object.keys(PIPELINES)) {
      it(`${kind} over ${pipeline}: every sort`, () => {
        let kept = 0
        let made = 0
        for (const sort of Object.keys(SORTS)) {
          // (a sort by an aggregate of `v` over the aggregate's output reads its `v`; by `i`, which it has not, the order of appearance)
          const out = walk({ kind, pipeline, sort }, STEPS)
          kept += out.kept
          made += out.made
        }
        // (both outcomes happen in every combination: the walk is not vacuous)
        expect(kept).toBeGreaterThan(0)
        expect(made).toBeGreaterThan(0)
      })
    }
  }

  for (const domain of ['fields', 'datalist', 'literal'] as const) {
    it(`a domain of ${domain === 'fields' ? 'several fields' : domain === 'datalist' ? 'several datasets' : 'a literal and a field'}`, () => {
      for (const kind of ['color', 'band'] as const) {
        for (const pipeline of ['direct', 'filter', 'formula+filter', 'stack']) {
          const out = walk({ kind, pipeline, sort: 'none', domain }, STEPS)
          expect(out.kept, `${kind} / ${pipeline}`).toBeGreaterThan(0)
          expect(out.made, `${kind} / ${pipeline}`).toBeGreaterThan(0)
        }
      }
    })
  }

  it('a domain given by the host (`domainRaw`): kept over any change of the rows, made again when the override changes', () => {
    for (const kind of ['color', 'band', 'point'] as const) {
      const steps: Step[] = [
        ...STEPS.slice(0, 12),
        { what: 'the override changed', to: (w) => ({ ...w, raw: ['a', 'b'] }), touches: 0 },
        { what: 'a new category appended under the override', to: (w) => ({ ...w, t: [...w.t, r('k', 3)] }), touches: 1 },
        { what: 'the override equal, in a new array', to: (w) => ({ ...w, raw: ['a', 'b'] }), touches: 0 },
      ]
      const out = walk({ kind, pipeline: 'filter', sort: 'key' }, steps, { t: T0, u: U0, raw: ['b', 'c', 'a'] })
      // (the override changes once; an ordinal scale under an override adds the categories it is asked for, and is made every time)
      // (but the last step, whose inputs are equal to the step before's, which the session answers with the scene it made)
      expect(out.made, kind).toBe(kind === 'color' ? steps.length - 1 : 1)
    }
  })
})

describe('the reuse itself', () => {
  const N = 40
  const rows = Array.from({ length: N }, (_, i) => ({ i, g: ['c', 'a', 'b'][i % 3], v: i % 9 === 4 ? null : i, h: 'x' }))

  for (const pipeline of ['direct', 'filter', 'formula+filter']) {
    for (const sort of ['none', 'key', 'count desc']) {
      it(`${pipeline}, sort ${sort}: a row of a category appended encodes one item; a new category encodes them all`, () => {
        const spec = chart({ kind: 'color', pipeline, sort })
        const s = createChartSession()
        let t = rows
        const prev = s.evaluate(spec, { data: { t, u: U0 } })
        t = [...t, { i: 50, g: 'a', v: 50, h: 'x' }]
        const a = encodedBy(() => s.evaluate(spec, { data: { t, u: U0 } }))
        expect(scaleOf(a.scene, 's')).toBe(scaleOf(prev, 's'))
        expect(a.encoded).toEqual({ pts: 1 })
        expect(keptItems(prev, a.scene, 'pts')).toBe(itemCount(prev, 'pts'))
        expect(keptItems(prev, a.scene, 'others')).toBe(itemCount(prev, 'others'))
        t = [...t, { i: 51, g: 'new', v: 51, h: 'x' }]
        const b = encodedBy(() => s.evaluate(spec, { data: { t, u: U0 } }))
        expect(scaleOf(b.scene, 's')).not.toBe(scaleOf(a.scene, 's'))
        expect(b.encoded).toEqual({ pts: itemCount(b.scene, 'pts'), others: itemCount(b.scene, 'others') })
        // (a row edited and a row removed: the census cannot say, the settings can)
        t = t.map((x, k) => (k === 7 ? { ...x, v: 77 } : x)).filter((_, k) => k !== 11)
        const c = encodedBy(() => s.evaluate(spec, { data: { t, u: U0 } }))
        expect(scaleOf(c.scene, 's')).toBe(scaleOf(b.scene, 's'))
        expect(c.encoded).toEqual({ pts: 1 })
      })
    }
  }

  it('a scale shared by two marks over two datasets, and a domain over both: each mark encodes its own new rows', () => {
    const spec = chart({ kind: 'color', pipeline: 'filter', sort: 'key', domain: 'datalist' })
    const s = createChartSession()
    let w: World = { t: rows, u: U0 }
    let prev = s.evaluate(spec, input(w))
    for (const [what, next, want, keep] of [
      ['a row of t', (x: World) => ({ ...x, t: [...x.t, { i: 60, g: 'b', v: 1, h: 'x' }] }), { pts: 1 }, true],
      ['a row of u', (x: World) => ({ ...x, u: [...x.u, { i: 61, g: 'q', v: 1 }] }), { others: 1 }, true],
      ['a new category in u', (x: World) => ({ ...x, u: [...x.u, { i: 62, g: 'zz', v: 1 }] }), null, false],
      ['a row of t again', (x: World) => ({ ...x, t: [...x.t, { i: 63, g: 'c', v: 1, h: 'x' }] }), { pts: 1 }, true],
    ] as const) {
      w = next(w)
      const { scene, encoded } = encodedBy(() => s.evaluate(spec, input(w)))
      expect(norm(scene), what).toEqual(norm(evaluateChart(compileChart(spec), input(w))))
      expect(scaleOf(scene, 's') === scaleOf(prev, 's'), what).toBe(keep)
      expect(encoded, what).toEqual(want ?? { pts: itemCount(scene, 'pts'), others: itemCount(scene, 'others') })
      prev = scene
    }
  })

  it('a stream append of a category the scale has encodes the new item only, through a validity filter', () => {
    const spec = chart({ kind: 'color', pipeline: 'formula+filter', sort: 'key' })
    const st = createChartStream(spec, { capacity: 8 })
    st.push({ data: { t: rows, u: U0 } })
    let prev = st.flush()!.scene
    let all = rows
    for (const [row, keep] of [[{ i: 70, g: 'b', v: 3, h: 'x' }, true], [{ i: 71, g: 'b', v: null, h: 'x' }, true], [{ i: 72, g: 'new', v: 3, h: 'x' }, false], [{ i: 73, g: 'a', v: 3, h: 'x' }, true]] as const) {
      all = [...all, row]
      const { scene, encoded } = encodedBy(() => { st.push({ append: { t: [row] } }); return st.flush()!.scene })
      expect(norm(scene)).toEqual(norm(evaluateChart(compileChart(spec), { data: { t: all, u: U0 } })))
      expect(scaleOf(scene, 's') === scaleOf(prev, 's'), JSON.stringify(row)).toBe(keep)
      expect(encoded, JSON.stringify(row)).toEqual(keep ? (row.v === null ? {} : { pts: 1 }) : { pts: itemCount(scene, 'pts'), others: itemCount(scene, 'others') })
      prev = scene
    }
  })
})

describe('what the census tells apart', () => {
  // categories told apart by their text: `1` and `'1'` are one, and the first row's value is the category's
  const numeric = (vals: unknown[]): Row[] => vals.map((g, i) => ({ i, g, v: i, h: 'x' }))
  const cases: Array<{ what: string; from: unknown[]; to: (t: Row[]) => Row[] }> = [
    { what: 'a number appended as its text', from: [1, 2, 3, 1], to: (t) => [...t, { i: 9, g: '2', v: 1, h: 'x' }] },
    { what: 'the first row of a category edited to its text', from: [1, 2, 3, 1], to: (t) => at(t, 1, { g: '2' }) },
    { what: 'a later row edited to its text', from: [1, 2, 3, 2], to: (t) => at(t, 3, { g: '2' }) },
    { what: '0 edited to -0 in a first row', from: [0, 2, 3, 0], to: (t) => at(t, 0, { g: -0 }) },
    { what: '-0 appended to 0', from: [0, 2, 3], to: (t) => [...t, { i: 9, g: -0, v: 1, h: 'x' }] },
    { what: 'a Date of the same instant as a first row', from: [new Date(0), new Date(1000)], to: (t) => at(t, 0, { g: new Date(0) }) },
    { what: 'null and undefined', from: [null, 'a', undefined], to: (t) => [...t, { i: 9, g: 'null', v: 1, h: 'x' }] },
    { what: 'NaN appended to NaN', from: [Number.NaN, 'a'], to: (t) => [...t, { i: 9, g: Number.NaN, v: 1, h: 'x' }] },
  ]
  for (const kind of ['color', 'band'] as const) {
    for (const pipeline of ['direct', 'filter']) {
      for (const sort of ['none', 'key']) {
        for (const c of cases) {
          it(`${kind} / ${pipeline} / ${sort}: ${c.what}`, () => {
            const t0 = numeric(c.from)
            walk({ kind, pipeline, sort }, [{ what: c.what, to: (w) => ({ ...w, t: c.to(w.t) }), touches: 1 }], { t: t0, u: U0 }, true)
          })
        }
      }
    }
  }

  it('an ordinal scale that adds the categories it is asked for (`domainImplicit`) is never kept for its settings', () => {
    const spec = {
      width: 100, height: 50, autosize: 'none',
      data: [{ name: 't' }, { name: 'u' }],
      scales: [{ name: 's', type: 'ordinal', domain: { data: 't', field: 'g' }, domainImplicit: true, range: 'category' }],
      legends: [{ fill: 's' }],
      marks: [
        { type: 'symbol', name: 'pts', from: { data: 't' }, encode: { update: { fill: { scale: 's', field: 'g' } } } },
        // (reads categories the domain does not have: each one joins it)
        { type: 'symbol', name: 'others', from: { data: 'u' }, encode: { update: { fill: { scale: 's', field: 'g' } } } },
      ],
    } as unknown as VgSpec
    const s = createChartSession()
    let u: Row[] = [{ g: 'p' }, { g: 'q' }]
    const t: Row[] = [{ g: 'a' }, { g: 'b' }]
    s.evaluate(spec, { data: { t, u } })
    for (const next of [[{ g: 'q' }], [{ g: 'r' }, { g: 'p' }], [{ g: 'p' }]]) {
      u = next
      const input: RuntimeInput = { data: { t: [...t], u } }
      const scene = s.evaluate(spec, input)
      const fresh = evaluateChart(compileChart(spec), input)
      expect(norm(scene)).toEqual(norm(fresh))
      expect(same(scaleView(scaleOf(scene, 's')), scaleView(scaleOf(fresh, 's')))).toBe(true)
    }
  })
})
