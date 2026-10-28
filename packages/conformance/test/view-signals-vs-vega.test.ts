// @vitest-environment node
/**
 * The signals vega defines on every view -- `width`, `height`, `padding` -- are readable from any expression. `padding` is the
 * spec's padding as an object ({left, top, right, bottom}, a number spread over the four sides), whatever autosize does.
 */
import { describe, it, expect } from 'vitest'
import { renderSpec } from '@aster/core'
import { renderWithVegaChecked } from '../src/render-vega.js'
import { canonicalizeSvg, diffCanonical } from '../src/normalize.js'

const spec = (padding: unknown, update: string, extra: Record<string, unknown> = {}): any => ({
  $schema: 'https://vega.github.io/schema/vega/v5.json',
  width: 120,
  height: 60,
  ...(padding === undefined ? {} : { padding }),
  signals: [{ name: 'k', update }],
  marks: [{ type: 'rect', encode: { update: { x: { value: 5 }, y: { signal: 'k' }, width: { value: 10 }, height: { value: 10 } } } }],
  ...extra,
})
const CASES: Array<[string, unknown, string, Record<string, unknown>?]> = [
  ['an object padding: one side', { top: 10, left: 40, bottom: 20, right: 10 }, '-(height + padding.bottom)'],
  ['an object padding: every side', { top: 1, left: 2, bottom: 3, right: 4 }, 'padding.top * 1000 + padding.left * 100 + padding.bottom * 10 + padding.right'],
  ['a number padding is spread over the sides', 7, 'padding.left + padding.right + padding.top + padding.bottom'],
  ['no padding: vega\'s default of 0', undefined, 'padding.left + 3'],
  ['a partial padding', { left: 9 }, 'padding.left + (padding.top || 0)'],
  ['the padding next to autosize none', { top: 4, left: 4, bottom: 4, right: 4 }, 'padding.top + 2', { autosize: 'none' }],
]

describe('the view signals', () => {
  for (const [name, padding, update, extra] of CASES) {
    it(name, async () => {
      const s = spec(padding, update, extra)
      const vega = await renderWithVegaChecked(JSON.parse(JSON.stringify(s)))
      expect(vega.errors).toEqual([])
      const errors: unknown[] = []
      const mine = renderSpec(JSON.parse(JSON.stringify(s)), { logger: { error: (e: unknown) => { errors.push(e) }, warn: () => {} } } as never) as string
      expect(errors).toEqual([])
      expect(diffCanonical(canonicalizeSvg(vega.svg), canonicalizeSvg(mine)).slice(0, 3)).toEqual([])
    }, 30_000)
  }
})
