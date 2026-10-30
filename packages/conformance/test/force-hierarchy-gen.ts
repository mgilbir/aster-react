/**
 * The force simulation and the hierarchy layouts (pack, partition, treemap, tree) against the real vega (vega-force over
 * d3-force, vega-hierarchy over d3-hierarchy) in the same process: generated graphs and trees, every force and parameter
 * combination, iteration counts, every tiling method, padding, round, size and sort. The datasets must be equal bit for
 * bit (`Object.is` on every number: the sign of a zero and a NaN count), because the layouts are chaotic in their float
 * order: one reordered addition moves a node by a pixel after a few hundred ticks.
 */
import { expect } from 'vitest'
import * as vega from 'vega'
import '@aster/core/transforms'
import { evaluateChart, compileChart, datasetsOfScene } from '@aster/core'

/** mulberry32: a small seeded generator, so a failing case replays from its index. */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
export interface Gen {
  next(): number
  int(lo: number, hi: number): number
  pick<T>(xs: readonly T[]): T
  chance(p: number): boolean
  num(lo: number, hi: number): number
}
export const gen = (seed: number): Gen => {
  const next = rng(seed)
  return {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: (xs) => xs[Math.floor(next() * xs.length)]!,
    chance: (p) => next() < p,
    num: (lo, hi) => Math.round((lo + next() * (hi - lo)) * 1000) / 1000,
  }
}

