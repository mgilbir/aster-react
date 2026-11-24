// @vitest-environment node
/**
 * Which views share a dataset when they carry inline rows: vega-lite's findSource makes two views' `data` one source when their
 * values are deepEqual, whether they are one object or equal-but-distinct ones. @aster-charts/vl reads no row unless it must,
 * so this pins, across layers, concat, repeat and facet:
 *  - equal rows compile the same whether they are one object or two (for vega-lite as for Aster);
 *  - in a view, the marks that read one inline dataset are the ones vega-lite has read one (layers of one view share a source);
 *  - the SVG is vega-lite's.
 *  - across the views of a concat / repeat / facet, views with equal rows read one source in vega-lite and in Aster, and there are as
 *    many sources (`global` and `sources` below).
 */
import { describe, it, expect } from 'vitest'
import * as vl from 'vega-lite'
import { compile } from '@aster-charts/vl'
import { renderWithVega } from '../src/render-vega.js'
import { canonicalizeSvg, diffCanonical, type CanonicalResult } from '../src/normalize.js'

type Obj = Record<string, any>
const rows = (seed: number, n = 6): Obj[] => Array.from({ length: n }, (_, i) => ({ k: `k${i % 3}`, x: (i * 5 + seed) % 13, y: (i * 3 + seed * 7) % 11 }))

/** The relation between the rows two views carry. */
const RELATIONS = {
  'one object': (): [Obj[], Obj[]] => { const r = rows(1); return [r, r] },
  'equal but distinct': (): [Obj[], Obj[]] => [rows(1), rows(1)],
  'equal rows that are one object each': (): [Obj[], Obj[]] => { const r = rows(1); return [r, r.slice()] },
  'equal, keys in another order': (): [Obj[], Obj[]] => [rows(1), rows(1).map((r) => Object.fromEntries(Object.entries(r).reverse()))],
  'equal, nested keys in another order': (): [Obj[], Obj[]] => [rows(1).map((r) => ({ ...r, o: { p: 1, q: [1, { s: 2, t: 3 }] } })), rows(1).map((r) => ({ o: { q: [1, { t: 3, s: 2 }], p: 1 }, ...r }))],
  'different (same length)': (): [Obj[], Obj[]] => [rows(1), rows(2)],
  'different (length)': (): [Obj[], Obj[]] => [rows(1), rows(1, 4)],
  'different (last row)': (): [Obj[], Obj[]] => { const a = rows(1); const b = rows(1); b[b.length - 1]!.y = 99; return [a, b] },
}

const xy = { x: { field: 'x', type: 'quantitative' }, y: { field: 'y', type: 'quantitative' } }
/** Specs in which two views carry rows a and b. */
const SHAPES: Record<string, (a: Obj[], b: Obj[]) => Obj> = {
  layer: (a, b) => ({ layer: [{ data: { values: a }, mark: 'point', encoding: xy }, { data: { values: b }, mark: 'line', encoding: xy }] }),
  'layer of three (the middle one has rows of its own)': (a, b) => ({ layer: [{ data: { values: a }, mark: 'point', encoding: xy }, { data: { values: rows(5, 3) }, mark: 'rule', encoding: { y: xy.y } }, { data: { values: b }, mark: 'tick', encoding: xy }] }),
  'nested layer': (a, b) => ({ layer: [{ data: { values: a }, mark: 'point', encoding: xy }, { layer: [{ data: { values: b }, mark: 'line', encoding: xy }] }] }),
  hconcat: (a, b) => ({ hconcat: [{ data: { values: a }, mark: 'point', encoding: xy }, { data: { values: b }, mark: 'bar', encoding: { x: { field: 'k', type: 'nominal' }, y: { aggregate: 'sum', field: 'y', type: 'quantitative' } } }] }),
  vconcat: (a, b) => ({ vconcat: [{ data: { values: a }, mark: 'point', encoding: xy }, { data: { values: b }, mark: 'point', encoding: xy }] }),
  'concat (wrapped)': (a, b) => ({ columns: 1, concat: [{ data: { values: a }, mark: 'point', encoding: xy }, { data: { values: b }, mark: 'circle', encoding: xy }] }),
  'concat of layers': (a, b) => ({ hconcat: [{ layer: [{ data: { values: a }, mark: 'point', encoding: xy }] }, { layer: [{ data: { values: b }, mark: 'rule', encoding: { y: xy.y } }] }] }),
  'repeat (beside a view with its own rows)': (a, b) => ({ hconcat: [{ data: { values: a }, repeat: ['x', 'y'], spec: { mark: 'point', encoding: { x: { field: { repeat: 'repeat' }, type: 'quantitative' }, y: xy.y } } }, { data: { values: b }, mark: 'point', encoding: xy }] }),
  'repeat of a layer whose layers carry rows': (a, b) => ({ repeat: ['x', 'y'], spec: { layer: [{ data: { values: a }, mark: 'point', encoding: { x: { field: { repeat: 'repeat' }, type: 'quantitative' }, y: xy.y } }, { data: { values: b }, mark: 'rule', encoding: { y: { aggregate: 'mean', field: { repeat: 'repeat' }, type: 'quantitative' } } }] } }),
  'facet beside a view with its own rows': (a, b) => ({ hconcat: [{ data: { values: a }, facet: { field: 'k', type: 'nominal' }, spec: { mark: 'point', encoding: xy, width: 60 } }, { data: { values: b }, mark: 'point', encoding: xy }] }),
  'two facets': (a, b) => ({ vconcat: [{ data: { values: a }, facet: { row: { field: 'k', type: 'nominal' } }, spec: { mark: 'point', encoding: xy } }, { data: { values: b }, facet: { column: { field: 'k', type: 'nominal' } }, spec: { mark: 'bar', encoding: { x: { field: 'k', type: 'nominal' }, y: xy.y } } }] }),
}

