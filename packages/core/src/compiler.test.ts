import { describe, it, expect } from 'vitest'
import { compileChart } from './compiler.js'

describe('compiler', () => {
  it('width/height/padding/background parsed', () => {
    const spec = { width: 800, height: 600, padding: 10, background: 'white' }
    const chart = compileChart(spec)
    expect(chart.width).toBe(800)
    expect(chart.height).toBe(600)
    expect(chart.padding).toEqual({ top: 10, right: 10, bottom: 10, left: 10 })
    expect(chart.background).toBe('white')
  })

  it("style:'cell' → frameStroke='#ddd'; no style → undefined", () => {
    const withStyle = compileChart({ style: 'cell' } as never)
    expect(withStyle.frameStroke).toBe('#ddd')

    const withoutStyle = compileChart({})
    expect(withoutStyle.frameStroke).toBeUndefined()
  })

  it('data/scales/axes/marks extracted with correct names/types', () => {
    const spec = {
      data: [{ name: 'table', values: [] }],
      scales: [
        { name: 'x', type: 'linear' as const, domain: [] as never, range: [0, 100] },
      ],
      axes: [{ scale: 'x', orient: 'bottom' as const }],
      marks: [{ type: 'line', encode: { update: {} } }],
    }
    const chart = compileChart(spec)
    expect(chart.data).toHaveLength(1)
    expect(chart.data[0]!.name).toBe('table')
    expect(chart.scales).toHaveLength(1)
    expect(chart.scales[0]!.name).toBe('x')
    expect(chart.scales[0]!.type).toBe('linear')
    expect(chart.axes).toHaveLength(1)
    expect(chart.axes[0]!.scale).toBe('x')
    expect(chart.marks).toHaveLength(1)
    expect(chart.marks[0]!.type).toBe('line')
    expect(chart.marks[0]!.name).not.toBe('')
  })

  it('static and event-driven signals retain their declared value', () => {
    const spec = {
      signals: [
        { name: 'width', value: 400 },
        { name: 'height', value: 300 },
        { name: 'click', value: 0, on: [{ trigger: 'click' }] },
      ],
    }
    const chart = compileChart(spec)
    expect(chart.signals.width).toBe(400)
    expect(chart.signals.height).toBe(300)
    expect(chart.signals.click).toBe(0)
  })
})
