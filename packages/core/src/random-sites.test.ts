/**
 * Which code can draw from an injected random source (`mayDrawRandom`), and what the engine does with a site that cannot.
 *
 * An injected source is replayed per site, keyed by a fingerprint of what the site read. Fingerprinting a transform's input rows is
 * the cost of that, and a site that never draws has nothing to replay: `mayDrawRandom` is what lets the engine skip it. It is a
 * reading of the code, so it is checked against what the code does -- every expression function and every transform that draws
 * must be one it names -- and the engine is checked to fingerprint exactly the sites it names.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('./random-tape.js', async (original) => {
  const real = await original<typeof import('./random-tape.js')>()
  return { ...real, contentKey: vi.fn(real.contentKey) }
})

import './addon-transforms.js'
import { compileExpr, expressionFunctionNames, type ExpressionRuntime } from './expression.js'
import { contentKey, mayDrawRandom } from './random-tape.js'
import { applyTransforms, type Row } from './transform.js'
import { compileChart } from './compiler.js'
import { evaluateChart } from './runtime.js'
import { createChartSession } from './session.js'
import { renderSceneToSvg } from './index.js'
import type { VgSpec } from './types.js'

/** The runtime an expression sees, drawing from a source that counts. */
function countingRuntime(): { runtime: ExpressionRuntime; draws: () => number } {
  let draws = 0
  const runtime: ExpressionRuntime = {
    scale: () => undefined, data: () => undefined, expr: (e) => compileExpr(e, runtime),
    random: () => { draws++; return ((draws * 37) % 101) / 101 + 0.001 }, // (never a constant: a rejection sampler would not end)
  }
  return { runtime, draws: () => draws }
}

describe('mayDrawRandom names every expression function that draws', () => {
  const argLists: unknown[][] = [[], [1], [1, 2], [[1, 2, 3]], ['a'], [1, 2, 3]]
  const drawers = new Set<string>()
  for (const name of expressionFunctionNames()) {
    for (const args of argLists) {
      const { runtime, draws } = countingRuntime()
      const code = `${name}(${args.map((a) => JSON.stringify(a)).join(', ')})`
      try { compileExpr(code, runtime)({}, {}) } catch { /* not callable like this: it drew or it did not before it threw */ }
      if (draws() > 0) drawers.add(name)
    }
  }

  it('finds the functions that draw', () => {
    expect([...drawers].sort()).toEqual(['random', 'sampleLogNormal', 'sampleNormal', 'sampleUniform'])
  })
  for (const name of drawers) it(`${name}`, () => expect(mayDrawRandom(`${name}(datum.x)`)).toBe(true))
  it('and not the others', () => {
    for (const name of expressionFunctionNames()) {
      if (!drawers.has(name) && !/sample|random|ci[01]/i.test(name)) expect(mayDrawRandom(`${name}(datum.x)`), name).toBe(false)
    }
  })
})

