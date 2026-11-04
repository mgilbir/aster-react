// @vitest-environment node
/**
 * The paint channels against vega-lite 6.4.3 (vl-paint-space.ts): `fill` and `stroke` on every mark, filled and unfilled, as a field,
 * a datum, a value and a condition, alone and beside `color` or each other; the config and mark-def colours they fall back on; layers
 * that share their fields. The compiled scales, axes and legends, the scales as they run, the rows and the SVG must be the same
 * (vl-ranged-compare.ts).
 */
import { describe, it, expect } from 'vitest'
import { collect } from './vl-ranged-compare.js'
import { PAINT_MARKS, paintCases, paintDefaultCases, paintLayerCases } from './vl-paint-space.js'

async function expectSame(cases: Iterable<[string, Record<string, unknown>]>): Promise<void> {
  const all = [...cases]
  const bad = await collect(all)
  expect(bad.slice(0, 8), `${bad.length} of ${all.length} differ`).toEqual([])
  expect(all.length).toBeGreaterThan(0)
}

describe('fill and stroke paint a mark as vega-lite paints it', () => {
  for (const mark of PAINT_MARKS) {
    it(`${mark}: fill and stroke, filled and unfilled, every definition, beside color and each other`, async () => {
      await expectSame(paintCases(mark))
    }, 240_000)
  }
  it('the config and mark-def colours they fall back on', async () => {
    await expectSame(paintDefaultCases())
  }, 240_000)
  it('layers whose paint channels share a field', async () => {
    await expectSame(paintLayerCases())
  }, 240_000)
})
