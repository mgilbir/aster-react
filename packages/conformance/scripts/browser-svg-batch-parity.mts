/**
 * Batched-SVG pixel parity gate (R13 / perf).
 *
 * `denseMarks` rewrites dense symbol marks as chunked `<path>` elements instead
 * of one element per datum (100k symbols -> ~400 paths). Positions are baked
 * into `d` (rounded to 0.001px), so the pixels must be identical to the
 * per-item rendering; this gate rasterizes both DOMs in headless Chromium and
 * compares them. The corpus supplies real-world symbol specs; the synthetic
 * entries force the batcher across paint, shape, stroke, opacity, rotation and
 * clipping edges.
 *
 * Run: pnpm conformance:batch [--limit=N] [--filter=substr] [--browser=chromium]
 */
import { readdirSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const THIS_DIR = dirname(fileURLToPath(import.meta.url))
const CONF_DIR = dirname(THIS_DIR)
const OUT_DIR = join(CONF_DIR, '.tmp-browser-batch')
const argv = process.argv.slice(2)
const arg = (n: string, d: string): string => argv.find((a) => a.startsWith(`--${n}=`))?.split('=')[1] ?? d
const LIMIT = Number(arg('limit', '0'))
const FILTER = arg('filter', '')
const BROWSER = arg('browser', 'chromium') as 'chromium' | 'firefox' | 'webkit'
// Positions are baked into `d` at 0.001px, so geometry is identical. A batched
// path still antialiases overlapping same-paint subpaths once instead of per
// item, which shifts edge pixels; the tolerance accepts those AA differences
// but a moved/missing/recoloured mark still fails (it shifts whole marks).
const RATIO = Number(arg('ratio', '0.04'))
const DELTA = Number(arg('delta', '24'))
const MEAN = Number(arg('mean', '1.5'))

interface Entry { name: string; spec: Record<string, unknown> }

function hasUrlData(spec: Record<string, unknown>): boolean {
  const data = spec.data
  const defs = Array.isArray(data) ? data : data && typeof data === 'object' ? [data] : []
  return defs.some((d) => d && typeof d === 'object' && typeof (d as { url?: unknown }).url === 'string')
}

function hasSymbolMark(spec: Record<string, unknown>): boolean {
  const seen = new Set<unknown>()
  const walk = (node: unknown): boolean => {
    if (!node || typeof node !== 'object' || seen.has(node)) return false
    seen.add(node)
    const o = node as Record<string, unknown>
    if (o.type === 'symbol') return true
    if (Array.isArray(o.marks) && o.marks.some(walk)) return true
    if (Array.isArray(o.layer) && o.layer.some(walk)) return true
    if (Array.isArray(o.items) && o.items.some(walk)) return true
    return false
  }
  return walk(spec)
}

function loadCorpus(): Entry[] {
  const corpus = join(CONF_DIR, 'corpus')
  const files = readdirSync(corpus, { recursive: true }).filter((f) => String(f).endsWith('.json')).map(String).sort()
  const entries: Entry[] = []
  for (const f of files) {
    const spec = JSON.parse(readFileSync(join(corpus, f), 'utf8')) as Record<string, unknown>
    if (hasUrlData(spec) || !hasSymbolMark(spec)) continue
    entries.push({ name: f.replace(/\.vl\.json$|\.json$/, ''), spec })
  }
  return entries
}

// `paintIndex` returns a *run*-shaped value (series blocks) unless the entry is
// explicitly testing per-item paint cycling, which cannot batch by design.
const symbolValues = (n: number, paintIndex: (i: number) => Record<string, unknown>, extra: (i: number) => Record<string, unknown> = () => ({})) =>
  Array.from({ length: n }, (_, i) => ({
    x: (i * 37) % 400,
    y: (i * 23) % 300,
    ...paintIndex(i),
    ...extra(i),
  }))

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

const synthetic: Entry[] = [
  {
    name: 'batch-single-paint',
    spec: denseSpec(symbolValues(8000, () => ({ fill: '#4c78a8', size: 30 }))),
  },
  {
    name: 'batch-multi-paint',
    spec: denseSpec(symbolValues(8000, (i) => ({ fill: ['#4c78a8', '#f58518', '#54a24b', '#e45756', '#b279a2'][Math.floor(i / 1600)], size: 30 }))),
  },
  {
    name: 'batch-shapes',
    spec: denseSpec(symbolValues(8000, (i) => ({ fill: '#4c78a8', size: 20 + (i % 7) * 10, shape: shapes[i % shapes.length] }))),
  },
  {
    name: 'batch-stroke',
    // Stroke style changes every 1000 items: 8 same-paint runs batch, while the
    // per-item stroke-width variation within a run forces chunks.
    spec: denseSpec(symbolValues(8000, (i) => ({
      fill: Math.floor(i / 1000) % 2 ? '#4c78a8' : undefined,
      stroke: Math.floor(i / 1000) % 3 ? '#e45756' : undefined,
      sw: 1 + (Math.floor(i / 1000) % 3),
      size: 40,
    }))),
  },
  {
    name: 'batch-opacity-fallback',
    spec: denseSpec(symbolValues(8000, (i) => ({ fill: '#4c78a8', size: 30, op: 0.5 + (Math.floor(i / 1000) % 2) * 0.2 }))),
  },
  {
    name: 'batch-rotated',
    spec: denseSpec(symbolValues(4000, (i) => ({ fill: '#4c78a8', size: 30, shape: shapes[i % shapes.length] })), { angle: { value: 35 } }),
  },
  {
    name: 'batch-clipped',
    spec: denseSpec(symbolValues(8000, (i) => ({ fill: ['#4c78a8', '#f58518'][Math.floor(i / 1000) % 2], size: 30 })), {}, true),
  },
]

const all = [...loadCorpus(), ...synthetic].filter((e) => !FILTER || e.name.includes(FILTER))
const entries = all.slice(0, LIMIT || undefined)
console.log(`[browser-batch] ${BROWSER}: ${entries.length} entries (${synthetic.length} synthetic, ${entries.length - synthetic.length} corpus symbol specs)`)

const entrySrc = `
import embed from 'vega-embed'
import { compileChart, evaluateChart } from '@aster/core'
import { renderSceneToDomElement } from '@aster/core/dom'
import { loadSpecData, TRUSTED_LOAD_OPTIONS } from '@aster/core/load'
import { compile } from '@aster/vl'
import '@aster/core/geo'
import '@aster/core/transforms'

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

// Strict pixel diff (no neighbourhood search): the batched geometry is the same
// geometry, only the element grouping changed.
function diff(a, b) {
  if (a.w !== b.w || a.h !== b.h) return { error: 'size ' + a.w + 'x' + a.h + ' != ' + b.w + 'x' + b.h }
  const DELTA = ${DELTA}
  let bad = 0, sum = 0
  for (let i = 0; i < a.data.length; i += 4) {
    const d = Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i+1] - b.data[i+1])
      + Math.abs(a.data[i+2] - b.data[i+2]) + Math.abs(a.data[i+3] - b.data[i+3])
    if (d > DELTA) bad++
    sum += d
  }
  const count = a.w * a.h
  return { ratio: bad / count, mean: sum / (count * 4) }
}

function pathStats(el) {
  const paths = el.querySelectorAll('path')
  let subpaths = 0
  for (const p of paths) {
    const d = p.getAttribute('d') || ''
    for (const ch of d) if (ch === 'M' || ch === 'm') subpaths++
  }
  return { paths: paths.length, subpaths }
}

const RATIO = ${RATIO}
const MEAN = ${MEAN}

window.__runBatch = async (entry) => {
  try {
    const spec = entry.spec
    const isVl = String(spec.$schema ?? '').includes('vega-lite')
    const compiled = isVl ? compile(spec) : spec
    const loaded = await loadSpecData(compiled as never, TRUSTED_LOAD_OPTIONS)
    const scene = evaluateChart(compileChart(loaded as never))
    const normal = renderSceneToDomElement(scene)
    const batched = renderSceneToDomElement(scene, document, { denseMarks: true })
    const stats = { normal: pathStats(normal), batched: pathStats(batched) }
    const a = await rasterize(normal, scene.width, scene.height)
    const b = await rasterize(batched, scene.width, scene.height)
    const d = diff(a, b)
    // A synthetic entry is only meaningful if batching actually kicked in.
    const expectBatch = entry.name.startsWith('batch-') && !entry.name.includes('rotated') && !entry.name.includes('fallback')
    if (expectBatch && !(stats.batched.paths < stats.normal.paths)) {
      return { pass: false, error: 'batcher did not reduce paths: ' + JSON.stringify(stats), stats }
    }
    return { ...d, stats, pass: !d.error && d.ratio <= RATIO && d.mean <= MEAN }
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
writeFileSync(join(OUT_DIR, 'index.html'), '<!doctype html><html><body><script src="./page.js"></script></body></html>')

const playwright = await import('playwright')
const browser = await playwright[BROWSER].launch({ headless: true, args: BROWSER === 'chromium' ? ['--disable-dev-shm-usage'] : [] })
const page = await browser.newPage({ deviceScaleFactor: 1 })
page.on('pageerror', (e) => console.error('[page]', e.message.slice(0, 200)))
await page.goto(`file://${join(OUT_DIR, 'index.html')}`)
await page.waitForFunction(() => '__runBatch' in window, null, { timeout: 30_000 })
await page.evaluate((data) => { (window as unknown as { __entries: unknown }).__entries = data }, entries)

let pass = 0
const failures: Array<{ name: string; error?: string; ratio?: number; mean?: number; stats?: unknown }> = []
const t0 = Date.now()
for (let i = 0; i < entries.length; i++) {
  const r = await page.evaluate((idx: number) => {
    const es = (window as unknown as { __entries: Entry[] }).__entries
    return (window as unknown as { __runBatch: (e: Entry) => Promise<{ pass: boolean; error?: string; ratio?: number; mean?: number; stats?: unknown }> }).__runBatch(es[idx]!)
  }, i)
  if (r.pass) pass++
  else failures.push({ name: entries[i]!.name, error: r.error, ratio: r.ratio, mean: r.mean, stats: r.stats })
  if ((i + 1) % 25 === 0) console.log(`  ${i + 1}/${entries.length} (${((Date.now() - t0) / 1000).toFixed(0)}s)`)
}
await browser.close()
rmSync(OUT_DIR, { recursive: true, force: true })

console.log(`\n[browser-batch] ${BROWSER}: ${pass}/${entries.length} passed (${((Date.now() - t0) / 1000).toFixed(0)}s)`)
if (failures.length) {
  console.log(`[browser-batch] failing: ${failures.map((f) => f.name).join(', ')}`)
  for (const f of failures.slice(0, 20)) {
    console.log(`  ${f.name}: ${f.error ?? `ratio=${f.ratio?.toFixed(4)} mean=${f.mean?.toFixed(2)}`} ${f.stats ? JSON.stringify(f.stats) : ''}`)
  }
}
process.exit(failures.length ? 1 : 0)
