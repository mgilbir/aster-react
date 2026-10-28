// @vitest-environment node
/**
 * A time axis `format` that is an object is vega-format's multi-format specifier: one pattern per interval level
 * (millisecond ... year), the missing ones taking the defaults.
 */
import { describe, it, expect } from 'vitest'
import { renderSpec } from '@aster/core'
import { renderWithVegaChecked } from '../src/render-vega.js'
import { canonicalizeSvg, diffCanonical } from '../src/normalize.js'

const D = (y: number, m: number, d = 1, h = 0, mi = 0): number => Date.UTC(y, m, d, h, mi)
const spec = (type: 'time' | 'utc', domain: number[], axis: Record<string, unknown>): any => ({
  $schema: 'https://vega.github.io/schema/vega/v5.json',
  width: 500,
  height: 50,
  padding: 5,
  scales: [{ name: 'x', type, domain, range: 'width' }],
  axes: [{ orient: 'bottom', scale: 'x', ...axis }],
})
const YEARS = [D(2006, 0), D(2009, 11)]
const MONTHS = [D(2006, 0), D(2007, 2)]
const DAYS = [D(2006, 0, 1), D(2006, 0, 20)]
const HOURS = [D(2006, 0, 1, 0), D(2006, 0, 2, 6)]
const CASES: Array<[string, any]> = [
  ['year and quarter levels', spec('time', MONTHS, { format: { year: '%y', quarter: '%b' }, tickCount: 12 })],
  ['years', spec('time', YEARS, { format: { year: '%y' }, tickCount: 6 })],
  ['months', spec('time', MONTHS, { format: { month: '%b %Y', quarter: '%q' }, tickCount: 10 })],
  ['days and weeks', spec('time', DAYS, { format: { day: '%d', week: 'wk %U' }, tickCount: 10 })],
  ['hours', spec('time', HOURS, { format: { hours: '%H:00', day: '%b %d' }, tickCount: 10 })],
  ['utc', spec('utc', MONTHS, { format: { year: '%y', quarter: '%b' }, tickCount: 12 })],
  ['an empty object (all defaults)', spec('time', MONTHS, { format: {}, tickCount: 12 })],
  ['a string format, for comparison', spec('time', MONTHS, { format: '%b %y', tickCount: 12 })],
]
describe('a time axis with an object format', () => {
  for (const [name, s] of CASES) {
    it(name, async () => {
      const vega = await renderWithVegaChecked(JSON.parse(JSON.stringify(s)))
      expect(vega.errors).toEqual([])
      const errors: unknown[] = []
      const mine = renderSpec(JSON.parse(JSON.stringify(s)), { logger: { error: (e: unknown) => { errors.push(e) }, warn: () => {} } } as never) as string
      expect(errors).toEqual([])
      expect(diffCanonical(canonicalizeSvg(vega.svg), canonicalizeSvg(mine)).slice(0, 3)).toEqual([])
    }, 30_000)
  }
})
