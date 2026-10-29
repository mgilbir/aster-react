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
 * A composition (concat, facet, repeat) has one frame per view / cell: a step names the one it is aimed at (`view`, the
 * index among the group frames in document order), and positions are fractions of that frame. Their signals live in
 * group scopes, which are compared too (vega: the sub-contexts of the view's state).
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
/** Ceiling on the steps classified `retained` (Aster == vega's fresh render != vega's retained render), like sweep-signals' --max-retained. */
const MAX_RETAINED = Number(arg('max-retained', '1e9'))
const require = createRequire(import.meta.url)
void require

// ---- cases ------------------------------------------------------------------------

/** Positions are fractions (0..1) of the plot frame, so both pages use the same absolute point. */
type Step =
  | { t: 'move'; x: number; y: number; view?: number }
  | { t: 'down' | 'up' }
  | { t: 'click'; x: number; y: number; shift?: boolean; view?: number }
  | { t: 'dblclick'; x: number; y: number; view?: number }
  | { t: 'drag'; x0: number; y0: number; x1: number; y1: number; shift?: boolean; view?: number }
  /** Press at the first point, move through the rest (`steps` mouse moves per leg: 1 is a jump), release at the last unless `hold`. Points may lie outside the frame, even outside the window. */
  | { t: 'path'; pts: Array<[number, number]>; steps?: number; hold?: boolean; shift?: boolean; view?: number }
  | { t: 'wheel'; x: number; y: number; dy: number; shift?: boolean; view?: number }
  | { t: 'clickMark'; i: number; shift?: boolean; sel?: string; view?: number }
  | { t: 'moveMark'; i: number; view?: number }
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
  /** CSS applied to the page of BOTH engines before the chart mounts: the svg sized, bordered, padded or transformed by its host. */
  css?: string
  /** Milliseconds both engines are left running after the mount before the first snapshot (a spec that seeds itself from a timer tick: vega's lands a few frames after the mount). */
  wait?: number
}

