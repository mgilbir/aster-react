// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { compile } from '../src/index.js'

describe('Vega-Lite axis ordering', () => {
  it('emits every grid axis before every label axis', () => {
    const spec = {
      $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
      width: 400, height: 300,
      data: { values: [{ x: 1, y: 2 }] },
      mark: 'point',
      encoding: {
        x: { field: 'x', type: 'quantitative' },
        y: { field: 'y', type: 'quantitative' },
      },
    }
    const vg = compile(spec as never) as { axes: Array<{ grid?: boolean; scale: string }> }
    const grids = vg.axes.map((a, i) => (a.grid ? i : -1)).filter((i) => i >= 0)
    const labels = vg.axes.map((a, i) => (a.grid ? -1 : i)).filter((i) => i >= 0)
    expect(grids.length).toBe(2)
    expect(labels.length).toBe(2)
    expect(Math.max(...grids)).toBeLessThan(Math.min(...labels))
  })
})
