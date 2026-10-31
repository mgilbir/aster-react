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
 * A second phase (browser-canvas-append.mts) checks that incremental append painting
 * equals a full repaint, pixel for pixel.
 * A third phase (browser-canvas-symbols.mts) checks that batched symbol runs paint the plain path's pixels, in time.
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
const BROWSER = arg('browser', 'chromium') as 'chromium' | 'firefox' | 'webkit'
// Pixel tolerance, measured (see the block comment above the diff in the page code):
//   PIXEL  a pixel differs when |dR|+|dG|+|dB|+|dA| > PIXEL (48 = 12/255 per channel on average)
//   RATIO  an entry may have at most this fraction of differing pixels
//   MEAN   and at most this mean per-channel difference over ALL pixels
// Against vega's own canvas, 327 of 420 corpus entries are BIT-EXACT; the rest of the
// agreeing entries differ only by the 3-decimal rounding of path coordinates (Aster
// paints most marks from the same path string the SVG renderer emits, vega's canvas from the
// unrounded numbers; line, area and symbol marks are the exception: they are drawn unrounded, because
// Firefox amplified the rounding at acute miter joins and WebKit turned a rounded circle into a visible pixel difference, tree-links-paths). Worst such noise measured: 50 pixels over PIXEL out of 127,100
// (RATIO 3.9e-4) and mean 0.029; the limits below sit just above that.
// WebKit's rasteriser rounds path coverage differently from Skia: its worst measured noise
// on the same corpus is 0.08% / mean 0.06 (line-curve-cardinal-tension-0-3.vg), so its
// limits are one step looser; Chromium and Firefox measured the same as above.
const LIMITS = { chromium: { ratio: 0.0005, mean: 0.05 }, firefox: { ratio: 0.0005, mean: 0.05 }, webkit: { ratio: 0.001, mean: 0.07 } } as const
const PIXEL = Number(arg('pixel', '48'))
const RATIO = Number(arg('ratio', String(LIMITS[BROWSER].ratio)))
const MEAN = Number(arg('mean', String(LIMITS[BROWSER].mean)))

interface Entry { name: string; spec: Record<string, unknown> }

function loadCorpus(): Entry[] {
  const corpus = join(CONF_DIR, 'corpus')
  const files = readdirSync(corpus, { recursive: true }).filter((f) => String(f).endsWith('.json')).map(String).sort()
  const entries: Entry[] = []
  for (const f of files) {
    const spec = JSON.parse(readFileSync(join(corpus, f), 'utf8')) as Record<string, unknown>
    entries.push({ name: f.replace(/\.vl\.json$|\.json$/, ''), spec })
  }
  return entries
}

