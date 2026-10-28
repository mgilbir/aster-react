// @vitest-environment node
/**
 * The bounds of a symbol (vega-scenegraph markItemPath: the shape's path traced by boundContext, rotated by the angle, inflated by
 * the stroke) drive the view's padding under autosize pad. A symbol at the edge of the view makes the overflow visible.
 */
import { describe, it, expect } from 'vitest'
import { renderSpec } from '@aster/core'
import { renderWithVegaChecked } from '../src/render-vega.js'
import { canonicalizeSvg, diffCanonical } from '../src/normalize.js'

const PERSON = 'M1.7 -1.7h-0.8c0.3 -0.2 0.6 -0.5 0.6 -0.9c0 -0.6 -0.4 -1 -1 -1c-0.6 0 -1 0.4 -1 1c0 0.4 0.2 0.7 0.6 0.9h-0.8c-0.4 0 -0.7 0.3 -0.7 0.6v1.9c0 0.3 0.3 0.6 0.6 0.6h0.2c0 0 0 0.1 0 0.1v1.9c0 0.3 0.2 0.6 0.3 0.6h1.3c0.2 0 0.3 -0.3 0.3 -0.6v-1.8c0 0 0 -0.1 0 -0.1h0.2c0.3 0 0.6 -0.3 0.6 -0.6v-2c0.200 -0.3 -0.1 -0.6 -0.5 -0.6z'
const spec = (shape: string, extra: Record<string, unknown> = {}, x = 0, y = 0): any => ({
  $schema: 'https://vega.github.io/schema/vega/v5.json',
  width: 60,
  height: 60,
  padding: 5,
  marks: [{ type: 'symbol', encode: { update: { x: { value: x }, y: { value: y }, size: { value: 900 }, shape: { value: shape }, fill: { value: 'tomato' }, ...extra } } }],
})
const SHAPES = ['circle', 'square', 'cross', 'diamond', 'triangle-up', 'triangle-down', 'triangle-left', 'triangle-right', 'stroke', 'arrow', 'wedge', 'triangle', PERSON]
describe('symbol bounds drive the view padding', () => {
  for (const shape of SHAPES) {
    for (const [label, extra] of [['', {}], [' rotated', { angle: { value: 30 } }], [' stroked', { stroke: { value: 'black' }, strokeWidth: { value: 3 } }]] as Array<[string, Record<string, unknown>]>) {
      it(`${shape.length > 20 ? 'a custom path' : shape}${label}`, async () => {
        const s = spec(shape, extra)
        const vega = await renderWithVegaChecked(JSON.parse(JSON.stringify(s)))
        expect(vega.errors).toEqual([])
        const errors: unknown[] = []
        const mine = renderSpec(JSON.parse(JSON.stringify(s)), { logger: { error: (e: unknown) => { errors.push(e) }, warn: () => {} } } as never) as string
        expect(errors).toEqual([])
        expect(diffCanonical(canonicalizeSvg(vega.svg), canonicalizeSvg(mine)).slice(0, 3)).toEqual([])
      }, 30_000)
    }
  }
})
