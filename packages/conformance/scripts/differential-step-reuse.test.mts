/**
 * LIVE differential for a chart that is evaluated again and again with its dataset steps kept (Aster) against a vega view that
 * runs only what a change reaches. Vega never runs a transform again whose inputs did not move: a resize or a signal an operator
 * does not read leaves its tuples, its published signals and its ids as they were. Aster evaluates its whole chart for every
 * input and keeps the steps whose inputs are as they were (core/src/step-reuse.ts); what each side makes must be the same.
 *
 * Random charts of several datasets (inline rows, or derived from an earlier one), each a random chain of steps that read
 * the view's size (`width`), signals, and signals other steps publish (`extent`, `bin`), are run in real Vega and in Aster. After the
 * first evaluation and after every step of a random program (the width moving, a signal moving, rows appended or removed) the rows of
 * EVERY dataset and every published signal must be the same. Aster is driven the way a `<Chart>` is: one session, the size and signals
 * as inputs, a new row array for a change of rows.
 *
 * Not generated: steps that draw (vega's stream is global, `differential-random` covers it), and `aggregate` / `collect` (vega keeps a
 * running sum, so its floating-point sums differ in the last bit from a fresh sum; a `collect` of a dataset another derives from
 * sorts the rows both hold; those steps have their own differentials). The rows of a dataset are compared as a set: vega adds the
 * rows a filter lets through later after the ones it let through before.
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { createChartSession } from '../../core/src/session.ts'
import { datasetsOfScene } from '../../core/src/runtime.ts'
import { enc } from './differential-util.mts'
import { makeRng, scaled, type Rng } from './differential-gen.mts'

type Row = Record<string, unknown>
type Spec = Record<string, unknown>

interface Dataset { name: string; values?: Row[]; source?: string | string[]; transform: Spec[] }
type Step =
  | { op: 'width'; to: number }
  | { op: 'signal'; name: 'sigA' | 'sigB' | 'thr'; to: number }
  | { op: 'append'; dataset: string; rows: Row[] }
  | { op: 'remove'; dataset: string; keys: string[] }
interface Program { datasets: Dataset[]; published: string[]; steps: Step[] }

let nextKey = 0

function genProgram(rng: Rng): Program {
  const row = (): Row => ({ k: `r${nextKey++}`, x: rng.between(0, 12), v: rng.between(0, 9), g: rng.between(0, 2) })
  const published: string[] = []
  const datasets: Dataset[] = []
  // (a row that a signal lets out of a filter and back in keeps its id in vega but not here -- see differential-identifier -- and the
  // order vega runs datasets in when one reads a signal another publishes numbers their ids in its own order: a program with ids has
  // no filter on a field a signal can move and no step that reads a published signal)
  const ids = rng.chance(0.5)
  const n = rng.between(1, 4)
  for (let i = 0; i < n; i++) {
    const name = `d${i}`
    const d: Dataset = { name, transform: [] }
    if (i === 0 || rng.chance(0.4)) d.values = Array.from({ length: rng.between(3, 12) }, row)
    else {
      const first = rng.int(i)
      d.source = `d${first}`
    }
    // the numeric fields the rows of this dataset hold so far, so each step reads one that exists
    let numeric = ['x', 'v']
    // (a signal a dataset publishes is read by the datasets after it: vega ranks a dataset that reads its own signal after the others)
    const earlier = ids ? [] : [...published]
    for (let c = rng.between(1, 5); c > 0; c--) {
      const f = rng.pick(numeric)
      const as = `${name}_${c}`
      const step = rng.pick<() => Spec>([
        () => ({ type: 'formula', expr: `datum.${f} * 2 + width / 10`, as }),
        () => ({ type: 'formula', expr: `datum.${f} + ${rng.pick(['sigA', 'sigB', 'sigA * sigB'])}`, as }),
        () => ({ type: 'formula', expr: `abs(datum.${f} - 3)`, as }),
        () => (ids ? { type: 'filter', expr: `datum.${rng.pick(['x', 'v'])} >= 1` } : { type: 'filter', expr: `datum.${f} >= ${rng.pick(['thr', 'sigA - 2', '1'])}` }),
        () => ({ type: 'bin', field: f, extent: [0, 14], step: { signal: 'sigB' }, as: [as, `${as}e`] }),
        () => ({ type: 'bin', field: f, extent: [0, 14], step: rng.pick([1, 2, 3]), as: [as, `${as}e`] }),
        () => (earlier.length ? { type: 'bin', field: f, extent: { signal: rng.pick(earlier) }, maxbins: rng.pick([3, 5]), signal: `${as}_info`, as: [as, `${as}e`] } : { type: 'bin', field: f, extent: [0, 14], maxbins: 4, signal: `${as}_info`, as: [as, `${as}e`] }),
        () => ({ type: 'extent', field: f, signal: `${as}_ext` }),
        () => (ids ? { type: 'identifier', as } : { type: 'formula', expr: `datum.${f} + 1`, as }),
      ])()
      d.transform.push(step)
      if (step.type === 'bin' && typeof step.signal === 'string') published.push(step.signal)
      if (step.type === 'extent') published.push(step.signal as string)
      if (step.type === 'formula' || step.type === 'identifier') numeric = [...numeric, as]
      else if (step.type === 'bin') numeric = [...numeric, as, `${as}e`]
    }
    datasets.push(d)
  }
  const inline = datasets.filter((d) => d.values).map((d) => ({ name: d.name, keys: d.values!.map((r) => r.k as string) }))
  const steps: Step[] = []
  for (let s = rng.between(3, 7); s > 0; s--) {
    const kind = rng.pick(['width', 'width', 'signal', 'signal', 'signal', 'append', 'remove'] as const)
    if (kind === 'width') steps.push({ op: 'width', to: rng.pick([240, 280, 320, 360]) })
    else if (kind === 'signal') steps.push({ op: 'signal', name: rng.pick(['sigA', 'sigB', 'thr'] as const), to: rng.between(1, 6) })
    else {
      const t = rng.pick(inline)
      if (kind === 'append') {
        const rows = Array.from({ length: rng.between(1, 2) }, row)
        t.keys.push(...rows.map((r) => r.k as string))
        steps.push({ op: 'append', dataset: t.name, rows })
      } else if (t.keys.length > 1) {
        const keys = t.keys.filter(() => rng.chance(0.3))
        t.keys = t.keys.filter((k) => !keys.includes(k))
        if (keys.length) steps.push({ op: 'remove', dataset: t.name, keys })
      }
    }
  }
  return { datasets, published, steps }
}

const specOf = (p: Program): Spec => ({
  width: 200, height: 100, autosize: 'none',
  signals: [{ name: 'sigA', value: 3 }, { name: 'sigB', value: 2 }, { name: 'thr', value: 2 }],
  data: p.datasets.map((d) => ({ name: d.name, ...(d.values ? { values: structuredClone(d.values) } : {}), ...(d.source ? { source: d.source } : {}), transform: structuredClone(d.transform) })),
})

/** The datasets and published signals as text. After a step the rows are a set (see the header). */
function image(p: Program, rows: (name: string) => readonly unknown[] | null | undefined, signal: (name: string) => unknown, ordered: boolean): string {
  const sets = p.datasets.map((d) => {
    const list = (rows(d.name) ?? []).map((r) => JSON.stringify(enc(r)))
    return `${d.name}: ${(ordered ? list : [...list].sort()).join('|')}`
  })
  // (vega publishes a bin's grid as a function carrying `start`, `stop` and `step`; Aster as an object with them)
  const grid = (v: unknown): unknown => (typeof v === 'function' ? { start: (v as Record<string, unknown>).start, stop: (v as Record<string, unknown>).stop, step: (v as Record<string, unknown>).step } : v)
  return [...sets, ...p.published.map((s) => `${s}: ${JSON.stringify(enc(grid(signal(s))))}`)].join('\n')
}

