import { describe, it, expect, afterEach } from 'vitest'
import { renderSpec, setTextMetricsProvider, withTextMetricsProvider } from './index.js'
import type { TextMetricsProvider } from './text-metrics.js'

const spec = {
  width: 220, height: 120, padding: 5, autosize: 'none',
  data: [{ name: 't', values: [{ c: 'alpha', v: 3 }, { c: 'beta', v: 7 }, { c: 'gamma', v: 5 }] }],
  scales: [
    { name: 'x', type: 'band', domain: { data: 't', field: 'c' }, range: 'width' },
    { name: 'y', type: 'linear', domain: [0, 8], range: 'height' },
  ],
  axes: [{ scale: 'x', orient: 'bottom', title: 'Category' }, { scale: 'y', orient: 'left' }],
  title: { text: 'Custom font title' },
  marks: [{ type: 'rect', from: { data: 't' }, encode: { update: {
    x: { scale: 'x', field: 'c' }, width: { scale: 'x', band: 1 },
    y: { scale: 'y', field: 'v' }, y2: { scale: 'y', value: 0 }, fill: { value: 'steelblue' },
  } } }],
} as never

const wide: TextMetricsProvider = {
  measure: (text, _font, fontSize) => text.length * fontSize * 1.6,
}

afterEach(() => setTextMetricsProvider(null))

describe('host text metrics', () => {
  it('applies a per-render provider to layout and bounds', () => {
    const narrow = renderSpec(spec)
    const custom = renderSpec(spec, { textMetrics: wide })
    expect(custom).not.toBe(narrow)
    expect(custom.length).not.toBe(narrow.length)
  })

  it('supports a scoped provider and restores the default', () => {
    const inside = withTextMetricsProvider(wide, () => renderSpec(spec))
    const outside = renderSpec(spec)
    expect(inside).not.toBe(outside)
    expect(renderSpec(spec, { textMetrics: wide })).toBe(inside)
  })

  it('sanitizes invalid provider widths back to the estimate', () => {
    const bad: TextMetricsProvider = { measure: () => Number.NaN }
    expect(() => renderSpec(spec, { textMetrics: bad })).not.toThrow()
  })
})
