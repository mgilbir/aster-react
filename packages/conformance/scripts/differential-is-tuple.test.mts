/**
 * LIVE differential for `isTuple`: true for what vega's dataflow made a tuple, false for anything else, in every place an
 * expression can ask. Each generated spec writes `isTuple(...)` of the datum of every kind of item into a text or a description
 * channel -- a dataset's rows (inline, derived by formula, filter, aggregate, window, fold, lookup), a mark without `from`, a
 * mark made from another mark's items, a facet cell and a plain group (their datum, and `parent` inside them), an axis' ticks,
 * labels and title, a legend's symbols, labels, entries and title, a title -- and of what is not a tuple (a row's nested
 * object, an object an expression makes, `data()` rows, an aggregate's `values`). Run through the pinned vega and through Aster
 * in the same process, with the rows in the spec and with the same (frozen) rows given by the host; every item's channels must
 * agree. Nothing a tuple carries may show on the scene's objects.
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { compileChart } from '../../core/src/compiler.ts'
import { evaluateChart } from '../../core/src/evaluate.ts'
import { quietLogger } from './differential-util.mts'
import { scenegraphRoot } from '../src/scenegraph-root.ts'

type Spec = Record<string, unknown>
const T = (e: string): Spec => ({ signal: `'' + (${e})` })

let seed = 3
const rnd = (): number => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32 }
const pick = <X,>(xs: readonly X[]): X => xs[Math.floor(rnd() * xs.length)]!

const DERIVED: Array<[string, unknown[], string]> = [
  ['formula', [{ type: 'formula', expr: 'datum.v * 2', as: 'w' }], 'isTuple(datum)'],
  ['filter', [{ type: 'filter', expr: 'datum.v > 1' }], 'isTuple(datum)'],
  ['aggregate', [{ type: 'aggregate', groupby: ['k'], ops: ['values', 'sum'], fields: ['v', 'v'], as: ['vals', 'sum'] }], "isTuple(datum) + ',' + isTuple(datum.vals[0])"],
  ['window', [{ type: 'window', ops: ['rank'], as: ['r'] }], 'isTuple(datum)'],
  ['fold', [{ type: 'fold', fields: ['v', 'u'] }], 'isTuple(datum)'],
  ['lookup', [{ type: 'lookup', from: 'other', key: 'k', fields: ['k'], as: ['o'] }], "isTuple(datum) + ',' + isTuple(datum.o)"],
  ['first formula', [{ type: 'formula', expr: "isTuple(datum) ? 'y' : 'n'", as: 'w' }], "datum.w + ',' + isTuple(datum)"],
  ['first filter', [{ type: 'filter', expr: 'isTuple(datum)' }], "'kept,' + isTuple(datum)"],
  ['formulas', [{ type: 'formula', expr: 'datum.v * 2', as: 'w' }, { type: 'formula', expr: "isTuple(datum) ? 'y' : 'n'", as: 'w2' }, { type: 'filter', expr: 'isTuple(datum)' }], "datum.w2 + ',' + isTuple(datum)"],
  ['chain', [{ type: 'formula', expr: 'datum.v + 1', as: 'w' }, { type: 'filter', expr: 'isTuple(datum)' }, { type: 'aggregate', groupby: ['k'], ops: ['values'], fields: ['w'], as: ['vals'] }], "isTuple(datum) + ',' + isTuple(datum.vals[0])"],
]

// the first step over a dataset's own rows (what the spec or the host gave): its expressions see them as tuples
const FIRST: Spec[] = [{ type: 'formula', expr: "isTuple(datum) ? 'y' : 'n'", as: 'it' }, { type: 'filter', expr: 'isTuple(datum)' }]

function genSpec(i: number): Spec {
  const [, transform, probe] = pick(DERIVED)
  const marks: Spec[] = [
    { type: 'text', name: 'rows', from: { data: 't' }, encode: { update: { text: T("datum.it + ',' + isTuple(datum) + ',' + isTuple(datum.obj) + ',' + isTuple({a: 1}) + ',' + isTuple(data('t')[0])") } } },
    { type: 'text', name: 'derived', from: { data: 'd' }, encode: { update: { text: T(probe) } } },
    { type: 'text', name: 'solo', encode: { update: { text: T('isTuple(datum)') } } },
    { type: 'symbol', name: 'ofmark', from: { data: 'rows' }, encode: { update: { description: T("isTuple(datum) + ',' + isTuple(datum.datum)") } } },
  ]
  if (rnd() < 0.7) marks.push({
    type: 'group', name: 'cells', from: { facet: { data: 't', name: 'f', groupby: 'k' } }, encode: { update: { description: T('isTuple(datum)') } },
    marks: [
      { type: 'text', name: 'inner', from: { data: 'f' }, encode: { update: { text: T("isTuple(datum) + ',' + isTuple(parent)") } } },
      { type: 'group', name: 'nested', encode: { update: { description: T('isTuple(datum)') } }, marks: [{ type: 'text', name: 'innermost', encode: { update: { text: T('isTuple(parent)') } } }] },
    ],
  })
  if (rnd() < 0.6) marks.push({ type: 'group', name: 'plain', encode: { update: { description: T('isTuple(datum)') } }, marks: [{ type: 'text', name: 'inplain', encode: { update: { text: T('isTuple(parent)') } } }] })
  const spec: Spec = {
    width: 100, height: 60, padding: 5,
    data: [
      { name: 't', values: [{ k: 'a', v: 1, u: 4, obj: { z: 1 } }, { k: 'b', v: 2, u: 5, obj: { z: 2 } }, { k: 'a', v: 3, u: 6, obj: { z: 3 } }], ...(rnd() < 0.5 ? { transform: [pick(FIRST)] } : {}) },
      { name: 'other', values: [{ k: 'a', note: 'x' }, { k: 'b', note: 'y' }] },
      { name: 'd', source: 't', transform },
    ],
    signals: [{ name: 's', update: "isTuple(data('t')[0]) + ',' + isTuple(data('d')[0]) + ',' + isTuple({}) + ',' + isTuple(null)" }],
    scales: [{ name: 'x', type: 'linear', domain: [0, 3], range: 'width' }, { name: 'c', type: 'ordinal', domain: ['a', 'b'], range: 'category' }],
    marks,
  }
  if (rnd() < 0.7) spec.axes = [{ scale: 'x', orient: pick(['bottom', 'left'] as const), title: 'X', values: [1, 2], encode: { labels: { update: { text: T('isTuple(datum)') } }, ticks: { update: { description: T('isTuple(datum)') } }, title: { update: { text: T('isTuple(datum)') } } } }]
  if (rnd() < 0.7) spec.legends = [{ fill: 'c', title: 'L', encode: { labels: { update: { text: T('isTuple(datum)') } }, symbols: { update: { description: T('isTuple(datum)') } }, title: { update: { text: T('isTuple(datum)') } } } }]
  if (rnd() < 0.5) spec.title = { text: 'T', encode: { title: { update: { text: T('isTuple(datum)') } } } }
  void i
  return spec
}

/** What every item says, in the scene's order: `<mark or part>: <text>|<description>`. */
function vegaSays(root: unknown): string[] {
  const out: string[] = []
  const walk = (m: { name?: string; role: string; items: Array<{ text?: unknown; description?: unknown; items?: unknown[] }> }): void => {
    for (const it of m.items) {
      if (it.text !== undefined || it.description !== undefined) out.push(`${m.name ?? m.role}: ${String(it.text ?? '')}|${String(it.description ?? '')}`)
      for (const c of (it.items ?? []) as Array<typeof m>) walk(c)
    }
  }
  walk(root as never)
  return out.sort()
}

