/**
 * Transform microbenchmark: every transform over 100k rows.
 *
 * Pure dataflow cost (no scene, no DOM): `applyTransforms` over a fresh row set
 * per rep, reporting the median and p95 of `--reps` timed runs after a warm-up.
 * Used to compare two builds (same file, run against each dist) — the table is
 * what the transform-semantics work was held to (within 10% median and p95).
 *
 * Run: pnpm --filter @aster/benchmarks run bench:transforms [--rows=100000] [--reps=15] [--only=aggregate,window]
 */
import { performance } from 'node:perf_hooks'
import { ensureBuilt } from './ensure-built.js'
import { summarize, table, fmt } from './stats.js'

type Row = Record<string, unknown>

async function main(): Promise<void> {
  ensureBuilt()
  const argv = process.argv.slice(2)
  const arg = (n: string, d: string): string => argv.find((a) => a.startsWith(`--${n}=`))?.split('=')[1] ?? d
  const N = Number(arg('rows', '100000'))
  const reps = Math.max(5, Number(arg('reps', '15')))
  const only = arg('only', '').split(',').filter(Boolean)

  const core = await import('@aster/core')
  await import('@aster/core/transforms')
  const { applyTransforms, compileExpr } = core as unknown as {
    applyTransforms: (rows: Row[], t: unknown[], ctx: unknown, source?: string) => Row[]
    compileExpr: (e: string, rt: unknown) => unknown
  }
  const runtime: { scale: () => undefined; data: () => never[]; expr: (e: string) => unknown } = {
    scale: () => undefined,
    data: () => [],
    expr: (e: string) => compileExpr(e, runtime),
  }

  // deterministic data: 50 groups, numeric measures, a date column, a short array, a nested object
  const mk = (): Row[] => {
    let s = 12345
    const rnd = (): number => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
    return Array.from({ length: N }, (_, i) => ({
      i, g: 'g' + (i % 50), h: 'h' + (i % 7), v: Math.round(rnd() * 1000) / 10, w: rnd() * 100, q: i % 13 === 0 ? null : rnd() * 10,
      t: new Date(1.5e12 + i * 3.6e6), a: [i % 3, i % 5], o: { b: rnd() },
    }))
  }
  const lookupTable: Row[] = Array.from({ length: 50 }, (_, i) => ({ k: 'g' + i, label: 'Group ' + i, w: i }))
  const treeRows: Row[] = []
  const TN = 20000
  for (let i = 0; i < TN; i++) treeRows.push({ id: 'n' + i, p: i === 0 ? null : 'n' + Math.floor((i - 1) / 4), s: (i % 17) + 1 })

  interface Case { name: string; t: unknown[]; rows?: () => Row[] }
  const cases: Case[] = [
    { name: 'formula', t: [{ type: 'formula', expr: 'datum.v * 2 + datum.w', as: 'f' }] },
    { name: 'filter', t: [{ type: 'filter', expr: 'datum.v > 50' }] },
    { name: 'collect', t: [{ type: 'collect', sort: { field: ['g', 'v'], order: ['ascending', 'descending'] } }] },
    { name: 'aggregate (sum/mean/count by g)', t: [{ type: 'aggregate', groupby: ['g'], fields: ['v', 'w', null], ops: ['sum', 'mean', 'count'] }] },
    { name: 'aggregate (median/q1/q3/stdev by g)', t: [{ type: 'aggregate', groupby: ['g'], fields: ['v', 'v', 'v', 'w'], ops: ['median', 'q1', 'q3', 'stdev'] }] },
    { name: 'aggregate (min/max/argmin by g,h)', t: [{ type: 'aggregate', groupby: ['g', 'h'], fields: ['v', 'v', 'w'], ops: ['min', 'max', 'argmin'] }] },
    { name: 'aggregate (ci0/ci1 by g)', t: [{ type: 'aggregate', groupby: ['g'], fields: ['v', 'v'], ops: ['ci0', 'ci1'] }], rows: () => mk().slice(0, 5000) },
    { name: 'joinaggregate (mean by g)', t: [{ type: 'joinaggregate', groupby: ['g'], fields: ['v'], ops: ['mean'], as: ['m'] }] },
    { name: 'window (running sum by g)', t: [{ type: 'window', groupby: ['g'], sort: { field: 'i' }, ops: ['sum', 'row_number'], fields: ['v', null], as: ['cs', 'rn'] }] },
    { name: 'window (rank/lag by g)', t: [{ type: 'window', groupby: ['g'], sort: { field: 'v' }, ops: ['rank', 'lag'], fields: [null, 'v'], as: ['rk', 'lg'] }] },
    { name: 'window (sliding mean frame -2..2)', t: [{ type: 'window', sort: { field: 'i' }, ops: ['mean'], fields: ['v'], frame: [-2, 2], as: ['m'] }] },
    { name: 'pivot', t: [{ type: 'pivot', field: 'h', value: 'v', groupby: ['g'], op: 'sum' }] },
    { name: 'bin', t: [{ type: 'bin', field: 'v', extent: [0, 100], maxbins: 20, as: ['bin0', 'bin1'] }] },
    { name: 'timeunit (year, month, date)', t: [{ type: 'timeunit', field: 't', units: ['year', 'month', 'date'] }] },
    { name: 'timeunit (utc hours)', t: [{ type: 'timeunit', field: 't', units: ['year', 'month', 'date', 'hours'], timezone: 'utc' }] },
    { name: 'stack (by g)', t: [{ type: 'stack', groupby: ['g'], field: 'v', sort: { field: 'h' }, as: ['y0', 'y1'] }] },
    { name: 'impute (mean by g)', t: [{ type: 'impute', field: 'v', key: 'h', groupby: ['g'], method: 'mean' }] },
    { name: 'fold', t: [{ type: 'fold', fields: ['v', 'w'], as: ['key', 'value'] }] },
    { name: 'flatten', t: [{ type: 'flatten', fields: ['a'], as: ['e'] }] },
    { name: 'project', t: [{ type: 'project', fields: ['g', 'v', 'o.b'], as: ['g', 'v', 'b'] }] },
    { name: 'lookup (values)', t: [{ type: 'lookup', from: 'lk', key: 'k', fields: ['g'], values: ['label', 'w'], as: ['label', 'lw'] }] },
    { name: 'extent', t: [{ type: 'extent', field: 'v', signal: 'ext' }] },
    { name: 'identifier', t: [{ type: 'identifier', as: 'id' }] },
    { name: 'sample (1000)', t: [{ type: 'sample', size: 1000 }] },
    { name: 'pie', t: [{ type: 'pie', field: 'v' }] },
    { name: 'dotbin', t: [{ type: 'dotbin', field: 'v', groupby: ['g'], step: 0.5 }] },
    { name: 'quantile (by g)', t: [{ type: 'quantile', field: 'v', groupby: ['g'], step: 0.05 }] },
    { name: 'kde (by g, 200 steps)', t: [{ type: 'kde', field: 'v', groupby: ['g'], steps: 100 }], rows: () => mk().slice(0, 20000) },
    { name: 'regression (linear by g)', t: [{ type: 'regression', x: 'w', y: 'v', groupby: ['g'] }] },
    { name: 'regression (poly 3 by g)', t: [{ type: 'regression', x: 'w', y: 'v', groupby: ['g'], method: 'poly', order: 3 }], rows: () => mk().slice(0, 20000) },
    { name: 'loess (20k)', t: [{ type: 'loess', x: 'w', y: 'v', bandwidth: 0.05 }], rows: () => mk().slice(0, 20000) },
    { name: 'countpattern', t: [{ type: 'countpattern', field: 'g' }] },
    { name: 'stratify+treemap (20k nodes)', t: [{ type: 'stratify', key: 'id', parentKey: 'p' }, { type: 'treemap', field: 's', size: [800, 600] }], rows: () => treeRows.map((r) => ({ ...r })) },
    { name: 'stratify+pack (20k nodes)', t: [{ type: 'stratify', key: 'id', parentKey: 'p' }, { type: 'pack', field: 's', size: [800, 600] }], rows: () => treeRows.map((r) => ({ ...r })) },
    { name: 'stratify+partition (20k nodes)', t: [{ type: 'stratify', key: 'id', parentKey: 'p' }, { type: 'partition', field: 's', size: [800, 600] }], rows: () => treeRows.map((r) => ({ ...r })) },
  ]

  const out: string[][] = []
  for (const c of cases) {
    if (only.length && !only.some((o) => c.name.includes(o))) continue
    const data = (c.rows ?? mk)()
    const run = (): void => {
      const ctx = { runtime, signals: Object.create(null), datasets: (n: string) => (n === 'lk' ? lookupTable : undefined), hierarchies: new Map() }
      applyTransforms(data, c.t, ctx, 'src')
    }
    try { run(); run() } catch (e) { // warm-up; a build that lacks the transform/op is reported, not fatal
      out.push([c.name, String(data.length), 'unsupported', (e as Error).message.slice(0, 40), ''])
      continue
    }
    const samples: number[] = []
    for (let r = 0; r < reps; r++) {
      const t0 = performance.now()
      run()
      samples.push(performance.now() - t0)
    }
    const s = summarize(samples)
    out.push([c.name, String(data.length), fmt(s.median, 2), fmt(s.p95, 2), fmt(s.min, 2)])
  }
  console.log(table(`transform microbenchmark (${N} rows, ${reps} reps; ms)`, ['transform', 'rows', 'median', 'p95', 'min'], out))
}

main().catch((e) => { console.error(e); process.exit(1) })
