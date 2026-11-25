// @vitest-environment jsdom
/**
 * What vega's tuples carry from one run to the next (C68): a dataset whose steps read a field that a step at or after them writes
 * -- vega/reorderable-matrix: `score` reads `order`, which the `window` after it writes -- reads, after a signal change, what the run
 * before left on the tuple. Dragging a label of the matrix reorders it, and on release the new order stays.
 *
 * Driven through the event loops with the same native events: a vega View (svg renderer, in this document) and `<Chart renderer="svg">`
 * are given the same pointerdown on a label, pointermoves and a pointerup on the window, and after each event every label of both
 * must be at the same place with the same fill. The official example (its data inline: vega-datasets' miserables), and a generated
 * family of drag-to-reorder specs: the order's first value (a field, its negation, the row's index), the steps between (a formula
 * that reads the order, a `collect` sorted by it, a `bin` of it, a formula with `initonly`), the window's op and sort direction,
 * dragging along x or y, drags with and without moves.
 *
 *   ASTER_HISTORY_SEEDS=60   (default 24)
 */
import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as vega from 'vega'
import * as React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { Chart } from '@aster-charts/react'
// (the matrix's `cross` and `lookup`: loaded before the chart renders, so it does not suspend)
import '@aster-charts/core/transforms'

type Spec = Record<string, unknown>
type Rnd = () => number
interface VItem { x?: number; y?: number; datum?: Record<string, unknown>; fill?: string; text?: string; _svg?: Element; mark: { name?: string; marktype: string }; items?: VItem[] }
type VegaView = { initialize(el: Element): VegaView; hover(): VegaView; runAsync(): Promise<unknown>; scenegraph(): { root: VItem }; origin(): [number, number]; finalize(): void }

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const cleanups: Array<() => void> = []
afterEach(() => { while (cleanups.length) cleanups.pop()!(); document.body.innerHTML = '' })

function mulberry32(seed: number): Rnd {
  let a = seed | 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const pick = <T,>(r: Rnd, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!
const int = (r: Rnd, lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1))

// ---------------------------------------------------------------------------
// The specs
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url))
const miserables = JSON.parse(readFileSync(join(HERE, '..', 'node_modules', 'vega-datasets', 'data', 'miserables.json'), 'utf8')) as { nodes: unknown[]; links: unknown[] }

