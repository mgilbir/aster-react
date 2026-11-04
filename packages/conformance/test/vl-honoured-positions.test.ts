// @vitest-environment node
/**
 * Where a mark sits on the scales its encoding asked for, against vega-lite 6.4.3 (vl-honoured-positions-space.ts): every mark on every
 * data type of a position, every scale type vega-lite honours for it and every band position; offsets on band, point, continuous,
 * binned and time scales, alone and in layers; time units on the non-position channels of every mark; datums on every position.
 * The compiled scales, axes and legends, the scales as they run, the axes, the rows and the SVG must be the same (vl-ranged-compare.ts).
 */
import { describe, it, expect } from 'vitest'
import { collect } from './vl-ranged-compare.js'
import { MARKS, markPositionCases, offsetCases, timeUnitChannelCases, datumCases } from './vl-honoured-positions-space.js'

async function expectSame(cases: ReturnType<typeof markPositionCases>): Promise<void> {
  const all = [...cases]
  const bad = await collect(all)
  expect(bad.slice(0, 8), `${bad.length} of ${all.length} differ`).toEqual([])
  expect(all.length).toBeGreaterThan(0)
}

describe('a mark sits where vega-lite puts it', () => {
  for (const mark of MARKS) {
    it(`${mark}: every position, scale type and band position`, async () => {
      await expectSame(markPositionCases(mark))
    }, 240_000)
  }
  it('offsets on every kind of position', async () => {
    await expectSame(offsetCases())
  }, 240_000)
  it('a time unit on a colour, a size and an opacity, on every mark', async () => {
    await expectSame(timeUnitChannelCases())
  }, 240_000)
  it('a datum on every position of every mark', async () => {
    await expectSame(datumCases())
  }, 240_000)
})
