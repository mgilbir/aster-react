/**
 * Chromium oracle for batched symbol runs on a canvas.
 *
 * A dense scatter is painted as one path per run of identically-painted symbols. Blink measures the whole
 * path on every `closePath`, so closing 100k squares one by one in a single growing path took 17 s (crosses
 * 67 s, circles, which never close, 0.2 s). A browser context therefore gets every closed symbol as a small
 * `Path2D` added to the run's path. This gate checks the two things that must hold for that:
 *
 *   - PIXELS: the same pixels as the plain way (the symbols traced straight onto the context's own path,
 *     which is what any other context still gets and what Aster drew before), over every built-in shape and
 *     two custom ones, solid, stroked, dashed, translucent and blended paints, three sizes and NaN positions;
 *   - TIME: a 100k scatter of each closed shape paints in a few hundred milliseconds, not tens of seconds.
 *
 * The plain way is reached by handing the renderer a stand-in that forwards to the real context but is not
 * an instance of it, so the renderer cannot take the Path2D route.
 *
 * Run standalone: npx tsx scripts/browser-canvas-symbols.mts [--browser=chromium]
 * It is also run by `pnpm conformance:canvas` (gate `canvas`).
 */
import { writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const THIS_DIR = dirname(fileURLToPath(import.meta.url))
const CONF_DIR = dirname(THIS_DIR)
const CORE_SRC = join(CONF_DIR, '..', 'core', 'src')

export interface SymbolRunResult { cases: number; withInk: number; failures: string[]; timings: Array<{ shape: string; ms: number }> }

/** The slowest a 100k scatter may take: tens of seconds before the fix, a few hundred milliseconds after. */
const SCATTER_LIMIT_MS = 5000

export async function runSymbolRunOracle(browserName: 'chromium' | 'firefox' | 'webkit' = 'chromium'): Promise<SymbolRunResult> {
  const OUT_DIR = join(CONF_DIR, '.tmp-browser-canvas-symbols')
  rmSync(OUT_DIR, { recursive: true, force: true })
  mkdirSync(OUT_DIR, { recursive: true })
  const entry = `
import { renderSceneToCanvas } from ${JSON.stringify(join(CORE_SRC, 'canvas.ts'))}

const W = 400, H = 300
const sceneOf = (items) => ({ width: W, height: H, padding: { top: 0, right: 0, bottom: 0, left: 0 }, items: [{ marktype: 'symbol', items }] })

/** Forwards to the real context, but is not an instance of it: the renderer gives it the symbols on its own path. */
function plain(real) {
  return new Proxy({}, {
    get: (_t, k) => { const v = real[k]; return typeof v === 'function' ? v.bind(real) : v },
    set: (_t, k, v) => { real[k] = v; return true },
  })
}

function scatter(n, shape, size, paint, seed) {
  let s = seed
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296)
  const items = []
  for (let i = 0; i < n; i++) items.push({ x: rnd() * (W - 20) + 10, y: i % 97 === 0 ? NaN : rnd() * (H - 20) + 10, size, shape, ...paint })
  return items
}

window.__same = (shape, size, paint, n, seed) => {
  const items = scatter(n, shape, size, paint, seed)
  const a = document.createElement('canvas'), b = document.createElement('canvas')
  a.width = b.width = W; a.height = b.height = H
  const A = a.getContext('2d', { willReadFrequently: true }), B = b.getContext('2d', { willReadFrequently: true })
  renderSceneToCanvas(sceneOf(items), A)
  renderSceneToCanvas(sceneOf(items), plain(B))
  const da = A.getImageData(0, 0, W, H).data, db = B.getImageData(0, 0, W, H).data
  let diff = 0, ink = 0
  for (let i = 0; i < da.length; i++) { if (da[i] !== db[i]) diff++; if (da[i + 3 - (i % 4)]) ink++ }
  return { diff, ink }
}

window.__time = (shape, n) => {
  const items = scatter(n, shape, 30, { fill: '#4c78a8', stroke: null, strokeWidth: 0, opacity: 0.7 }, 99)
  const c = document.createElement('canvas'); c.width = 800; c.height = 600
  const ctx = c.getContext('2d')
  const t0 = performance.now()
  renderSceneToCanvas(sceneOf(items), ctx)
  ctx.getImageData(0, 0, 1, 1)
  return performance.now() - t0
}
`
  writeFileSync(join(OUT_DIR, 'entry.ts'), entry)
  await build({
    entryPoints: [join(OUT_DIR, 'entry.ts')],
    bundle: true, format: 'iife', platform: 'browser', outfile: join(OUT_DIR, 'page.js'),
    define: { 'process.env.NODE_ENV': '"production"' },
    banner: { js: 'var process = { env: { NODE_ENV: "production" } };' },
    logLevel: 'silent',
  })
  writeFileSync(join(OUT_DIR, 'index.html'), '<!doctype html><html><body><script src="./page.js"></script></body></html>')
  const playwright = await import('playwright')
  const browser = await playwright[browserName].launch({ headless: true, args: browserName === 'chromium' ? ['--disable-dev-shm-usage'] : [] })
  const page = await browser.newPage({ deviceScaleFactor: 1 })
  page.on('pageerror', (e) => console.error('[page]', e.message.slice(0, 200)))
  await page.goto(`file://${join(OUT_DIR, 'index.html')}`)
  await page.waitForFunction(() => '__same' in window, null, { timeout: 30_000 })

  const shapes = ['circle', 'square', 'cross', 'diamond', 'triangle-up', 'triangle-down', 'triangle-left', 'triangle-right', 'stroke', 'arrow', 'wedge', 'triangle',
    'M-1,-1L1,-1L1,1L-1,1Z', 'M-1,-1 A1,1 0 0 1 1,-1 Z', 'M-1,-1L1,-1L0,1']
  const paints: Array<Record<string, unknown>> = [
    { fill: '#4c78a8', stroke: null, opacity: 0.7 },
    { fill: null, stroke: '#e45756', strokeWidth: 2, opacity: 1 },
    { fill: '#4c78a8', stroke: '#222', strokeWidth: 1.5, opacity: 0.6, fillOpacity: 0.8, strokeOpacity: 0.5 },
    { fill: null, stroke: '#e45756', strokeWidth: 3, strokeJoin: 'round', strokeCap: 'round', strokeDash: [4, 2], strokeDashOffset: 1, opacity: 1 },
    { fill: null, stroke: '#000', strokeWidth: 4, strokeJoin: 'miter', strokeMiterLimit: 10, opacity: 0.5 },
    { fill: '#0a0', stroke: null, opacity: 1, blend: 'multiply' },
  ]
  const failures: string[] = []
  let cases = 0
  let withInk = 0
  for (const shape of shapes) for (const size of [30, 400, 2]) for (let p = 0; p < paints.length; p++) for (const n of [300, 3000]) {
    cases++
    const r = await page.evaluate(([sh, sz, pt, nn]) => (window as unknown as { __same: (...a: unknown[]) => { diff: number; ink: number } }).__same(sh, sz, pt, nn, 777), [shape, size, paints[p], n] as const)
    if (r.ink) withInk++
    if (r.diff) failures.push(`${shape} size=${size} paint#${p} n=${n}: ${r.diff} channel value(s) differ from the plain path`)
  }
  const timings: Array<{ shape: string; ms: number }> = []
  for (const shape of ['square', 'cross', 'diamond', 'triangle-up', 'arrow', 'wedge', 'M-1,-1L1,-1L1,1L-1,1Z', 'circle']) {
    const ms = await page.evaluate(([sh]) => (window as unknown as { __time: (s: string, n: number) => number }).__time(sh as string, 100_000), [shape] as const)
    timings.push({ shape, ms: Math.round(ms) })
    if (ms > SCATTER_LIMIT_MS) failures.push(`${shape}: 100000 symbols took ${Math.round(ms)} ms (limit ${SCATTER_LIMIT_MS})`)
  }
  await browser.close()
  rmSync(OUT_DIR, { recursive: true, force: true })
  return { cases, withInk, failures, timings }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = process.argv.slice(2)
  const arg = (n: string, d: string): string => argv.find((a) => a.startsWith(`--${n}=`))?.split('=')[1] ?? d
  const res = await runSymbolRunOracle(arg('browser', 'chromium') as 'chromium')
  console.log(`[browser-canvas-symbols] ${res.cases} cases (${res.withInk} with ink), ${res.failures.length} failing; 100k scatter ms: ${res.timings.map((t) => `${t.shape}=${t.ms}`).join(' ')}`)
  for (const f of res.failures.slice(0, 20)) console.log('  ' + f)
  process.exit(res.failures.length ? 1 : 0)
}
