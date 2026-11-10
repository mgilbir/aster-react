/**
 * A view that fits its viewport (`autosize` fit / fit-x / fit-y, and every view sized by a measured container) makes two passes per
 * evaluation: the first at the viewport finds the overflow, the second builds the content at the viewport less it. Each pass of an
 * update is made from the same pass of the evaluation before (`IncrementalState.fitFirst`), so a one-row update re-encodes a row per
 * pass instead of the whole first pass.
 *
 * What this file pins:
 *  - the scene of every update is the scene a fresh evaluation of the same inputs makes, for row edits, appends, removals, updates
 *    that move a domain, and updates and resizes that move the fitted size (the second pass then has nothing at its size to reuse);
 *  - the update is incremental in both passes: the items of the rows that did not change keep their objects, and the encode runs
 *    for the changed row only, once per pass;
 *  - an evaluation that dies after a pass updated a structure in place leaves nothing behind that a later evaluation would build on.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { compileChart } from './compiler.js'
import { evaluateChart } from './evaluate.js'
import { registerExpressionFunction } from './expression.js'
import { createChartSession } from './session.js'
import { renderSceneToSvg } from './index.js'
import type { RuntimeInput, SceneGroup, SceneItem, SceneRoot, VgSpec } from './types.js'

type Row = Record<string, unknown>
type Auto = 'fit' | 'fit-x' | 'fit-y'

// Counts the encodes of the symbol mark: its `size` reads this function once per item encoded.
let encodes = 0
let dispose: (() => void) | undefined
beforeAll(() => { dispose = registerExpressionFunction('fitIncCount', () => { encodes++; return 30 }) })
afterAll(() => dispose?.())

/** A chart with every part the passes keep: a filter and an aggregate (engine state), data-driven domains (the census), axes and a legend. */
function specOf(auto: Auto, contains?: 'padding'): VgSpec {
  return {
    width: 400, height: 240, padding: 5, autosize: contains ? { type: auto, contains } : auto,
    data: [
      { name: 't' },
      { name: 'kept', source: 't', transform: [{ type: 'filter', expr: 'datum.y >= 0' }] },
      { name: 'agg', source: 't', transform: [{ type: 'aggregate', groupby: ['c'], ops: ['count'], as: ['n'] }] },
    ],
    scales: [
      { name: 'x', type: 'linear', domain: { data: 'kept', field: 'x' }, range: 'width' },
      { name: 'y', type: 'linear', domain: { data: 'kept', field: 'y' }, range: 'height', nice: true },
      { name: 'c', type: 'ordinal', domain: { data: 't', field: 'c' }, range: 'category' },
    ],
    axes: [{ orient: 'bottom', scale: 'x' }, { orient: 'left', scale: 'y' }],
    legends: [{ fill: 'c' }],
    marks: [
      { type: 'symbol', from: { data: 'kept' }, encode: { update: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'y' }, fill: { scale: 'c', field: 'c' }, size: { signal: 'fitIncCount()' } } } },
      { type: 'text', from: { data: 'agg' }, encode: { update: { x: { value: 0 }, y: { value: 0 }, text: { field: 'n' } } } },
    ],
  } as unknown as VgSpec
}

const rowsOf = (n: number): Row[] => Array.from({ length: n }, (_, i) => ({ x: i, y: Math.round(Math.sin(i / 7) * 40 + 50), c: `k${i % 3}` }))
const fresh = (spec: VgSpec, input: RuntimeInput): SceneRoot => evaluateChart(compileChart(spec), input)
const symbols = (s: SceneRoot): SceneItem[] => (s.items.find((g) => g.role === 'mark' && g.marktype === 'symbol') as SceneGroup).items as SceneItem[]
const shape = (s: SceneRoot): string => `${s.width}x${s.height} plot ${String(s.plotWidth)}x${String(s.plotHeight)} pad ${JSON.stringify(s.padding)}`

