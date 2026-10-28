// @vitest-environment node
/**
 * The ticks of a scale with `bins`: vega-encode AxisTicks asks tickCount(scale, count, minstep), which raises the count to the
 * number of bin boundaries, and tickValues then takes the boundaries (thinned only when there are more than that count).
 */
import { describe, it, expect } from 'vitest'
import { renderSpec } from '@aster/core'
import { renderWithVegaChecked } from '../src/render-vega.js'
import { canonicalizeSvg, diffCanonical } from '../src/normalize.js'

const spec = (axis: Record<string, unknown>, bins: unknown, domain: unknown = [0, 10]): any => ({
  $schema: 'https://vega.github.io/schema/vega/v5.json',
  width: 300,
  height: 60,
  padding: 5,
  signals: [{ name: 'b', value: { start: 0, stop: 10, step: 0.25 } }],
  scales: [{ name: 'x', type: 'linear', domain, range: 'width', bins, zero: false }],
  axes: [{ orient: 'bottom', scale: 'x', ...axis }],
})
const CASES: Array<[string, any]> = [
  ['tickCount below the number of bins (a step object)', spec({ tickCount: 5 }, { step: 0.5 })],
  ['tickCount above the number of bins', spec({ tickCount: 100 }, { step: 1 })],
  ['tickCount from a signal expression', spec({ tickCount: { signal: 'ceil(width / 10)' } }, { step: 0.25 })],
  ['bins as a signal object', spec({ tickCount: { signal: 'ceil(width / 10)' } }, { signal: 'b' }, { signal: '[b.start, b.stop]' })],
  ['bins as an explicit array', spec({ tickCount: 3 }, [0, 1, 2.5, 4, 7, 10])],
  ['bins with tickMinStep', spec({ tickCount: 40, tickMinStep: 2 }, { step: 0.25 })],
  ['no tickCount (the default of 10)', spec({}, { step: 0.25 })],
  ['bins with a start and a stop inside the domain', spec({ tickCount: 4 }, { start: 2, stop: 8, step: 0.5 })],
]
describe('axis ticks of a scale with bins', () => {
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
