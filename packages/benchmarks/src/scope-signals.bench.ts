/**
 * Scoped derived signals (C483): a group mark's `signals`, one set per group item, evaluated for every item of a 200-cell view.
 *
 * `evaluateChart` over a spec whose group mark has a cell per row and N signals of its own that read each other: a forward chain
 * (each reads the one before), the same chain declared in reverse, and a diamond-shaped fan (every signal reads two before it).
 * Reports the median and p95 of `--reps` timed runs, cold (the first evaluation of a compiled chart) and warm (the next ones).
 * Compare two builds with `--core=<dist/index.js of the other build>`; `--control` times a spec with no scoped signals, which
 * the change does not touch.
 *
 * Run: pnpm --filter @aster-charts/benchmarks run bench:scope-signals [--cells=200] [--reps=15] [--core=/path/to/dist/index.js]
 */
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'
import { ensureBuilt } from './ensure-built.js'
import { summarize, table, fmt } from './stats.js'
import { cli } from '../../../scripts/lib/cli.mjs'

cli({ url: import.meta.url, flags: { cells: 'eq', reps: 'eq', core: 'eq' } })

type Spec = Record<string, unknown>

const arg = (n: string, d: string): string => process.argv.slice(2).find((a) => a.startsWith(`--${n}=`))?.split('=')[1] ?? d

/** The view: a group mark with a cell per row, N signals in each cell, and a text that reads the last. */
export function scopedSpec(shape: 'forward' | 'reverse' | 'fan' | 'none', signals: number, cells: number): Spec {
  const at = (i: number): string => (shape === 'reverse' ? `s${signals - 1 - i}` : `s${i}`)
  const list = Array.from({ length: shape === 'none' ? 0 : signals }, (_, i) => {
    const read = (j: number): string => at(Math.max(0, j))
    const update = i === 0 ? 'parent.i' : shape === 'fan' ? `${read(i - 1)} + ${read(i - 2)} + 1` : `${read(i - 1)} + 1`
    return { name: at(i), update }
  })
  // (the reverse chain is declared last-reader first: s0 reads s1, s1 reads s2 ... s{n-1} reads parent)
  const declared = shape === 'reverse' ? list.map((d, i) => ({ name: d.name, update: i === 0 ? 'parent.i' : `${at(i - 1)} + 1` })).reverse() : list
  const last = shape === 'none' ? 'parent.i' : at(signals - 1)
  return {
    width: 200, height: 100, padding: 0, autosize: 'none',
    data: [{ name: 't', values: Array.from({ length: cells }, (_, i) => ({ i })) }],
    marks: [{ type: 'group', from: { data: 't' }, ...(declared.length ? { signals: declared } : {}), marks: [{ type: 'text', encode: { update: { text: { signal: last } } } }] }],
  }
}

async function main(): Promise<void> {
  ensureBuilt()
  const cells = Number(arg('cells', '200'))
  const reps = Math.max(5, Number(arg('reps', '15')))
  const given = arg('core', '')
  const core = (await import(given ? pathToFileURL(given).href : '@aster-charts/core')) as typeof import('@aster-charts/core')
  const out: string[][] = []
  for (const shape of ['none', 'forward', 'reverse', 'fan'] as const) {
    for (const n of shape === 'none' ? [0] : [10, 40, 80, 160]) {
      const spec = scopedSpec(shape, n, cells)
      let cold = Infinity
      const warm: number[] = []
      for (let r = 0; r < reps; r++) {
        const chart = core.compileChart(structuredClone(spec) as never)
        const t0 = performance.now()
        core.evaluateChart(chart)
        const t1 = performance.now()
        core.evaluateChart(chart)
        const t2 = performance.now()
        cold = Math.min(cold, t1 - t0)
        warm.push(t2 - t1)
      }
      const w = summarize(warm)
      out.push([shape === 'none' ? 'control (no scoped signals)' : `${shape} x ${n}`, String(cells), fmt(cold, 1), fmt(w.median, 1), fmt(w.p95, 1)])
    }
  }
  console.log(table(`scoped signals (${cells} cells, ${reps} reps; ms)`, ['shape', 'cells', 'cold min', 'warm median', 'warm p95'], out))
}
await main()