function asterSays(scene: { items: unknown[] }): string[] {
  const out: string[] = []
  type N = { name?: string; cssName?: string; role?: string; marktype?: string; _scope?: boolean; _part?: string; _bg?: boolean; items?: N[]; text?: unknown; description?: unknown; datum?: unknown }
  const say = (label: string, it: N): void => { if (it.text !== undefined || it.description !== undefined) out.push(`${label}: ${String(it.text ?? '')}|${String(it.description ?? '')}`) }
  const walk = (g: N): void => {
    if (g._scope) {
      // (a group item's own aria channels are held apart, as its `<g>` carries them)
      say(g.cssName ?? g.role ?? 'group', { description: (g as { itemAria?: { description?: unknown } }).itemAria?.description })
      for (const c of g.items ?? []) if (!c._bg && Array.isArray(c.items)) walk(c)
      return
    }
    const guide = g.role === 'axis' || g.role === 'legend' ? g.role : null
    for (const it of g.items ?? []) {
      if (Array.isArray(it.items)) { walk(it); continue }
      if (guide) { if (it._part !== undefined && it._part !== 'bg') say(`${guide}-${it._part}`, it) }
      else say(g.cssName ?? g.role ?? '?', it)
    }
  }
  for (const g of scene.items as N[]) walk(g)
  return out.sort()
}

// (Aster names a guide part by `_part`; vega by its mark's role: the same parts, by another name)
const ROLE: Record<string, string> = {
  'axis-label': 'axis-label', 'axis-tick': 'axis-tick', 'axis-title': 'axis-title', 'legend-label': 'legend-label',
  'legend-symbol': 'legend-symbol', 'legend-title': 'legend-title', 'title-text': 'title-text',
}
const normalize = (lines: string[]): string[] => lines.map((l) => { const [k, v] = [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':'))]; return (ROLE[k] ?? k) + v }).sort()

