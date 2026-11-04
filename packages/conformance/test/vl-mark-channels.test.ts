// @vitest-environment node
/**
 * Every mark x every encoding channel x every kind of definition (vl-mark-channels-space.ts), compiled by vega-lite 6.4.3 and by
 * @aster/vl: a field of each type, a value, a datum, a condition with a value and with a field, and a field without a scale. The
 * channels a mark does not draw are dropped, as vega-lite 6.4.3's initEncoding drops them (a size on an area, an x on a geoshape, a
 * url on anything but an image: the output is the output without the channel); the ones it draws are drawn as vega-lite draws them.
 * The compiled scales, axes and legends, the scales as they run, the rows and the SVG must be the same (vl-ranged-compare.ts).
 */
import { describe, it, expect } from 'vitest'
import * as vl from 'vega-lite'
import { silent } from './vl-time-helpers.js'
import { collect } from './vl-ranged-compare.js'
import { MARKS, base, markChannelCases } from './vl-mark-channels-space.js'

type Obj = Record<string, unknown>

const vegaLite = (spec: Obj): string | undefined => {
  try { return JSON.stringify((vl as any).compile(JSON.parse(JSON.stringify(spec)), { logger: silent }).spec) } catch { return undefined }
}

describe('a mark draws the channels vega-lite draws, and drops the ones it drops', () => {
  for (const mark of MARKS) {
    it(`${mark}: every channel as a field of each type, a value, a datum, a condition and a field without a scale`, async () => {
      const all = [...markChannelCases(mark)]
      const bad = await collect(all)
      expect(bad.slice(0, 8), `${bad.length} of ${all.length} differ`).toEqual([])
      // (the space holds channels the mark does not draw, and ones it draws)
      const without = vegaLite({ ...base(mark), mark })
      const dropped = all.filter(([, spec]) => vegaLite(spec) === without).length
      expect(dropped).toBeGreaterThan(0)
      expect(dropped).toBeLessThan(all.length)
    }, 240_000)
  }
})
