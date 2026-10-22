/**
 * Chromium pixel oracle for incremental canvas painting (audit C22).
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
 * It is also run by `pnpm conformance:canvas` (gate `canvas`).
 */
import { writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const THIS_DIR = dirname(fileURLToPath(import.meta.url))
const CONF_DIR = dirname(THIS_DIR)
const CORE_SRC = join(CONF_DIR, '..', 'core', 'src')

export interface AppendOracleResult { runs: number; appended: number; failures: string[] }

export async function runAppendPixelOracle(
  browserName: 'chromium' | 'firefox' | 'webkit' = 'chromium',
  seeds = 60,
  steps = 14,
): Promise<AppendOracleResult> {
  const OUT_DIR = join(CONF_DIR, '.tmp-browser-canvas-append')
  rmSync(OUT_DIR, { recursive: true, force: true })
  mkdirSync(OUT_DIR, { recursive: true })
  const entry = `
import { canvasScenario } from ${JSON.stringify(join(CORE_SRC, 'canvas-append-scenario.testlib.ts'))}
import { renderSceneToCanvas, renderSceneToCanvasAppend, snapshotCanvasScene } from ${JSON.stringify(join(CORE_SRC, 'canvas.ts'))}

function mk(scene) {
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(scene.width)); c.height = Math.max(1, Math.round(scene.height))
  return c
}
function fullPaint(canvas, scene) {
  const ctx = canvas.getContext('2d')
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  renderSceneToCanvas(scene, ctx, { dpr: 1 })
}

window.__runAppend = (seed, steps, driver) => {
  let live = null, snap = null, appended = 0
  for (const st of canvasScenario(seed, steps, driver)) {
    if (live == null) live = mk(st.scene)
    if (live.width !== Math.round(st.scene.width) || live.height !== Math.round(st.scene.height)) { live = mk(st.scene); snap = null }
    let how = 'full repaint'
    if (snap != null && renderSceneToCanvasAppend(snap, st.scene, live.getContext('2d'), { dpr: 1 })) { how = 'append path'; appended++ }
    else fullPaint(live, st.scene)
    snap = snapshotCanvasScene(st.scene)
    const ref = mk(st.scene)
    fullPaint(ref, st.fresh())
    if (ref.width !== live.width || ref.height !== live.height) return { appended, error: 'step ' + st.step + ': canvas size differs from the fresh scene (' + live.width + 'x' + live.height + ' vs ' + ref.width + 'x' + ref.height + ')' }
    const a = live.getContext('2d').getImageData(0, 0, live.width, live.height).data
    const b = ref.getContext('2d').getImageData(0, 0, ref.width, ref.height).data
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
  page.on('pageerror', (e) => console.error('[page]', e.message.slice(0, 200)))
  await page.goto(`file://${join(OUT_DIR, 'index.html')}`)
  await page.waitForFunction(() => '__runAppend' in window, null, { timeout: 30_000 })
  const failures: string[] = []
  let runs = 0
  let appended = 0
  for (const driver of ['session', 'stream'] as const) {
    for (let seed = 1; seed <= seeds; seed++) {
      runs++
      const r = await page.evaluate(
        ([s, n, d]) => (window as unknown as { __runAppend: (s: number, n: number, d: string) => { appended: number; error?: string } }).__runAppend(s as number, n as number, d as string),
        [seed, steps, driver] as const,
      )
      appended += r.appended
      if (r.error) failures.push(`${driver} seed=${seed}: ${r.error}`)
    }
  }
  await browser.close()
  rmSync(OUT_DIR, { recursive: true, force: true })
  return { runs, appended, failures }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = process.argv.slice(2)
  const arg = (n: string, d: string): string => argv.find((a) => a.startsWith(`--${n}=`))?.split('=')[1] ?? d
  const res = await runAppendPixelOracle(arg('browser', 'chromium') as 'chromium', Number(arg('seeds', '60')), Number(arg('steps', '14')))
  console.log(`[browser-canvas-append] ${res.runs} scenarios, ${res.appended} append-path frames, ${res.failures.length} failing`)
  for (const f of res.failures.slice(0, 20)) console.log('  ' + f)
  process.exit(res.failures.length ? 1 : 0)
}
