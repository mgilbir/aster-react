/**
 * LIVE differential for the `identifier` transform at the level of a VIEW. vega keeps ONE id counter per view: every
 * `identifier` transform of every dataset draws from it, in the order the dataflow runs them, so ids continue across datasets;
 * a tuple keeps the id it was given for as long as it lives (a signal that changes what a filter lets through, a modified row),
 * and a tuple added later (an appended row) is numbered from where the counter stands.
 *
 * Random specs of several datasets (inline values, derived from one or several earlier ones),
 * each with a random chain of filter / collect / formula / identifier, are run in real Vega and in Aster. After the first
 * evaluation and after every step of a random program (a signal moving, rows appended, removed or modified) the rows of EVERY
 * dataset must be the same. Aster is driven the way a `<Chart>` is: one session, new row arrays and signals per step.
 *
 * A mark's `identifier` transforms number its items from the same counter, after the datasets (vega runs a mark's transforms after
 * them): marks and group marks of the view over the datasets, with an identifier among their transforms, are compared by the
 * numbers their items hold, which an item keeps for as long as it lives.
 *
 * Not covered, by design: rows added together to data that a `collect` sorts, upstream of an `identifier`, are numbered in the order
 * vega received them and Aster in sorted order (so a sort is only ever the last step of a dataset nobody derives from); a row that LEAVES a dataset and comes back later keeps its id in vega (it is the same tuple) but gets a
 * new one here (an evaluation keeps no row it no longer has); the programs never bring a row back. Replacing the rows of a
 * dataset by different ones is not a vega operation (it is remove + insert, new ids) but a diff here, so it is not generated.
 * The rows of a dataset that unions several are in the order vega received them, pulse by pulse, and here in the order of the
 * datasets they come from: the items a mark makes of rows that arrive together are numbered in that order, so marks are over data
 * that unions nothing (docs/ERRORS.md).
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { createChartSession } from '../../core/src/session.ts'
import { datasetsOfScene } from '../../core/src/runtime.ts'
import type { RuntimeInput } from '../../core/src/types.ts'
import { makeRng, scaled, type Rng } from './differential-gen.mts'

type Row = Record<string, unknown>
type Spec = Record<string, unknown>

interface Dataset { name: string; values?: Row[]; source?: string | string[]; transform: Spec[] }
interface Mark { name: string; type: 'rect' | 'group'; from: string; transform: Spec[] }
interface Program {
  datasets: Dataset[]
  marks: Mark[]
  /** The first `lim`; every later one is larger (a row never comes back). */
  lim: number
  steps: Step[]
}
type Step =
  | { op: 'again' }
  | { op: 'lim'; to: number }
  | { op: 'append'; dataset: string; rows: Row[] }
  | { op: 'remove'; dataset: string; keys: string[] }
  | { op: 'modify'; dataset: string; keys: string[]; w: number }

const FIELDS = ['k', 'id', 'id2', 'w']

/** Whether a dataset's rows are the union of several datasets', or come from such a one (see the header). */
function unioned(d: Dataset, all: readonly Dataset[]): boolean {
  if (Array.isArray(d.source)) return true
  const from = typeof d.source === 'string' ? all.find((x) => x.name === d.source) : undefined
  return from !== undefined && unioned(from, all)
}

