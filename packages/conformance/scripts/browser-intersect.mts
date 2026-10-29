/**
 * Chromium differential for the expression function `intersect(box, {marktype, markname}, group)`.
 *
 * vega-scenegraph's `intersect` asks a canvas context where a mark has an outline (arc, path), so only a browser can judge it.
 * One Vega spec draws every mark type with an item or two of each (symbols of several shapes, rects, rules, text with an angle,
 * line / area / trail, arcs, paths, images, and a group mark whose items are offset and hold marks of their own); in the same
 * Chromium page real vega and Aster's scene evaluate `intersect()` over a seeded set of boxes -- over the whole scene, by mark
 * name, by mark type, and from a group item's `mark` -- and must return the same items in the same order.
 *
 * Run: pnpm --filter @aster/conformance exec tsx scripts/browser-intersect.mts   (after `pnpm build`)
 */
import { writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const CONF_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const OUT_DIR = join(CONF_DIR, '.tmp-browser-intersect')

const V = (value: unknown) => ({ value })
const F = (field: string) => ({ field })
const ids = (prefix: string, n: number): string[] => Array.from({ length: n }, (_, i) => `${prefix}${i}`)

const spec = {
  width: 400, height: 300, padding: 0, autosize: 'none',
  signals: [
    { name: 'box', value: null }, { name: 'markname', value: '' }, { name: 'marktype', value: '' },
    { name: 'hits', update: "box ? intersect(box, markname ? {markname: markname} : (marktype ? {marktype: marktype} : null)) : []" },
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
import { compileChart, evaluateChart, compileExpr } from '@aster/core'
import '@aster/core/geo'
import '@aster/core/transforms'

window.__run = async (spec, boxes, scopes) => {
  const errors = []
  const view = new vega.View(vega.parse(structuredClone(spec)), { renderer: 'none', logger: { level() { return this }, error(...a) { errors.push(a.map(String).join(' ')); return this }, warn() { return this }, info() { return this }, debug() { return this } } })
  await view.runAsync()
  const scene = evaluateChart(compileChart(structuredClone(spec)), {})
  const runtime = { scale: () => undefined, data: () => undefined, scene: () => scene, expr: (e) => compileExpr(e, runtime) }
  const expr = compileExpr("box ? intersect(box, markname ? {markname: markname} : (marktype ? {marktype: marktype} : null)) : []", runtime)
  // (a group item has no datum of its own at the root: it is named by its mark)
  const idOf = (it, vegaSide) => (it.datum ? it.datum.id : 'G:' + (vegaSide ? it.mark.name : it.name))
  const out = []
  let nonEmpty = 0
  for (const sc of scopes) {
    view.signal('markname', sc.markname || '').signal('marktype', sc.marktype || '')
    for (const b of boxes) {
      errors.length = 0
      await view.signal('box', b).runAsync()
      const want = errors.length ? 'ERR ' + errors[0] : view.signal('hits').map((i) => idOf(i, true))
      let got
      try { got = expr({}, { box: b, markname: sc.markname || '', marktype: sc.marktype || '' }).map((i) => idOf(i, false)) } catch (e) { got = 'ERR ' + e.message }
      if (want.length && typeof want !== 'string') nonEmpty++
      if (JSON.stringify(want) !== JSON.stringify(got)) out.push({ scope: JSON.stringify(sc), box: JSON.stringify(b), want, got })
    }
  }
  view.finalize()
  return { failures: out, nonEmpty }
}
`
rmSync(OUT_DIR, { recursive: true, force: true })
mkdirSync(OUT_DIR, { recursive: true })
writeFileSync(join(OUT_DIR, 'page-entry.ts'), entry)
await build({
  entryPoints: [join(OUT_DIR, 'page-entry.ts')], bundle: true, format: 'iife', platform: 'browser', outfile: join(OUT_DIR, 'page.js'),
  define: { 'process.env.NODE_ENV': '"production"' }, banner: { js: 'var process = { env: { NODE_ENV: "production" } };' }, logLevel: 'silent', absWorkingDir: CONF_DIR,
})
writeFileSync(join(OUT_DIR, 'index.html'), '<!doctype html><html><body><script src="./page.js"></script></body></html>')

const playwright = await import('playwright')
const browser = await playwright.chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] })
const page = await browser.newPage({ deviceScaleFactor: 1 })
page.on('pageerror', (e) => console.error('[page]', e.message.slice(0, 300)))
await page.goto(`file://${join(OUT_DIR, 'index.html')}`)
await page.waitForFunction(() => '__run' in window, null, { timeout: 30_000 })
const t0 = Date.now()
const r = await page.evaluate(([s, b, sc]) => (window as unknown as { __run: (...a: unknown[]) => Promise<{ failures: Array<Record<string, unknown>>; nonEmpty: number }> }).__run(s, b, sc), [spec, boxes, SCOPES] as const)
await browser.close()
rmSync(OUT_DIR, { recursive: true, force: true })

const total = boxes.length * SCOPES.length
console.log(`[browser-intersect] ${total - r.failures.length}/${total} (box, scope) pairs agree with real vega, ${r.nonEmpty} of them non-empty (${((Date.now() - t0) / 1000).toFixed(0)}s)`)
for (const f of r.failures.slice(0, 12)) console.log(`  FAIL scope=${f.scope} box=${f.box}\n    vega  ${JSON.stringify(f.want)}\n    aster ${JSON.stringify(f.got)}`)
// a comparison of empty lists proves nothing: most scopes must have hits somewhere
const MIN_NONEMPTY = 300
if (r.nonEmpty < MIN_NONEMPTY) { console.log(`[browser-intersect] FLOOR: only ${r.nonEmpty} non-empty results < ${MIN_NONEMPTY}`); process.exit(1) }
process.exit(r.failures.length ? 1 : 0)
