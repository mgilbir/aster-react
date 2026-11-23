// @vitest-environment node
/**
 * `datasetsOfScene(scene)` and the scene's runtime `data()` are the rows each dataset ended with in the evaluation that made `scene`
 * (its TSDoc, docs/API.md): history, not the chart's rows now. So neither a later evaluation that appends in place (the engine's
 * O(appended) fast paths) nor one that is rejected (a limit, after the fast path ran) may change what an earlier scene reports.
 *
 * The oracle is a fresh evaluation of the same input: what the scene reported when it was made must equal what a fresh chart makes
 * of that input, before and after the later evaluations, over every transform whose append path updates its rows in place.
 */
import { describe, expect, it } from 'vitest'
import { createChartSession } from './session.js'
import { createChartStream } from './stream.js'
import { compileChart } from './compiler.js'
import { evaluateChart } from './evaluate.js'
import { datasetsOfScene } from './runtime.js'
import './addon-transforms.js'
import type { SceneRoot, VgSpec } from './types.js'

type Row = Record<string, unknown>

/** Pipelines whose last step has an append fast path, each over the source `table` (`x`, `g`). */
const PIPELINES: Record<string, unknown[]> = {
  formula: [{ type: 'formula', as: 'y', expr: 'datum.x * 2' }],
  filter: [{ type: 'filter', expr: 'datum.x % 2 === 0' }],
  fold: [{ type: 'fold', fields: ['x', 'g'] }],
  joinaggregate: [{ type: 'joinaggregate', groupby: ['g'], ops: ['sum'], fields: ['x'], as: ['s'] }],
  identifier: [{ type: 'identifier', as: 'id' }],
  aggregate: [{ type: 'aggregate', groupby: ['x'], ops: ['sum'], fields: ['g'], as: ['s'] }],
  'formula then filter': [{ type: 'formula', as: 'y', expr: 'datum.x + 1' }, { type: 'filter', expr: 'datum.y > 2' }],
  none: [],
}

const specOf = (pipeline: unknown[]): VgSpec => ({
  width: 100, height: 100,
  data: [{ name: 'table', values: [] }, { name: 'out', source: 'table', transform: pipeline }],
  marks: [{ type: 'symbol', from: { data: 'out' }, encode: { update: { x: { value: 1 }, y: { value: 1 } } } }],
} as unknown as VgSpec)

const rowsOf = (n: number, from = 0): Row[] => Array.from({ length: n }, (_, i) => ({ x: from + i, g: (from + i) % 3 }))

const strip = (rows: readonly unknown[] | null | undefined): unknown => JSON.parse(JSON.stringify(rows ?? null))

/** What a scene reports of its datasets and its runtime's data, as plain JSON. */
function reported(scene: SceneRoot): { out: unknown; data: unknown; n: unknown } {
  // (what a signal handler bound to the scene computes: `length(data('out'))` through the scene's own expression runtime)
  const runtime = (scene as unknown as { runtime: { data(name: string): unknown[]; expr(src: string): (datum: unknown, signals: unknown) => unknown } }).runtime
  return { out: strip(datasetsOfScene(scene).get('out')), data: strip(runtime.data('out')), n: runtime.expr("length(data('out'))")({}, {}) }
}

function fresh(spec: VgSpec, rows: Row[]): { out: unknown; data: unknown; n: unknown } {
  return reported(evaluateChart(compileChart(structuredClone(spec)), { data: { table: rows } }))
}

describe('an earlier scene keeps reporting its own rows (datasetsOfScene, runtime data)', () => {
  for (const [name, pipeline] of Object.entries(PIPELINES)) {
    const spec = specOf(pipeline)

    it(`${name}: a session, after an accepted append and after a rejected one`, () => {
      const session = createChartSession()
      const first = rowsOf(3)
      const scene1 = session.evaluate(spec, { data: { table: first } })
      const want1 = fresh(spec, first)
      expect(reported(scene1)).toEqual(want1)
      // accepted: an append (the session's diff makes it an append-only pulse)
      const second = [...first, ...rowsOf(4, 3)]
      const scene2 = session.evaluate(spec, { data: { table: second } })
      expect(reported(scene2)).toEqual(fresh(spec, second))
      expect(reported(scene1), 'the first scene, after a later append').toEqual(want1)
      // rejected: an append past maxItems (one item per output row: the most the second input makes), after the fast path ran
      const third = [...second, ...rowsOf(30, 7)]
      const maxItems = (fresh(spec, second).out as unknown[]).length
      expect(() => session.evaluate(spec, { data: { table: third }, limits: { maxItems } })).toThrow(/maxItems/)
      expect(reported(scene2), 'the last good scene, after a rejected append').toEqual(fresh(spec, second))
      expect(reported(scene1)).toEqual(want1)
      // the cached scene handed out again still reports its own rows
      const again = session.evaluate(spec, { data: { table: second } })
      expect(reported(again)).toEqual(fresh(spec, second))
    })

    it(`${name}: a stream, through a rejected flush and its discard`, () => {
      // (one item per output row: what six rows make is accepted, what thirty make is not)
      const maxItems = (fresh(spec, rowsOf(6)).out as unknown[]).length
      const stream = createChartStream(spec, { initial: { data: { table: rowsOf(3) }, limits: { maxItems } } })
      stream.flush()
      const good = stream.scene()!
      const want = fresh(spec, rowsOf(3))
      expect(reported(good)).toEqual(want)
      stream.push({ append: { table: rowsOf(27, 3) } })
      expect(() => stream.flush()).toThrow(/maxItems/)
      expect(reported(stream.scene()!), 'the last good scene, after a rejected flush').toEqual(want)
      stream.discard()
      expect(reported(stream.scene()!), 'and after the discard').toEqual(want)
      // the stream goes on from its committed rows, and each scene keeps its own as more are appended
      stream.push({ append: { table: rowsOf(2, 3) } })
      stream.flush()
      const five = stream.scene()!
      expect(reported(five)).toEqual(fresh(spec, rowsOf(5)))
      stream.push({ append: { table: rowsOf(1, 5) } })
      stream.flush()
      expect(reported(stream.scene()!)).toEqual(fresh(spec, rowsOf(6)))
      expect(reported(five), 'a scene, after the next accepted flush').toEqual(fresh(spec, rowsOf(5)))
      expect(reported(good)).toEqual(want)
    })
  }
})
