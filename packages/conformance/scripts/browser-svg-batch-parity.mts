/**
 * Batched-SVG pixel parity gate.
 *
 * `denseMarks` rewrites dense symbol marks (512 items or more) as chunked `<path>` elements instead
 * of one element per datum (100k symbols -> ~400 paths). Positions are baked
 * into `d` (rounded to 0.001px), so the picture must be the per-item one;
 * this gate rasterizes both DOMs in headless Chromium and compares them.
 *
 * Every entry is generated: no corpus spec has a symbol mark of 512 items (the largest has 30), so a corpus spec renders
 * through the same code twice and proves nothing. The entries span 511 to 100k items and force the batcher across paint,
 * shape, stroke, opacity, rotation and clipping edges. For each one:
 *   - BATCHING is what the entry says it is: `batched` entries have fewer path elements batched than per item, the others
 *     (under 512 items, rotated, translucent) exactly as many;
 *   - GEOMETRY: the batched DOM draws as many sub-paths (`M` commands) as the per-item one, so no item is dropped or
 *     duplicated whatever the pixels say;
 *   - PIXELS agree under the gates' one comparison (canvas-pixels.mts: global noise limits, LOCALITY, ink on both sides),
 *     with the batch limits below: a batched path antialiases overlapping same-paint sub-paths once instead of per item.
 *
 * The verdict is runGate's (scripts/lib/run-gate.mjs): `compared` counts the entries compared, `batched` those whose batched
 * DOM really was batched; both have floors on a full run. `--plant-difference` drops the last sub-path of Aster's batched DOM.
 *
 * Run after `pnpm build`: pnpm conformance:batch [--limit=N] [--filter=substr] [--browser=chromium]
 */
import { writeFileSync, rmSync, mkdirSync, mkdtempSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { cli } from '../../../scripts/lib/cli.mjs'
import { GATE_FLAGS, intOption, runGate, type Gate } from '../../../scripts/lib/run-gate.mjs'
import { COMPARE_PIXELS_SOURCE } from './canvas-pixels.mts'

cli({ url: import.meta.url, flags: { limit: 'eq', filter: 'eq', browser: 'eq', ratio: 'eq', delta: 'eq', mean: 'eq', local: 'eq', ...GATE_FLAGS } })

const THIS_DIR = dirname(fileURLToPath(import.meta.url))
const CONF_DIR = dirname(THIS_DIR)
const OUT_DIR = mkdtempSync(join(CONF_DIR, '.tmp-browser-batch-')) // (one directory per run: concurrent runs do not clobber each other)
const argv = process.argv.slice(2)
const arg = (n: string, d: string): string => argv.find((a) => a.startsWith(`--${n}=`))?.split('=')[1] ?? d
const LIMIT = intOption(argv.find((a) => a.startsWith('--limit='))?.split('=')[1], '--limit', 0)
const FILTER = arg('filter', '')
const BROWSER = arg('browser', 'chromium') as 'chromium' | 'firefox' | 'webkit'
// The batch limits: a pixel differs when the sum of its channel differences exceeds DELTA; at most RATIO of the pixels may
// differ, a mean per-channel difference of MEAN, and LOCAL differing pixels in any 8x8 square (a missing, moved or recoloured
// symbol is concentrated there: a missing 30 px^2 symbol is ~25). Measured over the entries below (Chromium, 2026-11-23):
// worst ratio 8.2e-3 (batch-stroke), worst mean 0.47 (batch-stroke), worst square 7 (batch-shapes); the previous limits
// (ratio 0.04, mean 1.5, no locality) let 60 of 8000 symbols go missing.
const DELTA = Number(arg('delta', '24'))
const RATIO = Number(arg('ratio', '0.01'))
const MEAN = Number(arg('mean', '0.6'))
const LOCAL = Number(arg('local', '7'))
const NARROWED = Boolean(FILTER) || LIMIT > 0 || ['delta', 'ratio', 'mean', 'local'].some((n) => argv.some((a) => a.startsWith(`--${n}=`)))

interface Entry { name: string; spec: Record<string, unknown>; batched: boolean }

// `paintIndex` returns a *run*-shaped value (series blocks) unless the entry is
// explicitly testing per-item paint cycling, which cannot batch by design.
const symbolValues = (n: number, paintIndex: (i: number) => Record<string, unknown>, extra: (i: number) => Record<string, unknown> = () => ({})) =>
  Array.from({ length: n }, (_, i) => ({
    x: (i * 37) % 400,
    y: (i * 23) % 300,
    ...paintIndex(i),
    ...extra(i),
  }))

// The same lattice with a slip every 1200 items, so no symbol is drawn twice on one spot: two that coincide double the rasterizer's
// antialiasing difference between one path and many elements (a difference of rasterization, not of compositing).
const scattered = (n: number, paintIndex: (i: number) => Record<string, unknown>) =>
  Array.from({ length: n }, (_, i) => ({ x: (i * 37 + 11 * Math.floor(i / 1200)) % 400, y: (i * 23 + 5 * Math.floor(i / 1200)) % 300, ...paintIndex(i) }))

// 3000 symbols dropped at random (a seeded generator) into a 190 x 140 patch: neighbours overlap all over, so the batches are cut
// at hundreds of places
const cluster = (paintIndex: (i: number) => Record<string, unknown>) => {
  let a = 413
  const rnd = (): number => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return Array.from({ length: 3000 }, (_, i) => ({ x: 100 + Math.floor(rnd() * 190), y: 100 + Math.floor(rnd() * 140), ...paintIndex(i) }))
}

const shapes = ['circle', 'square', 'diamond', 'triangle-up', 'cross', 'triangle-down']

function denseSpec(values: Array<Record<string, unknown>>, markExtra: Record<string, unknown> = {}, clip = false): Record<string, unknown> {
  return {
    $schema: 'https://vega.github.io/schema/vega/v6.json',
    width: 400, height: 300, padding: 5, autosize: 'none', background: 'white',
    data: [{ name: 't', values }],
    scales: [
      { name: 'x', type: 'linear', domain: [0, 400], range: [0, 400] },
      { name: 'y', type: 'linear', domain: [0, 300], range: [300, 0] },
    ],
    ...(clip ? { marks: [{ type: 'group', clip: true, encode: { update: {} }, marks: [symbolMark(markExtra)] }] } : {}),
    ...(clip ? {} : { marks: [symbolMark(markExtra)] }),
    axes: [
      { scale: 'x', orient: 'bottom', grid: true },
      { scale: 'y', orient: 'left', grid: true },
    ],
  }
}

function symbolMark(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'symbol',
    from: { data: 't' },
    encode: {
      update: {
        x: { scale: 'x', field: 'x' },
        y: { scale: 'y', field: 'y' },
        size: { field: 'size' },
        shape: { field: 'shape' },
        fill: { field: 'fill' },
        stroke: { field: 'stroke' },
        strokeWidth: { field: 'sw' },
        opacity: { field: 'op' },
        ...extra,
      },
    },
  }
}

