/**
 * LIVE differential for the random source: the pinned real Vega (`setRandom(seeded)`) and Aster (`RuntimeInput.random` = the same
 * seeded stream) render the same spec in this process, and the two SVGs must be equal. The numbers are written into text marks, so
 * the draws themselves are compared: same values, in the same ORDER and COUNT, for
 *
 *   - expression `random()`, `sampleNormal` / `sampleLogNormal` / `sampleUniform` (including the Box-Muller pair a call leaves
 *     for the next one, which must not leak from one view to the next),
 *   - the `sample` transform's reservoir and the bootstrap `ci0` / `ci1` of `aggregate` / `joinaggregate`,
 *   - a signal and several datasets drawing in one view,
 *   - a pipeline the evaluator runs more than once to a fixed point (the stream is consumed once, as vega's single run does),
 *   - Vega-Lite specs (`calculate: random()`, an errorbar whose rule and ticks read one bootstrap) through both compilers.
 *
 * With equal streams, any difference is a real divergence. A different seed must change the numbers on both sides (the harness
 * is not comparing constants).
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import * as vl from 'vega-lite'
import { renderSpec, renderSceneToSvg } from '@aster/core'
import { createChartSession } from '@aster/core/dom'
import '@aster/core/transforms'
import { compile as compileAster } from '@aster/vl'
import { canonicalizeSvg, diffCanonical } from '../src/normalize.js'
import { seededRandom, withOracleRandom } from '../src/gallery/seeded.js'

type Spec = Record<string, unknown>
const clone = <T,>(v: T): T => structuredClone(v)

async function vegaSvg(spec: Spec, seed: number): Promise<string> {
  return withOracleRandom(async () => {
    const view = new vega.View(vega.parse(clone(spec) as never), { renderer: 'none' })
    try {
      await view.runAsync()
      return await view.toSVG()
    } finally {
      view.finalize()
    }
  }, seed)
}
const asterSvg = (spec: Spec, seed: number): string => renderSpec(clone(spec) as never, { random: seededRandom(seed) })

async function expectSame(vg: Spec, asterSpec: Spec = vg, seed = 7): Promise<string> {
  const oracle = canonicalizeSvg(await vegaSvg(vg, seed))
  const svg = asterSvg(asterSpec, seed)
  expect(diffCanonical(oracle, canonicalizeSvg(svg))).toEqual([])
  return svg
}

/** Text marks listing field `f` of dataset `d`, one per row. */
const texts = (d: string, f: string, y0 = 0): Spec => ({
  type: 'text', from: { data: d },
  encode: { update: { text: { field: f }, x: { value: 5 }, y: { signal: `${y0} + 12 * datum.i` } } },
})
const rowsOf = (n: number): Spec[] => Array.from({ length: n }, (_, i) => ({ i, g: `g${i % 3}`, v: (i * 7) % 11 }))
const base = (data: Spec[], marks: Spec[], extra: Spec = {}): Spec => ({ width: 200, height: 300, padding: 5, data, marks, ...extra })
const formula = (expr: string, as = 'r'): Spec => ({ type: 'formula', expr, as })

