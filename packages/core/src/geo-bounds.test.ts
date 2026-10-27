import { describe, it, expect } from 'vitest'
import { buildProjection, projectedBounds } from './geo.js'

// vega bounds a shape by running its generator through boundContext, which maps each point through an identity rotation
// (1*x + 0*y), so a point at infinity becomes NaN and extends nothing.
describe('projectedBounds', () => {
  it('ignores the points at infinity a degenerate clip emits (stereographic, clipAngle 0)', () => {
    const p = buildProjection({ type: 'stereographic', scale: 60, translate: [100, 60], clipAngle: 0 } as never)
    const cap = { type: 'Polygon', coordinates: [[[-30, 70], [30, 70], [30, 88], [-30, 88], [-30, 70]]] }
    const b = projectedBounds(p, cap)
    expect(b).not.toBeNull()
    expect(b!.every(Number.isFinite)).toBe(true)
  })

  it('bounds an ordinary shape by its unrounded geometry', () => {
    const p = buildProjection({ type: 'equirectangular', scale: 100, translate: [0, 0] } as never)
    const b = projectedBounds(p, { type: 'Polygon', coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]] })
    expect(b).not.toBeNull()
    expect(b![2]).toBeGreaterThan(b![0])
  })
})