function genProgram(rng: Rng, withSteps: boolean): Program {
  let nextKey = 0
  const row = (): Row => ({ k: `r${nextKey++}`, v: rng.between(0, 9), w: 0 })
  const n = rng.between(2, 5)
  const datasets: Dataset[] = []
  // (datasets that end in a sort are nobody's source: see the header)
  const sortedLast = new Set<number>()
  for (let i = 0; i < n; i++) {
    const name = `d${i}`
    const d: Dataset = { name, transform: [] }
    const pool = [...Array(i).keys()].filter((j) => !sortedLast.has(j))
    if (i === 0 || !pool.length || rng.chance(0.4)) {
      d.values = Array.from({ length: rng.between(0, 5) }, row)
    } else {
      // a source: an earlier dataset (vega refuses a source declared later), sometimes two
      const first = rng.pick(pool)
      d.source = rng.chance(0.25) && pool.length > 1 ? [`d${first}`, `d${rng.pick(pool.filter((j) => j !== first))}`] : `d${first}`
    }
    for (let c = rng.between(0, 3); c > 0; c--) {
      d.transform.push(rng.pick<() => Spec>([
        () => ({ type: 'filter', expr: 'datum.v < lim' }),
        () => ({ type: 'filter', expr: `datum.v % ${rng.between(2, 3)} != 0` }),
        () => ({ type: 'formula', expr: 'datum.v * 2', as: 'dbl' }),
        () => ({ type: 'identifier', as: rng.pick(['id', 'id', 'id2']) }),
        () => ({ type: 'identifier', as: 'id' }),
      ])())
    }
    // every dataset carries at least one identifier, or there is nothing to compare
    if (!d.transform.some((t) => t.type === 'identifier')) d.transform.push({ type: 'identifier', as: rng.pick(['id', 'id2']) })
    if (rng.chance(0.25)) {
      d.transform.push({ type: 'collect', sort: { field: 'v', order: rng.pick(['ascending', 'descending']) } })
      sortedLast.add(i)
    }
    datasets.push(d)
  }
  // marks over the datasets whose transforms number their items (and may read the numbers)
  const marks: Mark[] = []
  for (let m = rng.between(0, 2); m > 0; m--) {
    const transform: Spec[] = [{ type: 'identifier', as: 'mid' }]
    if (rng.chance(0.4)) transform.unshift({ type: 'formula', as: 'x', expr: 'datum.datum.v * 3' })
    if (rng.chance(0.3)) transform.push({ type: 'identifier', as: 'mid2' })
    const type = rng.chance(0.3) ? 'group' : 'rect'
    // (what a group item holds of its numbers is where it is drawn)
    if (type === 'group' || rng.chance(0.3)) transform.push({ type: 'formula', as: 'y', expr: 'datum.mid * 2' })
    marks.push({ name: `mk${marks.length}`, type, from: rng.pick(datasets.filter((d) => !unioned(d, datasets))).name, transform })
  }
  const prog: Program = { datasets, marks, lim: rng.between(2, 6), steps: [] }
  if (!withSteps) return prog
  // the live row keys of every inline dataset, to remove / modify existing ones
  const live = new Map<string, string[]>(datasets.filter((d) => d.values).map((d) => [d.name, d.values!.map((r) => r.k as string)]))
  let lim = prog.lim
  for (let s = rng.between(2, 5); s > 0; s--) {
    const kind = rng.pick(['again', 'lim', 'append', 'append', 'remove', 'modify'] as const)
    const names = [...live.keys()]
    const name = rng.pick(names)
    // (an evaluation again with nothing changed)
    if (kind === 'again') prog.steps.push({ op: 'again' })
    else if (kind === 'lim') prog.steps.push({ op: 'lim', to: (lim += rng.between(1, 3)) })
    else if (kind === 'append') {
      const rows = Array.from({ length: rng.between(1, 3) }, row)
      live.get(name)!.push(...rows.map((r) => r.k as string))
      prog.steps.push({ op: 'append', dataset: name, rows })
    } else {
      const keys = live.get(name)!
      if (!keys.length) continue
      const pickKeys = keys.filter(() => rng.chance(0.4))
      if (!pickKeys.length) continue
      if (kind === 'remove') {
        live.set(name, keys.filter((k) => !pickKeys.includes(k)))
        prog.steps.push({ op: 'remove', dataset: name, keys: pickKeys })
      } else prog.steps.push({ op: 'modify', dataset: name, keys: pickKeys, w: rng.between(1, 9) })
    }
  }
  return prog
}

const specOf = (p: Program): Spec => ({
  signals: [{ name: 'lim', value: p.lim }],
  data: p.datasets.map((d) => ({ name: d.name, ...(d.values ? { values: structuredClone(d.values) } : {}), ...(d.source ? { source: d.source } : {}), transform: structuredClone(d.transform) })),
  marks: p.marks.map((m) => ({ type: m.type, name: m.name, from: { data: m.from }, encode: { update: { x: { field: 'v' }, y: { value: 1 }, width: { value: 2 }, height: { value: 2 } } }, transform: structuredClone(m.transform) })),
})

/**
 * A mark's items as text: each item's key (its datum's) and the numbers it holds, by key (the order of items is a matter of history).
 * A group item is compared by its position, which its numbers decide.
 */
const markImage = (m: Mark, items: readonly unknown[]): string => {
  const fields = m.type === 'group' ? ['x', 'y'] : ['mid', 'mid2', 'x', 'y']
  const name = m.name
  const list = items.map((it) => [((it as { datum?: Row }).datum ?? {}).k, ...fields.map((f) => (it as Row)[f])])
  list.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), 'en', { numeric: true }))
  return `${name}: ${JSON.stringify(list)}`
}
/** The items of the view's mark of that name in a scenegraph (vega's or Aster's: a mark is a group of items, a group mark's are groups). */
function itemsOf(root: { items?: unknown[] }, name: string): unknown[] {
  const out: unknown[] = []
  for (const m of root.items ?? []) {
    const mark = m as { name?: string; items?: unknown[]; marktype?: string }
    if (mark.name === name) out.push(...(mark.items ?? []))
  }
  return out
}

/**
 * A dataset as text. After a step the rows are listed in a fixed order: vega appends the rows a filter lets through LATER after the ones it
 * let through before (the order of a dataset depends on its history), which is a matter of row order, not of ids.
 */
