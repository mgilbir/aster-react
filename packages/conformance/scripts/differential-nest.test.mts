/**
 * The `nest` transform against the pinned real Vega, in this process: the rows grouped by key fields into a tree, the interior
 * nodes added as rows with `generate`, and the layouts that lay the tree out (`partition`, `treemap`, `tree`, `treelinks`).
 * Strict: the rows, their key order, the order of the rows, what the layouts wrote on rows and on interior nodes.
 * Keys are drawn so that the order of the groups is told (whole numbers before names, in an object's key order), with
 * nulls, booleans and numbers (a key is `'' + value`), nested and escaped paths, and rows that hold a `values` array of their
 * own (which Vega reads as the children of that row).
 *
 * Not compared (Aster never writes on the rows it was given, and a layout's fields are written on copies): the elements inside
 * a `values` array. Vega lays the very objects those arrays hold out, so they show the layout's fields; Aster's show the
 * objects as they were before the layout. Each element is compared by its `key` or `id`, so the grouping and the order are.
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import '@aster/core/geo'
import '@aster/core/transforms'
import { compileChart, datasetsOfScene, evaluateChart } from '@aster/core'
import { enc } from './differential-util.mts'
import { makeRng, scaled, type Rng } from './differential-gen.mts'

type Spec = Record<string, unknown>

async function onVega(spec: Spec): Promise<{ rows?: unknown[]; errors: string[] }> {
  const errors: string[] = []
  const logger = {
    level() { return 2 },
    error: (...a: unknown[]) => { errors.push(a.map(String).join(' ')); return logger },
    warn: () => logger, info: () => logger, debug: () => logger,
  }
  const View = (vega as unknown as { View: new (rt: unknown, o: unknown) => { runAsync(): Promise<void>; data(n: string): unknown[]; finalize(): void } }).View
  const view = new View(vega.parse(structuredClone(spec) as never), { renderer: 'none', logger })
  try {
    await view.runAsync()
    return { rows: view.data('out'), errors }
  } finally {
    view.finalize()
  }
}

function onAster(spec: Spec): { rows?: unknown[]; errors: unknown[] } {
  const errors: unknown[] = []
  const logger = { error: (...a: unknown[]) => { errors.push(a[0]) }, warn: () => {} }
  const scene = evaluateChart(compileChart(structuredClone(spec) as never), { logger } as never)
  return { rows: datasetsOfScene(scene).get('out') as unknown[], errors }
}

/** A row as compared: the elements of its `values` array stand for themselves by name only (and a link's two ends are rows so). */
function named(rows: unknown[] | undefined): unknown[] | undefined {
  const tag = (v: unknown): unknown => {
    const o = v as { key?: unknown; id?: unknown } | null
    return o && typeof o === 'object' ? (o.key !== undefined ? { key: o.key } : { id: o.id }) : v
  }
  const one = (row: unknown): unknown => {
    const r = row as { values?: unknown[] } | null
    return r && Array.isArray(r.values) ? { ...r, values: r.values.map(tag) } : row
  }
  return rows?.map((row) => {
    const link = row as { source?: unknown; target?: unknown } | null
    return link && typeof link === 'object' && 'source' in link && 'target' in link ? { source: one(link.source), target: one(link.target) } : one(row)
  })
}

const KEY_PATHS = ['a', 'b', 'o.c', 'o\\.d', 'e[1]', '["f g"]'] as const
const KEY_VALUES: unknown[] = ['x', 'y', 'z', '10', '2', '1', 3, 10, true, false, null, 'null', 'true', '']

function rowOf(r: Rng, i: number): Record<string, unknown> {
  const pick = (): unknown => r.pick(KEY_VALUES)
  const row: Record<string, unknown> = {
    id: i, n: r.between(1, 20), a: pick(), b: pick(), o: { c: pick() }, 'o.d': pick(), e: [pick(), pick()], 'f g': pick(),
  }
  // a row that is a node of its own: a non-empty array `values`
  if (r.chance(0.08)) row.values = Array.from({ length: r.between(0, 3) }, (_, j) => ({ id: 100 + i * 10 + j, n: r.between(1, 9), a: pick() }))
  return row
}