describe('isTuple, against vega, for every kind of item', () => {
  const cases = Array.from({ length: 40 }, (_, i) => genSpec(i))
  it('generated specs: every item and the signal agree', async () => {
    const failures: string[] = []
    let compared = 0
    for (const [i, spec] of cases.entries()) {
      const errors: unknown[][] = []
      const view = new vega.View(vega.parse(structuredClone(spec)), { renderer: 'none', logger: quietLogger(errors) })
      await view.runAsync()
      expect(errors, `case ${i}: vega errors`).toEqual([])
      const want = normalize(vegaSays(scenegraphRoot(view)))
      const wantSignal = view.signal('s')
      view.finalize()
      // the rows in the spec, and the same rows given by the host (`input.data`): vega's ingested rows either way
      const hosted = structuredClone(spec) as { data: Array<{ name: string; values?: unknown[] }> }
      const t = hosted.data.find((d) => d.name === 't')!
      const hostRows = Object.freeze(t.values!.map((r) => Object.freeze(r)))
      t.values = []
      const scene = evaluateChart(compileChart(structuredClone(spec) as never)) as unknown as { items: unknown[]; signalParams: Record<string, unknown> }
      const hostScene = evaluateChart(compileChart(hosted as never), { data: { t: hostRows as unknown[] } }) as unknown as typeof scene
      for (const [how, sc] of [['spec rows', scene], ['host rows', hostScene]] as const) {
        const got = normalize(asterSays(sc))
        compared += want.length
        if (JSON.stringify(got) !== JSON.stringify(want)) failures.push(`case ${i} (${how}): vega=${JSON.stringify(want.filter((w) => !got.includes(w)))} aster=${JSON.stringify(got.filter((g) => !want.includes(g)))}`)
        if (sc.signalParams.s !== wantSignal) failures.push(`case ${i} (${how}): signal vega=${String(wantSignal)} aster=${String(sc.signalParams.s)}`)
      }
      // nothing a tuple carries shows on the scene's objects
      const walk = (n: { datum?: unknown; items?: unknown[] }): void => {
        if (n.datum !== null && typeof n.datum === 'object') expect(Object.getOwnPropertySymbols(n.datum)).toEqual([])
        for (const c of (n.items ?? []) as Array<typeof n>) walk(c)
      }
      for (const g of scene.items as Array<{ items?: unknown[] }>) walk(g)
    }
    expect(compared).toBeGreaterThan(400)
    expect(failures.slice(0, 8)).toEqual([])
  })

  // Vega-Lite asks `isTuple(group())` and `isTuple(facet)` in every selection; neither needs the evaluation to register its tuples,
  // so such a chart does not pay for it -- unless the host sets `facet` to something that may be one
  const VL_FACET = { name: 'facet', value: {}, on: [{ events: [{ source: 'scope', type: 'pointermove' }], update: 'isTuple(facet) ? facet : group("cell").datum' }] }
  const facetSpec = (extra: Spec[] = []): Spec => ({
    width: 100, height: 60, data: [{ name: 't', values: [{ k: 'a' }, { k: 'b' }] }],
    signals: [VL_FACET, ...extra, { name: 'unit', value: {}, on: [{ events: 'pointermove', update: 'isTuple(group()) ? group() : unit' }] }],
    marks: [{ type: 'text', name: 'probe', from: { data: 't' }, encode: { update: { text: T("isTuple(facet) + ',' + datum.k") } } }],
  })
  it('a chart that only asks of group() and Vega-Lite\'s facet registers nothing, and answers as vega', async () => {
    expect(compileChart(facetSpec() as never).callsIsTuple).toBe('facet')
    expect(compileChart({ signals: [{ name: 'u', value: {}, on: [{ events: 'click', update: 'isTuple( group() ) ? group() : u' }] }] } as never).callsIsTuple).toBeUndefined()
    // another write to `facet`, or another question, needs the tuples
    expect(compileChart({ ...facetSpec(), signals: [{ ...VL_FACET, on: [...VL_FACET.on, { events: 'click', update: 'datum' }] }] } as never).callsIsTuple).toBe(true)
    expect(compileChart({ ...facetSpec(), signals: [{ ...VL_FACET, value: [] }] } as never).callsIsTuple).toBe(true)
    expect(compileChart({ signals: [{ name: 'u', update: 'isTuple(data("t")[0])' }] } as never).callsIsTuple).toBe(true)
    // the host sets `facet`: to one of the rows it gives (an ingested row, a tuple to vega), and to an object of its own
    for (const which of ['row', 'object'] as const) {
      const spec = facetSpec()
      const rows = (spec.data as Array<{ values: object[] }>)[0]!.values.map((r) => Object.freeze({ ...r }))
      const hosted = structuredClone(spec) as { data: Array<{ values: unknown[] }> }
      hosted.data[0]!.values = []
      const view = new vega.View(vega.parse(structuredClone(hosted) as never), { renderer: 'none' })
      // (vega stamps its id on the rows it ingests: it is given copies; Aster the frozen rows)
      view.data('t', rows.map((r) => ({ ...r })) as never)
      await view.runAsync()
      const value = which === 'row' ? view.data('t')[0] : { k: 'z' }
      view.signal('facet', value)
      await view.runAsync()
      const want = vegaSays(scenegraphRoot(view))
      view.finalize()
      const scene = evaluateChart(compileChart(hosted as never), { data: { t: rows as unknown[] }, signals: { facet: which === 'row' ? rows[0] : { k: 'z' } } }) as unknown as { items: unknown[] }
      expect(normalize(asterSays(scene)), which).toEqual(normalize(want))
      expect(want.some((w) => w.includes(which === 'row' ? 'true' : 'false')), which).toBe(true)
    }
  })
})