/** vega's reorderable-matrix example (vega/docs/examples/reorderable-matrix.vg.json), its two url datasets given inline. */
const MATRIX: Spec = {
  width: 770, height: 770, padding: 2,
  signals: [
    { name: 'cellSize', value: 10 },
    { name: 'count', update: "length(data('nodes'))" },
    { name: 'width', update: "span(range('position'))" },
    { name: 'height', update: 'width' },
    { name: 'src', value: {}, on: [{ events: 'text:pointerdown', update: 'datum' }, { events: 'window:pointerup', update: '{}' }] },
    { name: 'dest', value: -1, on: [
      { events: '[@columns:pointerdown, window:pointerup] > window:pointermove', update: 'src.name && datum !== src ? (0.5 + count * clamp(x(), 0, width) / width) : dest' },
      { events: '[@rows:pointerdown, window:pointerup] > window:pointermove', update: 'src.name && datum !== src ? (0.5 + count * clamp(y(), 0, height) / height) : dest' },
      { events: 'window:pointerup', update: '-1' },
    ] },
  ],
  data: [
    { name: 'nodes', values: miserables.nodes, transform: [
      { type: 'formula', as: 'order', expr: 'datum.group' },
      { type: 'formula', as: 'score', expr: 'dest >= 0 && datum === src ? dest : datum.order' },
      { type: 'window', sort: { field: 'score' }, ops: ['row_number'], as: ['order'] },
    ] },
    { name: 'edges', values: miserables.links, transform: [
      { type: 'lookup', from: 'nodes', key: 'index', fields: ['source', 'target'], as: ['sourceNode', 'targetNode'] },
      { type: 'formula', as: 'group', expr: 'datum.sourceNode.group === datum.targetNode.group ? datum.sourceNode.group : count' },
    ] },
    { name: 'cross', source: 'nodes', transform: [{ type: 'cross' }] },
  ],
  scales: [
    { name: 'position', type: 'band', domain: { data: 'nodes', field: 'order', sort: true }, range: { step: { signal: 'cellSize' } } },
    { name: 'color', type: 'ordinal', range: 'category', domain: { fields: [{ data: 'nodes', field: 'group' }, { signal: 'count' }], sort: true } },
  ],
  marks: [
    { type: 'rect', from: { data: 'cross' }, encode: { update: {
      x: { scale: 'position', field: 'a.order' }, y: { scale: 'position', field: 'b.order' },
      width: { scale: 'position', band: 1, offset: -1 }, height: { scale: 'position', band: 1, offset: -1 },
      fill: [{ test: 'datum.a === src || datum.b === src', value: '#ddd' }, { value: '#f5f5f5' }],
    } } },
    { type: 'rect', from: { data: 'edges' }, encode: { update: {
      x: { scale: 'position', field: 'sourceNode.order' }, y: { scale: 'position', field: 'targetNode.order' },
      width: { scale: 'position', band: 1, offset: -1 }, height: { scale: 'position', band: 1, offset: -1 }, fill: { scale: 'color', field: 'group' },
    } } },
    { type: 'rect', from: { data: 'edges' }, encode: { update: {
      x: { scale: 'position', field: 'targetNode.order' }, y: { scale: 'position', field: 'sourceNode.order' },
      width: { scale: 'position', band: 1, offset: -1 }, height: { scale: 'position', band: 1, offset: -1 }, fill: { scale: 'color', field: 'group' },
    } } },
    { type: 'text', name: 'columns', from: { data: 'nodes' }, encode: { update: {
      x: { scale: 'position', field: 'order', band: 0.5 }, y: { offset: -2 }, text: { field: 'name' }, fontSize: { value: 10 }, angle: { value: -90 },
      align: { value: 'left' }, baseline: { value: 'middle' }, fill: [{ test: 'datum === src', value: 'steelblue' }, { value: 'black' }],
    } } },
    { type: 'text', name: 'rows', from: { data: 'nodes' }, encode: { update: {
      x: { offset: -2 }, y: { scale: 'position', field: 'order', band: 0.5 }, text: { field: 'name' }, fontSize: { value: 10 },
      align: { value: 'right' }, baseline: { value: 'middle' }, fill: [{ test: 'datum === src', value: 'steelblue' }, { value: 'black' }],
    } } },
  ],
}

/** A drag of a label (`label`: which, `moves`: where to), or a press and release on empty space (`empty`). */
interface Gesture { mark: 'rows' | 'columns'; label: number; moves: number[]; empty?: boolean }
interface Case { id: string; spec: Spec; gestures: Gesture[] }

