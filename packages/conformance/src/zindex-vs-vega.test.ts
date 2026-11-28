/**
 * Paint order by `zindex`, against real vega (C28, C118, C309).
 *
 * vega's scenegraph keeps a mark's items in data order and its renderers paint them by zindex (vega-scenegraph util/visit.js: the
 * items whose zindex is falsy first, in order, then the others ascending, ties in order); a mark's own `zindex` orders the marks of
 * its scope the same way, at every depth. Generated: every mark type whose items are drawn one by one (and the one-path marks, which
 * zindex must leave alone), group items, an item zindex from a field (negative, zero, positive, a string, NaN, null), a signal and a
 * constant, in `enter` or `update`, at the top level, inside a group and inside a facet cell, with mark zindexes among siblings. The
 * items overlap, so the canonical SVG (which compares the order of overlapping records) sees any other order.
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { renderSpec } from '@aster-charts/core'
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

const TYPES = ['symbol', 'rect', 'rule', 'arc', 'text', 'path', 'image', 'group', 'line', 'area', 'trail'] as const
const COLORS = ['#d62728', '#1f77b4', '#2ca02c', '#9467bd', '#8c564b', '#e377c2']
// (vega compares zindexes as numbers after `if (item.zindex)`: a string is coerced, NaN and null are falsy)
const Z_VALUES: unknown[] = [2, -1, 0, 1, 3, '2', Number.NaN, null, 1]
const IMG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/** One item's channels for a mark of `type` drawn over (x, y), all items overlapping. */
function channels(type: string): Spec {
  const at = { x: { field: 'x' }, y: { field: 'y' } }
  const fill = { scale: 'c', field: 'k' }
  switch (type) {
    case 'rect': return { ...at, width: { value: 40 }, height: { value: 30 }, fill }
    case 'rule': return { ...at, x2: { signal: 'datum.x + 40' }, y2: { signal: 'datum.y + 20' }, stroke: fill, strokeWidth: { value: 8 } }
    case 'arc': return { ...at, outerRadius: { value: 30 }, startAngle: { value: 0 }, endAngle: { value: 5 }, fill }
    case 'text': return { ...at, text: { value: 'MMMM' }, fontSize: { value: 30 }, fill }
    case 'path': return { ...at, path: { value: 'M0,0L40,0L40,30L0,30Z' }, fill }
    case 'image': return { ...at, url: { value: IMG }, width: { value: 30 }, height: { value: 30 }, aspect: { value: false } }
    case 'group': return { ...at, width: { value: 40 }, height: { value: 30 }, fill, stroke: { value: '#000' } }
    case 'line': return { ...at, stroke: fill, strokeWidth: { value: 6 } }
    case 'area': return { ...at, y2: { value: 90 }, fill }
    case 'trail': return { ...at, size: { value: 8 }, fill }
    default: return { ...at, size: { value: 1600 }, fill, stroke: { value: '#000' } }
  }
}

function zindexEntry(r: () => number): Spec {
  const u = r()
  if (u < 0.55) return { field: 'z' }
  if (u < 0.85) return { signal: '-datum.z' }
  return { value: 1 }
}

/** A mark of `type` over the dataset `data`, its items zindexed (or not), with a mark zindex (or not). */
function mark(type: string, data: string, r: () => number, name: string): Spec {
  const set = channels(type)
  const zSet = r() < 0.8 ? { zindex: zindexEntry(r) } : {}
  const inEnter = r() < 0.3
  const encode = inEnter ? { enter: { ...set, ...zSet } } : { enter: set, update: zSet }
  const m: Spec = { type, name, from: { data }, encode }
  if (type === 'group') m.marks = [{ type: 'text', encode: { update: { x: { value: 2 }, y: { value: 12 }, text: { field: { parent: 'k' } }, fill: { value: '#fff' } } } }]
  if (r() < 0.4) m.zindex = Math.floor(r() * 3)
  return m
}

function zCase(seed: number): { id: string; spec: Spec } {
  const r = stream(seed * 104729 + 11)
  const type = TYPES[seed % TYPES.length]!
  const depth = Math.floor(seed / TYPES.length) % 3
  const n = 3 + Math.floor(r() * 4)
  const rows = Array.from({ length: n }, (_, i) => ({
    k: String.fromCharCode(97 + i),
    // (all on top of each other, a little apart, so every pair overlaps)
    x: 30 + i * 6 + Math.round(r() * 4),
    y: 30 + i * 4 + Math.round(r() * 4),
    z: Z_VALUES[Math.floor(r() * Z_VALUES.length)],
    g: i % 2,
  }))
  const siblings = (data: string): Spec[] => {
    const out: Spec[] = [mark(type, data, r, 'm0')]
    // a sibling of another type over the same spot, so a mark zindex has marks to order
    out.push(mark(TYPES[(seed * 7 + 3) % 8]!, data, r, 'm1'))
    if (r() < 0.5) out.push(mark('symbol', data, r, 'm2'))
    return out
  }
  const scales = [{ name: 'c', type: 'ordinal', domain: { data: 't', field: 'k' }, range: COLORS }]
  let marks: Spec[]
  if (depth === 0) marks = siblings('t')
  else if (depth === 1) {
    marks = [{ type: 'group', encode: { update: { x: { value: 5 }, y: { value: 5 }, width: { value: 150 }, height: { value: 120 } } }, marks: siblings('t') }]
  } else {
    marks = [{
      type: 'group', name: 'cell', from: { facet: { data: 't', name: 'f', groupby: 'g' } },
      encode: { update: { x: { signal: 'datum.g * 10' }, y: { signal: 'datum.g * 8' }, width: { value: 150 }, height: { value: 120 } } },
      marks: siblings('f'),
    }]
  }
  const spec: Spec = { width: 200, height: 160, padding: 5, autosize: 'none', data: [{ name: 't', values: rows }], scales, marks }
  return { id: `${type} depth ${depth} seed ${seed}`, spec }
}

async function vegaSvg(spec: Spec): Promise<string> {
  const view = new vega.View(vega.parse(spec as never), { renderer: 'none' })
  try {
    await view.runAsync()
    return await view.toSVG()
  } finally {
    view.finalize()
  }
}

describe('paint order by zindex (vega)', () => {
  it('item and mark zindexes, every mark type, every depth: the same SVG as vega, in the same order', async () => {
    const CASES = TYPES.length * 3 * 4
    const bad: string[] = []
    let reordered = 0
    for (let seed = 0; seed < CASES; seed++) {
      const c = zCase(seed)
      const [oracle, ours] = await forEngines(c.spec, (o, a) => Promise.all([vegaSvg(o), Promise.resolve(renderSpec(a as never))]))
      const d = diffCanonical(canonicalizeSvg(oracle), canonicalizeSvg(ours))
      if (d.length) bad.push(`${c.id}: ${d[0]}`)
      // (not vacuous: in most cases vega paints in another order than the one its marks and items are declared in)
      const plain = JSON.parse(JSON.stringify(c.spec, (k, v) => (k === 'zindex' ? undefined : v)))
      if (diffCanonical(canonicalizeSvg(oracle), canonicalizeSvg(await vegaSvg(plain))).length) reordered++
    }
    expect(bad).toEqual([])
    expect(reordered).toBeGreaterThan(CASES * 0.5)
  }, 120_000)
})