/**
 * Per view (a group's own non-group marks, in order), which of its marks read the same inline dataset in the end: each mark is
 * written `type:n`, n numbering the view's datasets in order of first use. Names are resolved scope by scope, innermost first.
 */
function sharing(spec: Obj): { views: string[][]; global: string[]; sources: number } {
  const views: string[][] = []
  const global: string[] = []
  const globalNumbers = new Map<Obj, number>()
  let sources = 0
  const visit = (node: Obj, scopes: Array<Map<string, Obj | { facet: string }>>): void => {
    const own = new Map<string, Obj | { facet: string }>()
    for (const d of (node.data as Obj[] | undefined) ?? []) { own.set(d.name, d); if (d.values !== undefined || d.url !== undefined) sources++ }
    for (const m of (node.marks as Obj[] | undefined) ?? []) if (m.from?.facet) own.set(m.from.facet.name, { facet: m.from.facet.data })
    const chain = [own, ...scopes]
    const lookup = (name: string, from: number): [Obj | { facet: string } | undefined, number] => {
      for (let i = from; i < chain.length; i++) if (chain[i]!.has(name)) return [chain[i]!.get(name), i]
      return [undefined, chain.length]
    }
    const root = (name: string | undefined): Obj | undefined => {
      let at = 0
      for (let n = name, guard = 0; n !== undefined && guard < 100; guard++) {
        const [d, i] = lookup(n, at)
        if (!d) return undefined
        if ('facet' in d && typeof d.facet === 'string') { n = d.facet; at = i + 1; continue }
        const def = d as Obj
        if (def.values !== undefined) return def
        n = def.source
        at = i
      }
      return undefined
    }
    const numbers = new Map<Obj, number>()
    const view: string[] = []
    for (const m of (node.marks as Obj[] | undefined) ?? []) {
      if (m.type === 'group') { visit(m, chain); continue }
      const r = root(m.from?.data)
      if (!r) continue
      if (!numbers.has(r)) numbers.set(r, numbers.size)
      view.push(`${m.type}:${numbers.get(r)}`)
      if (!globalNumbers.has(r)) globalNumbers.set(r, globalNumbers.size)
      global.push(`${m.type}:${globalNumbers.get(r)}`)
    }
    if (view.length) views.push(view)
  }
  visit(spec, [])
  return { views, global, sources }
}

