/**
 * conformance:diff compares each step's two sides on their own (audit C193): a side that throws alone is a difference, two that
 * throw differently are a difference, and the accessibility structure is compared with the picture.
 */
import { describe, expect, it } from 'vitest'
import { attempt, stepDifference } from './diff-compare.js'
import { canonicalizeSvg } from './normalize.js'

const svg = (label: string, x = 1) => `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><g role="graphics-symbol" aria-label="${label}"><rect x="${x}" y="1" width="5" height="5" fill="red"/></g></svg>`
const ok = (s: string) => attempt(() => canonicalizeSvg(s))
const threw = (m: string) => attempt((): ReturnType<typeof canonicalizeSvg> => { throw new Error(m) })

describe('one step of conformance:diff (C193)', () => {
  it('agrees on the same render, and on the same error', () => {
    expect(stepDifference('s', ok(svg('a')), ok(svg('a')))).toBeNull()
    expect(stepDifference('s', threw('boom'), threw('boom'))).toBeNull()
  })
  it('an incremental path that throws where the reference renders is a difference, and the reverse', () => {
    expect(stepDifference('s', threw('boom'), ok(svg('a')))).toMatch(/only the incremental path threw \(boom\)/)
    expect(stepDifference('s', ok(svg('a')), threw('boom'))).toMatch(/only the reference threw \(boom\)/)
  })
  it('two different errors are a difference', () => {
    expect(stepDifference('s', threw('boom'), threw('bang'))).toMatch(/threw "boom", the reference "bang"/)
  })
  it('a stale aria-label (the structure) is a difference, as is the picture', () => {
    expect(stepDifference('s', ok(svg('old')), ok(svg('new')))).toMatch(/the render differs/)
    expect(stepDifference('s', ok(svg('a', 1)), ok(svg('a', 3)))).toMatch(/the render differs/)
  })
})
