import { describe, it, expect } from 'vitest'
import { classify, KNOWN_DIFFERENCES, type Difference, type Side } from './geometry-differences.js'
import { EXPECTED_DIFFERENCES } from '../../../scripts/lib/expected-differences.mjs'

const side = (over: Partial<Side> = {}): Side => ({ type: 'rect', groups: [[0, 0, 300, 200]], bounds: [1, 2, 30, 40], rejected: [], ...over })
const diff = (over: Partial<Difference> = {}): Difference => ({ renderer: 'svg', origin: [5, 5], size: [310, 210], vega: side(), aster: null, ...over })

describe('the known differences of conformance:geometry', () => {
  it('a plain difference is none of them: it fails the gate', () => {
    expect(classify(diff())).toBeNull()
    expect(classify(diff({ renderer: 'canvas' }))).toBeNull()
  })
  it('each class is told apart by what the oracle holds', () => {
    expect(classify(diff({ origin: [Infinity, 5] }))).toBe('view-not-finite')
    expect(classify(diff({ size: [310, Number.NaN] }))).toBe('view-not-finite')
    expect(classify(diff({ vega: side({ rejected: ['g@transform'] }) }))).toBe('svg-attribute-rejected')
    expect(classify(diff({ aster: side({ type: 'text' }) }))).toBe('svg-text-glyphs')
    expect(classify(diff({ renderer: 'canvas', vega: side({ groups: [['15px', 32.6, 60, 90]] }) }))).toBe('canvas-group-one-axis-not-a-number')
    expect(classify(diff({ renderer: 'canvas', vega: side({ bounds: [1, -1e15, 30, 40] }) }))).toBe('canvas-beyond-float-precision')
  })
  it('an SVG class does not excuse a canvas difference, nor the reverse', () => {
    expect(classify(diff({ renderer: 'canvas', vega: side({ rejected: ['g@transform'] }) }))).toBeNull()
    expect(classify(diff({ renderer: 'svg', vega: side({ bounds: [1, -1e15, 30, 40] }) }))).toBeNull()
    expect(classify(diff({ renderer: 'canvas', vega: side({ type: 'text' }) }))).toBeNull()
  })
  it('a group that is a number on both axes, or on neither, is not the one-axis class', () => {
    expect(classify(diff({ renderer: 'canvas', vega: side({ groups: [[1, 2, 3, 4]] }) }))).toBeNull()
    expect(classify(diff({ renderer: 'canvas', vega: side({ groups: [['a', 'b', 3, 4]] }) }))).toBeNull()
  })
  it('every class names itself, and the expected-differences table says why (and names no class that does not exist)', () => {
    expect(new Set(KNOWN_DIFFERENCES.map((k) => k.id)).size).toBe(KNOWN_DIFFERENCES.length)
    const listed = EXPECTED_DIFFERENCES.filter((e) => e.gate === 'geometry-browser')
    expect(listed.map((e) => e.case).sort()).toEqual(KNOWN_DIFFERENCES.map((k) => k.id).sort())
    for (const e of listed) expect(e.reason.length, e.case).toBeGreaterThan(80)
  })
})
