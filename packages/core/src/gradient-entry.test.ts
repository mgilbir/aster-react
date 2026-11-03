// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { compileChart, evaluateChart, renderSpec } from './index.js'
import type { VgSpec } from './types.js'

const frame = (fill: unknown, extra: Record<string, unknown> = {}): VgSpec => ({
  width: 100, height: 50, padding: 0, autosize: 'none',
  scales: [{ name: 'g', type: 'linear', domain: [0, 10], range: ['white', 'black'] }],
  marks: [{ type: 'rect', encode: { update: { x: { value: 0 }, y: { value: 0 }, width: { value: 40 }, height: { value: 20 }, fill } } }],
  ...extra,
} as unknown as VgSpec)

const fillOf = (spec: VgSpec): unknown => {
  const scene = evaluateChart(compileChart(spec), { logger: { error: () => {}, warn: () => {} } } as never)
  const mark = scene.items.find((g) => g.marktype === 'rect')
  return mark?.items?.[0]?.fill
}

describe('the gradient of a scale', () => {
  it('an encode entry paints a linear gradient left to right, over the ticks of the scale and its ends', () => {
    const fill = fillOf(frame({ gradient: 'g' })) as { gradient: string; x1: number; x2: number; y1: number; y2: number; stops: Array<{ offset: number; color: string }> }
    expect(fill).toMatchObject({ gradient: 'linear', x1: 0, y1: 0, x2: 1, y2: 0 })
    expect(fill.stops.length).toBeGreaterThanOrEqual(11)
    expect(fill.stops[0]).toEqual({ offset: 0, color: 'rgb(255, 255, 255)' })
    expect(fill.stops[fill.stops.length - 1]).toEqual({ offset: 1, color: 'rgb(0, 0, 0)' })
  })

  it('start, stop and count give the end points and the number of ticks', () => {
    const fill = fillOf(frame({ gradient: 'g', start: [0.25, 0], stop: [1, 1], count: 2 })) as { x1: number; y1: number; x2: number; y2: number; stops: unknown[] }
    expect([fill.x1, fill.y1, fill.x2, fill.y2]).toEqual([0.25, 0, 1, 1])
    expect(fill.stops).toHaveLength(3)
  })

  it('the expression gradient() makes the same gradient, and the SVG names it once however many items share it', () => {
    const viaSignal = fillOf(frame({ signal: "gradient('g', [0.25, 0], [1, 1], 2)" }))
    expect(viaSignal).toEqual(fillOf(frame({ gradient: 'g', start: [0.25, 0], stop: [1, 1], count: 2 })))
    const svg = renderSpec(frame({ gradient: 'g' }, { data: [{ name: 't', values: [{}, {}, {}] }], marks: [{ type: 'rect', from: { data: 't' }, encode: { update: { x: { value: 0 }, width: { value: 4 }, height: { value: 4 }, fill: { gradient: 'g' } } } }] }))
    expect(svg.match(/<linearGradient /g)).toHaveLength(1)
    expect(svg.match(/fill="url\(#gradient_/g)).toHaveLength(3)
  })

  it('a scale that is not there, or cannot draw a gradient, fails as vega does: the error is logged and the item has no fill', () => {
    const errors: unknown[] = []
    const ordinal = frame({ gradient: 'g' }, { scales: [{ name: 'g', type: 'ordinal', domain: ['a', 'b'], range: ['red', 'blue'] }] })
    const scene = evaluateChart(compileChart(ordinal), { logger: { error: (e: unknown) => errors.push(e), warn: () => {} } } as never)
    expect(String(errors[0])).toBe('TypeError: scale.interpolate is not a function')
    expect(scene.items.find((g) => g.marktype === 'rect')?.items?.[0]?.fill).toBeUndefined()
    const missing: unknown[] = []
    evaluateChart(compileChart(frame({ gradient: 'nope' })), { logger: { error: (e: unknown) => missing.push(e), warn: () => {} } } as never)
    expect(String(missing[0])).toBe("TypeError: Cannot read properties of undefined (reading 'domain')")
  })
})
