/**
 * Chromium pixel oracle for the canvas frames that paint nothing.
 *
 * `paintsSameAs` says a scene paints exactly the pixels of the frame on the canvas (a signal changed only what is not painted, a
 * tooltip), and <Chart> then paints nothing; the contract is that the canvas then shows exactly what a full repaint of the new scene
 * shows. This drives random specs through random signal moves (a tooltip, a highlighted category, an opacity threshold, a size, a
 * moved item, a guide that reads the signal, now and then new rows) in a chart session, paints each scene to two real canvases --
 * one the way <Chart> does (the appended marks, else nothing when the pixels are the same, else a clear and a full repaint) and one
 * fully repainted from a scene evaluated afresh -- at device pixel ratios 1 and 2, and compares every pixel after every step.
 *
 * Run standalone: npx tsx scripts/browser-canvas-dirty.mts [--seeds=80] [--steps=14]
 * It is also run by `pnpm conformance:canvas` (gate `canvas`, which floors the frames <Chart> painted nothing for: if
 * `paintsSameAs` never held, every frame would be a full repaint compared with a full repaint). It reads the core sources.
 */
import { writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { cli } from '../../../scripts/lib/cli.mjs'
import { makeTempDir } from '../../../scripts/lib/temp-dir.mjs'
import { GATE_FLAGS, intOption, runGate } from '../../../scripts/lib/run-gate.mjs'
import { launchBrowser } from '../../../scripts/lib/launch-browser.mjs'

const THIS_DIR = dirname(fileURLToPath(import.meta.url))
const CONF_DIR = dirname(THIS_DIR)
const CORE_SRC = join(CONF_DIR, '..', 'core', 'src')

/** One case per scenario (`error` when a step differs from a full repaint), and how its frames were painted. */
export interface DirtyOracleResult { cases: Array<{ name: string; error?: string }>; untouched: number; repainted: number }

export async function runDirtyPixelOracle(
  browserName: 'chromium' | 'firefox' | 'webkit' = 'chromium',
  seeds = 80,
  steps = 14,
  plant = false,
): Promise<DirtyOracleResult> {
  const OUT_DIR = makeTempDir('.tmp-browser-canvas-dirty-', CONF_DIR) // (one directory per run: concurrent runs do not clobber each other)
  rmSync(OUT_DIR, { recursive: true, force: true })
  mkdirSync(OUT_DIR, { recursive: true })
  const entry = `
// (core's modules read the parts of the engine from slots the public entries fill: this page imports the modules, so the parts too)
import { installAllParts } from ${JSON.stringify(join(CORE_SRC, 'install-parts.testlib.ts'))}
installAllParts()
import { canvasDirtyScenario } from ${JSON.stringify(join(CORE_SRC, 'canvas-dirty-scenario.testlib.ts'))}
import { paintsSameAs, renderSceneToCanvas, renderSceneToCanvasAppend, snapshotCanvasScene } from ${JSON.stringify(join(CORE_SRC, 'canvas.ts'))}

// (both canvases software-backed, as in the append oracle: see browser-canvas-append.mts)
const RF = { willReadFrequently: true }
function mk(scene, dpr) {
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(scene.width * dpr)); c.height = Math.max(1, Math.round(scene.height * dpr))
  return c
}
function fullPaint(canvas, scene, dpr) {
  const ctx = canvas.getContext('2d', RF)
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  renderSceneToCanvas(scene, ctx, { dpr })
}

window.__runDirty = (seed, steps, dpr, plant) => {
  let live = null, snap = null, untouched = 0, repainted = 0
  for (const st of canvasDirtyScenario(seed, steps)) {
    if (live == null || live.width !== Math.round(st.scene.width * dpr) || live.height !== Math.round(st.scene.height * dpr)) { live = mk(st.scene, dpr); snap = null }
    const ctx = live.getContext('2d', RF)
    let how = 'full repaint'
    if (snap != null && renderSceneToCanvasAppend(snap, st.scene, ctx, { dpr })) how = 'append path'
    else if (snap != null && paintsSameAs(snap, st.scene)) { how = 'nothing painted'; untouched++ }
    else { if (snap != null) repainted++; fullPaint(live, st.scene, dpr) }
    snap = snapshotCanvasScene(st.scene)
    // (--plant-difference: a 3x3 black mark the full repaint does not have)
    if (plant) { ctx.fillStyle = '#000'; ctx.fillRect(1, 1, 3, 3) }
    const ref = mk(st.scene, dpr)
    fullPaint(ref, st.fresh(), dpr)
    if (ref.width !== live.width || ref.height !== live.height) return { untouched, repainted, error: 'step ' + st.step + ': canvas size differs from the fresh scene' }
    const a = live.getContext('2d', RF).getImageData(0, 0, live.width, live.height).data
    const b = ref.getContext('2d', RF).getImageData(0, 0, ref.width, ref.height).data
    let bad = 0, x1 = 1e9, y1 = 1e9, x2 = -1, y2 = -1
    for (let i = 0; i < a.length; i += 4) {
      if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3]) {
        bad++
        const p = i / 4, x = p % live.width, y = (p - x) / live.width
        if (x < x1) x1 = x; if (y < y1) y1 = y; if (x > x2) x2 = x; if (y > y2) y2 = y
      }
    }
    if (bad) return { untouched, repainted, error: 'dpr ' + dpr + ' step ' + st.step + ' (' + st.what + ', ' + how + '): ' + bad + ' pixel(s) differ from a full repaint, in [' + x1 + ',' + y1 + ' - ' + x2 + ',' + y2 + ']' }
  }
  return { untouched, repainted }
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
  const browser = await launchBrowser(playwright[browserName], { headless: true, args: browserName === 'chromium' ? ['--disable-dev-shm-usage'] : [] })
  const page = await browser.newPage({ deviceScaleFactor: 1 })
  const pageErrors: string[] = []
  page.on('pageerror', (e) => pageErrors.push(e.message.slice(0, 200)))
  await page.goto(`file://${join(OUT_DIR, 'index.html')}`)
  await page.waitForFunction(() => '__runDirty' in window, null, { timeout: 30_000 })
  const cases: DirtyOracleResult['cases'] = []
  let untouched = 0
  let repainted = 0
  try {
    for (const dpr of [1, 2]) {
      for (let seed = 1; seed <= seeds; seed++) {
        const r = await page.evaluate(
          ([s, n, d, p]) => (window as unknown as { __runDirty: (s: number, n: number, d: number, p: boolean) => { untouched: number; repainted: number; error?: string } }).__runDirty(s as number, n as number, d as number, p as boolean),
          [seed, steps, dpr, plant] as const,
        )
        untouched += r.untouched
        repainted += r.repainted
        const errors = [...(r.error ? [r.error] : []), ...pageErrors.splice(0).map((m) => `page error: ${m}`)]
        cases.push({ name: `dpr=${dpr} seed=${seed}`, ...(errors.length ? { error: errors.join('; ') } : {}) })
      }
    }
  } finally {
    await browser.close()
    rmSync(OUT_DIR, { recursive: true, force: true })
  }
  return { cases, untouched, repainted }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  cli({ url: import.meta.url, flags: { browser: 'eq', seeds: 'eq', steps: 'eq', ...GATE_FLAGS } })
  const argv = process.argv.slice(2)
  const raw = (n: string): string | undefined => argv.find((a) => a.startsWith(`--${n}=`))?.split('=')[1]
  const seeds = intOption(raw('seeds'), '--seeds', 80, { min: 1 })
  const steps = intOption(raw('steps'), '--steps', 14, { min: 1 })
  await runGate({
    name: 'canvas-dirty',
    counters: { scenarios: { floor: 2 * seeds, what: 'scenarios run' }, 'untouched-frames': { floor: 1, what: 'frames <Chart> painted nothing for' } },
    reads: [],
    run: async (gate) => {
      const res = await runDirtyPixelOracle((raw('browser') ?? 'chromium') as 'chromium', seeds, steps, gate.plant)
      for (const c of res.cases) if (c.error) gate.differ(c.name, c.error); else gate.agree(c.name)
      gate.count('untouched-frames', res.untouched)
      console.log(`[browser-canvas-dirty] ${res.cases.length} scenarios, ${res.untouched} frames that painted nothing, ${res.repainted} full repaints`)
    },
  })
}
