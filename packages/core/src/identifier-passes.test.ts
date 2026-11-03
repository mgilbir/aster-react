/**
 * The passes of ONE evaluation see the same ids for the same rows.
 *
 * A view that fits its viewport builds its content twice (the first pass decides the padding, from the guides it drew; the second is the
 * scene), and the datasets are built again in each. Whatever rule numbers the rows of an `identifier`, the second pass must not number
 * them otherwise than the first: a legend whose entries are the ids (here: the ordinal domain of `id`) is as wide as the first pass's
 * ids make it, and the scene is drawn from the second's.
 *
 * The reference is independent of history: the same chart over rows that already carry the ids the scene drew (an `identifier` keeps a
 * truthy value), with no `identifier` step, evaluated once. Its padding comes from those ids in both passes.
 */
import { describe, it, expect } from 'vitest'
import { compileChart } from './compiler.js'
import { datasetsOfScene } from './runtime.js'
import { evaluateChart } from './evaluate.js'
import { createChartSession } from './session.js'
import { renderSceneToSvg } from './index.js'
import type { RuntimeInput, VgSpec } from './types.js'

type Row = Record<string, unknown>

function mulberry32(seed: number): () => number {
  let a = seed | 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const specOf = (autosize: string, withIds: boolean): VgSpec => ({
  autosize, width: 300, height: 300,
  data: [{ name: 't', transform: withIds ? [{ type: 'identifier', as: 'id' }] : [] }],
  scales: [
    { name: 'x', type: 'linear', domain: { data: 't', field: 'x' }, range: 'width' },
    { name: 'y', type: 'linear', domain: [0, 100], range: 'height' },
    { name: 'c', type: 'ordinal', domain: { data: 't', field: 'id' }, range: 'category' },
  ],
  axes: [{ orient: 'bottom', scale: 'x', title: 'x' }, { orient: 'left', scale: 'y' }],
  legends: [{ fill: 'c', title: 'id' }],
  marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'x' }, y: { value: 40 }, fill: { scale: 'c', field: 'id' } } } }],
} as unknown as VgSpec)

describe('a fit view numbers its rows once per evaluation', () => {
  const rowsOf = (n: number, from = 0): Row[] => Array.from({ length: n }, (_, i) => ({ k: from + i, x: (from + i) % 17 }))
  const change = (r: () => number, rows: Row[], next: { k: number }): Row[] => {
    switch (Math.floor(r() * 7)) {
      case 5: return [...rows].reverse()                                      // a reversal
      case 6: return rowsOf(rows.length, next.k++ * 1000).sort(() => r() - 0.5) // other rows, shuffled
      case 0: return [...rows].sort(() => r() - 0.5)                       // a shuffle
      case 1: return [...rows, ...rowsOf(1 + Math.floor(r() * 3), next.k++ * 100)]
      case 2: return rows.filter(() => r() < 0.8)
      case 3: return rows.map((x) => (r() < 0.3 ? { ...x, x: (x.x as number) + 1 } : x))
      default: return rows.map((x) => ({ ...x }))                           // equal rows, new objects
    }
  }

  // Each (mode, block of seeds) is its own test: far below the timeout under load, and a failure names its block. Every seed of 1..60 runs in
  // every mode, 7 steps each. The two charts are compiled once per mode (a session recompiles only on a changed skeleton, and the
  // reference spec never changes), so a step costs its two evaluations and two renders.
  const SEEDS = 60
  const BLOCK = 10
  for (const autosize of ['fit', 'fit-x', 'fit-y', 'pad']) {
    const reference = compileChart(specOf(autosize, false))
    for (let first = 1; first <= SEEDS; first += BLOCK) {
      it(`${autosize} seeds ${first}-${first + BLOCK - 1}: the legend of the first pass is drawn from the ids of the scene`, () => {
        for (let seed = first; seed < first + BLOCK; seed++) {
          const r = mulberry32(seed * 7919)
          const session = createChartSession()
          const spec = specOf(autosize, true)
          let rows = rowsOf(4 + Math.floor(r() * 12))
          let last: { w: number; h: number } | undefined
          const next = { k: 1 }
          for (let step = 0; step < 7; step++) {
            rows = step === 0 ? rows : change(r, rows, next)
            // half the time the view is the size the last evaluation's content ended at: the first pass then matches the committed
            // fingerprint (and takes the pulse), the second does not
            const input: RuntimeInput = { data: { t: rows }, ...(last && r() < 0.5 ? { width: last.w, height: last.h } : {}) }
            const scene = session.evaluate(spec, input)
            last = { w: scene.plotWidth ?? 0, h: scene.plotHeight ?? 0 }
            const made = (datasetsOfScene(scene).get('t') ?? []) as Row[]
            const want = evaluateChart(reference, { data: { t: made.map((x) => ({ ...x })) }, ...(input.width !== undefined ? { width: input.width, height: input.height } : {}) })
            // compared as the rendered SVG (the legend, the padding and every mark); `expect` only on a difference, as it costs more than the compare
            const got = renderSceneToSvg(scene)
            const ref = renderSceneToSvg(want)
            if (got !== ref) expect(got, `${autosize} seed ${seed} step ${step}`).toBe(ref)
          }
        }
      })
    }
  }
})