describe('seeded random source, Aster vs Vega (same stream, same order and count)', () => {
  it('expression random() draws one number per row, in row order', async () => {
    await expectSame(base([{ name: 't', values: rowsOf(6), transform: [formula('random()')] }], [texts('t', 'r')]))
  })

  it('sampleNormal pairs, an odd number of calls per dataset, across datasets and across views', async () => {
    const spec = base([
      { name: 'a', values: rowsOf(3), transform: [formula('sampleNormal(2, 3)')] },
      { name: 'b', values: rowsOf(4), transform: [formula('sampleNormal()')] },
    ], [texts('a', 'r'), texts('b', 'r', 60)])
    const first = await expectSame(spec)
    // the pair the first view left over must not reach the second: it replays the same numbers
    expect(await expectSame(spec)).toBe(first)
  })

  it('sampleLogNormal and sampleUniform', async () => {
    await expectSame(base([
      { name: 't', values: rowsOf(4), transform: [formula('sampleLogNormal(0.5, 0.25)', 'l'), formula('sampleUniform(10, 20)', 'u'), formula('sampleUniform(5)', 'u5'), formula('datum.l + "|" + datum.u + "|" + datum.u5', 's')] },
    ], [texts('t', 's')]))
  })

  it('the sample transform: reservoir replacement past the size', async () => {
    await expectSame(base([{ name: 't', values: rowsOf(40), transform: [{ type: 'sample', size: 5 }] }], [texts('t', 'i')]))
  })

  it('bootstrap ci0 / ci1 over several groups, aggregate and joinaggregate', async () => {
    const values = Array.from({ length: 60 }, (_, i) => ({ i, g: `g${i % 3}`, v: (i * 13) % 17 }))
    const agg = { type: 'aggregate', groupby: ['g'], ops: ['ci0', 'ci1', 'mean'], fields: ['v', 'v', 'v'], as: ['lo', 'hi', 'm'] }
    const join = { type: 'joinaggregate', groupby: ['g'], ops: ['ci0', 'ci1'], fields: ['v', 'v'], as: ['lo', 'hi'] }
    await expectSame(base([
      { name: 'agg', values, transform: [agg, formula('datum.lo + " " + datum.hi + " " + datum.m', 's'), { type: 'window', ops: ['row_number'], as: ['i'] }, { type: 'formula', expr: 'datum.i - 1', as: 'i' }] },
      { name: 'join', values, transform: [join, { type: 'filter', expr: 'datum.i < 4' }, formula('datum.lo + " " + datum.hi', 's')] },
    ], [texts('agg', 's'), texts('join', 's', 60)]))
  })

  it('a signal and several datasets share one stream in vega\'s order', async () => {
    await expectSame(base([
      { name: 'a', values: rowsOf(3), transform: [formula('random()')] },
      { name: 'b', values: rowsOf(3), transform: [formula('random()')] },
    ], [texts('a', 'r'), texts('b', 'r', 50)], { signals: [{ name: 'sig', update: 'random()' }] }))
  })

  it('a pipeline the evaluator runs again (a dataset that reads a scale) still consumes the stream once', async () => {
    const spec = base([
      { name: 'a', values: rowsOf(4), transform: [formula('random()')] },
      { name: 'b', values: rowsOf(3), transform: [formula('random()'), formula("datum.r + '|' + round(scale('x', 0.5))", 's')] },
    ], [texts('a', 'r'), texts('b', 's', 60)], {
      scales: [{ name: 'x', type: 'linear', domain: { data: 'a', field: 'r' }, range: [0, 100] }],
    })
    await expectSame(spec)
  })

  it('a signal that changes redraws the dataset it feeds from the stream on; a resize or an unrelated signal does not', async () => {
    const spec = base(
      [{ name: 't', values: rowsOf(4), transform: [formula('random() + 0 * s')] }],
      [texts('t', 'r')],
      { signals: [{ name: 's', value: 1 }, { name: 'other', value: 0 }] },
    )
    const canon = (svg: string) => canonicalizeSvg(svg)
    // vega: first run, the signal changes (the dataset runs again), the view is resized (nothing runs again), another signal changes
    const oracle = await withOracleRandom(async () => {
      const view = new vega.View(vega.parse(clone(spec) as never), { renderer: 'none' })
      try {
        await view.runAsync()
        const out = [await view.toSVG()]
        await view.signal('s', 2).runAsync()
        out.push(await view.toSVG())
        await view.width(240).runAsync()
        out.push(await view.toSVG())
        await view.signal('other', 5).runAsync()
        out.push(await view.toSVG())
        return out
      } finally { view.finalize() }
    }, 7)
    // aster: one session, one stream, the same four evaluations
    const session = createChartSession()
    const random = seededRandom(7)
    const svgOf = (input: Record<string, unknown>): string => renderSceneToSvg(session.evaluate(clone(spec) as never, { random, ...input }))
    const ours = [svgOf({}), svgOf({ signals: { s: 2 } }), svgOf({ signals: { s: 2 }, width: 240 }), svgOf({ signals: { s: 2, other: 5 }, width: 240 })]
    for (let i = 0; i < 4; i++) expect(diffCanonical(canon(oracle[i]!), canon(ours[i]!)), `evaluation ${i}`).toEqual([])
    // (the test sees draws at all: the signal's redraw is other numbers, the rest are the same ones)
    expect(canon(oracle[0]!)).not.toEqual(canon(oracle[1]!))
    expect(canon(oracle[1]!).records.length).toBeGreaterThan(0)
  })

  it('a different seed gives different numbers on both sides', async () => {
    const spec = base([{ name: 't', values: rowsOf(3), transform: [formula('random()')] }], [texts('t', 'r')])
    const a = await vegaSvg(spec, 1)
    const b = await vegaSvg(spec, 2)
    expect(a).not.toBe(b)
    expect(asterSvg(spec, 1)).not.toBe(asterSvg(spec, 2))
    expect(canonicalizeSvg(a)).toEqual(canonicalizeSvg(asterSvg(spec, 1)))
  })

  describe('Vega-Lite through both compilers', () => {
    const through = async (vlSpec: Spec): Promise<void> => {
      await expectSame(vl.compile(clone(vlSpec) as never).spec as unknown as Spec, compileAster(clone(vlSpec) as never) as Spec)
    }
    const cars = Array.from({ length: 300 }, (_, i) => ({ Year: `19${70 + (i % 6)}-01-01`, mpg: 10 + ((i * 7) % 23), Cylinders: [4, 6, 8][i % 3] }))

    it('calculate: random() as an offset', async () => {
      await through({
        data: { values: cars }, transform: [{ calculate: 'random()', as: 'r' }], height: { step: 50 }, mark: 'point',
        encoding: { x: { field: 'mpg', type: 'quantitative' }, y: { field: 'Cylinders', type: 'ordinal' }, yOffset: { field: 'r', type: 'quantitative' } },
      })
    })

    it('an errorbar with ticks: the rule and both ticks read ONE bootstrap', async () => {
      await through({
        data: { values: cars }, mark: { type: 'errorbar', extent: 'ci', ticks: true },
        encoding: { y: { field: 'mpg', type: 'quantitative', scale: { zero: false } }, x: { timeUnit: 'year', field: 'Year' } },
      })
    })

    it('a layered errorband and line sharing a time unit of the layer', async () => {
      await through({
        data: { values: cars }, encoding: { x: { field: 'Year', timeUnit: 'year' } },
        layer: [
          { mark: { type: 'errorband', extent: 'ci' }, encoding: { y: { field: 'mpg', type: 'quantitative' } } },
          { mark: 'line', encoding: { y: { aggregate: 'mean', field: 'mpg' } } },
        ],
      })
    })

    it('a sample', async () => {
      await through({ data: { values: cars }, transform: [{ sample: 8 }], mark: 'point', encoding: { x: { field: 'mpg', type: 'quantitative' }, y: { field: 'Cylinders', type: 'ordinal' } } })
    })
  })
})
