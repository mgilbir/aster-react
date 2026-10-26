/**
 * Real-browser differential for Vega-Lite selections.
 *
 * Each case is a Vega-Lite spec (inline data) mounted twice in headless Chromium, each in its own page:
 * vega-lite 6.4.3's compiled spec in a real vega `View`, and Aster's own `@aster/vl` output in `<Chart>`
 * (which brings the signal event loop and hit testing). The SAME native input -- Playwright mouse, wheel,
 * keyboard and form-control events -- is driven through both, and after EVERY step the two must agree on
 *
 *   - the value of every signal of the compiled spec,
 *   - the contents of every selection store (`<param>_store`, after its transforms),
 *   - the rendered SVG (the strict canonicalizer of the conformance gates).
 *
 * A case that can never differ proves nothing, so each names the steps after which its selection store (or, for
 * bound scales, a scale domain / signal) must have changed on the vega side (`expect`): a vacuous case fails.
 *
 * Run: pnpm conformance:selections [--filter=substr] [--min-cases=N]   (after `pnpm build`)
 */
import { writeFileSync, rmSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import type { Page } from 'playwright'
import { canonicalizeSvg, diffCanonical } from '../src/normalize.js'

const THIS_DIR = dirname(fileURLToPath(import.meta.url))
const CONF_DIR = dirname(THIS_DIR)
const ROOT = dirname(dirname(CONF_DIR))
const REACT_DIR = join(ROOT, 'packages', 'react')
const OUT_DIR = join(CONF_DIR, '.tmp-browser-vl-selections')
const argv = process.argv.slice(2)
const arg = (n: string, d: string): string => argv.find((a) => a.startsWith(`--${n}=`))?.split('=')[1] ?? d
const FILTER = arg('filter', '')
const MIN_CASES = Number(arg('min-cases', '0'))
const require = createRequire(import.meta.url)
void require

// ---- cases ------------------------------------------------------------------------

/** Positions are fractions (0..1) of the plot frame, so both pages use the same absolute point. */
type Step =
  | { t: 'move'; x: number; y: number }
  | { t: 'down' | 'up' }
  | { t: 'click'; x: number; y: number; shift?: boolean }
  | { t: 'dblclick'; x: number; y: number }
  | { t: 'drag'; x0: number; y0: number; x1: number; y1: number; shift?: boolean }
  | { t: 'wheel'; x: number; y: number; dy: number; shift?: boolean }
  | { t: 'clickMark'; i: number; shift?: boolean; sel?: string }
  | { t: 'moveMark'; i: number }
  | { t: 'clickLegend'; part: string; i: number; shift?: boolean }
  | { t: 'dblclickLegend'; part: string; i: number }
  | { t: 'input'; i: number; value: string | boolean }
  | { t: 'key'; key: string }

interface Case {
  name: string
  spec: Record<string, unknown>
  steps: Step[]
  /** Indices of the steps after which the vega side's stores / signals must differ from before the step. */
  moves: number[]
  /**
   * Vega keeps the tick items of an axis across updates and appends the ones a pan brings in; Aster, a pure function
   * of its inputs, draws them in scale order (docs/INTERACTION.md, "a signal write is a fresh render"). A case that
   * pans or zooms a scale accepts exactly that difference: the SAME records in another paint order.
   */
  retainedTickOrder?: boolean
}

const ROWS = [
  { a: 1, b: 3, c: 'x', d: '2020-01-01' }, { a: 2, b: 5, c: 'y', d: '2020-03-01' }, { a: 3, b: 2, c: 'x', d: '2020-06-01' },
  { a: 4, b: 6, c: 'z', d: '2020-09-01' }, { a: 5, b: 4, c: 'y', d: '2021-01-01' }, { a: 6, b: 7, c: 'z', d: '2021-04-01' },
]
const base = (extra: Record<string, unknown>): Record<string, unknown> => ({
  $schema: 'https://vega.github.io/schema/vega-lite/v6.json', data: { values: ROWS }, width: 300, height: 200, ...extra,
})
const xy = { x: { field: 'a', type: 'quantitative' }, y: { field: 'b', type: 'quantitative' } }
const colorBy = (param: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  condition: { param, field: 'c', type: 'nominal', ...extra }, value: 'lightgray',
})
const sel = (name: string, select: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ name, select, ...extra })