const ROWS = [
  { a: 1, b: 3, c: 'x', d: '2020-01-01' }, { a: 2, b: 5, c: 'y', d: '2020-03-01' }, { a: 3, b: 2, c: 'x', d: '2020-06-01' },
  { a: 4, b: 6, c: 'z', d: '2020-09-01' }, { a: 5, b: 4, c: 'y', d: '2021-01-01' }, { a: 6, b: 7, c: 'z', d: '2021-04-01' },
]
const base = (extra: Record<string, unknown>): Record<string, unknown> => ({
  $schema: 'https://vega.github.io/schema/vega-lite/v6.json', data: { values: ROWS }, width: 300, height: 200, ...extra,
})
const xy = { x: { field: 'a', type: 'quantitative' }, y: { field: 'b', type: 'quantitative' } }
/** A composition has no size of its own: its views do. */
const baseC = (extra: Record<string, unknown>): Record<string, unknown> => ({ $schema: 'https://vega.github.io/schema/vega-lite/v6.json', data: { values: ROWS }, ...extra })
const unitV = (extra: Record<string, unknown>): Record<string, unknown> => ({ width: 150, height: 100, ...extra })
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
    spec: base({ params: [sel('grid', 'interval', { bind: 'scales' })], mark: 'point', encoding: xy }),
    steps: [{ t: 'drag', x0: 0.5, y0: 0.5, x1: 0.3, y1: 0.6 }, { t: 'wheel', x: 0.5, y: 0.5, dy: -120 }, { t: 'wheel', x: 0.2, y: 0.8, dy: 200 }, { t: 'dblclick', x: 0.5, y: 0.5 }],
    moves: [0, 1, 2, 3],
  },
  {
    name: 'bind scales on log and pow scales',
    spec: base({ params: [sel('grid', 'interval', { bind: 'scales' })], mark: 'point', encoding: { x: { field: 'a', type: 'quantitative', scale: { type: 'log' } }, y: { field: 'b', type: 'quantitative', scale: { type: 'pow', exponent: 2 } } } }),
    steps: [{ t: 'drag', x0: 0.5, y0: 0.5, x1: 0.4, y1: 0.4 }, { t: 'wheel', x: 0.5, y: 0.5, dy: -150 }],
    moves: [0, 1],
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
  // --- compositions: the units' signals are their groups' (one scope per view / cell) ---
  {
    name: 'concat: a brush in one view filters another',
    spec: baseC({
      hconcat: [
        unitV({ params: [sel('brush', { type: 'interval', encodings: ['x'] })], mark: 'point', encoding: xy }),
        unitV({ transform: [{ filter: { param: 'brush' } }], mark: 'bar', encoding: { x: { field: 'c', type: 'nominal' }, y: { field: 'b', type: 'quantitative', aggregate: 'sum' } } }),
      ],
    }),
    steps: [{ t: 'drag', x0: 0.2, y0: 0.5, x1: 0.6, y1: 0.5, view: 0 }, { t: 'drag', x0: 0.4, y0: 0.5, x1: 0.9, y1: 0.5, view: 0 }, { t: 'dblclick', x: 0.5, y: 0.5, view: 0 }],
    moves: [0, 1, 2],
  },
  {
    name: 'concat: a selection declared on the composition is shared by its views',
    spec: baseC({
      params: [sel('brush', 'interval')],
      hconcat: [unitV({ mark: 'point', encoding: xy }), unitV({ mark: 'point', encoding: { x: { field: 'b', type: 'quantitative' }, y: { field: 'a', type: 'quantitative' } } })],
    }),
    steps: [{ t: 'drag', x0: 0.2, y0: 0.2, x1: 0.6, y1: 0.7, view: 0 }, { t: 'drag', x0: 0.3, y0: 0.3, x1: 0.8, y1: 0.9, view: 1 }, { t: 'dblclick', x: 0.5, y: 0.5, view: 1 }],
    moves: [0, 1, 2],
  },
  {
    name: 'vconcat: a point selection links two views',
    spec: baseC({
      vconcat: [
        unitV({ params: [sel('pick', { type: 'point', fields: ['c'] })], mark: 'point', encoding: { ...xy, color: colorBy('pick') } }),
        unitV({ mark: 'bar', encoding: { x: { field: 'c', type: 'nominal' }, y: { field: 'b', type: 'quantitative', aggregate: 'sum' }, color: colorBy('pick') } }),
      ],
    }),
    steps: [{ t: 'clickMark', i: 1, view: 0 }, { t: 'clickMark', i: 0, shift: true, view: 0 }, { t: 'click', x: 0.5, y: 0.97, view: 0 }, { t: 'dblclick', x: 0.5, y: 0.5, view: 0 }],
    moves: [0, 1, 2],
  },
  {
    name: 'facet: a brush in each cell, the latest wins',
    spec: baseC({ facet: { column: { field: 'c', type: 'nominal' } }, spec: unitV({ params: [sel('brush', 'interval')], mark: 'point', encoding: xy }) }),
    steps: [{ t: 'drag', x0: 0.2, y0: 0.2, x1: 0.6, y1: 0.7, view: 0 }, { t: 'drag', x0: 0.3, y0: 0.3, x1: 0.8, y1: 0.9, view: 1 }, { t: 'dblclick', x: 0.5, y: 0.5, view: 1 }],
    moves: [0, 1, 2],
  },
  {
    name: 'facet: a point selection across cells, with shift to add',
    spec: baseC({ facet: { column: { field: 'c', type: 'nominal' } }, spec: unitV({ params: [sel('pick', 'point')], mark: 'point', encoding: { ...xy, color: { condition: { param: 'pick', value: 'firebrick' }, value: 'lightgray' } } }) }),
    steps: [{ t: 'clickMark', i: 0, view: 0 }, { t: 'clickMark', i: 0, view: 1 }, { t: 'clickMark', i: 0, shift: true, view: 2 }, { t: 'click', x: 0.5, y: 0.97, view: 1 }],
    moves: [0, 1, 2, 3],
  },
  {
    name: 'facet by row and column: point selections',
    spec: baseC({
      data: { values: ROWS.flatMap((r, i) => [{ ...r, e: 'p' }, { ...r, a: r.a + 10, e: 'q', c: ['x', 'y', 'z'][(i + 1) % 3] }]) },
      facet: { row: { field: 'e', type: 'nominal' }, column: { field: 'c', type: 'nominal' } },
      spec: unitV({ width: 100, height: 70, params: [sel('pick', 'point')], mark: 'point', encoding: { ...xy, color: { condition: { param: 'pick', value: 'firebrick' }, value: 'lightgray' } } }),
    }),
    steps: [{ t: 'clickMark', i: 0, view: 0 }, { t: 'clickMark', i: 0, view: 4 }, { t: 'clickMark', i: 0, shift: true, view: 1 }],
    moves: [0, 1, 2],
  },
  {
    name: 'repeat: a brush per repeated view',
    spec: baseC({ repeat: { column: ['a', 'b'] }, spec: unitV({ params: [sel('brush', 'interval')], mark: 'point', encoding: { x: { field: { repeat: 'column' }, type: 'quantitative' }, y: { field: 'b', type: 'quantitative' } } }) }),
    steps: [{ t: 'drag', x0: 0.2, y0: 0.2, x1: 0.6, y1: 0.7, view: 0 }, { t: 'drag', x0: 0.3, y0: 0.3, x1: 0.8, y1: 0.9, view: 1 }, { t: 'dblclick', x: 0.5, y: 0.5, view: 1 }],
    moves: [0, 1, 2],
  },
  {
    name: 'concat: bound scales pan one view and leave the other alone',
    spec: baseC({ hconcat: [unitV({ params: [sel('grid', 'interval', { bind: 'scales' })], mark: 'point', encoding: xy }), unitV({ mark: 'point', encoding: xy })] }),
    steps: [{ t: 'drag', x0: 0.5, y0: 0.5, x1: 0.3, y1: 0.6, view: 0 }, { t: 'wheel', x: 0.5, y: 0.5, dy: -120, view: 0 }, { t: 'dblclick', x: 0.5, y: 0.5, view: 0 }],
    moves: [0, 1, 2],
  },
  {
    name: 'concat: a layered view with a brush in one layer',
    spec: baseC({
      hconcat: [
        { width: 150, height: 100, layer: [unitV({ params: [sel('brush', { type: 'interval', encodings: ['x'] })], mark: 'point', encoding: xy, width: undefined, height: undefined }), { mark: 'line', encoding: { ...xy, color: { value: 'steelblue' } } }] },
        unitV({ transform: [{ filter: { param: 'brush' } }], mark: 'point', encoding: xy }),
      ],
    }),
    steps: [{ t: 'drag', x0: 0.2, y0: 0.5, x1: 0.7, y1: 0.5, view: 0 }, { t: 'dblclick', x: 0.5, y: 0.5, view: 0 }],
    moves: [0, 1],
  },
  {
    name: 'facet wrap: an interval selection per cell',
    spec: baseC({ facet: { field: 'c', type: 'nominal' }, columns: 2, spec: unitV({ params: [sel('brush', { type: 'interval', encodings: ['x'] })], mark: 'point', encoding: xy }) }),
    steps: [{ t: 'drag', x0: 0.2, y0: 0.5, x1: 0.6, y1: 0.5, view: 0 }, { t: 'drag', x0: 0.3, y0: 0.5, x1: 0.8, y1: 0.5, view: 2 }],
    moves: [0, 1],
  },
  {
    name: 'nested concat: a brush filters its sibling inside a vconcat',
    spec: baseC({
      vconcat: [
        { hconcat: [unitV({ params: [sel('brush', { type: 'interval', encodings: ['x'] })], mark: 'point', encoding: xy }), unitV({ transform: [{ filter: { param: 'brush' } }], mark: 'bar', encoding: { x: { field: 'c', type: 'nominal' }, y: { field: 'b', type: 'quantitative', aggregate: 'sum' } } })] },
        unitV({ mark: 'point', encoding: xy }),
      ],
    }),
    steps: [{ t: 'drag', x0: 0.2, y0: 0.5, x1: 0.6, y1: 0.5, view: 1 }, { t: 'dblclick', x: 0.5, y: 0.5, view: 1 }],
    moves: [0, 1],
  },
  {
    name: 'facet: bound scales are shared by the cells',
    spec: baseC({ facet: { column: { field: 'c', type: 'nominal' } }, spec: unitV({ params: [sel('grid', 'interval', { bind: 'scales' })], mark: 'point', encoding: xy }) }),
    steps: [{ t: 'drag', x0: 0.5, y0: 0.5, x1: 0.3, y1: 0.6, view: 1 }, { t: 'wheel', x: 0.5, y: 0.5, dy: -120, view: 0 }, { t: 'dblclick', x: 0.5, y: 0.5, view: 2 }],
    moves: [0, 1, 2],
  },
  {
    name: 'concat: a point selection bound to a legend filters another view',
    spec: baseC({
      hconcat: [
        unitV({ params: [sel('pick', { type: 'point', fields: ['c'] }, { bind: 'legend' })], mark: 'point', encoding: { ...xy, color: { field: 'c', type: 'nominal' }, opacity: { condition: { param: 'pick', value: 1 }, value: 0.2 } } }),
        unitV({ mark: 'bar', transform: [{ filter: { param: 'pick' } }], encoding: { x: { field: 'c', type: 'nominal' }, y: { field: 'b', type: 'quantitative', aggregate: 'sum' } } }),
      ],
    }),
    steps: [{ t: 'clickLegend', part: 'symbols', i: 1 }, { t: 'clickLegend', part: 'symbols', i: 0, shift: true }, { t: 'dblclickLegend', part: 'symbols', i: 0 }],
    moves: [0, 1, 2],
  },
  {
    name: 'concat: a nearest point selection on hover',
    spec: baseC({ hconcat: [unitV({ params: [sel('hover', { type: 'point', nearest: true, on: 'pointerover' })], mark: 'point', encoding: { ...xy, color: { condition: { param: 'hover', value: 'firebrick', empty: false }, value: 'gray' } } }), unitV({ mark: 'point', encoding: xy })] }),
    steps: [{ t: 'moveMark', i: 1, view: 0 }, { t: 'moveMark', i: 3, view: 0 }],
    moves: [0, 1],
  },
  {
    name: 'facet of a layered unit: an interval selection in one layer',
    spec: baseC({
      facet: { column: { field: 'c', type: 'nominal' } },
      spec: { width: 120, height: 80, layer: [{ params: [sel('brush', { type: 'interval', encodings: ['x'] })], mark: 'point', encoding: xy }, { mark: 'rule', encoding: { x: { aggregate: 'mean', field: 'a', type: 'quantitative' } } }] },
    }),
    steps: [{ t: 'drag', x0: 0.2, y0: 0.5, x1: 0.6, y1: 0.5, view: 0 }, { t: 'drag', x0: 0.3, y0: 0.5, x1: 0.8, y1: 0.5, view: 1 }, { t: 'dblclick', x: 0.5, y: 0.5, view: 1 }],
    moves: [0, 1, 2],
  },
  {
    name: 'repeat: a point selection over the repeated fields',
    spec: baseC({ repeat: { column: ['a', 'b'] }, spec: unitV({ params: [sel('pick', { type: 'point', fields: ['c'] })], mark: 'point', encoding: { x: { field: { repeat: 'column' }, type: 'quantitative' }, y: { field: 'b', type: 'quantitative' }, color: { condition: { param: 'pick', field: 'c', type: 'nominal' }, value: 'lightgray' } } }) }),
    steps: [{ t: 'clickMark', i: 1, view: 0 }, { t: 'clickMark', i: 3, shift: true, view: 1 }, { t: 'click', x: 0.5, y: 0.97, view: 0 }],
    moves: [0, 1, 2],
  },
  ...geoCases(),
  ...hostedCases(),
]