/** The update steps: what the rows become, and the pulse that says so. */
interface Step { what: string; rows: (rs: Row[]) => Row[]; pulse: (rs: Row[], next: Row[]) => Pick<RuntimeInput, 'dataChanges' | 'dataPulse' | 'changedDatasets'>; size?: number }
const edit = (i: number, y: number): Step => ({
  what: `row ${i} -> y ${y}`,
  rows: (rs) => rs.map((r, k) => (k === i ? { ...r, y } : r)),
  pulse: () => ({ dataChanges: { t: [i] } }),
})
const STEPS: Step[] = [
  edit(3, 55),
  { what: 'append', rows: (rs) => [...rs, { x: rs.length, y: 60, c: 'k1' }], pulse: (rs, next) => ({ dataPulse: { t: { changed: [], appendOnly: true, baseLength: rs.length, added: [[rs.length, next.length]] } } }) },
  {
    what: 'remove row 5',
    rows: (rs) => rs.filter((_, k) => k !== 5),
    pulse: (rs, next) => ({ dataPulse: { t: { changed: [], from: next.map((_, k) => (k < 5 ? k : k + 1)), to: rs.map((_, k) => (k < 5 ? k : k === 5 ? -1 : k - 1)), removed: [[5, 6]] } } }),
  },
  edit(7, 95),
  // the y domain moves (and its labels get wider: the overflow, and the fitted size, move with it)
  edit(2, 123456),
  edit(2, 40),
  // a new category: the legend grows
  { what: 'new category', rows: (rs) => rs.map((r, k) => (k === 4 ? { ...r, c: 'a much longer category name' } : r)), pulse: () => ({ dataChanges: { t: [4] } }) },
  { what: 'filtered out', rows: (rs) => rs.map((r, k) => (k === 6 ? { ...r, y: -5 } : r)), pulse: () => ({ dataChanges: { t: [6] } }) },
  { what: 'named as changed', rows: (rs) => rs.map((r, k) => (k === 9 ? { ...r, y: 12 } : r)), pulse: () => ({ changedDatasets: ['t'] }) },
  { ...edit(11, 70), what: 'resized', size: 330 },
  edit(12, 71),
  { ...edit(13, 72), what: 'resized back', size: 400 },
]

describe.each([['fit'], ['fit-x'], ['fit-y']] as const)('autosize %s: every update of an incremental evaluation is a fresh evaluation', (auto) => {
  for (const contains of [undefined, 'padding'] as const) {
    it(`contains ${contains ?? 'content'}: evaluateChart on one compiled chart, and a session`, () => {
      const spec = specOf(auto, contains)
      const chart = compileChart(spec)
      const session = createChartSession()
      let rows = rowsOf(40)
      let width = 400
      const sizeOf = (w: number): RuntimeInput => ({ width: w, height: 240 })
      evaluateChart(chart, { data: { t: rows }, ...sizeOf(width) })
      session.evaluate(spec, { data: { t: rows }, ...sizeOf(width) })
      const shapes = new Set<string>()
      for (const step of STEPS) {
        const next = step.rows(rows)
        width = step.size ?? width
        const input: RuntimeInput = { data: { t: next }, ...sizeOf(width) }
        const want = fresh(spec, input)
        const inc = evaluateChart(chart, { ...input, ...step.pulse(rows, next) })
        expect(renderSceneToSvg(inc), `${auto} chart: ${step.what}`).toBe(renderSceneToSvg(want))
        expect(shape(inc), `${auto} chart: ${step.what}`).toBe(shape(want))
        const viaSession = session.evaluate(spec, input)
        expect(renderSceneToSvg(viaSession), `${auto} session: ${step.what}`).toBe(renderSceneToSvg(want))
        shapes.add(shape(want))
        rows = next
      }
      // (the steps move the fitted size: some updates had no second pass of the same size to reuse)
      expect(shapes.size).toBeGreaterThan(2)
    })
  }
})

describe('a view sized by a measured container (fit, containing the padding)', () => {
  it('updates and container resizes equal a fresh evaluation', () => {
    const spec = { ...specOf('fit'), autosize: 'pad' } as unknown as VgSpec
    const session = createChartSession()
    let rows = rowsOf(40)
    let box = { width: 420, height: 260 }
    session.evaluate(spec, { data: { t: rows }, measuredSize: box })
    for (const step of STEPS) {
      const next = step.rows(rows)
      if (step.size !== undefined) box = { width: step.size + 20, height: 260 }
      const input: RuntimeInput = { data: { t: next }, measuredSize: box }
      const inc = session.evaluate(spec, { ...input, ...step.pulse(rows, next) })
      expect(renderSceneToSvg(inc), step.what).toBe(renderSceneToSvg(fresh(spec, input)))
      rows = next
    }
  })

  it('a view the host sized, then the container sized, then the host again', () => {
    const spec = { ...specOf('fit'), autosize: 'pad' } as unknown as VgSpec
    const chart = compileChart(spec)
    let rows = rowsOf(30)
    const sizes: RuntimeInput[] = [{ width: 400, height: 240 }, { measuredSize: { width: 420, height: 260 } }, { measuredSize: { width: 420, height: 260 } }, { width: 400, height: 240 }, { measuredSize: { width: 420, height: 260 } }, { measuredSize: { width: 420, height: 260 } }]
    evaluateChart(chart, { data: { t: rows }, ...sizes[0] })
    for (const [k, size] of sizes.entries()) {
      const next = rows.map((r, i) => (i === k ? { ...r, y: 10 + k } : r))
      const input: RuntimeInput = { data: { t: next }, ...size }
      const inc = evaluateChart(chart, { ...input, dataChanges: { t: [k] } })
      expect(renderSceneToSvg(inc), `step ${k}`).toBe(renderSceneToSvg(fresh(spec, input)))
      rows = next
    }
  })
})

