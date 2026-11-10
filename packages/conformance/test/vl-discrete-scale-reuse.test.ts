// @vitest-environment node
/**
 * Vega-Lite charts whose discrete scales come from data, end to end, through the chart session as `<Chart>` drives it (a new array per
 * update) and through a stream's appends as `<ChartStream>` delivers them (see packages/core/src/discrete-scale-reuse.test.ts for the
 * engine's side).
 *
 * Every step is the scene a fresh evaluation of the same inputs makes, with every observable of every discrete scale. A discrete scale
 * is the object of the step before exactly when a fresh evaluation's scale is the same as at the step before; while every scale a mark
 * reads is kept, the mark keeps every item the step did not touch.
 */
import { describe, it, expect } from 'vitest'
import { compile } from '@aster-charts/vl'
import { compileChart, createChartStream, evaluateChart, renderSceneToSvg, type RuntimeInput, type SceneRoot } from '@aster-charts/core'
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

type ScaleFn = ((x: unknown) => unknown) & Record<string, (...a: unknown[]) => unknown> & { type: string }
const scaleMap = (scene: SceneRoot): Map<string, ScaleFn> => (scene as unknown as { __scaleMap: Map<string, ScaleFn> }).__scaleMap
const DISCRETE = new Set(['ordinal', 'band', 'point'])
const discreteScales = (scene: SceneRoot): string[] => [...scaleMap(scene)].filter(([, s]) => DISCRETE.has(s.type)).map(([n]) => n).sort()

/** Everything a reader sees of a scale. */
function scaleView(s: ScaleFn | undefined): unknown {
  if (!s) return undefined
  const read = (m: string): unknown => (typeof s[m] === 'function' ? s[m]!() : undefined)
  const domain = s.domain!() as unknown[]
  return {
    type: s.type, domain, range: read('range'), mapped: domain.map((d) => s(d)), bandwidth: read('bandwidth'), step: read('step'),
    paddingInner: read('paddingInner'), paddingOuter: read('paddingOuter'), align: read('align'), round: read('round'),
  }
}
function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (a instanceof Date || b instanceof Date) return false
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => same(x, b[i]))
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const ka = Object.keys(a)
    return ka.length === Object.keys(b).length && ka.every((k) => same((a as Row)[k], (b as Row)[k]))
  }
  return false
}

interface Group { name?: string; role?: string; marktype?: string; items?: unknown[] }
function leafMarks(scene: SceneRoot): Group[] {
  const out: Group[] = []
  const walk = (items: readonly unknown[]): void => {
    for (const it of items) {
      const g = it as Group
      if (g.role === 'mark' && g.marktype !== 'group' && g.name?.startsWith('marks')) out.push(g)
      if (Array.isArray(g.items)) walk(g.items)
    }
  }
  walk(scene.items)
  return out
}
const itemsOf = (scene: SceneRoot): unknown[] => leafMarks(scene).flatMap((g) => g.items ?? [])

/** One check of a step: the fresh scene, and the discrete scales kept exactly when their fresh result is the same. */
function check(spec: Spec, prev: SceneRoot, scene: SceneRoot, prevFresh: SceneRoot, input: RuntimeInput, what: string): { fresh: SceneRoot; allKept: boolean } {
  const fresh = evaluateChart(compileChart(spec as never), input)
  expect(norm(scene), what).toEqual(norm(fresh))
  expect(renderSceneToSvg(scene), what).toBe(renderSceneToSvg(fresh))
  let allKept = true
  for (const name of discreteScales(fresh)) {
    expect(same(scaleView(scaleMap(scene).get(name)), scaleView(scaleMap(fresh).get(name))), `${what}: scale ${name}`).toBe(true)
    const unchanged = same(scaleView(scaleMap(fresh).get(name)), scaleView(scaleMap(prevFresh).get(name)))
    const kept = scaleMap(scene).get(name) === scaleMap(prev).get(name)
    expect(kept, `${what}: scale ${name} kept`).toBe(unchanged)
  }
  // (every scale, discrete or not, kept: what reads only them keeps the items the step did not touch)
  for (const [name, s] of scaleMap(scene)) if (scaleMap(prev).get(name) !== s) allKept = false
  return { fresh, allKept }
}

const CATS = ['k2', 'k0', 'k3', 'k1']
const row = (i: number, c = CATS[i % 4]!): Row => ({ t: i, x: (i * 13) % 97, y: ((i * 37) % 41) + 1, c, s: i % 3 === 0 ? 'p' : 'q' })
const ROWS: Row[] = Array.from({ length: 60 }, (_, i) => row(i))

