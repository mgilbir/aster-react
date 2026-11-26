/**
 * Chromium differential for the expression function `intersect(box, {marktype, markname}, group)`.
 *
 * vega-scenegraph's `intersect` asks a canvas context where a mark has an outline (arc, path), so only a browser can judge it.
 * One Vega spec draws every mark type with an item or two of each (symbols of several shapes, rects, rules, text with an angle,
 * line / area / trail, arcs, paths, images, and a group mark whose items are offset and hold marks of their own); in the same
 * Chromium page real vega and Aster's scene evaluate `intersect()` over a seeded set of boxes -- over the whole scene, by mark
 * name, by mark type, and within a group item's `mark` (the third argument, as Vega-Lite's geo interval selection passes
 * `unit.mark`: the group item is the one a real pointer press on the group gave `item()`, in each engine) -- and must return
 * the same items in the same order (also within the mark of the group an event is in, `group().mark`). It runs on each renderer: vega's view on its svg and its canvas renderer, and Aster's
 * through the signal event loop bound to the svg and to the canvas (`createCanvasEvents`), as `<Chart>` binds it, the box
 * written with `setSignal` and the hits computed by the loop. Each engine's errors are collected apart (an error of vega's is
 * never read as Aster's).
 *
 * The verdict is runGate's (scripts/lib/run-gate.mjs): `compared` counts the (renderer, scope, box) cases, `non-empty` those
 * where vega found something (a comparison of empty lists proves nothing) and `group-scoped` the non-empty ones searched
 * within a group item's mark; each has a floor. `--plant-difference` adds an item to every one of Aster's results.
 *
 * Run: pnpm --filter @aster-charts/conformance exec tsx scripts/browser-intersect.mts [--filter=substr]   (after `pnpm build`)
 */
import { writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { cli } from '../../../scripts/lib/cli.mjs'
import { makeTempDir } from '../../../scripts/lib/temp-dir.mjs'
import { GATE_FLAGS, runGate, type Gate } from '../../../scripts/lib/run-gate.mjs'
import { launchBrowser } from '../../../scripts/lib/launch-browser.mjs'

cli({ url: import.meta.url, flags: { filter: 'eq', ...GATE_FLAGS } })
/** `--filter=substr`: only the scopes (`{"markname":"m_rect"}`...) whose JSON contains it (a narrowed run: no floors). */
const FILTER = process.argv.slice(2).find((a) => a.startsWith('--filter='))?.slice('--filter='.length) ?? ''

const CONF_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const OUT_DIR = makeTempDir('.tmp-browser-intersect-', CONF_DIR) // (one directory per run: concurrent runs do not clobber each other)

const V = (value: unknown) => ({ value })
const F = (field: string) => ({ field })
const ids = (prefix: string, n: number): string[] => Array.from({ length: n }, (_, i) => `${prefix}${i}`)

const spec = {
  width: 400, height: 300, padding: 0, autosize: 'none',
  signals: [
    { name: 'box', value: null }, { name: 'markname', value: '' }, { name: 'marktype', value: '' },
    { name: 'hits', update: "box ? intersect(box, markname ? {markname: markname} : (marktype ? {marktype: marktype} : null)) : []" },
    // the group item a pointer press on a cell of m_group is about, and a search within its mark (vega-lite's `unit.mark`)
    { name: 'unit', value: null, on: [{ events: '@m_group:pointerdown', update: 'item()' }] },
    { name: 'unitHits', update: "box && unit ? intersect(box, markname ? {markname: markname} : (marktype ? {marktype: marktype} : null), unit.mark) : []" },
    // the same within the mark of a data item (a path pressed): its mark node
    { name: 'leaf', value: null, on: [{ events: '@m_path:pointerdown', update: 'item()' }] },
    // and within the mark of the group an event's item sits in (\`group()\`, as vega-lite's \`unit\` signal takes it)
    { name: 'cell', value: null, on: [{ events: '@m_inner:pointerdown', update: 'group()' }] },
    { name: 'cellHits', update: "box && cell ? intersect(box, markname ? {markname: markname} : (marktype ? {marktype: marktype} : null), cell.mark) : []" },
    { name: 'leafHits', update: "box && leaf ? intersect(box, markname ? {markname: markname} : (marktype ? {marktype: marktype} : null), leaf.mark) : []" },
  ],
  data: [
    { name: 'sym', values: ids('s', 14).map((id, i) => ({ id, x: 20 + ((i * 53) % 360), y: 20 + ((i * 37) % 260), size: 40 + (i % 5) * 60, shape: ['circle', 'square', 'diamond', 'triangle-up', 'cross', 'wedge', 'stroke'][i % 7] })) },
    { name: 'rect', values: [
      { id: 'r0', x: 30, y: 40, w: 60, h: 30 }, { id: 'r1', x: 120, y: 90, w: 20, h: 80 }, { id: 'r2', x: 200, y: 20, w: 90, h: 90 }, { id: 'r3', x: 310, y: 150, w: 70, h: 20 },
    ] },
    { name: 'rule', values: [
      { id: 'u0', x: 20, y: 200, x2: 180, y2: 260 }, { id: 'u1', x: 220, y: 280, x2: 380, y2: 220 }, { id: 'u2', x: 100, y: 10, x2: 100, y2: 120 }, { id: 'u3', x: 250, y: 190, x2: 350, y2: 190 },
    ] },
    { name: 'txt', values: [
      { id: 't0', x: 60, y: 120, a: 0, s: 'label' }, { id: 't1', x: 160, y: 150, a: 40, s: 'rotated' }, { id: 't2', x: 280, y: 250, a: -90, s: 'vertical' }, { id: 't3', x: 330, y: 60, a: 0, s: 'right' },
    ] },
    { name: 'pts', values: ids('p', 8).map((id, i) => ({ id, x: 30 + i * 45, y: 60 + ((i * 41) % 120), v: 4 + (i % 3) * 6 })) },
    { name: 'arcs', values: [
      { id: 'a0', x: 90, y: 220, r0: 0, r: 50, a0: 0, a1: 4.2 }, { id: 'a1', x: 250, y: 110, r0: 20, r: 55, a0: 1, a1: 5.5 }, { id: 'a2', x: 340, y: 240, r0: 10, r: 30, a0: 0, a1: 6.28 },
    ] },
    { name: 'paths', values: [
      { id: 'q0', x: 30, y: 30, p: 'M0,0L60,10L40,70L-10,50Z' }, { id: 'q1', x: 200, y: 200, p: 'M0,0C40,-40 80,40 120,0L120,40L0,40Z' }, { id: 'q2', x: 300, y: 80, p: 'M0,0L50,0L50,50L0,50ZM15,15L35,15L35,35L15,35Z' },
    ] },
    { name: 'imgs', values: [{ id: 'i0', x: 50, y: 60, w: 40, h: 40 }, { id: 'i1', x: 300, y: 200, w: 60, h: 30 }] },
    { name: 'cells', values: [{ id: 'g0', x: 10, y: 10 }, { id: 'g1', x: 200, y: 150 }] },
    { name: 'inner', values: [{ id: 'n0', x: 15, y: 15 }, { id: 'n1', x: 70, y: 40 }] },
  ],
  marks: [
    { type: 'symbol', name: 'm_symbol', from: { data: 'sym' }, encode: { update: { x: F('x'), y: F('y'), size: F('size'), shape: F('shape'), fill: V('steelblue'), stroke: V('black') } } },
    { type: 'rect', name: 'm_rect', from: { data: 'rect' }, encode: { update: { x: F('x'), y: F('y'), width: F('w'), height: F('h'), fill: V('tomato') } } },
    { type: 'rect', name: 'm_rect2', from: { data: 'rect' }, encode: { update: { x: F('x'), x2: { signal: 'datum.x + datum.w + 10' }, y: { signal: 'datum.y + datum.h' }, y2: F('y'), fill: V('gray'), opacity: V(0.3) } } },
    { type: 'rule', name: 'm_rule', from: { data: 'rule' }, encode: { update: { x: F('x'), y: F('y'), x2: F('x2'), y2: F('y2'), stroke: V('black'), strokeWidth: V(3) } } },
    { type: 'text', name: 'm_text', from: { data: 'txt' }, encode: { update: { x: F('x'), y: F('y'), angle: F('a'), text: F('s'), fontSize: V(14), fill: V('black') } } },
    { type: 'line', name: 'm_line', from: { data: 'pts' }, encode: { update: { x: F('x'), y: F('y'), stroke: V('green'), strokeWidth: V(2) } } },
    { type: 'area', name: 'm_area', from: { data: 'pts' }, encode: { update: { x: F('x'), y: F('y'), y2: V(280), fill: V('lightgreen'), opacity: V(0.4) } } },
    { type: 'trail', name: 'm_trail', from: { data: 'pts' }, encode: { update: { x: F('x'), y: { signal: 'datum.y + 40' }, size: F('v'), fill: V('purple') } } },
    { type: 'arc', name: 'm_arc', from: { data: 'arcs' }, encode: { update: { x: F('x'), y: F('y'), innerRadius: F('r0'), outerRadius: F('r'), startAngle: F('a0'), endAngle: F('a1'), fill: V('orange') } } },
    { type: 'path', name: 'm_path', from: { data: 'paths' }, encode: { update: { x: F('x'), y: F('y'), path: F('p'), fill: V('teal'), stroke: V('black') } } },
    { type: 'image', name: 'm_image', from: { data: 'imgs' }, encode: { update: { x: F('x'), y: F('y'), width: F('w'), height: F('h'), url: V('data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==') } } },
    {
      type: 'group', name: 'm_group', from: { data: 'cells' },
      encode: { update: { x: F('x'), y: F('y'), width: V(90), height: V(70), fill: V('transparent'), stroke: V('red') } },
      marks: [{ type: 'symbol', name: 'm_inner', from: { data: 'inner' }, encode: { update: { x: F('x'), y: F('y'), size: V(100), fill: V('blue') } } }],
    },
  ],
}

// a seeded set of boxes: tiny, thin, wide, large, and the whole view
let seed = 7
const rnd = (): number => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32 }
const boxes: number[][][] = [[[0, 0], [400, 300]], [[390, 290], [395, 295]], [[200, 150], [200, 150]]]
for (let i = 0; i < 160; i++) {
  const w = [3, 15, 40, 90, 200][Math.floor(rnd() * 5)]!
  const h = [3, 15, 40, 90, 200][Math.floor(rnd() * 5)]!
  const x = rnd() * (400 - 1)
  const y = rnd() * (300 - 1)
  boxes.push(rnd() < 0.2 ? [[x + w, y + h], [x, y]] : [[x, y], [x + w, y + h]])
}
const SCOPES: Array<{ markname?: string; marktype?: string }> = [
  {}, ...['m_symbol', 'm_rect', 'm_rect2', 'm_rule', 'm_text', 'm_line', 'm_area', 'm_trail', 'm_arc', 'm_path', 'm_image', 'm_group', 'm_inner'].map((markname) => ({ markname })),
  { marktype: 'symbol' }, { marktype: 'rect' }, { marktype: 'group' },
]

