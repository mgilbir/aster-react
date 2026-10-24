/**
 * Real-browser signal-event parity gate (audit C20).
 *
 * The same specs are mounted twice in headless Chromium, each in its own page:
 * once in REAL vega (a `View` with the svg renderer) and once in @aster/core
 * (`renderSceneToDomElement` + `bindSceneSignals`). The same native input
 * (Playwright mouse / wheel / keyboard / touch events, real timing) is driven
 * through both, and the resulting signal values -- and whether an error was
 * logged -- must agree. A case that cannot differ (both sides unchanged) would
 * prove nothing, so every case also names the signals that MUST have moved on
 * the vega side (`expectMoved`): a vacuous case fails the run.
 *
 * Run: pnpm conformance:signals [--filter=substr] [--min-cases=N]
 */
import { writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const THIS_DIR = dirname(fileURLToPath(import.meta.url))
const CONF_DIR = dirname(THIS_DIR)
const OUT_DIR = join(CONF_DIR, '.tmp-browser-signals')
const argv = process.argv.slice(2)
const arg = (n: string, d: string): string => argv.find((a) => a.startsWith(`--${n}=`))?.split('=')[1] ?? d
const FILTER = arg('filter', '')
const MIN_CASES = Number(arg('min-cases', '0'))

// ---- cases ------------------------------------------------------------------------

/** Coordinates are relative to the svg's top-left corner. */
type Step =
  | { t: 'move'; x: number; y: number }
  | { t: 'down' | 'up' }
  | { t: 'click'; x: number; y: number }
  | { t: 'dblclick'; x: number; y: number }
  | { t: 'wheel'; x: number; y: number; dy: number; dx?: number }
  | { t: 'key'; key: string }
  | { t: 'keydown' | 'keyup'; key: string }
  | { t: 'tap'; x: number; y: number }
  | { t: 'wait'; ms: number }

interface Case {
  name: string
  spec: Record<string, unknown>
  steps: Step[]
  /** Signals that must differ from their initial value on the vega side. */
  expectMoved: string[]
  /** Signals that must still equal their initial value on the vega side (the event must NOT have fired them). */
  expectStill?: string[]
  /** Both engines must have logged at least one error. */
  expectError?: boolean
}

const DATA = [
  { k: 'a', x: 20, v: 1 },
  { k: 'b', x: 100, v: 2 },
  { k: 'c', x: 180, v: 3 },
]

/** Pointer positions (svg coordinates; the plot origin is the 10px padding). */
const P = {
  barA: [55, 150], barB: [135, 150], barC: [215, 150],
  dotA: [55, 60], dotB: [135, 60],
  labelA: [55, 40],
  empty: [95, 100],
  pad: [4, 4],
} as const

function chart(signals: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    $schema: 'https://vega.github.io/schema/vega/v6.json',
    width: 260, height: 190, padding: 10, autosize: 'none',
    data: [{ name: 't', values: DATA }],
    signals,
    marks: [
      { type: 'rect', name: 'bars', from: { data: 't' }, encode: { update: { x: { field: 'x' }, width: { value: 50 }, y: { value: 100 }, height: { value: 80 }, fill: { value: '#4c78a8' } } } },
      { type: 'symbol', name: 'dots', from: { data: 't' }, encode: { update: { x: { field: 'x', offset: 25 }, y: { value: 50 }, size: { value: 400 }, fill: { value: '#f58518' } } } },
      { type: 'text', name: 'labels', from: { data: 't' }, encode: { update: { x: { field: 'x', offset: 25 }, y: { value: 30 }, text: { field: 'k' }, align: { value: 'center' }, baseline: { value: 'middle' }, fontSize: { value: 11 } } } },
    ],
    ...extra,
  }
}

const sig = (name: string, on: unknown[], value: unknown = 0, extra: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ name, value, on, ...extra })

