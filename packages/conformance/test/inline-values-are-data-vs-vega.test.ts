// @vitest-environment node
/**
 * A dataset's `values` is an expression only when it is a `{signal}` (vega-parser `isSignal(data.values)`): rows and any other object
 * (a GeoJSON FeatureCollection, a single row) are data, whose fields are never read as expressions, however they are named. So a row
 * object holding `{signal: "..."}` deep inside neither fails the parse nor asks for an add-on, and a `{signal}` values still is one.
 */
import { describe, it, expect } from 'vitest'
import { renderSpec } from '@aster-charts/core'
import { addonsNeeded } from '@aster-charts/core/addons'
import { renderWithVegaChecked } from '../src/render-vega.js'
import { canonicalizeSvg, diffCanonical } from '../src/normalize.js'

const spec = (values: unknown): any => ({
  $schema: 'https://vega.github.io/schema/vega/v6.json',
  width: 100, height: 50, padding: 5,
  data: [{ name: 't', values }],
  marks: [{ type: 'text', from: { data: 't' }, encode: { update: { x: { value: 10 }, y: { signal: '10 + 12 * (datum.a || 0)' }, text: { signal: 'datum.a + ":" + (isValid(datum.data) ? datum.data : "")' } } } }],
})

const CASES: Record<string, any> = {
  'an object row whose field is a broken {signal}': spec({ a: 1, f: { signal: 'nope(' } }),
  'an object row whose field calls an add-on function': spec({ a: 2, f: { signal: 'sampleNormal()' }, g: { expr: 'random()' } }),
  'a FeatureCollection whose properties look like signals': spec({ type: 'FeatureCollection', a: 3, features: [{ type: 'Feature', properties: { signal: 'nope(', update: 'x(' }, geometry: null }] }),
  'array rows whose fields look like signals': spec([{ a: 1, signal: 'nope(' }, { a: 2, f: { signal: 'sampleNormal()' } }]),
  'a {signal} values is still an expression': spec({ signal: '[{a: 1}, {a: 2}, {a: 3}]' }),
}

describe('inline values are data unless they are a {signal}', () => {
  for (const [name, s] of Object.entries(CASES)) {
    it(name, async () => {
      const vega = await renderWithVegaChecked(JSON.parse(JSON.stringify(s)))
      expect(vega.errors).toEqual([])
      const errors: unknown[] = []
      const mine = renderSpec(JSON.parse(JSON.stringify(s)), { logger: { error: (e: unknown) => { errors.push(e) }, warn: () => {} } } as never) as string
      expect(errors).toEqual([])
      expect(diffCanonical(canonicalizeSvg(vega.svg), canonicalizeSvg(mine)).slice(0, 3)).toEqual([])
      // (no add-on is needed for data: these specs use none)
      expect(addonsNeeded(JSON.parse(JSON.stringify(s)))).toEqual([])
    }, 30_000)
  }
})