const entry = `
import * as vega from 'vega'
import { compileChart, evaluateChart, compileExpr } from '@aster-charts/core'
import { sceneIntersect, bindSceneSignals } from '@aster-charts/core/signals'
import { renderSceneToDomElement } from '@aster-charts/core/dom'
import { renderSceneToCanvas, createCanvasEvents } from '@aster-charts/core/canvas'
import { buildHitIndex } from '@aster-charts/core/hit'
import '@aster-charts/core/geo'
import '@aster-charts/core/transforms'

let state = null

/** Build vega's view and Aster's bound scene on one renderer, one above the other; returns where each one's cell g1 is. */
window.__prepare = async (spec, renderer) => {
  const vegaErrors = []
  const asterErrors = []
  document.body.replaceChildren()
  document.body.style.margin = '0'
  const holder = document.createElement('div')
  document.body.appendChild(holder)
  const sink = (list) => ({ level() { return this }, error(...a) { list.push(a.map(String).join(' ')); return this }, warn() { return this }, info() { return this }, debug() { return this } })
  const view = new vega.View(vega.parse(structuredClone(spec)), { renderer, container: holder, logger: sink(vegaErrors) })
  await view.runAsync()
  const scene = evaluateChart(compileChart(structuredClone(spec)), {})
  // Aster's event loop on the same renderer: \`hits\` is a signal it computes when \`box\` is written (setSignal)
  const mine = document.createElement('div')
  document.body.appendChild(mine)
  let el
  let events
  if (renderer === 'canvas') {
    el = document.createElement('canvas')
    el.width = scene.width; el.height = scene.height
    renderSceneToCanvas(scene, el.getContext('2d'), { dpr: 1 })
    events = createCanvasEvents(el)
  } else {
    el = renderSceneToDomElement(scene)
  }
  mine.appendChild(el)
  const store = {}
  const hit = buildHitIndex(scene, undefined, renderer === 'canvas' ? { renderer: 'canvas' } : {})
  const binding = bindSceneSignals(el, scene, store, { logger: { error: (...a) => asterErrors.push(a.map(String).join(' ')), warn() {} } }, { pick: (x, y) => hit.pick(x, y), ...(events ? { events } : {}) })
  state = { view, scene, store, binding, events, vegaErrors, asterErrors }
  const at = (node) => { const r = node.getBoundingClientRect(); return [r.left, r.top] }
  // (cell g1: x 200..290, y 150..220 in the view; the point is inside it and on none of its own marks)
  return { vega: at(holder.firstElementChild || holder), aster: at(el), cell: [270, 160], path: [305, 85], inner: [215, 165] }
}

const vegaIntersect = vega.expressionFunction('intersect')

window.__run = (boxes, scopes, plant) => {
  const { view, scene, store, binding, events, vegaErrors, asterErrors } = state
  // the expression as written, over the scene (no event loop): the function's own answer
  const runtime = { scale: () => undefined, data: () => undefined, intersect: (b, o, g) => sceneIntersect(scene, b, o, g), expr: (e) => compileExpr(e, runtime) }
  const filterText = "markname ? {markname: markname} : (marktype ? {marktype: marktype} : null)"
  const expr = compileExpr("box ? intersect(box, " + filterText + ") : []", runtime)
  const unitExpr = compileExpr("box && unit ? intersect(box, " + filterText + ", unit.mark) : []", runtime)
  const itemExpr = compileExpr("box && unit ? intersect(box, " + filterText + ", unit) : []", runtime)
  const leafExpr = compileExpr("box && leaf ? intersect(box, " + filterText + ", leaf.mark) : []", runtime)
  const cellExpr = compileExpr("box && cell ? intersect(box, " + filterText + ", cell.mark) : []", runtime)
  // (a group item has no datum of its own at the root: it is named by its mark)
  const idOf = (it, vegaSide) => (it.datum ? it.datum.id : 'G:' + (vegaSide ? it.mark.name : it.name))
  const planted = (list) => (plant && Array.isArray(list) ? [...list, 'PLANTED'] : list)
  const unitPressed = { vega: view.signal('unit') != null && view.signal('leaf') != null && view.signal('cell') != null, aster: store.unit != null && store.leaf != null && store.cell != null }
  const out = []
  return (async () => {
    for (const sc of scopes) {
      view.signal('markname', sc.markname || '').signal('marktype', sc.marktype || '')
      binding.setSignal('markname', sc.markname || '')
      binding.setSignal('marktype', sc.marktype || '')
      for (let bi = 0; bi < boxes.length; bi++) {
        const b = boxes[bi]
        vegaErrors.length = 0
        await view.signal('box', b).runAsync()
        const vegaFailed = vegaErrors.length ? 'ERR ' + vegaErrors[0] : null
        const want = vegaFailed ?? view.signal('hits').map((i) => idOf(i, true))
        const wantUnit = vegaFailed ?? view.signal('unitHits').map((i) => idOf(i, true))
        const wantLeaf = vegaFailed ?? view.signal('leafHits').map((i) => idOf(i, true))
        const wantCell = vegaFailed ?? view.signal('cellHits').map((i) => idOf(i, true))
        // the group item itself as the third argument: vega's function, called as its expression calls it (vega takes a mark
        // node there; an item is an error), and Aster's
        const filterArg = sc.markname ? { markname: sc.markname } : sc.marktype ? { marktype: sc.marktype } : null
        let wantItem
        try { wantItem = vegaIntersect.call({ context: { dataflow: view } }, b, filterArg, view.signal('unit')).map((i) => idOf(i, true)) } catch (e) { wantItem = 'ERR ' + e.message }
        const signals = { box: b, markname: sc.markname || '', marktype: sc.marktype || '', unit: store.unit, leaf: store.leaf, cell: store.cell }
        let got
        let gotUnit
        try { got = planted(expr({}, signals).map((i) => idOf(i, false))) } catch (e) { got = 'ERR ' + e.message }
        try { gotUnit = planted(unitExpr({}, signals).map((i) => idOf(i, false))) } catch (e) { gotUnit = 'ERR ' + e.message }
        let gotLeaf
        try { gotLeaf = planted(leafExpr({}, signals).map((i) => idOf(i, false))) } catch (e) { gotLeaf = 'ERR ' + e.message }
        let gotCell
        try { gotCell = planted(cellExpr({}, signals).map((i) => idOf(i, false))) } catch (e) { gotCell = 'ERR ' + e.message }
        let gotItem
        try { gotItem = planted(itemExpr({}, signals).map((i) => idOf(i, false))) } catch (e) { gotItem = 'ERR ' + e.message }
        asterErrors.length = 0
        binding.setSignal('box', b)
        const asterFailed = asterErrors.length ? 'ERR ' + asterErrors[0] : null
        const viaLoop = asterFailed ?? planted((store.hits || []).map((i) => idOf(i, false)))
        const unitViaLoop = asterFailed ?? planted((store.unitHits || []).map((i) => idOf(i, false)))
        const leafViaLoop = asterFailed ?? planted((store.leafHits || []).map((i) => idOf(i, false)))
        const cellViaLoop = asterFailed ?? planted((store.cellHits || []).map((i) => idOf(i, false)))
        const key = 'scope=' + JSON.stringify(sc) + ' box#' + bi
        const cmp = (scope, w, g, l) => {
          const fail = JSON.stringify(w) !== JSON.stringify(g) ? { got: g } : JSON.stringify(w) !== JSON.stringify(l) ? { got: { 'through the event loop': l } } : null
          out.push({ key: scope + ' ' + key, nonEmpty: Array.isArray(w) && w.length > 0, ...(fail ? { want: w, box: JSON.stringify(b), ...fail } : {}) })
        }
        cmp('root', want, got, viaLoop)
        cmp('unit.mark', wantUnit, gotUnit, unitViaLoop)
        cmp('leaf.mark', wantLeaf, gotLeaf, leafViaLoop)
        cmp('group().mark', wantCell, gotCell, cellViaLoop)
        cmp('unit', wantItem, gotItem, gotItem)
      }
    }
    view.finalize()
    binding.release()
    if (events) events.release()
    return { cases: out, unitPressed }
  })()
}
`

