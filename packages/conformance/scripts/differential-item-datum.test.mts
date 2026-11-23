/**
 * LIVE differential for the `datum` of scene items that are not made from a data row.
 *
 * A mark without `from` is made of one item whose datum vega-parser generates (`{}`, a tuple of its own), a group mark
 * without `from` likewise; the parts of a guide carry the guide's own data (an axis' tick and its datum, the axis datum
 * for its domain and title, a legend's entries, the title's `{}`). What an item's datum is can be observed: an encode
 * reads it (`datum.*`), the event loop hands it out as `event.item.datum` / `datum`, a tooltip handler and
 * `ChartHandle.getScene()` expose it. Each generated spec is run through the pinned real vega and through Aster in the
 * same process, and every item's datum is compared (its own enumerable keys and values), per mark and per guide part.
 * Nothing is recorded.
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { compileChart } from '../../core/src/compiler.ts'
import { evaluateChart } from '../../core/src/evaluate.ts'
import { enc, quietLogger } from './differential-util.mts'
import { scenegraphRoot } from '../src/scenegraph-root.ts'

type Row = Record<string, unknown>
type Spec = Record<string, unknown>

/** The datum as anything outside the engine sees it: `undefined`, or its own enumerable keys and values. */
const image = (d: unknown): unknown => (d === undefined ? 'undefined' : d === null ? 'null' : enc(d))

/** vega's scenegraph: `key -> [datum image]` in item order (marks by name, guide parts by role, legend entries by their group). */
function vegaItems(root: unknown): Map<string, unknown[]> {
  const out = new Map<string, unknown[]>()
  const push = (k: string, v: unknown): void => { const l = out.get(k); if (l) l.push(v); else out.set(k, [v]) }
  const walk = (mark: { marktype: string; role: string; name?: string; items: Array<{ datum?: unknown; items?: unknown[] }> }, inLegend: boolean): void => {
    for (const it of mark.items) {
      const role = mark.role
      // (the root group item has no datum in either engine; a legend's `legend-entry` group is a container vega never paints, and
      // so never picks: Aster has no item for it at all)
      if (role === 'frame' || role === 'legend-entry') { /* nothing to compare */ }
      else if (mark.name) push(`mark:${mark.name}`, image(it.datum))
      else if (role === 'scope' && inLegend) push('legend-entry-item', image(it.datum))
      else if (role !== 'scope' && role !== 'mark') push(role, image(it.datum))
      for (const m of (it.items ?? []) as Array<typeof mark>) walk(m, inLegend || role === 'legend')
    }
  }
  walk(root as never, false)
  return out
}

/** Aster's scene, keyed the same way (a guide part is named by `_part`; an axis / legend leaf's role is `<guide>-<part>`). */
function asterItems(scene: { items: unknown[] }): Map<string, unknown[]> {
  const out = new Map<string, unknown[]>()
  const push = (k: string, v: unknown): void => { const l = out.get(k); if (l) l.push(v); else out.set(k, [v]) }
  type Node = { marktype?: string; role?: string; name?: string; items?: Node[]; datum?: unknown; _part?: string; _bg?: boolean; _scope?: boolean }
  const walk = (g: Node): void => {
    if (g._scope) {
      // a group item: its own datum, then what it holds
      if (g.name) push(`mark:${g.name}`, image(g.datum))
      for (const c of g.items ?? []) if (!c._bg) walk(c)
      return
    }
    const guide = g.role === 'axis' || g.role === 'legend' ? g.role : g.role === 'title' ? 'title' : null
    // a guide's own group item
    if (guide !== null) push(guide, image(g.datum))
    for (const it of g.items ?? []) {
      if (Array.isArray(it.items) && (it._scope || it.marktype !== undefined)) { walk(it); continue }
      if (guide === 'axis' || guide === 'legend') {
        const part = it._part
        if (part === 'bg' || part === undefined) continue
        push(part === 'entry' ? 'legend-entry-item' : `${guide}-${part}`, image(it.datum))
      } else if (guide === 'title') {
        if (g.role === 'title') continue
      } else if (g.role === 'title-text' || g.role === 'title-subtitle') {
        push(g.role, image(it.datum))
      } else if (g.name) {
        push(`mark:${g.name}`, image(it.datum))
      }
    }
  }
  for (const g of scene.items as Node[]) walk(g)
  return out
}

// ---- generated specs ----------------------------------------------------------------------------------------------

let seed = 11
const rnd = (): number => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32 }
const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!

const TYPES = ['rect', 'symbol', 'rule', 'text', 'arc', 'path', 'image', 'line', 'area', 'trail'] as const
const ROWS = [{ k: 'a', v: 1, g: 'p' }, { k: 'b', v: 3, g: 'q' }, { k: 'c', v: 2, g: 'p' }]

