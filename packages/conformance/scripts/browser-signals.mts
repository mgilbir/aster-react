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
 * Animations (Vega-Lite 6 `time` channel, a `timer` event stream and a selection store `modify` writes) run the
 * same way but on a CONTROLLED CLOCK: Playwright's fake clock (Date, performance, timeouts, intervals and animation
 * frames) is installed in both pages, paused at the same instant, and stepped by the same amounts; after each step the
 * rendered frame (canonicalised SVG) and the animation's signals must agree with real vega. Because both pages run the
 * same virtual time, a tick that lands a frame early or late on one side shows up as a different `anim_clock` and
 * a different frame; a case whose vega frames never change would prove nothing, so it fails as vacuous.
 *
 * Run: pnpm conformance:signals [--filter=substr] [--min-cases=N]
 */
import { writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { compile as compileVL } from '../../vl/src/index.ts'
import { canonicalizeSvg, diffCanonical } from '../src/normalize.ts'

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
  /** The scoped signals (group items' own, in document order) must differ from their initial values on the vega side. */
  expectScopedMoved?: boolean
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


/**
 * A view of two group marks side by side (each its own scope, declaring `signals`) over the same data: `left` spans view x
 * 10..130, `right` 150..270. `top` are the view's own signals.
 */
function groups(signals: unknown[], top: unknown[] = [], extra: Record<string, unknown> = {}, inner: Record<string, unknown>[] = []): Record<string, unknown> {
  const group = (name: string, x: number): Record<string, unknown> => ({
    type: 'group', name, signals,
    encode: { update: { x: { value: x }, y: { value: 0 }, width: { value: 120 }, height: { value: 180 }, fill: { value: '#eef' } } },
    marks: [
      { type: 'rect', name: 'cellbars', from: { data: 't' }, encode: { update: { x: { field: 'x', mult: 0.5 }, width: { value: 20 }, y: { value: 100 }, height: { value: 60 }, fill: { value: '#4c78a8' } } } },
      ...inner,
    ],
  })
  return {
    $schema: 'https://vega.github.io/schema/vega/v6.json',
    width: 260, height: 190, padding: 10, autosize: 'none',
    data: [{ name: 't', values: DATA }],
    signals: top,
    marks: [group('left', 0), group('right', 140)],
    ...extra,
  }
}
/** Pointer positions for `groups()` (svg coordinates): inside each group's empty area, on a bar, and outside both. */
const G = { left: [40, 40], right: [190, 40], leftBar: [20, 120], rightBar: [170, 120], gap: [135, 40], below: [40, 188] } as const

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

  // --- group scopes (a group mark's own signals: one copy per group item) ---
  {
    name: 'group-scope-click-counts-per-scope',
    spec: groups([sig('n', [{ events: 'click', update: 'n + 1' }]), sig('last', [{ events: 'mousemove', update: '[x(), y()]' }], [0, 0])]),
    steps: [{ t: 'click', x: G.left[0], y: G.left[1] }, { t: 'click', x: G.right[0], y: G.right[1] }, { t: 'click', x: G.right[0], y: G.right[1] }, ...moves([60, 70])],
    expectMoved: [],
    expectScopedMoved: true,
  },
  {
    name: 'group-scope-click-outside-every-group-fires-nothing',
    spec: groups([sig('n', [{ events: 'click', update: 'n + 1' }])]),
    steps: [{ t: 'click', x: G.gap[0], y: G.gap[1] }, { t: 'click', x: G.below[0], y: G.below[1] }],
    expectMoved: [],
  },
  {
    name: 'group-scope-explicit-view-source-fires-in-every-scope',
    spec: groups([sig('n', [{ events: { source: 'view', type: 'click' }, update: 'n + 1' }])]),
    steps: [{ t: 'click', x: G.gap[0], y: G.gap[1] }],
    expectMoved: [],
    expectScopedMoved: true,
  },
  {
    name: 'group-scope-markname-in-scope',
    spec: groups([sig('hit', [{ events: '@cellbars:click', update: 'datum.k' }], 'none')]),
    steps: [{ t: 'click', x: G.rightBar[0], y: G.rightBar[1] }],
    expectMoved: [],
    expectScopedMoved: true,
  },
  {
    name: 'group-scope-push-outer-writes-the-view-signal',
    spec: groups([{ name: 'total', push: 'outer', on: [{ events: 'click', update: 'total + 1' }] }], [{ name: 'total', value: 0 }]),
    steps: [{ t: 'click', x: G.left[0], y: G.left[1] }, { t: 'click', x: G.right[0], y: G.right[1] }, { t: 'click', x: G.right[0], y: G.right[1] }],
    expectMoved: ['total'],
  },
  {
    name: 'group-scope-shadows-the-view-signal',
    spec: groups([sig('n', [{ events: 'click', update: 'n + 10' }])], [sig('n', [{ events: { source: 'view', type: 'dblclick' }, update: 'n + 1' }])]),
    steps: [{ t: 'click', x: G.left[0], y: G.left[1] }, { t: 'dblclick', x: G.gap[0], y: G.gap[1] }],
    expectMoved: ['n'],
    expectScopedMoved: true,
  },
  {
    name: 'group-scope-reads-the-view-signal',
    spec: groups([sig('seen', [{ events: 'click', update: 'base * 2' }], 0)], [sig('base', [{ events: { source: 'view', type: 'dblclick' }, update: 'x()' }], 1)]),
    steps: [{ t: 'dblclick', x: G.gap[0], y: G.gap[1] }, { t: 'click', x: G.right[0], y: G.right[1] }],
    expectMoved: ['base'],
    expectScopedMoved: true,
  },
  {
    name: 'group-scope-derived-and-signal-source',
    spec: groups([
      sig('n', [{ events: 'click', update: 'n + 1' }]),
      { name: 'twice', update: 'n * 2' },
      sig('echo', [{ events: { signal: 'n' }, update: 'n + 100' }], -1),
    ]),
    steps: [{ t: 'click', x: G.left[0], y: G.left[1] }, { t: 'click', x: G.left[0], y: G.left[1] }, { t: 'click', x: G.right[0], y: G.right[1] }],
    expectMoved: [],
    expectScopedMoved: true,
  },
  {
    name: 'group-scope-between-drag-and-window-end',
    spec: groups([
      sig('start', [{ events: { source: 'scope', type: 'mousedown' }, update: 'x()' }], -1),
      sig('drag', [{ events: { source: 'window', type: 'mousemove', consume: true, between: [{ source: 'scope', type: 'mousedown' }, { source: 'window', type: 'mouseup' }] }, update: '[start, x()]' }], [0, 0]),
    ]),
    steps: [...moves([30, 30]), { t: 'down' }, ...moves([50, 40], [90, 50], [220, 60]), { t: 'up' }, ...moves([60, 60]), { t: 'move', x: 180, y: 50 }, { t: 'down' }, ...moves([200, 60]), { t: 'up' }],
    expectMoved: [],
    expectScopedMoved: true,
  },
  {
    name: 'group-scope-nested-scopes-see-the-enclosing-one',
    spec: groups([sig('outerN', [{ events: 'click', update: 'outerN + 1' }]), sig('outerBase', [{ events: { source: 'view', type: 'dblclick' }, update: 'x()' }], 1)], [], {}, [{
      type: 'group', name: 'inner', signals: [sig('innerN', [{ events: 'click', update: 'innerN + 1' }]), sig('seeBase', [{ events: 'click', update: 'outerBase * 2' }], -1)],
      encode: { update: { x: { value: 5 }, y: { value: 5 }, width: { value: 50 }, height: { value: 50 }, fill: { value: '#fee' } } },
      marks: [{ type: 'rect', name: 'innerbar', encode: { update: { x: { value: 5 }, y: { value: 5 }, width: { value: 10 }, height: { value: 10 }, fill: { value: '#c33' } } } }],
    }]),
    steps: [{ t: 'dblclick', x: G.gap[0], y: G.gap[1] }, { t: 'click', x: 20, y: 20 }, { t: 'click', x: 100, y: 120 }, { t: 'click', x: 170, y: 20 }],
    expectMoved: [],
    expectScopedMoved: true,
  },
  {
    name: 'group-scope-a-group-without-marks-has-no-scope-group',
    spec: groups([sig('outerN', [{ events: 'click', update: 'outerN + 1' }])], [], {}, [{
      type: 'group', name: 'inner', signals: [sig('innerN', [{ events: 'click', update: 'innerN + 1' }])],
      encode: { update: { x: { value: 5 }, y: { value: 5 }, width: { value: 50 }, height: { value: 50 }, fill: { value: '#fee' } } },
    }]),
    steps: [{ t: 'click', x: 20, y: 20 }, { t: 'click', x: 170, y: 20 }],
    expectMoved: [],
    expectScopedMoved: true,
  },
  {
    name: 'group-scope-facet-cells-have-their-own-signals',
    spec: {
      $schema: 'https://vega.github.io/schema/vega/v6.json',
      width: 260, height: 190, padding: 10, autosize: 'none',
      data: [{ name: 't', values: DATA }],
      marks: [{
        type: 'group', name: 'cell', from: { facet: { name: 'facet', data: 't', groupby: 'k' } },
        signals: [{ name: 'facet', value: {}, on: [{ events: [{ source: 'scope', type: 'pointermove' }], update: 'isTuple(facet) ? facet : group("cell").datum' }] }, sig('hits', [{ events: 'click', update: 'hits + 1' }]), sig('key', [{ events: 'mousemove', update: 'facet.k' }], '-'), sig('same', [{ events: 'click', update: 'isTuple(facet) ? 1 : 0' }], -1)],
        encode: { update: { x: { signal: 'datum.x', offset: 0 }, y: { value: 0 }, width: { value: 70 }, height: { value: 180 }, fill: { value: '#eef' } } },
        marks: [{ type: 'rect', from: { data: 'facet' }, encode: { update: { x: { value: 5 }, width: { value: 20 }, y: { value: 100 }, height: { value: 60 }, fill: { value: '#4c78a8' } } } }],
      }],
    },
    steps: [{ t: 'click', x: 40, y: 30 }, { t: 'click', x: 40, y: 30 }, { t: 'click', x: 125, y: 30 }, ...moves([200, 40])],
    expectMoved: [],
    expectScopedMoved: true,
  },
  {
    name: 'group-scope-listeners-run-in-vega-order-root-and-scope',
    spec: groups([sig('seen', [{ events: 'click', update: 'seq' }], -1)], [sig('seq', [{ events: { source: 'view', type: 'click' }, update: 'seq + 1' }], 0)]),
    steps: [{ t: 'click', x: G.left[0], y: G.left[1] }, { t: 'click', x: G.right[0], y: G.right[1] }],
    expectMoved: ['seq'],
    expectScopedMoved: true,
  },
  {
    name: 'group-scope-derived-signal-source-reads-a-scope-handler-of-the-same-event',
    spec: groups([{ name: 'tup', update: 'legsig' }, sig('tog', [{ events: 'click', update: 'event.shiftKey' }], false), sig('mod', [{ events: { signal: 'tup' }, update: 'tog ? "T" : "R"' }], 'init')], [sig('legsig', [{ events: { source: 'view', type: 'click' }, update: 'event.shiftKey ? "S" : "N"' }], '')]),
    steps: [{ t: 'click', x: G.left[0], y: G.left[1] }, { t: 'keydown', key: 'Shift' }, { t: 'click', x: G.left[0], y: G.left[1] }, { t: 'keyup', key: 'Shift' }],
    expectMoved: ['legsig'],
    expectScopedMoved: true,
  },
  {
    name: 'group-scope-order-root-then-scope-handlers-of-one-event',
    spec: groups([{ name: 'log', push: 'outer', on: [{ events: 'click', update: 'log + "S"' }] }], [{ name: 'log', value: '', on: [{ events: { source: 'view', type: 'click' }, update: 'log + "R"' }] }]),
    steps: [{ t: 'click', x: G.left[0], y: G.left[1] }, { t: 'click', x: G.right[0], y: G.right[1] }],
    expectMoved: ['log'],
  },
  {
    name: 'group-scope-order-scope-then-root-declared-handler',
    spec: groups([{ name: 'log', push: 'outer', on: [{ events: { source: 'view', type: 'click' }, update: 'log + "S"' }] }], [{ name: 'log', value: '', on: [{ events: { source: 'view', type: 'click' }, update: 'log + "R"' }] }]),
    steps: [{ t: 'click', x: G.left[0], y: G.left[1] }],
    expectMoved: ['log'],
  },
  {
    name: 'group-scope-order-two-scopes-and-root',
    spec: groups([{ name: 'log', push: 'outer', on: [{ events: { source: 'view', type: 'dblclick' }, update: 'log + "s"' }] }], [{ name: 'log', value: '', on: [{ events: { source: 'view', type: 'dblclick' }, update: 'log + "R"' }] }]),
    steps: [{ t: 'dblclick', x: G.gap[0], y: G.gap[1] }],
    expectMoved: ['log'],
  },
  {
    name: 'probe-signal-source-handler-reevaluates-when-another-referenced-signal-changes',
    spec: chart([sig('a', [{ events: 'click', update: 'a + 1' }]), sig('c', [{ events: 'dblclick', update: 'c + 100' }]), sig('b', [{ events: { signal: 'a' }, update: 'a + c' }], -1)]),
    steps: [{ t: 'click', x: 100, y: 100 }, { t: 'dblclick', x: 100, y: 100 }],
    expectMoved: ['a', 'c'],
  },
  {
    name: 'probe-scope-derived-source-then-scope-event-same-click',
    spec: groups([{ name: 'tup', update: 'legsig' }, sig('tog', [{ events: 'click', update: 'event.shiftKey' }], false), sig('mod', [{ events: { signal: 'tup' }, update: 'tog ? "T" : "R"' }], 'init')], [sig('legsig', [{ events: { source: 'view', type: 'click' }, update: 'event.shiftKey ? "S" : "N"' }], '')]),
    steps: [{ t: 'keydown', key: 'Shift' }, { t: 'click', x: G.left[0], y: G.left[1] }, { t: 'keyup', key: 'Shift' }],
    expectMoved: [],
    expectScopedMoved: true,
  },
  {
    name: 'probe-scope-derived-source-tog-on-later-event',
    spec: groups([{ name: 'tup', update: 'legsig' }, sig('tog', [{ events: 'dblclick', update: 'true' }], false), sig('mod', [{ events: { signal: 'tup' }, update: 'tog ? "T" : "R"' }], 'init')], [sig('legsig', [{ events: { source: 'view', type: 'click' }, update: '"S"' }], '')]),
    steps: [{ t: 'click', x: G.left[0], y: G.left[1] }, { t: 'dblclick', x: G.left[0], y: G.left[1] }],
    expectMoved: [],
    expectScopedMoved: true,
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
import { compileChart, evaluateChart, renderSceneToSvg } from '@aster/core'
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
let readScoped = () => []
const normv = (v) => JSON.stringify(v, (k, x) => (typeof x === 'number' && !Number.isFinite(x) ? 'NaN/Inf:' + String(x) : x === undefined ? '__undefined__' : x && typeof x === 'object' && !Array.isArray(x) && 'mark' in x && ('x' in x || 'datum' in x) ? '[item]' : x))

window.__mountVega = async (spec) => {
  const view = new vega.View(vega.parse(spec), { renderer: 'svg', container: holder, logger, hover: false })
  await view.runAsync()
  names = (spec.signals || []).map((s) => s.name)
  read = () => Object.fromEntries(names.map((n) => [n, view.signal(n)]))
  // the signals of every group item's scope, in document order (vega: the sub-contexts of the view's state)
  readScoped = () => {
    const out = []
    const walk = (st) => { for (const sub of st.subcontext || []) { const own = { ...(sub.signals || {}) }; delete own.parent; if (Object.keys(own).length) out.push(own); walk(sub) } }
    walk(view.getState({ signals: vega.truthy, recurse: true }))
    return out
  }
  window.__settle = async () => { await view.runAsync() }
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
  readScoped = () => {
    const out = []
    const walk = (g) => {
      const sc = g.scopeSignals
      if (sc) {
        const o = {}
        for (const d of sc.defs) { if (d.push === 'outer') continue; const k = sc.id + ':' + d.name; o[d.name] = Object.hasOwn(store, k) ? store[k] : sc.values[d.name] }
        if (Object.keys(o).length) out.push(o)
      }
      for (const c of g.items || []) if (Array.isArray(c.items)) walk(c)
    }
    for (const g of scene.items) walk(g)
    return out
  }
  window.__settle = async () => {}
}

// ---- animations: both engines driven by the page's (fake) clock; each exposes the current frame as SVG text ----
window.__mountVegaAnim = async (spec) => {
  const view = new vega.View(vega.parse(spec), { renderer: 'none', logger, hover: false })
  await view.runAsync()
  names = (spec.signals || []).map((s) => s.name)
  read = () => Object.fromEntries(names.map((n) => [n, view.signal(n)]))
  window.__settle = () => view.runAsync()
  window.__frame = async () => { await view.runAsync(); return view.toSVG() }
  window.__stop = () => { view.finalize() }
}

window.__mountAsterAnim = async (spec) => {
  const compiled = compileChart(spec)
  let signals = {}
  let data = {}
  let binding = null
  let scene = null
  let scheduled = false
  const draw = () => {
    scheduled = false
    scene = evaluateChart(compiled, { signals, data })
    const svg = renderSceneToDomElement(scene)
    holder.replaceChildren(svg)
    if (binding) binding.detach()
    binding = bindSceneSignals(svg, scene, { ...signals }, {
      onSignal: (_n, _v, all) => { signals = { ...all }; schedule() },
      onData: (name, rows) => { data = { ...data, [name]: rows }; schedule() },
      logger,
    }, { data, owner: holder })
  }
  const schedule = () => { if (!scheduled) { scheduled = true; queueMicrotask(draw) } }
  draw()
  names = (spec.signals || []).map((s) => s.name)
  read = () => Object.fromEntries(names.map((n) => [n, Object.hasOwn(signals, n) ? signals[n] : scene.signalParams[n]]))
  window.__settle = async () => { for (let i = 0; i < 4; i++) await Promise.resolve() }
  window.__frame = async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); return renderSceneToSvg(scene) }
  window.__stop = () => { if (binding) binding.release() }
}

