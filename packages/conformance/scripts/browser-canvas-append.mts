/**
 * Chromium pixel oracle for incremental canvas painting.
 *
 * `renderSceneToCanvasAppend` paints only the appended marks on top of the
 * previous frame; the contract is that the canvas then shows exactly what a
 * full repaint of the new scene shows. This renders random scene sequences
 * (session and stream drivers: appends together with in-place edits of other
 * datasets, grown data domains that change guides, legends and titles painted
 * above the marks) to two real canvases - one painted the way <Chart> does
 * (append when the renderer accepts it, else clear + full repaint) and one fully
 * repainted from a scene built from scratch - and compares every pixel after
 * every step. Z-order, ghosting of a changed guide and graphics-state drift are
 * all visible here, which a recorded draw list cannot see.
 *
 * Run standalone: npx tsx scripts/browser-canvas-append.mts [--seeds=60] [--steps=14]
 * It is also run by `pnpm conformance:canvas` (gate `canvas`, which floors the append-path frames: a renderer that never
 * takes the append path compares a full repaint with a full repaint and proves nothing). It reads the core sources.
 */
import { writeFileSync, rmSync, mkdirSync, mkdtempSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { cli } from '../../../scripts/lib/cli.mjs'
import { GATE_FLAGS, intOption, runGate } from '../../../scripts/lib/run-gate.mjs'

const THIS_DIR = dirname(fileURLToPath(import.meta.url))
const CONF_DIR = dirname(THIS_DIR)
const CORE_SRC = join(CONF_DIR, '..', 'core', 'src')

/** One case per scenario (`error` when a step differs from a full repaint), and the frames the append path painted. */
export interface AppendOracleResult { cases: Array<{ name: string; error?: string }>; appended: number }

export async function runAppendPixelOracle(
  browserName: 'chromium' | 'firefox' | 'webkit' = 'chromium',
  seeds = 60,
  steps = 14,
  plant = false,
): Promise<AppendOracleResult> {
  const OUT_DIR = mkdtempSync(join(CONF_DIR, '.tmp-browser-canvas-append-')) // (one directory per run: concurrent runs do not clobber each other)
  rmSync(OUT_DIR, { recursive: true, force: true })
  mkdirSync(OUT_DIR, { recursive: true })
  const entry = `
// (core's modules read the parts of the engine from slots the public entries fill: this page imports the modules, so the parts too)
import { installAllParts } from ${JSON.stringify(join(CORE_SRC, 'install-parts.testlib.ts'))}
installAllParts()
import { canvasScenario } from ${JSON.stringify(join(CORE_SRC, 'canvas-append-scenario.testlib.ts'))}
import { renderSceneToCanvas, renderSceneToCanvasAppend, snapshotCanvasScene } from ${JSON.stringify(join(CORE_SRC, 'canvas.ts'))}

// Both canvases are software-backed (willReadFrequently). This oracle reads live back after EVERY
// step but ref only once, and WebKit rasterises the same draw commands differently once a canvas
// has been read back (anti-aliased edges differ, e.g. 76 pixels of two overlapping 1px rules; replaying
// the recorded command streams with and without a mid-stream getImageData reproduces it with no Aster
// code involved). Giving both canvases one backing removes that browser artefact and keeps the
// comparison strict: any real append/full-repaint difference still fails (verified by planting one).
const RF = { willReadFrequently: true }
function mk(scene) {
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(scene.width)); c.height = Math.max(1, Math.round(scene.height))
  return c
}
function fullPaint(canvas, scene) {
  const ctx = canvas.getContext('2d', RF)
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  renderSceneToCanvas(scene, ctx, { dpr: 1 })
}

window.__runAppend = (seed, steps, driver, plant) => {
  let live = null, snap = null, appended = 0
  for (const st of canvasScenario(seed, steps, driver)) {
    if (live == null) live = mk(st.scene)
    if (live.width !== Math.round(st.scene.width) || live.height !== Math.round(st.scene.height)) { live = mk(st.scene); snap = null }
    let how = 'full repaint'
    if (snap != null && renderSceneToCanvasAppend(snap, st.scene, live.getContext('2d', RF), { dpr: 1 })) { how = 'append path'; appended++ }
    else fullPaint(live, st.scene)
    snap = snapshotCanvasScene(st.scene)
    // (--plant-difference: a 3x3 black mark the full repaint does not have)
    if (plant) { const g = live.getContext('2d', RF); g.fillStyle = '#000'; g.fillRect(1, 1, 3, 3) }
    const ref = mk(st.scene)
    fullPaint(ref, st.fresh())
    if (ref.width !== live.width || ref.height !== live.height) return { appended, error: 'step ' + st.step + ': canvas size differs from the fresh scene (' + live.width + 'x' + live.height + ' vs ' + ref.width + 'x' + ref.height + ')' }
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
    if (bad) return { appended, error: 'step ' + st.step + ' after ops ' + st.ops.join(',') + ' (' + how + '): ' + bad + ' pixel(s) differ from a full repaint, in [' + x1 + ',' + y1 + ' - ' + x2 + ',' + y2 + ']' }
  }
  return { appended }
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
  const pageErrors: string[] = []
  page.on('pageerror', (e) => pageErrors.push(e.message.slice(0, 200)))
  await page.goto(`file://${join(OUT_DIR, 'index.html')}`)
  await page.waitForFunction(() => '__runAppend' in window, null, { timeout: 30_000 })
  const cases: AppendOracleResult['cases'] = []
  let appended = 0
  try {
    for (const driver of ['session', 'stream'] as const) {
      for (let seed = 1; seed <= seeds; seed++) {
        const r = await page.evaluate(
          ([s, n, d, p]) => (window as unknown as { __runAppend: (s: number, n: number, d: string, p: boolean) => { appended: number; error?: string } }).__runAppend(s as number, n as number, d as string, p as boolean),
          [seed, steps, driver, plant] as const,
        )
        appended += r.appended
        const errors = [...(r.error ? [r.error] : []), ...pageErrors.splice(0).map((m) => `page error: ${m}`)]
        cases.push({ name: `${driver} seed=${seed}`, ...(errors.length ? { error: errors.join('; ') } : {}) })
      }
    }
  } finally {
    await browser.close()
    rmSync(OUT_DIR, { recursive: true, force: true })
  }
  return { cases, appended }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  cli({ url: import.meta.url, flags: { browser: 'eq', seeds: 'eq', steps: 'eq', ...GATE_FLAGS } })
  const argv = process.argv.slice(2)
  const raw = (n: string): string | undefined => argv.find((a) => a.startsWith(`--${n}=`))?.split('=')[1]
  const seeds = intOption(raw('seeds'), '--seeds', 60, { min: 1 })
  const steps = intOption(raw('steps'), '--steps', 14, { min: 1 })
  await runGate({
    name: 'canvas-append',
    counters: { scenarios: { floor: 2 * seeds, what: 'scenarios run' }, 'append-frames': { floor: 1, what: 'frames painted by the append path' } },
    reads: [],
    run: async (gate) => {
      const res = await runAppendPixelOracle((raw('browser') ?? 'chromium') as 'chromium', seeds, steps, gate.plant)
      for (const c of res.cases) if (c.error) gate.differ(c.name, c.error); else gate.agree(c.name)
      gate.count('append-frames', res.appended)
    },
  })
}