/**
 * An interval selection over `latitude` / `longitude` encodings: no scale inverts a projection, so vega-lite selects by what is drawn
 * inside the brush (`intersect(box, {markname}, unit.mark)`), seeds the brush from its initial value one timer tick after the
 * view starts (`geo_interval_init_tick`), and filters other views through the store. The brush follows the pointer too.
 */
function geoCases(): Case[] {
  const PLACES = [
    { id: 'a', lat: 47.6, lon: -122.3, n: 3, k: 'x' }, { id: 'b', lat: 45.5, lon: -122.7, n: 5, k: 'y' }, { id: 'c', lat: 37.8, lon: -122.4, n: 8, k: 'x' },
    { id: 'd', lat: 34.1, lon: -118.2, n: 2, k: 'z' }, { id: 'e', lat: 40.7, lon: -74.0, n: 9, k: 'y' }, { id: 'f', lat: 41.9, lon: -87.6, n: 4, k: 'x' },
    { id: 'g', lat: 29.8, lon: -95.4, n: 6, k: 'z' }, { id: 'h', lat: 33.4, lon: -112.1, n: 7, k: 'y' }, { id: 'i', lat: 25.8, lon: -80.2, n: 1, k: 'x' },
    { id: 'j', lat: 44.9, lon: -93.3, n: 5, k: 'z' }, { id: 'k', lat: 39.7, lon: -105.0, n: 3, k: 'y' }, { id: 'l', lat: 42.4, lon: -71.1, n: 6, k: 'x' },
  ]
  const geoUnit = (extra: Record<string, unknown>): Record<string, unknown> => ({
    width: 300, height: 180, projection: { type: 'mercator' }, data: { values: PLACES }, ...extra,
  })
  const ll = { longitude: { field: 'lon', type: 'quantitative' }, latitude: { field: 'lat', type: 'quantitative' } }
  const gold = (param: string): Record<string, unknown> => ({ condition: { param, empty: false, value: 'goldenrod' }, value: 'steelblue' })
  return [
    {
      name: 'geo interval on latitude: an initial value, a new brush, translate, clear',
      spec: baseC(geoUnit({
        params: [sel('brush', { type: 'interval', encodings: ['latitude'] }, { value: { latitude: [33, 43] } })],
        mark: 'circle', encoding: { ...ll, size: { field: 'n', type: 'quantitative' }, color: gold('brush') },
      })),
      steps: [
        { t: 'drag', x0: 0.2, y0: 0.2, x1: 0.8, y1: 0.55 },
        { t: 'drag', x0: 0.5, y0: 0.4, x1: 0.5, y1: 0.7 },
        { t: 'dblclick', x: 0.5, y: 0.9 },
      ],
      moves: [0, 1, 2],
      wait: 300,
    },
    {
      name: 'geo interval on both: an initial value, over squares',
      spec: baseC(geoUnit({
        params: [sel('brush', 'interval', { value: { latitude: [30, 45], longitude: [-125, -100] } })],
        mark: { type: 'square', size: 80 }, encoding: { ...ll, color: gold('brush') },
      })),
      steps: [{ t: 'drag', x0: 0.1, y0: 0.2, x1: 0.6, y1: 0.8 }, { t: 'dblclick', x: 0.9, y: 0.9 }],
      moves: [0, 1],
      wait: 300,
    },
    {
      name: 'geo interval over text marks',
      spec: baseC(geoUnit({
        params: [sel('brush', 'interval', { value: { latitude: [35, 48], longitude: [-100, -70] } })],
        mark: { type: 'text', fontSize: 12 }, encoding: { ...ll, text: { field: 'id' }, color: gold('brush') },
      })),
      steps: [{ t: 'drag', x0: 0.4, y0: 0.2, x1: 0.95, y1: 0.7 }],
      moves: [0],
      wait: 300,
    },
    {
      name: 'geo crossfilter: a map brushed (with an initial value) filters a bar chart through its store',
      spec: baseC({
        vconcat: [
          geoUnit({
            layer: [{
              params: [sel('brush', 'interval', { value: { latitude: [32, 46], longitude: [-125, -95] } })],
              mark: 'circle', encoding: { ...ll, size: { field: 'n', type: 'quantitative', legend: null }, color: gold('brush') },
            }],
          }),
          {
            width: 300, height: 100, data: { values: PLACES },
            transform: [{ lookup: 'id', from: { param: 'brush', key: 'id' } }],
            layer: [
              { mark: 'bar', encoding: { x: { field: 'k', type: 'nominal' }, y: { aggregate: 'count', type: 'quantitative' }, color: { value: 'steelblue' } } },
              { transform: [{ filter: "data('brush_store').length && isValid(datum.brush)" }], mark: 'bar', encoding: { x: { field: 'k', type: 'nominal' }, y: { aggregate: 'count', type: 'quantitative' }, color: { value: 'goldenrod' } } },
            ],
          },
        ],
      }),
      steps: [{ t: 'drag', x0: 0.1, y0: 0.2, x1: 0.5, y1: 0.7, view: 0 }, { t: 'drag', x0: 0.3, y0: 0.45, x1: 0.6, y1: 0.4, view: 0 }, { t: 'dblclick', x: 0.95, y: 0.95, view: 0 }],
      moves: [0, 1, 2],
      wait: 300,
    },
  ]
}