const palette = ['#4c78a8', '#f58518', '#54a24b', '#e45756', '#b279a2']
const entries0: Entry[] = [
  // the threshold: one item short of it never batches, at it always does
  { name: 'batch-511-under-threshold', batched: false, spec: denseSpec(symbolValues(511, () => ({ fill: '#4c78a8', size: 30 }))) },
  { name: 'batch-512-single-paint', batched: true, spec: denseSpec(symbolValues(512, () => ({ fill: '#4c78a8', size: 30 }))) },
  { name: 'batch-single-paint', batched: true, spec: denseSpec(symbolValues(8000, () => ({ fill: '#4c78a8', size: 30 }))) },
  { name: 'batch-multi-paint', batched: true, spec: denseSpec(symbolValues(8000, (i) => ({ fill: palette[Math.floor(i / 1600)], size: 30 }))) },
  { name: 'batch-shapes', batched: true, spec: denseSpec(symbolValues(8000, (i) => ({ fill: '#4c78a8', size: 20 + (i % 7) * 10, shape: shapes[i % shapes.length] }))) },
  {
    name: 'batch-stroke',
    batched: true,
    // Stroke style changes every 1000 items: 8 same-paint runs batch, while the
    // per-item stroke-width variation within a run forces chunks.
    spec: denseSpec(symbolValues(8000, (i) => ({
      fill: Math.floor(i / 1000) % 2 ? '#4c78a8' : undefined,
      stroke: Math.floor(i / 1000) % 3 ? '#e45756' : undefined,
      sw: 1 + (Math.floor(i / 1000) % 3),
      size: 40,
    }))),
  },
  // translucent, blended and filled-and-stroked symbols share a path only where their ink cannot overlap (one path would composite
  // an overlap once): a field this dense overlaps often, so the batches are short, and every cut must leave the picture as it was
  { name: 'batch-opacity-disjoint', batched: true, spec: denseSpec(scattered(8000, (i) => ({ fill: '#4c78a8', size: 30, op: 0.5 + (Math.floor(i / 1000) % 2) * 0.2 }))) },
  { name: 'batch-fill-stroke', batched: true, spec: denseSpec(scattered(8000, () => ({ fill: '#4c78a8', stroke: 'white', sw: 1, size: 30 }))) },
  { name: 'batch-fill-stroke-shapes', batched: true, spec: denseSpec(scattered(8000, (i) => ({ fill: palette[Math.floor(i / 400) % 3], stroke: '#222', sw: 1 + (Math.floor(i / 400) % 4), size: 20 + (i % 7) * 10, shape: shapes[i % shapes.length] }))) },
  { name: 'batch-blend', batched: true, spec: denseSpec(scattered(4000, () => ({ fill: '#e45756', size: 30 })), { blend: { value: 'multiply' } }) },
  { name: 'batch-stroke-opacity', batched: true, spec: denseSpec(scattered(4000, () => ({ stroke: '#4c78a8', sw: 3, size: 30 })), { strokeOpacity: { value: 0.4 } }) },
  { name: 'batch-cluster-opacity', batched: true, spec: denseSpec(cluster(() => ({ fill: '#e45756', size: 30, op: 0.5 }))) },
  { name: 'batch-cluster-blend', batched: true, spec: denseSpec(cluster(() => ({ fill: '#e45756', size: 30 })), { blend: { value: 'multiply' } }) },
  { name: 'batch-cluster-fill-stroke', batched: true, spec: denseSpec(cluster(() => ({ fill: '#e45756', stroke: 'white', sw: 2, size: 30, op: 0.5 }))) },
  // the benchmark's scatter: random positions, a stroked translucent symbol, 1000 of them
  { name: 'batch-scatter-1000', batched: true, spec: denseSpec(Array.from({ length: 1000 }, (_, i) => ({ x: ((i * 2654435761) >>> 0) % 4000 / 10, y: ((i * 40503 + 7) >>> 0) % 3000 / 10, fill: '#4682b4', stroke: 'white', sw: 1, size: 80, op: 0.7 }))) },
  // symbols piled on each other: no two consecutive ones are apart, so nothing may be batched
  { name: 'batch-translucent-piled', batched: false, spec: denseSpec(Array.from({ length: 4000 }, (_, i) => ({ x: 100 + (i % 7), y: 100 + (i % 5), fill: '#4c78a8', size: 200, op: 0.5 }))) },
  // one translucent run among opaque ones: the opaque runs batch, and so does the translucent one where it is apart
  { name: 'batch-opacity-mixed', batched: true, spec: denseSpec(symbolValues(4000, (i) => ({ fill: palette[Math.floor(i / 1000)], size: 30, op: Math.floor(i / 1000) === 2 ? 0.5 : 1 }))) },
  // rotated items keep their own element
  { name: 'batch-rotated', batched: false, spec: denseSpec(symbolValues(4000, (i) => ({ fill: '#4c78a8', size: 30, shape: shapes[i % shapes.length] })), { angle: { value: 35 } }) },
  { name: 'batch-clipped', batched: true, spec: denseSpec(symbolValues(8000, (i) => ({ fill: palette[Math.floor(i / 1000) % 2], size: 30 })), {}, true) },
  // sparse: symbols that do not overlap, so a missing one cannot hide under another
  { name: 'batch-sparse-600', batched: true, spec: denseSpec(Array.from({ length: 600 }, (_, i) => ({ x: 8 + (i % 30) * 13, y: 8 + Math.floor(i / 30) * 14, fill: palette[Math.floor(i / 300)], size: 20 }))) },
  { name: 'batch-20k-paint-runs', batched: true, spec: denseSpec(symbolValues(20000, (i) => ({ fill: palette[Math.floor(i / 4000)], size: 12, shape: shapes[Math.floor(i / 500) % shapes.length] }))) },
  { name: 'batch-100k', batched: true, spec: denseSpec(symbolValues(100000, () => ({ fill: '#4c78a8', size: 6 }))) },
]

