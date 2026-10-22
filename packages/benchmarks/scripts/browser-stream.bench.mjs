/**
 * Real-browser streaming benchmark (R13 / P0).
 *
 * Drives one append per animation frame through two engines on the identical
 * spec/rows and measures frame pacing, DOM mutations and node count:
 *
 * - `aster` — `<ChartStream>` with SVG and canvas, microtask and raf flush,
 * - `vega`  — a plain `vega.View` using the documented streaming API,
 *             `view.change('t', changeset().insert(rows)).run()` (synchronous)
 *             and `.runAsync()` (deferred), SVG and canvas renderers.
 *
 * The vega rows are the apples-to-apples baseline for the aster streaming
 * numbers in docs/PERFORMANCE.md.
 *
 * Run: pnpm bench:browser-stream [--points=10000,100000] [--seconds=3] [--batch=1]
 *                                [--engines=aster,vega] [--renderers=svg,canvas]
 *                                [--policies=microtask,raf] [--vega-modes=run,runAsync]
 *                                [--dense=0,1]   (aster SVG, `denseMarks` batching)
 */
import { build } from 'esbuild'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { summarize, table, fmt } from '../src/stats.js'
import { ensureBuilt } from '../src/ensure-built.ts'

const THIS_DIR = dirname(fileURLToPath(import.meta.url))
const PKG_DIR = dirname(THIS_DIR)
const OUT_DIR = join(PKG_DIR, '.tmp-browser-stream')
const argv = process.argv.slice(2)
const arg = (name, dflt) => argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? dflt

const POINTS = arg('points', '10000,100000').split(',').map(Number).filter((n) => n > 0)
const SECONDS = Number(arg('seconds', '3'))
const BATCH = Math.max(1, Number(arg('batch', '1')))
const ENGINES = arg('engines', 'aster,vega').split(',').filter(Boolean)
const RENDERERS = arg('renderers', 'svg,canvas').split(',')
const POLICIES = {
  aster: arg('policies', 'microtask,raf').split(','),
  vega: arg('vega-modes', 'run,runAsync').split(','),
}
// Dense SVG marks: batch symbol marks into chunked <path> elements (opt-in).
const DENSE = new Set(arg('dense', '0').split(',').filter((v) => v === '0' || v === '1'))

ensureBuilt()
rmSync(OUT_DIR, { recursive: true, force: true })
mkdirSync(OUT_DIR, { recursive: true })

await build({
  entryPoints: [join(PKG_DIR, 'src', 'browser-stream-entry.tsx')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  outfile: join(OUT_DIR, 'bench.js'),
  define: { 'process.env.NODE_ENV': '"production"' },
  jsx: 'automatic',
  logLevel: 'warning',
})

writeFileSync(
  join(OUT_DIR, 'index.html'),
  '<!doctype html><html><head><meta charset="utf-8"></head><body><script src="./bench.js"></script></body></html>',
)

const browser = await chromium.launch({
  headless: true,
  args: ['--disable-dev-shm-usage', '--js-flags=--max-old-space-size=4096'],
})
const page = await browser.newPage()
page.on('pageerror', (e) => console.error('[page]', e.message))
await page.goto(`file://${join(OUT_DIR, 'index.html')}`)
await page.waitForFunction(() => '__streamBench' in window, null, { timeout: 30_000 })

const out = []
for (const points of POINTS) {
  for (const engine of ENGINES) {
    for (const renderer of RENDERERS) {
      for (const policy of POLICIES[engine]) for (const dense of engine === 'aster' && renderer === 'svg' ? DENSE : ['0']) {
        await page.evaluate(() => window.__streamBench.reset())
        const r = await page.evaluate(
          ([p, s, b, rr, pp, ee, dd]) => window.__streamBench.frames(p, s, b, rr, pp, ee, dd === '1'),
          [points, SECONDS, BATCH, renderer, policy, engine, dense],
        )
        const ft = r.frameTimes
        const long = ft.filter((t) => t > 21).length
        const summary = summarize(ft)
        const expectedRows = points + r.updates * BATCH
        // Vega reports its final dataset length: a dropped change would look
        // fast for doing less work, so surface it instead of silently ranking it.
        if (r.rows != null && r.rows !== expectedRows) {
          console.error(`  [warn] vega dataset has ${r.rows} rows, expected ${expectedRows}`)
        }
        out.push({
          points, engine, renderer, policy, dense,
          median: summary.median, p95: summary.p95,
          longShare: ft.length ? long / ft.length : 0,
          frames: ft.length, updates: r.updates, mutations: r.mutations, nodes: r.nodes,
        })
        await page.evaluate(() => window.__streamBench.reset())
        console.log(`  ${engine}/${renderer}/${policy}${dense === '1' ? '/dense' : ''} @ ${points}: ${fmt(summary.median)} ms median, ${((long / Math.max(1, ft.length)) * 100).toFixed(1)}% long (${r.updates} appends, ${r.svgNodes} paths)`)
      }
    }
  }
}

await browser.close()
rmSync(OUT_DIR, { recursive: true, force: true })

console.log(
  table(
    `streaming append ${BATCH}/frame for ${SECONDS}s — aster vs vega view.change`,
    ['points', 'engine', 'backend', 'flush', 'dense', 'median frame', 'p95 frame', 'long >21ms', 'appends', 'mut/append', 'DOM nodes'],
    out.map((r) => [
      String(r.points), r.engine, r.renderer, r.policy, r.dense === '1' ? 'yes' : 'no',
      `${fmt(r.median)} ms`, `${fmt(r.p95)} ms`,
      `${(r.longShare * 100).toFixed(1)}%`,
      String(r.updates),
      fmt(r.mutations / Math.max(1, r.updates), 1),
      String(r.nodes),
    ]),
  ),
)
