/**
 * Chromium canvas parity gate.
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
 * A fourth phase (browser-canvas-dirty.mts) checks that when <Chart> paints nothing for a signal-driven scene (because it
 * paints the same pixels), the canvas shows exactly what a full repaint of that scene shows, at device pixel ratios 1 and 2.
 *
 * The verdict is runGate's (scripts/lib/run-gate.mjs). Its counters are what was compared on the path each phase exists to
 * test, with floors on a full run: `compared` (entries compared in pixels with ink on both sides), `gradient` (generated
 * scale gradients compared, call by call), `append-frames` (frames painted by the append path), `untouched-frames` (frames
 * <Chart> painted nothing for), `symbol-ink` (symbol cases with ink) and `path2d` (symbol cases the real context painted
 * through Path2D). Phase 1 reads the built packages (dist; runGate refuses a stale build), phases 2-4 the core sources.
 * A narrowed run (`--filter`, `--limit`, a tolerance flag) runs phase 1 only. `--plant-difference` paints a 3x3 black square
 * onto Aster's canvas in every phase.
 *
 * Run after `pnpm build`: npx tsx scripts/browser-canvas-parity.mts [--limit=N] [--filter=substr] [--browser=chromium]
 */
import { readdirSync, readFileSync, writeFileSync, rmSync, mkdirSync, mkdtempSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import * as vega from 'vega'
import { gradientSpec, makeRng, UNPAINTABLE_KINDS } from './gradient-gen.mts'
import { cli } from '../../../scripts/lib/cli.mjs'
import { GATE_FLAGS, intOption, runGate, type Gate } from '../../../scripts/lib/run-gate.mjs'
import { CANVAS_LIMITS, COMPARE_PIXELS_SOURCE } from './canvas-pixels.mts'
import { compileChart, evaluateChart } from '@aster-charts/core'

cli({ url: import.meta.url, flags: { limit: 'eq', filter: 'eq', browser: 'eq', pixel: 'eq', ratio: 'eq', mean: 'eq', local: 'eq', ...GATE_FLAGS } })

const THIS_DIR = dirname(fileURLToPath(import.meta.url))
const CONF_DIR = dirname(THIS_DIR)
const OUT_DIR = mkdtempSync(join(CONF_DIR, '.tmp-browser-canvas-')) // (one directory per run: concurrent runs do not clobber each other)
const argv = process.argv.slice(2)
const arg = (n: string, d: string): string => argv.find((a) => a.startsWith(`--${n}=`))?.split('=')[1] ?? d
const LIMIT = intOption(argv.find((a) => a.startsWith('--limit='))?.split('=')[1], '--limit', 0)
const FILTER = arg('filter', '')
const BROWSER = arg('browser', 'chromium') as 'chromium' | 'firefox' | 'webkit'
// Pixel tolerance, measured (canvas-pixels.mts `comparePixels` is the comparison):
//   PIXEL  a pixel differs when |dR|+|dG|+|dB|+|dA| > PIXEL (48 = 12/255 per channel on average)
//   RATIO  an entry may have at most this fraction of differing pixels
//   MEAN   and at most this mean per-channel difference over ALL pixels
//   LOCAL  and at most this many differing pixels in any WINDOW x WINDOW square (a mark missing, moved or recoloured is
//          concentrated; rounding noise is spread along edges), and ink on one side requires ink on the other
// Against vega's own canvas, 1156 of the 1216 entries compared are BIT-EXACT (`--pixel=0 --ratio=0 --mean=0`
// counts them, Chromium, 2026-11-06); the rest of the
// agreeing entries differ only by the 3-decimal rounding of path coordinates (Aster
// paints most marks from the same path string the SVG renderer emits, vega's canvas from the
// unrounded numbers; line, area and symbol marks are the exception: they are drawn unrounded, because
// Firefox amplified the rounding at acute miter joins and WebKit turned a rounded circle into a visible pixel difference, tree-links-paths). Worst such noise measured: 50 pixels over PIXEL out of 127,100
// (RATIO 3.9e-4) and mean 0.029; the limits below sit just above that.
// WebKit's rasteriser rounds path coverage differently from Skia: its worst measured noise
// on the same corpus is 0.08% / mean 0.06 (line-curve-cardinal-tension-0-3.vg), so its
// limits are one step looser; Chromium and Firefox measured the same as above.
// (Chromium's numbers are shared with the gates that compare a live canvas after interaction: canvas-pixels.mts)
// LOCAL, measured per browser over the corpus (2026-11-23): Chromium 7 (legend-discretizing-labels.vg), Firefox 6
// (vlx-geo-geoshape-config-projection-signal-expr), WebKit 13 (geoshape-point-radius.vg: a geoshape point's small circle,
// 2 in Chromium and 4 in Firefox); a missing 5x5 mark is 25, a 7x7 one moved by a pixel 14.
const LIMITS = { chromium: { ratio: CANVAS_LIMITS.ratio, mean: CANVAS_LIMITS.mean, local: CANVAS_LIMITS.local }, firefox: { ratio: 0.0005, mean: 0.05, local: CANVAS_LIMITS.local }, webkit: { ratio: 0.001, mean: 0.07, local: 13 } } as const
const PIXEL = Number(arg('pixel', String(CANVAS_LIMITS.pixel)))
const RATIO = Number(arg('ratio', String(LIMITS[BROWSER].ratio)))
const MEAN = Number(arg('mean', String(LIMITS[BROWSER].mean)))
const LOCAL = Number(arg('local', String(LIMITS[BROWSER].local)))
/** A narrowed run (filter, limit, or a tolerance other than the measured one): the floors are not applied. */
const NARROWED = Boolean(FILTER) || LIMIT > 0 || ['pixel', 'ratio', 'mean', 'local'].some((n) => argv.some((a) => a.startsWith(`--${n}=`)))

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

// No entry is skipped: every corpus entry (including URL data and images) is compared. One whose ORACLE output is undefined is compared
// like the others and listed, with the evidence, in the expected-differences table (scripts/lib/expected-differences.mjs), which requires
// it to still differ (none today: `area-gradient` was one while its fill was the string 'gradient'; it now holds a real gradient object).
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
// A gradient on a guide's box (an axis's, a legend's, an entry's, a title's), on a legend's strip and on its symbols: vega lays it over
// the item's bounds (gradient-canvas-bounds-vs-vega.test.ts holds the axis-aligned and radial ones to vega's coordinates in Node). A
// diagonal one vega draws into an image of the bounds' size, which only a browser can; the stops are hard edges, so a gradient laid
// a pixel off shows.
{
  const edge = (x1: number, y1: number, x2: number, y2: number): object => ({ gradient: 'linear', x1, y1, x2, y2, stops: [{ offset: 0, color: 'black' }, { offset: 0.5, color: 'black' }, { offset: 0.5, color: 'gold' }, { offset: 1, color: 'gold' }] })
  const ring = { gradient: 'radial', stops: [{ offset: 0, color: 'navy' }, { offset: 0.5, color: 'navy' }, { offset: 0.5, color: 'white' }, { offset: 1, color: 'white' }] }
  const diag = edge(0, 0, 1, 0.7)
  const box = (paint: object): object => ({ update: { width: { value: 40 }, height: { value: 20 }, strokeWidth: { value: 3 }, ...paint } })
  const base = { $schema: 'https://vega.github.io/schema/vega/v6.json', width: 160, height: 100, padding: 5, autosize: 'pad', background: 'white',
    scales: [{ name: 'x', type: 'linear', domain: [0, 10], range: 'width' }, { name: 'c', type: 'ordinal', domain: ['a', 'b'], range: ['red', 'blue'] }, { name: 'q', type: 'linear', domain: [0, 10], range: ['white', 'navy'] }] }
  const guides: Array<[string, object]> = [
    ['axis', { axes: [{ orient: 'bottom', scale: 'x', title: 'X', encode: { axis: box({ fill: { value: diag }, stroke: { value: edge(0, 0, 0, 1) } }) } }] }],
    ['legend', { legends: [{ fill: 'c', title: 'C', encode: { legend: box({ fill: { value: edge(0, 0, 1, 0) }, stroke: { value: diag }, strokeForeground: { value: true } }) } }] }],
    ['entries', { legends: [{ fill: 'c', encode: { entries: box({ fill: { value: diag }, stroke: { value: 'teal' } }), symbols: { update: { fill: { value: ring }, size: { value: 200 } } } } }] }],
    ['title', { title: { text: 'Title', subtitle: 'Sub', encode: { group: box({ fill: { value: ring }, stroke: { value: diag } }) } } }],
    ['strip', { legends: [{ fill: 'q', type: 'gradient', title: 'Q', gradientStrokeColor: 'black', gradientStrokeWidth: 3, encode: { gradient: { update: { stroke: { value: edge(1, 0, 1, 1) } } } } }] }],
    // (a diagonal gradient is a pattern, which sits at the origin of the frame vega paints in: a group's, an entry's, an axis's)
    ['legend-parts', { legends: [{ fill: 'c', title: 'Title above', encode: { entries: box({ fill: { value: diag } }), symbols: { update: { fill: { value: diag }, size: { value: 300 } } }, labels: { update: { fill: { value: diag }, fontSize: { value: 16 } } } } }] }],
    ['gradient-legend-labels', { legends: [{ fill: 'q', type: 'gradient', title: 'Q', encode: { labels: { update: { fill: { value: diag }, fontSize: { value: 16 } } }, gradient: { update: { stroke: { value: diag }, strokeWidth: { value: 4 } } } } }] }],
    ['axis-parts', { axes: [{ orient: 'bottom', scale: 'x', title: 'Bottom', encode: { labels: { update: { fill: { value: diag }, fontSize: { value: 16 } } }, ticks: { update: { stroke: { value: diag }, strokeWidth: { value: 4 } } }, title: { update: { fill: { value: diag }, fontSize: { value: 20 } } } } }] }],
    ['group-mark', { marks: [{ type: 'group', encode: { update: { x: { value: 37 }, y: { value: 23 }, width: { value: 70 }, height: { value: 40 }, fill: { value: diag }, stroke: { value: diag }, strokeWidth: { value: 5 }, strokeForeground: { value: true } } }, marks: [{ type: 'rect', encode: { update: { x: { value: 10 }, y: { value: 10 }, width: { value: 30 }, height: { value: 20 }, fill: { value: diag } } } }] }] }],
  ]
  for (const [name, guide] of guides) synthetic.push({ name: `canvas-guide-gradient-${name}`, spec: { ...base, ...guide } })
  // A legend's symbols, compared call by call (a `canvas-gradient-` entry): vega's canvas draws them with its symbol mark, a circle as one
  // full-turn arc and every shape at full precision; drawn from the SVG's three-decimal path text, a hard-edged radial fill showed
  // the difference in WebKit (canvas-guide-gradient-entries).
  synthetic.push({ name: 'canvas-gradient-legend-symbols', spec: { ...base, legends: [
    { fill: 'c', encode: { symbols: { update: { fill: { value: ring }, size: { value: 200 } } } } },
    { fill: 'c', orient: 'left', encode: { symbols: { update: { shape: { value: 'diamond' }, fill: { value: ring }, stroke: { value: 'teal' }, strokeWidth: { value: 2 }, size: { value: 150 } } } } },
  ] } })
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
// The gradient of a scale (`{gradient: <scale>, start, stop, count}`, `gradient(scale, ...)`), generated over the kinds of scale, the
// options and the marks that paint (gradient-gen.mts; the SVG side is differential-gradient.test.mts). Their CanvasGradients are
// compared in pixels with vega's; the specs that vega itself refuses at parse (a hole in the call), and the scales whose stops are no
// colours (a number: `addColorStop` throws in vega's canvas too), are not specs for a canvas.
/**
 * The generated gradients vega itself refuses at parse (a hole in a `gradient()` call): no spec for a canvas, but compared
 * all the same, for the refusal: Aster must refuse each with vega's message (in Node, before the browser starts).
 */
const gradientRefusals: Array<{ name: string; spec: Record<string, unknown>; message: string }> = []
let unpaintableGradients = 0
{
  const r = makeRng(2024)
  for (let i = 0; i < 220; i++) {
    const { spec, kind } = gradientSpec(r)
    // (the scales whose stops are no colours: a number is no colour, `addColorStop` throws in vega's canvas too; their SVG is
    // compared by differential-gradient.test.mts)
    if (UNPAINTABLE_KINDS.has(kind)) {
      unpaintableGradients++
      continue
    }
    let refusal: string | null = null
    try { vega.parse(structuredClone(spec) as never) } catch (e) { refusal = e instanceof Error ? e.message : String(e) }
    const entry = { name: `canvas-gradient-${i}`, spec: { $schema: 'https://vega.github.io/schema/vega/v6.json', background: 'white', ...spec } }
    if (refusal === null) synthetic.push(entry)
    else gradientRefusals.push({ ...entry, message: refusal })
  }
}
const entries = [...loadCorpus(), ...synthetic].filter((e) => !FILTER || e.name.includes(FILTER)).slice(0, LIMIT || undefined)
const refusals = gradientRefusals.filter((e) => !FILTER || e.name.includes(FILTER))
console.log(`[browser-canvas] ${BROWSER}: ${entries.length} entries; generated gradients: ${synthetic.filter((e) => e.name.startsWith('canvas-gradient-')).length} painted, ${gradientRefusals.length} refused by vega.parse (refusal compared), ${unpaintableGradients} of unpaintable kinds (SVG only)`)

const entrySrc = `
import embed from 'vega-embed'
import { compileChart, evaluateChart, renderSpec } from '@aster-charts/core'
import { renderSceneToCanvas } from '@aster-charts/core/canvas'
import { loadSpecData, TRUSTED_LOAD_OPTIONS } from '@aster-charts/core/load'
import { compile } from '@aster-charts/vl'
import '@aster-charts/core/geo'
import '@aster-charts/core/transforms'

function pixels(canvas) {
  // (a view of no width or height is a canvas with no pixels: getImageData refuses it; the sizes are still compared)
  if (canvas.width === 0 || canvas.height === 0) return { data: new Uint8ClampedArray(0), w: canvas.width, h: canvas.height }
  const ctx = canvas.getContext('2d')
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
  return { data, w: canvas.width, h: canvas.height }
}

// The one pixel comparison of the gates (canvas-pixels.mts): no neighbourhood matching, a mark one pixel off is concentrated
// in a square of the picture and fails the LOCAL limit.
const comparePixels = ${COMPARE_PIXELS_SOURCE}
const LIMITS = { pixel: ${PIXEL}, ratio: ${RATIO}, mean: ${MEAN}, window: ${CANVAS_LIMITS.window}, local: ${LOCAL} }
function diff(a, b) {
  if (a.w !== b.w || a.h !== b.h) return { error: 'size ' + a.w + 'x' + a.h + ' != ' + b.w + 'x' + b.h, inkA: false, inkB: false }
  return comparePixels(a.data, b.data, a.w, a.h, LIMITS)
}

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


// A recorder of how a context is drawn on, in device space: the paths, the gradients and what is painted with them. It lets a gate
// compare the CALLS of vega and of Aster (a rasterizer may hide a difference in them: WebKit drew a circle made of two half turns a
// pixel differently from vega's one full turn).
window.__rec = null
{
  const P = CanvasRenderingContext2D.prototype
  const r6 = (v) => (typeof v === 'number' ? String(Math.round(v * 1e6) / 1e6) : typeof v)
  const dev = (ctx, x, y) => { const m = ctx.getTransform(); return r6(m.a * x + m.c * y + m.e) + ',' + r6(m.b * x + m.d * y + m.f) }
  // (a path counts where it is painted: what is traced and never filled or stroked paints nothing)
  let cur = []
  const put = (s) => { if (window.__rec) { if (/^(B|M|L|Z|A|C)/.test(s) && !s.startsWith('LG')) { if (s === 'B') cur = []; else cur.push(s) } else window.__rec.push(s) } }
  const wrap = (name, f) => { const o = P[name]; P[name] = function (...a) { if (window.__rec) f(this, a); return o.apply(this, a) } }
  wrap('beginPath', () => put('B'))
  wrap('moveTo', (c, a) => put('M' + dev(c, a[0], a[1])))
  wrap('lineTo', (c, a) => put('L' + dev(c, a[0], a[1])))
  wrap('closePath', () => put('Z'))
  // (arc with a false last argument and arc without one are one call: clockwise)
  wrap('arc', (c, a) => put('A' + dev(c, a[0], a[1]) + ',' + a.slice(2).filter((v) => v !== false && v !== undefined).map(r6).join(',')))
  wrap('bezierCurveTo', (c, a) => put('C' + dev(c, a[0], a[1]) + ' ' + dev(c, a[2], a[3]) + ' ' + dev(c, a[4], a[5])))
  wrap('rect', (c, a) => { const [x, y, w, h] = a; put('M' + dev(c, x, y)); put('L' + dev(c, x + w, y)); put('L' + dev(c, x + w, y + h)); put('L' + dev(c, x, y + h)); put('Z') })
  wrap('fill', () => put('F[' + cur.join(' ') + ']'))
  wrap('stroke', () => put('S[' + cur.join(' ') + ']'))
  wrap('createLinearGradient', (c, a) => put('LG' + dev(c, a[0], a[1]) + ' ' + dev(c, a[2], a[3])))
  wrap('createRadialGradient', (c, a) => put('RG' + dev(c, a[0], a[1]) + ',' + r6(a[2]) + ' ' + dev(c, a[3], a[4]) + ',' + r6(a[5])))
  const G = CanvasGradient.prototype
  const addStop = G.addColorStop
  G.addColorStop = function (o, c) { put('stop' + r6(o) + c); return addStop.call(this, o, c) }
}

window.__runCanvas = async (entry, plant) => {
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
    // (the calls are compared for the gradient entries)
    const callLevel = String(entry.name).startsWith('canvas-gradient-')
    if (callLevel) window.__rec = []
    const result = await embed(host, structuredClone(isVl ? spec : loaded), { actions: false, renderer: 'canvas' })
    const vegaCalls = callLevel ? window.__rec : null
    window.__rec = callLevel ? [] : null
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
    // (--plant-difference: a 3x3 black mark the oracle did not draw)
    if (plant) { const g = ours.getContext('2d'); g.fillStyle = '#000'; g.fillRect(Math.floor(ours.width / 2), Math.floor(ours.height / 2), 3, 3) }
    const b = pixels(ours)
    const asterCalls = callLevel ? window.__rec : null
    window.__rec = null
    let callDiff = null
    if (callLevel) {
      const n = Math.max(vegaCalls.length, asterCalls.length)
      for (let i = 0; i < n; i++) if (vegaCalls[i] !== asterCalls[i]) { callDiff = 'call ' + i + ': vega ' + vegaCalls[i] + ' vs aster ' + asterCalls[i]; break }
    }
    const d = diff(a, b)
    return { error: d.error, local: d.local, ratio: d.ratio, mean: d.mean, ink: d.inkA && d.inkB, callDiff, callLevel, pass: d.error === null && callDiff === null }
  } catch (err) {
    return { pass: false, error: err instanceof Error ? err.message : String(err) }
  }
}
`

/** Aster's refusal of each generated gradient vega refuses: the same message. */
function compareRefusals(gate: Gate): void {
  for (const e of refusals) {
    let ours: string | null = null
    try { evaluateChart(compileChart(structuredClone(e.spec) as never)) } catch (err) { ours = err instanceof Error ? err.message : String(err) }
    if (ours === e.message) gate.agree(`${e.name} (refused)`, 'gradient-refusals')
    else gate.differ(`${e.name} (refused)`, `vega refuses: ${e.message}; Aster: ${ours ?? 'accepts it'}`, 'gradient-refusals')
  }
}

/** A picture for an image URL: its size from a `<w>x<h>` in the URL (placehold.co style), else 64 x 64; hard-edged stripes. */
function servedImage(url: string): string {
  const m = /(\d+)x(\d+)/.exec(url)
  const w = m ? Number(m[1]) : 64
  const h = m ? Number(m[2]) : 64
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="#2a6f97"/>`
    + `<rect width="${w / 2}" height="${h / 2}" fill="#f4a261"/><rect x="${w / 2}" y="${h / 2}" width="${w / 2}" height="${h / 2}" fill="#e76f51"/></svg>`
}

interface CanvasResult { pass: boolean; error?: string | null; callDiff?: string | null; callLevel?: boolean; ink?: boolean; ratio?: number; mean?: number; local?: number }

async function phase1(gate: Gate): Promise<void> {
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
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1 })
    page.on('pageerror', (e) => gate.problem(`page error: ${e.message.slice(0, 200)}`))
    // An image a spec names on the network is served here, the same bytes to both engines, so image marks are compared offline
    // too (an image that fails to load paints nothing in either engine: blank against blank proves nothing).
    let served = 0
    await page.route(/^https?:\/\//, (route) => {
      if (route.request().resourceType() !== 'image') return route.continue()
      served++
      return route.fulfill({ status: 200, contentType: 'image/svg+xml', headers: { 'access-control-allow-origin': '*' }, body: servedImage(route.request().url()) })
    })
    await page.goto(`file://${join(OUT_DIR, 'index.html')}`)
    await page.waitForFunction(() => '__runCanvas' in window, null, { timeout: 30_000 })
    await page.evaluate((data) => { (window as unknown as { __entries: unknown }).__entries = data }, entries)
    let pass = 0
    let blank = 0
    const t0 = Date.now()
    for (let i = 0; i < entries.length; i++) {
      const name = entries[i]!.name
      const r = await page.evaluate(([idx, plant]) => {
        const es = (window as unknown as { __entries: Entry[] }).__entries
        return (window as unknown as { __runCanvas: (e: Entry, plant: boolean) => Promise<CanvasResult> }).__runCanvas(es[idx as number]!, plant as boolean)
      }, [i, gate.plant] as const)
      // the call-level entries are compared call by call; the others count only when there was ink to compare
      const counter = r.callLevel ? 'gradient' : r.ink ? 'compared' : 'blank'
      const failedToCompare = !r.pass && r.ratio === undefined && r.callDiff == null && r.local === undefined
      if (r.pass) {
        pass++
        gate.agree(name, counter)
      } else if (failedToCompare) gate.error(name, r.error ?? 'error')
      else gate.differ(name, `${r.callDiff ?? r.error} (ratio=${r.ratio?.toExponential(2)} mean=${r.mean?.toFixed(3)} local=${r.local})`, counter)
      if (counter === 'blank' && !failedToCompare) {
        blank++
        console.log(`  blank on both sides (compared, proving nothing): ${name}`)
      }
      if ((i + 1) % 25 === 0) console.log(`  ${i + 1}/${entries.length} (${((Date.now() - t0) / 1000).toFixed(0)}s)`)
    }
    gate.count('images-served', served)
    console.log(`\n[browser-canvas] ${BROWSER}: ${pass}/${entries.length} passed (${blank} blank on both sides, ${served} network images served, ${((Date.now() - t0) / 1000).toFixed(0)}s)`)
  } finally {
    await browser.close()
    rmSync(OUT_DIR, { recursive: true, force: true })
  }
}

await runGate({
  name: 'canvas',
  counters: {
    compared: { floor: 1068, what: 'entries compared in pixels with ink on both sides' },
    gradient: { floor: 150, what: 'generated scale gradients compared call by call and in pixels' },
    'gradient-refusals': { floor: 46, what: 'generated gradients vega refuses, refused by Aster with the same message' },
    'append-frames': { floor: 309, what: 'frames painted by the append path and compared with a full repaint' },
    'untouched-frames': { floor: 414, what: 'frames <Chart> painted nothing for, compared with a full repaint' },
    'symbol-ink': { floor: 528, what: 'symbol-run cases with ink compared with the plain path' },
    path2d: { floor: 432, what: 'symbol-run cases the real context painted through Path2D' },
    'images-served': { floor: 2, what: 'network images served to both engines (image marks compared offline)' },
    'append-scenarios': { floor: 120, what: 'append scenarios run' },
    'symbol-cases': { floor: 548, what: 'symbol-run cases compared with the plain path' },
    'dirty-scenarios': { floor: 160, what: 'signal-move scenarios run' },
    blank: { floor: 0, what: 'entries blank on both sides (compared, proving nothing)' },
  },
  // (the floors are today's numbers, Chromium, 2026-11-23; they only ratchet up)
  partial: NARROWED,
  run: async (gate) => {
    compareRefusals(gate)
    await phase1(gate)
    if (NARROWED) return
    // Phase 2: incremental canvas painting (append path) must equal a full repaint, pixel for pixel.
    const { runAppendPixelOracle } = await import('./browser-canvas-append.mts')
    const append = await runAppendPixelOracle(BROWSER, 60, 14, gate.plant)
    for (const c of append.cases) if (c.error) gate.differ(`append ${c.name}`, c.error, 'append-scenarios'); else gate.agree(`append ${c.name}`, 'append-scenarios')
    gate.count('append-frames', append.appended)
    console.log(`[browser-canvas] append-vs-full-repaint ${BROWSER}: ${append.cases.length} scenarios, ${append.appended} append-path frames`)
    // Phase 3: a batched run of symbols (a browser context builds closed symbols as Path2D) must paint the plain path's pixels, fast.
    const { runSymbolRunOracle } = await import('./browser-canvas-symbols.mts')
    const symbols = await runSymbolRunOracle(BROWSER, gate.plant)
    for (const c of symbols.cases) if (c.error) gate.differ(`symbols ${c.name}`, c.error, 'symbol-cases'); else gate.agree(`symbols ${c.name}`, 'symbol-cases')
    gate.count('symbol-ink', symbols.withInk)
    gate.count('path2d', symbols.path2d)
    console.log(`[browser-canvas] symbol-runs ${BROWSER}: ${symbols.cases.length} cases (${symbols.withInk} with ink, ${symbols.path2d} through Path2D); 100k scatter ms: ${symbols.timings.map((t) => `${t.shape}=${t.ms}`).join(' ')}`)
    // Phase 4: signal moves; a frame that paints nothing (the same pixels) must show what a full repaint shows, pixel for pixel.
    const { runDirtyPixelOracle } = await import('./browser-canvas-dirty.mts')
    const dirty = await runDirtyPixelOracle(BROWSER, 80, 14, gate.plant)
    for (const c of dirty.cases) if (c.error) gate.differ(`dirty ${c.name}`, c.error, 'dirty-scenarios'); else gate.agree(`dirty ${c.name}`, 'dirty-scenarios')
    gate.count('untouched-frames', dirty.untouched)
    console.log(`[browser-canvas] signal-moves-vs-full-repaint ${BROWSER}: ${dirty.cases.length} scenarios, ${dirty.untouched} frames that painted nothing, ${dirty.repainted} full repaints`)
  },
})
