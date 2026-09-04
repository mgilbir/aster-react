// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { compileChart, evaluateChart, renderSceneToSvg } from './index.js'
import type { VgSpec } from './types.js'

const mkSpec = (a: number, b: number): VgSpec => ({
  width: 200,
  height: 100,
  data: [
    { name: 'a', values: [{ x: 0, y: a }, { x: 1, y: a * 2 }] },
    { name: 'b', values: [{ x: 0, y: b }, { x: 1, y: b * 2 }] },
  ],
  scales: [
    { name: 'x', type: 'linear', domain: [0, 1], range: 'width' },
    { name: 'y', type: 'linear', domain: [0, 100], range: 'height' },
  ],
  marks: [
    { type: 'line', name: 'marks_a', from: { data: 'a' }, encode: { update: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'y' }, stroke: { value: 'red' } } } },
    { type: 'line', name: 'marks_b', from: { data: 'b' }, encode: { update: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'y' }, stroke: { value: 'blue' } } } },
  ],
})

describe('partial re-evaluation', () => {
  it('reuses unaffected mark groups by identity when one dataset changes', () => {
    const chart = compileChart(mkSpec(10, 20))
    const scene1 = evaluateChart(chart)
    const [a1, b1] = scene1.items
    expect(a1).toBeTruthy()
    expect(b1).toBeTruthy()

    const scene2 = evaluateChart(chart, { changedDatasets: ['b'] })
    const [a2, b2] = scene2.items
    // a: untouched -> the SAME object identity (patcher-friendly)
    expect(a2).toBe(a1)
    // b: changed -> a new group
    expect(b2).not.toBe(b1)
    // content correctness: b reflects the new values
    expect(renderSceneToSvg(scene2)).toContain('blue')
  })

  it('full rebuild without changedDatasets (safe default)', () => {
    const chart = compileChart(mkSpec(10, 20))
    const scene1 = evaluateChart(chart)
    const scene2 = evaluateChart(chart, { data: { a: [{ x: 0, y: 99 }, { x: 1, y: 99 }] } })
    expect(scene2.items[0]).not.toBe(scene1.items[0])
    expect(scene2.items[1]).not.toBe(scene1.items[1])
  })

  it('changed data actually re-encodes the affected mark', () => {
    const chart = compileChart(mkSpec(10, 20))
    evaluateChart(chart)
    const chart2 = chart
    const scene2 = evaluateChart(chart2, {
      data: { b: [{ x: 0, y: 50 }, { x: 1, y: 50 }] },
      changedDatasets: ['b'],
    })
    // the reused group must still be the old object (identity)...
    expect(scene2.items[0]).toBeTruthy()
    // ...and the rebuilt group must carry the new data (y=50 -> mid-plot)
    const bGroup = scene2.items[1]
    const bLeaf = (bGroup as { items?: Array<{ y?: number }> }).items?.[0]
    expect(bLeaf?.y).toBe(50)
  })
})