/** A drag-to-reorder spec: labels along one axis, ordered by a window over a score that reads the order the window wrote. */
function generate(seed: number): Case {
  const r = mulberry32(seed * 7717)
  const n = int(r, 4, 9)
  const values = Array.from({ length: n }, (_, i) => ({ name: `n${i}`, group: int(r, 0, 4), w: int(r, 0, 20) }))
  const first = pick(r, ['datum.group', '-datum.w', 'datum.w + datum.group / 10', 'datum.name'])
  const axis = pick(r, ['rows', 'columns'] as const)
  const op = pick(r, ['row_number', 'rank', 'dense_rank'])
  const order = pick(r, ['ascending', 'descending'])
  const transform: Spec[] = [{ type: 'formula', as: 'order', expr: first }]
  // (steps between that read or are read by the order, as the family's variations)
  const twice = r() < 0.35
  if (twice) transform.push({ type: 'formula', as: 'twice', expr: 'datum.order * 2', ...(r() < 0.5 ? { initonly: true } : {}) })
  // (the score reads the order, or what a formula made of it: one that runs once per tuple keeps the first order)
  transform.push({ type: 'formula', as: 'score', expr: `dest >= 0 && datum === src ? dest : ${twice && r() < 0.6 ? 'datum.twice / 2' : 'datum.order'}` })
  transform.push({ type: 'window', sort: { field: 'score', order }, ops: [op], as: ['order'] })
  if (r() < 0.3) transform.push({ type: 'collect', sort: { field: 'order' } })
  if (r() < 0.3) transform.push({ type: 'bin', field: 'order', extent: [0, 20], step: 2, as: ['b0', 'b1'] })
  // (a formula of the order the window wrote, which the label's place across the axis shows: one with `initonly` keeps the first)
  const after = r() < 0.4
  if (after) transform.push({ type: 'formula', as: 'shift', expr: 'datum.order * 3 % 7', ...(r() < 0.5 ? { initonly: true } : {}) })
  const across = after ? { signal: '30 + datum.shift' } : { value: 30 }
  const along = axis === 'rows' ? 'y' : 'x'
  const label: Spec = axis === 'rows'
    ? { x: across, y: { scale: 'position', field: 'order', band: 0.5 }, align: { value: 'right' } }
    : { x: { scale: 'position', field: 'order', band: 0.5 }, y: across, align: { value: 'center' } }
  const spec: Spec = {
    width: 200, height: 200, padding: 4, autosize: 'none',
    signals: [
      { name: 'count', update: "length(data('nodes'))" },
      { name: 'src', value: {}, on: [{ events: 'text:pointerdown', update: 'datum' }, { events: 'window:pointerup', update: '{}' }] },
      { name: 'dest', value: -1, on: [
        { events: `[@${axis}:pointerdown, window:pointerup] > window:pointermove`, update: `src.name && datum !== src ? (0.5 + count * clamp(${along}(), 0, 200) / 200) : dest` },
        { events: 'window:pointerup', update: '-1' },
      ] },
    ],
    data: [{ name: 'nodes', values, transform }],
    scales: [{ name: 'position', type: 'band', domain: { data: 'nodes', field: 'order', sort: true }, range: [0, 200] }],
    marks: [{ type: 'text', name: axis, from: { data: 'nodes' }, encode: { update: {
      ...label, text: { field: 'name' }, fontSize: { value: 12 }, baseline: { value: 'middle' },
      fill: [{ test: 'datum === src', value: 'steelblue' }, { value: 'black' }],
    } } }],
  }
  // (a press on empty space and its release: the release sets `src` to a new `{}`, which vega's dataflow takes for a change)
  const gestures: Gesture[] = Array.from({ length: int(r, 2, 4) }, () => ({ mark: axis, label: int(r, 0, n - 1), moves: Array.from({ length: int(r, 0, 3) }, () => int(r, 2, 198)), ...(r() < 0.25 ? { empty: true } : {}) }))
  return { id: `seed ${seed} (${first}; ${transform.map((t) => t.type).join(' ')}; ${op} ${order}; ${axis})`, spec, gestures }
}

// ---------------------------------------------------------------------------
// The two event loops
// ---------------------------------------------------------------------------

interface Label { text: string; x: number; y: number; fill: string }

/** The labels a scene draws (vega's scenegraph), by text. */
function vegaLabels(root: VItem, marks: readonly string[]): Map<string, Label> {
  const out = new Map<string, Label>()
  const walk = (n: VItem): void => {
    if (n.mark?.marktype === 'text' && marks.includes(n.mark.name ?? '')) out.set(`${n.mark.name}:${n.text}`, { text: String(n.text), x: round(n.x), y: round(n.y), fill: String(n.fill) })
    for (const c of n.items ?? []) walk(c)
  }
  walk(root)
  return out
}