const image = (name: string, rows: readonly unknown[] | null | undefined, byKey: boolean): string => {
  const list = (rows ?? []).map((r) => FIELDS.map((f) => (r as Row)[f]))
  if (byKey) list.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), 'en', { numeric: true }))
  return `${name}: ${JSON.stringify(list)}`
}

async function runVega(p: Program): Promise<string[][]> {
  const view = new vega.View(vega.parse(specOf(p) as never), { renderer: 'none', logLevel: vega.None })
  const look = (byKey: boolean): string[] => [
    ...p.datasets.map((d) => image(d.name, view.data(d.name), byKey)),
    ...p.marks.map((m) => markImage(m, itemsOf((view.scenegraph() as unknown as { root: { items: Array<{ items: unknown[] }> } }).root.items[0]!, m.name))),
  ]
  const out: string[][] = []
  try {
    await view.runAsync()
    out.push(look(false))
    for (const s of p.steps) {
      if (s.op === 'again') { /* nothing changes */ } else if (s.op === 'lim') view.signal('lim', s.to)
      else if (s.op === 'append') view.change(s.dataset, vega.changeset().insert(structuredClone(s.rows)))
      else if (s.op === 'remove') view.change(s.dataset, vega.changeset().remove((r: Row) => s.keys.includes(r.k as string)))
      else view.change(s.dataset, vega.changeset().modify((r: Row) => s.keys.includes(r.k as string), 'w', s.w))
      await view.runAsync()
      out.push(look(true))
    }
  } finally {
    view.finalize()
  }
  return out
}

function runAster(p: Program): string[][] {
  const spec = specOf(p)
  const session = createChartSession()
  const logger = { error: (...a: unknown[]) => { throw new Error(a.map(String).join(' ')) }, warn: () => {} }
  const out: string[][] = []
  // the live rows of every inline dataset, as the host holds them: a new array per change
  const data: Record<string, Row[]> = {}
  for (const d of p.datasets) if (d.values) data[d.name] = structuredClone(d.values)
  let signals: Record<string, unknown> = { lim: p.lim }
  const look = (input: RuntimeInput, byKey: boolean): string[] => {
    const scene = session.evaluate(structuredClone(spec) as never, { ...input, logger, data: { ...data }, signals })
    const sets = datasetsOfScene(scene)
    // (Aster's scene holds a group mark's items as one group each, named like their mark)
    const marks = (scene as unknown as { items: Array<{ name?: string; items?: unknown[]; marktype?: string }> }).items
    return [
      ...p.datasets.map((d) => image(d.name, sets.get(d.name), byKey)),
      ...p.marks.map((m) => markImage(m, m.type === 'group' ? marks.filter((g) => g.name === m.name && !(g as { emptyMark?: boolean }).emptyMark) : itemsOf({ items: marks }, m.name))),
    ]
  }
  out.push(look({}, false))
  for (const s of p.steps) {
    if (s.op === 'again') { /* nothing changes */ } else if (s.op === 'lim') signals = { ...signals, lim: s.to }
    else if (s.op === 'append') data[s.dataset] = [...data[s.dataset]!, ...structuredClone(s.rows)]
    else if (s.op === 'remove') data[s.dataset] = data[s.dataset]!.filter((r) => !s.keys.includes(r.k as string))
    else data[s.dataset] = data[s.dataset]!.map((r) => (s.keys.includes(r.k as string) ? { ...r, w: s.w } : r))
    out.push(look({}, true))
  }
  return out
}

const describeProgram = (p: Program): string => JSON.stringify({ lim: p.lim, datasets: p.datasets, marks: p.marks, steps: p.steps })

describe('identifier: one id counter per view (Aster vs real Vega)', { timeout: 120_000 }, () => {
  it('ids continue across the datasets of a view, in the order the dataflow runs them', async () => {
    const rng = makeRng(0x1d1)
    let compared = 0
    let marked = 0
    for (let i = 0; i < scaled(120); i++) {
      const p = genProgram(rng, false)
      const [oracle] = await runVega(p)
      const [got] = runAster(p)
      expect(got, describeProgram(p)).toEqual(oracle)
      compared++
      if (p.marks.length) marked++
    }
    expect(compared).toBe(scaled(120))
    // (most views have marks that number their items)
    expect(marked).toBeGreaterThan(scaled(120) * 0.4)
  })

  it('ids keep their rows, and new rows continue the counter, through signals, appends, removals and modifications', async () => {
    const rng = makeRng(0x1d2)
    let steps = 0
    let marked = 0
    for (let i = 0; i < scaled(150); i++) {
      const p = genProgram(rng, true)
      const oracle = await runVega(p)
      const got = runAster(p)
      expect(got, describeProgram(p)).toEqual(oracle)
      steps += p.steps.length
      if (p.marks.length) marked += p.steps.length
    }
    expect(steps).toBeGreaterThan(200)
    expect(marked).toBeGreaterThan(steps * 0.4)
  })
})