/**
 * The brush follows the pointer exactly, wherever the chart sits and however its host sizes it: pointer -> view coordinates is
 * vega's (the svg's screen CTM, so a CSS-scaled, bordered, padded or transformed svg is mapped like vega maps it), and the
 * group transform is each enclosing group's x/y. Every cell / view of a composition is pressed in, and each press leaves the
 * frame a different way: through an edge, the header, the axes, the gap between cells, the padding, out of the window and back,
 * released outside; slowly and in one jump.
 */
function hostedCases(): Case[] {
  type P = Array<[number, number]>
  // (all fractions of the pressed cell; the cell's own x range is 0..1, so > 1 is the gap and the next cell, < 0 the one before)
  const exits: Array<{ name: string; pts: P; steps?: number }> = [
    { name: 'inside', pts: [[0.25, 0.3], [0.55, 0.5], [0.8, 0.7]], steps: 4 },
    { name: 'right edge', pts: [[0.3, 0.4], [0.9, 0.5], [1.05, 0.6]], steps: 3 },
    { name: 'header', pts: [[0.5, 0.5], [0.45, -0.1], [0.4, -0.35]], steps: 3 },
    { name: 'x axis', pts: [[0.6, 0.5], [0.55, 1.1], [0.5, 1.35]], steps: 3 },
    { name: 'y axis', pts: [[0.2, 0.5], [-0.1, 0.45], [-0.35, 0.4]], steps: 3 },
    { name: 'cell border', pts: [[0.4, 0.5], [0.99, 0.5], [1.003, 0.45], [0.5, 1.003]], steps: 2 },
    { name: 'padding, fast', pts: [[0.2, 0.4], [-0.4, -0.3]], steps: 1 },
    { name: 'gap', pts: [[0.7, 0.3], [1.08, 0.35], [1.12, 0.5]], steps: 2 },
    { name: 'out of the window and back', pts: [[0.5, 0.5], [-9, 0.5], [0.3, 0.2]], steps: 2 },
    { name: 'released outside the window', pts: [[0.4, 0.5], [0.9, 0.9], [-9, 2.5]], steps: 1 },
  ]
  /** `views`: the frames pressed in (document order; a concat inside a concat has a frame of its own before its children's). */
  const make = (name: string, spec: Record<string, unknown>, views: number | number[], css?: string): Case => {
    const steps: Step[] = []
    for (const view of typeof views === 'number' ? Array.from({ length: views }, (_, i) => i) : views) for (const e of exits) steps.push({ t: 'path', pts: e.pts, steps: e.steps, view })
    return { name, spec, steps, moves: steps.map((_, i) => i), css }
  }
  const facet = (extra: Record<string, unknown> = {}): Record<string, unknown> => baseC({ facet: { column: { field: 'c', type: 'nominal' } }, spec: unitV({ params: [sel('brush', 'interval')], mark: 'point', encoding: xy }), ...extra })
  const scaled = '#c svg { max-width: 400px; height: auto }'
  const boxed = '#c svg { border: 6px solid #888; padding: 9px; box-sizing: content-box }'
  const transformed = '#c { transform: scale(0.8) rotate(0deg); transform-origin: 0 0 }'
  const unitB = (n: string): Record<string, unknown> => unitV({ params: [sel(n, 'interval')], mark: 'point', encoding: xy })
  return [
    make('hosted: facet, a brush path from each cell', facet(), 3),
    make('hosted: facet in a CSS-scaled svg (max-width), a brush path from each cell', facet(), 3, scaled),
    make('hosted: facet in a bordered, padded svg, a brush path from each cell', facet(), 3, boxed),
    make('hosted: facet under a CSS transform, a brush path from each cell', facet(), 3, transformed),
    make('hosted: facet with a spec padding and a CSS-scaled svg', facet({ padding: { left: 31, top: 12, right: 7, bottom: 20 } }), 3, scaled),
    make('hosted: facet by row and column in a CSS-scaled svg', baseC({ data: { values: ROWS.flatMap((r, i) => [{ ...r, e: 'p' }, { ...r, a: r.a + 10, e: 'q', c: ['x', 'y', 'z'][(i + 1) % 3] }]) }, facet: { row: { field: 'e', type: 'nominal' }, column: { field: 'c', type: 'nominal' } }, spec: unitV({ width: 100, height: 70, params: [sel('brush', 'interval')], mark: 'point', encoding: xy }) }), [0, 2, 3, 5], scaled),
    make('hosted: facet wrap in a CSS-scaled svg', baseC({ facet: { field: 'c', type: 'nominal' }, columns: 2, spec: unitB('brush') }), 3, scaled),
    make('hosted: hconcat, a brush path from each view, CSS-scaled', baseC({ hconcat: [unitB('b0'), unitB('b1'), unitB('b2')] }), 3, scaled),
    make('hosted: vconcat, a brush path from each view, CSS-scaled', baseC({ vconcat: [unitB('b0'), unitB('b1')] }), 2, scaled),
    make('hosted: nested concat (vconcat of hconcat), a brush path from each view, CSS-scaled', baseC({ vconcat: [{ hconcat: [unitB('b0'), unitB('b1')] }, unitB('b2')] }), [1, 2, 3], scaled),
    make('hosted: facet of a layered unit under a CSS transform', baseC({ facet: { column: { field: 'c', type: 'nominal' } }, spec: { width: 150, height: 100, layer: [{ params: [sel('brush', 'interval')], mark: 'point', encoding: xy }, { mark: 'line', encoding: xy }] } }), 3, transformed),
    make('hosted: single view with a spec padding in a CSS-scaled svg', base({ padding: 25, params: [sel('brush', 'interval')], mark: 'point', encoding: xy }), 1, '#c svg { max-width: 360px; height: auto }'),
  ]
}
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
window.__freshErrors = []