/** The labels an SVG draws, read off the elements (the group marks carry each mark's name in their class): vega's renderer's or Aster's. */
function asterLabels(host: Element, marks: readonly string[]): Map<string, Label> {
  const out = new Map<string, Label>()
  for (const name of marks) {
    for (const t of host.querySelectorAll(`g.mark-text.role-mark.${name} text`)) {
      const m = /translate\(([-\d.e]+),\s*([-\d.e]+)\)/.exec(t.getAttribute('transform') ?? '')
      out.set(`${name}:${t.textContent}`, { text: t.textContent ?? '', x: round(m ? Number(m[1]) : NaN), y: round(m ? Number(m[2]) : NaN), fill: t.getAttribute('fill') ?? '' })
    }
  }
  return out
}
const round = (v: unknown): number => Math.round(Number(v ?? 0) * 100) / 100

async function drive(spec: Spec, gestures: readonly Gesture[], marks: readonly string[]): Promise<{ steps: number; diffs: string[]; moved: boolean }> {
  const quiet = { error: console.error, warn: console.warn }
  console.error = () => {}
  console.warn = () => {}
  cleanups.push(() => { console.error = quiet.error; console.warn = quiet.warn })
  const vegaHost = document.createElement('div')
  const asterHost = document.createElement('div')
  document.body.append(vegaHost, asterHost)
  const view = new (vega as unknown as { View: new (rt: unknown, o: unknown) => VegaView }).View(vega.parse(structuredClone(spec) as never), { renderer: 'svg' }).initialize(vegaHost).hover()
  cleanups.push(() => view.finalize())
  await view.runAsync()
  const root = createRoot(asterHost)
  cleanups.push(() => act(() => root.unmount()))
  act(() => { root.render(React.createElement(Chart as never, { spec: structuredClone(spec), renderer: 'svg' })) })
  const container = asterHost.firstElementChild as HTMLElement
  const svgSize = (): DOMRect => {
    const svg = asterHost.querySelector('svg')!
    const w = Number(svg.getAttribute('width')), h = Number(svg.getAttribute('height'))
    return { left: 0, top: 0, right: w, bottom: h, width: w, height: h, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
  }
  container.getBoundingClientRect = svgSize
  // (where the view's origin is on the page: its padding, and what autosize `pad` added for marks past the plot, as the label column)
  const [ox, oy] = view.origin()
  const diffs: string[] = []
  let steps = 0
  let moved = false
  const first = [...asterLabels(vegaHost, marks).values()].map((l) => `${l.x},${l.y}`).join(' ')
  const compare = (what: string): void => {
    steps++
    // (both renderers' SVG, read the same way: the elements a page shows)
    const v = asterLabels(vegaHost, marks)
    const a = asterLabels(asterHost, marks)
    const bad = [...v].filter(([k, l]) => { const o = a.get(k); return o === undefined || o.x !== l.x || o.y !== l.y || o.fill !== l.fill })
    if (bad.length || a.size !== v.size) diffs.push(`${what}: ${bad.slice(0, 3).map(([k, l]) => `${k} vega ${l.x},${l.y} ${l.fill} aster ${a.get(k) ? `${a.get(k)!.x},${a.get(k)!.y} ${a.get(k)!.fill}` : 'none'}`).join('; ')} (${a.size}/${v.size} labels)`)
  }
  const pointer = (type: string, target: EventTarget, x: number, y: number): void => {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1 }))
  }
  compare('first render')
  for (const g of gestures) {
    if (g.empty) {
      // (a corner of the view no label reaches)
      const [x, y] = [ox + 199, oy + 199]
      pointer('pointerdown', vegaHost.querySelector('svg')!, x, y)
      await view.runAsync()
      act(() => { pointer('pointerdown', container.querySelector('svg') ?? container, x, y) })
      compare('down on empty space')
      act(() => { pointer('pointerup', window, x, y) })
      await view.runAsync()
      compare('release on empty space')
      continue
    }
    // the label's item in vega (the element a browser makes the event's target) and where it is, which is where Aster's is
    const items: VItem[] = []
    const walk = (n: VItem): void => { if (n.mark?.marktype === 'text' && n.mark.name === g.mark) items.push(n); for (const c of n.items ?? []) walk(c) }
    walk(view.scenegraph().root)
    // (a label no other label lies on: where two do -- tied ranks -- the item under the pointer is a renderer's choice, not the
    // dataflow's; the next one in turn when the one asked for is such)
    const labels = vegaLabels(view.scenegraph().root, [g.mark])
    const alone = (i: VItem): boolean => [...labels.values()].filter((l) => l.x === round(i.x) && l.y === round(i.y)).length === 1
    const sorted = items.slice().sort((a, b) => String(a.text).localeCompare(String(b.text)))
    const it = Array.from({ length: sorted.length }, (_, k) => sorted[(g.label + k) % sorted.length]!).find(alone)
    if (it === undefined) continue
    // (a point inside the label: the anchor, nudged into the glyphs by its alignment)
    const anchor = labels.get(`${g.mark}:${it.text}`)!
    const px = ox + anchor.x + (g.mark === 'rows' ? -3 : 0)
    const py = oy + anchor.y + (g.mark === 'columns' ? -1 : 0)
    // the press: on the label's element in vega (a browser's target), at its place on Aster's chart
    pointer('pointerdown', it._svg!, px, py)
    await view.runAsync()
    act(() => { pointer('pointerdown', container.querySelector('svg') ?? container, px, py) })
    compare(`down on ${it.text}`)
    // the moves and the release: on the window, which both event loops listen to -- one event each
    for (const m of g.moves) {
      const [x, y] = g.mark === 'rows' ? [px, oy + m] : [ox + m, py]
      act(() => { pointer('pointermove', window, x, y) })
      await view.runAsync()
      compare(`move ${it.text} to ${m}`)
    }
    act(() => { pointer('pointerup', window, px, py) })
    await view.runAsync()
    compare(`release ${it.text}`)
  }
  moved = [...asterLabels(vegaHost, marks).values()].map((l) => `${l.x},${l.y}`).join(' ') !== first
  return { steps, diffs, moved }
}