async function runVega(p: Program): Promise<string[]> {
  const view = new vega.View(vega.parse(specOf(p) as never), { renderer: 'none', logLevel: vega.None })
  const look = (ordered: boolean): string => image(p, (n) => view.data(n), (s) => view.signal(s), ordered)
  const out: string[] = []
  try {
    await view.runAsync()
    out.push(look(false))
    for (const s of p.steps) {
      if (s.op === 'width') view.width(s.to)
      else if (s.op === 'signal') view.signal(s.name, s.to)
      else if (s.op === 'append') view.change(s.dataset, vega.changeset().insert(structuredClone(s.rows)))
      else view.change(s.dataset, vega.changeset().remove((r: Row) => s.keys.includes(r.k as string)))
      await view.runAsync()
      out.push(look(false))
    }
  } finally {
    view.finalize()
  }
  return out
}

function runAster(p: Program): string[] {
  const spec = specOf(p)
  const session = createChartSession()
  const logger = { error: (...a: unknown[]) => { throw new Error(a.map(String).join(' ')) }, warn: () => {} }
  const data: Record<string, Row[]> = {}
  for (const d of p.datasets) if (d.values) data[d.name] = structuredClone(d.values)
  let width: number | undefined
  let signals: Record<string, unknown> = { sigA: 3, sigB: 2, thr: 2 }
  const look = (ordered: boolean): string => {
    const scene = session.evaluate(structuredClone(spec) as never, { logger, data: { ...data }, signals, ...(width !== undefined ? { width } : {}) })
    const sets = datasetsOfScene(scene)
    const params = (scene as unknown as { signalParams: Record<string, unknown> }).signalParams
    return image(p, (n) => sets.get(n), (s) => params[s], ordered)
  }
  const out = [look(false)]
  for (const s of p.steps) {
    if (s.op === 'width') width = s.to
    else if (s.op === 'signal') signals = { ...signals, [s.name]: s.to }
    else if (s.op === 'append') data[s.dataset] = [...data[s.dataset]!, ...structuredClone(s.rows)]
    else data[s.dataset] = data[s.dataset]!.filter((r) => !s.keys.includes(r.k as string))
    out.push(look(false))
  }
  return out
}

describe('kept steps: a chart evaluated again and again (Aster) vs a vega view that runs what a change reaches', { timeout: 180_000 }, () => {
  it('datasets, ids and published signals are the same through resizes, signals and rows', async () => {
    const rng = makeRng(0x5e7)
    let steps = 0
    for (let i = 0; i < scaled(200); i++) {
      const p = genProgram(rng)
      const oracle = await runVega(p)
      const got = runAster(p)
      expect(got, JSON.stringify(p)).toEqual(oracle)
      steps += p.steps.length
    }
    expect(steps).toBeGreaterThan(400)
  })
})
