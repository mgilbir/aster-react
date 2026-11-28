// @vitest-environment node
/**
 * Features crossed with compositions, against vega-lite 6.4.3. A compiler rule that holds for a unit view and breaks inside a layer,
 * a concat, a facet or a wrapped facet is the kind of defect a hand-picked case table misses (the first-pass mis-compiles were all of
 * it: a calculated field in a facet of layers, two binnings of one field, a normalised stack with nothing to stack by, a rounded stack in
 * a facet, a config style, a layer's resolve, a wrapped facet's header, a layer child's size, one field on two channels, a format
 * under a condition, an extent parameter in a composition, a boxplot with a slider).
 *
 * Every feature is a unit view (with the data and the transform it needs) and every shape puts that unit in a composition; the
 * spec is run through the same check as the parity suite (structure, interaction wiring, expressions, render). A spec vega-lite
 * refuses must be refused here by a VLCompileError, not a crash.
 */
import { describe, it, expect } from 'vitest'
import * as vl from 'vega-lite'
import { compile, VLCompileError } from '@aster-charts/vl'
import { oracleDefect } from './vl-oracle-defect.js'
import { check, plain } from './vl-parity-check.js'

const DATA = {
  values: [
    { c: 'A', g: 'p', x: 1, y: 2, v: 5, t: '2001-01-01' },
    { c: 'B', g: 'q', x: 2, y: 4, v: 9, t: '2002-01-01' },
    { c: 'A', g: 'q', x: 3, y: 3, v: 2, t: '2003-01-01' },
    { c: 'C', g: 'p', x: 4, y: 6, v: 7, t: '2004-01-01' },
    { c: 'B', g: 'p', x: 5, y: 5, v: 4, t: '2005-01-01' },
    { c: 'C', g: 'q', x: 6, y: 8, v: 6, t: '2006-01-01' },
  ],
}
const NULLS = { values: [{ a: null, b: 100, c: 5, g: 'p' }, { a: -10, b: null, c: 3, g: 'q' }, { a: -5, b: -25, c: null, g: 'p' }, { a: 1, b: 30, c: 7, g: 'q' }, { a: 5, b: 40, c: 2, g: 'p' }, { a: 10, b: null, c: 9, g: 'q' }] }
const BOX = { values: Array.from({ length: 48 }, (_, i) => ({ c: ['A', 'B', 'C'][i % 3], g: i % 2 ? 'p' : 'q', x: i % 5, v: [3, 5, 4, 6, 5, 4, 7, 5, 6, 4, 5, 6, 40, 5, 6, 4, -30, 5, 4, 6][i % 20]! + (i % 7) })) }
const q = (field: string, extra: Record<string, unknown> = {}) => ({ field, type: 'quantitative', ...extra })
const n = (field: string, extra: Record<string, unknown> = {}) => ({ field, type: 'nominal', ...extra })

