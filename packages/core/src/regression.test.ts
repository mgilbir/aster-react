import { describe, it, expect } from 'vitest'
import { buildScale } from './scales.js'
import { compileChart } from './compiler.js'
import { evaluateChart } from './runtime.js'
import type { ScaleContext } from './scales.js'
import './addon-geo.js'

// Regression guards for the two real bugs found while closing parity gaps:
//   (1) {step} band-scale range must be derived from the step, not frozen.
//   (2) contour must honour its explicit threshold array.

describe('{step} band-scale range (bug: .step() setter does not expand range)', () => {
  const ctx = (signals: Record<string, unknown>): ScaleContext => ({
    width: 400, height: 300, signals,
    evaluate: () => undefined, dataField: () => [], dataRows: () => [],
  })
  it('derives range end = step * bandSpace(count, padInner, padOuter)', () => {
    const s = buildScale({
      name: 'x', type: 'band', domain: ['a', 'b'], range: { step: 20 }, padding: 0.1,
    } as never, ctx({})) as any
    // padding maps to both inner+outer -> bandSpace(2, 0.1, 0.1) = 2.1 -> 42
    expect(s.range()[1]).toBeCloseTo(42, 5)
  })
  it('resolves a step from a signal', () => {
    const s = buildScale({
      name: 'x', type: 'band', domain: ['a', 'b', 'c'], range: { step: { signal: 'x_step' } }, paddingInner: 0.1, paddingOuter: 0.05,
    } as never, ctx({ x_step: 20 })) as any
    // bandSpace(3, 0.1, 0.05) = 3.0 -> rangeEnd = 60
    expect(s.range()[1]).toBeCloseTo(60, 5)
  })
})

describe('contour transform honours its threshold array (bug: d3-contour needs .thresholds())', () => {
  it('produces exactly `count` isocontours from point input', () => {
    const chart = compileChart({
      width: 100, height: 100, autosize: 'none', padding: 0,
      data: [
        { name: 'pts', values: [{ x: 20, y: 30 }, { x: 25, y: 35 }, { x: 60, y: 50 }, { x: 65, y: 55 }, { x: 30, y: 30 }, { x: 70, y: 60 }] },
        { name: 'cont', source: 'pts', transform: [{ type: 'contour', count: 4, x: 'x', y: 'y', size: [100, 100] }] },
      ],
      marks: [{ type: 'shape', from: { data: 'cont' }, transform: [{ type: 'geoshape' }], encode: { update: { stroke: { value: '#000' } } } }],
    } as never)
    const scene = evaluateChart(chart, {})
    const shape = (scene.items as Array<Record<string, unknown>>).find((g) => g.marktype === 'shape') as { items?: unknown[] }
    // exactly `count` isocontours, not d3's default ~20 Sturges set
    expect(shape).toBeDefined()
    expect(shape.items!.length).toBe(4)
  })
})
