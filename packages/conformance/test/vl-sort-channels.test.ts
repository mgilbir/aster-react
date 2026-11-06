// @vitest-environment node
/**
 * A field's `sort` on every channel of the honoured-scale-type space (vl-honoured-space.ts): every place, every data type, the scale the
 * field has by default and every scale type vega-lite 6.4.3 honours for it, and every kind of sort -- ascending, descending, none, by an
 * aggregate of a field (the channel's own or another), by a field. vega-lite orders a discrete scale by its domain's sort and reverses
 * only a continuous one. The compiled scales, axes and legends, the scales as they run, the rows and the SVG must be the same
 * (vl-ranged-compare.ts).
 */
import { describe, it, expect } from 'vitest'
import * as vl from 'vega-lite'
import { TIME_DATA, silent } from './vl-time-helpers.js'
import { collect } from './vl-ranged-compare.js'
import { PLACES, DATA, SCALE_TYPES, channelOf, type Obj } from './vl-honoured-space.js'

const SORTS: Array<[string, unknown]> = [
  ['ascending', 'ascending'],
  ['descending', 'descending'],
  ['none', null],
  ['by the sum of another field, descending', { op: 'sum', field: 'v', order: 'descending' }],
  ['by a field, descending', { field: 'k', order: 'descending' }],
  ['by a field', { field: 'k' }],
  ['by the count of a field', { field: 'k', op: 'count' }],
  ['by the count of a field, descending', { field: 'k', op: 'count', order: 'descending' }],
  ['by the sum of a field', { field: 'v', op: 'sum' }],
  ['by the max of the time, descending', { field: 't', op: 'max', order: 'descending' }],
  ['by a list of values', ['b', 'a', 'c']],
]

function scaleTypeVegaLiteGave(spec: Obj, channel: string): string | undefined {
  try {
    const vg = (vl as any).compile(JSON.parse(JSON.stringify(spec)), { logger: silent }).spec
    return (vg.scales ?? []).find((s: Obj) => s.name === channel)?.type
  } catch {
    return undefined
  }
}

describe('a sort orders a channel as vega-lite orders it', () => {
  for (const [place, mark, make] of PLACES) {
    it(`${place} on a ${mark}: every data type, scale type and sort`, async () => {
      const cases: Array<[string, Obj]> = []
      for (const [dn, def] of DATA) {
        for (const type of [undefined, ...SCALE_TYPES]) {
          const scaled = type === undefined ? def : { ...def, scale: { type } }
          // (a scale type asked for and not honoured is the fallback test's)
          if (type !== undefined && scaleTypeVegaLiteGave({ data: { values: TIME_DATA }, mark, encoding: make(scaled) }, channelOf(place)) !== type) continue
          for (const [sn, sort] of SORTS) cases.push([`${dn}, ${type ?? 'default scale'}, sort ${sn}`, { data: { values: TIME_DATA }, mark, encoding: make({ ...scaled, sort }) }])
        }
      }
      const bad = await collect(cases)
      expect(bad.slice(0, 8), `${bad.length} of ${cases.length} differ`).toEqual([])
      expect(cases.length).toBeGreaterThan(0)
    }, 600_000)
  }
})
