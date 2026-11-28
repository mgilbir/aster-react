// @vitest-environment node
/**
 * A `datum` given as an expression (`{datum: {expr: "p"}}`), on every channel and mark, with and without a type, against vega-lite 6.4.3.
 *
 * Where a scale reads the datum, vega-lite refuses the definition without a `type` ("Invalid field type undefined") and with one writes the
 * expression object into the scale's domain, a chart Vega cannot run ("Unsupported object"). Such a spec is refused here with a
 * VLCompileError (DECISIONS Q9: where vega-lite compiles a wrong chart, refuse). Where nothing scales the datum (a secondary position, a
 * text, a tooltip, a channel the mark does not draw) vega-lite's chart runs, and the one compiled here is held to it.
 */
import { describe, it, expect } from 'vitest'
import * as vl from 'vega-lite'
import { compile, VLCompileError } from '@aster-charts/vl'
import { renderWithVega } from '../src/render-vega.js'
import { check, plain } from './vl-parity-check.js'

const DATA = { values: [{ x: 1, y: 2 }, { x: 3, y: 5 }] }
const CHANNELS = ['x', 'y', 'x2', 'y2', 'theta', 'radius', 'xOffset', 'yOffset', 'color', 'fill', 'stroke', 'opacity', 'fillOpacity', 'strokeOpacity', 'strokeWidth', 'strokeDash', 'size', 'shape', 'angle', 'text', 'tooltip', 'href', 'description', 'detail', 'order', 'key'] as const
const MARKS = ['point', 'circle', 'square', 'bar', 'rule', 'tick', 'text', 'line', 'area', 'trail', 'arc', 'rect'] as const

async function vegaLiteChart(spec: Record<string, unknown>): Promise<'refused' | 'fails' | Record<string, unknown>> {
  let out: Record<string, unknown>
  try { out = (vl as unknown as { compile: (s: unknown, o: unknown) => { spec: Record<string, unknown> } }).compile(plain(spec), { logger: { level: () => null, warn() {}, info() {}, debug() {}, error() {} } }).spec } catch { return 'refused' }
  // (an expression the compiler wrote as an object literal, `format({"expr": "p"}, "")`, reads the object, not the parameter: a chart that
  // prints "[object Object]", which Vega runs without a word)
  if (JSON.stringify(out).includes('{\\"expr\\"')) return 'fails'
  try { await renderWithVega(plain(out)); return out } catch { return 'fails' }
}

for (const mark of MARKS) {
  describe(`@aster-charts/vl == vega-lite: a datum expression on a ${mark}`, () => {
    for (const channel of CHANNELS) {
      for (const type of [undefined, 'quantitative', 'nominal'] as const) {
        it(`${channel}${type === undefined ? '' : ` ${type}`}`, async () => {
          const spec = { data: DATA, params: [{ name: 'p', value: 4 }], mark, encoding: { x: { field: 'x', type: 'quantitative' }, y: { field: 'y', type: 'quantitative' }, [channel]: { datum: { expr: 'p' }, ...(type === undefined ? {} : { type }) } } }
          const theirs = await vegaLiteChart(spec)
          if (theirs === 'refused' || theirs === 'fails') {
            expect(() => compile(plain(spec) as never), `vega-lite ${theirs === 'refused' ? 'refuses' : 'compiles a chart Vega cannot run for'} this spec`).toThrow(VLCompileError)
          } else {
            await check(plain(spec))
          }
        }, 30_000)
      }
    }
  })
}
