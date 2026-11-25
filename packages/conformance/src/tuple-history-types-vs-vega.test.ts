/**
 * What vega's tuples carry from one run to the next (C68), for every transform type vega runs as a step that keeps its tuples and writes
 * onto them: a pipeline whose `score` reads the field `X` the step writes after it, at the top level and in a dataset derived by
 * `source` (whose own source may modify fields of its own), driven by signal writes (`view.signal` in vega, a session in Aster: what
 * an event handler does). After every write, every dataset's rows (their fields, in order) must be vega's.
 *
 * The rule each step follows is read from vega's dataflow (tuple-history.ts): a formula, bin, timeunit, window, joinaggregate or lookup
 * runs again when a field it reads was modified before it; a stack, pie, dotbin, linkpath, voronoi, collect or extent whenever anything
 * before it ran; an identifier or an `initonly` formula never. A derived dataset gets new tuples from vega's Relay, which copies every
 * field of a modified source tuple onto them.
 *
 * `filter` is the case not followed (ARCHITECTURE.md, deviations): after a filter, vega's later steps visit the tuples the filter let in
 * as added ones, and the dataset lists them after the ones it kept. The last test holds that it still differs, so the row stays true.
 *
 *   ASTER_HISTORY_TYPE_SEEDS=60   (default 16)
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { datasetsOfScene } from '@aster-charts/core'
import { createChartSession } from '@aster-charts/core/dom'
import '@aster-charts/core/transforms'

type Spec = Record<string, unknown>
type Rnd = () => number
function mulberry32(seed: number): Rnd {
  let a = seed | 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const score = (x: string): Spec => ({ type: 'formula', as: 'score', expr: `s + (datum.${x} == null ? datum.v : datum.${x})` })
const TYPES: Record<string, Spec[]> = {
  formula: [score('X'), { type: 'formula', as: 'X', expr: 'datum.score * 0.5 + 1' }],
  'formula initonly': [score('X'), { type: 'formula', as: 'X', expr: 'datum.score * 0.5 + 1', initonly: true }],
  bin: [score('X'), { type: 'bin', field: 'score', extent: [-100, 100], step: 7, as: ['X', 'X1'] }],
  timeunit: [score('X'), { type: 'formula', as: 'd', expr: 'datetime(2020, 0, 1 + datum.score)' }, { type: 'timeunit', field: 'd', units: ['year', 'month'], as: ['X', 'X1'] }],
  window: [score('X'), { type: 'window', sort: { field: 'score', order: 'descending' }, ops: ['row_number'], as: ['X'] }],
  joinaggregate: [score('X'), { type: 'joinaggregate', groupby: ['g'], fields: ['score'], ops: ['min'], as: ['X'] }],
  lookup: [score('X'), { type: 'lookup', from: 'other', key: 'k', fields: ['k'], values: ['w'], as: ['X'] }],
  stack: [score('X'), { type: 'stack', field: 'score', groupby: ['g'], as: ['X', 'X1'] }],
  // (a stack over fields nothing modifies still runs when anything before it ran, and what it writes counts as modified: the formula
  // after it, which reads what it wrote last time, runs again)
  'stack after any change': [score('X'), { type: 'formula', as: 'X', expr: 'datum.score * 0.5' }, { type: 'stack', field: 'v', groupby: ['g'], as: ['Y', 'Y1'] }, { type: 'formula', as: 'Z', expr: '(datum.Z || 0) + datum.Y1' }],
  pie: [score('X'), { type: 'pie', field: 'score', as: ['X', 'X1'] }],
  dotbin: [score('X'), { type: 'dotbin', field: 'score', step: 3, as: 'X' }],
  linkpath: [score('X'), { type: 'linkpath', sourceX: 'score', sourceY: 'v', targetX: 'v', targetY: 'score', as: 'X' }],
  voronoi: [score('X'), { type: 'voronoi', x: 'score', y: 'v', size: [100, 100], as: 'X' }],
  identifier: [score('X'), { type: 'identifier', as: 'X' }],
  collect: [score('X'), { type: 'collect', sort: { field: 'score', order: 'descending' } }, { type: 'formula', as: 'X', expr: 'datum.score + 1' }],
  extent: [score('X'), { type: 'formula', as: 'X', expr: 'datum.score * 0.5' }, { type: 'extent', field: 'X', signal: 'ext' }],
}
const FILTER: Spec[] = [score('X'), { type: 'filter', expr: 'datum.score > c' }, { type: 'formula', as: 'X', expr: 'datum.score - 1' }]

const text = (rows: readonly unknown[] | null | undefined): string => (rows ?? []).map((r) => JSON.stringify(Object.keys(r as object).sort()
  .map((k) => [k, (r as Record<string, unknown>)[k] instanceof Date ? +((r as Record<string, unknown>)[k] as Date) : (r as Record<string, unknown>)[k]]))).join('\n')

/** The first write after which a dataset's rows differ from vega's (null: none), over `seeds` generated cases of `pipe`. */
async function firstDifference(type: string, pipe: Spec[], seeds: number): Promise<{ diffs: string[]; derived: number }> {
  const diffs: string[] = []
  let derivedCases = 0
  for (let seed = 1; seed <= seeds; seed++) {
    const r = mulberry32(seed * 31 + type.length)
    const n = 3 + Math.floor(r() * 5)
    const values = Array.from({ length: n }, (_, i) => ({ k: i, g: i % 2, v: Math.floor(r() * 20) }))
    const derived = r() < 0.5
    if (derived) derivedCases++
    const data: Spec[] = derived
      ? [{ name: 'src', values, transform: r() < 0.5 ? [{ type: 'formula', as: 'u', expr: 'datum.v + s2' }] : [] }, { name: 't', source: 'src', transform: [{ type: 'formula', as: 'v0', expr: 'datum.v' }, ...pipe] }]
      : [{ name: 't', values, transform: [{ type: 'formula', as: 'v0', expr: 'datum.v' }, ...pipe] }]
    data.unshift({ name: 'other', values: values.map((x) => ({ k: x.k, w: x.v * 3 })) })
    const spec = { width: 100, height: 100, signals: [{ name: 's', value: 0 }, { name: 's2', value: 0 }, { name: 'c', value: 5 }], data, marks: [] }
    const view = new vega.View(vega.parse(structuredClone(spec) as never), { renderer: 'none' }) as unknown as { runAsync(): Promise<unknown>; signal(n: string, v: unknown): unknown; data(n: string): unknown[]; finalize(): void }
    const session = createChartSession()
    try {
      await view.runAsync()
      session.evaluate(structuredClone(spec) as never, {})
      const signals: Record<string, number> = {}
      for (let step = 0; step < 6; step++) {
        const which = ['s', 's2', 'c'][Math.floor(r() * 3)]!
        const value = Math.floor(r() * 10)
        view.signal(which, value)
        await view.runAsync()
        signals[which] = value
        const ds = datasetsOfScene(session.evaluate(structuredClone(spec) as never, { signals: { ...signals } }))
        const bad = data.map((d) => String(d.name)).find((name) => text(ds.get(name)) !== text(view.data(name)))
        if (bad !== undefined) { diffs.push(`${type} seed ${seed}${derived ? ' (derived)' : ''} after ${which}=${value}: dataset ${bad}`); break }
      }
    } finally { view.finalize() }
  }
  return { diffs, derived: derivedCases }
}

const SEEDS = Number(process.env.ASTER_HISTORY_TYPE_SEEDS ?? 16)

describe('every tuple-keeping transform type in a pipeline that reads what a later step writes (C68), vs real vega', () => {
  for (const [type, pipe] of Object.entries(TYPES)) {
    it(type, { timeout: 120_000 }, async () => {
      const { diffs, derived } = await firstDifference(type, pipe, SEEDS)
      expect(diffs).toEqual([])
      // (both shapes are driven: top level and derived)
      expect(derived).toBeGreaterThan(0)
      expect(derived).toBeLessThan(SEEDS)
    })
  }

  it('filter is the known difference: it still differs (ARCHITECTURE.md deviations)', { timeout: 120_000 }, async () => {
    const { diffs } = await firstDifference('filter', FILTER, SEEDS)
    expect(diffs.length).toBeGreaterThan(0)
  })
})
