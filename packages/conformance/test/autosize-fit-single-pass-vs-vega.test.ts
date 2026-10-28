// @vitest-environment node
/**
 * autosize fit / fit-x / fit-y: viewSizeLayout measures the overflow of the FIRST pass and sizes the content to the viewport minus
 * it; the pass that follows (the width signal changed) does not run the layout again. So an overflow that depends on the content's
 * width -- a title text wider than the view, anchored to the bounds -- is measured once, at the unfitted width, and the view keeps
 * that padding whatever the second pass overflows by.
 */
import { describe, it, expect } from 'vitest'
import { renderSpec } from '@aster/core'
import { renderWithVegaChecked } from '../src/render-vega.js'
import { canonicalizeSvg, diffCanonical } from '../src/normalize.js'

const LONG = 'Passenger Traffic at Seattle-Tacoma International Airport, One Year to the Next'
const spec = (autosize: unknown, title: Record<string, unknown> | undefined, extra: Record<string, unknown> = {}): any => ({
  $schema: 'https://vega.github.io/schema/vega/v5.json',
  width: 400,
  height: 200,
  padding: 5,
  autosize,
  scales: [{ name: 'x', type: 'linear', domain: [0, 10], range: 'width', padding: 20 }, { name: 'y', type: 'linear', domain: [0, 10], range: 'height', nice: false }],
  axes: [{ orient: 'bottom', scale: 'x', values: [0, 5, 10] }, { orient: 'left', scale: 'y', values: [0, 5, 10] }],
  marks: [{ type: 'symbol', encode: { update: { x: { scale: 'x', value: 5 }, y: { scale: 'y', value: 5 } } } }],
  ...(title ? { title } : {}),
  ...extra,
})
const CASES: Record<string, any> = {
  'fit, a title wider than the view, anchored to the bounds': spec({ type: 'fit', contains: 'padding' }, { text: LONG, frame: 'bounds', anchor: 'start', offset: 12 }),
  'fit, no contains, a long title': spec('fit', { text: LONG, anchor: 'start' }),
  'fit-x, a long title at the end': spec('fit-x', { text: LONG, anchor: 'end', frame: 'bounds' }),
  'fit-y with a long left axis title': spec('fit-y', undefined, { axes: [{ orient: 'bottom', scale: 'x', values: [0, 5, 10] }, { orient: 'left', scale: 'y', values: [0, 5, 10], title: 'a left axis title that is rather long' }] }),
  'fit, a title that fits': spec('fit', { text: 'short' }),
  'fit with scale padding and no title (the padding shrinks the domain)': spec({ type: 'fit', contains: 'padding' }, undefined),
}
describe('autosize fit measures the overflow once', () => {
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