describe('a one-row update of a fit view is incremental in both passes', () => {
  for (const auto of ['fit', 'fit-x', 'fit-y'] as const) {
    it(`${auto}: the unchanged items keep their objects, and the changed row is encoded once per pass`, () => {
      const spec = specOf(auto)
      const chart = compileChart(spec)
      let rows = rowsOf(200)
      const size = { width: 400, height: 240 }
      evaluateChart(chart, { data: { t: rows }, ...size })
      // (the first update after a fresh evaluation finds the state both passes left)
      let prev = evaluateChart(chart, { data: { t: rows = rows.map((r, i) => (i === 1 ? { ...r, y: 51 } : r)) }, ...size, dataChanges: { t: [1] } })
      for (const i of [10, 50, 150]) {
        // (inside the y domain, so neither the scales nor the overflow move: both passes have their own size of before to reuse)
        const next = rows.map((r, k) => (k === i ? { ...r, y: 50 + (i % 3) } : r))
        const before = symbols(prev).slice()
        encodes = 0
        const inc = evaluateChart(chart, { data: { t: next }, ...size, dataChanges: { t: [i] } })
        // one encode in the first pass, one in the second (a pass that re-encoded every row would count 200)
        expect(encodes, `row ${i}`).toBe(2)
        const after = symbols(inc)
        expect(after.length).toBe(before.length)
        for (let k = 0; k < after.length; k++) {
          if (k === i) expect(after[k], `row ${i}`).not.toBe(before[k])
          else if (after[k] !== before[k]) throw new Error(`${auto}: item ${k} was made again for an update of row ${i}`)
        }
        expect((after[i] as { __gen?: number }).__gen).toBeGreaterThan((after[i === 0 ? 1 : 0] as { __gen?: number }).__gen!)
        expect(renderSceneToSvg(inc)).toBe(renderSceneToSvg(fresh(spec, { data: { t: next }, ...size })))
        prev = inc
        rows = next
      }
    })
  }

  it('a dataset named as changed (no pulse): the second pass keeps the marks that do not read it', () => {
    const base = specOf('fit') as unknown as { data: unknown[]; marks: unknown[] }
    const spec = {
      ...base,
      data: [...base.data, { name: 'u' }],
      marks: [...base.marks, { type: 'rule', from: { data: 'u' }, encode: { update: { x: { value: 0 }, x2: { field: 'w' }, y: { value: 1 } } } }],
    } as unknown as VgSpec
    const chart = compileChart(spec)
    const rows = rowsOf(100)
    const size = { width: 400, height: 240 }
    evaluateChart(chart, { data: { t: rows, u: [{ w: 5 }] }, ...size })
    const a = evaluateChart(chart, { data: { t: rows, u: [{ w: 6 }] }, ...size, changedDatasets: ['u'] })
    encodes = 0
    const input = { data: { t: rows, u: [{ w: 7 }] }, ...size }
    const b = evaluateChart(chart, { ...input, changedDatasets: ['u'] })
    const encoded = encodes
    expect(renderSceneToSvg(b)).toBe(renderSceneToSvg(fresh(spec, input)))
    // (the symbols read `t` only: the group is the previous scene's, and neither pass encoded a symbol)
    expect(b.items.find((g) => g.role === 'mark' && g.marktype === 'symbol')).toBe(a.items.find((g) => g.role === 'mark' && g.marktype === 'symbol'))
    expect(encoded).toBe(0)
  })
})