const entries = entries0.filter((e) => !FILTER || e.name.includes(FILTER)).slice(0, LIMIT || undefined)
console.log(`[browser-batch] ${BROWSER}: ${entries.length} generated entries`)

const entrySrc = `
import { compileChart, evaluateChart } from '@aster-charts/core'
import { renderSceneToDomElement } from '@aster-charts/core/dom'
import { loadSpecData, TRUSTED_LOAD_OPTIONS } from '@aster-charts/core/load'

const NS = 'http://www.w3.org/2000/svg'

function rasterize(el, w, h) {
  const xml = new XMLSerializer().serializeToString(el)
  const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml)
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = w; canvas.height = h
      const ctx = canvas.getContext('2d')
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h)
      ctx.drawImage(img, 0, 0, w, h)
      const { data } = ctx.getImageData(0, 0, w, h)
      resolve({ data, w, h })
    }
    img.onerror = () => reject(new Error('svg rasterize failed'))
    img.src = url
  })
}

const comparePixels = ${COMPARE_PIXELS_SOURCE}
const LIMITS = { pixel: ${DELTA}, ratio: ${RATIO}, mean: ${MEAN}, window: 8, local: ${LOCAL} }

function pathStats(el) {
  const paths = el.querySelectorAll('path')
  let subpaths = 0
  for (const p of paths) {
    const d = p.getAttribute('d') || ''
    for (const ch of d) if (ch === 'M' || ch === 'm') subpaths++
  }
  return { paths: paths.length, subpaths }
}

/** --plant-difference: the batched DOM loses the last sub-path of its last multi-item path (an item the batcher dropped). */
function plantDrop(el) {
  const paths = [...el.querySelectorAll('path')].reverse()
  for (const p of paths) {
    const d = p.getAttribute('d') || ''
    const at = Math.max(d.lastIndexOf('M'), d.lastIndexOf('m'))
    if (at > 0) { p.setAttribute('d', d.slice(0, at)); return }
  }
}

window.__runBatch = async (entry, plant) => {
  try {
    const spec = entry.spec
    const loaded = await loadSpecData(spec as never, TRUSTED_LOAD_OPTIONS)
    const scene = evaluateChart(compileChart(loaded as never))
    const normal = renderSceneToDomElement(scene)
    const batched = renderSceneToDomElement(scene, document, { denseMarks: true })
    if (plant) plantDrop(batched)
    const stats = { normal: pathStats(normal), batched: pathStats(batched) }
    const problems = []
    const didBatch = stats.batched.paths < stats.normal.paths
    if (didBatch !== entry.batched) problems.push((entry.batched ? 'the batcher did not reduce paths' : 'items that must keep their own element were batched') + ': ' + JSON.stringify(stats))
    if (stats.batched.subpaths !== stats.normal.subpaths) problems.push('the batched DOM draws ' + stats.batched.subpaths + ' sub-paths, per item ' + stats.normal.subpaths + ' (an item dropped or duplicated)')
    const a = await rasterize(normal, scene.width, scene.height)
    const b = await rasterize(batched, scene.width, scene.height)
    const d = a.w !== b.w || a.h !== b.h ? { error: 'size ' + a.w + 'x' + a.h + ' != ' + b.w + 'x' + b.h } : comparePixels(a.data, b.data, a.w, a.h, LIMITS)
    if (d.error) problems.push(d.error)
    return { compared: true, batched: didBatch, error: problems.length ? problems.join('; ') : null, ratio: d.ratio, mean: d.mean, local: d.local }
  } catch (err) {
    return { compared: false, error: err instanceof Error ? err.message : String(err) }
  }
}
`

