/**
 * The hierarchy layouts' `sort` against the pinned real Vega, in this process, over generated trees: siblings that tie under the
 * sort are ordered by the order their rows were made in (vega's `stableCompare`, by tuple id), not by where the rows sit when the
 * layout runs. A `collect` that sorts the rows by something else before the `stratify` moves them; the ties must not follow it.
 * Every layout that sorts (`treemap`, `partition`, `pack`, `tree`), over trees with many ties, with and without that `collect`.
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import '@aster-charts/core/transforms'
import { compileChart, datasetsOfScene, evaluateChart } from '@aster-charts/core'
import { makeRng, scaled } from './differential-gen.mts'

type Spec = Record<string, unknown>
type Row = Record<string, unknown>

async function onVega(spec: Spec): Promise<unknown[]> {
  const View = (vega as unknown as { View: new (rt: unknown, o: unknown) => { runAsync(): Promise<void>; data(n: string): unknown[]; finalize(): void } }).View
  const view = new View(vega.parse(structuredClone(spec) as never), { renderer: 'none' })
  try {
    await view.runAsync()
    return view.data('tree')
  } finally {
    view.finalize()
  }
}

const onAster = (spec: Spec): unknown[] => datasetsOfScene(evaluateChart(compileChart(structuredClone(spec) as never))).get('tree') as unknown[]

const FIELDS: Record<string, string[]> = {
  treemap: ['x0', 'y0', 'x1', 'y1', 'depth', 'children'],
  partition: ['x0', 'y0', 'x1', 'y1', 'depth', 'children'],
  pack: ['x', 'y', 'r', 'depth', 'children'],
  tree: ['x', 'y', 'depth', 'children'],
}

const round = (v: unknown): unknown => (typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : v)

describe('hierarchy layouts: sort ties follow the order rows were made in, as vega (generated)', () => {
  it('treemap, partition, pack and tree, with and without a collect that sorted the rows first', async () => {
    const r = makeRng(0x131)
    const n = scaled(160)
    let withCollect = 0
    let differ = 0
    for (let k = 0; k < n; k++) {
      const method = (['treemap', 'partition', 'pack', 'tree'] as const)[k % 4]!
      const leaves = 3 + Math.floor(r.next() * 6)
      // a root, a middle level, and leaves whose sizes tie often
      const rows: Row[] = [{ id: 0, n: 'root' }]
      const mids = 1 + Math.floor(r.next() * 2)
      for (let m = 0; m < mids; m++) rows.push({ id: 1 + m, parent: 0, n: r.pick(['b', 'c', 'a', 'd']), s: r.pick([0, 2, 2]) })
      for (let i = 0; i < leaves; i++) rows.push({ id: 10 + i, parent: 1 + Math.floor(r.next() * mids), n: r.pick(['q', 'e', 'z', 'k', 'm']), s: r.pick([5, 5, 5, 3, 3]) })
      const collect = r.chance(0.7)
      if (collect) withCollect++
      const sort = r.pick([{ field: 'value', order: 'descending' }, { field: 'value' }, { field: 'depth' }, { field: ['value', 'id'], order: ['descending', 'ascending'] }])
      const spec: Spec = {
        data: [{
          name: 'tree', values: rows,
          transform: [
            ...(collect ? [{ type: 'collect', sort: { field: r.pick(['n', 's', 'id']), order: r.pick(['ascending', 'descending']) } }] : []),
            { type: 'stratify', key: 'id', parentKey: 'parent' },
            { type: method, field: 's', sort, ...(method === 'tree' ? { size: [100, 50] } : { size: [100, 50] }) },
          ],
        }],
      }
      const want = await onVega(spec)
      const got = onAster(spec)
      const pick = (rows: unknown[]): unknown[] => [...rows].map((row) => {
        const o = row as Row
        const out: Row = { id: o.id }
        for (const f of FIELDS[method]!) out[f] = round(o[f])
        return out
      }).sort((a, b) => (a.id as number) - (b.id as number))
      if (JSON.stringify(pick(got)) !== JSON.stringify(pick(want))) differ++
      expect(pick(got), `${method} ${JSON.stringify(spec)}`).toEqual(pick(want))
    }
    // (not vacuous: most cases move the rows before the layout sorts them)
    expect(withCollect).toBeGreaterThan(n * 0.5)
    expect(differ).toBe(0)
  }, 120_000)
})

describe('a pack the data cannot enclose is the data\'s failure, as vega\'s (C406)', () => {
  it('vega logs it and the view runs; Aster logs it and the evaluation goes on (generated leaf sizes)', async () => {
    const r = makeRng(0x406)
    let failed = 0
    for (let k = 0; k < scaled(40); k++) {
      // sizes past what a circle's radius squared can hold make the enclosing search fail
      const sizes = Array.from({ length: 2 + Math.floor(r.next() * 4) }, () => r.pick([1e308, 1e308, 1, 2, 3]))
      const spec: Spec = {
        data: [{
          name: 'tree',
          values: [{ id: 0 }, ...sizes.map((s, i) => ({ id: i + 1, parent: 0, s }))],
          transform: [{ type: 'stratify', key: 'id', parentKey: 'parent' }, { type: 'pack', field: 's', size: [100, 50] }],
        }],
      }
      const vegaErrors: unknown[] = []
      const logger = { level() { return 2 }, error: (...a: unknown[]) => { vegaErrors.push(a[0]); return logger }, warn: () => logger, info: () => logger, debug: () => logger }
      const View = (vega as unknown as { View: new (rt: unknown, o: unknown) => { runAsync(): Promise<void>; finalize(): void } }).View
      const view = new View(vega.parse(structuredClone(spec) as never), { renderer: 'none', logger })
      await view.runAsync()
      view.finalize()
      const asterErrors: unknown[] = []
      // (a failure the engine treats as its own refusal is thrown out of evaluateChart; a data failure is logged)
      evaluateChart(compileChart(structuredClone(spec) as never), { logger: { error: (e: unknown) => asterErrors.push(e), warn: () => {} } } as never)
      expect(asterErrors.length, JSON.stringify(sizes)).toBe(vegaErrors.length)
      if (vegaErrors.length) {
        failed++
        expect(String(asterErrors[0]), JSON.stringify(sizes)).toBe(String(vegaErrors[0]))
      }
    }
    expect(failed).toBeGreaterThan(0)
  })
})
