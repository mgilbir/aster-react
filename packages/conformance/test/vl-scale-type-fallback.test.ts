// @vitest-environment node
/**
 * A scale type a spec asks for that the channel or the data cannot use is not used: the field has the scale it would have had without
 * asking (vega-lite scale/type.ts: the channel's list of scale types, then the data type's). An explicit `point` or `ordinal` scale on a
 * temporal x or colour is a time scale; `linear` on a nominal x is a band or point; `band` on a colour is an ordinal one; and so on.
 *
 * Every channel, every data type (quantitative, ordinal, nominal, temporal in each time unit form, binned) and every scale type of the
 * schema is compiled by vega-lite 6.4.3 and by @aster/vl; the compiled scales, axes and legends, the scales as they run, the axes, the
 * rows and the SVG must be the same (vl-ranged-compare.ts). Only the requests vega-lite does not honour are compared here: those it
 * honours are in vl-honoured-scale-types.test.ts, over the same space (vl-honoured-space.ts).
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

describe('a scale type the channel or the data cannot use falls back to the default', () => {
  for (const [place, mark, make] of PLACES) {
    it(`${place} on a ${mark}: every data type and scale type`, async () => {
      const cases: Array<[string, Obj]> = []
      let fellBack = 0
      for (const [dn, def] of DATA) {
        for (const type of SCALE_TYPES) {
          const spec = { data: { values: TIME_DATA }, mark, encoding: make({ ...def, scale: { type } }) }
          const gave = scaleTypeVegaLiteGave(spec, channelOf(place))
          // (a request vega-lite honours is not the subject: a scale type's own range and legend are another feature)
          if (gave === type || gave === undefined) continue
          fellBack++
          cases.push([`${dn}, ${type}`, spec])
        }
      }
      const bad = await collect(cases)
      expect(bad.slice(0, 8), `${bad.length} of ${cases.length} differ`).toEqual([])
      // the space must hold the fallbacks it is about, on every channel
      expect(fellBack).toBeGreaterThan(0)
    }, 240_000)
  }

  it('a layer that asks for point or ordinal on a temporal field is a time scale', async () => {
    const T = { field: 't', type: 'temporal' }
    const cases: Array<[string, Obj]> = []
    for (const type of ['point', 'ordinal', 'band', 'linear', 'time', 'utc']) {
      for (const unit of [undefined, 'month', 'utcmonth']) {
        const def = { ...T, ...(unit ? { timeUnit: unit } : {}) }
        cases.push([`${type} ${unit}: layer`, { data: { values: TIME_DATA }, layer: [
          { mark: 'line', encoding: { x: { ...def, scale: { type } }, y: { field: 'v', type: 'quantitative' } } },
          { mark: 'point', encoding: { x: def, y: { field: 'v', type: 'quantitative' }, color: { ...def, scale: { type } } } },
        ] }])
        cases.push([`${type} ${unit}: ranged`, { data: { values: TIME_DATA }, mark: 'bar', encoding: { x: { ...def, scale: { type } }, x2: { field: 't', timeUnit: unit }, y: { field: 'k', type: 'ordinal' } } }])
      }
    }
    const bad = await collect(cases)
    expect(bad.slice(0, 8), `${bad.length} of ${cases.length} differ`).toEqual([])
  }, 240_000)
})
