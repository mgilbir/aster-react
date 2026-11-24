/**
 * A mark's `sort` orders what the mark DRAWS, not what a later mark reads from it.
 *
 * vega-parser wires a mark as DataJoin -> Collect -> Mark -> Encode -> SortItems -> Bound, and a named mark's DataScope (what
 * `from: {data: <mark>}` and `data('<mark>')` read) is that Collect: the items in the order of the mark's rows. SortItems orders
 * `mark.items`, which only the renderer reads. So a text mark drawn from a sorted line reads the line's items in data order,
 * while the line itself is drawn through them in sorted order.
 *
 * Generated over every mark type a later mark can read (group marks too), sort fields read off the datum and off the
 * encoded item, both orders and shuffled rows; the reading mark stacks its texts on one spot, so their paint order is the order
 * it read the items in.
 *
 * `data('<mark>')` in an expression reads the other array, the sorted one (vega-functions `data` returns the DataScope's
 * values, the Sieve whose value is `pulse.source`, the array SortItems sorted in place): the second test. Compared with real vega: the canonical SVG and
 * the text order.
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

const TYPES = ['symbol', 'rect', 'rule', 'arc', 'text', 'path', 'line', 'area', 'trail', 'image', 'group'] as const
const SORTS = [{ field: 'datum.x' }, { field: 'datum.k' }, { field: 'x' }, { field: 'datum.x', order: 'descending' }, { field: ['datum.g', 'datum.x'], order: ['descending', 'ascending'] }]

function enter(type: string): Spec {
  const at = { x: { field: 'x' }, y: { field: 'y' } }
  switch (type) {
    case 'rect': return { ...at, width: { value: 5 }, height: { value: 5 } }
    case 'rule': return { ...at, x2: { value: 3 }, stroke: { value: '#000' } }
    case 'arc': return { ...at, outerRadius: { value: 6 }, startAngle: { value: 0 }, endAngle: { value: 2 } }
    case 'text': return { ...at, text: { field: 'k' } }
    case 'path': return { ...at, path: { value: 'M0,0L4,4' }, stroke: { value: '#000' } }
    case 'line': return { ...at, stroke: { value: '#c33' } }
    case 'area': return { ...at, y2: { value: 100 }, fill: { value: '#ccc' } }
    case 'trail': return { ...at, size: { value: 3 } }
    case 'image': return { ...at, width: { value: 4 }, height: { value: 4 } }
    case 'group': return { ...at, width: { value: 4 }, height: { value: 4 }, fill: { value: '#eee' } }
    default: return at
  }
}

function sortCase(seed: number): { id: string; spec: Spec } {
  const r = stream(seed * 7919 + 3)
  const type = TYPES[seed % TYPES.length]!
  const sort = SORTS[Math.floor(seed / TYPES.length) % SORTS.length]!
  const n = 4 + Math.floor(r() * 6)
  const keys = 'abcdefghij'.split('').slice(0, n)
  // shuffled rows, so data order, key order and x order all differ
  for (let i = keys.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [keys[i], keys[j]] = [keys[j]!, keys[i]!] }
  const rows = keys.map((k, i) => ({ k, x: Math.round(r() * 180) + i / 10, y: Math.round(r() * 80), g: Math.floor(r() * 3) }))
  const spec: Spec = {
    width: 200, height: 100, padding: 5, autosize: 'none',
    data: [{ name: 't', values: rows }],
    marks: [
      { name: 'base', type, from: { data: 't' }, sort, encode: { enter: enter(type) } },
      // every text on one spot: their paint order is the order the text mark read the base mark's items in
      { type: 'text', from: { data: 'base' }, encode: { enter: { x: { value: 20 }, y: { value: 50 }, text: { field: 'datum.k' }, fontSize: { value: 30 }, fill: { value: '#000' } } } },
    ],
  }
  return { id: `${type} sort ${JSON.stringify(sort)} seed ${seed}`, spec }
}

/** vega's SVG, and the keys of the base mark's items in the order vega draws them (its sorted `mark.items`). */
async function vegaRender(spec: Spec): Promise<{ svg: string; drawn: string }> {
  const view = new vega.View(vega.parse(spec as never), { renderer: 'none' })
  try {
    await view.runAsync()
    const marks = (view.scenegraph() as unknown as { root: { items: Array<{ items: Array<{ name?: string; items: Array<{ datum: { k: string } }> }> }> } }).root.items[0]!.items
    const drawn = marks.find((m) => m.name === 'base')!.items.map((it) => it.datum.k).join(' ')
    return { svg: await view.toSVG(), drawn }
  } finally {
    view.finalize()
  }
}

const textOrder = (svg: string): string => [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]).join(' ')

describe('a mark drawn from a sorted mark reads its items in data order (vega)', () => {
  it('every mark type, sort field and order: the same SVG and text order as vega', async () => {
    const bad: string[] = []
    let compared = 0
    let sortedDiffers = 0
    for (let seed = 0; seed < TYPES.length * SORTS.length * 2; seed++) {
      const c = sortCase(seed)
      const [{ svg: oracle, drawn }, ours] = await forEngines(c.spec, (o, a) => Promise.all([vegaRender(o), Promise.resolve(renderSpec(a as never))]))
      compared++
      const rows = ((c.spec.data as Array<{ values: Array<{ k: string }> }>)[0]!.values).map((d) => d.k).join(' ')
      // (not vacuous: the base mark's sort really draws its items in another order than its rows)
      if (drawn !== rows) sortedDiffers++
      if (textOrder(oracle) !== textOrder(ours)) bad.push(`${c.id}: text order vega ${JSON.stringify(textOrder(oracle))} aster ${JSON.stringify(textOrder(ours))}`)
      const d = diffCanonical(canonicalizeSvg(oracle), canonicalizeSvg(ours))
      if (d.length) bad.push(`${c.id}: ${d[0]}`)
    }
    expect(bad).toEqual([])
    expect(compared).toBe(TYPES.length * SORTS.length * 2)
    expect(sortedDiffers).toBeGreaterThan(compared * 0.8)
  })

  it("`data('<mark>')` in an expression: the mark's items in the order it draws them (vega)", async () => {
    const bad: string[] = []
    let compared = 0
    for (let seed = 0; seed < TYPES.length * SORTS.length; seed++) {
      const c = sortCase(seed)
      const marks = c.spec.marks as Spec[]
      // a text that writes what `data('base')` returns, and nothing else drawn from the base mark
      c.spec.marks = [marks[0]!, { type: 'text', encode: { update: { x: { value: 5 }, y: { value: 95 }, text: { signal: "join(pluck(pluck(data('base'), 'datum'), 'k'), ' ')" } } } }]
      const [{ svg: oracle, drawn }, ours] = await forEngines(c.spec, (o, a) => Promise.all([vegaRender(o), Promise.resolve(renderSpec(a as never))]))
      compared++
      if (textOrder(oracle).split(' ').slice(-drawn.split(' ').length).join(' ') !== drawn) bad.push(`${c.id}: vega's data('base') is not its drawn order`)
      const d = diffCanonical(canonicalizeSvg(oracle), canonicalizeSvg(ours))
      if (d.length) bad.push(`${c.id}: ${d[0]}`)
    }
    expect(bad).toEqual([])
    expect(compared).toBe(TYPES.length * SORTS.length)
  })
})