const norm = (v) => JSON.stringify(v, function (k, x) {
  if (typeof x === 'function') return undefined
  if (x instanceof Set) return { $set: [...x] }
  if (x instanceof Date) return { $date: x.getTime() }
  if (typeof x === 'number' && !Number.isFinite(x)) return 'NaN/Inf:' + String(x)
  if (x === undefined) return '__undefined__'
  if (x && typeof x === 'object' && !Array.isArray(x) && 'mark' in x && ('x' in x || 'datum' in x)) return '[item]'
  return x
})

// A deep copy for the fresh view: setState hands the tuples, signal values and nested objects to a second dataflow, which
// writes to them (ids, derived fields); sharing them with the retained view broke its next wheel event.
const cloneState = (v, ancestors = new Set()) => {
  if (v instanceof Date) return new Date(v.getTime())
  if (v && typeof v === 'object') {
    if (ancestors.has(v)) return undefined // (a cycle: a scenegraph item reaches its group, which reaches it)
    if (!Array.isArray(v) && !(v instanceof Set) && 'mark' in v && ('x' in v || 'datum' in v)) return undefined // (a scenegraph item: event signals hold the one under the pointer)
    ancestors.add(v)
    let out
    if (v instanceof Set) out = new Set([...v].map((x) => cloneState(x, ancestors)))
    else if (Array.isArray(v)) out = v.map((x) => cloneState(x, ancestors))
    else {
      out = {}
      // (a signal that held a scenegraph item has nothing to restore: the fresh view's own value stays)
      for (const k of Object.keys(v)) { const c = cloneState(v[k], ancestors); if (c !== undefined || v[k] === undefined) out[k] = c }
    }
    ancestors.delete(v)
    return out
  }
  return typeof v === 'function' ? undefined : v
}