window.__read = () => {
  const norm = (v) => JSON.stringify(v, (k, x) => (typeof x === 'number' && !Number.isFinite(x) ? 'NaN/Inf:' + String(x) : x === undefined ? '__undefined__' : x))
  return { signals: Object.fromEntries(Object.entries(read()).map(([k, v]) => [k, norm(v)])), scoped: normv(readScoped()), errors: logs.filter((l) => l.startsWith('error:')) }
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

interface Observed { signals: Record<string, string>; scoped: string; errors: string[] }

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

// ---- animation cases (controlled clock) ---------------------------------------------------------

interface AnimCase {
  name: string
  /** the Vega-Lite spec; compiled with @aster/vl for both engines (vega-lite 6.4.3's own output is pinned by the corpus) */
  vl: Record<string, unknown>
  /** virtual times (ms since the mount) at which both engines are sampled */
  at: number[]
}

const YEARS = [1990, 1991, 1992]
const ANIM_ROWS = YEARS.flatMap((year, y) => ['a', 'b', 'c', 'd'].map((country, c) => ({
  year, date: `${year}-06-15`, country, region: c % 2 ? 'west' : 'east', pop: 10 + 7 * c + 3 * y, life: 50 + 4 * c + 2 * y, fert: 5 - c * 0.5 - y * 0.3,
})))
const animBase = (extra: Record<string, unknown>): Record<string, unknown> => ({
  $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
  width: 240, height: 160, padding: 10, autosize: 'none',
  data: { values: ANIM_ROWS },
  params: [{ name: 'anim', select: { type: 'point', on: 'timer', fields: ['year'] } }],
  transform: [{ filter: { param: 'anim' } }],
  ...extra,
})
const scatter = { mark: { type: 'point', filled: true }, encoding: { x: { field: 'life', type: 'quantitative', scale: { zero: false } }, y: { field: 'fert', type: 'quantitative' }, size: { field: 'pop', type: 'quantitative' }, color: { field: 'region', type: 'nominal' }, time: { field: 'year', type: 'ordinal' } } }
/** Instants that straddle the frame and cycle boundaries of a 2 fps (500 ms step, 1500 ms cycle) animation. */
const SAMPLES = [0, 10, 17, 50, 100, 249, 251, 500, 749, 751, 1000, 1499, 1501, 2000, 3100]

const ANIM_CASES: AnimCase[] = [
  { name: 'anim-scatter-default-clock', vl: animBase(scatter), at: SAMPLES },
  { name: 'anim-fps-4', vl: animBase({ ...scatter, config: { scale: { framesPerSecond: 4 } } }), at: SAMPLES },
  { name: 'anim-empty-false-first-frame-blank', vl: animBase({ ...scatter, transform: [{ filter: { param: 'anim', empty: false } }] }), at: SAMPLES },
  {
    name: 'anim-bars-with-axes',
    vl: animBase({ mark: 'bar', encoding: { x: { field: 'country', type: 'nominal' }, y: { field: 'pop', type: 'quantitative' }, color: { field: 'region', type: 'nominal' }, time: { field: 'year', type: 'ordinal' } } }),
    at: SAMPLES,
  },
  {
    name: 'anim-temporal-field',
    vl: animBase({ params: [{ name: 'anim', select: { type: 'point', on: 'timer', fields: ['date'] } }], mark: 'circle', encoding: { x: { field: 'life', type: 'quantitative' }, y: { field: 'fert', type: 'quantitative' }, time: { field: 'date', type: 'temporal' } } }),
    at: SAMPLES,
  },
  { name: 'anim-named-selection', vl: animBase({ params: [{ name: 'play', select: { type: 'point', on: 'timer', encodings: ['time'] } }], transform: [{ filter: { param: 'play' } }], mark: 'square', encoding: scatter.encoding }), at: SAMPLES },
]

const animCases = ANIM_CASES.filter((c) => !FILTER || c.name.includes(FILTER))

interface Frame { t: number; svg: string; signals: Record<string, string>; errors: string[] }

async function driveAnim(engine: 'vega' | 'aster', vg: Record<string, unknown>, at: number[]): Promise<Frame[] | { error: string }> {
  const context = await browser.newContext({ viewport: { width: 900, height: 600 }, deviceScaleFactor: 1 })
  const T0 = 1_700_000_000_000
  // the fake clock is installed before the page exists, then paused at the same instant for both engines
  await context.clock.install({ time: T0 })
  const page = await context.newPage()
  const pageErrors: string[] = []
  page.on('pageerror', (e) => pageErrors.push(e.message.slice(0, 200)))
  try {
    await page.goto(`file://${join(OUT_DIR, 'index.html')}`)
    await page.waitForFunction(() => '__mountVegaAnim' in window, null, { timeout: 30_000 })
    await page.clock.pauseAt(T0 + 5000)
    await page.evaluate(async ([which, spec]) => {
      const w = window as unknown as Record<string, (s: unknown) => Promise<void>>
      await (which === 'vega' ? w.__mountVegaAnim! : w.__mountAsterAnim!)(spec)
    }, [engine, vg] as const)
    const frames: Frame[] = []
    let now = 0
    for (const t of at) {
      if (t > now) await page.clock.runFor(t - now)
      now = t
      const svg = await page.evaluate(() => (window as unknown as { __frame: () => Promise<string> }).__frame())
      const obs = await page.evaluate(() => (window as unknown as { __read: () => Observed }).__read())
      frames.push({ t, svg, signals: obs.signals, errors: obs.errors })
    }
    await page.evaluate(() => (window as unknown as { __stop: () => void }).__stop())
    if (pageErrors.length) return { error: `page errors: ${pageErrors.join(' | ')}` }
    return frames
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
    if (v.final.scoped !== a.final.scoped) problems.push(`scoped signals: vega=${v.final.scoped} aster=${a.final.scoped}`)
    if (c.expectScopedMoved && v.final.scoped === v.initial.scoped) problems.push(`VACUOUS: vega did not move any scoped signal (${v.final.scoped})`)
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
  if (process.env.SIG_PRINT && !('error' in v)) console.log('  vega', c.name, JSON.stringify(v.final.signals), v.final.scoped)
  if (problems.length === 0) pass++
  else failures.push(`${c.name}: ${problems.join('; ')}`)
}
for (const c of animCases) {
  const vg = compileVL(c.vl as never) as Record<string, unknown>
  const [v, a] = [await driveAnim('vega', vg, c.at), await driveAnim('aster', vg, c.at)]
  const problems: string[] = []
  if ('error' in v) problems.push(`vega side failed: ${v.error}`)
  else if ('error' in a) problems.push(`aster side failed: ${a.error}`)
  else {
    const seen = new Set<string>()
    v.forEach((vf, i) => {
      const af = a[i]!
      const diffs = diffCanonical(canonicalizeSvg(vf.svg), canonicalizeSvg(af.svg))
      if (diffs.length) problems.push(`frame at ${vf.t} ms differs: ${String(diffs[0]).slice(0, 160)}`)
      for (const name of Object.keys(vf.signals)) {
        if (vf.signals[name] !== af.signals[name]) problems.push(`signal ${name} at ${vf.t} ms: vega=${vf.signals[name]} aster=${af.signals[name]}`)
      }
      if (vf.errors.length || af.errors.length) problems.push(`error log at ${vf.t} ms: vega=${JSON.stringify(vf.errors)} aster=${JSON.stringify(af.errors)}`)
      seen.add(JSON.stringify(canonicalizeSvg(vf.svg).records))
    })
    // a vacuous comparison proves nothing: the clock must have run and the picture must have changed on the vega side
    const last = v[v.length - 1]!
    if (v[0]!.signals.anim_clock === last.signals.anim_clock) problems.push('VACUOUS: the animation clock never moved on the vega side')
    if (seen.size < 2 && !c.name.includes('first-frame-blank')) problems.push('VACUOUS: every vega frame is the same picture')
  }
  if (problems.length === 0) pass++
  else failures.push(`${c.name}: ${problems.slice(0, 6).join('; ')}`)
}
await browser.close()
rmSync(OUT_DIR, { recursive: true, force: true })

console.log(`\n[browser-signals] ${pass}/${cases.length + animCases.length} cases agree with real vega (${((Date.now() - t0) / 1000).toFixed(0)}s)`)
for (const f of failures) console.log(`  FAIL ${f}`)
if (MIN_CASES && cases.length + animCases.length < MIN_CASES) {
  console.log(`[browser-signals] FLOOR: ${cases.length + animCases.length} cases < --min-cases ${MIN_CASES}`)
  process.exit(1)
}
if (cases.length + animCases.length === 0) {
  console.log('[browser-signals] no cases ran')
  process.exit(1)
}
process.exit(failures.length ? 1 : 0)