/** The first difference between two values, comparing numbers with Object.is and objects by their sorted keys. */
export function firstDiff(a: unknown, b: unknown, path = '$', seen = new Set<unknown>()): string | null {
  if (typeof a === 'number' || typeof b === 'number') return Object.is(a, b) ? null : `${path}: ${String(a)} vs ${String(b)}`
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return a === b ? null : `${path}: ${String(a)} vs ${String(b)}`
  if (seen.has(a)) return null
  seen.add(a)
  if (Array.isArray(a) !== Array.isArray(b)) return `${path}: array vs object`
  if (Array.isArray(a) && Array.isArray(b)) {
    // (vega hangs the backing tree on a stratified dataset's array as `root`: only the rows are compared)
    if (a.length !== b.length) return `${path}: length ${a.length} vs ${b.length}`
    for (let i = 0; i < a.length; ++i) { const d = firstDiff(a[i], b[i], `${path}[${i}]`, seen); if (d) return d }
    return null
  }
  const ka = Object.keys(a).sort()
  const kb = Object.keys(b).sort()
  if (ka.join('\u0000') !== kb.join('\u0000')) return `${path}: keys ${ka.join(',')} vs ${kb.join(',')}`
  for (const k of ka) {
    const d = firstDiff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`, seen)
    if (d) return d
  }
  return null
}

export async function vegaDatasets(spec: any): Promise<{ data: Record<string, unknown>; errors: string[] }> {
  const errors: string[] = []
  const logger = { level: () => 3, error: (...a: unknown[]) => { errors.push(a.map((x) => (x instanceof Error ? x.message : String(x))).join(' ')); return logger }, warn: () => logger, info: () => logger, debug: () => logger }
  const data: Record<string, unknown> = {}
  try {
    const view = new vega.View(vega.parse(JSON.parse(JSON.stringify(spec))), { renderer: 'none', logger: logger as never })
    try {
      await view.runAsync()
      for (const d of spec.data) data[d.name] = view.data(d.name)
    } finally { view.finalize() }
  } catch (e) { errors.push(e instanceof Error ? e.message : String(e)) }
  return { data, errors }
}
export function asterDatasets(spec: any): { data: Record<string, unknown>; errors: string[] } {
  const errors: string[] = []
  const logger = { error: (...a: unknown[]) => { errors.push(a.map((x) => (x instanceof Error ? x.message : String(x))).join(' ')) }, warn: () => {}, info: () => {}, debug: () => {} }
  const data: Record<string, unknown> = {}
  try {
    const scene = evaluateChart(compileChart(JSON.parse(JSON.stringify(spec))), { logger } as never)
    for (const d of spec.data) data[d.name] = datasetsOfScene(scene).get(d.name)
  } catch (e) { errors.push(e instanceof Error ? e.message : String(e)) }
  return { data, errors }
}

export async function agree(spec: any, label: string): Promise<void> {
  const v = await vegaDatasets(spec)
  const a = asterDatasets(spec)
  expect(a.errors, label).toEqual(v.errors)
  const d = firstDiff(a.data, v.data)
  if (d) throw new Error(`${label}: ${d.slice(0, 300)}\n${JSON.stringify(spec).slice(0, 1500)}`)
}

export const SCHEMA = 'https://vega.github.io/schema/vega/v6.json'

// -- force ---------------------------------------------------------------------------------------------------------

export function forceCase(seed: number): any {
  const g = gen(seed)
  const n = g.pick([0, 1, 2, 3, 5, 9, 17, 30, 45])
  const mode = g.pick(['plain', 'placed', 'coincident', 'fixed', 'mixed'])
  const nodes = Array.from({ length: n }, (_, i) => {
    const row: Record<string, unknown> = { id: g.int(1000, 9999) * 100 + i, w: g.int(1, 9), k: g.pick(['a', 'b', 'c']), tx: g.num(0, 200) }
    if (mode === 'placed' || mode === 'mixed' && g.chance(0.5)) { row.x = g.num(0, 200); row.y = g.num(0, 200) }
    if (mode === 'coincident') { row.x = g.pick([10, 20]); row.y = g.pick([10, 20]) }
    if (mode === 'fixed' || mode === 'mixed' && g.chance(0.2)) { if (g.chance(0.6)) row.fx = g.num(0, 200); if (g.chance(0.6)) row.fy = g.num(0, 200) }
    return row
  })
  const useId = g.chance(0.5)
  const links = n < 1 ? [] : Array.from({ length: g.pick([0, 1, n, 2 * n, 3 * n]) }, () => {
    const s = g.int(0, n - 1)
    const t = g.chance(0.05) ? s : g.int(0, n - 1)
    return useId ? { source: nodes[s]!.id, target: nodes[t]!.id } : { source: s, target: t }
  })
  const forceNames = ['center', 'collide', 'nbody', 'link', 'x', 'y']
  const count = g.int(0, 5)
  const forces = Array.from({ length: count }, () => {
    const name = g.pick(forceNames)
    const f: Record<string, unknown> = { force: name }
    const maybe = (key: string, v: () => unknown, p = 0.5): void => { if (g.chance(p)) f[key] = v() }
    switch (name) {
      case 'center': maybe('x', () => g.num(-50, 250)); maybe('y', () => g.num(-50, 250)); maybe('strength', () => g.pick([0, 0.3, 1, 2])) /* (not a parameter of vega's center: it is ignored) */; break
      case 'collide':
        maybe('radius', () => g.pick([{ expr: 'datum.w * 2' }, { expr: 'sqrt(datum.w) * 3 + 0.5' }, 4, 0, { expr: 'datum.index % 3 + 1' }]), 0.8)
        maybe('strength', () => g.pick([0.25, 0.7, 1, 1.5])); maybe('iterations', () => g.int(1, 4)); break
      case 'nbody':
        maybe('strength', () => g.pick([-80, -30, -5, 0, 20, { expr: 'datum.w * -4' }]))
        maybe('theta', () => g.pick([0, 0.5, 0.9, 1.5])); maybe('distanceMin', () => g.pick([0, 1, 5, 20]))
        maybe('distanceMax', () => g.pick([10, 50, 400, 1e9])); break
      case 'link':
        f.links = 'links'
        if (useId) f.id = 'id'
        maybe('distance', () => g.pick([5, 30, 80, { expr: 'datum.index * 2 + 10' }])); maybe('strength', () => g.pick([0, 0.3, 0.8, 1]))
        maybe('iterations', () => g.int(1, 3)); break
      case 'x': case 'y':
        maybe(name, () => g.pick(['tx', 'w', { field: 'tx' }]), 0.8); maybe('strength', () => g.pick([0, 0.05, 0.1, 0.5, 1])); break
    }
    return f
  })
  const t: Record<string, unknown> = { type: 'force', forces }
  if (g.chance(0.7)) t.static = true
  if (g.chance(0.6)) t.iterations = g.pick([1, 2, 7, 30, 120, 300, 500])
  if (g.chance(0.3)) t.alpha = g.pick([0.2, 0.5, 1, 2])
  if (g.chance(0.3)) t.alphaMin = g.pick([0.001, 0.01, 0.1])
  if (g.chance(0.3)) t.alphaTarget = g.pick([0, 0.1, 0.3])
  if (g.chance(0.3)) t.velocityDecay = g.pick([0.1, 0.4, 0.6, 0.9])
  if (g.chance(0.2)) t.velocityDecay = { signal: '1 - 0.4' }
  if (g.chance(0.15)) t.alphaMin = { signal: '0.0005 * 2' }
  return { $schema: SCHEMA, width: 200, height: 200, data: [{ name: 'nodes', values: nodes }, { name: 'links', values: links }, { name: 'out', source: 'nodes', transform: [t] }] }
}

// -- hierarchy -----------------------------------------------------------------------------------------------------

export function treeRowsOf(g: Gen): Array<Record<string, unknown>> {
  const n = g.pick([1, 1, 2, 3, 4, 7, 12, 25, 60, 120])
  const shape = g.pick(['random', 'chain', 'bushy', 'star', 'binary'])
  const parent = (i: number): number => {
    switch (shape) {
      case 'chain': return i - 1
      case 'star': return 0
      case 'binary': return (i - 1) >> 1
      case 'bushy': return Math.floor(g.next() * Math.min(i, 4))
      default: return g.int(0, i - 1)
    }
  }
  const rows = Array.from({ length: n }, (_, i) => ({
    id: 'n' + i, parent: i === 0 ? null : 'n' + parent(i),
    v: g.pick([0, 1, 1, 2, 3, 5, 8, g.num(0, 20), g.num(0.001, 3)]),
    r: g.pick([0, 1, 4, g.num(0, 9)]),
    s: g.pick(['p', 'q', 'r']),
  }))
  // children before parents in the rows, sometimes
  if (g.chance(0.4)) for (let i = rows.length - 1; i > 1; --i) { const j = g.int(1, i); [rows[i], rows[j]] = [rows[j]!, rows[i]!] }
  return rows
}
const SIZES = [[1, 1], [100, 100], [400, 250], [37.5, 91.25], [1000, 3]]
export function layoutSpec(g: Gen, kind: string): Record<string, unknown> {
  const t: Record<string, unknown> = { type: kind }
  const maybe = (key: string, v: () => unknown, p = 0.5): void => { if (g.chance(p)) t[key] = v() }
  maybe('field', () => 'v', 0.8)
  maybe('sort', () => ({ field: g.pick(['value', 'height', 'depth', 'data.v', 'data.s']), order: g.pick(['ascending', 'descending']) }), 0.5)
  maybe('size', () => g.pick(SIZES), 0.8)
  switch (kind) {
    case 'pack': maybe('radius', () => g.pick(['data.r', 'data.v']), 0.4); maybe('padding', () => g.pick([0, 1, 3, 10.5]), 0.6); break
    case 'partition': maybe('round', () => g.chance(0.5), 0.6); maybe('padding', () => g.pick([0, 1, 4, 30]), 0.6); break
    case 'treemap':
      maybe('method', () => g.pick(['squarify', 'resquarify', 'binary', 'slice', 'dice', 'slicedice']), 0.9)
      maybe('ratio', () => g.pick([1, 1.5, 2, 0.5, 3.7]), 0.4); maybe('round', () => g.chance(0.5), 0.6)
      for (const p of ['padding', 'paddingInner', 'paddingOuter', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft']) maybe(p, () => g.pick([0, 1, 2.5, 8, 60]), 0.25)
      break
    case 'tree':
      maybe('method', () => g.pick(['tidy', 'cluster']), 0.8); maybe('separation', () => g.chance(0.5), 0.5)
      if (g.chance(0.3)) { if (g.chance(0.7)) delete t.size; t.nodeSize = g.pick([[10, 20], [1, 1], [7.5, 33]]) }
      break
  }
  return t
}
export function hierarchySpec(seed: number): any {
  const g = gen(seed)
  const kind = g.pick(['pack', 'partition', 'treemap', 'tree'])
  const rows = treeRowsOf(g)
  const t = layoutSpec(g, kind)
  if (g.chance(0.2)) t.as = ['a', 'b', 'c', 'd', 'e', 'f'].slice(0, kind === 'pack' ? 5 : kind === 'tree' ? 4 : 6)
  return { $schema: SCHEMA, width: 100, height: 100, data: [{ name: 'src', values: rows }, { name: 'out', source: 'src', transform: [{ type: 'stratify', key: 'id', parentKey: 'parent' }, t] }] }
}

