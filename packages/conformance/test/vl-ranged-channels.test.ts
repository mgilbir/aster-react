// @vitest-environment node
/**
 * A ranged position (x and x2, y and y2) against vega-lite 6.4.3 over bins, pre-binned data, aggregates, datums and constants, in every
 * mark that can be ranged and in layers: the compiled scales (a domain is the union of the two channels' own, each made as its channel
 * is: a bin spans its signal, pre-binned data starts at the field and ends at the second channel, a time unit its band), the scales as
 * they run, the axes, the rows and the SVG (vl-ranged-compare.ts).
 */
import { describe, it, expect } from 'vitest'
import { TIME_DATA } from './vl-time-helpers.js'
import { collect } from './vl-ranged-compare.js'

type Obj = Record<string, unknown>
const DATA = TIME_DATA.map((r, i) => ({ ...r, w: (r.v as number) * 2 + (i % 4), k2: i % 4 }))

/** The first channel: a measure, aggregated or not, binned in each way, pre-binned, a datum. */
const FIRST: Array<[string, Obj]> = [
  ['v', { field: 'v', type: 'quantitative' }],
  ['sum v', { field: 'v', type: 'quantitative', aggregate: 'sum' }],
  ['mean v', { field: 'v', type: 'quantitative', aggregate: 'mean' }],
  ['v, bin', { field: 'v', type: 'quantitative', bin: true }],
  ['v, bin maxbins 3', { field: 'v', type: 'quantitative', bin: { maxbins: 3 } }],
  ['v, pre-binned', { field: 'v', type: 'quantitative', bin: 'binned' }],
]
/** The second channel: a field of the same kind, the same field, an aggregate of it, a datum, a constant. */
const SECOND: Array<[string, Obj]> = [
  ['w', { field: 'w' }],
  ['sum w', { field: 'w', aggregate: 'sum' }],
  ['v', { field: 'v' }],
  ['sum v', { field: 'v', aggregate: 'sum' }],
  ['datum', { datum: 9 }],
  ['value', { value: 40 }],
]
const sensible = (n1: string, n2: string): boolean => {
  const aggregated = /sum|mean/.test(n1)
  // an aggregate ranges against an aggregate (or a constant); a pre-binned start against the field that is where its bins end
  if (aggregated !== /sum/.test(n2) && n2 !== 'datum' && n2 !== 'value' && !n1.includes('pre-binned')) return false
  if (n1.includes('pre-binned')) return n2 === 'w' || n2 === 'sum w'
  return true
}

const MARKS = ['bar', 'rect', 'rule', 'area', 'tick', 'line', 'point']
const rank = (axis: 'x' | 'y', a: Obj, b: Obj, mark: string): Obj => {
  const other = axis === 'x' ? 'y' : 'x'
  return { data: { values: DATA }, mark, encoding: { [axis]: a, [`${axis}2`]: b, [other]: { field: 'k', type: 'nominal' } } }
}

describe('a ranged position has the scale, the axes and the marks vega-lite gives it', () => {
  for (const mark of MARKS) {
    for (const axis of ['x', 'y'] as const) {
      it(`${mark}, ${axis} and ${axis}2: bins, pre-binned data, aggregates, datums and constants`, async () => {
        const cases: Array<[string, Obj]> = []
        for (const [n1, d1] of FIRST) for (const [n2, d2] of SECOND) if (sensible(n1, n2)) cases.push([`${n1} + ${n2}`, rank(axis, d1, d2, mark)])
        const bad = await collect(cases)
        expect(bad.slice(0, 8), `${bad.length} of ${cases.length} differ`).toEqual([])
      }, 240_000)
    }
  }
})

/** A bar ranged on x, and a bar stacked on x: layers share the scale, so the stack's data and the range's both reach its domain. */
describe('a ranged bar layered with a stacked bar', () => {
  const K = { field: 'k', type: 'ordinal' }
  const RANGED: Array<[string, Obj]> = [
    ['v, w', { x: { field: 'v', type: 'quantitative' }, x2: { field: 'w' }, y: K }],
    ['v, k (the field the other layer stacks by)', { x: { field: 'v', type: 'quantitative' }, x2: { field: 'k' }, y: K }],
    ['sum v, sum w', { x: { field: 'v', type: 'quantitative', aggregate: 'sum' }, x2: { field: 'w', aggregate: 'sum' }, y: K }],
    ['v, datum', { x: { field: 'v', type: 'quantitative' }, x2: { datum: 20 }, y: K }],
    ['v, value', { x: { field: 'v', type: 'quantitative' }, x2: { value: 100 }, y: K }],
    ['bin v, w', { x: { field: 'v', type: 'quantitative', bin: true }, x2: { field: 'w' }, y: K }],
    ['pre-binned v, w', { x: { field: 'v', type: 'quantitative', bin: 'binned' }, x2: { field: 'w' }, y: K }],
  ]
  const PLAIN: Array<[string, Obj]> = [
    ['v', { x: { field: 'v', type: 'quantitative' }, y: K }],
    ['k (the same field on both axes)', { x: { field: 'k', type: 'quantitative' }, y: K }],
    ['v by a colour', { x: { field: 'v', type: 'quantitative' }, y: K, color: { field: 'c', type: 'nominal' } }],
    ['sum w by a colour', { x: { field: 'w', type: 'quantitative', aggregate: 'sum' }, y: K, color: { field: 'c', type: 'nominal' } }],
    ['count by a colour', { x: { aggregate: 'count', type: 'quantitative' }, y: K, color: { field: 'c', type: 'nominal' } }],
    ['sum w, normalized', { x: { field: 'w', type: 'quantitative', aggregate: 'sum', stack: 'normalize' }, y: K, color: { field: 'c', type: 'nominal' } }],
    ['sum w, centred', { x: { field: 'w', type: 'quantitative', aggregate: 'sum', stack: 'center' }, y: K, color: { field: 'c', type: 'nominal' } }],
    ['sum w, not stacked', { x: { field: 'w', type: 'quantitative', aggregate: 'sum', stack: false }, y: K, color: { field: 'c', type: 'nominal' } }],
  ]
  const withColour = DATA.map((r, i) => ({ ...r, c: i % 2 ? 'p' : 'q' }))

  for (const [rn, ranged] of RANGED) {
    it(`${rn}, layered with each stacked bar, in both orders`, async () => {
      const cases: Array<[string, Obj]> = []
      for (const [pn, plain] of PLAIN) {
        const a = { mark: 'bar', encoding: ranged }
        const b = { mark: 'bar', encoding: plain }
        cases.push([`${pn}, after`, { data: { values: withColour }, layer: [a, b] }])
        cases.push([`${pn}, before`, { data: { values: withColour }, layer: [b, a] }])
      }
      const bad = await collect(cases)
      expect(bad.slice(0, 8), `${bad.length} of ${cases.length} differ`).toEqual([])
    }, 240_000)
  }
})
