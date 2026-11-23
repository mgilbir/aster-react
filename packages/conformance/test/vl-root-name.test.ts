// @vitest-environment node
/**
 * A view nested in the spec under the root view's own `name` (C428), against vega-lite 6.4.3 through real Vega, over where it sits (a
 * concat view, a layer in a concat, a layer of a layer root, a facet's or a repeat's spec) x what it draws (bars over steps, points).
 * A name draws nothing, so renaming the nested view must not change vega-lite's drawing; where it does, vega-lite's output is wrong
 * (the view is sized by the root's signals) and @aster-charts/vl refuses the spec (DECISIONS Q9). Elsewhere both draw the same.
 */
import { describe, it, expect } from 'vitest'
import * as vl from 'vega-lite'
import { compile, VLCompileError } from '@aster-charts/vl'
import { renderWithVegaChecked } from '../src/render-vega.js'
import { canonicalizeSvg } from '../src/normalize.js'
import { drawsLikeVegaLite, caseName } from './vl-composition-render.js'

const data = { values: [{ a: 'A', b: 28, d: 1 }, { a: 'B', b: 55, d: 2 }, { a: 'C', b: 43, d: 3 }, { a: 'A', b: 12, d: 4 }] }
const bar = { mark: 'bar', encoding: { x: { field: 'a', type: 'nominal' }, y: { field: 'b', type: 'quantitative' } } }
const pt = { mark: 'point', encoding: { x: { field: 'd', type: 'quantitative' }, y: { field: 'b', type: 'quantitative' } } }
type View = Record<string, unknown>

const SHAPES: Array<[string, (v: View, name: string) => View]> = [
  ['a concat view', (v, name) => ({ data, name: 'r', hconcat: [{ ...v, name }, bar] })],
  ['a layer in a concat', (v, name) => ({ data, name: 'r', hconcat: [bar, { layer: [{ ...v, name }] }] })],
  ['a layer of a layer root', (v, name) => ({ data, name: 'r', layer: [{ ...v, name }] })],
  ['a facet\'s spec', (v, name) => ({ data, name: 'r', facet: { column: { field: 'a', type: 'nominal' } }, spec: { ...v, name } })],
  ['a repeat\'s spec', (v, name) => ({ data, name: 'r', repeat: ['b', 'd'], spec: { ...v, name, encoding: { ...(v.encoding as object), y: { field: { repeat: 'repeat' }, type: 'quantitative' } } } })],
]
const quiet = { level: () => quiet, warn: () => quiet, info: () => quiet, debug: () => quiet, error: () => quiet }
const vlSvg = async (spec: View): Promise<string> => canonicalizeSvg((await renderWithVegaChecked((vl as any).compile(JSON.parse(JSON.stringify(spec)), { logger: quiet }).spec)).svg)

describe('a view named as the root view', () => {
  for (const [shName, shape] of SHAPES) {
    for (const [vName, v] of [['bars', bar], ['points', pt]] as const) {
      it(caseName(shName, vName), async () => {
        const same = shape(v, 'r')
        const renamed = shape(v, 'other')
        await drawsLikeVegaLite(renamed)
        let refused: unknown
        try { compile(JSON.parse(JSON.stringify(same))) } catch (e) { refused = e }
        if (refused !== undefined) {
          expect(refused).toBeInstanceOf(VLCompileError)
          expect(String((refused as Error).message)).toMatch(/named as the root view/)
          expect(await vlSvg(same), 'refused only where the name changes what vega-lite draws').not.toBe(await vlSvg(renamed))
        } else {
          await drawsLikeVegaLite(same)
        }
      }, 30_000)
    }
  }
})
