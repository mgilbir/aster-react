import { describe, it, expect } from 'vitest'
import { buildA11yTree } from './a11y.js'
import { compileChart, evaluateChart, getChartInfo } from './index.js'
import { buildHitIndex } from './hit.js'

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

describe('the coordinates of the accessible tree', () => {
  // The contract: a node's x / y / width / height are in the rendered viewport, the space the pointer is in and `buildHitIndex`
  // answers in -- the padding and the frame's offset inside it are in the numbers, and a host overlays a node at exactly
  // (x, y) over the chart. A node that is a mark is found by the hit test at its own centre.
  const bars = (extra: Record<string, unknown>): never => ({
    width: 200, height: 120,
    data: [{ name: 't', values: [{ c: 'a', v: 3 }, { c: 'b', v: 7 }] }],
    scales: [
      { name: 'x', type: 'band', domain: { data: 't', field: 'c' }, range: 'width' },
      { name: 'y', type: 'linear', domain: [0, 10], range: 'height' },
    ],
    axes: [{ scale: 'x', orient: 'bottom', title: 'Category' }, { scale: 'y', orient: 'left' }],
    marks: [{
      type: 'rect', from: { data: 't' },
      encode: { update: {
        x: { scale: 'x', field: 'c' }, width: { scale: 'x', band: 1 }, y: { scale: 'y', field: 'v' }, y2: { scale: 'y', value: 0 },
        fill: { value: 'steelblue' }, description: { field: 'c' },
      } },
    }],
    ...extra,
  }) as never

  // `contained`: the chart's own guides fit the viewport (autosize pad / fit); with none, or an offset frame, a label can hang outside
  const CASES: Array<[string, Record<string, unknown>, boolean]> = [
    ['a padding of 5', { padding: 5, autosize: 'none' }, false],
    ['a padding per side', { padding: { left: 31, top: 9, right: 4, bottom: 17 }, autosize: 'none' }, false],
    ['autosize pad, which grows the padding for the axes', { padding: 5, autosize: 'pad' }, true],
    ['autosize pad with a padding per side', { padding: { left: 3, top: 11, right: 6, bottom: 2 }, autosize: 'pad' }, true],
    ['autosize fit, the size containing the padding', { padding: 12, autosize: { type: 'fit', contains: 'padding' } }, true],
    ['autosize fit-x with a padding per side', { padding: { left: 20, top: 8, right: 14, bottom: 6 }, autosize: { type: 'fit-x', contains: 'padding' } }, true],
    ['a frame offset inside the padding (the view encode)', { padding: 5, autosize: 'none', encode: { update: { x: { value: 7 }, y: { value: 3 } } } }, false],
    ['a frame offset with autosize pad', { padding: { left: 9, top: 4, right: 5, bottom: 5 }, autosize: 'pad', encode: { update: { x: { value: 13 }, y: { value: 6 } } } }, false],
  ]

  it.each(CASES)('%s: a mark node is where the hit test finds the mark', (_name, extra, contained) => {
    const spec = bars(extra)
    const scene = evaluateChart(compileChart(spec))
    const tree = buildA11yTree(scene, getChartInfo(spec).scales)
    const hits = buildHitIndex(scene)
    const marks = tree.nodes.filter((n) => n.kind === 'mark')
    expect(marks).toHaveLength(2)
    for (const node of marks) {
      const hit = hits.query(node.x + node.width / 2, node.y + node.height / 2)
      expect(hit?.item.datum, `node ${node.label} at (${node.x}, ${node.y}) ${node.width}x${node.height}`).toBe(node.datum)
    }
    if (!contained) return
    // and the boxes are inside the rendered viewport, which the padding is part of
    for (const node of tree.nodes) {
      expect(node.x).toBeGreaterThanOrEqual(-0.001)
      expect(node.y).toBeGreaterThanOrEqual(-0.001)
      expect(node.x + node.width).toBeLessThanOrEqual(scene.width + 0.001)
      expect(node.y + node.height).toBeLessThanOrEqual(scene.height + 0.001)
    }
  })

  it('pins the boxes of a chart with a padding of 5', () => {
    const spec = bars({ padding: 5, autosize: 'none' })
    const scene = evaluateChart(compileChart(spec))
    const marks = buildA11yTree(scene, getChartInfo(spec).scales).nodes.filter((n) => n.kind === 'mark')
    // the root group sits at the padding; band a spans the left half, its bar rises 3 of 10 of the 120 high plot
    const boxes = marks.map((m) => [m.label, m.x, m.y, m.width, m.height])
    expect(boxes.map(([l]) => l)).toEqual(['a', 'b'])
    expect(boxes[0]!.slice(1)).toEqual([5, 5 + 84, 100, 36])
    expect(boxes[1]!.slice(1).map((n) => Math.round((n as number) * 1e6) / 1e6)).toEqual([105, 5 + 36, 100, 84])
  })

  it('moves every node, guides and titles included, with the padding and the frame offset and nothing else', () => {
    const base = bars({ padding: 5, autosize: 'none' })
    const shifted = bars({ padding: { left: 31, top: 9, right: 4, bottom: 17 }, autosize: 'none', encode: { update: { x: { value: 7 }, y: { value: 3 } } } })
    const nodesOf = (spec: never) => buildA11yTree(evaluateChart(compileChart(spec)), getChartInfo(spec).scales).nodes
    const a = nodesOf(base)
    const b = nodesOf(shifted)
    expect(b.map((n) => n.label)).toEqual(a.map((n) => n.label))
    expect(a.some((n) => n.kind === 'axis')).toBe(true)
    // (31 - 5 more padding on the left, 9 - 5 on the top, and the frame 7 and 3 further in)
    for (let i = 0; i < a.length; i++) {
      expect(b[i]!.x - a[i]!.x, a[i]!.label).toBeCloseTo(26 + 7, 6)
      expect(b[i]!.y - a[i]!.y, a[i]!.label).toBeCloseTo(4 + 3, 6)
      expect(b[i]!.width).toBeCloseTo(a[i]!.width, 6)
      expect(b[i]!.height).toBeCloseTo(a[i]!.height, 6)
    }
  })

  it('places the frame node over the plot: at the padding plus the frame offset, the size of the plot', () => {
    const spec = bars({
      padding: { left: 31, top: 9, right: 4, bottom: 17 }, autosize: 'none',
      encode: { update: { x: { value: 7 }, y: { value: 3 }, description: { value: 'the frame' } } },
    })
    const scene = evaluateChart(compileChart(spec))
    const frame = buildA11yTree(scene, getChartInfo(spec).scales).nodes.find((n) => n.label === 'the frame')!
    expect([frame.x, frame.y, frame.width, frame.height]).toEqual([31 + 7, 9 + 3, 200, 120])
  })
})
