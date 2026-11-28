import { describe, it, expect } from 'vitest'
import { compileChart, datasetsOfScene, evaluateChart, renderSceneToSvg, type VgSpec } from './index.js'
import { createChartSession } from './session.js'
import { diffRows } from './pulse.js'

const spec = {
  width: 200, height: 100, padding: 0, autosize: 'none',
  data: [{ name: 't', values: [{ g: 'a', v: 1 }, { g: 'b', v: 2 }, { g: 'c', v: 3 }] }],
  scales: [
    { name: 'x', type: 'band', domain: { data: 't', field: 'g' }, range: [0, 200] },
    { name: 'y', type: 'linear', domain: [0, 4], range: [100, 0] },
  ],
  marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: {
    x: { scale: 'x', field: 'g', band: 0.5 }, y: { scale: 'y', field: 'v' }, size: { value: 40 },
  } } }],
} as unknown as VgSpec

describe('pulse graph', () => {
  it('diffs same-length arrays and marks changed rows', () => {
    const d = diffRows([{ a: 1 }, { a: 2 }], [{ a: 1 }, { a: 3 }])
    expect(d).toEqual({ changed: [1], sameLength: true, added: null, removed: null })
    expect(diffRows([{ a: 1 }], [{ a: 2 }, { a: 3 }])?.sameLength).toBe(false)
  })

  it('the structural pulse graph is not public: it never was the engine\'s dataflow (C283)', async () => {
    const core = await import('./index.js') as Record<string, unknown>
    for (const name of ['buildPulseGraph', 'propagatePulse', 'transformNeedsFullRederive']) expect(name in core, name).toBe(false)
  })
})

describe('session auto changes', () => {
  it('reuses unchanged items when an immutable data array is replaced without dataChanges', () => {
    const session = createChartSession()
    const first = [{ g: 'a', v: 1 }, { g: 'b', v: 2 }, { g: 'c', v: 3 }]
    const sceneA = session.evaluate(spec, { data: { t: first } })
    const itemsA = [...(sceneA.items[0]!.items as unknown[])]
    const next = [{ g: 'a', v: 1 }, { g: 'b', v: 9 }, { g: 'c', v: 3 }]
    const sceneB = session.evaluate(spec, { data: { t: next } })
    const itemsB = sceneB.items[0]!.items as unknown[]
    expect(itemsB[0]).toBe(itemsA[0])
    expect(itemsB[1]).not.toBe(itemsA[1])
    expect(itemsB[2]).toBe(itemsA[2])
    expect(session.pulse()?.datasets.get('t')?.changed).toEqual([1])
  })

  it('treats structurally equal replacement arrays as a no-op', () => {
    const session = createChartSession()
    const a = session.evaluate(spec, { data: { t: [{ g: 'a', v: 1 }, { g: 'b', v: 2 }, { g: 'c', v: 3 }] } })
    const b = session.evaluate(spec, { data: { t: [{ g: 'a', v: 1 }, { g: 'b', v: 2 }, { g: 'c', v: 3 }] } })
    expect(b).toBe(a)
    expect(session.pulse()?.datasets.size).toBe(0)
  })

  it('reports appends as a structural pulse', () => {
    const session = createChartSession()
    session.evaluate(spec, { data: { t: [{ g: 'a', v: 1 }, { g: 'b', v: 2 }] } })
    session.evaluate(spec, { data: { t: [{ g: 'a', v: 1 }, { g: 'b', v: 2 }, { g: 'c', v: 3 }] } })
    const pulse = session.pulse()
    expect(pulse?.structural.has('t')).toBe(true)
    expect(pulse?.datasets.get('t')?.added).toEqual([2, 3])
  })

  it('can opt out of auto diffing', () => {
    const session = createChartSession()
    session.evaluate(spec, { data: { t: [{ g: 'a', v: 1 }] } })
    const a = session.evaluate(spec, { data: { t: [{ g: 'a', v: 1 }, { g: 'b', v: 2 }] }, autoChanges: false })
    const b = session.evaluate(spec, { data: { t: [{ g: 'a', v: 1 }, { g: 'b', v: 2 }] }, autoChanges: false })
    expect(a).not.toBe(b)
    expect(session.pulse()?.structural.size).toBe(0)
  })
})

