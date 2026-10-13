import { describe, expect, it } from 'vitest'
import { Bounds, boundAxisGroup, boundLeaf, boundsFromPath } from './bounds.js'
import type { SceneGroup } from './types.js'

/**
 * Bounds values verified against the real vega scenegraph (dumped via the
 * conformance oracle). These pin the exact vega-scenegraph arithmetic:
 * text boxes (baseline offset + align + rotation), rule/stroke expansion,
 * and the path-traced symbol bounds.
 */
describe('vega-exact bounds', () => {
  it('bounds an axis tick rule with half-stroke expansion', () => {
    // vega: left-axis tick rule (0,300)→(-5,300), stroke #888 w1
    // → [-5.5, 299.5, 0.5, 300.5]
    const b = new Bounds()
    boundLeaf(b, { x: 0, y: 300, x2: -5, y2: 300, stroke: '#888', strokeWidth: 1 })
    expect([b.x1, b.y1, b.x2, b.y2]).toEqual([-5.5, 299.5, 0.5, 300.5])
  })

  it('bounds a right-aligned axis label', () => {
    // vega: label '0' at (-7,300), align end, baseline middle, fontSize 10
    // → box [-15, 295, -7, 305]
    const b = new Bounds()
    boundLeaf(b, { x: -7, y: 300, text: '0', align: 'right', baseline: 'middle', fontSize: 10, fill: '#000' })
    expect([b.x1, b.y1, b.x2, b.y2]).toEqual([-15, 295, -7, 305])
  })

  it('bounds a rotated axis title exactly', () => {
    // vega: title 'v' at (-35,150), align center, baseline bottom, fontSize 11,
    // angle -90 → rotated bounds [-46, 146, -35, 154]
    const b = new Bounds()
    boundLeaf(b, { x: -35, y: 150, text: 'v', align: 'center', baseline: 'bottom', fontSize: 11, fontWeight: 'bold', fill: '#000', angle: -90 })
    expect([b.x1, b.y1, b.x2, b.y2]).toEqual([-46, 146, -35, 154])
  })

  it('bounds a circle symbol with miter stroke expansion', () => {
    // vega: point at (40,48), size 30 (r=2.7386), stroke w2, miter → ±(r+4)
    const b = new Bounds()
    boundLeaf(b, { x: 40, y: 48, stroke: '#4c78a8', strokeWidth: 2, opacity: 0.7, fill: 'transparent' })
    const e = Math.sqrt(30) / 2 + 4
    expect(b.x1).toBeCloseTo(40 - e, 10)
    expect(b.y2).toBeCloseTo(48 + e, 10)
  })

  it('bounds guide-label leaves at vega\'s raw item position', () => {
    // guide labels carry vega's raw item y (the baseline shift is the
    // renderer's bake): item (−6.5, 0.5), baseline middle, fs 10
    const b = new Bounds()
    boundLeaf(b, { x: -6.5, y: 0.5, text: '55', align: 'right', baseline: 'middle', fontSize: 10, fill: '#000' })
    expect([b.x1, b.y1, b.x2, b.y2]).toEqual([-22.5, -4.5, -6.5, 5.5])
  })

  it('traces an svg arc path like vega boundContext', () => {
    // full circle: two half arcs → center ± r
    const b = new Bounds()
    boundsFromPath(b, 'M2.7386,0A2.7386,2.7386,0,1,1,-2.7386,0A2.7386,2.7386,0,1,1,2.7386,0')
    expect([b.x1, b.y1, b.x2, b.y2]).toEqual([-2.7386, -2.7386, 2.7386, 2.7386])
  })

  it('bounds an axis group as (ticks ∪ labels) ∪ spine ∪ title', () => {
    // vega's Y-axis mark bounds: spine [−s, 0, 0, range] with s = tick/label
    // extent, unioned with the shifted tick/label bounds
    const axis: SceneGroup = {
      marktype: 'group',
      role: 'axis',
      axis: { orient: 'left', range: 300 },
      items: [
        { x: 0.5, y: 0.5, x2: -4.5, y2: 0.5, stroke: '#888', strokeWidth: 1 },
        { x: -6.5, y: 0.5, text: '55', align: 'right', baseline: 'middle', fontSize: 10, fill: '#000' },
      ],
    } as unknown as SceneGroup
    const b = boundAxisGroup(axis)
    // ticks shifted (−0.5): [-5.5, -0.5, 0.5, 0.5]; label raw: [-23, -5, -6.5, 5.5]
    // spine: s = 23 → [-23, 0, 0, 300]
    expect([b.x1, b.y1, b.x2, b.y2]).toEqual([-23, -5, 0.5, 300])
  })

  it('keeps empty-union semantics for cleared bounds', () => {
    const b = new Bounds()
    expect(b.empty()).toBe(true)
    b.add(0, 0)
    expect(b.empty()).toBe(false)
  })
})