const CASES: Case[] = [
  {
    name: 'point click, replace, shift-toggle, clear on empty, dblclick',
    spec: base({ params: [sel('pick', 'point')], mark: 'point', encoding: { ...xy, color: colorBy('pick') } }),
    steps: [
      { t: 'clickMark', i: 0 }, { t: 'clickMark', i: 3 }, { t: 'clickMark', i: 1, shift: true }, { t: 'clickMark', i: 3, shift: true },
      { t: 'click', x: 0.55, y: 0.95 }, { t: 'clickMark', i: 2 }, { t: 'dblclick', x: 0.5, y: 0.5 },
    ],
    moves: [0, 1, 2, 3, 4, 5, 6],
  },
  {
    name: 'point toggle: false',
    spec: base({ params: [sel('pick', { type: 'point', toggle: false })], mark: 'point', encoding: { ...xy, color: colorBy('pick') } }),
    steps: [{ t: 'clickMark', i: 0 }, { t: 'clickMark', i: 1, shift: true }],
    moves: [0, 1],
  },
  {
    name: 'point fields on a bar chart',
    spec: base({ params: [sel('pick', { type: 'point', fields: ['c'] })], mark: 'bar', encoding: { x: { field: 'c', type: 'nominal' }, y: { field: 'b', type: 'quantitative', aggregate: 'sum' }, fill: { condition: { param: 'pick', value: 'steelblue' }, value: 'lightgray' } } }),
    steps: [{ t: 'clickMark', i: 0 }, { t: 'clickMark', i: 2, shift: true }, { t: 'clickMark', i: 2, shift: true }],
    moves: [0, 1, 2],
  },
  {
    name: 'point on pointerover with clear on pointerout',
    spec: base({ params: [sel('pick', { type: 'point', on: 'pointerover', clear: 'pointerout' })], mark: 'point', encoding: { ...xy, color: colorBy('pick') } }),
    steps: [{ t: 'moveMark', i: 1 }, { t: 'move', x: 0.5, y: 1.4 }, { t: 'moveMark', i: 4 }, { t: 'move', x: -0.3, y: 0.5 }],
    moves: [0, 1, 2, 3],
  },
  {
    name: 'point nearest',
    spec: base({ params: [sel('pick', { type: 'point', on: 'pointerover', nearest: true })], mark: 'point', encoding: { ...xy, color: colorBy('pick') } }),
    steps: [{ t: 'move', x: 0.1, y: 0.8 }, { t: 'move', x: 0.9, y: 0.1 }, { t: 'move', x: 0.5, y: 0.5 }],
    moves: [0, 1, 2],
  },
  {
    name: 'point initial value, then toggled off',
    spec: base({ params: [sel('pick', { type: 'point', fields: ['c'] }, { value: [{ c: 'x' }, { c: 'z' }] })], mark: 'circle', encoding: { ...xy, color: colorBy('pick') } }),
    steps: [{ t: 'clickMark', i: 0, shift: true }, { t: 'clickMark', i: 1, shift: true }],
    moves: [0, 1],
  },
  {
    name: 'legend binding: click, shift-click, click again',
    spec: base({ params: [sel('pick', { type: 'point', fields: ['c'] }, { bind: 'legend' })], mark: 'point', encoding: { ...xy, color: { field: 'c', type: 'nominal' }, opacity: { condition: { param: 'pick', value: 1 }, value: 0.2 } } }),
    steps: [{ t: 'clickLegend', part: 'symbols', i: 0 }, { t: 'clickLegend', part: 'labels', i: 2, shift: true }, { t: 'clickLegend', part: 'symbols', i: 2, shift: true }, { t: 'dblclickLegend', part: 'entries', i: 1 }],
    moves: [0, 1, 2],
  },
  {
    name: 'input binding: select',
    spec: base({ params: [sel('pick', { type: 'point', fields: ['c'] }, { bind: { input: 'select', options: ['x', 'y', 'z'] } })], mark: 'point', encoding: { ...xy, color: colorBy('pick') } }),
    steps: [{ t: 'input', i: 0, value: 'y' }, { t: 'input', i: 0, value: 'z' }],
    moves: [0, 1],
  },
  {
    name: 'input binding: radio',
    spec: base({ params: [sel('pick', { type: 'point', fields: ['c'] }, { bind: { input: 'radio', options: ['x', 'y', 'z'] } })], mark: 'point', encoding: { ...xy, color: colorBy('pick') } }),
    steps: [{ t: 'input', i: 1, value: true }, { t: 'input', i: 2, value: true }],
    moves: [0, 1],
  },
  {
    name: 'input binding: range',
    spec: base({ params: [sel('pick', { type: 'point', fields: ['a'] }, { bind: { input: 'range', min: 1, max: 6, step: 1 } })], mark: 'point', encoding: { ...xy, color: colorBy('pick') } }),
    steps: [{ t: 'input', i: 0, value: '3' }, { t: 'input', i: 0, value: '5' }],
    moves: [0, 1],
  },
  {
    name: 'input binding: checkbox',
    spec: base({ params: [sel('pick', { type: 'point', fields: ['a'] }, { bind: { input: 'checkbox' } })], mark: 'point', encoding: { ...xy, color: colorBy('pick') } }),
    steps: [{ t: 'input', i: 0, value: true }, { t: 'input', i: 0, value: false }],
    moves: [0, 1],
  },
  {
    name: 'interval brush, move it, resize it with the wheel, clear',
    spec: base({ params: [sel('brush', 'interval')], mark: 'point', encoding: { ...xy, color: colorBy('brush') } }),
    steps: [
      { t: 'drag', x0: 0.2, y0: 0.7, x1: 0.6, y1: 0.2 }, { t: 'drag', x0: 0.4, y0: 0.45, x1: 0.55, y1: 0.55 },
      { t: 'wheel', x: 0.5, y: 0.5, dy: 120 }, { t: 'drag', x0: 0.8, y0: 0.9, x1: 0.1, y1: 0.1 }, { t: 'dblclick', x: 0.5, y: 0.95 },
    ],
    moves: [0, 1, 2, 3, 4],
  },
  {
    name: 'interval on x with initial value',
    spec: base({ params: [sel('brush', { type: 'interval', encodings: ['x'] }, { value: { x: [2, 4] } })], mark: 'point', encoding: { ...xy, color: colorBy('brush') } }),
    steps: [{ t: 'drag', x0: 0.1, y0: 0.5, x1: 0.9, y1: 0.5 }, { t: 'dblclick', x: 0.5, y: 0.5 }],
    moves: [0, 1],
  },
  {
    name: 'interval translate with shift and zoom with shift-wheel (custom events)',
    spec: base({
      params: [sel('brush', { type: 'interval', encodings: ['x'], translate: '[pointerdown[event.shiftKey], window:pointerup] > window:pointermove!', zoom: 'wheel![event.shiftKey]' })],
      mark: 'point', encoding: { ...xy, color: colorBy('brush') },
    }),
    steps: [{ t: 'drag', x0: 0.2, y0: 0.5, x1: 0.5, y1: 0.5 }, { t: 'drag', x0: 0.35, y0: 0.5, x1: 0.6, y1: 0.5, shift: true }, { t: 'wheel', x: 0.45, y: 0.5, dy: -100, shift: true }],
    moves: [0, 1, 2],
  },
  {
    name: 'interval over a temporal axis',
    spec: base({ params: [sel('brush', { type: 'interval', encodings: ['x'] })], mark: 'point', encoding: { x: { field: 'd', type: 'temporal' }, y: { field: 'b', type: 'quantitative' }, color: colorBy('brush') } }),
    steps: [{ t: 'drag', x0: 0.1, y0: 0.5, x1: 0.7, y1: 0.5 }, { t: 'drag', x0: 0.3, y0: 0.5, x1: 0.4, y1: 0.5 }],
    moves: [0, 1],
  },
  {
    name: 'interval over an ordinal axis',
    spec: base({ params: [sel('brush', { type: 'interval', encodings: ['x'] })], mark: 'bar', encoding: { x: { field: 'c', type: 'nominal' }, y: { field: 'b', type: 'quantitative', aggregate: 'sum' }, color: { condition: { param: 'brush', value: 'steelblue' }, value: 'lightgray' } } }),
    steps: [{ t: 'drag', x0: 0.05, y0: 0.5, x1: 0.5, y1: 0.5 }],
    moves: [0],
  },
  {
    name: 'bind scales: drag pans, wheel zooms, dblclick resets',
    spec: base({ params: [sel('grid', 'interval', { bind: 'scales' })], autosize: 'none', padding: { left: 45, right: 15, top: 10, bottom: 35 }, mark: 'point', encoding: xy }),
    steps: [{ t: 'drag', x0: 0.5, y0: 0.5, x1: 0.3, y1: 0.6 }, { t: 'wheel', x: 0.5, y: 0.5, dy: -120 }, { t: 'wheel', x: 0.2, y: 0.8, dy: 200 }, { t: 'dblclick', x: 0.5, y: 0.5 }],
    moves: [0, 1, 2, 3],
    retainedTickOrder: true,
  },
  {
    name: 'bind scales on log and pow scales',
    spec: base({ params: [sel('grid', 'interval', { bind: 'scales' })], autosize: 'none', padding: { left: 45, right: 15, top: 10, bottom: 35 }, mark: 'point', encoding: { x: { field: 'a', type: 'quantitative', scale: { type: 'log' } }, y: { field: 'b', type: 'quantitative', scale: { type: 'pow', exponent: 2 } } } }),
    steps: [{ t: 'drag', x0: 0.5, y0: 0.5, x1: 0.4, y1: 0.4 }, { t: 'wheel', x: 0.5, y: 0.5, dy: -150 }],
    moves: [0, 1],
    retainedTickOrder: true,
  },
  {
    name: 'layers: brush in one layer filters another',
    spec: base({
      layer: [
        { params: [sel('brush', { type: 'interval', encodings: ['x'] })], mark: 'point', encoding: { ...xy, color: { condition: { param: 'brush', value: 'firebrick' }, value: 'lightgray' } } },
        { transform: [{ filter: { param: 'brush' } }], mark: 'line', encoding: { ...xy, color: { value: 'firebrick' } } },
      ],
    }),
    steps: [{ t: 'drag', x0: 0.2, y0: 0.5, x1: 0.7, y1: 0.5 }, { t: 'drag', x0: 0.3, y0: 0.5, x1: 0.5, y1: 0.5 }, { t: 'dblclick', x: 0.5, y: 0.5 }],
    moves: [0, 1, 2],
  },
  {
    name: 'layers: nearest hover with a rule and a lookup',
    spec: base({
      layer: [
        { params: [sel('hover', { type: 'point', on: 'pointerover', nearest: true, fields: ['a'], clear: 'pointerout' })], mark: 'point', encoding: { ...xy, opacity: { value: 0 } } },
        { mark: 'line', encoding: { ...xy, color: { field: 'c', type: 'nominal' } } },
        { mark: 'rule', encoding: { x: { field: 'a', type: 'quantitative' }, opacity: { condition: { param: 'hover', empty: false, value: 0.6 }, value: 0 } } },
      ],
    }),
    steps: [{ t: 'move', x: 0.2, y: 0.4 }, { t: 'move', x: 0.8, y: 0.4 }, { t: 'move', x: 1.5, y: 0.4 }],
    moves: [0, 1, 2],
  },
  {
    name: 'a variable param with an input and an expression',
    spec: base({ params: [{ name: 'cut', value: 3, bind: { input: 'range', min: 1, max: 6, step: 1 } }, { name: 'twice', expr: 'cut * 2' }], mark: 'point', encoding: { ...xy, color: { condition: { test: 'datum.a > twice / 2', value: 'firebrick' }, value: 'steelblue' } } }),
    steps: [{ t: 'input', i: 0, value: '5' }, { t: 'input', i: 0, value: '2' }],
    moves: [0, 1],
  },
]