describe('sorted grouped transforms', () => {
  // The transforms whose output depends on the ORDER of a group (a window rank, a sorted stack): an evaluation told which rows
  // changed must write the same values as a chart compiled afresh and evaluated from scratch. The values are compared on the
  // rows, not on a rendering (a mark that does not encode the window's or the stack's output would show nothing), over generated
  // changes that move a row past others in its group (C456).
  const transforms = {
    'window rank': [{ type: 'window', groupby: ['g'], sort: { field: 'v', order: 'descending' }, ops: ['rank', 'row_number'], as: ['r', 'n'] }],
    'stack sorted': [{ type: 'stack', groupby: ['g'], field: 'v', sort: { field: 'v' }, as: ['y0', 'y1'] }],
    'stack, then window over its output': [
      { type: 'stack', groupby: ['g'], field: 'v', sort: { field: ['v'], order: ['descending'] }, as: ['y0', 'y1'] },
      { type: 'window', groupby: ['g'], sort: { field: 'y0' }, ops: ['rank'], as: ['r'] },
    ],
  }
  const specOf = (transform: unknown): VgSpec => ({
    width: 200, height: 100, padding: 0, autosize: 'none',
    data: [{ name: 't', transform }],
    scales: [{ name: 'y', type: 'linear', domain: [0, 30], range: [100, 0] }],
    marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { value: 50 }, y: { scale: 'y', field: 'v' }, size: { value: 30 } } } }],
  } as unknown as VgSpec)
  const rowsOf = (scene: ReturnType<typeof evaluateChart>): unknown => datasetsOfScene(scene).get('t')

  for (const [name, transform] of Object.entries(transforms)) {
    it(`${name}: an incremental evaluation writes what a fresh one writes, over generated changes`, () => {
      let seed = 7
      const random = (): number => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646
      let swapped = 0
      for (let trial = 0; trial < 60; trial++) {
        const spec = specOf(transform)
        const chart = compileChart(spec)
        const rows = Array.from({ length: 8 }, (_, i) => ({ g: 'ab'[i % 2]!, v: 1 + Math.floor(random() * 20) }))
        evaluateChart(chart, { data: { t: rows } })
        const changed = [Math.floor(random() * rows.length)]
        if (random() < 0.5) changed.push((changed[0]! + 1 + Math.floor(random() * (rows.length - 1))) % rows.length)
        const next = rows.map((r, i) => (changed.includes(i) ? { ...r, v: 1 + Math.floor(random() * 20) } : r))
        const before = rowsOf(evaluateChart(compileChart(spec), { data: { t: rows } }))
        const inc = rowsOf(evaluateChart(chart, { data: { t: next }, dataChanges: { t: changed } }))
        const fresh = rowsOf(evaluateChart(compileChart(spec), { data: { t: next } }))
        expect(inc, `trial ${trial}: ${JSON.stringify(rows)} -> ${JSON.stringify(next)}`).toEqual(fresh)
        if (JSON.stringify(before) !== JSON.stringify(fresh)) swapped++
      }
      // the changes did move the transform's output (ranks or stack offsets), most of the time
      expect(swapped).toBeGreaterThan(40)
    })
  }
})