interface Change { what: string; to: (rows: Row[], k: number) => Row[]; touches: number }
const CHANGES: Change[] = [
  { what: 'a row of a category appended', to: (r, k) => [...r, row(100 + k, 'k0')], touches: 1 },
  { what: 'a row with a missing x appended', to: (r, k) => [...r, { ...row(100 + k, 'k1'), x: null }], touches: 1 },
  { what: 'a value edited', to: (r) => r.map((x, i) => (i === 9 ? { ...x, y: (x.y as number) + 0.5 } : x)), touches: 1 },
  { what: 'a category edited to another', to: (r) => r.map((x, i) => (i === 21 ? { ...x, c: 'k2' } : x)), touches: 1 },
  { what: 'a row removed', to: (r) => r.filter((_, i) => i !== 13), touches: 0 },
  { what: 'a new category appended', to: (r, k) => [...r, row(100 + k, 'k9')], touches: 1 },
  { what: 'the new category removed', to: (r) => r.filter((x) => x.c !== 'k9'), touches: 0 },
  { what: 'the new category added again', to: (r, k) => [...r, row(100 + k, 'k9')], touches: 1 },
  { what: 'rows of one category appended', to: (r, k) => [...r, ...Array.from({ length: 12 }, (_, j) => row(200 + k * 20 + j, 'k3'))], touches: 12 },
  { what: 'two rows swapped', to: (r) => { const n = r.slice(); [n[0], n[1]] = [n[1]!, n[0]!]; return n }, touches: 2 },
  { what: 'a row inserted', to: (r, k) => [...r.slice(0, 7), row(300 + k, 'k1'), ...r.slice(7)], touches: 1 },
]

const CHARTS: Record<string, { spec: Spec; rowWise: boolean }> = {
  'scatter by category': { spec: compile({ width: 300, height: 150, data: { name: 'src' }, mark: 'point', encoding: { x: { field: 'x', type: 'quantitative', scale: { domain: [0, 100] } }, y: { field: 'y', type: 'quantitative', scale: { domain: [0, 50] } }, color: { field: 'c', type: 'nominal' } } } as never), rowWise: true },
  'scatter, colour sorted descending': { spec: compile({ width: 300, height: 150, data: { name: 'src' }, mark: 'point', encoding: { x: { field: 'x', type: 'quantitative', scale: { domain: [0, 100] } }, y: { field: 'y', type: 'quantitative', scale: { domain: [0, 50] } }, color: { field: 'c', type: 'nominal', sort: 'descending' } } } as never), rowWise: true },
  'scatter, colour in a custom order': { spec: compile({ width: 300, height: 150, data: { name: 'src' }, mark: 'point', encoding: { x: { field: 'x', type: 'quantitative', scale: { domain: [0, 100] } }, y: { field: 'y', type: 'quantitative', scale: { domain: [0, 50] } }, color: { field: 'c', type: 'nominal', sort: ['k3', 'k1', 'k9'] } } } as never), rowWise: true },
  'scatter, colour by count': { spec: compile({ width: 300, height: 150, data: { name: 'src' }, mark: 'point', encoding: { x: { field: 'x', type: 'quantitative', scale: { domain: [0, 100] } }, y: { field: 'y', type: 'quantitative', scale: { domain: [0, 50] } }, color: { field: 'c', type: 'nominal', sort: { op: 'count', order: 'descending' } } } } as never), rowWise: true },
  'shape, size and dash by category': { spec: compile({ width: 300, height: 150, data: { name: 'src' }, mark: 'point', encoding: { x: { field: 'x', type: 'quantitative', scale: { domain: [0, 100] } }, y: { field: 'y', type: 'quantitative', scale: { domain: [0, 50] } }, shape: { field: 'c', type: 'nominal' }, size: { field: 's', type: 'ordinal' }, strokeDash: { field: 'c', type: 'nominal' } } } as never), rowWise: true },
  'bar, nominal x': { spec: compile({ width: 300, height: 150, data: { name: 'src' }, mark: 'bar', encoding: { x: { field: 'c', type: 'nominal' }, y: { field: 'y', type: 'quantitative', stack: null, scale: { domain: [0, 50] } } } } as never), rowWise: true },
  'bar, nominal x sorted by y': { spec: compile({ width: 300, height: 150, data: { name: 'src' }, mark: 'bar', encoding: { x: { field: 'c', type: 'nominal', sort: '-y' }, y: { field: 'y', type: 'quantitative', aggregate: 'sum' } } } as never), rowWise: false },
  'bar, nominal x by an aggregate of another field': { spec: compile({ width: 300, height: 150, data: { name: 'src' }, mark: 'bar', encoding: { x: { field: 'c', type: 'nominal', sort: { field: 'x', op: 'max', order: 'descending' } }, y: { field: 'y', type: 'quantitative', stack: null, scale: { domain: [0, 50] } } } } as never), rowWise: true },
  'stacked bar': { spec: compile({ width: 300, height: 150, data: { name: 'src' }, transform: [{ calculate: 'datum.t % 5', as: 'b' }], mark: 'bar', encoding: { x: { field: 'b', type: 'ordinal' }, y: { field: 'y', type: 'quantitative', aggregate: 'sum' }, color: { field: 'c', type: 'nominal' } } } as never), rowWise: false },
  'line per category': { spec: compile({ width: 300, height: 150, data: { name: 'src' }, mark: 'line', encoding: { x: { field: 't', type: 'quantitative' }, y: { field: 'y', type: 'quantitative' }, color: { field: 'c', type: 'nominal' } } } as never), rowWise: false },
  'layered: points and a rule share the colour': { spec: compile({ width: 300, height: 150, data: { name: 'src' }, encoding: { color: { field: 'c', type: 'nominal' } }, layer: [
    { mark: 'point', encoding: { x: { field: 'x', type: 'quantitative', scale: { domain: [0, 100] } }, y: { field: 'y', type: 'quantitative', scale: { domain: [0, 50] } } } },
    { transform: [{ filter: 'datum.y > 20' }], mark: 'rule', encoding: { y: { field: 'y', type: 'quantitative' } } },
  ] } as never), rowWise: false },
}

