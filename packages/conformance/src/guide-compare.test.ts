// @vitest-environment node
/**
 * The harness the guide differentials compare through (C424): a spec vega refuses is run through Aster too, and Aster drawing it is a
 * difference; a spec both refuse is a refusal with no difference; logged errors are compared. Its own failure paths, so the sweeps
 * that rely on it cannot pass by comparing nothing.
 */
import { describe, expect, it } from 'vitest'
import { compareToVega } from './guide-compare.js'

describe('compareToVega', () => {
  it('a spec vega refuses and Aster draws is a difference, not a skipped case', async () => {
    // (a data set named like a member of Object.prototype crashes vega's parser; Aster draws it: a documented deviation, which this
    // harness must still report rather than skip)
    const out = await compareToVega({ width: 10, height: 10, data: [{ name: 'toString', values: [{ a: 1 }] }], marks: [{ type: 'rect', from: { data: 'toString' } }] })
    expect(out.refused).toBeDefined()
    expect(out.diffs.join(' ')).toMatch(/vega refused .*aster rendered/)
  })
  it('a spec both refuse is a refusal and no difference', async () => {
    const out = await compareToVega({ marks: [{ type: 'bogus' }] })
    expect(out.refused).toBeDefined()
    expect(out.diffs).toEqual([])
  })
  it('a spec both draw alike is no difference, and no refusal', async () => {
    const out = await compareToVega({ width: 20, height: 20, marks: [{ type: 'rect', encode: { update: { width: { value: 5 }, height: { value: 5 } } } }] })
    expect(out).toMatchObject({ diffs: [] })
    expect(out.refused).toBeUndefined()
  })
})
