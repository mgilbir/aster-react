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
 * Where vega's two renderers disagree at a point (the browser tests an SVG text by its glyphs, its canvas pick by the text's box...) vega
 * has no single answer, and Aster's SVG answer may be either (the rule of browser-signals-pick.mts): those points are counted.
 *
 * The differences that remain are named in src/geometry-differences.ts: each class says what the oracle does there (an attribute SVG
 * rejects, a view of infinite size, glyph cells, a canvas of 32-bit floats), is read off the oracle's own scenegraph and DOM, and must
 * still differ (a class no difference falls into fails the gate as `FIXED-GAP`, on a full run). A difference no class names fails it.
 *
 * Every pick runs under a deadline (SEED_DEADLINE_MS): a page that does not answer fails the gate naming the seed, it never hangs it.
 * vega's own `intersect()` walks one `isPointInPath` per pixel of an item's bounds, which for a path of 1e15 pixels does not end: a box
 * Aster refuses at its work ceiling (`AsterLimitError`, LIMITS.md) is never given to vega's walk, and is counted.
 *
 * Run: pnpm --filter @aster-charts/conformance exec tsx scripts/browser-geometry.mts [--seeds=N]   (after `pnpm build`)
 */
import { writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { cli } from '../../../scripts/lib/cli.mjs'
import { GATE_FLAGS, intOption, runGate } from '../../../scripts/lib/run-gate.mjs'
import { KNOWN_DIFFERENCES } from '../src/geometry-differences.ts'
import { within as deadline } from '../src/deadline.ts'

cli({ url: import.meta.url, flags: { seeds: 'eq', ...GATE_FLAGS } })
const SEEDS = intOption(process.argv.find((a) => a.startsWith('--seeds='))?.slice('--seeds='.length), '--seeds', 160)

const CONF_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const OUT_DIR = join(CONF_DIR, '.tmp-browser-geometry')

const entry = `
import * as vega from 'vega'
import { compileChart, evaluateChart } from '@aster-charts/core'
import { sceneIntersect } from '@aster-charts/core/signals'
import { buildHitIndex } from '@aster-charts/core/hit'
import { loadImages, sceneImageUrls, withSceneImages } from '@aster-charts/core/canvas'
import { genGeometrySpec, rng, MARK_TYPES } from '../src/geometry-specs.ts'
import { vegaPlaces, asterPlaces, nameOf } from '../src/geometry-keys.ts'
import { classify } from '../src/geometry-differences.ts'

// An SVG attribute the browser rejects as vega wrote it: a value that is no number (NaN, Infinity, a unit), a size below 0, a number a
// browser's float cannot hold.
const SINGLE_OVERFLOW = 3.4028235677973366e38
const NUMBER = /^\\s*[+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][+-]?\\d+)?\\s*$/
const NUMBERS = /[+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][+-]?\\d+)?/g
const okNumber = (v) => NUMBER.test(v) && Math.abs(+v) < SINGLE_OVERFLOW
function okTransform(t) {
  const call = /\\s*([a-zA-Z]+)\\(([^)]*)\\)[\\s,]*/y
  let i = 0
  if (t.trim() === '') return true
  while (i < t.length) {
    call.lastIndex = i
    const m = call.exec(t)
    if (!m) return false
    for (const a of m[2].split(/[\\s,]+/).filter(Boolean)) if (!okNumber(a)) return false
    i = call.lastIndex
  }
  return true
}
function okPath(d) {
  if ((d.match(NUMBERS) || []).some((v) => Math.abs(+v) >= SINGLE_OVERFLOW)) return false
  return d.replace(/[MmLlHhVvCcSsQqTtAaZz]/g, ' ').replace(NUMBERS, ' ').replace(/[\\s,]/g, '') === ''
}
/** The attributes of an SVG element, and of the groups above it, that SVG does not take as written. */
function rejectedAttributes(el) {
  const out = []
  for (let n = el; n && n.tagName && n.tagName.toLowerCase() !== 'svg'; n = n.parentNode) {
    const tag = n.tagName.toLowerCase()
    for (const a of ['x', 'y', 'x1', 'y1', 'x2', 'y2', 'width', 'height', 'cx', 'cy', 'r', 'rx', 'ry']) {
      const v = n.getAttribute(a)
      if (v !== null && (!okNumber(v) || ((a === 'width' || a === 'height') && +v < 0))) out.push(tag + '@' + a)
    }
    const t = n.getAttribute('transform')
    if (t !== null && !okTransform(t)) out.push(tag + '@transform')
    const d = n.getAttribute('d')
    if (d !== null && !okPath(d)) out.push(tag + '@d')
  }
  return out
}

const silent = (errors) => ({ level() { return this }, error(...a) { errors.push(a.map(String).join(' ')); return this }, warn() { return this }, info() { return this }, debug() { return this } })

window.__run = async (seed, renderer, plant) => {
  const { spec } = genGeometrySpec(seed)
  const out = { seed, renderer, skipped: null, points: 0, decisive: 0, hits: 0, ambiguous: 0, differ: 0, classes: {}, unknown: [], boxes: 0, boxHits: 0, boxDiffer: [], refused: 0 }
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
  // (an image the browser draws is sized by its bitmap where the item gives no size, and the host that draws Aster's scene has loaded
  // it: the SVG's index is made of the scene as that host holds it. Vega's canvas pick, by bounds measured before the image loaded,
  // and intersect(), by those bounds, take the scene as it was evaluated)
  let indexScene = scene
  let anameIndex = anameOf
  let index
  try {
    if (renderer === 'svg') {
      indexScene = withSceneImages(scene, await loadImages(sceneImageUrls(scene), { timeoutMs: 10_000 }))
      const iname = nameOf(asterPlaces(indexScene).places)
      anameIndex = (it) => iname.get(it) ?? (it && it.items === indexScene.items ? '(root)' : '?')
    }
    index = buildHitIndex(indexScene, undefined, renderer === 'canvas' ? { renderer: 'canvas' } : {})
  } catch (e) { out.skipped = 'aster index: ' + e.message; view.finalize(); return out }
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
  // (the SVG renderer is hit-tested by the browser, which reads an SVG text by its glyphs and recovers from attributes SVG rejects in
  // its own way; vega's canvas renderer picks by vega's own rules. Where the two disagree vega has no single answer, and Aster's
  // may be either, as in browser-signals-pick.mts)
  let canvasAt = null
  let cview = null
  if (renderer === 'svg') {
    const holder2 = document.createElement('div')
    document.body.append(holder2)
    try {
      cview = new vega.View(vega.parse(structuredClone(spec)), { renderer: 'canvas', container: holder2, logger: silent([]) })
      await cview.runAsync()
      const croot = cview.scenegraph().root
      const cname = nameOf(vegaPlaces(croot.items[0]))
      cname.set(croot.items[0], '(root)')
      const corigin = [cview.padding().left + cview._origin[0], cview.padding().top + cview._origin[1]]
      canvasAt = (x, y) => {
        const item = cview._handler.pick(croot, x, y, x - corigin[0], y - corigin[1])
        return item ? (cname.get(item) ?? '(vega: ' + item.mark.marktype + ' ' + item.mark.name + ')') : 'nothing'
      }
    } catch (e) { canvasAt = null }
  }
  // (what the oracle holds about an item, for src/geometry-differences.ts: its mark, the groups above it, its bounds, its SVG element's rejected attributes)
  const domOf = new Map()
  if (renderer === 'svg') for (const e of holder.querySelectorAll('*')) if (e.__data__ && e.__data__.mark) domOf.set(e.__data__, e)
  const sideOf = (name) => {
    const n = vplaces.get(name)
    if (!n) return null
    const groups = []
    for (let g = n.mark && n.mark.group; g && g.mark; g = g.mark.group) groups.push([g.x, g.y, g.width, g.height])
    const b = n.bounds
    const el = domOf.get(n)
    return {
      type: (vplaces.get(name.replace(/\\[\\d+\\]$/, '')) || {}).marktype ?? 'group',
      groups,
      bounds: b ? [b.x1, b.y1, b.x2, b.y2] : [],
      rejected: el ? rejectedAttributes(el) : [],
    }
  }
  const viewOrigin = [view.padding().left + view._origin[0], view.padding().top + view._origin[1]]
  const viewSize = [view._width, view._height]
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
    const got = plant ? '(planted)' : h ? anameIndex(h.item) : 'nothing'
    const alt = canvasAt ? canvasAt(x, y) : want
    if (alt !== want) out.ambiguous++
    if (got !== want && got !== alt) {
      out.differ++
      const cls = classify({ renderer, origin: viewOrigin, size: viewSize, vega: sideOf(want), aster: sideOf(got) })
      if (cls !== null) out.classes[cls] = (out.classes[cls] ?? 0) + 1
      else if (out.unknown.length < 6) out.unknown.push({ x, y, vega: want, aster: got })
      else out.unknown.push(null)
    }
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
      // Aster first: where its work ceiling refuses the box, vega's walk of the same lattice (one isPointInPath per pixel of an
      // item's bounds, which a path of 1e15 pixels makes endless) is not run at all: it has no answer to compare with
      if (plant) got = '(planted)'
      else try { got = sceneIntersect(scene, box, opt, undefined).map(anameOf).join(' ') } catch (e) {
        if (e.name === 'AsterLimitError' && /intersect\\(\\) lattice tests/.test(e.message)) { out.refused++; continue }
        got = 'throws ' + e.message
      }
      try { want = vegaIntersect.call({ context: { dataflow: view } }, box, opt, undefined).map((it) => vname.get(it) ?? '?').join(' ') } catch (e) { want = 'throws ' + e.message }
      if (want !== '' && !want.startsWith('throws')) out.boxHits++
      if (want !== got) out.boxDiffer.push({ box, opt, vega: want, aster: got })
    }
  }
  view.finalize()
  if (cview) cview.finalize()
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

/** One seed takes a few milliseconds; a page still busy (or waiting) after this is hung, and the gate fails naming the seed. */
const SEED_DEADLINE_MS = 60_000
async function within<T>(ms: number, what: string, work: Promise<T>): Promise<T> {
  // (a page that does not answer in time is a crash of the gate, which runGate reports and fails on; a hung page cannot be asked to
  // close, so the process leaves with its browser when runGate exits)
  return deadline(ms, what, work)
}

type Result = {
  seed: number; renderer: string; skipped: string | null; points: number; decisive: number; hits: number; ambiguous: number
  differ: number; classes: Record<string, number>; unknown: Array<Record<string, unknown> | null>
  boxes: number; boxHits: number; boxDiffer: Array<Record<string, unknown>>; refused: number
}
/** A run without `--seeds` is the full one: only it can say that a class of known differences has no difference left in it. */
const FULL = !process.argv.some((a) => a.startsWith('--seeds='))

await runGate({
  name: 'geometry-browser',
  counters: {
    points: { floor: 56000, what: 'decisive pointer positions whose pick Aster answered as vega does (or as a known difference)' },
    boxes: { floor: 17500, what: 'intersect() boxes (by filter) compared with vega' },
  },
  // (a narrowed run, `--seeds=N`, cannot say a known class has no difference left)
  partial: !FULL,
  reads: ['core'],
  run: async (gate) => {
    const t0 = Date.now()
    const playwright = await import('playwright')
    const browser = await playwright.chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] })
    const page = await browser.newPage({ deviceScaleFactor: 1, viewport: { width: 1400, height: 1000 } })
    page.on('pageerror', (e) => console.error('[page]', e.message.slice(0, 300)))
    await page.goto(`file://${join(OUT_DIR, 'index.html')}`)
    await page.waitForFunction(() => '__run' in window, null, { timeout: 30_000 })
    const seen: Record<string, Record<string, number>> = { svg: {}, canvas: {} }
    for (const renderer of ['svg', 'canvas'] as const) {
      const total = { specs: 0, skipped: 0, points: 0, decisive: 0, hits: 0, ambiguous: 0, differ: 0, known: 0, unknown: 0, boxes: 0, boxHits: 0, boxDiffer: 0, refused: 0 }
      for (let seed = 1; seed <= SEEDS; seed++) {
        const r = await within(SEED_DEADLINE_MS, `${renderer} seed ${seed}`, page.evaluate(([s, rd, plant]) => (window as unknown as { __run: (s: number, r: string, p: boolean) => Promise<Result> }).__run(s, rd, plant), [seed, renderer, gate.plant] as const))
        if (r.skipped) { total.skipped++; continue }
        total.specs++
        total.points += r.points; total.decisive += r.decisive; total.hits += r.hits; total.ambiguous += r.ambiguous; total.differ += r.differ
        for (const [id, n] of Object.entries(r.classes)) { total.known += n; seen[renderer]![id] = (seen[renderer]![id] ?? 0) + n }
        total.unknown += r.unknown.length
        total.boxes += r.boxes; total.boxHits += r.boxHits; total.boxDiffer += r.boxDiffer.length; total.refused += r.refused
        gate.count('points', r.decisive)
        gate.count('boxes', r.boxes - r.refused)
        // every difference no class names is a case that differs (the first few of a seed say where; the rest are counted in the last)
        r.unknown.forEach((d, i) => {
          if (d) gate.differ(`pick ${renderer} seed ${seed} (${(d.x as number).toFixed(2)}, ${(d.y as number).toFixed(2)})`, `vega ${d.vega}, aster ${d.aster}`, null)
          else gate.differ(`pick ${renderer} seed ${seed} (more ${i})`, 'a pick that differs, past the six a seed shows', null)
        })
        r.boxDiffer.forEach((d, i) => gate.differ(`intersect ${renderer} seed ${seed} box ${i}`, `${JSON.stringify(d.box)} ${JSON.stringify(d.opt)}: vega [${d.vega}] aster [${d.aster}]`, null))
      }
      console.log(`[geometry-browser] ${renderer}: ${total.specs} specs (${total.skipped} vega or Aster could not run), ${total.decisive}/${total.points} decisive points, ${total.hits} on an item, ${total.ambiguous} where vega's renderers disagree, ${total.differ} differ (${total.known} known: ${JSON.stringify(seen[renderer])}, ${total.unknown} not); ${total.boxes} intersect boxes, ${total.boxHits} meet something, ${total.boxDiffer} differ, ${total.refused} refused by the work ceiling (${((Date.now() - t0) / 1000).toFixed(0)}s)`)
      // what was compared: most specs run, most points decide, and many of them are on an item; boxes meet something (measured: 28 and 16 a seed)
      if (FULL && (total.specs < 0.9 * SEEDS || total.decisive < 0.6 * total.points || total.hits < 20 * SEEDS || total.boxHits < 12 * SEEDS)) {
        gate.problem(`FLOOR (${renderer}): too little was compared to say anything: ${JSON.stringify(total)}`)
      }
    }
    // the known differences are cases of the expected-differences table (scripts/lib/expected-differences.mjs): each class that has
    // differences differs, and (on a full run) one with none is a case that agrees, which the harness fails as FIXED-GAP
    for (const k of KNOWN_DIFFERENCES) {
      const n = (k.renderer === 'both' ? ['svg', 'canvas'] : [k.renderer]).reduce((a, r) => a + (seen[r]![k.id] ?? 0), 0)
      if (n > 0) gate.differ(k.id, `${n} decisive points`, null)
      else if (FULL) gate.agree(k.id, null)
    }
    await within(30_000, 'closing the browser', browser.close())
    rmSync(OUT_DIR, { recursive: true, force: true })
  },
})
