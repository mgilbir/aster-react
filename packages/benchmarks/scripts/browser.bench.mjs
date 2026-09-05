/**
 * Real-browser benchmark driver: builds the in-page bench API with esbuild,
 * runs it in headless Chromium via Playwright, and reports
 * time-to-first-render, update latency, frame pacing under a 1-update/frame
 * stream, prop resize, and container resize.
 *
 * Run: pnpm bench:browser [--points=1000] [--kind=line] [--seconds=3]
 * Requires: chromium available to playwright (npx playwright install chromium)
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
const OUT_DIR = join(PKG_DIR, '.tmp-browser')
const argv = process.argv.slice(2)
const arg = (name, dflt) => argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? dflt

const POINTS = Number(arg('points', '1000'))
const KINDS = arg('kind', 'line,scatter,bar').split(',')
const REPS = Number(arg('reps', '9'))
const SECONDS = Number(arg('seconds', '3'))
const MEMORY = arg('memory', 'true') === 'true'

ensureBuilt()

const EMBEDS = ['aster', 'asterDom', 'reactVega', 'embedHook']

rmSync(OUT_DIR, { recursive: true, force: true })
mkdirSync(OUT_DIR, { recursive: true })

await build({
  entryPoints: [join(PKG_DIR, 'src', 'browser-entry.ts')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  outfile: join(OUT_DIR, 'bench.js'),
  define: { 'process.env.NODE_ENV': '"production"' },
  jsx: 'automatic',
  logLevel: 'warning',
  alias: {
    // exact paths so the addon subpaths (@aster/core/dom etc.) resolve
    '@aster/react': join(PKG_DIR, '..', 'react', 'dist', 'index.js'),
    '@aster/core': join(PKG_DIR, '..', 'core', 'dist', 'index.js'),
    '@aster/core/dom': join(PKG_DIR, '..', 'core', 'dist', 'addon-dom.js'),
    '@aster/core/geo': join(PKG_DIR, '..', 'core', 'dist', 'addon-geo.js'),
    '@aster/core/signals': join(PKG_DIR, '..', 'core', 'dist', 'signals.js'),
    '@aster/core/load': join(PKG_DIR, '..', 'core', 'dist', 'addon-load.js'),
    '@aster/core/transforms': join(PKG_DIR, '..', 'core', 'dist', 'addon-transforms.js'),
  },
})

writeFileSync(
  join(OUT_DIR, 'index.html'),
  `<!doctype html><html><head><meta charset="utf-8"><title>aster bench</title>
<style>html,body{margin:0;font:14px system-ui}#stage{padding:16px}</style></head>
<body><div id="stage"></div><script src="./bench.js"></script></body></html>`,
)

const browser = await chromium.launch({
  headless: true,
  // Container-safe: /dev/shm can be tiny where CI runs, and the JS heap of a
  // 100k-point scene page needs more than Chromium's conservative default.
  args: ['--disable-dev-shm-usage', '--js-flags=--max-old-space-size=4096'],
})
const page = await browser.newPage()
page.on('pageerror', (e) => console.error('[page]', e.message))
await page.goto(`file://${join(OUT_DIR, 'index.html')}`)
await page.waitForFunction(() => '__bench' in window, null, { timeout: 30_000 })

const cdp = MEMORY ? await page.context().newCDPSession(page) : null
if (cdp) {
  await cdp.send('Performance.enable')
  await cdp.send('HeapProfiler.enable')
}
async function heapMetrics() {
  if (!cdp) return { heapMB: NaN, nodes: 0, listeners: 0 }
  await cdp.send('HeapProfiler.collectGarbage')
  const { metrics } = await cdp.send('Performance.getMetrics')
  const get = (n) => metrics.find((m) => m.name === n)?.value ?? 0
  return { heapMB: get('JSHeapUsedSize') / 1024 / 1024, nodes: get('Nodes'), listeners: get('JSEventListeners') }
}

const results = {}
function put(key, embed, value) {
  results[key] ??= {}
  results[key][embed] = value
}

for (const kind of KINDS) for (const embed of EMBEDS) {
  console.log(`running ${embed} ${kind} ...`)
  await page.evaluate(([e, k, p]) => (window.__benchWarmup?.(e, k, p)), [embed, kind, POINTS])

  // 1) Time to first render (fresh mount each rep)
  const mounts = []
  for (let i = 0; i < REPS; i++) {
    await page.evaluate(() => window.__bench.reset())
    mounts.push(await page.evaluate(([e, k, p]) => window.__bench.mounts(e, k, p), [embed, kind, POINTS]))
  }
  put(`mount:${kind}`, embed, summarize(mounts))

  // 2) Update latency (median/p95 of settling each new data push)
  const updates = await page.evaluate(([e, k, p, r]) => window.__bench.updates(e, k, p, r), [embed, kind, POINTS, REPS])
  put(`update:${kind}`, embed, summarize(updates))

  // 3) Frame pacing: sustained one update per frame
  const { frameTimes } = await page.evaluate(([e, k, p, s]) => window.__bench.fps(e, k, p, s), [embed, kind, POINTS, SECONDS])
  const ft = frameTimes
  const long = ft.filter((t) => t > 21).length
  put(`fps:${kind}`, embed, { median: summarize(ft).median, p95: summarize(ft).p95, longShare: long / ft.length, frames: ft.length })

  // 4) Prop-driven resize latency
  const resizes = await page.evaluate(([e, k, p, r]) => window.__bench.resize(e, k, p, r), [embed, kind, POINTS, REPS])
  put(`resize:${kind}`, embed, summarize(resizes))

  // 5) Container-driven resize (host CSS width; does the svg follow?)
  const autos = await page.evaluate(([e, k, p]) => window.__bench.autoResize(e, k, p, [700, 500, 620, 540]), [embed, kind, POINTS])
  put(`autoResize:${kind}`, embed, { lags: autos, median: summarize(autos.filter((v) => v >= 0)).median ?? NaN, resized: autos.filter((v) => v >= 0).length, total: autos.length })

  // 6) DOM weight after last render
  put(`nodes:${kind}`, embed, await page.evaluate(() => window.__bench.domNodes()))

  // 7) Stable-content re-render (fresh spec object, same data arrays)
  {
    await page.evaluate(() => window.__bench.reset())
    const st = await page.evaluate(([e, k, p, r]) => window.__bench.stableRerenders(e, k, p, r), [embed, kind, POINTS, 7])
    put(`stable:${kind}`, embed, { ms: summarize(st.ms), mutations: st.mutations })
  }

  // 7b) Per-datum differential update (aster only): ~1% of points change, so the
  // reactive dataflow reuses unchanged items/DOM subtrees. Measures the real
  // browser O(changed) update vs the full re-encode in `updates`.
  {
    await page.evaluate(() => window.__bench.reset())
    const diff = await page.evaluate(([e, p, r]) => window.__bench.differentialUpdates(e, p, r), [embed, POINTS, REPS])
    put(`diff:${kind}`, embed, summarize(diff))
  }
}

// 8) aster-internal stage decomposition (once, on the first kind)
if (KINDS.length > 0) {
  const stg = await page.evaluate(([k, p, r]) => window.__bench.stages(k, p, r), [KINDS[0], POINTS, 9])
  console.log(
    table(
      `aster pipeline stages per update (${KINDS[0]} @ ${POINTS} pts) — ms median`,
      ['stage', 'median'],
      [
        ['compile+evaluate', fmt(summarize(stg.evaluate).median, 2)],
        ['sceneToDomDesc', fmt(summarize(stg.desc).median, 2)],
        ['patchSceneDom (data changed: walk + writes)', fmt(summarize(stg.noopPatch).median, 2)],
        ['patchSceneDom (identical scene: walk + skips)', fmt(summarize(stg.patch).median, 2)],
        ['string mode end-to-end (render+innerHTML swap)', fmt(summarize(stg.stringPath).median, 2)],
      ],
    ),
  )
  console.log('')
}

// 8b) Synchronous differential staging: isolates the dataflow (evaluateChart +
// patchSceneDom) for the differential path against the full re-encode, without
// the settle protocol that dominates the React-level metric.
if (KINDS.length > 0) {
  const dg = await page.evaluate(([p, r]) => window.__bench.differentialStages(p, r), [POINTS, 9])
  console.log(
    table(
      `differential staging (fixed-scale symbol @ ${POINTS} pts, ~1% changed) — ms median`,
      ['path', 'full', 'differential', 'speedup'],
      [
        ['evaluateChart', fmt(summarize(dg.fullEval).median, 2), fmt(summarize(dg.diffEval).median, 2), `${(summarize(dg.fullEval).median / summarize(dg.diffEval).median).toFixed(1)}x`],
        ['patchSceneDom', fmt(summarize(dg.fullPatch).median, 2), fmt(summarize(dg.diffPatch).median, 2), `${(summarize(dg.fullPatch).median / summarize(dg.diffPatch).median).toFixed(1)}x`],
        ['evaluate + patch', fmt(summarize(dg.fullEval).median + summarize(dg.fullPatch).median, 2), fmt(summarize(dg.diffEval).median + summarize(dg.diffPatch).median, 2), `${((summarize(dg.fullEval).median + summarize(dg.fullPatch).median) / (summarize(dg.diffEval).median + summarize(dg.diffPatch).median)).toFixed(1)}x`],
      ],
    ),
  )
  console.log('')
}

// 9) Heap over a churn run: mount -> 30 updates -> unmount, x5
if (cdp) for (const kind of KINDS) for (const embed of EMBEDS) {
    await page.evaluate(() => window.__bench.reset())
    const t0 = await heapMetrics()
    for (let c = 0; c < 5; c++) {
      await page.evaluate(([e, k, p]) => (window.__benchWarmup?.(e, k, p)), [embed, kind, POINTS])
      await page.evaluate(([e, k, p, r]) => window.__bench.updates(e, k, p, r), [embed, kind, POINTS, 30])
      await page.evaluate(() => window.__bench.reset())
    }
    await page.waitForTimeout(500)
    const t1 = await heapMetrics()
    put(`heap:${kind}`, embed, { retainedMB: t1.heapMB - t0.heapMB, nodesAfter: t1.nodes })
  }

await browser.close()
rmSync(OUT_DIR, { recursive: true, force: true })

const ms = (s) => `${fmt(s.median)} / ${fmt(s.p95)}`
for (const kind of KINDS) {
  const g = (key, embed) => results[`${key}:${kind}`]?.[embed]
  console.log(
    table(
      `browser (${kind} @ ${POINTS} pts, ${REPS} reps) — ms median / p95`,
      ['embed', 'first render', 'update', 'prop resize'],
      EMBEDS.map((e) => [e, ms(g('mount', e)), ms(g('update', e)), ms(g('resize', e))]),
    ),
  )
  console.log('')
  console.log(
    table(
      'frame pacing under 1-update-per-frame stream',
      ['embed', 'median frame', 'p95 frame', 'long frames (>21ms)'],
      EMBEDS.map((e) => {
        const f = g('fps', e)
        return [e, `${fmt(f.median)} ms`, `${fmt(f.p95)} ms`, `${(f.longShare * 100).toFixed(1)}% (${f.frames} f)`]
      }),
    ),
  )
  console.log('')
  console.log(
    table(
      'container resize + DOM weight + stable-content re-render + heap after churn',
      ['embed', 'followed', 'lag (ms)', 'DOM nodes', 'stable-render ms', 'stable mutations/render', 'retained heap (MB)'],
      EMBEDS.map((e) => {
        const a = g('autoResize', e)
        const h2 = g('heap', e)
        const st = g('stable', e)
        const mutAvg = st ? st.mutations.reduce((x, y) => x + y, 0) / st.mutations.length : NaN
        return [
          e,
          a ? `${a.resized}/${a.total}` : '—',
          a && a.resized ? fmt(a.median) : '—',
          String(g('nodes', e) ?? '—'),
          st ? fmt(st.ms.median) : 'n/a',
          Number.isFinite(mutAvg) ? mutAvg.toFixed(1) : 'n/a',
          h2 ? fmt(h2.retainedMB, 2) : 'n/a',
        ]
      }),
    ),
  )
  console.log('')
  // Differential update: ~1% of points change, so aster's reactive dataflow
  // reuses unchanged items/DOM subtrees (only aster/asterDom use dataChanges).
  console.log(
    table(
      'differential update — ~1% points change (aster only)',
      ['embed', 'update (ms)'],
      ['aster', 'asterDom'].map((e) => {
        const d = g('diff', e)
        return [e, d ? `${fmt(d.median)} / ${fmt(d.p95)}` : 'n/a']
      }),
    ),
  )
  console.log('')
}
await browser.close()
rmSync(OUT_DIR, { recursive: true, force: true })

