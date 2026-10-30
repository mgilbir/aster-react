// @vitest-environment node
/**
 * An injected random source (`RuntimeInput.random`, the counterpart of vega's `setRandom`) against the real vega drawing from the
 * SAME seeded stream: the datasets of a chart whose pipelines mix transforms that draw (a `random()` formula, `sample`, bootstrap
 * `ci0` / `ci1`, `sampleNormal`, a signal that draws) with ones that do not (`bin`, `filter`, `aggregate`, `collect`), first as
 * vega runs them, and again after the chart is resized -- which vega's dataflow does not rerun, so the numbers must not move.
 *
 * Aster fingerprints a site's inputs only when the site can draw (random-tape.ts `mayDrawRandom`); a site it wrongly left out would
 * consume the stream differently from vega, and show here as a different number in a later dataset.
 */
import { describe, it, expect } from 'vitest'
import * as vega from 'vega'
import '@aster/core/transforms'
import { datasetsOfScene } from '@aster/core'
import { createChartSession } from '@aster/core/dom'
import { seededRandom, withOracleRandom } from '../src/gallery/seeded.js'

const rows = Array.from({ length: 80 }, (_, i) => ({ id: i, g: i % 4, x: (i * 37) % 23, y: ((i * 11) % 17) - 8 }))
const frame = { width: 120, height: 80, padding: 5 }
const BIN = { type: 'bin', field: 'x', extent: [0, 23], step: 4, as: ['b0', 'b1'] }

const CASES: Record<string, any> = {
  'a formula that draws after a bin and a filter': {
    ...frame,
    data: [
      { name: 'a', values: rows, transform: [BIN, { type: 'filter', expr: 'datum.y > -6' }, { type: 'formula', as: 'r', expr: 'random()' }, { type: 'aggregate', groupby: ['b0'], fields: ['r'], ops: ['mean'], as: ['m'] }] },
    ],
  },
  'sample, then a bin and an aggregate that do not draw': {
    ...frame,
    data: [{ name: 'a', values: rows, transform: [{ type: 'sample', size: 20 }, BIN, { type: 'aggregate', groupby: ['b0'], ops: ['count'], as: ['n'] }] }],
  },
  'bootstrap intervals over binned groups': {
    ...frame,
    data: [{ name: 'a', values: rows, transform: [BIN, { type: 'aggregate', groupby: ['b0'], fields: ['y', 'y', 'y'], ops: ['mean', 'ci0', 'ci1'], as: ['m', 'lo', 'hi'] }] }],
  },
  'a joinaggregate bootstrap then a plain filter': {
    ...frame,
    data: [{ name: 'a', values: rows, transform: [{ type: 'joinaggregate', groupby: ['g'], fields: ['y'], ops: ['ci1'], as: ['hi'] }, { type: 'filter', expr: 'datum.x > 5' }, { type: 'collect', sort: { field: 'x' } }] }],
  },
  'sampleNormal on derived rows, read by a second dataset': {
    ...frame,
    data: [
      { name: 'a', values: rows, transform: [BIN, { type: 'formula', as: 'n', expr: 'sampleNormal(0, 1)' }] },
      { name: 'b', source: 'a', transform: [{ type: 'filter', expr: 'datum.n > -1' }, { type: 'formula', as: 'u', expr: 'sampleUniform(0, 1) + datum.n' }] },
    ],
  },
  'a signal that draws, read by a dataset that does not': {
    ...frame,
    signals: [{ name: 'cut', update: 'floor(random() * 20)' }],
    data: [{ name: 'a', values: rows, transform: [BIN, { type: 'filter', expr: 'datum.x > cut' }, { type: 'aggregate', groupby: ['b0'], ops: ['count'], as: ['n'] }] }],
  },
  'two datasets that draw, in between ones that do not': {
    ...frame,
    data: [
      { name: 'a', values: rows, transform: [{ type: 'formula', as: 'r', expr: 'random()' }] },
      { name: 'b', source: 'a', transform: [BIN, { type: 'filter', expr: 'datum.r > 0.3' }, { type: 'collect', sort: { field: 'id' } }] },
      { name: 'c', source: 'b', transform: [{ type: 'formula', as: 's', expr: 'random() + datum.r' }] },
    ],
  },
}

const SEED = 0x5eed
const clean = (v: unknown): unknown => JSON.parse(JSON.stringify(v ?? null))

describe('an injected random source against vega drawing from the same stream', () => {
  for (const [name, spec] of Object.entries(CASES)) {
    it(name, async () => {
      const names = (spec.data as Array<{ name: string }>).map((d) => d.name)
      const oracle = await withOracleRandom(async () => {
        const view = new vega.View(vega.parse(structuredClone(spec)), { renderer: 'none' })
        await view.runAsync()
        const first = Object.fromEntries(names.map((n) => [n, clean(view.data(n))]))
        await view.width(240).height(140).runAsync() // a resize: nothing the datasets read has changed
        const second = Object.fromEntries(names.map((n) => [n, clean(view.data(n))]))
        view.finalize()
        return { first, second }
      }, SEED)
      expect(oracle.second).toEqual(oracle.first)

      const stream = seededRandom(SEED)
      const session = createChartSession()
      const read = (input: Record<string, unknown>): Record<string, unknown> => {
        const scene = session.evaluate(structuredClone(spec), { random: stream, ...input } as never)
        return Object.fromEntries(names.map((n) => [n, clean(datasetsOfScene(scene).get(n))]))
      }
      const first = read({ width: 120, height: 80 })
      expect(first).toEqual(oracle.first)
      expect(read({ width: 240, height: 140 })).toEqual(oracle.first)
    }, 30_000)
  }
})