interface Feature {
  data: unknown
  /** The unit view: mark, encoding and the transform or params it needs. */
  unit: Record<string, unknown>
  /** Properties of the top-level spec (a config, a resolve). */
  top?: Record<string, unknown>
  /** The shapes it is not asked in (a unit view has no `resolve`: @aster-charts/vl refuses it where vega-lite ignores it). */
  not?: string[]
}
const FEATURES: Array<[string, Feature]> = [
  ['a calculated measure', { data: DATA, unit: { transform: [{ calculate: 'datum.v / 100', as: 'pct' }], mark: 'bar', encoding: { x: n('c'), y: q('pct') } } }],
  ['measures that are all computed', { data: DATA, unit: { transform: [{ calculate: 'datum.v * 2', as: 'a' }, { calculate: 'datum.y + 1', as: 'b' }], mark: 'point', encoding: { x: q('a'), y: q('b'), size: q('a') } } }],
  ['a calculated field counted by distinct', { data: DATA, unit: { transform: [{ calculate: 'datum.v + 1', as: 'w' }], mark: 'line', encoding: { x: n('c'), y: q('w', { aggregate: 'distinct' }) } } }],
  ['one field binned on a position and on colour', { data: DATA, unit: { mark: 'bar', encoding: { x: q('v', { bin: true }), y: { aggregate: 'count' }, color: q('v', { bin: true }) } } }],
  ['a normalised stack with nothing to stack by', { data: DATA, unit: { mark: 'bar', encoding: { x: n('c'), y: q('v', { aggregate: 'sum', stack: 'normalize' }) } } }],
  ['a rounded stacked bar', { data: DATA, unit: { mark: { type: 'bar', cornerRadius: 6 }, encoding: { x: n('c'), y: q('v'), color: n('t') } } }],
  ['a config style of the mark type', { data: DATA, top: { config: { style: { bar: { opacity: 0.4 } } } }, unit: { mark: 'bar', encoding: { x: n('c'), y: q('v', { aggregate: 'sum' }) } } }],
  ['a config style of the text mark', { data: DATA, top: { config: { style: { text: { fontSize: 17 } } } }, unit: { mark: 'text', encoding: { x: q('x'), y: q('y'), text: n('c') } } }],
  ['an independent y scale', { data: DATA, not: ['a unit', 'a facet channel'], top: { resolve: { scale: { y: 'independent' } } }, unit: { mark: 'point', encoding: { x: q('x'), y: q('y') } } }],
  ['a size of its own', { data: DATA, unit: { width: 100, height: 80, mark: 'bar', encoding: { x: n('c'), y: q('v', { aggregate: 'sum' }) } } }],
  ['a step width of its own', { data: DATA, unit: { width: { step: 40 }, mark: 'bar', encoding: { x: n('c'), y: q('v', { aggregate: 'sum' }) } } }],
  ['invalid values shown, one field on two channels', { data: NULLS, unit: { mark: { type: 'point', invalid: 'show' }, encoding: { x: q('c'), y: q('b'), color: q('b') } } }],
  ['a line, one field on two channels', { data: NULLS, unit: { mark: 'line', encoding: { x: q('c'), y: q('b'), color: q('b') } } }],
  ['a format under a condition', { data: DATA, unit: { mark: 'text', encoding: { x: q('x'), y: q('y'), text: { condition: { test: 'datum.v > 4', field: 'v', type: 'quantitative', format: '.2f' }, value: '-' } } } }],
  ['an extent parameter read downstream', { data: DATA, unit: { transform: [{ extent: 'v', param: 'ex' }, { calculate: 'datum.v - ex[0]', as: 'd' }], mark: 'point', encoding: { x: q('x'), y: q('d') } } }],
  ['a slider parameter filtering a boxplot', { data: BOX, unit: { params: [{ name: 'cut', value: 2, bind: { input: 'range', min: 0, max: 100 } }], transform: [{ filter: 'datum.v > cut' }], mark: 'boxplot', encoding: { x: n('c'), y: q('v') } } }],
  ['a point selection', { data: DATA, unit: { params: [{ name: 'pick', select: { type: 'point', fields: ['c'] } }], mark: 'bar', encoding: { x: n('c'), y: q('v', { aggregate: 'sum' }), color: { condition: { param: 'pick', value: 'red' }, value: 'grey' } } } }],
  ['a rule from a datum', { data: DATA, unit: { mark: 'rule', encoding: { y: { datum: 4 }, color: { value: 'red' } } } }],
]

type Shape = (f: Feature) => Record<string, unknown>
const SIDE = { mark: 'point', encoding: { x: q('x'), y: q('v') } }
const FACET_SIDE = { mark: 'rule', encoding: { y: { datum: 4 } } }
const SHAPES: Array<[string, Shape]> = [
  ['a unit', (f) => ({ data: f.data, ...f.top, ...f.unit })],
  ['a layer', (f) => ({ data: f.data, ...f.top, layer: [f.unit, FACET_SIDE] })],
  ['an hconcat', (f) => ({ data: f.data, ...f.top, hconcat: [f.unit, SIDE] })],
  ['a vconcat', (f) => ({ data: f.data, ...f.top, vconcat: [SIDE, f.unit] })],
  ['a column facet', (f) => ({ data: f.data, ...f.top, facet: { column: n('g') }, spec: f.unit })],
  ['a facet of layers', (f) => ({ data: f.data, ...f.top, facet: { column: n('g') }, spec: { layer: [f.unit, FACET_SIDE] } })],
  ['a wrapped facet', (f) => ({ data: f.data, ...f.top, facet: n('c'), columns: 2, spec: f.unit })],
  ['a facet channel', (f) => ({ data: f.data, ...f.top, ...f.unit, encoding: { ...(f.unit.encoding as Record<string, unknown> | undefined), column: n('g') } })],
]