describe('mayDrawRandom names every transform that draws', () => {
  const rows = (): Row[] => Array.from({ length: 40 }, (_, i) => ({ id: i, g: i % 3, x: (i * 7) % 11, y: i }))
  const drawsOf = (t: Record<string, unknown>): number => {
    const { runtime, draws } = countingRuntime()
    applyTransforms(rows(), [t as never], { runtime, signals: {} })
    return draws()
  }

  const DRAWING: Record<string, Record<string, unknown>> = {
    sample: { type: 'sample', size: 5 },
    'aggregate ci0': { type: 'aggregate', groupby: ['g'], fields: ['x'], ops: ['ci0'], as: ['lo'] },
    'aggregate ci1': { type: 'aggregate', groupby: ['g'], fields: ['x', 'x'], ops: ['mean', 'ci1'], as: ['m', 'hi'] },
    'joinaggregate ci0': { type: 'joinaggregate', groupby: ['g'], fields: ['x'], ops: ['ci0'], as: ['lo'] },
    'window ci1': { type: 'window', sort: { field: 'id' }, frame: [-3, 0], ops: ['ci1'], fields: ['x'], as: ['hi'] },
    'formula random()': { type: 'formula', as: 'r', expr: 'random()' },
    'filter random()': { type: 'filter', expr: 'random() < 2' },
    'formula sampleNormal': { type: 'formula', as: 'r', expr: 'sampleNormal(0, 1) + datum.x' },
  }
  for (const [name, t] of Object.entries(DRAWING)) {
    it(`${name} draws, and is named`, () => {
      expect(drawsOf(t)).toBeGreaterThan(0)
      expect(mayDrawRandom(t)).toBe(true)
    })
  }

  const PURE: Record<string, Record<string, unknown>> = {
    bin: { type: 'bin', field: 'x', extent: [0, 11], maxbins: 5 },
    'aggregate count': { type: 'aggregate', groupby: ['g'], fields: ['x'], ops: ['mean'], as: ['m'] },
    collect: { type: 'collect', sort: { field: 'x' } },
    filter: { type: 'filter', expr: 'datum.x > 3' },
    formula: { type: 'formula', as: 'z', expr: 'datum.x * 2' },
    crossfilter: { type: 'crossfilter', signal: 'xf', fields: ['x'], query: [[1, 5]] },
    stack: { type: 'stack', groupby: ['g'], field: 'x' },
  }
  for (const [name, t] of Object.entries(PURE)) {
    it(`${name} draws nothing, and is not named`, () => {
      expect(drawsOf(t)).toBe(0)
      expect(mayDrawRandom(t)).toBe(false)
    })
  }
})

describe('the engine fingerprints the sites that may draw, and only those', () => {
  const values = Array.from({ length: 50 }, (_, i) => ({ id: i, g: i % 4, x: (i * 7) % 13 }))
  const spec = (transform: unknown[]): VgSpec => ({ width: 60, height: 40, signals: [{ name: 'k', value: 3 }], data: [{ name: 't', values, transform }] } as never)
  const fingerprinted = (transform: unknown[]): number => {
    vi.mocked(contentKey).mockClear()
    evaluateChart(compileChart(spec(transform)), { random: () => 0.25 })
    return vi.mocked(contentKey).mock.calls.length
  }

  it('a pipeline that cannot draw is never fingerprinted', () => {
    expect(fingerprinted([
      { type: 'bin', field: 'x', extent: [0, 13], step: 2, as: ['b0', 'b1'] },
      { type: 'filter', expr: 'datum.x > k' },
      { type: 'aggregate', groupby: ['b0'], ops: ['count'], as: ['n'] },
    ])).toBe(0)
  })
  it('a transform that draws is, with its rows', () => {
    expect(fingerprinted([{ type: 'bin', field: 'x', extent: [0, 13], step: 2, as: ['b0', 'b1'] }, { type: 'formula', as: 'r', expr: 'random()' }])).toBeGreaterThan(0)
    expect(fingerprinted([{ type: 'sample', size: 5 }])).toBeGreaterThan(0)
  })
  it('without a source nothing is fingerprinted at all', () => {
    vi.mocked(contentKey).mockClear()
    evaluateChart(compileChart(spec([{ type: 'formula', as: 'r', expr: 'random()' }])))
    expect(vi.mocked(contentKey)).not.toHaveBeenCalled()
  })

  it('what draws is still drawn once: the same source, a resize, the same numbers', () => {
    const chartSpec = {
      width: 60, height: 40, autosize: 'none',
      data: [
        { name: 't', values, transform: [{ type: 'bin', field: 'x', extent: [0, 13], step: 2, as: ['b0', 'b1'] }, { type: 'formula', as: 'r', expr: 'random()' }] },
        { name: 'u', source: 't', transform: [{ type: 'aggregate', groupby: ['b0'], fields: ['x'], ops: ['ci0'], as: ['lo'] }] },
      ],
    } as never
    let n = 0
    const source = (): number => ((++n * 37) % 101) / 101
    const session = createChartSession()
    const first = renderSceneToSvg(session.evaluate(chartSpec, { random: source, width: 60, height: 40 }))
    const drawn = n
    const second = renderSceneToSvg(session.evaluate(chartSpec, { random: source, width: 90, height: 50 }))
    expect(drawn).toBeGreaterThan(50)
    expect(n).toBe(drawn)
    expect(typeof first + typeof second).toBe('stringstring')
  })
})
