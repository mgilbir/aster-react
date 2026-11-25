/**
 * A mark `key` joins rows into items, against real vega (C120).
 *
 * vega's DataJoin keys a mark's items by the key field: rows that share a key are ONE item, in the place of the first of them,
 * holding the last of them (its `datum`, so its encode reads the last row). The keys are the properties of a plain object, so 1 and
 * "1", null and "null", and any two objects are one key. Generated over every mark type (group marks too, from a dataset and from
 * a facet), keys that collide in each of those ways, nested key paths, and marks nested in a group; compared with vega's SVG and
 * with the data of its items, in order.
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { compileChart, evaluateChart, renderSpec, type SceneGroup } from '@aster-charts/core'
import { canonicalizeSvg, diffCanonical } from './normalize.js'
import { forEngines } from './engines.js'

type Spec = Record<string, unknown>

function stream(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const TYPES = ['symbol', 'rect', 'rule', 'arc', 'text', 'path', 'image', 'line', 'area', 'trail', 'group'] as const
const KEYS: unknown[] = ['a', 'b', 'a', 1, '1', null, 'null', { o: 1 }, { o: 2 }, 'c', undefined, 'undefined', true, 'true']
const IMG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function enter(type: string): Spec {
  const at = { x: { field: 'x' }, y: { field: 'y' } }
  switch (type) {
    case 'rect': return { ...at, width: { value: 6 }, height: { value: 6 }, fill: { value: '#4c78a8' } }
    case 'rule': return { ...at, x2: { signal: 'datum.x + 5' }, stroke: { value: '#000' } }
    case 'arc': return { ...at, outerRadius: { value: 5 }, startAngle: { value: 0 }, endAngle: { value: 2 }, fill: { value: '#c33' } }
    case 'text': return { ...at, text: { signal: "'t' + datum.i" } }
    case 'path': return { ...at, path: { value: 'M0,0L4,4' }, stroke: { value: '#000' } }
    case 'line': return { ...at, stroke: { value: '#c33' } }
    case 'area': return { ...at, y2: { value: 90 }, fill: { value: '#ccc' } }
    case 'trail': return { ...at, size: { value: 3 }, fill: { value: '#999' } }
    case 'image': return { ...at, url: { value: IMG }, width: { value: 4 }, height: { value: 4 } }
    case 'group': return { ...at, width: { value: 8 }, height: { value: 8 }, fill: { value: '#eee' }, stroke: { value: '#333' } }
    default: return { ...at, size: { value: 40 }, fill: { value: '#4c78a8' } }
  }
}

function keyCase(seed: number): { id: string; spec: Spec } {
  const r = stream(seed * 65537 + 5)
  const type = TYPES[seed % TYPES.length]!
  const shape = Math.floor(seed / TYPES.length) % 4 // 0 flat key, 1 nested key path, 2 inside a group, 3 a facet's group mark
  const n = 4 + Math.floor(r() * 7)
  const rows = Array.from({ length: n }, (_, i) => {
    const k = KEYS[Math.floor(r() * KEYS.length)]
    return { i, x: 5 + Math.round(r() * 180), y: 5 + Math.round(r() * 80), k, n: { k }, g: i % 2 }
  })
  const key = shape === 1 ? 'n.k' : 'k'
  const base = (data: string): Spec => {
    const m: Spec = { type, name: 'm', key, from: { data }, encode: { enter: enter(type) } }
    if (type === 'group') m.marks = [{ type: 'text', encode: { enter: { x: { value: 1 }, y: { value: 7 }, text: { field: { parent: 'i' } } } } }]
    return m
  }
  let marks: Spec[]
  if (shape === 2) marks = [{ type: 'group', encode: { enter: { x: { value: 3 }, y: { value: 3 } } }, marks: [base('t')] }]
  else if (shape === 3) marks = [{ type: 'group', from: { facet: { data: 't', name: 'f', groupby: 'g' } }, encode: { enter: { x: { signal: 'datum.g * 4' } } }, marks: [base('f')] }]
  else marks = [base('t')]
  return { id: `${type} shape ${shape} seed ${seed}`, spec: { width: 200, height: 100, padding: 5, autosize: 'none', data: [{ name: 't', values: rows }], marks } }
}

/** The `i` of the datum of every item of every mark named `m`, in scene order. */
function itemRows(node: unknown, out: number[][] = []): number[][] {
  const n = node as { name?: string; marktype?: string; items?: unknown[] }
  if (n.name === 'm' && n.marktype !== undefined && Array.isArray(n.items) && (n as { role?: string }).role !== undefined) out.push(n.items.map((it) => (it as { datum: { i: number } }).datum.i))
  for (const c of n.items ?? []) if (c && typeof c === 'object') itemRows(c, out)
  return out
}

/** Aster's scene holds a group mark's items as consecutive group items of one `markIndex`: the same lists, gathered. */
function asterItemRows(node: unknown, out: number[][] = []): number[][] {
  const items = ((node as { items?: unknown[] }).items ?? []) as SceneGroup[]
  for (let i = 0; i < items.length; i++) {
    const g = items[i]!
    if (g.name === 'm' && g.marktype === 'group' && g.markIndex !== undefined) {
      const run: number[] = []
      while (i < items.length && items[i]!.markIndex === g.markIndex) { run.push((items[i]!.datum as { i: number }).i); asterItemRows(items[i], out); i++ }
      i--
      out.push(run)
      continue
    }
    if (g.name === 'm' && g.marktype !== undefined && g.marktype !== 'group') { out.push((g.items ?? []).map((it) => (it.datum as { i: number }).i)); continue }
    if (Array.isArray(g.items)) asterItemRows(g, out)
  }
  return out
}

async function vegaRun(spec: Spec): Promise<{ svg: string; rows: number[][] }> {
  const view = new vega.View(vega.parse(spec as never), { renderer: 'none' })
  try {
    await view.runAsync()
    return { svg: await view.toSVG(), rows: itemRows((view.scenegraph() as unknown as { root: unknown }).root) }
  } finally {
    view.finalize()
  }
}

const sorted = (xs: number[][]): string => JSON.stringify(xs.map((x) => JSON.stringify(x)).sort())

describe('a mark key joins rows into items (vega)', () => {
  it('every mark type, colliding keys, nested paths, nested and faceted marks: the same items and SVG as vega', async () => {
    const CASES = TYPES.length * 4 * 3
    const bad: string[] = []
    let joined = 0
    for (let seed = 0; seed < CASES; seed++) {
      const c = keyCase(seed)
      const [want, svg, scene] = await forEngines(c.spec, async (o, a) => [await vegaRun(o), renderSpec(structuredClone(a) as never), evaluateChart(compileChart(a as never))] as const)
      const got = asterItemRows(scene)
      if (sorted(want.rows) !== sorted(got)) bad.push(`${c.id}: items vega ${JSON.stringify(want.rows)} aster ${JSON.stringify(got)}`)
      const d = diffCanonical(canonicalizeSvg(want.svg), canonicalizeSvg(svg))
      if (d.length) bad.push(`${c.id}: ${d[0]}`)
      // (not vacuous: most cases join rows)
      const rows = (c.spec.data as Array<{ values: unknown[] }>)[0]!.values.length
      if (want.rows.reduce((n, r) => n + r.length, 0) < rows) joined++
    }
    expect(bad).toEqual([])
    expect(joined).toBeGreaterThan(CASES * 0.6)
  }, 120_000)
})