/** The facet-only properties: a wrapped facet's header and the header config (C49: only row and column facets had them). */
const HEADERS: Array<[string, Record<string, unknown>]> = [
  ['a wrapped facet with header.labelOrient bottom', { data: DATA, facet: n('c', { header: { labelOrient: 'bottom' } }), columns: 2, spec: { mark: 'point', encoding: { x: q('x'), y: q('y') } } }],
  ['a wrapped facet with a header title colour and size', { data: DATA, facet: n('c', { header: { titleColor: 'red', titleFontSize: 20 } }), columns: 2, spec: { mark: 'point', encoding: { x: q('x'), y: q('y') } } }],
  ['a wrapped facet with config.headerFacet', { data: DATA, config: { headerFacet: { labelColor: 'green', titleColor: 'blue' } }, facet: n('c'), columns: 2, spec: { mark: 'point', encoding: { x: q('x'), y: q('y') } } }],
  ['a column facet with config.headerColumn', { data: DATA, config: { headerColumn: { labelColor: 'green', titleOrient: 'bottom' } }, facet: { column: n('g') }, spec: { mark: 'point', encoding: { x: q('x'), y: q('y') } } }],
  ['nested layers with their own resolve', { data: DATA, layer: [{ resolve: { scale: { y: 'independent' } }, layer: [{ mark: 'point', encoding: { x: q('x'), y: q('y') } }, { mark: 'line', encoding: { x: q('x'), y: q('v') } }] }, { mark: 'rule', encoding: { y: { datum: 4 } } }] }],
  ['a layer resolve of the x scale', { data: DATA, resolve: { scale: { x: 'independent' } }, layer: [{ mark: 'point', encoding: { x: q('x'), y: q('y') } }, { mark: 'line', encoding: { x: q('v'), y: q('y') } }] }],
]

async function run(spec: Record<string, unknown>): Promise<void> {
  let refused: unknown
  let oracle: Record<string, unknown> | undefined
  try { oracle = (vl as unknown as { compile: (s: unknown) => { spec: Record<string, unknown> } }).compile(plain(spec)).spec } catch (e) { refused = e }
  if (refused !== undefined) {
    expect(() => compile(plain(spec) as never), 'vega-lite refuses this spec').toThrow(VLCompileError)
    return
  }
  // (DECISIONS Q9 in parity tests: where vega-lite's chart is no chart - real Vega fails on it, or draws nothing - the compiler's typed
  // refusal is asserted on that evidence, taken from this render; a chart that renders is compared as any other, nothing is skipped)
  const defect = await oracleDefect(oracle!)
  let refusal2: unknown
  try { compile(plain(spec) as never) } catch (e) { refusal2 = e }
  if (refusal2 instanceof VLCompileError) {
    // (the compiler refuses what vega-lite compiles: that is right only where vega-lite's output is no chart; a chart that draws is a gap)
    expect(defect, `the compiler refuses this spec (${refusal2.message}), but real Vega draws a chart from vega-lite's output`).toBeDefined()
    return
  }
  await check(plain(spec))
}

for (const [shapeName, shape] of SHAPES) {
  describe(`@aster-charts/vl == vega-lite: a feature in ${shapeName}`, () => {
    for (const [featureName, feature] of FEATURES) if (!feature.not?.includes(shapeName)) it(featureName, () => run(shape(feature)), 30_000)
  })
}
describe('@aster-charts/vl == vega-lite: header and resolve properties of compositions', () => {
  for (const [name, spec] of HEADERS) it(name, () => run(spec), 30_000)
})
