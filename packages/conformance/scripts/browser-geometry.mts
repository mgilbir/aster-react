/**
 * Chromium differential for what is under the pointer and what a box meets, on the generated geometry specs
 * (src/geometry-specs.ts: every mark type and nested group marks, every value class no scale writes -- NaN, the infinities, null, a
 * missing field, numeric and non-numeric strings, huge and negative numbers -- every kind of paint, stroke, cap, join, clip). Each spec
 * is drawn in one page by real vega and by Aster, on each renderer:
 *
 * - the pick: vega's canvas renderer picks with its own canvas handler (`pick`: the bounds first, then `isPointInPath` /
 *   `isPointInStroke` on a real canvas); its SVG renderer is hit-tested by the browser (`elementFromPoint`, the element's item).
 *   Aster's hit index answers `pick(x, y)` for the same renderer (`{ renderer: 'canvas' }` on the canvas). Where vega's own answer
 *   changes within half a pixel of a point -- an edge, which vega's renderers and the browser approximate (Skia flattens curves and
 *   strokes) -- the point does not decide: those are counted, the decisive ones must agree, item by item.
 * - `intersect()`: vega's expression function on vega's scenegraph, which asks this page's canvas for an arc's, a path's and a
 *   shape's outline, against Aster's `intersect` on Aster's scene, over boxes of every size by every filter.
 *
 * Items are named by their place (src/geometry-keys.ts), never by the order they are first met in.
 *
 * Run: pnpm --filter @aster-charts/conformance exec tsx scripts/browser-geometry.mts [--seeds=N]   (after `pnpm build`)
 *
 * Status: NOT GREEN, and so a non-blocking gate (scripts/gates.mjs). On 20 seeds the SVG pass finds 231 of 3401 decisive points
 * where Aster's pick differs from what the browser hit-tests in vega's SVG, and 1 of 1080 intersect boxes. The classes seen: an
 * SVG text hit-tested by its glyphs (vega's two renderers disagree there: this gate should take the rule of browser-signals-pick.mts,
 * Aster's answer one of theirs); a path the browser draws up to its first coordinate that is no number (an area or a line with an
 * infinite or missing y), which Aster's geometry drops whole; group transforms with a unit (`translate(15px,…)`), which Chromium may
 * read as a CSS length. The audit-fix lane a11 left these open (its report says so).
 */
import { writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { cli } from '../../../scripts/lib/cli.mjs'

cli({ url: import.meta.url, flags: { seeds: 'eq' } })
const SEEDS = Number(process.argv.find((a) => a.startsWith('--seeds='))?.slice('--seeds='.length) ?? 160)

const CONF_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const OUT_DIR = join(CONF_DIR, '.tmp-browser-geometry')

const entry = `
import * as vega from 'vega'
import { compileChart, evaluateChart } from '@aster-charts/core'
import { sceneIntersect } from '@aster-charts/core/signals'
import { buildHitIndex } from '@aster-charts/core/hit'
import { genGeometrySpec, rng, MARK_TYPES } from '../src/geometry-specs.ts'
import { vegaPlaces, asterPlaces, nameOf } from '../src/geometry-keys.ts'

const silent = (errors) => ({ level() { return this }, error(...a) { errors.push(a.map(String).join(' ')); return this }, warn() { return this }, info() { return this }, debug() { return this } })

window.__run = async (seed, renderer) => {
  const { spec } = genGeometrySpec(seed)
  const out = { seed, renderer, skipped: null, points: 0, decisive: 0, hits: 0, differ: [], boxes: 0, boxHits: 0, boxDiffer: [], refused: 0 }
  const holder = document.createElement('div')
  document.body.replaceChildren(holder)
  const errors = []
  let view
  try {
    view = new vega.View(vega.parse(structuredClone(spec)), { renderer, container: holder, logger: silent(errors) })
    await view.runAsync()
    if (errors.length) throw new Error(errors[0])
  } catch (e) { out.skipped = 'vega: ' + e.message; if (view) view.finalize(); return out }
  let scene
  try { scene = evaluateChart(compileChart(structuredClone(spec)), {}) } catch (e) { out.skipped = 'aster: ' + e.message; view.finalize(); return out }
  const root = view.scenegraph().root
  const vplaces = vegaPlaces(root.items[0])
  const vname = nameOf(vplaces)
  vname.set(root.items[0], '(root)')
  const { places: aplaces } = asterPlaces(scene)
  const aname = nameOf(aplaces)
  const anameOf = (it) => aname.get(it) ?? (it && it.items === scene.items ? '(root)' : '?')
  let index
  try { index = buildHitIndex(scene, undefined, renderer === 'canvas' ? { renderer: 'canvas' } : {}) } catch (e) { out.skipped = 'aster index: ' + e.message; view.finalize(); return out }
  const el = holder.querySelector(renderer === 'canvas' ? 'canvas' : 'svg')
  const rect = el.getBoundingClientRect()
  const origin = [view.padding().left + view._origin[0], view.padding().top + view._origin[1]]
  const vegaAt = (x, y) => {
    let item = null
    if (renderer === 'canvas') item = view._handler.pick(root, x, y, x - origin[0], y - origin[1])
    else {
      let n = document.elementFromPoint(rect.left + x, rect.top + y)
      while (n && n !== el && !(n.__data__ && n.__data__.mark)) n = n.parentNode
      item = n && n !== el ? n.__data__ : null
    }
    return item ? (vname.get(item) ?? '(vega: ' + item.mark.marktype + ' ' + item.mark.name + ')') : 'nothing'
  }
  const R = rng(seed * 13 + (renderer === 'canvas' ? 1 : 2))
  const W = rect.width, H = rect.height
  const pts = []
  for (let i = 0; i < 150; i++) pts.push([1 + R() * (W - 2), 1 + R() * (H - 2)])
  // (and around what vega drew: inside and near the bounds of its items, where the edges are)
  for (const [, n] of vplaces) {
    if (n.marktype !== undefined || !n.bounds || pts.length > 450) continue
    const b = n.bounds
    if (![b.x1, b.y1, b.x2, b.y2].every((v) => typeof v === 'number' && Math.abs(v) < 1e5)) continue
    let ox = origin[0], oy = origin[1]
    for (let g = n.mark && n.mark.group; g && g.mark; g = g.mark.group) { ox += +(g.x || 0) || 0; oy += +(g.y || 0) || 0 }
    for (let k = 0; k < 3; k++) {
      const p = [ox + b.x1 + R() * (b.x2 - b.x1), oy + b.y1 + R() * (b.y2 - b.y1)]
      // (points on the page: the browser hit-tests only those)
      if (p[0] > 1 && p[1] > 1 && p[0] < W - 1 && p[1] < H - 1) pts.push(p)
    }
  }
  const NEAR = [[0.5, 0], [-0.5, 0], [0, 0.5], [0, -0.5], [0.35, 0.35], [-0.35, 0.35], [0.35, -0.35], [-0.35, -0.35]]
  for (const [x, y] of pts) {
    out.points++
    const want = vegaAt(x, y)
    if (NEAR.some(([dx, dy]) => vegaAt(x + dx, y + dy) !== want)) continue
    out.decisive++
    if (want !== 'nothing') out.hits++
    const h = index.pick(x, y)
    const got = h ? anameOf(h.item) : 'nothing'
    if (got !== want && out.differ.length < 6) out.differ.push({ x, y, vega: want, aster: got })
    else if (got !== want) out.differ.push(null)
  }
  // intersect(): in the root group item's frame, boxes over the view, by every filter
  const vegaIntersect = vega.expressionFunction('intersect')
  const names = [...vplaces].filter(([, v]) => v.marktype !== undefined).map(([, v]) => v.name)
  const filters = [null, { marktype: 'group' }, ...MARK_TYPES.filter(() => R() < 0.3).map((t) => ({ marktype: t })), ...names.filter(() => R() < 0.4).map((n) => ({ markname: n }))]
  for (let k = 0; k < 8; k++) {
    const x = R() * 330 - 15, y = R() * 230 - 15
    const w = [0, 2, 20, 80, 200][Math.floor(R() * 5)], h = [0, 2, 20, 80, 200][Math.floor(R() * 5)]
    const box = [[x, y], [x + w, y + h]]
    for (const opt of filters) {
      out.boxes++
      let want, got
      try { want = vegaIntersect.call({ context: { dataflow: view } }, box, opt, undefined).map((it) => vname.get(it) ?? '?').join(' ') } catch (e) { want = 'throws ' + e.message }
      try { got = sceneIntersect(scene, box, opt, undefined).map(anameOf).join(' ') } catch (e) {
        if (e.name === 'AsterLimitError' && /intersect\\(\\) lattice tests/.test(e.message)) { out.refused++; continue }
        got = 'throws ' + e.message
      }
      if (want !== '' && !want.startsWith('throws')) out.boxHits++
      if (want !== got) out.boxDiffer.push({ box, opt, vega: want, aster: got })
    }
  }
  view.finalize()
  return out
}
`
rmSync(OUT_DIR, { recursive: true, force: true })
mkdirSync(OUT_DIR, { recursive: true })
writeFileSync(join(OUT_DIR, 'page-entry.ts'), entry)
await build({
  entryPoints: [join(OUT_DIR, 'page-entry.ts')], bundle: true, format: 'iife', platform: 'browser', outfile: join(OUT_DIR, 'page.js'),
  define: { 'process.env.NODE_ENV': '"production"' }, banner: { js: 'var process = { env: { NODE_ENV: "production" } };' }, logLevel: 'silent', absWorkingDir: CONF_DIR,
})
writeFileSync(join(OUT_DIR, 'index.html'), '<!doctype html><html><body style="margin:0"><script src="./page.js"></script></body></html>')

const playwright = await import('playwright')
const browser = await playwright.chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] })
const page = await browser.newPage({ deviceScaleFactor: 1, viewport: { width: 1400, height: 1000 } })
page.on('pageerror', (e) => console.error('[page]', e.message.slice(0, 300)))
await page.goto(`file://${join(OUT_DIR, 'index.html')}`)
await page.waitForFunction(() => '__run' in window, null, { timeout: 30_000 })