const moves = (...pts: ReadonlyArray<readonly [number, number]>): Step[] => pts.map(([x, y]) => ({ t: 'move' as const, x, y }))

const CASES: Case[] = [
  // --- selectors ---
  {
    name: 'plain-click-counts-only-clicks',
    spec: chart([sig('count', [{ events: 'click', update: 'count + 1' }]), sig('moves', [{ events: 'mousemove', update: 'moves + 1' }])]),
    steps: [...moves([60, 60], [70, 70], [80, 80]), { t: 'click', x: 100, y: 100 }],
    expectMoved: ['count', 'moves'],
  },
  {
    name: 'between-drag-only-while-pressed',
    spec: chart([sig('dragX', [{ events: '[mousedown, mouseup] > mousemove', update: 'x()' }], -1), sig('downs', [{ events: 'mousedown', update: 'downs + 1' }])]),
    steps: [...moves([30, 30], [40, 40]), { t: 'down' }, ...moves([60, 60], [90, 70]), { t: 'up' }, ...moves([150, 150], [160, 160])],
    expectMoved: ['dragX', 'downs'],
  },
  {
    name: 'between-never-pressed-stays-initial',
    spec: chart([sig('dragX', [{ events: '[mousedown, mouseup] > mousemove', update: 'x()' }], -1)]),
    steps: moves([30, 30], [40, 40], [90, 90]),
    expectMoved: [],
    expectStill: ['dragX'],
  },
  {
    name: 'between-object-form-window-end',
    spec: chart([
      sig('dragX', [{ events: { type: 'mousemove', between: [{ type: 'mousedown' }, { source: 'window', type: 'mouseup' }] }, update: 'x()' }], -1),
    ]),
    steps: [...moves([30, 30]), { t: 'down' }, ...moves([60, 60]), { t: 'up' }, ...moves([200, 120])],
    expectMoved: ['dragX'],
  },
  {
    name: 'between-selector-then-filter',
    spec: chart([sig('dragX', [{ events: '[mousedown, mouseup] > mousemove[event.shiftKey]', update: 'x()' }], -1)]),
    steps: [...moves([30, 30]), { t: 'down' }, ...moves([60, 60]), { t: 'keydown', key: 'Shift' }, ...moves([90, 70]), { t: 'keyup', key: 'Shift' }, { t: 'up' }],
    expectMoved: ['dragX'],
  },
  {
    name: 'filter-shift-click',
    spec: chart([sig('shift', [{ events: 'click', update: 'event.shiftKey' }], 'init'), sig('clicks', [{ events: 'click[event.shiftKey]', update: 'clicks + 1' }])]),
    steps: [{ t: 'click', x: 100, y: 100 }, { t: 'keydown', key: 'Shift' }, { t: 'click', x: 100, y: 100 }, { t: 'keyup', key: 'Shift' }],
    expectMoved: ['shift', 'clicks'],
  },
  {
    name: 'filter-multiple-brackets',
    spec: chart([sig('n', [{ events: 'click[event.shiftKey][event.altKey]', update: 'n + 1' }])]),
    steps: [{ t: 'click', x: 100, y: 100 }, { t: 'keydown', key: 'Shift' }, { t: 'click', x: 100, y: 100 }, { t: 'keydown', key: 'Alt' }, { t: 'click', x: 100, y: 100 }, { t: 'keyup', key: 'Alt' }, { t: 'keyup', key: 'Shift' }],
    expectMoved: ['n'],
  },
  {
    name: 'merge-comma-selector',
    spec: chart([sig('n', [{ events: 'mousedown, mouseup, dblclick', update: 'n + 1' }])]),
    steps: [{ t: 'down' }, { t: 'up' }, { t: 'dblclick', x: 120, y: 100 }],
    expectMoved: ['n'],
  },
  {
    name: 'markname-click-datum',
    spec: chart([sig('picked', [{ events: '@bars:click', update: 'datum.k' }], 'none'), sig('other', [{ events: '@dots:click', update: 'datum.k' }], 'none')]),
    steps: [{ t: 'click', x: P.barB[0], y: P.barB[1] }, { t: 'click', x: P.dotA[0], y: P.dotA[1] }],
    expectMoved: ['picked', 'other'],
  },
  {
    name: 'marktype-click-symbol-vs-rect',
    spec: chart([sig('sym', [{ events: 'symbol:click', update: 'datum.k' }], 'none'), sig('rect', [{ events: 'rect:click', update: 'datum.k' }], 'none')]),
    steps: [{ t: 'click', x: P.dotB[0], y: P.dotB[1] }, { t: 'click', x: P.barA[0], y: P.barA[1] }],
    expectMoved: ['sym', 'rect'],
  },
  {
    name: 'markname-unmatched-does-not-fire',
    spec: chart([sig('n', [{ events: '@dots:click', update: 'n + 1' }])]),
    steps: [{ t: 'click', x: P.barA[0], y: P.barA[1] }, { t: 'click', x: P.empty[0], y: P.empty[1] }],
    expectMoved: [],
    expectStill: ['n'],
  },
  {
    name: 'markname-mouseover-and-mouseout',
    spec: chart([sig('hover', [{ events: '@bars:mouseover', update: 'datum.k' }, { events: '@bars:mouseout', update: '"none"' }], 'none')]),
    steps: [...moves([5, 5], P.barA, P.empty, P.barC)],
    expectMoved: ['hover'],
  },
  {
    name: 'text-mark-click',
    spec: chart([sig('t', [{ events: 'text:click', update: 'datum.k' }], 'none')]),
    steps: [{ t: 'click', x: P.labelA[0], y: P.labelA[1] }],
    expectMoved: ['t'],
  },
  {
    name: 'item-and-group-functions',
    spec: chart([
      sig('role', [{ events: 'click', update: 'item() && item().mark ? item().mark.marktype + ":" + item().mark.name : "no-item"' }], 'init'),
    ]),
    steps: [{ t: 'click', x: P.barA[0], y: P.barA[1] }],
    expectMoved: ['role'],
  },
  {
    name: 'group-functions-root-frame',
    spec: chart([sig('g', [{ events: 'click', update: 'group() && group().mark ? group().mark.marktype + ":" + group().mark.role + ":" + group().mark.name : "none"' }], 'init'), sig('gxy', [{ events: 'click', update: '[x("root"), y(group())]' }], [0, 0])]),
    steps: [{ t: 'click', x: P.barA[0], y: P.barA[1] }],
    expectMoved: ['g', 'gxy'],
  },
  {
    name: 'item-over-empty-plot-area',
    spec: chart([sig('role', [{ events: 'click', update: 'event.item && event.item.mark ? event.item.mark.marktype + ":" + event.item.mark.role + ":" + event.item.mark.name : "no-item"' }], 'init')]),
    steps: [{ t: 'click', x: P.empty[0], y: P.empty[1] }],
    expectMoved: ['role'],
  },
  {
    name: 'item-over-padding',
    spec: chart([sig('role', [{ events: 'click', update: 'event.item && event.item.mark ? event.item.mark.marktype + ":" + event.item.mark.role + ":" + event.item.mark.name : "no-item"' }], 'init')]),
    steps: [{ t: 'click', x: P.pad[0], y: P.pad[1] }],
    expectMoved: ['role'],
  },
  {
    name: 'item-over-dot',
    spec: chart([sig('role', [{ events: 'mousemove', update: 'event.item && event.item.mark ? event.item.mark.marktype + ":" + event.item.mark.name : "no-item"' }], 'init')]),
    steps: moves(P.dotA),
    expectMoved: ['role'],
  },
  {
    name: 'xy-functions-with-mark-origin',
    spec: chart([sig('pt', [{ events: 'click', update: '[x(), y()]' }], [0, 0]), sig('ptEvent', [{ events: 'click', update: '[event.clientX, event.clientY]' }], [0, 0])]),
    steps: [{ t: 'click', x: 77, y: 88 }],
    expectMoved: ['pt', 'ptEvent'],
  },
  // --- sources ---
  {
    name: 'window-source-keydown',
    spec: chart([sig('key', [{ events: 'window:keydown', update: 'event.key' }], 'none'), sig('code', [{ events: { source: 'window', type: 'keyup' }, update: 'event.code' }], 'none')]),
    steps: [{ t: 'key', key: 'q' }],
    expectMoved: ['key', 'code'],
  },
  {
    name: 'window-mouseup-ends-drag-outside-chart',
    spec: chart([sig('active', [{ events: 'mousedown', update: 'true' }, { events: 'window:mouseup', update: 'false' }], false)]),
    steps: [...moves([40, 40]), { t: 'down' }, ...moves([300, 260]), { t: 'up' }],
    expectMoved: [],
  },
  {
    name: 'view-source-explicit-and-css-selector',
    spec: chart([sig('v', [{ events: { source: 'view', type: 'click' }, update: 'v + 1' }]), sig('s', [{ events: { source: '#probe', type: 'click' }, update: 's + 1' }])]),
    steps: [{ t: 'click', x: 100, y: 100 }],
    expectMoved: ['v'],
    expectStill: ['s'],
  },
  {
    name: 'scope-source-in-root-scope',
    spec: chart([sig('n', [{ events: { source: 'scope', type: 'click' }, update: 'n + 1' }])]),
    steps: [{ t: 'click', x: P.barA[0], y: P.barA[1] }, { t: 'click', x: P.pad[0], y: P.pad[1] }],
    expectMoved: ['n'],
  },
  // --- wheel / keyboard / event properties ---
  {
    name: 'wheel-delta-zoom',
    spec: chart([sig('zoom', [{ events: 'wheel!', force: true, update: 'pow(1.001, event.deltaY * pow(16, event.deltaMode))' }], 1)]),
    steps: [{ t: 'wheel', x: 120, y: 100, dy: 120 }, { t: 'wheel', x: 120, y: 100, dy: -40 }],
    expectMoved: ['zoom'],
  },
  {
    name: 'wheel-modifier-and-deltaX',
    spec: chart([sig('w', [{ events: 'wheel', update: '[event.deltaX, event.deltaY, event.shiftKey]' }], [0, 0, false])]),
    steps: [{ t: 'keydown', key: 'Shift' }, { t: 'wheel', x: 120, y: 100, dy: 30, dx: 10 }, { t: 'keyup', key: 'Shift' }],
    expectMoved: ['w'],
  },
  {
    name: 'consume-stops-propagation-to-window',
    spec: chart([
      sig('consumed', [{ events: 'mousedown!', update: 'consumed + 1' }]),
      sig('leaked', [{ events: 'window:mousedown', update: 'leaked + 1' }]),
    ]),
    steps: [...moves([60, 60]), { t: 'down' }, { t: 'up' }],
    expectMoved: ['consumed'],
    expectStill: ['leaked'],
  },
  {
    name: 'no-consume-propagates-to-window',
    spec: chart([
      sig('seen', [{ events: 'mousedown', update: 'seen + 1' }]),
      sig('leaked', [{ events: 'window:mousedown', update: 'leaked + 1' }]),
    ]),
    steps: [...moves([60, 60]), { t: 'down' }, { t: 'up' }],
    expectMoved: ['seen', 'leaked'],
  },
  // --- timing ---
  {
    name: 'throttle-passes-first-then-waits',
    spec: chart([sig('n', [{ events: 'mousemove{200}', update: 'n + 1' }])]),
    steps: [...moves([30, 30], [40, 40], [50, 50]), { t: 'wait', ms: 260 }, ...moves([60, 60], [70, 70])],
    expectMoved: ['n'],
  },
  {
    name: 'debounce-fires-once-with-last',
    spec: chart([sig('last', [{ events: 'mousemove{0,150}', update: 'x()' }], -1), sig('n', [{ events: 'mousemove{0,150}', update: 'n + 1' }])]),
    steps: [...moves([30, 30], [40, 40], [90, 50]), { t: 'wait', ms: 400 }],
    expectMoved: ['last', 'n'],
  },
  // --- handler semantics ---
  {
    name: 'only-matching-handlers-update-derived-not-rerun',
    spec: chart([
      sig('count', [{ events: 'click', update: 'count + 1' }]),
      sig('tick', [{ events: 'mousemove', update: 'tick + 1' }]),
      { name: 'doubled', update: 'count * 2' },
      { name: 'ticks3', update: 'tick * 3' },
    ]),
    steps: [...moves([30, 30], [40, 40], [50, 50]), { t: 'click', x: 100, y: 100 }],
    expectMoved: ['count', 'tick', 'doubled', 'ticks3'],
  },
  {
    name: 'handler-is-not-rerun-by-unrelated-event',
    spec: chart([sig('count', [{ events: 'click', update: 'count + 1' }]), sig('moved', [{ events: 'mousemove', update: 'count' }], -1)]),
    steps: [{ t: 'click', x: 100, y: 100 }, ...moves([30, 30]), { t: 'click', x: 100, y: 100 }, ...moves([40, 40])],
    expectMoved: ['count', 'moved'],
  },
  {
    name: 'update-forms-expr-value-signal',
    spec: chart([
      sig('a', [{ events: 'click', update: { expr: 'a + 2' } }]),
      sig('b', [{ events: 'click', update: { value: 'set' } }], 'init'),
      sig('c', [{ events: 'click', update: { signal: 'a' } }], -1),
    ]),
    steps: [{ t: 'click', x: 100, y: 100 }],
    expectMoved: ['a', 'b', 'c'],
  },
  {
    name: 'signal-event-source',
    spec: chart([
      sig('count', [{ events: 'click', update: 'count + 1' }]),
      sig('mirror', [{ events: { signal: 'count' }, update: 'count * 10' }], -1),
    ]),
    steps: [{ t: 'click', x: 100, y: 100 }, { t: 'click', x: 100, y: 100 }],
    expectMoved: ['count', 'mirror'],
  },
  {
    name: 'merged-streams-array-form',
    spec: chart([sig('n', [{ events: [{ type: 'click' }, { type: 'dblclick' }, { source: 'window', type: 'keydown' }], update: 'n + 1' }])]),
    steps: [{ t: 'click', x: 100, y: 100 }, { t: 'key', key: 'x' }],
    expectMoved: ['n'],
  },
  {
    name: 'marktype-object-form-with-filter',
    spec: chart([sig('n', [{ events: { marktype: 'rect', type: 'click', filter: 'event.shiftKey' }, update: 'n + 1' }])]),
    steps: [{ t: 'click', x: P.barA[0], y: P.barA[1] }, { t: 'keydown', key: 'Shift' }, { t: 'click', x: P.barA[0], y: P.barA[1] }, { t: 'click', x: P.dotA[0], y: P.dotA[1] }, { t: 'keyup', key: 'Shift' }],
    expectMoved: ['n'],
  },
  {
    name: 'touch-tap',
    spec: chart([sig('tap', [{ events: 'touchstart', update: '[x(), y()]' }], [0, 0])]),
    steps: [{ t: 'tap', x: 90, y: 90 }],
    expectMoved: ['tap'],
  },
  // --- errors ---
  {
    name: 'update-error-logged-and-loop-continues',
    spec: chart([sig('bad', [{ events: 'click', update: 'datum.nope.x' }], 'init'), sig('good', [{ events: 'mousemove', update: 'good + 1' }])]),
    steps: [{ t: 'click', x: 100, y: 100 }, ...moves([30, 30]), { t: 'click', x: 100, y: 100 }],
    expectMoved: ['good'],
    expectStill: ['bad'],
    expectError: true,
  },
  {
    name: 'filter-error-logged',
    spec: chart([sig('n', [{ events: 'click[event.item.nope.x]', update: 'n + 1' }]), sig('m', [{ events: 'mousemove', update: 'm + 1' }])]),
    steps: [{ t: 'click', x: 100, y: 100 }, ...moves([30, 30])],
    expectMoved: ['m'],
    expectStill: ['n'],
    expectError: true,
  },
]

