// @vitest-environment node
/**
 * The numbers `identifier` transforms hand out, against real vega, through a sequence of updates. Every `identifier` of a view draws
 * from one counter in the order vega's dataflow runs them: a dataset whose transforms read a scale made from data runs after that
 * scale (vega-parser connects a scale's parameters after the data, so the scale and what reads it are reranked past every dataset),
 * and a row keeps its number for as long as it lives. The engine builds such a dataset once before the scales exist and once after:
 * the numbers the first build drew must not be the rows' (they used to be carried into the second build, so the rows were numbered
 * again on every evaluation, and with numbers another dataset held -- a point picked in one dataset selected a point of the other).
 *
 * Each step changes vega's view (a changeset, a signal) and hands the session the same state; the datasets' `id` columns and the
 * points a selection by id highlights are compared after every step.
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { createChartSession } from '@aster-charts/core/dom'
import { datasetsOfScene, type RuntimeInput, type SceneRoot } from '@aster-charts/core'

type Row = Record<string, unknown>
type Spec = Record<string, any>
interface View {
  runAsync(): Promise<void>
  data(name: string): Row[]
  signal(name: string, v: unknown): View
  change(name: string, cs: unknown): View
  finalize(): void
}

const T = Array.from({ length: 6 }, (_, i) => ({ v: i }))
const B = [{ w: 1 }, { w: 2 }]

/** `a` reads the scale `x` (made from `t`); `b` reads none; the marks of both are filled by a selection of ids (`store`). */
const spec = (domain: unknown, order: 'a-first' | 'b-first'): Spec => {
  const a = { name: 'a', source: 't', transform: [{ type: 'filter', expr: "scale('x', datum.v) > 50" }, { type: 'identifier', as: 'id' }] }
  const b = { name: 'b', values: B, transform: [{ type: 'identifier', as: 'id' }] }
  const fill = [{ test: "vlSelectionIdTest('store', {_vgsid_: datum.id})", value: 'red' }, { value: 'grey' }]
  return {
    width: 100, height: 50, autosize: 'none',
    signals: [{ name: 'u', value: 0 }],
    scales: [{ name: 'x', type: 'linear', domain, range: [0, 100] }],
    data: [{ name: 'store', values: [] }, { name: 't', values: T }, ...(order === 'a-first' ? [a, b] : [b, a])],
    marks: ['a', 'b'].map((name) => ({ type: 'symbol', name: `m${name}`, from: { data: name }, encode: { update: { x: { field: 'id' }, fill } } })),
  }
}

type Step = { what: string; t?: Row[]; b?: Row[]; u?: number; store?: Row[] }

/** The same steps through vega and through the session; the ids of both datasets and the fill of every point after each. */
async function compare(s: Spec, steps: Step[]): Promise<void> {
  const view = new (vega as unknown as { View: new (rt: unknown, o: unknown) => View }).View(vega.parse(structuredClone(s) as never), { renderer: 'none' })
  const session = createChartSession()
  let state = { t: T, b: B, u: 0, store: [] as Row[] }
  const input = (): RuntimeInput => ({ data: { t: state.t, b: state.b, store: state.store }, signals: { u: state.u } })
  const ids = (rows: Row[]): unknown[] => rows.map((r) => r.id)
  const fills = (scene: SceneRoot, name: string): unknown[] => {
    const g = (scene.items as Array<{ name?: string; items?: Array<{ fill?: unknown }> }>).find((m) => m.name === `m${name}`)
    return (g?.items ?? []).map((it) => it.fill)
  }
  try {
    await view.runAsync()
    for (const step of [{ what: 'first' } as Step, ...steps]) {
      if (step.t) { view.change('t', (vega as any).changeset().insert(step.t.slice(state.t.length).map((r) => ({ ...r })))); state = { ...state, t: step.t } }
      if (step.b) { view.change('b', (vega as any).changeset().insert(step.b.slice(state.b.length).map((r) => ({ ...r })))); state = { ...state, b: step.b } }
      if (step.store) { view.change('store', (vega as any).changeset().remove(() => true).insert(step.store.map((r) => ({ ...r })))); state = { ...state, store: step.store } }
      if (step.u !== undefined) { view.signal('u', step.u); state = { ...state, u: step.u } }
      await view.runAsync()
      const scene = session.evaluate(structuredClone(s) as never, input())
      const made = datasetsOfScene(scene)
      for (const name of ['a', 'b']) {
        expect(ids(made.get(name) as Row[]), `${step.what}: ids of ${name}`).toEqual(ids(view.data(name)))
        const want = view.data(name).map((r) => (state.store.some((p) => p._vgsid_ === r.id) ? 'red' : 'grey'))
        expect(fills(scene, name), `${step.what}: the points of ${name} the selection fills`).toEqual(want)
      }
    }
  } finally { view.finalize() }
}

const STEPS: Step[] = [
  { what: 'a signal nothing reads', u: 1 },
  { what: 'a row of b', b: [...B, { w: 3 }] },
  { what: 'a signal nothing reads, again', u: 2 },
  // (a row of `t` inside the scale's domain: `a` gains a row, numbered from where the counter stands)
  { what: 'a row of t', t: [...T, { v: 4.5 }] },
  { what: 'another row of b', b: [...B, { w: 3 }, { w: 4 }] },
  { what: 'a signal nothing reads, at last', u: 3 },
]

describe('identifier numbers, against vega', () => {
  for (const order of ['a-first', 'b-first'] as const) {
    it(`a dataset that reads a scale made from data (${order})`, async () => {
      await compare(spec({ data: 't', field: 'v' }, order), STEPS)
    })
    it(`a dataset that reads a scale of a constant domain is numbered in declaration order (${order})`, async () => {
      await compare(spec([0, 10], order), STEPS)
    })
  }

  it('a point picked in one dataset selects no point of the other, and stays picked through an unrelated signal', async () => {
    // (the ids: `b` holds 1 and 2, `a` 3 and 4; the store picks `a`'s first point)
    await compare(spec({ data: 't', field: 'v' }, 'a-first'), [
      { what: 'a point of a picked', store: [{ unit: '', _vgsid_: 3 }] },
      { what: 'a signal nothing reads', u: 1 },
      { what: 'a point of b picked', store: [{ unit: '', _vgsid_: 1 }] },
      { what: 'a signal nothing reads, again', u: 2 },
    ])
  })
})
