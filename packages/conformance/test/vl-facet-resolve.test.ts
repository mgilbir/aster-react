// @vitest-environment node
/**
 * A facet whose cells resolve a channel other than x / y independently (C83): `resolve.scale.<channel>: independent` gives each cell
 * its own scale (`child_color`) over the cell's rows and its own legend, and `resolve.legend.<channel>: independent` draws the legend
 * of a shared scale in every cell (vega-lite resolve.ts, parseLegend). Every legend channel x scale / legend resolution x facet form
 * (row, column, both, wrapped, faceted through the encoding, a facet of layers) is drawn by vega-lite 6.4.3 and by @aster-charts/vl
 * through real Vega.
 */
import { describe, it } from 'vitest'
import { drawsLikeVegaLite, caseName } from './vl-composition-render.js'

const rows = Array.from({ length: 12 }, (_, i) => ({ a: 'ABCD'[i % 4], g: 'pq'[i % 2], h: 'uvw'[i % 3], b: (i * 7) % 11 + 1, c: (i * 5) % 9 + 2 }))
const data = { values: rows }
const q = (field: string) => ({ field, type: 'quantitative' })
const n = (field: string) => ({ field, type: 'nominal' })

const CHANNELS: Array<[string, string, Record<string, unknown>]> = [
  ['color nominal', 'point', { color: n('a') }],
  ['color quantitative', 'point', { color: q('c') }],
  ['fill', 'point', { fill: n('a') }],
  ['stroke', 'point', { stroke: q('c') }],
  ['size', 'point', { size: q('c') }],
  ['shape', 'point', { shape: n('a') }],
  ['opacity', 'point', { opacity: q('c') }],
  ['strokeDash', 'line', { strokeDash: n('a') }],
  ['strokeWidth', 'line', { strokeWidth: q('c'), detail: n('a') }],
  ['color and size', 'point', { color: n('a'), size: q('c') }],
]
const RESOLVES: Array<[string, (ch: string[]) => Record<string, unknown>]> = [
  ['scale independent', (chs) => ({ scale: Object.fromEntries(chs.map((c) => [c, 'independent'])) })],
  ['legend independent', (chs) => ({ legend: Object.fromEntries(chs.map((c) => [c, 'independent'])) })],
  ['scale and legend independent', (chs) => ({ scale: Object.fromEntries(chs.map((c) => [c, 'independent'])), legend: Object.fromEntries(chs.map((c) => [c, 'independent'])) })],
  ['scale independent, legend shared', (chs) => ({ scale: Object.fromEntries(chs.map((c) => [c, 'independent'])), legend: Object.fromEntries(chs.map((c) => [c, 'shared'])) })],
  ['first independent, x too', (chs) => ({ scale: { [chs[0]!]: 'independent', x: 'independent' } })],
]
const unitOf = (mark: string, enc: Record<string, unknown>) => ({ mark, encoding: { x: q('b'), y: q('c'), ...enc } })
const FORMS: Array<[string, (mark: string, enc: Record<string, unknown>, resolve: Record<string, unknown>) => Record<string, unknown> | undefined]> = [
  ['facet column', (m, e, r) => ({ data, facet: { column: n('g') }, spec: unitOf(m, e), resolve: r })],
  ['facet row', (m, e, r) => ({ data, facet: { row: n('g') }, spec: unitOf(m, e), resolve: r })],
  ['facet row and column', (m, e, r) => ({ data, facet: { row: n('g'), column: n('h') }, spec: unitOf(m, e), resolve: r })],
  // (an independent x in a wrapped facet is another refusal of the compiler's, not this test's subject: the wrapped form takes the other resolutions)
  ['wrapped facet', (m, e, r) => ((r.scale as Record<string, unknown> | undefined)?.x ? undefined : { data, facet: n('h'), columns: 2, spec: unitOf(m, e), resolve: r })],
  ['encoding row', (m, e, r) => ({ data, ...unitOf(m, { ...e, row: n('g') }), resolve: r })],
  ['encoding column', (m, e, r) => ({ data, ...unitOf(m, { ...e, column: n('g') }), resolve: r })],
  ['facet of layers', (m, e, r) => ({ data, facet: { column: n('g') }, spec: { layer: [unitOf(m, e), { mark: 'rule', encoding: { y: { aggregate: 'mean', field: 'c' } } }] }, resolve: r })],
]

const cases: Array<[string, Record<string, unknown>]> = []
for (const [chName, mark, enc] of CHANNELS) {
  const chs = Object.keys(enc).filter((k) => k !== 'detail')
  for (const [rName, resolve] of RESOLVES) {
    for (const [fName, make] of FORMS) {
      const spec = make(mark, enc, resolve(chs))
      if (spec !== undefined) cases.push([caseName(fName, chName, rName), spec])
    }
  }
}

describe('a facet resolves the scales and legends of its other channels as vega-lite does', () => {
  for (const [name, spec] of cases) it(name, () => drawsLikeVegaLite(spec), 30_000)
})