const cases = CASES.filter((c) => !FILTER || c.name.includes(FILTER))

// ---- page bundle ------------------------------------------------------------------

const entrySrc = `
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import '@aster/core/transforms' // (a nearest selection's voronoi cells)
import * as vega from 'vega'
import * as vl from 'vega-lite'
import { Chart } from ${JSON.stringify(join(REACT_DIR, 'src/index.ts'))}
import { compile as asterVlCompile } from ${JSON.stringify(join(REACT_DIR, 'src/vl.ts'))}
window.__asterVl = asterVlCompile // (importing vl.ts registers the compiler; the reference keeps esbuild from dropping it)

const holder = document.createElement('div')
holder.id = 'c'
holder.style.cssText = 'position:absolute;left:20px;top:20px;width:520px'
document.body.appendChild(holder)
const binds = document.createElement('div')
binds.id = 'b'
binds.style.cssText = 'position:absolute;left:20px;top:420px'
document.body.appendChild(binds)
window.__errors = []

const norm = (v) => JSON.stringify(v, function (k, x) {
  if (typeof x === 'function') return undefined
  if (x instanceof Set) return { $set: [...x] }
  if (x instanceof Date) return { $date: x.getTime() }
  if (typeof x === 'number' && !Number.isFinite(x)) return 'NaN/Inf:' + String(x)
  if (x === undefined) return '__undefined__'
  if (x && typeof x === 'object' && !Array.isArray(x) && 'mark' in x && ('x' in x || 'datum' in x)) return '[item]'
  return x
})

let names = []
let stores = []
window.__mountVega = async (specVl) => {
  const vg = vl.compile(specVl).spec
  names = (vg.signals || []).map((s) => s.name)
  stores = (vg.data || []).map((d) => d.name).filter((n) => /_store$/.test(n))
  const view = new vega.View(vega.parse(vg), { renderer: 'svg', container: holder, bind: binds, hover: false, logger: { level() { return this }, error(...a) { window.__errors.push(a.map(String).join(' ')); return this }, warn() { return this }, info() { return this }, debug() { return this } } })
  await view.runAsync()
  window.__read = () => ({
    signals: Object.fromEntries(names.map((n) => [n, norm(view.signal(n))])),
    stores: Object.fromEntries(stores.map((n) => [n, norm(view.data(n))])),
  })
  window.__svg = () => view.toSVG()
  window.__settle = async () => { await view.runAsync() }
}

window.__mountAster = async (specVl) => {
  const vg = vl.compile(specVl).spec // names only; the chart compiles the Vega-Lite spec itself
  names = (vg.signals || []).map((s) => s.name)
  stores = (vg.data || []).map((d) => d.name).filter((n) => /_store$/.test(n))
  window.__ref = React.createRef()
  const root = createRoot(holder)
  flushSync(() => root.render(React.createElement(Chart, { ref: window.__ref, spec: specVl, width: specVl.width, height: specVl.height, onError: (e) => window.__errors.push('onError:' + String(e)), logger: { error: (...a) => window.__errors.push(a.map(String).join(' ')), warn() {} } })))
  for (let i = 0; i < 200 && !(window.__ref.current && window.__ref.current.getScene()); i++) await new Promise((r) => setTimeout(r, 25))
  if (!window.__ref.current) throw new Error('chart did not mount: ' + JSON.stringify(window.__errors) + ' ref=' + String(window.__ref.current) + ' html=' + holder.innerHTML.slice(0, 300))
  window.__read = () => {
    const scene = window.__ref.current.getScene()
    const params = scene.signalParams
    return {
      signals: Object.fromEntries(names.map((n) => [n, norm(params[n])])),
      stores: Object.fromEntries(stores.map((n) => [n, norm(scene.runtime.data(n))])),
    }
  }
  // (data-datum is the stamp the event loop reads the datum from; vega has no such attribute)
  window.__svg = () => window.__ref.current.getSvg().replace(/ data-datum="[^"]*"/g, '')
  window.__settle = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
}
`

