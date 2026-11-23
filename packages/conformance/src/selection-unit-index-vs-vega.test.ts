/**
 * vega-selections tests an `intersect` per unit only over a store vega indexes by unit, which it does when some expression of the
 * spec names the store in a selection function with the literal last argument `'intersect'` (`selectionVisitor`); over a store
 * it does not index, every tuple must match (C420). Aster combined per unit always. And the units are read from the store as it
 * is (C419: a store rewritten in place was read as a cache remembered it). The same specs go to vega and Aster: the rows a
 * formula marks must agree.
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { compileChart, evaluateChart, datasetsOfScene } from '@aster-charts/core'

type Spec = Record<string, unknown>
const STORE = [
  { unit: 'u1', fields: [{ field: 'x', type: 'E' }], values: [1] },
  { unit: 'u1', fields: [{ field: 'x', type: 'E' }], values: [2] },
  { unit: 'u2', fields: [{ field: 'x', type: 'E' }], values: [1] },
]
const ROWS = [{ x: 1 }, { x: 2 }, { x: 3 }]
const spec = (expr: string, elsewhere?: string, store = STORE): Spec => ({
  signals: [{ name: 'op', value: 'intersect' }],
  data: [
    { name: 's_store', values: store },
    // (another expression of the spec that names the store, read before the one tested: in the other order vega's own unit index
    // is not ready when the tested formula runs, and vega fails, `reading 'count'`)
    ...(elsewhere ? [{ name: 'u', values: ROWS, transform: [{ type: 'formula', as: 'o', expr: elsewhere }] }] : []),
    { name: 't', values: ROWS, transform: [{ type: 'formula', as: 'in', expr }] },
  ],
  marks: [{ type: 'rect', from: { data: 't' } }, ...(elsewhere ? [{ type: 'rect', from: { data: 'u' } }] : [])],
})

async function vegaIn(s: Spec): Promise<unknown[]> {
  const view = new vega.View(vega.parse(structuredClone(s) as never), { renderer: 'none' })
  try { await view.runAsync(); return view.data('t').map((r: Record<string, unknown>) => r.in) } finally { view.finalize() }
}
const asterIn = (s: Spec): unknown[] => ((datasetsOfScene(evaluateChart(compileChart(structuredClone(s) as never))) as Map<string, Array<Record<string, unknown>>>).get('t') ?? []).map((r) => r.in)

const CASES: Array<[string, Spec]> = [
  ['a literal intersect: indexed, per unit', spec("vlSelectionTest('s_store', datum, 'intersect')")],
  ['the op from a signal, no literal anywhere: every tuple', spec("vlSelectionTest('s_store', datum, op)")],
  ['the op from a signal, a literal elsewhere: indexed', spec("vlSelectionTest('s_store', datum, op)", "vlSelectionTest('s_store', datum, 'intersect')")],
  ['union', spec("vlSelectionTest('s_store', datum, 'union')")],
  ['union from a signal', spec("vlSelectionTest('s_store', datum, op == 'intersect' ? 'union' : op)")],
  ['a single unit, op from a signal', spec("vlSelectionTest('s_store', datum, op)", undefined, STORE.filter((t) => t.unit === 'u1'))],
]

describe('selection tests over stores indexed by unit or not, as vega (C420)', () => {
  for (const [label, s] of CASES) it(label, async () => expect(asterIn(s)).toEqual(await vegaIn(s)))
})