describe('views with equal inline rows share a dataset where vega-lite shares one', () => {
  for (const [shape, make] of Object.entries(SHAPES)) {
    for (const [relation, pair] of Object.entries(RELATIONS)) {
      it(`${shape}, rows ${relation}`, async () => {
        const [a, b] = pair()
        const spec = { $schema: 'https://vega.github.io/schema/vega-lite/v6.json', ...make(a, b) }
        const oracle = (vl as any).compile(structuredClone(spec)).spec as Obj
        const ours = compile(spec as never) as Obj
        // whether equal rows are one object or two decides nothing, for vega-lite (deepEqual) and for Aster
        if (relation.startsWith('equal') && !relation.includes('order')) {
          const [one] = RELATIONS['one object']()
          const same = make(one, one)
          expect(JSON.stringify(ours)).toBe(JSON.stringify(compile({ $schema: spec.$schema, ...same } as never)))
          expect(JSON.stringify(oracle)).toBe(JSON.stringify((vl as any).compile({ $schema: spec.$schema, ...structuredClone(same) }).spec))
        }
        // in a view, the marks that read one dataset are the ones vega-lite has read one
        const want = sharing(oracle)
        const got = sharing(ours)
        expect(got.views.flat().length).toBeGreaterThan(0)
        expect(got.views).toEqual(want.views)
        // and across views: views whose rows vega-lite makes one source read one source, and there are as many sources
        expect(got.global).toEqual(want.global)
        expect(got.sources).toBe(want.sources)
        // and the chart is vega-lite's
        const svg = async (s: Obj): Promise<CanonicalResult> => canonicalizeSvg(await renderWithVega(structuredClone(s)))
        expect(diffCanonical(await svg(oracle), await svg(ours)).slice(0, 2)).toEqual([])
      })
    }
  }

  it('the relations are what they say: equal-but-distinct rows are equal and not one object', () => {
    const [a, b] = RELATIONS['equal but distinct']()
    expect(a).not.toBe(b)
    expect(a).toEqual(b)
    expect(a[0]).not.toBe(b[0])
  })
})

/** The rest of findSource: urls, names, topojson objects, a lookup's data. Compared on the compiled specs (url data is not loaded here). */
describe('which views share a source: urls, names, topojson objects, lookups', () => {
  const unit = (data: Obj, extra: Obj = {}): Obj => ({ data, mark: 'point', encoding: xy, ...extra })
  const CASES: Record<string, Obj> = {
    'the same url': { hconcat: [unit({ url: 'data/cars.json' }), unit({ url: 'data/cars.json' })] },
    'different urls': { hconcat: [unit({ url: 'data/cars.json' }), unit({ url: 'data/movies.json' })] },
    'the same url, different topojson features': { hconcat: [{ data: { url: 'w.json', format: { type: 'topojson', feature: 'a' } }, mark: 'geoshape' }, { data: { url: 'w.json', format: { type: 'topojson', feature: 'b' } }, mark: 'geoshape' }] },
    'the same url, a feature and a mesh': { hconcat: [{ data: { url: 'w.json', format: { type: 'topojson', feature: 'a' } }, mark: 'geoshape' }, { data: { url: 'w.json', format: { type: 'topojson', mesh: 'a' } }, mark: 'geoshape' }] },
    'equal rows under two names': { hconcat: [unit({ name: 'one', values: rows(1) }), unit({ name: 'two', values: rows(1) })] },
    'equal rows, one named': { hconcat: [unit({ values: rows(1) }), unit({ name: 'two', values: rows(1) })] },
    'equal rows, the same name': { hconcat: [unit({ name: 'one', values: rows(1) }), unit({ name: 'one', values: rows(1) })] },
    'a lookup whose data are the view\'s rows': unit({ values: rows(1) }, { transform: [{ lookup: 'k', from: { data: { values: rows(1) }, key: 'k', fields: ['y'] }, as: ['y2'] }] }),
    'a lookup whose data are other rows': unit({ values: rows(1) }, { transform: [{ lookup: 'k', from: { data: { values: rows(2) }, key: 'k', fields: ['y'] }, as: ['y2'] }] }),
  }
  for (const [name, body] of Object.entries(CASES)) {
    it(name, () => {
      const spec = { $schema: 'https://vega.github.io/schema/vega-lite/v6.json', ...body }
      const oracle = (vl as any).compile(structuredClone(spec)).spec as Obj
      const ours = compile(spec as never) as Obj
      const want = sharing(oracle)
      const got = sharing(ours)
      expect(got.global).toEqual(want.global)
      expect(got.sources).toBe(want.sources)
    })
  }
})