describe('the two passes share what they kept, and update it once', () => {
  it('a view that turns into a fit view keeps the same steps in both passes; the next pulses update them in one pass only', () => {
    // The first evaluation sizes the view itself (one pass). The next fits a measured container over the same rows: neither pass has
    // a state of its own size, so both keep the dataset's steps (they do not read the size) from the one committed state, and the two
    // states this evaluation leaves hold the same step state. The edits and appends after it are taken by both passes. (The claim by
    // identity keeps the second from updating in place what the first did; the engine's own length checks refuse a second append too,
    // so this pins the result, not which of the two guards held.)
    const spec = {
      width: 400, height: 240, padding: 5, autosize: 'pad',
      data: [{ name: 't', transform: [
        { type: 'filter', expr: 'datum.y >= 10' },
        { type: 'aggregate', groupby: ['c'], ops: ['count', 'sum'], fields: [null, 'y'], as: ['n', 's'] },
        { type: 'collect', sort: { field: 'c' } },
      ] }],
      scales: [
        { name: 'x', type: 'band', domain: { data: 't', field: 'c' }, range: 'width' },
        { name: 'y', type: 'linear', domain: { data: 't', field: 's' }, range: 'height' },
      ],
      axes: [{ orient: 'bottom', scale: 'x' }, { orient: 'left', scale: 'y' }],
      marks: [{ type: 'rect', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'c' }, width: { scale: 'x', band: 1 }, y: { scale: 'y', field: 's' }, y2: { scale: 'y', value: 0 } } } }],
    } as unknown as VgSpec
    const session = createChartSession()
    let rows: Row[] = Array.from({ length: 30 }, (_, i) => ({ c: `g${i % 4}`, y: (i * 7) % 40 }))
    const box = { measuredSize: { width: 420, height: 260 } }
    session.evaluate(spec, { data: { t: rows }, width: 400, height: 240 })
    session.evaluate(spec, { data: { t: rows }, ...box })
    for (let k = 0; k < 8; k++) {
      // edits that keep each group (the aggregate updates its sums in place) and appends
      rows = k % 2 === 0 ? rows.map((r, i) => (i === 3 + k ? { ...r, y: (r.y as number) + 11 } : r)) : [...rows, { c: `g${k % 3}`, y: 20 + k }]
      const input: RuntimeInput = { data: { t: rows }, ...box }
      const inc = session.evaluate(spec, input)
      expect(renderSceneToSvg(inc), `update ${k}`).toBe(renderSceneToSvg(fresh(spec, input)))
    }
  })
})

describe('an evaluation that dies after a pass updated a structure in place', () => {
  it('the next update is made from the last evaluation that committed, not from the half-updated state', () => {
    // The formula refuses a row (a limit violation inside the expression, which is thrown, not logged) after the first pass took the
    // pulse in place; the next update starts again from the state the last good evaluation left.
    const spec = {
      ...specOf('fit'),
      data: [{ name: 't', transform: [{ type: 'formula', expr: 'datum.obj ? datum.obj.deep : length(sequence(0, 1e9))', as: 'y' }] }],
      scales: [
        { name: 'x', type: 'linear', domain: { data: 't', field: 'x' }, range: 'width' },
        { name: 'y', type: 'linear', domain: { data: 't', field: 'y' }, range: 'height', zero: false },
        { name: 'c', type: 'ordinal', domain: { data: 't', field: 'c' }, range: 'category' },
      ],
      marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'y' }, size: { value: 30 } } } }],
    } as unknown as VgSpec
    const chart = compileChart(spec)
    const row = (x: number, deep: number): Row => ({ x, c: 'k', obj: { deep } })
    const size = { width: 400, height: 240 }
    const a = [row(0, 10), row(1, 20)]
    evaluateChart(chart, { data: { t: a }, ...size })
    evaluateChart(chart, { data: { t: [row(0, 11), row(1, 20)] }, ...size, dataChanges: { t: [0] } })
    const good = [row(0, 11), row(1, 20)]
    const bad = [row(0, 99), row(1, 20), { x: 2, c: 'k', obj: undefined }]
    expect(() => evaluateChart(chart, { data: { t: bad }, ...size, limits: { maxRows: 1000 }, dataPulse: { t: { changed: [0], appendOnly: true, baseLength: 2, added: [[2, 3]] } } })).toThrow()
    const next = [...good, row(2, 30)]
    const inc = evaluateChart(chart, { data: { t: next }, ...size, dataPulse: { t: { changed: [], appendOnly: true, baseLength: 2, added: [[2, 3]] } } })
    expect(renderSceneToSvg(inc)).toBe(renderSceneToSvg(fresh(spec, { data: { t: next }, ...size })))
  })
})