describe('a row diff sees values as the scene does', () => {
  it('tells 0 from -0, nested ones too, and Infinity from null; NaN is NaN and two Dates of one instant are one value', () => {
    const changed = (a: unknown, b: unknown): number[] => diffRows([{ v: a }], [{ v: b }])!.changed
    expect(changed(0, -0)).toEqual([0])
    expect(changed(-0, 0)).toEqual([0])
    expect(changed([0], [-0])).toEqual([0])
    expect(changed({ p: [Infinity] }, { p: [null] })).toEqual([0])
    expect(changed(new Map([[1, 2]]), new Map())).toEqual([0])
    expect(changed(NaN, NaN)).toEqual([])
    expect(changed([NaN, { q: 'x' }], [NaN, { q: 'x' }])).toEqual([])
    expect(changed(new Date(5), new Date(5))).toEqual([])
    expect(changed(new Date(5), new Date(6))).toEqual([0])
  })

  it('a session that is not told what changed draws a value turned from 0 into -0 as a fresh evaluation does', () => {
    const shown = {
      width: 100, height: 50, padding: 0, autosize: 'none',
      data: [{ name: 't' }],
      scales: [{ name: 'c', type: 'ordinal', domain: { data: 't', field: 'v' }, range: 'category' }],
      legends: [{ fill: 'c' }],
      marks: [{ type: 'text', from: { data: 't' }, encode: { update: { text: { signal: "format(datum.v, '+')" }, fill: { scale: 'c', field: 'v' } } } }],
    } as unknown as VgSpec
    const session = createChartSession()
    session.evaluate(shown, { data: { t: [{ v: 0 }, { v: 2 }] } })
    const input = { data: { t: [{ v: -0 }, { v: 2 }] } }
    expect(renderSceneToSvg(session.evaluate(shown, input))).toBe(renderSceneToSvg(evaluateChart(compileChart(shown), input)))
  })
  it('a mark kept for its rows after a signal change sees a value turned from 0 into -0', () => {
    // (the signal `k` moves the formula's output from 0 to -0; the mark reads no signal, only the rows, which it compares with its items)
    const signed = {
      width: 100, height: 50, padding: 0, autosize: 'none',
      signals: [{ name: 'k', value: 1 }],
      data: [{ name: 't' }, { name: 'd', source: 't', transform: [{ type: 'formula', as: 'w', expr: 'datum.v * k' }] }],
      marks: [{ type: 'text', from: { data: 'd' }, encode: { update: { text: { signal: "format(datum.w, '+')" } } } }],
    } as unknown as VgSpec
    const session = createChartSession()
    const rows = [{ v: 0 }]
    session.evaluate(signed, { data: { t: rows }, signals: { k: 1 } })
    const input = { data: { t: rows }, signals: { k: -1 } }
    expect(renderSceneToSvg(session.evaluate(signed, input))).toBe(renderSceneToSvg(evaluateChart(compileChart(signed), input)))
  })
})

describe('a dataset with a row that is not an object is not diffed, wherever the row is (C122)', () => {
  const o = (v: number): Record<string, number> => ({ v })
  // each shape of diffRows looks at every row through one of its loops: the same-length one, the prefix, the suffix, the paired
  // middle, the added rows, the removed ones. A primitive (or null) in any of those places refuses the diff.
  const cases: Array<[string, unknown[], unknown[]]> = [
    ['same length, in the previous', [o(1), 2, o(3)], [o(1), o(2), o(3)]],
    ['same length, in the next', [o(1), o(2), o(3)], [o(1), 'x', o(3)]],
    ['same length, null', [o(1), o(2)], [o(1), null]],
    ['in the common prefix, changed', [3, o(1), o(2)], [4, o(1), o(2), o(3)]],
    ['in the common suffix, changed', [o(1), o(2), 5], [o(0), o(1), o(2), 6]],
    ['in a paired middle row', [o(1), o(2), o(9)], [o(1), true, o(3), o(9)]],
    ['in an added row', [o(1), o(2)], [o(1), o(2), 7]],
    ['in an added row, in the middle', [o(1), o(9)], [o(1), 7, o(9)]],
    ['in a removed row', [o(1), 7, o(9)], [o(1), o(9)]],
  ]
  for (const [name, a, b] of cases) {
    it(name, () => {
      expect(diffRows(a, b)).toBeNull()
    })
  }
  it('the same primitive at the same index is the same row; 0 and -0 are not looked at as equal', () => {
    // (a primitive row that is identical in both is nothing to compare; a changed one refuses the diff)
    expect(diffRows([5, o(1)], [5, o(2)])?.changed).toEqual([1])
    expect(diffRows([5, o(1)], [6, o(1)])).toBeNull()
    expect(diffRows([0], [-0])).toBeNull()
    expect(diffRows([o(1), o(2)], [o(1), o(2)])?.changed).toEqual([])
  })
})