interface BatchResult { compared: boolean; batched?: boolean; error: string | null; ratio?: number; mean?: number; local?: number }

async function main(gate: Gate): Promise<void> {
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
  writeFileSync(join(OUT_DIR, 'index.html'), '<!doctype html><html><body><script src="./page.js"></script></body></html>')
  const playwright = await import('playwright')
  const browser = await playwright[BROWSER].launch({ headless: true, args: BROWSER === 'chromium' ? ['--disable-dev-shm-usage'] : [] })
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1 })
    page.on('pageerror', (e) => gate.problem(`page error: ${e.message.slice(0, 200)}`))
    await page.goto(`file://${join(OUT_DIR, 'index.html')}`)
    await page.waitForFunction(() => '__runBatch' in window, null, { timeout: 30_000 })
    const t0 = Date.now()
    for (const entry of entries) {
      const r = await page.evaluate(([e, plant]) => (window as unknown as { __runBatch: (e: Entry, p: boolean) => Promise<BatchResult> }).__runBatch(e as Entry, plant as boolean), [entry, gate.plant] as const)
      const measured = r.ratio === undefined ? '' : ` (ratio=${r.ratio.toExponential(2)} mean=${r.mean?.toFixed(3)} local=${r.local})`
      if (!r.compared) gate.error(entry.name, r.error ?? 'error')
      else if (r.error !== null) gate.differ(entry.name, r.error + measured)
      else gate.agree(entry.name)
      if (r.compared && r.batched) gate.count('batched')
      console.log(`  ${r.error === null ? 'PASS' : 'FAIL'}  ${entry.name}${measured}`)
    }
    console.log(`[browser-batch] ${BROWSER}: ${entries.length} entries (${((Date.now() - t0) / 1000).toFixed(0)}s)`)
  } finally {
    await browser.close()
    rmSync(OUT_DIR, { recursive: true, force: true })
  }
}

await runGate({
  name: 'batch',
  counters: {
    compared: { floor: entries0.length, what: 'generated entries compared (batching, geometry and pixels)' },
    batched: { floor: entries0.filter((e) => e.batched).length, what: 'entries whose batched DOM was really batched' },
  },
  partial: NARROWED,
  run: main,
})
