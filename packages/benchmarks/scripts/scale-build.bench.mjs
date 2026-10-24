/**
 * buildScale microbenchmark: one scale of every type built 10k times (spec ->
 * built scale, domain included), per-iteration median / p95 in microseconds.
 *
 *   node scripts/scale-build.bench.mjs [--dist=<dir with index.js>] [--iters=10000] [--rows=200]
 *
 * `--dist` points at another build of @aster/core (the base of a comparison); the
 * default is this workspace's build. Run it with `pnpm --filter @aster/core build`
 * done first.
 */
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const arg = (name, dflt) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? dflt
const dist = arg('dist', join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'core', 'dist'))
const ITERS = Number(arg('iters', '10000'))
const ROWS = Number(arg('rows', '200'))
const { buildScale } = await import(join(dist, 'index.js'))

const rows = Array.from({ length: ROWS }, (_, i) => ({ v: ((i * 37) % 101) + 1, c: 'cat' + (i % 12), t: Date.UTC(2020, 0, 1) + i * 86400000, n: i % 17 }))
const col = (f) => rows.map((r) => r[f])
const ctx = (extra = {}) => ({
  width: 400, height: 300, signals: Object.create(null), dataField: (_d, f) => col(f), dataRows: () => rows, hasData: () => true,
  distinctCache: new WeakMap(), ...extra,
})
const dom = (f, extra = {}) => ({ data: 'd', field: f, ...extra })
const SPECS = {
  'linear': { type: 'linear', domain: dom('v'), range: 'width', zero: true, nice: true },
  'linear-literal': { type: 'linear', domain: [0, 100], range: [0, 400] },
  'log': { type: 'log', domain: dom('v'), range: 'height' },
  'pow': { type: 'pow', exponent: 2, domain: dom('v'), range: 'width' },
  'sqrt': { type: 'sqrt', domain: dom('v'), range: 'width' },
  'symlog': { type: 'symlog', domain: dom('v'), range: 'width' },
  'time': { type: 'time', domain: dom('t'), range: 'width', nice: true },
  'utc': { type: 'utc', domain: dom('t'), range: 'width' },
  'sequential-scheme': { type: 'linear', domain: dom('v'), range: { scheme: 'viridis' } },
  'diverging-scheme': { type: 'linear', domain: dom('v'), range: { scheme: 'redblue' }, domainMid: 50 },
  'color-array-hcl': { type: 'linear', domain: dom('v'), range: ['#fee', '#a00', '#300'], interpolate: 'hcl' },
  'quantile': { type: 'quantile', domain: dom('v'), range: { scheme: 'blues', count: 5 } },
  'quantize': { type: 'quantize', domain: dom('v'), range: { scheme: 'blues' } },
  'threshold': { type: 'threshold', domain: [25, 50, 75], range: ['a', 'b', 'c', 'd'] },
  'bin-ordinal': { type: 'bin-ordinal', domain: [0, 25, 50, 75, 100], range: ['a', 'b', 'c', 'd'] },
  'ordinal-data': { type: 'ordinal', domain: dom('c'), range: { scheme: 'category20' } },
  'ordinal-sorted': { type: 'ordinal', domain: dom('c', { sort: { op: 'sum', field: 'n', order: 'descending' } }), range: { scheme: 'tableau10' } },
  'band': { type: 'band', domain: dom('c'), range: 'width', padding: 0.1, round: true },
  'point': { type: 'point', domain: dom('c'), range: 'width', padding: 0.5 },
  'identity': { type: 'identity', domain: [0, 1] },
}

const pct = (a, p) => a[Math.min(a.length - 1, Math.floor(a.length * p))]
const out = {}
for (const [name, spec] of Object.entries(SPECS)) {
  const def = { name: 's', ...spec }
  for (let i = 0; i < 500; i++) buildScale(def, ctx()) // warm-up
  const ts = new Float64Array(ITERS)
  for (let i = 0; i < ITERS; i++) {
    const c = ctx()
    const t0 = performance.now()
    buildScale(def, c)
    ts[i] = performance.now() - t0
  }
  const s = Array.from(ts).sort((a, b) => a - b)
  out[name] = { median_us: +(pct(s, 0.5) * 1000).toFixed(2), p95_us: +(pct(s, 0.95) * 1000).toFixed(2) }
}
console.log(JSON.stringify(out))