interface Case { key: string; nonEmpty: boolean; want?: unknown; got?: unknown; box?: string }

async function main(gate: Gate): Promise<void> {
  const playwright = await import('playwright')
  const browser = await launchBrowser(playwright.chromium, { headless: true, args: ['--disable-dev-shm-usage'] })
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1, viewport: { width: 500, height: 700 } })
    page.on('pageerror', (e) => gate.problem(`page error: ${e.message.slice(0, 300)}`))
    await page.goto(`file://${join(OUT_DIR, 'index.html')}`)
    await page.waitForFunction(() => '__run' in window, null, { timeout: 30_000 })
    const t0 = Date.now()
    for (const renderer of ['svg', 'canvas'] as const) {
      const where = await page.evaluate(([s, rd]) => (window as unknown as { __prepare: (...a: unknown[]) => Promise<{ vega: number[]; aster: number[]; cell: number[]; path: number[]; inner: number[] }> }).__prepare(s, rd), [spec, renderer] as const)
      // real pointer presses, in each engine: on cell g1 of m_group (`unit` is the group item) and on path q2 (`leaf`)
      for (const origin of [where.vega, where.aster]) {
        await page.mouse.click(origin[0]! + where.cell[0]!, origin[1]! + where.cell[1]!)
        await page.mouse.click(origin[0]! + where.path[0]!, origin[1]! + where.path[1]!)
        await page.mouse.click(origin[0]! + where.inner[0]!, origin[1]! + where.inner[1]!)
      }
      const scopes = SCOPES.filter((sc) => !FILTER || JSON.stringify(sc).includes(FILTER))
      const r = await page.evaluate(([b, sc, pl]) => (window as unknown as { __run: (...a: unknown[]) => Promise<{ cases: Case[]; unitPressed: { vega: boolean; aster: boolean } }> }).__run(b, sc, pl), [boxes, scopes, gate.plant] as const)
      if (!r.unitPressed.vega) gate.problem(`${renderer}: the presses gave vega no \`unit\` or \`leaf\` (the scoped cases would compare nothing)`)
      if (!r.unitPressed.aster) gate.problem(`${renderer}: the presses gave Aster no \`unit\` or \`leaf\` (vega got them)`)
      let fails = 0
      for (const c of r.cases) {
        const name = `${renderer} ${c.key}`
        if (c.want === undefined) gate.agree(name)
        else {
          gate.differ(name, `box=${c.box} vega ${JSON.stringify(c.want)} aster ${JSON.stringify(c.got)}`)
          fails++
        }
        if (c.nonEmpty) gate.count(`non-empty-${renderer}`)
        if (c.nonEmpty && c.key.startsWith('unit.mark')) gate.count('group-scoped')
        if (c.nonEmpty && c.key.startsWith('leaf.mark')) gate.count('mark-scoped')
        if (c.nonEmpty && c.key.startsWith('group().mark')) gate.count('enclosing-scoped')
      }
      console.log(`[browser-intersect] ${renderer}: ${r.cases.length - fails}/${r.cases.length} (scope, box) pairs agree with real vega (${((Date.now() - t0) / 1000).toFixed(0)}s)`)
    }
  } finally {
    await browser.close()
    rmSync(OUT_DIR, { recursive: true, force: true })
  }
}

