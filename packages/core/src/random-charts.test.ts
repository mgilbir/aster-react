// @vitest-environment node
/** One injected random source shared by several charts: each chart is a dataflow of its own that draws on from where the source stands. */
import { describe, expect, it } from 'vitest'
import { compileChart } from './compiler.js'
import { evaluateChart } from './evaluate.js'
import { datasetsOfScene } from './runtime.js'
import './addon-transforms.js'
import type { SceneRoot, VgSpec } from './types.js'

function rng(seed: number): () => number {
  let a = seed | 0
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

describe('one injected random source shared by several charts (C124)', () => {
  const specNamed = (expr: string): VgSpec => ({
    width: 10, height: 10,
    data: [{ name: 'table', values: [{ a: 1 }, { a: 2 }, { a: 3 }], transform: [{ type: 'formula', as: 'r', expr }] }],
  } as unknown as VgSpec)
  const drawn = (s: SceneRoot): number[] => (datasetsOfScene(s).get('table') as Array<{ r: number }>).map((d) => d.r)
  it('each chart draws on from where the source stands; a chart evaluated again replays its own numbers', () => {
    const seq = rng(124)
    const reference = rng(124)
    const expected = Array.from({ length: 6 }, () => reference())
    const random = (): number => seq()
    const a = compileChart(specNamed('random()'))
    const b = compileChart(specNamed('random() + 0'))
    const sa = evaluateChart(a, { random })
    const sb = evaluateChart(b, { random })
    expect(drawn(sa)).toEqual(expected.slice(0, 3))
    expect(drawn(sb)).toEqual(expected.slice(3, 6))
    // other charts with a dataset of the same name do not evict A's own tape
    for (let i = 0; i < 6; i++) evaluateChart(compileChart(specNamed(`random() * ${i + 2}`)), { random })
    expect(drawn(evaluateChart(a, { random }))).toEqual(expected.slice(0, 3))
  })
})