describe('Vega-Lite charts keep their discrete scales exactly when the scales are unchanged', () => {
  for (const [name, { spec, rowWise }] of Object.entries(CHARTS)) {
    it(name, () => {
      const session = createChartSession()
      let rows = ROWS
      let prev = session.evaluate(spec as never, { data: { src: rows } })
      let prevFresh = evaluateChart(compileChart(spec as never), { data: { src: rows } })
      let keptSteps = 0
      for (const [k, change] of CHANGES.entries()) {
        rows = change.to(rows, k)
        const input: RuntimeInput = { data: { src: rows } }
        const scene = session.evaluate(spec as never, input)
        const what = `${name}: ${change.what}`
        const { fresh, allKept } = check(spec, prev, scene, prevFresh, input, what)
        if (allKept) {
          keptSteps++
          if (rowWise) {
            const was = new Set(itemsOf(prev))
            const items = itemsOf(scene)
            expect(items.filter((it) => was.has(it)).length, `${what}: items kept`).toBeGreaterThanOrEqual(items.length - change.touches)
          }
        }
        prev = scene
        prevFresh = fresh
      }
      // (some step keeps every scale: the walk does not only rebuild)
      expect(keptSteps, name).toBeGreaterThan(0)
    })
  }
})

describe('<ChartStream> appends', () => {
  it('a colour-by-category scatter: an append of a category the scale has encodes the new point only; a new category, every point', () => {
    const { spec } = CHARTS['scatter by category']!
    const stream = createChartStream(spec as never, { capacity: 16 })
    stream.push({ data: { src: ROWS } })
    let prev = stream.flush()!.scene
    let prevFresh = evaluateChart(compileChart(spec as never), { data: { src: ROWS } })
    let all = ROWS
    for (const [k, c] of ['k0', 'k3', 'k9', 'k9', 'k2'].entries()) {
      const added = [row(400 + k, c)]
      all = [...all, ...added]
      stream.push({ append: { src: added } })
      const scene = stream.flush()!.scene
      const input: RuntimeInput = { data: { src: all } }
      const what = `append ${c} (${k})`
      const { fresh } = check(spec, prev, scene, prevFresh, input, what)
      const fresh0 = k === 2
      expect(scaleMap(scene).get('color') === scaleMap(prev).get('color'), what).toBe(!fresh0)
      const was = new Set(itemsOf(prev))
      expect(itemsOf(scene).filter((it) => was.has(it)).length, what).toBe(fresh0 ? 0 : itemsOf(prev).length)
      prev = scene
      prevFresh = fresh
    }
  })
})
