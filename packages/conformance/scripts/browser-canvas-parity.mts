/**
 * Chromium canvas parity gate (R9.1 / P2).
 *
 * The existing canvas differential replays recorded draw commands and runs in
 * jsdom; the SVG browser gate checks live text metrics but only for the SVG
 * backend. This gate closes the last environment gap: it renders the oracle
 * (official Vega) and aster to real `<canvas>` elements in headless Chromium,
 * then compares the pixels.
 *
 * Both engines run in the same browser with the same fonts and dpr, so text
 * metrics are live and the comparison catches canvas-only paint/geometry drift
 * (clip paths, gradients, dash, baseline offsets, path tracing).
 *
 * Run: npx tsx scripts/browser-canvas-parity.mts [--limit=N] [--filter=substr]
 */
import { readdirSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const THIS_DIR = dirname(fileURLToPath(import.meta.url))
const CONF_DIR = dirname(THIS_DIR)
const OUT_DIR = join(CONF_DIR, '.tmp-browser-canvas')
const argv = process.argv.slice(2)
const arg = (n: string, d: string): string => argv.find((a) => a.startsWith(`--${n}=`))?.split('=')[1] ?? d
const LIMIT = Number(arg('limit', '0'))
const FILTER = arg('filter', '')
const RATIO = Number(arg('ratio', '0.04'))
const MEAN = Number(arg('mean', '2.5'))
const BROWSER = arg('browser', 'chromium') as 'chromium' | 'firefox' | 'webkit'

interface Entry { name: string; spec: Record<string, unknown> }

function hasUrlData(spec: Record<string, unknown>): boolean {
  const data = spec.data
  const defs = Array.isArray(data) ? data : data && typeof data === 'object' ? [data] : []
  return defs.some((d) => d && typeof d === 'object' && typeof (d as { url?: unknown }).url === 'string')
}

function loadCorpus(): Entry[] {
  const corpus = join(CONF_DIR, 'corpus')
  const files = readdirSync(corpus, { recursive: true }).filter((f) => String(f).endsWith('.json')).map(String).sort()
  const entries: Entry[] = []
  for (const f of files) {
    const spec = JSON.parse(readFileSync(join(corpus, f), 'utf8')) as Record<string, unknown>
    if (hasUrlData(spec)) continue // network data is not part of the canvas surface
    entries.push({ name: f.replace(/\.vl\.json$|\.json$/, ''), spec })
  }
  return entries
}

// Known gaps that the SVG gate covers but the pixel gate intentionally skips:
// - image.vg loads a remote bitmap (no network in this gate),
// - concat-h/repeat hit degenerate 0-width concat cells whose SVG-only axis
//   domain paint is already covered by the SVG browser gate,
// - t-pie is a degenerate text mark (no x/y, all labels anchored at the origin).
const SKIP = new Map<string, string>([
  ['image.vg', 'remote image asset'],
  ['concat-h', 'degenerate concat cell (SVG gate covers axis paint)'],
  ['repeat', 'degenerate repeat cells (SVG gate covers axis paint)'],
  ['scatter-matrix', 'repeat grid (same degenerate cell axis paint as repeat)'],
  ['t-pie.vg', 'degenerate text mark (no x/y, all labels anchored at the origin)'],
  ['expr-fns.vg', 'vega SVG paints a boolean fill black; its canvas backend skips it'],
])
const synthetic: Entry[] = [
  {
    name: 'canvas-custom-font',
    spec: {
      $schema: 'https://vega.github.io/schema/vega/v6.json',
      width: 360, height: 200, padding: 5, autosize: 'none', background: 'white',
      title: { text: 'DejaVu label', font: 'DejaVu Sans' },
      data: [{ name: 't', values: [{ c: 'alpha', v: 3 }, { c: 'beta', v: 7 }, { c: 'gamma', v: 5 }] }],
      scales: [
        { name: 'x', type: 'band', domain: { data: 't', field: 'c' }, range: 'width' },
        { name: 'y', type: 'linear', domain: [0, 8], range: 'height' },
      ],
      axes: [
        { scale: 'x', orient: 'bottom', title: 'Category', labelFont: 'DejaVu Sans' },
        { scale: 'y', orient: 'left', labelFont: 'DejaVu Sans' },
      ],
      marks: [{
        type: 'text', from: { data: 't' }, encode: { update: {
          x: { scale: 'x', field: 'c', band: 0.5 }, y: { scale: 'y', field: 'v' },
          text: { field: 'c' }, font: { value: 'DejaVu Sans' }, fontSize: { value: 12 },
          align: { value: 'center' }, fill: { value: 'black' },
        } },
      }],
    },
  },
  {
    name: 'canvas-multiline-text',
    spec: {
      $schema: 'https://vega.github.io/schema/vega/v6.json',
      width: 260, height: 160, padding: 5, autosize: 'none', background: 'white',
      data: [{ name: 't', values: [{ x: 20, y: 30 }, { x: 120, y: 90 }] }],
      marks: [{
        type: 'text', from: { data: 't' }, encode: { update: {
          x: { field: 'x' }, y: { field: 'y' },
          text: { signal: "['first line', 'second line']" },
          fontSize: { value: 12 }, fill: { value: 'black' },
        } },
      }],
    },
  },
]
const all = [...loadCorpus(), ...synthetic].filter((e) => !FILTER || e.name.includes(FILTER))
const entries = all.filter((e) => !SKIP.has(e.name)).slice(0, LIMIT || undefined)
console.log(`[browser-canvas] ${BROWSER}: ${entries.length} corpus entries${all.length !== entries.length ? ` (${all.length - entries.length} skipped)` : ''}`)

const entrySrc = `
import embed from 'vega-embed'
import { compileChart, evaluateChart, renderSpec } from '@aster/core'
import { renderSceneToCanvas } from '@aster/core/canvas'
import { loadSpecData } from '@aster/core/load'
import { compile } from '@aster/vl'
import '@aster/core/geo'
import '@aster/core/transforms'

function pixels(canvas) {
  const ctx = canvas.getContext('2d')
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
  return { data, w: canvas.width, h: canvas.height }
}

// Tolerant pixel diff: each paint pixel is matched against the oracle within a
// 1px neighbourhood. Thin strokes and text antialiasing can shift by a pixel
// between vega's canvas walk and ours; a real geometry/paint regression (a
// missing mark, a different colour, a moved bar) still has no nearby match.
function diff(a, b) {
  if (a.w !== b.w || a.h !== b.h) return { error: 'size ' + a.w + 'x' + a.h + ' != ' + b.w + 'x' + b.h }
  const R = 1
  let bad = 0, sum = 0
  const W = a.w, H = a.h
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4
      let best = 1e9
      for (let dy = -R; dy <= R && best > 48; dy++) {
        const yy = y + dy
        if (yy < 0 || yy >= H) continue
        for (let dx = -R; dx <= R; dx++) {
          const xx = x + dx
          if (xx < 0 || xx >= W) continue
          const j = (yy * W + xx) * 4
          const d = Math.abs(a.data[i] - b.data[j])
            + Math.abs(a.data[i+1] - b.data[j+1])
            + Math.abs(a.data[i+2] - b.data[j+2])
            + Math.abs(a.data[i+3] - b.data[j+3])
          if (d < best) best = d
          if (best <= 48) break
        }
      }
      if (best > 48) bad++
      sum += best
    }
  }
  const count = W * H
  return { ratio: bad / count, mean: sum / (count * 4) }
}

const RATIO = ${RATIO}
const MEAN = ${MEAN}

window.__runCanvas = async (entry) => {
  try {
    const spec = entry.spec
    const isVl = String(spec.$schema ?? '').includes('vega-lite')
    const compiled = isVl ? compile(spec) : spec
    const loaded = await loadSpecData(compiled as never)
    // Oracle: official Vega on an in-DOM canvas.
    const host = document.createElement('div')
    document.body.appendChild(host)
    const result = await embed(host, isVl ? spec : loaded, { actions: false, renderer: 'canvas' })
    const oracleCanvas = host.querySelector('canvas')
    if (!oracleCanvas) throw new Error('oracle produced no canvas')
    const a = pixels(oracleCanvas)
    result.finalize()
    host.remove()
    // aster: same scene, canvas backend.
    const scene = evaluateChart(compileChart(loaded as never))
    const ours = document.createElement('canvas')
    ours.width = scene.width
    ours.height = scene.height
    renderSceneToCanvas(scene, ours.getContext('2d'))
    const b = pixels(ours)
    const d = diff(a, b)
    return { ...d, pass: !d.error && d.ratio <= RATIO && d.mean <= MEAN }
  } catch (err) {
    return { pass: false, error: err instanceof Error ? err.message : String(err) }
  }
}
`

rmSync(OUT_DIR, { recursive: true, force: true })
mkdirSync(OUT_DIR, { recursive: true })
writeFileSync(join(OUT_DIR, 'page-entry.ts'), entrySrc)
await build({
  entryPoints: [join(OUT_DIR, 'page-entry.ts')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  outfile: join(OUT_DIR, 'page.js'),
  define: { 'process.env.NODE_ENV': '"production"' },
  banner: { js: 'var process = { env: { NODE_ENV: "production" } };' },
  logLevel: 'silent',
})
writeFileSync(join(OUT_DIR, 'index.html'), `<!doctype html><html><body><script src="./page.js"></script></body></html>`)

const playwright = await import('playwright')
const browser = await playwright[BROWSER].launch({ headless: true, args: BROWSER === 'chromium' ? ['--disable-dev-shm-usage'] : [] })
const page = await browser.newPage({ deviceScaleFactor: 1 })
page.on('pageerror', (e) => console.error('[page]', e.message.slice(0, 200)))
await page.goto(`file://${join(OUT_DIR, 'index.html')}`)
await page.waitForFunction(() => '__runCanvas' in window, null, { timeout: 30_000 })
await page.evaluate((data) => { (window as unknown as { __entries: unknown }).__entries = data }, entries)

let pass = 0
const failures: Array<{ name: string; error?: string; ratio?: number; mean?: number }> = []
const t0 = Date.now()
for (let i = 0; i < entries.length; i++) {
  const r = await page.evaluate((idx: number) => {
    const es = (window as unknown as { __entries: Entry[] }).__entries
    return (window as unknown as { __runCanvas: (e: Entry) => Promise<{ pass: boolean; error?: string; ratio?: number; mean?: number }> }).__runCanvas(es[idx]!)
  }, i)
  if (r.pass) pass++
  else failures.push({ name: entries[i]!.name, error: r.error, ratio: r.ratio, mean: r.mean })
  if ((i + 1) % 25 === 0) console.log(`  ${i + 1}/${entries.length} (${((Date.now() - t0) / 1000).toFixed(0)}s)`)
}
await browser.close()
rmSync(OUT_DIR, { recursive: true, force: true })

console.log(`\n[browser-canvas] ${BROWSER}: ${pass}/${entries.length} passed (${((Date.now() - t0) / 1000).toFixed(0)}s)`)
if (failures.length) {
  console.log(`[browser-canvas] failing: ${failures.map((f) => f.name).join(', ')}`)
  for (const f of failures.slice(0, 20)) {
    console.log(`  ${f.name}: ${f.error ?? `ratio=${f.ratio?.toFixed(4)} mean=${f.mean?.toFixed(2)}`}`)
  }
}
process.exit(failures.length ? 1 : 0)