function leaf(type: string, name: string, from: boolean): Spec {
  // every channel reads the datum, so a datum that is not an object would also show in the encode
  const update: Spec = {
    x: { signal: '(datum.v || 1) * 20' }, y: { signal: '(datum.v || 2) * 15' }, fill: { value: 'steelblue' }, stroke: { value: 'black' },
    description: { signal: "'d:' + toString(datum) + ':' + datum.k" },
  }
  if (type === 'rect' || type === 'image') Object.assign(update, { width: { value: 20 }, height: { value: 10 } })
  if (type === 'rule') Object.assign(update, { x2: { value: 50 }, y2: { value: 60 } })
  if (type === 'text') update.text = { signal: "'t' + (datum.k || '-')" }
  if (type === 'arc') Object.assign(update, { outerRadius: { value: 10 }, endAngle: { value: 2 } })
  if (type === 'path') update.path = { value: 'M0,0L10,0L5,8Z' }
  if (type === 'trail') update.size = { value: 3 }
  return { type, name, ...(from ? { from: { data: 't' } } : {}), encode: { update } }
}

function genSpec(i: number): Spec {
  const marks: Spec[] = []
  const n = 2 + Math.floor(rnd() * 4)
  for (let j = 0; j < n; j++) marks.push(leaf(pick(TYPES), `m${i}_${j}`, rnd() < 0.35))
  const inner = [leaf(pick(TYPES), `in${i}_a`, false), leaf(pick(TYPES), `in${i}_b`, rnd() < 0.5)]
  const groupKind = pick(['none', 'plain', 'facet', 'from'] as const)
  if (groupKind === 'plain') marks.push({ type: 'group', name: `g${i}`, encode: { update: { x: { value: 5 }, width: { value: 80 }, height: { value: 60 }, fill: { value: '#eee' } } }, marks: inner })
  if (groupKind === 'facet') marks.push({ type: 'group', name: `g${i}`, from: { facet: { data: 't', name: 'f', groupby: 'g' } }, encode: { update: { x: { value: 5 } } }, marks: inner })
  if (groupKind === 'from') marks.push({ type: 'group', name: `g${i}`, from: { data: 't' }, encode: { update: { y: { signal: 'datum.v * 10' } } }, marks: inner })
  const spec: Spec = {
    width: 200, height: 150, padding: 5, autosize: 'none',
    data: [{ name: 't', values: ROWS }],
    scales: [
      { name: 'x', type: pick(['linear', 'band'] as const) === 'band' ? 'band' : 'linear', domain: { data: 't', field: rnd() < 0.5 ? 'k' : 'v' }, range: 'width' },
      { name: 'c', type: 'ordinal', domain: { data: 't', field: 'k' }, range: 'category' },
    ],
    marks,
  }
  // guides: an axis (with a title, a grid, or both), a legend of either kind, a title
  if (rnd() < 0.7) (spec as { axes: unknown[] }).axes = [{ scale: 'x', orient: pick(['bottom', 'top', 'left'] as const), ...(rnd() < 0.6 ? { title: 'X' } : {}), ...(rnd() < 0.5 ? { grid: true } : {}) }]
  if (rnd() < 0.6) (spec as { legends: unknown[] }).legends = [{ fill: 'c', ...(rnd() < 0.6 ? { title: 'L' } : {}) }]
  if (rnd() < 0.5) spec.title = rnd() < 0.5 ? 'T' : { text: 'T', subtitle: 'S' }
  return spec
}

const CASES = Array.from({ length: 60 }, (_, i) => genSpec(i))

async function vegaRun(spec: Spec): Promise<Map<string, unknown[]>> {
  const errors: unknown[][] = []
  const view = new vega.View(vega.parse(structuredClone(spec)), { renderer: 'none', logger: quietLogger(errors) })
  await view.runAsync()
  expect(errors).toEqual([])
  const out = vegaItems(scenegraphRoot(view))
  view.finalize()
  return out
}

describe('item datum: marks without `from`, group items and guide parts (vs vega)', () => {
  it('a mark without `from` reads `{}` and its item carries it', async () => {
    const spec: Spec = { width: 50, height: 50, marks: [leaf('rect', 'r', false), { type: 'group', name: 'g', marks: [leaf('symbol', 's', false)] }] }
    const want = await vegaRun(spec)
    const got = asterItems(evaluateChart(compileChart(structuredClone(spec))) as never)
    expect(want.get('mark:r')).toEqual([{}])
    expect(got.get('mark:r')).toEqual(want.get('mark:r'))
    expect(got.get('mark:s')).toEqual(want.get('mark:s'))
    expect(got.get('mark:g')).toEqual(want.get('mark:g'))
  })

  it('generated specs: every item of every mark and guide part has vega\'s datum', async () => {
    const failures: string[] = []
    let compared = 0
    for (const [i, spec] of CASES.entries()) {
      const want = await vegaRun(spec)
      const got = asterItems(evaluateChart(compileChart(structuredClone(spec))) as never)
      for (const [key, items] of want) {
        compared += items.length
        const mine = got.get(key)
        if (JSON.stringify(mine) !== JSON.stringify(items)) failures.push(`case ${i} ${key}: vega=${JSON.stringify(items).slice(0, 160)} aster=${JSON.stringify(mine)?.slice(0, 160)}`)
      }
    }
    // a comparison of nothing proves nothing
    expect(compared).toBeGreaterThan(500)
    expect(failures.slice(0, 12)).toEqual([])
  })
})
