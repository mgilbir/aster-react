/**
 * Real-browser streaming benchmark (R13 / P0).
 *
 * Drives <ChartStream> with one append per animation frame and measures frame
 * pacing, DOM mutations and node count for SVG and canvas, with microtask and
 * requestAnimationFrame flush policies.
 *
 * Run: pnpm bench:browser-stream [--points=10000,100000] [--seconds=3] [--batch=1]
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
const RENDERERS = arg('renderers', 'svg,canvas').split(',')
const POLICIES = arg('policies', 'microtask,raf').split(',')

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
  for (const renderer of RENDERERS) {
    for (const policy of POLICIES) {
      await page.evaluate(() => window.__streamBench.reset())
      const r = await page.evaluate(
        ([p, s, b, rr, pp]) => window.__streamBench.frames(p, s, b, rr, pp),
        [points, SECONDS, BATCH, renderer, policy],
      )
      const ft = r.frameTimes
      const long = ft.filter((t) => t > 21).length
      const summary = summarize(ft)
      out.push({
        points, renderer, policy,
        median: summary.median, p95: summary.p95,
        longShare: ft.length ? long / ft.length : 0,
        frames: ft.length, updates: r.updates, mutations: r.mutations, nodes: r.nodes,
      })
      await page.evaluate(() => window.__streamBench.reset())
      console.log(`  ${renderer}/${policy} @ ${points}: ${fmt(summary.median)} ms median, ${((long / Math.max(1, ft.length)) * 100).toFixed(1)}% long`)
    }
  }
}

await browser.close()
rmSync(OUT_DIR, { recursive: true, force: true })

console.log(
  table(
    `streaming <ChartStream> — append ${BATCH}/frame for ${SECONDS}s`,
    ['points', 'backend', 'flush', 'median frame', 'p95 frame', 'long >21ms', 'updates', 'mutations', 'DOM nodes'],
    out.map((r) => [
      String(r.points), r.renderer, r.policy,
      `${fmt(r.median)} ms`, `${fmt(r.p95)} ms`,
      `${(r.longShare * 100).toFixed(1)}%`,
      String(r.updates), String(r.mutations), String(r.nodes),
    ]),
  ),
)
