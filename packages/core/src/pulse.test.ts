import { describe, it, expect } from 'vitest'
import { compileChart, evaluateChart, renderSceneToSvg, type VgSpec } from './index.js'
import { createChartSession } from './session.js'
import { buildPulseGraph, diffRows, propagatePulse } from './pulse.js'

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

  it('builds source/target edges and propagates to marks', () => {
    const chart = compileChart({
      ...spec,
      // the scale must not name the data set this spec no longer declares (vega.parse refuses that)
      scales: [{ name: 'x', type: 'band', domain: ['a', 'b', 'c'], range: [0, 200] }, { name: 'y', type: 'linear', domain: [0, 4], range: [100, 0] }],
      data: [
        { name: 'src', values: [{ g: 'a', v: 1 }] },
        { name: 'filtered', source: 'src', transform: [{ type: 'filter', expr: 'datum.v > 0' }] },
      ],
      marks: [{ type: 'symbol', from: { data: 'filtered' }, encode: { update: { x: { value: 1 }, y: { value: 1 } } } }],
    } as unknown as VgSpec)
    const graph = buildPulseGraph(chart)
    expect(graph.nodes.get('src')?.downstream).toEqual(['filtered'])
    expect(graph.nodes.get('filtered')?.marks).toEqual(['marks'])
    const p = propagatePulse(graph, ['src'])
    expect([...p.datasets].sort()).toEqual(['filtered', 'src'])
    expect([...p.marks]).toEqual(['marks'])
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
  it('incremental sorted window/stack matches a full re-derive', () => {
    const base = {
      width: 200, height: 100, padding: 0, autosize: 'none',
      data: [{
        name: 't',
        values: [{ g: 'a', v: 1 }, { g: 'a', v: 3 }, { g: 'b', v: 2 }, { g: 'b', v: 4 }],
        transform: [{ type: 'window', groupby: ['g'], sort: { field: 'v', order: 'descending' }, ops: ['rank'], as: ['r'] }],
      }],
      scales: [{ name: 'y', type: 'linear', domain: [0, 5], range: [100, 0] }],
      marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { value: 50 }, y: { scale: 'y', field: 'v' }, size: { value: 30 } } } }],
    } as unknown as VgSpec
    const chart = compileChart(base)
    const rows = [{ g: 'a', v: 1 }, { g: 'a', v: 3 }, { g: 'b', v: 2 }, { g: 'b', v: 4 }]
    evaluateChart(chart, { data: { t: rows } })
    const next = [{ g: 'a', v: 2 }, { g: 'a', v: 3 }, { g: 'b', v: 2 }, { g: 'b', v: 4 }]
    const inc = evaluateChart(chart, { data: { t: next }, dataChanges: { t: [0] } })
    const full = evaluateChart(chart, { data: { t: next } })
    expect(renderSceneToSvg(inc)).toBe(renderSceneToSvg(full))
  })
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
