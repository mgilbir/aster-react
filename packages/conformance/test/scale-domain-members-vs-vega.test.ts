// @vitest-environment node
/**
 * A scale domain of several `fields` takes a data field, a literal array, or a `{signal}` per member. The signal's value is
 * ingested as vega-util `array(value)`: a scalar is one value, an array its elements, null/undefined none.
 */
import { describe, it, expect } from 'vitest'
import { renderSpec } from '@aster/core'
import { renderWithVegaChecked } from '../src/render-vega.js'
import { canonicalizeSvg, diffCanonical } from '../src/normalize.js'

const frame = { $schema: 'https://vega.github.io/schema/vega/v5.json', width: 200, height: 80, padding: 5 }
const base = (type: string, fields: unknown[], sig: unknown, extra: Record<string, unknown> = {}): any => ({
  ...frame,
  signals: [{ name: 's', value: sig }],
  data: [{ name: 'd', values: [{ g: 2, n: 5 }, { g: 0, n: 40 }, { g: 1, n: 12 }, { g: 2, n: 30 }] }],
  scales: [{ name: 'k', type, domain: { fields, ...extra }, range: type === 'ordinal' ? ['red', 'green', 'blue', 'orange', 'purple', 'black'] : 'width' }],
  ...(type === 'ordinal' ? { legends: [{ fill: 'k' }] } : { axes: [{ orient: 'bottom', scale: 'k' }] }),
})
const CASES: Record<string, any> = {
  'ordinal: a data field and a scalar signal': base('ordinal', [{ data: 'd', field: 'g' }, { signal: 's' }], 77, { sort: true }),
  'ordinal: a data field and an array signal': base('ordinal', [{ data: 'd', field: 'g' }, { signal: 's' }], [7, 8], { sort: true }),
  'ordinal: a null signal adds nothing': base('ordinal', [{ data: 'd', field: 'g' }, { signal: 's' }], null, { sort: true }),
  'ordinal: a string signal': base('ordinal', [{ data: 'd', field: 'g' }, { signal: 's' }], 'extra', { sort: true }),
  'ordinal: unsorted keeps first appearance': base('ordinal', [{ data: 'd', field: 'g' }, { signal: 's' }], 9),
  'ordinal: a literal array and a scalar signal': base('ordinal', [[5, 3], { signal: 's' }], 4, { sort: true }),
  'linear: a data field and a scalar signal': base('linear', [{ data: 'd', field: 'n' }, { signal: 's' }], 100),
  'linear: a data field and an array signal': base('linear', [{ data: 'd', field: 'n' }, { signal: 's' }], [-10, 60]),
  'time: signals that are tuples ({data: date}), as vega-lite writes a custom domain': {
    ...frame,
    scales: [{ name: 'k', type: 'time', domain: { fields: [{ signal: '{data: datetime(2017, 6, 14)}' }, { signal: '{data: datetime(2017, 6, 20)}' }] }, range: [0, 200] }],
    axes: [{ orient: 'bottom', scale: 'k' }],
  },
  'linear: a signal that is a tuple': base('linear', [{ data: 'd', field: 'n' }, { signal: 's' }], { data: 100 }),
  'linear: a signal that is a tuple without data': base('linear', [{ data: 'd', field: 'n' }, { signal: 's' }], { other: 100 }),
  'linear: a literal array of tuples and numbers': base('linear', [[{ data: 90 }, 3], { data: 'd', field: 'n' }], 0),
  'quantile': { ...base('quantile', [{ data: 'd', field: 'n' }, { signal: 's' }], 100), scales: [{ name: 'k', type: 'quantile', domain: { fields: [{ data: 'd', field: 'n' }, { signal: 's' }] }, range: ['red', 'green'] }], axes: undefined, legends: [{ fill: 'k' }] },
}
describe('scale domain members', () => {
  for (const [name, s] of Object.entries(CASES)) {
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
