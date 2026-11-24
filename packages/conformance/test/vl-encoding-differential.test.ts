// @vitest-environment node
/**
 * @aster-charts/vl against vega-lite 6.4.3, for the mark-encoding paths (audit lane a14): the properties a mark takes from its mark
 * definition, its named styles and the config, the invalid-value modes, conditions and formats, and the band / size geometry of the
 * rect-based marks. Each family is generated (every mark type, every channel form it concerns), both compilers' output is run by REAL
 * vega, and the canonical SVGs are compared exactly together with the scenegraph's item counts, so a mark drawn twice or a property
 * that is not applied fails the case even where the picture is the same.
 */
import { describe, it, expect } from 'vitest'
import * as vl from 'vega-lite'
import { compile } from '@aster-charts/vl'
import { renderWithVegaChecked } from '../src/render-vega.js'
import { canonicalizeSvg, diffCanonical } from '../src/normalize.js'

type Spec = Record<string, any>
const DATA = {
  values: [
    { a: 'A', b: 28, c: 3, d: '2020-01-01', g: 'x', k: 'p' },
    { a: 'B', b: 55, c: 7, d: '2020-02-01', g: 'y', k: 'p' },
    { a: 'C', b: 43, c: 1, d: '2020-03-01', g: 'x', k: 'q' },
    { a: 'A', b: 91, c: 9, d: '2020-04-01', g: 'y', k: 'q' },
    { a: 'B', b: 81, c: 4, d: '2020-05-01', g: 'x', k: 'p' },
    { a: 'C', b: 5, c: 6, d: '2020-06-01', g: 'y', k: 'q' },
  ],
}
const NULLS = {
  values: [
    { a: 'A', b: 28, c: 3 },
    { a: 'B', b: null, c: 7 },
    { a: 'C', b: 43, c: null },
    { a: 'A', b: 91, c: 9 },
    { a: 'B', b: 12, c: 4 },
  ],
}
const q = (field: string, extra: Spec = {}): Spec => ({ field, type: 'quantitative', ...extra })
const n = (field: string, extra: Spec = {}): Spec => ({ field, type: 'nominal', ...extra })
const t = (field: string, extra: Spec = {}): Spec => ({ field, type: 'temporal', ...extra })

const plain = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T
const deepFreeze = <T,>(v: T): T => {
  if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v)
    for (const k of Object.keys(v as object)) deepFreeze((v as Record<string, unknown>)[k])
  }
  return v
}
const oracleOf = (spec: Spec): Spec => (vl as unknown as { compile: (s: unknown) => { spec: Spec } }).compile(plain(spec)).spec
const oursOf = (spec: Spec): Spec => compile(deepFreeze(plain(spec)) as never) as Spec

/** The leaf items of every mark of the spec's own (not the guides), as the scenegraph holds them. */
function itemCount(vgSpecRender: string): number {
  return (vgSpecRender.match(/role="graphics-symbol"|role="graphics-object"/g) ?? []).length
}

/** Both compilers' Vega, run by vega: no new error or warning, the same canonical SVG, the same number of drawn items. */
async function same(spec: Spec): Promise<void> {
  const oracle = oracleOf(spec)
  const ours = oursOf(spec)
  const [ref, mine] = await Promise.all([renderWithVegaChecked(oracle), renderWithVegaChecked(plain(ours))])
  const inherited = new Set([...ref.errors, ...ref.warnings])
  expect([...mine.errors, ...mine.warnings].filter((m) => !inherited.has(m))).toEqual([])
  expect(itemCount(mine.svg), 'drawn items').toBe(itemCount(ref.svg))
  expect(diffCanonical(canonicalizeSvg(ref.svg), canonicalizeSvg(mine.svg)).slice(0, 2)).toEqual([])
}

/** A spec vega-lite itself cannot compile or run: Aster refuses it with a typed error (decision Q9) rather than drawing a wrong chart. */
async function refusedAsVegaLiteFails(spec: Spec, message: RegExp): Promise<void> {
  let upstream: unknown
  try {
    const oracle = oracleOf(spec)
    const r = await renderWithVegaChecked(oracle)
    if (r.errors.length === 0) throw new Error('vega-lite compiled it and vega ran it')
    upstream = r.errors
  } catch (e) {
    if (e instanceof Error && e.message === 'vega-lite compiled it and vega ran it') throw e
    upstream = e
  }
  expect(upstream).toBeDefined()
  expect(() => oursOf(spec)).toThrow(message)
}

const MARK_NAMES = ['point', 'circle', 'square', 'tick', 'bar', 'rect', 'line', 'area', 'trail', 'rule', 'text'] as const

// compile/mark/mark.ts getStackGroup: the stack of a rounded bar is a group faceted by its dimension, and the group inside it has no
// `from` of its own. A facet gives every mark the cell's dataset, but not that inner group: it is instanced by the outer one's items.
describe('@aster-charts/vl == vega-lite: a rounded stacked bar inside a facet (C55)', () => {
  const bar = (extra: Spec): Spec => ({ data: DATA, mark: { type: 'bar', cornerRadius: 6, opacity: 0.5 }, ...extra })
  const enc = { x: n('g'), y: q('b'), color: n('k') }
  const CASES: Array<[string, Spec]> = [
    ['column', bar({ encoding: { ...enc, column: n('a') } })],
    ['row', bar({ encoding: { ...enc, row: n('a') } })],
    ['row and column', bar({ encoding: { ...enc, row: n('a'), column: n('g') } })],
    ['the facet encoding channel', bar({ encoding: { ...enc, facet: n('a', { columns: 2 }) } })],
    ['the facet operator', { data: DATA, facet: { column: n('a') }, spec: { mark: { type: 'bar', cornerRadius: 6, opacity: 0.5 }, encoding: enc } }],
    ['the facet operator, wrapped', { data: DATA, facet: n('a'), columns: 2, spec: { mark: { type: 'bar', cornerRadius: 6, opacity: 0.5 }, encoding: enc } }],
    ['horizontal', bar({ encoding: { y: n('g'), x: q('b'), color: n('k'), column: n('a') } })],
    ['cornerRadiusEnd', { data: DATA, mark: { type: 'bar', cornerRadiusEnd: 6, opacity: 0.5 }, encoding: { ...enc, column: n('a') } }],
    ['a layer in a facet', { data: DATA, facet: { column: n('a') }, spec: { layer: [{ mark: { type: 'bar', cornerRadius: 6, opacity: 0.5 }, encoding: enc }, { mark: 'text', encoding: { x: n('g'), y: q('b'), text: q('b') } }] } }],
  ]
  for (const [name, spec] of CASES) it(name, () => same(spec), 30_000)
})