const cases = CASES.filter((c) => !FILTER || c.name.includes(FILTER))

// ---- page bundle ------------------------------------------------------------------

const entrySrc = `
import * as vega from 'vega'
import { compileChart, evaluateChart } from '@aster/core'
import { renderSceneToDomElement } from '@aster/core/dom'
import { buildHitIndex } from '@aster/core/hit'
import { bindSceneSignals } from '@aster/core/signals'

const logs = []
const logger = {
  _l: 2,
  level(l) { if (arguments.length) { this._l = l; return this } return this._l },
  error(...a) { logs.push('error:' + a.map(String).join(' ')); return this },
  warn(...a) { logs.push('warn:' + a.map(String).join(' ')); return this },
  info() { return this },
  debug() { return this },
}
window.__logs = logs

const holder = document.createElement('div')
holder.id = 'c'
holder.style.cssText = 'position:absolute;left:20px;top:20px'
document.body.appendChild(holder)
const probe = document.createElement('div')
probe.id = 'probe'
probe.style.cssText = 'position:absolute;left:600px;top:20px;width:30px;height:30px'
document.body.appendChild(probe)

let names = []
let read = () => ({})

window.__mountVega = async (spec) => {
  const view = new vega.View(vega.parse(spec), { renderer: 'svg', container: holder, logger, hover: false })
  await view.runAsync()
  names = (spec.signals || []).map((s) => s.name)
  read = () => Object.fromEntries(names.map((n) => [n, view.signal(n)]))
  window.__settle = () => view.runAsync()
}

window.__mountAster = async (spec) => {
  const scene = evaluateChart(compileChart(spec))
  const svg = renderSceneToDomElement(scene)
  holder.appendChild(svg)
  const store = {}
  const hit = buildHitIndex(scene)
  bindSceneSignals(svg, scene, store, { logger }, { pick: (x, y) => hit.query(x, y) })
  names = (spec.signals || []).map((s) => s.name)
  read = () => Object.fromEntries(names.map((n) => [n, Object.hasOwn(store, n) ? store[n] : scene.signalParams[n]]))
  window.__settle = async () => {}
}

window.__read = () => {
  const norm = (v) => JSON.stringify(v, (k, x) => (typeof x === 'number' && !Number.isFinite(x) ? 'NaN/Inf:' + String(x) : x === undefined ? '__undefined__' : x))
  return { signals: Object.fromEntries(Object.entries(read()).map(([k, v]) => [k, norm(v)])), errors: logs.filter((l) => l.startsWith('error:')) }
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
  absWorkingDir: CONF_DIR,
})
writeFileSync(join(OUT_DIR, 'index.html'), '<!doctype html><html><body style="margin:0;width:900px;height:600px"><script src="./page.js"></script></body></html>')

// ---- driver -----------------------------------------------------------------------

const playwright = await import('playwright')
const browser = await playwright.chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] })

interface Observed { signals: Record<string, string>; errors: string[] }

async function drive(engine: 'vega' | 'aster', c: Case): Promise<{ initial: Observed; final: Observed } | { error: string }> {
  const context = await browser.newContext({ viewport: { width: 900, height: 600 }, deviceScaleFactor: 1, hasTouch: true })
  const page = await context.newPage()
  const pageErrors: string[] = []
  page.on('pageerror', (e) => pageErrors.push(e.message.slice(0, 200)))
  try {
    await page.goto(`file://${join(OUT_DIR, 'index.html')}`)
    await page.waitForFunction(() => '__mountVega' in window, null, { timeout: 30_000 })
    await page.evaluate(async ([which, spec]) => {
      const w = window as unknown as Record<string, (s: unknown) => Promise<void>>
      await (which === 'vega' ? w.__mountVega! : w.__mountAster!)(spec)
    }, [engine, c.spec] as const)
    const read = (): Promise<Observed> => page.evaluate(() => (window as unknown as { __read: () => Observed }).__read())
    const settle = (): Promise<unknown> => page.evaluate(() => (window as unknown as { __settle: () => Promise<unknown> }).__settle())
    const initial = await read()
    const O = 20 // the holder's page offset
    for (const s of c.steps) {
      switch (s.t) {
        case 'move': await page.mouse.move(O + s.x, O + s.y); break
        case 'down': await page.mouse.down(); break
        case 'up': await page.mouse.up(); break
        case 'click': await page.mouse.move(O + s.x, O + s.y); await page.mouse.click(O + s.x, O + s.y); break
        case 'dblclick': await page.mouse.move(O + s.x, O + s.y); await page.mouse.dblclick(O + s.x, O + s.y); break
        case 'wheel': await page.mouse.move(O + s.x, O + s.y); await page.mouse.wheel(s.dx ?? 0, s.dy); break
        case 'key': await page.keyboard.press(s.key); break
        case 'keydown': await page.keyboard.down(s.key); break
        case 'keyup': await page.keyboard.up(s.key); break
        case 'tap': await page.touchscreen.tap(O + s.x, O + s.y); break
        case 'wait': await page.waitForTimeout(s.ms); break
      }
      await settle()
    }
    await settle()
    const final = await read()
    if (pageErrors.length) return { error: `page errors: ${pageErrors.join(' | ')}` }
    return { initial, final }
  } catch (e) {
    return { error: (e as Error).message.split('\n')[0]! }
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
    for (const name of Object.keys(v.final.signals)) {
      if (v.final.signals[name] !== a.final.signals[name]) problems.push(`signal ${name}: vega=${v.final.signals[name]} aster=${a.final.signals[name]}`)
    }
    for (const name of c.expectMoved) {
      if (v.final.signals[name] === v.initial.signals[name]) problems.push(`VACUOUS: vega did not move ${name} (${v.final.signals[name]})`)
    }
    for (const name of c.expectStill ?? []) {
      if (v.final.signals[name] !== v.initial.signals[name]) problems.push(`vega moved ${name} but the case says it must stay`)
    }
    if ((c.expectError ?? false) && !(v.final.errors.length > 0 && a.final.errors.length > 0)) {
      problems.push(`expected an error log on both sides: vega=${v.final.errors.length} aster=${a.final.errors.length}`)
    }
    if (!(c.expectError ?? false) && (v.final.errors.length > 0 || a.final.errors.length > 0)) {
      problems.push(`unexpected error log: vega=${JSON.stringify(v.final.errors)} aster=${JSON.stringify(a.final.errors)}`)
    }
  }
  if (problems.length === 0) pass++
  else failures.push(`${c.name}: ${problems.join('; ')}`)
}
await browser.close()
rmSync(OUT_DIR, { recursive: true, force: true })

console.log(`\n[browser-signals] ${pass}/${cases.length} cases agree with real vega (${((Date.now() - t0) / 1000).toFixed(0)}s)`)
for (const f of failures) console.log(`  FAIL ${f}`)
if (MIN_CASES && cases.length < MIN_CASES) {
  console.log(`[browser-signals] FLOOR: ${cases.length} cases < --min-cases ${MIN_CASES}`)
  process.exit(1)
}
if (cases.length === 0) {
  console.log('[browser-signals] no cases ran')
  process.exit(1)
}
process.exit(failures.length ? 1 : 0)