rmSync(OUT_DIR, { recursive: true, force: true })
mkdirSync(OUT_DIR, { recursive: true })
writeFileSync(join(OUT_DIR, 'page-entry.tsx'), entrySrc)
await build({
  entryPoints: [join(OUT_DIR, 'page-entry.tsx')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  jsx: 'automatic',
  outfile: join(OUT_DIR, 'page.js'),
  define: { 'process.env.NODE_ENV': '"production"' },
  nodePaths: [join(REACT_DIR, 'node_modules')],
  logLevel: 'silent',
  absWorkingDir: CONF_DIR,
})
writeFileSync(join(OUT_DIR, 'index.html'), '<!doctype html><html><body style="margin:0;width:900px;height:700px"><script src="./page.js"></script></body></html>')
void readFileSync
void readdirSync

// ---- driver -----------------------------------------------------------------------

const playwright = await import('playwright')
const browser = await playwright.chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] })

interface Snapshot { signals: Record<string, string>; stores: Record<string, string>; svg: string }

async function snapshot(page: Page): Promise<Snapshot> {
  const r = await page.evaluate(() => (window as unknown as { __read: () => { signals: Record<string, string>; stores: Record<string, string> } }).__read())
  const svg = await page.evaluate(() => Promise.resolve((window as unknown as { __svg: () => string | Promise<string> }).__svg()))
  return { ...r, svg }
}