// Entries the pixel gate cannot judge because the ORACLE's own output is undefined, with the
// evidence. There is no other exclusion: every corpus entry (including URL data and images)
// is compared.
const SKIP = new Map<string, string>([
  ['area-gradient', "the spec's fill is the string 'gradient' (not a colour, not a gradient object): vega's canvas assigns fillStyle='gradient', which a canvas ignores (invalid colour strings leave the previous value), so the pixels vega paints depend on whatever fillStyle earlier items left behind, not on the spec. Evidence: view.scenegraph() item.fill === 'gradient'; vega's canvas shows no area at all while aster shows a white one. The SVG gate compares this entry's markup strictly."],
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
// The arcs of a path string (a path mark, a custom symbol shape). vega's canvas draws them as the cubic beziers of path/arc.js
// (segments of at most a quarter turn), not as canvas arcs; the jsdom record parity compares SVG arcs with canvas arcs and cannot
// judge these, so they are compared here, in pixels against vega's canvas, and are not corpus specs.
const PATH_ARCS: Array<[string, string]> = [
  ['circ-small', 'M20,150 A100,100 0 0,1 180,150'],
  ['circ-large', 'M20,150 A60,60 0 1,1 120,100'],
  ['ellipse', 'M20,150 A120,50 0 0,1 280,150'],
  ['ellipse-rotated', 'M60,160 A140,40 35 0,1 260,100'],
  ['ellipse-large-sweep0', 'M60,160 A100,60 -20 1,0 260,120'],
  ['scaled-radii', 'M20,100 A10,10 0 0,1 280,100'],
  ['closed-pie', 'M150,150 L150,40 A110,110 0 1,1 60,215 Z'],
]
for (const [name, d] of PATH_ARCS) {
  synthetic.push({
    name: `canvas-path-arc-${name}`,
    spec: {
      $schema: 'https://vega.github.io/schema/vega/v6.json', width: 300, height: 300, padding: 5, autosize: 'none', background: 'white',
      marks: [{ type: 'path', encode: { update: { path: { value: d }, stroke: { value: 'black' }, strokeWidth: { value: 10 }, fill: { value: 'rgba(255,100,0,0.4)' } } } }],
    },
  })
}
const CUSTOM_SHAPES: Array<[string, string]> = [
  ['ring', 'M-1,0 A1,1 0 1,1 1,0 A1,1 0 1,1 -1,0 M0.5,0 A0.5,0.5 0 0,0 -0.5,0 Z'],
  ['ellipse', 'M0,-1 A1.2,0.5 30 1,1 1,0.4 L0,1 Z'],
]
for (const [name, shape] of CUSTOM_SHAPES) {
  synthetic.push({
    name: `canvas-symbol-custom-arc-${name}`,
    spec: {
      $schema: 'https://vega.github.io/schema/vega/v6.json', width: 300, height: 200, padding: 5, autosize: 'none', background: 'white',
      marks: [
        { type: 'symbol', encode: { update: { x: { value: 100 }, y: { value: 100 }, size: { value: 9000 }, shape: { value: shape }, stroke: { value: 'black' }, strokeWidth: { value: 8 }, fill: { value: 'rgba(0,120,255,0.4)' } } } },
        { type: 'symbol', encode: { update: { x: { value: 220 }, y: { value: 100 }, size: { value: 6000 }, shape: { value: shape }, angle: { value: 40 }, stroke: { value: 'black' }, strokeWidth: { value: 5 }, fill: { value: 'rgba(255,120,0,0.4)' } } } },
      ],
    },
  })
}
// A `heatmap` draws a raster grid into a canvas that the image mark then shows (as a dataset field and as a mark transform). They
// are not corpus specs: vega in Node has no canvas to draw them into, so only a browser can judge them; the SVG side (the href)
// is the gallery gate's (`vega/density-heatmaps`, `vega/contour-plot`).
{
  const points = Array.from({ length: 90 }, (_, i) => {
    const g = i % 3
    const a = (i * 2.399963) % (2 * Math.PI)
    const r = 4 + ((i * 7) % 11)
    return { g: ['a', 'b', 'c'][g], x: 30 + 25 * g + r * Math.cos(a), y: 25 + 8 * g + r * Math.sin(a) }
  })
  const kde = { type: 'kde2d', groupby: ['g'], size: [90, 60], x: { expr: 'datum.x' }, y: { expr: 'datum.y' }, bandwidth: [6, 6], cellSize: 2, counts: true }
  const scales = [{ name: 'c', type: 'ordinal', domain: ['a', 'b', 'c'], range: ['red', 'green', 'blue'] }]
  const box = { x: { value: 0 }, y: { value: 0 }, width: { value: 90 }, height: { value: 60 }, aspect: { value: false } }
  const base = { $schema: 'https://vega.github.io/schema/vega/v6.json', width: 90, height: 60, padding: 5, autosize: 'none', background: 'white' }
  synthetic.push({
    name: 'canvas-heatmap-dataset',
    spec: {
      ...base, scales,
      data: [{ name: 'pts', values: points }, { name: 'hm', source: 'pts', transform: [kde, { type: 'heatmap', field: 'grid', color: { expr: "scale('c', datum.g)" }, resolve: 'shared' }] }],
      marks: [{ type: 'image', from: { data: 'hm' }, encode: { update: { ...box, image: { field: 'image' }, smooth: { value: false } } } }],
    },
  })
  synthetic.push({
    name: 'canvas-heatmap-mark',
    spec: {
      ...base, scales,
      data: [{ name: 'pts', values: points }, { name: 'density', source: 'pts', transform: [kde] }],
      marks: [{ type: 'image', from: { data: 'density' }, encode: { update: box }, transform: [{ type: 'heatmap', field: 'datum.grid', color: { expr: 'rgb(255 * datum.$value / datum.$max, 0, 120)' } }] }],
    },
  })
}
const all = [...loadCorpus(), ...synthetic].filter((e) => !FILTER || e.name.includes(FILTER))
const entries = all.filter((e) => !SKIP.has(e.name)).slice(0, LIMIT || undefined)
const skippedNames = all.filter((e) => SKIP.has(e.name)).map((e) => e.name)
console.log(`[browser-canvas] ${BROWSER}: ${entries.length} entries compared${skippedNames.length ? `; ${skippedNames.length} skipped with a recorded reason: ${skippedNames.map((n) => `${n} (${SKIP.get(n)})`).join('; ')}` : ''}`)

const entrySrc = `
import embed from 'vega-embed'
import { compileChart, evaluateChart, renderSpec } from '@aster/core'
import { renderSceneToCanvas } from '@aster/core/canvas'
import { loadSpecData, TRUSTED_LOAD_OPTIONS } from '@aster/core/load'
import { compile } from '@aster/vl'
import '@aster/core/geo'
import '@aster/core/transforms'

function pixels(canvas) {
  const ctx = canvas.getContext('2d')
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
  return { data, w: canvas.width, h: canvas.height }
}

// Exact per-pixel diff: a pixel differs when the sum of its four channel differences
// exceeds PIXEL. No neighbourhood matching: a mark one pixel off is a difference.
function diff(a, b) {
  if (a.w !== b.w || a.h !== b.h) return { error: 'size ' + a.w + 'x' + a.h + ' != ' + b.w + 'x' + b.h }
  const count = a.w * a.h
  let bad = 0, sum = 0
  for (let i = 0; i < count * 4; i += 4) {
    const d = Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i+1] - b.data[i+1]) + Math.abs(a.data[i+2] - b.data[i+2]) + Math.abs(a.data[i+3] - b.data[i+3])
    sum += d
    if (d > PIXEL) bad++
  }
  return { ratio: bad / count, mean: sum / (count * 4) }
}

const PIXEL = ${PIXEL}
const RATIO = ${RATIO}
const MEAN = ${MEAN}
function loadImage(url) {
  return new Promise((resolve) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => resolve(null) // an unloadable image paints nothing, in vega too
    img.src = url
  })
}
async function attachImages(nodes) {
  for (const n of nodes) {
    if (n.marktype === 'image') for (const it of n.items || []) { if (it.url != null) it.image = await loadImage(String(it.url)) }
    if (n.items) await attachImages(n.items.filter((c) => c && typeof c === 'object' && c.items))
  }
}

window.__runCanvas = async (entry) => {
  try {
    const spec = entry.spec
    const isVl = String(spec.$schema ?? '').includes('vega-lite')
    const compiled = isVl ? compile(spec) : spec
    const loaded = await loadSpecData(compiled as never, TRUSTED_LOAD_OPTIONS)
    // Oracle: official Vega on an in-DOM canvas.
    // A specs' containerSize() reads this element: vega-embed measures the host, so the host gets a
    // definite size and aster is told the same one (it has no DOM to measure).
    const CONTAINER = { width: 420, height: 260 }
    const host = document.createElement('div')
    host.style.width = CONTAINER.width + 'px'
    host.style.height = CONTAINER.height + 'px'
    document.body.appendChild(host)
    // (vega changes the rows of an inline dataset in place -- a force layout rewrites its link rows -- so it gets a copy)
    const result = await embed(host, structuredClone(isVl ? spec : loaded), { actions: false, renderer: 'canvas' })
    const oracleCanvas = host.querySelector('canvas')
    if (!oracleCanvas) throw new Error('oracle produced no canvas')
    const a = pixels(oracleCanvas)
    result.finalize()
    host.remove()
    // aster: same scene, canvas backend.
    const scene = evaluateChart(compileChart(loaded as never), { containerSize: CONTAINER })
    // A host supplies decoded bitmaps for image marks (the renderer never fetches):
    // do what a host does, so image marks are compared like every other mark.
    await attachImages(scene.items)
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

// Phase 2: incremental canvas painting (append path) must equal a full repaint, pixel for pixel.
const { runAppendPixelOracle } = await import('./browser-canvas-append.mts')
const append = await runAppendPixelOracle(BROWSER, 60, 14)
console.log(`[browser-canvas] append-vs-full-repaint ${BROWSER}: ${append.runs} scenarios, ${append.appended} append-path frames, ${append.failures.length} failing`)
for (const f of append.failures.slice(0, 20)) console.log(`  ${f}`)

// Phase 3: a batched run of symbols (a browser context builds closed symbols as Path2D) must paint the plain path's pixels, fast.
const { runSymbolRunOracle } = await import('./browser-canvas-symbols.mts')
const symbols = await runSymbolRunOracle(BROWSER)
console.log(`[browser-canvas] symbol-runs ${BROWSER}: ${symbols.cases} cases (${symbols.withInk} with ink), ${symbols.failures.length} failing; 100k scatter ms: ${symbols.timings.map((t) => `${t.shape}=${t.ms}`).join(' ')}`)
for (const f of symbols.failures.slice(0, 20)) console.log(`  ${f}`)
process.exit(failures.length || append.failures.length || symbols.failures.length ? 1 : 0)
