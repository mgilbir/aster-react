// @vitest-environment jsdom
/**
 * `createPointMapper`: a client point mapped into the chart's frame (vega's `point()`). With no element yet there is no frame: the
 * point is over nothing (C532), not a client coordinate taken for a view coordinate.
 */
import { describe, expect, it } from 'vitest'
import { createPointMapper } from './pointer.js'
import { buildHitIndex } from './hit.js'
import { compileChart } from './compiler.js'
import { evaluateChart } from './evaluate.js'

describe('createPointMapper', () => {
  it('with no element yet, a point maps to (NaN, NaN), which no index picks', () => {
    const mapper = createPointMapper(() => null)
    const [x, y] = mapper.map(20, 20)
    expect(Number.isNaN(x) && Number.isNaN(y)).toBe(true)
    const scene = evaluateChart(compileChart({ width: 100, height: 100, padding: 0, autosize: 'none', marks: [{ type: 'rect', encode: { enter: { x: { value: 0 }, y: { value: 0 }, width: { value: 100 }, height: { value: 100 }, fill: { value: 'red' } } } }] } as never), {})
    const index = buildHitIndex(scene)
    expect(index.pick(20, 20)).not.toBeNull()
    expect(index.pick(x, y)).toBeNull()
  })

  it('maps through the element once it exists', () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    let target: Element | null = null
    const mapper = createPointMapper(() => target)
    expect(Number.isNaN(mapper.map(5, 5)[0])).toBe(true)
    target = el
    mapper.invalidate()
    const [x, y] = mapper.map(5, 7)
    expect([x, y].every(Number.isFinite)).toBe(true)
  })
})