type Result = { seed: number; renderer: string; skipped: string | null; points: number; decisive: number; hits: number; differ: Array<Record<string, unknown> | null>; boxes: number; boxHits: number; boxDiffer: Array<Record<string, unknown>>; refused: number }
const t0 = Date.now()
let failed = false
for (const renderer of ['svg', 'canvas'] as const) {
  const total = { specs: 0, skipped: 0, points: 0, decisive: 0, hits: 0, differ: 0, boxes: 0, boxHits: 0, boxDiffer: 0, refused: 0 }
  const shown: string[] = []
  for (let seed = 1; seed <= SEEDS; seed++) {
    const r = await page.evaluate(([s, rd]) => (window as unknown as { __run: (s: number, r: string) => Promise<Result> }).__run(s, rd), [seed, renderer] as const)
    if (r.skipped) { total.skipped++; continue }
    total.specs++
    total.points += r.points; total.decisive += r.decisive; total.hits += r.hits; total.differ += r.differ.length
    total.boxes += r.boxes; total.boxHits += r.boxHits; total.boxDiffer += r.boxDiffer.length; total.refused += r.refused
    for (const d of r.differ) if (d && shown.length < 16) shown.push(`  PICK seed ${seed} (${(d.x as number).toFixed(2)}, ${(d.y as number).toFixed(2)}): vega ${d.vega} aster ${d.aster}`)
    for (const d of r.boxDiffer) if (shown.length < 24) shown.push(`  INTERSECT seed ${seed} ${JSON.stringify(d.box)} ${JSON.stringify(d.opt)}: vega [${d.vega}] aster [${d.aster}]`)
  }
  console.log(`[browser-geometry] ${renderer}: ${total.specs} specs (${total.skipped} vega or Aster could not run), ${total.decisive}/${total.points} decisive points, ${total.hits} on an item, ${total.differ} differ; ${total.boxes} intersect boxes, ${total.boxHits} meet something, ${total.boxDiffer} differ, ${total.refused} refused by the lattice ceiling (${((Date.now() - t0) / 1000).toFixed(0)}s)`)
  for (const s of shown) console.log(s)
  if (total.differ || total.boxDiffer) failed = true
  // what was compared: most specs run, most points decide, and many of them are on an item; many boxes meet something
  if (total.specs < 0.9 * SEEDS || total.decisive < 0.6 * total.points || total.hits < 20 * SEEDS || total.boxHits < 20 * SEEDS) {
    console.log(`[browser-geometry] FLOOR (${renderer}): ${JSON.stringify(total)}`)
    failed = true
  }
}
await browser.close()
rmSync(OUT_DIR, { recursive: true, force: true })
process.exit(failed ? 1 : 0)
