// @vitest-environment node
/**
 * A dataset whose transform reads a signal that is computed from ANOTHER dataset (a bin whose `span` is the range of a selection,
 * `span(brush["t"])`, where `brush` is `vlSelectionResolve("brush_store", ...)`): vega runs the store, then the signal, then the
 * bin. A text mark shows the bins, so the render compares them with the real vega.
 */
import { describe, it, expect } from 'vitest'
import { renderSpec } from '@aster/core'
import { renderWithVegaChecked } from '../src/render-vega.js'
import { canonicalizeSvg, diffCanonical } from '../src/normalize.js'

const rows = [1, 2, 3, 5, 6, 8, 9, 13, 21, 22].map((t, i) => ({ t, v: i }))
const spec = (bin: Record<string, unknown>, sig: Record<string, unknown>[]): any => ({
  $schema: 'https://vega.github.io/schema/vega/v5.json',
  width: 400,
  height: 60,
  signals: sig,
  data: [
    // (declared before the dataset that reads them: the order vega-lite writes)
    { name: 'brush_store', transform: [{ type: 'collect' }] },
    { name: 'src', values: rows, transform: [{ type: 'extent', field: 't', signal: 'ext' }, { type: 'bin', field: 't', as: ['b0', 'b1'], signal: 'bins', extent: { signal: 'ext' }, maxbins: 4, ...bin }] },
    { name: 'counts', source: 'src', transform: [{ type: 'aggregate', groupby: ['b0', 'b1'] }] },
  ],
  marks: [{ type: 'text', from: { data: 'counts' }, encode: { update: { x: { value: 5 }, y: { field: 'b0', mult: 2 }, text: { signal: "datum.b0 + '-' + datum.b1 + ' ' + datum.count" } } } }],
})
const SEL = { name: 'brush', update: 'vlSelectionResolve("brush_store", "union")' }
const CASES: Array<[string, Record<string, unknown>, Record<string, unknown>[]]> = [
  ['a span read off a selection (empty store)', { span: { signal: 'span(brush["t"])' } }, [SEL]],
  ['a span read off a selection declared after another signal', { span: { signal: 'span(brush["t"])' } }, [{ name: 'k', value: 3 }, SEL]],
  ['a span from a signal computed from a selection', { span: { signal: 'wide' } }, [SEL, { name: 'wide', update: 'span(brush["t"])' }]],
  ['no span at all', {}, [SEL]],
]
describe('a dataset that reads a signal computed from another dataset', () => {
  for (const [name, bin, sig] of CASES) {
    it(name, async () => {
      const s = spec(bin, sig)
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

// vega-util span: `array && (peek(array) - array[0]) || 0`, so a missing or empty array spans nothing (it is what a selection that
// holds nothing yet gives a bin's `span`)
describe('span() of a missing, an empty and a real range', () => {
  const SPANS = ['span([1, 5])', 'span([5, 1])', 'span([3])', 'span([])', 'span(null)', 'span(nothing)', 'span({}["t"])']
  for (const expr of SPANS) {
    it(expr, async () => {
      const s: any = {
        $schema: 'https://vega.github.io/schema/vega/v5.json',
        width: 200,
        height: 40,
        signals: [{ name: 'nothing', update: '{}.x' }],
        marks: [{ type: 'text', encode: { update: { x: { value: 5 }, y: { value: 20 }, text: { signal: `"" + ${expr}` } } } }],
      }
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
