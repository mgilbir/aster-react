import { describe, it, expect } from 'vitest'
import { buildA11yTree } from './a11y.js'
import { compileChart, evaluateChart, getChartInfo } from './index.js'

const spec = {
  width: 200, height: 120, padding: 5, autosize: 'none',
  data: [{ name: 't', values: [{ c: 'a', v: 3 }, { c: 'b', v: 7 }] }],
  scales: [
    { name: 'x', type: 'band', domain: { data: 't', field: 'c' }, range: 'width' },
    { name: 'y', type: 'linear', domain: [0, 10], range: 'height' },
  ],
  axes: [{ scale: 'x', orient: 'bottom', title: 'Category' }, { scale: 'y', orient: 'left' }],
  marks: [{
    type: 'rect', from: { data: 't' },
    encode: { update: {
      x: { scale: 'x', field: 'c' }, width: { scale: 'x', band: 1 },
      y: { scale: 'y', field: 'v' }, y2: { scale: 'y', value: 0 },
      fill: { value: 'steelblue' }, description: { field: 'c' },
    } },
  }],
} as never

describe('accessible scene tree', () => {
  it('emits positioned mark and guide nodes with upstream-style captions', () => {
    const chart = compileChart(spec)
    const scene = evaluateChart(chart)
    const info = getChartInfo(spec)
    const tree = buildA11yTree(scene, info.scales)
    const marks = tree.nodes.filter((n) => n.kind === 'mark')
    expect(marks).toHaveLength(2)
    expect(marks[0]!.width).toBeGreaterThan(0)
    expect(marks.map((m) => m.label).sort()).toEqual(['a', 'b'])
    expect(marks[0]!.role).toBe('graphics-symbol')
    const axes = tree.nodes.filter((n) => n.kind === 'axis')
    expect(axes).toHaveLength(2)
    const xAxis = axes.find((n) => n.orient === 'bottom')!
    expect(xAxis.label).toMatch(/X-axis titled 'Category' for a discrete scale with 2 values/)
    expect(xAxis.role).toBe('graphics-symbol')
    const yAxis = axes.find((n) => n.orient === 'left')!
    // continuous scales expose an adjustable slider
    expect(yAxis.role).toBe('slider')
    expect(yAxis.domain).toEqual([0, 10])
  })

  it('summarises dense charts instead of emitting a node per mark', () => {
    const chart = compileChart(spec)
    const scene = evaluateChart(chart)
    const tree = buildA11yTree(scene, new Map(), { summaryThreshold: 1 })
    expect(tree.summary).toContain('2 marks')
    const markNodes = tree.nodes.filter((n) => n.kind === 'mark')
    expect(markNodes).toHaveLength(1)
    expect(markNodes[0]!.count).toBe(2)
  })
})
