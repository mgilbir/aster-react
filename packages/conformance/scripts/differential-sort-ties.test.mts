/**
 * LIVE differential for the order of rows that tie in a sort, at the level of a view. vega breaks such a tie by the order the
 * tuples were created in, not by where they sit: a `collect` that sorted them by something else has moved them, a dataset made
 * from another makes new tuples in the order its source lists them, and a transform that makes new rows makes them in its own order.
 *
 * Random views of a few datasets (inline values with few distinct keys, derived from one or several others) whose pipelines sort,
 * do something to the rows and sort again, with scales whose domain is sorted by a count, run in real Vega and in Aster: every
 * dataset, row by row, and every scale domain must be the same.
 *
 * Not covered, by design: ties after rows were added to a view that has run. Vega keeps the tuples it has made and makes the new
 * ones last, and keeps the new rows of a dataset after its old ones wherever an upstream sort would put them; a view here is
 * evaluated again from its inputs, so both orders are the order of the sorted inputs.
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { createChartSession } from '../../core/src/session.ts'
import { datasetsOfScene } from '../../core/src/runtime.ts'
import { makeRng, scaled, type Rng } from './differential-gen.mts'

type Row = Record<string, unknown>
type Spec = Record<string, unknown>
const FIELDS = ['n', 'k', 'g', 'rn', 'rk', 'y0', 'y1', 'sv', 'key', 'value']

interface Program { spec: Spec; inline: Record<string, Row[]> }

function genProgram(rng: Rng): Program {
  let n = 0
  const row = (): Row => ({ n: n++, k: rng.between(0, 2), g: rng.pick(['a', 'b']), v: rng.between(0, 3), w: rng.between(0, 5) })
  const sortOn = (): Spec => {
    const field = rng.chance(0.7) ? rng.pick(['k', 'g', 'v']) : [rng.pick(['k', 'g']), rng.pick(['v', 'w'])]
    return { field, ...(Array.isArray(field) ? { order: field.map(() => rng.pick(['ascending', 'descending'])) } : rng.chance(0.5) ? { order: rng.pick(['ascending', 'descending']) } : {}) }
  }
  const step = (): Spec => rng.pick<() => Spec>([
    () => ({ type: 'collect', sort: sortOn() }),
    () => ({ type: 'collect', sort: sortOn() }),
    () => ({ type: 'window', sort: sortOn(), groupby: rng.pick([[], ['g']]), ops: ['row_number', 'rank', 'sum'], fields: [null, null, 'v'], as: ['rn', 'rk', 'sv'] }),
    () => ({ type: 'stack', field: 'w', groupby: rng.pick([[], ['g']]), sort: sortOn(), offset: 'zero' }),
    () => ({ type: 'filter', expr: 'datum.n % 3 !== 1' }),
    () => ({ type: 'fold', fields: ['v', 'w'], as: ['key', 'value'] }),
    () => ({ type: 'project', fields: ['n', 'k', 'g', 'v', 'w'] }),
  ])()
  const count = rng.between(2, 4)
  const data: Spec[] = []
  const inline: Record<string, Row[]> = {}
  for (let i = 0; i < count; i++) {
    const name = `d${i}`
    const d: Spec = { name, transform: Array.from({ length: rng.between(1, 4) }, step) }
    if (i === 0 || rng.chance(0.4)) inline[name] = Array.from({ length: rng.between(2, 9) }, row)
    else {
      const first = rng.between(0, i - 1)
      d.source = rng.chance(0.25) && i > 1 ? [`d${first}`, `d${(first + 1) % i}`] : `d${first}`
    }
    // (a dataset made from another that opens with a sort sorts the rows of its source in place: vega's own aliasing, which is not
    // reproduced; a step before the sort avoids it)
    if (d.source) (d.transform as Spec[]).unshift({ type: 'formula', expr: 'datum.n', as: 'z' })
    if (inline[name]) d.values = structuredClone(inline[name])
    data.push(d)
  }
  const scales = [{ name: 's', type: 'band', domain: { data: 'd0', field: 'g', sort: { op: 'count', order: rng.pick(['ascending', 'descending']) } }, range: [0, 100] },
    { name: 't', type: 'band', domain: { data: 'd0', field: 'k', sort: { op: 'count', order: rng.pick(['ascending', 'descending']) } }, range: [0, 100] }]
  return { spec: { width: 100, height: 100, data, scales }, inline }
}

const image = (rows: readonly unknown[] | null | undefined): string => JSON.stringify((rows ?? []).map((r) => FIELDS.map((f) => (r as Row)[f])))

async function runVega(p: Program): Promise<string> {
  const view = new vega.View(vega.parse(structuredClone(p.spec) as never), { renderer: 'none', logLevel: vega.None })
  try {
    await view.runAsync()
    const names = (p.spec.data as Spec[]).map((d) => d.name as string)
    return names.map((n) => `${n} ${image(view.data(n))}`).join('\n') + `\ns ${JSON.stringify(view.scale('s').domain())} t ${JSON.stringify(view.scale('t').domain())}`
  } finally {
    view.finalize()
  }
}

function runAster(p: Program): string {
  const logger = { error: (...a: unknown[]) => { throw new Error(a.map(String).join(' ')) }, warn: () => {} }
  const scene = createChartSession().evaluate(structuredClone(p.spec) as never, { logger })
  const sets = datasetsOfScene(scene)
  const scales = (scene as unknown as { __scales: Array<{ name: string; domain: unknown[] }> }).__scales
  const dom = (n: string): string => JSON.stringify(scales.find((s) => s.name === n)?.domain)
  const names = (p.spec.data as Spec[]).map((d) => d.name as string)
  return names.map((n) => `${n} ${image(sets.get(n))}`).join('\n') + `\ns ${dom('s')} t ${dom('t')}`
}

describe('rows that tie in a sort keep the order they were made in (Aster vs real Vega)', { timeout: 120_000 }, () => {
  it('through sorts, new tuples, derived datasets and scale domains', async () => {
    const rng = makeRng(0x71e5)
    for (let i = 0; i < scaled(400); i++) {
      const p = genProgram(rng)
      expect(runAster(p), JSON.stringify(p.spec.data)).toEqual(await runVega(p))
    }
  })
})