let names = []
let stores = []
window.__modlog = []
if (${JSON.stringify(Boolean(process.env.SEL_MOD))}) {
  const f0 = vega.expressionFunction('modify')
  vega.expressionFunction('modify', function (...a) { const n = this.context.data[a[0]].input.value.length; const r = f0.apply(this, a); window.__modlog.push((this.context.group ? this.context.group.mark.name : '?') + ' ' + a[0] + ' pre=' + n + ' ins=' + JSON.stringify(a[1]) + ' rem=' + String(a[2]) + ' tog=' + JSON.stringify(a[3]) + ' -> ' + r + ' stamp=' + this.context.dataflow.stamp()); return r }) 
}
window.__mountVega = async (specVl) => {
  const vg = vl.compile(specVl).spec
  names = (vg.signals || []).map((s) => s.name)
  stores = (vg.data || []).map((d) => d.name).filter((n) => /_store$/.test(n))
  const view = new vega.View(vega.parse(vg), { renderer: 'svg', container: holder, bind: binds, hover: false, logger: { level() { return this }, error(...a) { window.__errors.push(a.map(String).join(' ')); return this }, warn() { return this }, info() { return this }, debug() { return this } } })
  await view.runAsync()
  window.__read = () => ({
    signals: Object.fromEntries(names.map((n) => [n, norm(view.signal(n))])),
    stores: Object.fromEntries(stores.map((n) => [n, norm(view.data(n))])),
    scoped: (() => {
      // the signals of every group item's scope, in document order (vega: the sub-contexts of the view's state)
      const out = []
      const walk = (st) => { for (const sub of st.subcontext || []) { const own = { ...(sub.signals || {}) }; delete own.parent; if (Object.keys(own).length) out.push(own); walk(sub) } }
      walk(view.getState({ signals: vega.truthy, recurse: true }))
      // (vega creates a facet's scopes in data order, the scene lists its cells sorted: compared as a set)
      return JSON.stringify(out.map((o) => norm(o)).sort())
    })(),
  })
  window.__svg = () => view.toSVG()
  window.__settle = async () => { await view.runAsync() }
  // vega's FRESH render of the same spec at the retained view's current signal values and store contents: a new View
  // initialised from the first one's state. Aster renders fresh (docs/INTERACTION.md, "a signal write is a fresh
  // render"), vega retains its first autosize, padding and tick order; the driver tells the two apart with this.
  window.__fresh = async () => {
    // (the default state: every signal that is not a proxy, and the data a modify() edited: the selection stores)
    const state = view.getState()
    const fresh = new vega.View(vega.parse(JSON.parse(JSON.stringify(vg))), { renderer: 'none', hover: false, logger: { level() { return this }, error(...a) { window.__freshErrors.push(a.map((x) => (x && x.stack ? x.stack : String(x))).join(' ').slice(0, 700)); return this }, warn() { return this }, info() { return this }, debug() { return this } } })
    // The view's own signals and the stores first: the layout is then computed once, for the state it renders. The group
    // scopes do not exist before the first run, so theirs follow (what they hold is drawn within the groups, it moves no layout).
    fresh.setState(cloneState({ signals: state.signals, data: state.data }))
    await fresh.runAsync()
    fresh.setState(cloneState(state))
    await fresh.runAsync()
    // (setState writes the values without waking what reads them: the scopes' marks are encoded again, which reads them)
    const touchEncodes = (ctx) => { for (const sub of ctx.subcontext || []) { for (const op of Object.values(sub.nodes)) if (op instanceof vega.transforms.encode) fresh.touch(op); touchEncodes(sub) } }
    touchEncodes(fresh._runtime)
    await fresh.runAsync()
    const svg = await fresh.toSVG()
    fresh.finalize()
    return svg
  }
}