describe('what vega\'s tuples carry from the run before (C68), through the event loops', () => {
  it('vega/reorderable-matrix: a dragged label highlights, moves, and keeps its new place on release', { timeout: 120_000 }, async () => {
    const out = await drive(MATRIX, [
      { mark: 'rows', label: 11, moves: [300, 520, 610] },
      { mark: 'columns', label: 40, moves: [40, 90] },
      { mark: 'rows', label: 3, moves: [] },
      { mark: 'rows', label: 60, moves: [700] },
    ], ['rows', 'columns'])
    expect(out.diffs).toEqual([])
    // (not vacuous: the drags reorder the matrix in vega, and the order stays after the releases)
    expect(out.moved).toBe(true)
  })

  const SEEDS = Number(process.env.ASTER_HISTORY_SEEDS ?? 24)
  it(`${SEEDS} generated drag-to-reorder specs`, { timeout: 300_000 }, async () => {
    const fails: string[] = []
    let moved = 0
    for (let seed = 1; seed <= SEEDS; seed++) {
      const c = generate(seed)
      const out = await drive(c.spec, c.gestures, [String((c.spec.marks as Spec[])[0]!.name)])
      if (out.moved) moved++
      if (out.diffs.length) fails.push(`${c.id}: ${out.diffs[0]}`)
      while (cleanups.length) cleanups.pop()!()
      document.body.innerHTML = ''
    }
    expect(fails).toEqual([])
    expect(moved).toBeGreaterThan(SEEDS / 2)
  })
})
