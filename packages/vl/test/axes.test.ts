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

describe('Vega-Lite axis properties that are signals', () => {
  const spec = {
    data: { values: [{ x: 'a', y: 2 }] },
    params: [{ name: 'ang', value: 0 }, { name: 'col', value: 'red' }],
    mark: 'point',
    encoding: {
      x: { field: 'x', type: 'nominal', axis: { labelAngle: { expr: 'ang' }, labelColor: { expr: 'col' } } },
      y: { field: 'y', type: 'quantitative' },
    },
  }
  const axis = (compile(spec as never) as { axes: Array<Record<string, any>> }).axes.find((a) => !a.grid && a.scale === 'x')!

  it('moves a signal with a Vega counterpart into the encode of its part (assembleAxis)', () => {
    expect(axis.encode.labels.update.fill).toEqual({ signal: 'col' })
    expect(axis.labelColor).toBeUndefined()
  })

  it('derives the label align and baseline of a signal angle as signals (defaultLabelAlign / defaultLabelBaseline)', () => {
    expect(axis.labelAngle).toEqual({ signal: 'ang' })
    expect(axis.encode.labels.update.align.signal).toContain('((ang % 360) + 360) % 360')
    expect(axis.encode.labels.update.baseline.signal).toContain('"middle"')
    expect(axis.labelAlign).toBeUndefined()
  })
})