interface Frame { x: number; y: number; w: number; h: number }
async function frameOf(page: Page): Promise<Frame> {
  // the plot frame: the first background path of the view
  const b = await page.evaluate(() => {
    const el = document.querySelector('#c svg path.background') as SVGGraphicsElement | null
    const r = (el ?? document.querySelector('#c svg')!).getBoundingClientRect()
    return { x: r.left, y: r.top, w: r.width, h: r.height }
  })
  return b
}

async function runStep(page: Page, s: Step): Promise<void> {
  const f = await frameOf(page)
  if (process.env.SEL_DEBUG) console.log('frame', JSON.stringify(f))
  const at = (x: number, y: number): [number, number] => [f.x + x * f.w, f.y + y * f.h]
  const shift = async (on: boolean | undefined, fn: () => Promise<void>): Promise<void> => {
    if (on) await page.keyboard.down('Shift')
    try { await fn() } finally { if (on) await page.keyboard.up('Shift') }
  }
  const markBox = async (i: number): Promise<[number, number]> => {
    const b = await page.evaluate((idx) => {
      const el = document.querySelectorAll('#c svg .mark-symbol.marks path, #c svg .mark-rect.marks path, #c svg .mark-symbol.layer_0_marks path')[idx] as SVGGraphicsElement
      const r = el.getBoundingClientRect()
      return [r.left + r.width / 2, r.top + r.height / 2] as [number, number]
    }, i)
    return b
  }
  const legendBox = async (part: string, i: number): Promise<[number, number]> => page.evaluate(([p, idx]) => {
    const els = document.querySelectorAll(`#c svg .${(document.querySelector(`#c svg [class*="_legend_${p}"]`) as Element).getAttribute('class')!.split(' ').find((c) => c.endsWith('_legend_' + p))} ${p === 'entries' ? 'path.background' : p === 'symbols' ? 'path' : 'text'}`)
    const r = (els[idx as number] as Element).getBoundingClientRect()
    return [r.left + r.width / 2, r.top + r.height / 2] as [number, number]
  }, [part, i] as const)
  switch (s.t) {
    case 'move': await page.mouse.move(...at(s.x, s.y), { steps: 3 }); break
    case 'moveMark': {
      const [x, y] = await markBox(s.i)
      if (process.env.SEL_DEBUG) await page.evaluate(() => { const svg = document.querySelector('#c svg')!; (window as never as { __ov: string[] }).__ov = []; svg.addEventListener('pointerover', (e) => (window as never as { __ov: string[] }).__ov.push((e.target as Element).tagName + '.' + (e.target as Element).getAttribute('class'))) })
      await page.mouse.move(x, y, { steps: 3 })
      if (process.env.SEL_DEBUG) console.log('pointerover', await page.evaluate(() => (window as never as { __ov: string[] }).__ov))
      break
    }
    case 'down': await page.mouse.down(); break
    case 'up': await page.mouse.up(); break
    case 'click': await shift(s.shift, async () => { await page.mouse.move(...at(s.x, s.y)); if (process.env.SEL_DEBUG) await page.evaluate(() => { const svg = document.querySelector('#c svg')!; (window as never as { __cl: string[] }).__cl = []; for (const t of ['click', 'pointerdown', 'pointerup']) svg.addEventListener(t, (e) => (window as never as { __cl: string[] }).__cl.push(t + ':' + (e.target as Element).tagName + ':' + (e as MouseEvent).shiftKey)) })
      if (process.env.SEL_DEBUG) console.log('click at', at(s.x, s.y), await page.evaluate(([x, y]) => { const e = document.elementFromPoint(x!, y!); return e ? e.tagName + '.' + (e.getAttribute('class') ?? '') + ' inSvg=' + (e.closest('svg') != null) : 'none' }, at(s.x, s.y))); await page.mouse.click(...at(s.x, s.y)); if (process.env.SEL_DEBUG) console.log('events', await page.evaluate(() => (window as never as { __cl: string[] }).__cl)) }); break
    case 'dblclick': await page.mouse.move(...at(s.x, s.y)); await page.mouse.dblclick(...at(s.x, s.y)); break
    case 'drag':
      await shift(s.shift, async () => {
        const dbg = async (tag: string): Promise<void> => {
          if (!process.env.SEL_TRACE) return
          const r = await snapshot(page)
          console.log('  trace', tag, r.signals.grid_translate_anchor, r.signals.grid_translate_delta, r.signals.unit)
        }
        await page.mouse.move(...at(s.x0, s.y0))
        await page.mouse.down()
        await dbg('down')
        for (let k = 1; k <= 8; k++) {
          await page.mouse.move(...at(s.x0 + ((s.x1 - s.x0) * k) / 8, s.y0 + ((s.y1 - s.y0) * k) / 8))
          await dbg('move' + k)
        }
        await page.mouse.up()
      })
      break
    case 'wheel': await shift(s.shift, async () => { await page.mouse.move(...at(s.x, s.y)); await page.mouse.wheel(0, s.dy) }); break
    case 'clickMark': await shift(s.shift, async () => { const [x, y] = await markBox(s.i); await page.mouse.move(x, y); await page.mouse.click(x, y) }); break
    case 'clickLegend': await shift(s.shift, async () => { const [x, y] = await legendBox(s.part, s.i); await page.mouse.move(x, y); await page.mouse.click(x, y) }); break
    case 'dblclickLegend': { const [x, y] = await legendBox(s.part, s.i); await page.mouse.move(x, y); await page.mouse.dblclick(x, y); break }
    case 'input': {
      const control = page.locator('#b input, #b select, #c [data-aster-binds] input, #c [data-aster-binds] select').nth(s.i)
      const type = await control.evaluate((el) => (el as HTMLInputElement).type)
      if (type === 'checkbox' || type === 'radio') await control.setChecked(Boolean(s.value))
      else if (type === 'range') await control.evaluate((el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, String(v)); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })) }, s.value)
      else await control.selectOption(String(s.value))
      break
    }
    case 'key': await page.keyboard.press(s.key); break
  }
}

