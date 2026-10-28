// @vitest-environment node
/**
 * Transforms that publish a `signal` (vega-transforms TimeUnit, ...): the value a later expression reads off it must be the one
 * vega publishes. A text mark shows the expression's value, so the render compares it with the real vega.
 */
import { describe, it, expect } from 'vitest'
import { renderSpec } from '@aster/core'
import { renderWithVegaChecked } from '../src/render-vega.js'
import { canonicalizeSvg, diffCanonical } from '../src/normalize.js'

const HOUR = 3600_000
const DAY = 24 * HOUR
const rows = [0, 1, 2, 5, 9, 14, 30, 33].map((k, i) => ({ t: Date.UTC(2012, 0, 1) + k * DAY + (i % 3) * 5 * HOUR, v: i }))
const show = (expr: string): any[] => [{ type: 'text', encode: { update: { x: { value: 5 }, y: { value: 20 }, text: { signal: expr } } } }]
const spec = (tu: Record<string, unknown>, expr: string): any => ({
  $schema: 'https://vega.github.io/schema/vega/v5.json',
  width: 400,
  height: 60,
  data: [{ name: 'd', values: rows, transform: [{ type: 'timeunit', field: 't', signal: 'tbin', ...tu }] }],
  marks: show(expr),
})
const INFO = "join([tbin.unit, tbin.step, join(tbin.units, '+'), toNumber(tbin.start), toNumber(tbin.stop)], ' ')"
const CASES: Array<[string, Record<string, unknown>, string]> = [
  ['explicit units', { units: ['year', 'month', 'date'] }, INFO],
  ['explicit units with a step', { units: ['year', 'month', 'date', 'hours'], step: 6 }, INFO],
  ['units from a signal', { units: { signal: "['year', 'month']" } }, INFO],
  ['units from the extent (maxbins)', { maxbins: 6 }, INFO],
  ['units inferred from the data', { inferUnits: true }, INFO],
  ['utc', { units: ['year', 'month', 'date'], timezone: 'utc' }, INFO],
  ['without the interval', { units: ['year', 'month', 'date'], interval: false }, INFO],
  ['used by timeSequence', { units: ['year', 'month', 'date'] }, "length(timeSequence(tbin.unit, tbin.start, tbin.stop))"],
]
describe('the signal a timeunit transform publishes', () => {
  for (const [name, tu, expr] of CASES) {
    it(name, async () => {
      const s = spec(tu, expr)
      const vega = await renderWithVegaChecked(JSON.parse(JSON.stringify(s)))
      expect(vega.errors).toEqual([])
      const errors: unknown[] = []
      const mine = renderSpec(JSON.parse(JSON.stringify(s)), { logger: { error: (e: unknown) => { errors.push(e) }, warn: () => {} } } as never) as string
      expect(errors).toEqual([])
      expect(vega.svg).toMatch(/<text[^>]*>[^<]+</)
      expect(diffCanonical(canonicalizeSvg(vega.svg), canonicalizeSvg(mine)).slice(0, 3)).toEqual([])
    }, 30_000)
  }
})
