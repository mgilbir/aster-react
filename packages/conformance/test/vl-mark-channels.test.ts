// @vitest-environment node
/**
 * Every mark x every encoding channel x every kind of definition (vl-mark-channels-space.ts), compiled by vega-lite 6.4.3 and by
 * @aster/vl: a field of each type, a value, a datum, a condition with a value and with a field, and a field without a scale. The
 * channels a mark does not draw are dropped, as vega-lite 6.4.3's initEncoding drops them (a size on an area, an x on a geoshape, a
 * url on anything but an image: the output is the output without the channel); the ones it draws are drawn as vega-lite draws them.
 * The compiled scales, axes and legends, the scales as they run, the rows and the SVG must be the same (vl-ranged-compare.ts).
 *
 * One kind of case is refused on purpose, and listed under "Throws" in packages/vl/README.md (readme-refusals.test.ts checks the
 * list): a condition that gives a field on a position the mark draws. The Vega-Lite schema gives a position no condition, and
 * vega-lite makes a scale, an axis and a stack group of the condition's field while it places the mark by the value. Those cases
 * stay in the space: @aster/vl must refuse each of them with that error, so one that comes to compile fails here until it is
 * compared like the rest.
 */
import { describe, it, expect } from 'vitest'
import * as vl from 'vega-lite'
import { compile, VLCompileError } from '@aster/vl'
import { silent } from './vl-time-helpers.js'
import { collect } from './vl-ranged-compare.js'
import { MARKS, base, markChannelCases } from './vl-mark-channels-space.js'

type Obj = Record<string, unknown>

const vegaLite = (spec: Obj): string | undefined => {
  try { return JSON.stringify((vl as any).compile(JSON.parse(JSON.stringify(spec)), { logger: silent }).spec) } catch { return undefined }
}

const POSITIONS = new Set(['x', 'y', 'x2', 'y2', 'xOffset', 'yOffset', 'theta', 'theta2', 'radius', 'radius2', 'longitude', 'latitude', 'longitude2', 'latitude2'])
const REFUSAL = /a condition that gives a field or a datum on a position channel/

/** A condition that gives a field (or a datum) on a position channel. */
function positionFieldCondition(spec: Obj): boolean {
  return Object.entries(spec.encoding as Obj).some(([ch, def]) => POSITIONS.has(ch) && ([] as unknown[]).concat((def as Obj).condition ?? []).some((c) => (c as Obj).field !== undefined || (c as Obj).datum !== undefined))
}

/** The `key` of every mark, in order. */
function keysOf(node: Obj): unknown[] {
  return ((node.marks as Obj[] | undefined) ?? []).flatMap((m) => [m.key, ...keysOf(m)])
}

describe('a mark draws the channels vega-lite draws, and drops the ones it drops', () => {
  for (const mark of MARKS) {
    it(`${mark}: every channel as a field of each type, a value, a datum, a condition and a field without a scale`, async () => {
      const all = [...markChannelCases(mark)]
      const without = vegaLite({ ...base(mark), mark })
      const dropped = new Set(all.filter(([, spec]) => vegaLite(spec) === without).map(([name]) => name))
      // (a position the mark does not draw is dropped, its condition with it: only a drawn one is refused)
      const refused = all.filter(([name, spec]) => positionFieldCondition(spec) && !dropped.has(name))
      const compared = all.filter((c) => !refused.includes(c))
      const bad = await collect(compared)
      expect(bad.slice(0, 8), `${bad.length} of ${compared.length} differ`).toEqual([])
      // (the key Vega joins a mark's items by changes no picture: it is compared as written, mark by mark)
      for (const [name, spec] of compared.filter(([, spec]) => 'key' in (spec.encoding as Obj))) {
        const theirs = vegaLite(spec)
        if (theirs !== undefined) expect(keysOf(compile(JSON.parse(JSON.stringify(spec)) as never) as Obj), name).toEqual(keysOf(JSON.parse(theirs) as Obj))
      }
      for (const [name, spec] of refused) {
        expect(() => compile(JSON.parse(JSON.stringify(spec)) as never), name).toThrow(VLCompileError)
        expect(() => compile(JSON.parse(JSON.stringify(spec)) as never), name).toThrow(REFUSAL)
      }
      // (the space holds channels the mark does not draw, and ones it draws)
      expect(dropped.size).toBeGreaterThan(0)
      expect(dropped.size).toBeLessThan(all.length)
    }, 240_000)
  }
})