async function drive(engine: 'vega' | 'aster', c: Case): Promise<{ snaps: Snapshot[]; errors: string[] } | { error: string }> {
  const context = await browser.newContext({ viewport: { width: 900, height: 700 }, deviceScaleFactor: 1 })
  const page = await context.newPage()
  const pageErrors: string[] = []
  page.on('pageerror', (e) => pageErrors.push(e.message.slice(0, 300)))
  try {
    await page.goto(`file://${join(OUT_DIR, 'index.html')}`)
    await page.waitForFunction(() => '__mountVega' in window, null, { timeout: 30_000 })
    await page.evaluate(async ([which, spec]) => {
      const w = window as unknown as Record<string, (s: unknown) => Promise<void>>
      await (which === 'vega' ? w.__mountVega! : w.__mountAster!)(spec)
    }, [engine, c.spec] as const)
    if (process.env.SEL_DEBUG) console.log(engine, await page.evaluate(() => document.querySelector('#c svg path.background')!.outerHTML + (document.querySelector('#c svg .marks')?.outerHTML.slice(0, 600) ?? '')))
    const settle = (): Promise<unknown> => page.evaluate(() => (window as unknown as { __settle: () => Promise<unknown> }).__settle())
    await settle()
    const snaps: Snapshot[] = [await snapshot(page)]
    for (const s of c.steps) {
      await runStep(page, s)
      await settle()
      await settle()
      snaps.push(await snapshot(page))
    }
    if (pageErrors.length) return { error: `page errors: ${pageErrors.join(' | ')}` }
    const errors = await page.evaluate(() => (window as unknown as { __errors: string[] }).__errors)
    return { snaps, errors }
  } catch (e) {
    if (process.env.SEL_DEBUG) console.log((e as Error).stack, await page.evaluate(() => JSON.stringify((window as unknown as { __errors: string[] }).__errors) + document.body.innerHTML.slice(0, 600)))
    return { error: (e as Error).message.split('\n')[0]! + (pageErrors.length ? ` [page errors: ${pageErrors.join(' | ')}]` : '') }
  } finally {
    await context.close()
  }
}

