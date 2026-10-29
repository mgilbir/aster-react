// @vitest-environment node
/**
 * HANDOFF (lane 3 -> lane 7): the expression functions `scale(name, v)` and `invert(name, v)` take a PROJECTION's name as well as a
 * scale's (vega registers a projection with the scales). vega-lite's interval selection over a map (interval.ts, the projection
 * branch) writes `[scale("projection", [lon, lat]), ...]` and `invert("projection", [width/2, height/2])`; Aster throws
 * "Cannot read properties of undefined (reading '0')" on every one of them. Fails today; belongs in packages/conformance/test/.
 * Gallery specs behind it: vl/interactive_1d_geo_brush, vl/interactive_airport_crossfilter (@aster/vl compiles both now).
 */
import { describe, it, expect } from 'vitest'
import { renderSpec } from '@aster/core'
import '@aster/core/geo'
import { renderWithVegaChecked } from '../src/render-vega.js'
import { canonicalizeSvg, diffCanonical } from '../src/normalize.js'

const spec = (update: string): any => ({
  $schema: 'https://vega.github.io/schema/vega/v5.json',
  width: 300,
  height: 200,
  projections: [{ name: 'proj', type: 'mercator', size: [300, 200] }],
  signals: [{ name: 'k', update }],
  marks: [{ type: 'rect', encode: { update: { x: { signal: 'k[0]' }, y: { signal: 'k[1]' }, width: { value: 10 }, height: { value: 10 } } } }],
})
const CASES: Array<[string, string]> = [
  ['scale() of a projection', 'scale("proj", [-100, 40])'],
  ['invert() of a projection', 'invert("proj", [100, 100])'],
  ['two projected corners, as a brush starts', '[scale("proj", [-86, 30]), scale("proj", [-118, 40])][1]'],
  ['the centre of the view, inverted', 'invert("proj", [width / 2, height / 2])'],
]
describe('scale() and invert() of a projection', () => {
  for (const [name, update] of CASES) {
    it(name, async () => {
      const s = spec(update)
      const vega = await renderWithVegaChecked(JSON.parse(JSON.stringify(s)))
      expect(vega.errors).toEqual([])
      const errors: unknown[] = []
      const mine = renderSpec(JSON.parse(JSON.stringify(s)), { logger: { error: (e: unknown) => { errors.push(String(e)) }, warn: () => {} } } as never) as string
      expect(errors).toEqual([])
      expect(diffCanonical(canonicalizeSvg(vega.svg), canonicalizeSvg(mine)).slice(0, 3)).toEqual([])
    }, 30_000)
  }
})
