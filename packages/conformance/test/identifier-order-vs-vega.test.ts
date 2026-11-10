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
const spec = (domain: unknown, order: 'a-first' | 'b-first', filter = "scale('x', datum.v) > 50"): Spec => {
  const a = { name: 'a', source: 't', transform: [{ type: 'filter', expr: filter }, { type: 'identifier', as: 'id' }] }
  const b = { name: 'b', values: B, transform: [{ type: 'identifier', as: 'id' }] }
  const fill = [{ test: "vlSelectionIdTest('store', {_vgsid_: datum.id})", value: 'red' }, { value: 'grey' }]
  return {
    width: 100, height: 50, autosize: 'none',
    signals: [{ name: 'u', value: 0 }, { name: 'cut', value: 3 }],
    scales: [{ name: 'x', type: 'linear', domain, range: [0, 100] }],
    data: [{ name: 'store', values: [] }, { name: 't', values: T }, ...(order === 'a-first' ? [a, b] : [b, a])],
    marks: ['a', 'b'].map((name) => ({ type: 'symbol', name: `m${name}`, from: { data: name }, encode: { update: { x: { field: 'id' }, fill } } })),
  }
}

type Step = { what: string; t?: Row[]; b?: Row[]; u?: number; cut?: number; store?: Row[] }

/** The same steps through vega and through the session; the ids of both datasets and the fill of every point after each. */
async function compare(s: Spec, steps: Step[]): Promise<void> {
  const view = new (vega as unknown as { View: new (rt: unknown, o: unknown) => View }).View(vega.parse(structuredClone(s) as never), { renderer: 'none' })
  const session = createChartSession()
  let state = { t: T, b: B, u: 0, cut: 3, store: [] as Row[] }
  const input = (): RuntimeInput => ({ data: { t: state.t, b: state.b, store: state.store }, signals: { u: state.u, cut: state.cut } })
  // (each row with its number, in the order of the rows' fields: vega lists a row a filter lets through again after the rows it kept,
  // where the engine keeps the source's order -- the numbers are compared, not that order)
  const ids = (rows: Row[]): string[] => rows.map((r) => `${r.v ?? r.w}:${r.id}`).sort()
  const fills = (scene: SceneRoot, name: string): string[] => {
    const g = (scene.items as Array<{ name?: string; items?: Array<{ fill?: unknown; datum?: Row }> }>).find((m) => m.name === `m${name}`)
    return (g?.items ?? []).map((it) => `${it.datum?.id}:${it.fill}`).sort()
  }
  try {
    await view.runAsync()
    for (const step of [{ what: 'first' } as Step, ...steps]) {
      if (step.t) {
        // (rows appended are inserted; rows gone are removed, the tuples vega holds for them)
        const next = step.t
        const cs = next.length >= state.t.length
          ? (vega as any).changeset().insert(next.slice(state.t.length).map((r) => ({ ...r })))
          : (vega as any).changeset().remove((d: Row) => !next.some((r) => r.v === d.v))
        view.change('t', cs)
        state = { ...state, t: next }
      }
      if (step.b) { view.change('b', (vega as any).changeset().insert(step.b.slice(state.b.length).map((r) => ({ ...r })))); state = { ...state, b: step.b } }
      if (step.store) { view.change('store', (vega as any).changeset().remove(() => true).insert(step.store.map((r) => ({ ...r })))); state = { ...state, store: step.store } }
      if (step.u !== undefined) { view.signal('u', step.u); state = { ...state, u: step.u } }
      if (step.cut !== undefined) { view.signal('cut', step.cut); state = { ...state, cut: step.cut } }
      await view.runAsync()
      const scene = session.evaluate(structuredClone(s) as never, input())
      const made = datasetsOfScene(scene)
      for (const name of ['a', 'b']) {
        expect(ids(made.get(name) as Row[]), `${step.what}: ids of ${name}`).toEqual(ids(view.data(name)))
        const want = view.data(name).map((r) => `${r.id}:${state.store.some((p) => p._vgsid_ === r.id) ? 'red' : 'grey'}`).sort()
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
  // (the scale's domain grows: the rows `a` held fail the filter, the new one passes and is a new tuple, numbered anew; the rows
  // that left keep their numbers on their tuples)
  { what: 'a row of t that moves the scale', t: [...T, { v: 4.5 }, { v: 30 }] },
  { what: 'a signal nothing reads, at last', u: 3 },
  // (the domain shrinks back: the rows that left come back with the numbers they had)
  { what: 'the row that moved the scale removed', t: [...T, { v: 4.5 }] },
]

describe('identifier numbers, against vega', () => {
  for (const order of ['a-first', 'b-first'] as const) {
    it(`a dataset that reads a scale made from data (${order})`, async () => {
      await compare(spec({ data: 't', field: 'v' }, order), STEPS)
    })
    it(`a dataset that reads a scale of a constant domain is numbered in declaration order (${order})`, async () => {
      // (`v` of 5 and the 4.5 appended pass the filter)
      await compare(spec([0, 8], order), STEPS)
    })
  }

  it('a filter by a signal: rows leave and come back with their numbers; rows removed and added around them', async () => {
    // (the rows of `t` with `v >= cut` pass; the steps move `cut`, remove a row from the middle of `t` and append others: the rows that
    // pass are found among the source rows, wherever they now stand)
    const mid = T.filter((r) => r.v !== 1)
    await compare(spec([0, 10], 'a-first', 'datum.v >= cut'), [
      { what: 'rows leave', cut: 5 },
      { what: 'rows come back', cut: 2 },
      { what: 'a row removed before them', t: mid },
      { what: 'a row appended', t: [...mid, { v: 7 }] },
      { what: 'every row passes', cut: 0 },
      { what: 'a row appended while rows leave', t: [...mid, { v: 7 }, { v: 8 }], cut: 6 },
      { what: 'they come back', cut: 0 },
    ])
  })

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