let pass = 0
const failures: string[] = []
const t0 = Date.now()
for (const c of cases) {
  const [v, a] = [await drive('vega', c), await drive('aster', c)]
  const problems: string[] = []
  if ('error' in v) problems.push(`vega side failed: ${v.error}`)
  else if ('error' in a) problems.push(`aster side failed: ${a.error}`)
  else {
    if (a.errors.length) problems.push(`aster logged: ${a.errors[0]!.slice(0, 200)}`)
    if (v.errors.length) problems.push(`vega logged: ${v.errors[0]!.slice(0, 200)}`)
    if (process.env.SEL_DEBUG) for (let i = 0; i < v.snaps.length; i++) console.log(i, "V", v.snaps[i]!.signals.pick_c_legend, v.snaps[i]!.signals.pick_toggle, v.snaps[i]!.signals.pick_tuple, "| A", a.snaps[i]!.signals.pick_c_legend, a.snaps[i]!.signals.pick_toggle, a.snaps[i]!.signals.pick_tuple)
    for (let i = 0; i < v.snaps.length; i++) {
      const label = i === 0 ? 'initial' : `step ${i - 1} (${c.steps[i - 1]!.t})`
      const vs = v.snaps[i]!
      const as = a.snaps[i]!
      for (const n of Object.keys(vs.signals)) {
        if (vs.signals[n] !== as.signals[n]) problems.push(`${label}: signal ${n}: vega=${vs.signals[n]!.slice(0, 160)} aster=${as.signals[n]!.slice(0, 160)}`)
      }
      for (const n of Object.keys(vs.stores)) {
        if (vs.stores[n] !== as.stores[n]) problems.push(`${label}: store ${n}: vega=${vs.stores[n]!.slice(0, 200)} aster=${as.stores[n]!.slice(0, 200)}`)
      }
      if (process.env.SEL_DUMP && i === 0) { writeFileSync('/tmp/fix-20-vl-selections-scratch/sel-vega.svg', vs.svg); writeFileSync('/tmp/fix-20-vl-selections-scratch/sel-aster.svg', as.svg) }
      const diffs = diffCanonical(canonicalizeSvg(vs.svg), canonicalizeSvg(as.svg)).filter((d) => !(c.retainedTickOrder && String(d).startsWith('paint-order: same records, different order')))
      if (diffs.length) problems.push(`${label}: svg differs: ${String(diffs[0]).slice(0, 220)}`)
    }
    for (const i of c.moves) {
      const before = v.snaps[i]!
      const after = v.snaps[i + 1]!
      if (JSON.stringify(before.stores) === JSON.stringify(after.stores) && JSON.stringify(before.signals) === JSON.stringify(after.signals)) {
        problems.push(`VACUOUS: step ${i} (${c.steps[i]!.t}) changed neither a signal nor a store in vega`)
      }
    }
  }
  if (problems.length === 0) pass++
  else failures.push(`${c.name}:\n      ${problems.slice(0, Number(process.env.SEL_MAX ?? 6)).join('\n      ')}`)
}
await browser.close()
rmSync(OUT_DIR, { recursive: true, force: true })

console.log(`\n[browser-vl-selections] ${pass}/${cases.length} cases agree with real vega + vega-lite (${((Date.now() - t0) / 1000).toFixed(0)}s)`)
for (const f of failures) console.log(`  FAIL ${f}`)
if (MIN_CASES && cases.length < MIN_CASES) {
  console.log(`[browser-vl-selections] FLOOR: ${cases.length} cases < --min-cases ${MIN_CASES}`)
  process.exit(1)
}
if (cases.length === 0) {
  console.log('[browser-vl-selections] no cases ran')
  process.exit(1)
}
process.exit(failures.length ? 1 : 0)
