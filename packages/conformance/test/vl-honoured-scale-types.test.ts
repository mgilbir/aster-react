// @vitest-environment node
/**
 * A scale type a channel can use is the scale the field has. vl-scale-type-fallback.test.ts covers the requests the channel or the data
 * cannot use (the field has the scale it would have had without asking); this covers the others: every channel, every scale type
 * vega-lite 6.4.3 honours for it (it compiled a scale of the type asked), and every data type, compiled by vega-lite and by @aster/vl.
 * The compiled scales, axes and legends (type, domain, range and every property), the scales as they run, the axes, the rows and the SVG
 * must be the same (vl-ranged-compare.ts).
 */
import { describe, it, expect } from 'vitest'
import * as vl from 'vega-lite'
import { TIME_DATA, silent } from './vl-time-helpers.js'
import { collect } from './vl-ranged-compare.js'
import { PLACES, DATA, SCALE_TYPES, channelOf, type Obj } from './vl-honoured-space.js'

function scaleTypeVegaLiteGave(spec: Obj, channel: string): string | undefined {
  try {
    const vg = (vl as any).compile(JSON.parse(JSON.stringify(spec)), { logger: silent }).spec
    return (vg.scales ?? []).find((s: Obj) => s.name === channel)?.type
  } catch {
    return undefined
  }
}

describe('a scale type the channel honours is the scale the field has', () => {
  for (const [place, mark, make] of PLACES) {
    it(`${place} on a ${mark}: every data type and scale type`, async () => {
      const cases: Array<[string, Obj]> = []
      for (const [dn, def] of DATA) {
        for (const type of SCALE_TYPES) {
          const spec = { data: { values: TIME_DATA }, mark, encoding: make({ ...def, scale: { type } }) }
          // (the requests vega-lite does not honour are the fallback test's)
          if (scaleTypeVegaLiteGave(spec, channelOf(place)) !== type) continue
          cases.push([`${dn}, ${type}`, spec])
        }
      }
      const bad = await collect(cases)
      expect(bad.slice(0, 8), `${bad.length} of ${cases.length} differ`).toEqual([])
      // the space must hold the requests it is about, on every channel
      expect(cases.length).toBeGreaterThan(0)
    }, 240_000)
  }
})