const LAYOUTS: Array<(r: Rng) => Spec[]> = [
  () => [],
  () => [],
  () => [{ type: 'partition', field: 'n', size: [100, 50] }],
  () => [{ type: 'treemap', field: 'n', size: [100, 50], method: 'squarify' }],
  (r) => [{ type: 'treemap', field: 'n', size: [100, 50], method: r.pick(['slice', 'dice', 'binary']), padding: r.pick([0, 2]) }],
  () => [{ type: 'tree', field: 'n', size: [100, 50], method: 'tidy' }],
  () => [{ type: 'tree', method: 'cluster', size: [100, 50] }],
  () => [{ type: 'partition', sort: { field: 'value', order: 'descending' }, size: [100, 50] }],
  () => [{ type: 'treemap', field: 'n', sort: { field: 'value' }, size: [100, 50] }],
]

describe('nest matches vega', () => {
  it(`${scaled(1500)} generated nestings hold the vega datasets`, { timeout: 600_000 }, async () => {
    const r = makeRng(31)
    const bad: string[] = []
    let compared = 0
    let generated = 0
    let withLayout = 0
    let refused = 0
    for (let c = 0; c < scaled(1500); c++) {
      const rows = Array.from({ length: r.pick([0, 1, 2, 5, 9, 14]) }, (_, i) => rowOf(r, i))
      const generate = r.chance(0.5)
      // (with no keys and `generate`, Vega's root row holds the dataset's own array as `values`, itself among it: a cycle that
      // is compared nowhere here)
      const keys = Array.from({ length: r.between(generate ? 1 : 0, 3) }, () => r.pick(KEY_PATHS))
      const layout = r.pick(LAYOUTS)(r)
      const links = r.chance(0.2) ? [{ type: 'treelinks' }] : []
      const transform = [{ type: 'nest', keys, ...(generate ? { generate: true } : r.chance(0.2) ? { generate: false } : {}) }, ...layout, ...links]
      const spec: Spec = { data: [{ name: 'src', values: rows }, { name: 'out', source: 'src', transform }] }
      const label = JSON.stringify(transform)
      const want = await onVega(spec)
      let got: ReturnType<typeof onAster>
      try {
        got = onAster(spec)
      } catch (e) {
        if (!want.errors.length) bad.push(`${label}: aster threw ${(e as Error).message}`)
        else refused++
        continue
      }
      if (want.errors.length) {
        refused++
        if (!got.errors.length) bad.push(`${label}: vega logged "${want.errors[0]}", aster nothing`)
        continue
      }
      if (got.errors.length) { bad.push(`${label}: aster logged ${String(got.errors[0])}`); continue }
      compared++
      if (generate) generated++
      if (layout.length) withLayout++
      const a = JSON.stringify(enc(named(got.rows)))
      const b = JSON.stringify(enc(named(want.rows)))
      if (a !== b) {
        const ga = (named(got.rows) ?? []).map((x) => JSON.stringify(enc(x)))
        const gb = (named(want.rows) ?? []).map((x) => JSON.stringify(enc(x)))
        const at = ga.findIndex((x, i) => x !== gb[i])
        bad.push(`${label} over ${JSON.stringify(rows).slice(0, 200)}\n   rows ${ga.length} vs ${gb.length}; first difference at ${at}\n   aster ${ga[at]?.slice(0, 500)}\n   vega  ${gb[at]?.slice(0, 500)}`)
      }
    }
    expect(bad.slice(0, 4)).toEqual([])
    expect(compared).toBeGreaterThan(scaled(1500) * 0.8)
    expect(generated).toBeGreaterThan(scaled(1500) * 0.25)
    expect(withLayout).toBeGreaterThan(scaled(1500) * 0.3)
    expect(refused).toBeLessThan(scaled(1500) * 0.2)
  })
})