await runGate({
  name: 'intersect-browser',
  partial: Boolean(FILTER),
  counters: {
    compared: { floor: 2 * 5 * boxes.length * SCOPES.length, what: '(renderer, search, scope, box) cases compared with real vega' },
    // a comparison of empty lists proves nothing: most scopes must have hits somewhere
    'non-empty-svg': { floor: 1236, what: 'cases on the svg renderer where vega found items' },
    'non-empty-canvas': { floor: 1236, what: 'cases on the canvas renderer where vega found items' },
    'group-scoped': { floor: 280, what: 'non-empty cases searched within a group item\'s mark (the third argument)' },
    'mark-scoped': { floor: 252, what: 'non-empty cases searched within a data item\'s mark' },
    'enclosing-scoped': { floor: 280, what: 'non-empty cases searched within the mark of the group an event is in (group().mark)' },
  },
  run: async (gate) => {
    rmSync(OUT_DIR, { recursive: true, force: true })
    mkdirSync(OUT_DIR, { recursive: true })
    writeFileSync(join(OUT_DIR, 'page-entry.ts'), entry)
    await build({
      entryPoints: [join(OUT_DIR, 'page-entry.ts')], bundle: true, format: 'iife', platform: 'browser', outfile: join(OUT_DIR, 'page.js'),
      define: { 'process.env.NODE_ENV': '"production"' }, banner: { js: 'var process = { env: { NODE_ENV: "production" } };' }, logLevel: 'silent', absWorkingDir: CONF_DIR,
    })
    writeFileSync(join(OUT_DIR, 'index.html'), '<!doctype html><html><body><script src="./page.js"></script></body></html>')
    await main(gate)
  },
})