window.__mountAster = async (specVl) => {
  // (the chart compiles the Vega-Lite spec itself; its numbers are the view size a host gives <Chart>, which otherwise fills its
  // container: a composition has none of its own, so 0 is the view's default size there)
  const vg = vl.compile(specVl).spec
  names = (vg.signals || []).map((s) => s.name)
  stores = (vg.data || []).map((d) => d.name).filter((n) => /_store$/.test(n))
  window.__ref = React.createRef()
  const root = createRoot(holder)
  flushSync(() => root.render(React.createElement(Chart, { ref: window.__ref, spec: specVl, width: typeof vg.width === 'number' ? vg.width : 0, height: typeof vg.height === 'number' ? vg.height : 0, onError: (e) => window.__errors.push('onError:' + String(e)), logger: { error: (...a) => window.__errors.push(a.map(String).join(' ')), warn() {} } })))
  for (let i = 0; i < 200 && !(window.__ref.current && window.__ref.current.getScene()); i++) await new Promise((r) => setTimeout(r, 25))
  if (!window.__ref.current) throw new Error('chart did not mount: ' + JSON.stringify(window.__errors) + ' ref=' + String(window.__ref.current) + ' html=' + holder.innerHTML.slice(0, 300))
  window.__read = () => {
    const scene = window.__ref.current.getScene()
    const params = scene.signalParams
    const scoped = []
    const walk = (g) => {
      const sc = g.scopeSignals
      if (sc) {
        const o = {}
        for (const d of sc.defs) if (d.push !== 'outer') o[d.name] = sc.values[d.name]
        if (Object.keys(o).length) scoped.push(o)
      }
      for (const c of g.items || []) if (Array.isArray(c.items)) walk(c)
    }
    for (const g of scene.items) walk(g)
    return {
      signals: Object.fromEntries(names.map((n) => [n, norm(params[n])])),
      stores: Object.fromEntries(stores.map((n) => [n, norm(scene.runtime.data(n))])),
      scoped: JSON.stringify(scoped.map((o) => norm(o)).sort()),
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

interface Snapshot { signals: Record<string, string>; stores: Record<string, string>; scoped?: string; svg: string; fresh?: string }

async function snapshot(page: Page, withFresh = false): Promise<Snapshot> {
  const r = await page.evaluate(() => (window as unknown as { __read: () => { signals: Record<string, string>; stores: Record<string, string>; scoped?: string } }).__read())
  const svg = await page.evaluate(() => Promise.resolve((window as unknown as { __svg: () => string | Promise<string> }).__svg()))
  if (!withFresh) return { ...r, svg }
  const fresh = await page.evaluate(() => (window as unknown as { __fresh: () => Promise<string> }).__fresh())
  return { ...r, svg, fresh }
}

interface Frame { x: number; y: number; w: number; h: number }
/** The frames of the views, in document order: one per group item that is a view or a cell, else the single view's. */
async function framesOf(page: Page): Promise<Frame[]> {
  return page.evaluate(() => {
    // (a composition's views and cells: groups named `<child>_group`, or `cell`; the groups a path mark makes are not views)
    let els = [...document.querySelectorAll('#c svg g.role-scope.cell > g > path.background, #c svg g.role-scope[class$="_group"] > g > path.background')] as SVGGraphicsElement[]
    if (!els.length) {
      // a single view: its frame is the largest background path (a group mid-update can be empty for a frame)
      const all = [...document.querySelectorAll('#c svg path.background')] as SVGGraphicsElement[]
      let best = -1
      let el: SVGGraphicsElement | null = null
      for (const e of all) { const q = e.getBoundingClientRect(); if (q.width * q.height > best) { best = q.width * q.height; el = e } }
      els = [(el ?? document.querySelector('#c svg')!) as SVGGraphicsElement]
    }
    return els.map((e) => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height } })
  })
}
async function frameOf(page: Page, view = 0): Promise<Frame> {
  return (await framesOf(page))[view] ?? { x: 0, y: 0, w: 0, h: 0 }
}

/** Vega keeps its first layout: the frames of its views are measured once, at the start of the case. */
const vegaFrames = new WeakMap<Page, Frame[]>()

async function runStep(page: Page, s: Step, engine: 'vega' | 'aster'): Promise<void> {
  // Vega keeps its first layout, and after a bound-scale pan its frame's background path collapses to 0x0 (the stale group
  // size), so vega's plot origin is measured once, at the start of the case. Aster's moves, so it is measured as needed.
  const viewIdx = ('view' in s ? s.view : undefined) ?? 0
  if (engine === 'vega' && !vegaFrames.has(page)) {
    const all = await framesOf(page)
    if (all.every((fr) => fr.w > 0)) vegaFrames.set(page, all)
  }
  let f = engine === 'vega' ? (vegaFrames.get(page)?.[viewIdx] ?? (await frameOf(page, viewIdx))) : await frameOf(page, viewIdx)
  if (process.env.SEL_DEBUG) console.log('frame', JSON.stringify(f))
  // Positions are fractions of the plot frame AS IT IS WHEN THE EVENT IS SENT. Aster renders fresh after every signal write,
  // so its padding (and with it the frame's place in the page) can move under a drag that pans an axis, where vega keeps
  // its first layout; the same fraction of the current frame is the same point in view space in both.
  const refresh = async (): Promise<void> => {
    if (engine === 'vega') return // (vega keeps its first layout, so its frame does not move)
    for (let k = 0; k < 20; k++) {
      await page.evaluate(() => (window as unknown as { __settle: () => Promise<unknown> }).__settle())
      f = await frameOf(page, viewIdx)
      if (process.env.SEL_DEBUG) console.log('refresh', k, JSON.stringify(f))
      if (f.w > 0 && f.h > 0) return
      await page.waitForTimeout(25)
    }
  }
  const at = (x: number, y: number): [number, number] => [f.x + x * f.w, f.y + y * f.h]
  const shift = async (on: boolean | undefined, fn: () => Promise<void>): Promise<void> => {
    if (on) await page.keyboard.down('Shift')
    try { await fn() } finally { if (on) await page.keyboard.up('Shift') }
  }
  const markBox = async (i: number): Promise<[number, number]> => {
    const b = await page.evaluate(([idx, view]) => {
      // (in a composition: the marks inside the view's own group item)
      const items = [...document.querySelectorAll('#c svg g.role-scope.cell > g, #c svg g.role-scope[class$="_group"] > g')]
      const roots = items.length ? items : [document.querySelector('#c svg')!]
      const el = roots[view]!.querySelectorAll('.mark-symbol.marks path, .mark-rect.marks path, .mark-symbol.layer_0_marks path, .mark-symbol[class*="_marks"] path, .mark-rect[class*="_marks"] path')[idx] as SVGGraphicsElement
      const r = el.getBoundingClientRect()
      return [r.left + r.width / 2, r.top + r.height / 2] as [number, number]
    }, [i, viewIdx] as const)
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
        for (let k = 1; k <= 8; k++) {
          await refresh()
          await page.mouse.move(...at(s.x0 + ((s.x1 - s.x0) * k) / 8, s.y0 + ((s.y1 - s.y0) * k) / 8))
          await dbg('move' + k)
        }
        await page.mouse.up()
      })
      break
    case 'path':
      await shift(s.shift, async () => {
        await page.mouse.move(...at(...s.pts[0]!))
        await page.mouse.down()
        for (const pt of s.pts.slice(1)) {
          await refresh()
          await page.mouse.move(...at(...pt), { steps: s.steps ?? 1 })
        }
        if (!s.hold) await page.mouse.up()
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

async function drive(engine: 'vega' | 'aster', c: Case): Promise<{ snaps: Snapshot[]; errors: string[]; modlog?: string[] } | { error: string }> {
  const context = await browser.newContext({ viewport: { width: 900, height: 700 }, deviceScaleFactor: 1 })
  const page = await context.newPage()
  const pageErrors: string[] = []
  page.on('pageerror', (e) => pageErrors.push(e.message.slice(0, 300)))
  try {
    await page.goto(`file://${join(OUT_DIR, 'index.html')}`)
    if (c.css) await page.addStyleTag({ content: c.css })
    await page.waitForFunction(() => '__mountVega' in window, null, { timeout: 30_000 })
    await page.evaluate(async ([which, spec]) => {
      const w = window as unknown as Record<string, (s: unknown) => Promise<void>>
      await (which === 'vega' ? w.__mountVega! : w.__mountAster!)(spec)
    }, [engine, c.spec] as const)
    if (process.env.SEL_DEBUG) console.log(engine, await page.evaluate(() => document.querySelector('#c svg path.background')!.outerHTML + (document.querySelector('#c svg .marks')?.outerHTML.slice(0, 600) ?? '')))
    const settle = (): Promise<unknown> => page.evaluate(() => (window as unknown as { __settle: () => Promise<unknown> }).__settle())
    await settle()
    if (c.wait) { await page.waitForTimeout(c.wait); await settle() }
    const snaps: Snapshot[] = [await snapshot(page, engine === 'vega' && !process.env.SEL_NOFRESH)]
    for (const s of c.steps) {
      await runStep(page, s, engine)
      await settle()
      await settle()
      snaps.push(await snapshot(page, engine === 'vega' && !process.env.SEL_NOFRESH))
    }
    if (pageErrors.length) return { error: `page errors: ${pageErrors.join(' | ')}` }
    const errors = await page.evaluate(() => (window as unknown as { __errors: string[] }).__errors)
    if (process.env.SEL_DEBUG) console.log('fresh errors', JSON.stringify(await page.evaluate(() => (window as unknown as { __freshErrors: string[] }).__freshErrors)))
    const modlog = await page.evaluate(() => (window as unknown as { __modlog?: string[] }).__modlog ?? [])
    return { snaps, errors, modlog }
  } catch (e) {
    if (process.env.SEL_DEBUG) console.log((e as Error).stack, await page.evaluate(() => JSON.stringify((window as unknown as { __errors: string[] }).__errors) + document.body.innerHTML.slice(0, 600)))
    return { error: (e as Error).message.split('\n')[0]! + (pageErrors.length ? ` [page errors: ${pageErrors.join(' | ')}]` : '') }
  } finally {
    await context.close()
  }
}

let pass = 0
const retainedSteps: string[] = []
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
    if (process.env.SEL_MOD) console.log('modlog', JSON.stringify(v.modlog ?? null))
    for (let i = 0; i < v.snaps.length; i++) {
      const label = i === 0 ? 'initial' : `step ${i - 1} (${c.steps[i - 1]!.t})`
      const vs = v.snaps[i]!
      const as = a.snaps[i]!
      for (const n of Object.keys(vs.signals)) {
        if (vs.signals[n] !== as.signals[n]) problems.push(`${label}: signal ${n}: vega=${vs.signals[n]!.slice(0, 160)} aster=${as.signals[n]!.slice(0, 160)}`)
      }
      if (vs.scoped !== as.scoped) {
        // name the first scope that has no counterpart
        const vsc = JSON.parse(vs.scoped!) as string[]
        const asc = JSON.parse(as.scoped!) as string[]
        const onlyV = vsc.find((x) => !asc.includes(x))
        const onlyA = asc.find((x) => !vsc.includes(x))
        const where = `${vsc.length} vs ${asc.length} scopes; only in vega: ${String(onlyV).slice(0, 300)}; only in aster: ${String(onlyA).slice(0, 300)}`
        problems.push(`${label}: scoped signals: ${where}`)
      }
      for (const n of Object.keys(vs.stores)) {
        if (vs.stores[n] !== as.stores[n]) problems.push(`${label}: store ${n}: vega=${vs.stores[n]!.slice(0, 200)} aster=${as.stores[n]!.slice(0, 200)}`)
      }
      if (process.env.SEL_DUMP && i === Number(process.env.SEL_DUMP_AT ?? 0)) { writeFileSync('/tmp/fix-20-vl-selections-scratch/sel-vega.svg', vs.svg); writeFileSync('/tmp/fix-20-vl-selections-scratch/sel-aster.svg', as.svg); writeFileSync('/tmp/fix-20-vl-selections-scratch/sel-vega-fresh.svg', vs.fresh ?? '') }
      const retained = canonicalizeSvg(vs.svg)
      const aster = canonicalizeSvg(as.svg)
      const diffs = diffCanonical(retained, aster)
      if (diffs.length) {
        // The documented deviation: after a signal write Aster renders the FRESH result, vega keeps its first autosize,
        // padding and tick order. Accepted only when Aster equals vega's own fresh render of the same spec at the same
        // signal and store values EXACTLY, and vega's retained render really differs from that fresh one.
        const fresh = canonicalizeSvg(vs.fresh ?? vs.svg)
        if (diffCanonical(fresh, aster).length === 0 && diffCanonical(fresh, retained).length > 0) retainedSteps.push(`${c.name} / ${label}`)
        else problems.push(`${label}: svg differs from vega's retained render (${String(diffs[0]).slice(0, 160)}) and from vega's fresh render (${String(diffCanonical(fresh, aster)[0]).slice(0, 220)})`)
      }
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
console.log(`[browser-vl-selections] retained (Aster == vega's fresh render, vega's retained render differs): ${retainedSteps.length} step(s), ceiling ${MAX_RETAINED}`)
for (const r of retainedSteps) console.log(`  retained ${r}`)
if (retainedSteps.length > MAX_RETAINED) {
  console.log(`[browser-vl-selections] RATCHET: ${retainedSteps.length} retained steps > --max-retained ${MAX_RETAINED}`)
  process.exit(1)
}
if (MIN_CASES && cases.length < MIN_CASES) {
  console.log(`[browser-vl-selections] FLOOR: ${cases.length} cases < --min-cases ${MIN_CASES}`)
  process.exit(1)
}
if (cases.length === 0) {
  console.log('[browser-vl-selections] no cases ran')
  process.exit(1)
}
process.exit(failures.length ? 1 : 0)
