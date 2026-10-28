// @vitest-environment node
/**
 * `background` is a view signal like `width`, `height` and `padding`: a spec that declares a signal of that name sets the view's
 * background through it (its value, or its update expression), over the spec's own `background`.
 */
import { describe, it, expect } from 'vitest'
import { renderSpec } from '@aster/core'
import { renderWithVegaChecked } from '../src/render-vega.js'
import { canonicalizeSvg, diffCanonical } from '../src/normalize.js'

const spec = (extra: Record<string, unknown>): any => ({
  $schema: 'https://vega.github.io/schema/vega/v5.json',
  width: 100,
  height: 50,
  padding: 5,
  marks: [{ type: 'rect', encode: { update: { x: { value: 5 }, y: { value: 5 }, width: { value: 20 }, height: { value: 10 }, fill: { value: 'steelblue' } } } }],
  ...extra,
})
const CASES: Record<string, any> = {
  'a signal with a value': spec({ signals: [{ name: 'background', value: '#ffeecc' }] }),
  'a signal with an update expression': spec({ signals: [{ name: 'k', value: 'red' }, { name: 'background', update: 'k' }] }),
  'the signal wins over the spec background': spec({ background: '#111111', signals: [{ name: 'background', value: '#eeeeff' }] }),
  'a signal with no value leaves the spec background': spec({ background: '#abcdef', signals: [{ name: 'background' }] }),
  'the spec background alone': spec({ background: '#abcdef' }),
  'a signal with a null value': spec({ background: '#abcdef', signals: [{ name: 'background', value: null }] }),
}
describe('the background signal', () => {
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
