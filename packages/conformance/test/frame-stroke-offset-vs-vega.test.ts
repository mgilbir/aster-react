// @vitest-environment node
/**
 * The root frame's border sits on the pixel grid as vega-scenegraph's group does it: a stroke between 0.5 and 1.5 wide (1 when it names
 * no width) is inset by 0.5 - |width - 1|, any other by nothing. The frame was inset by half a pixel when its stroke had no width of its
 * own, and by nothing when it had one - a view stroke of width 1 written as 1 drew its border half a pixel off.
 */
import { describe, it, expect } from 'vitest'
import { renderSpec } from '@aster-charts/core'
import { renderWithVegaChecked } from '../src/render-vega.js'
import { canonicalizeSvg, diffCanonical } from '../src/normalize.js'

const WIDTHS: Array<number | undefined> = [undefined, 0, 0.25, 0.5, 0.51, 0.75, 1, 1.25, 1.49, 1.5, 2, 3]

describe('the frame stroke offset', () => {
  for (const strokeWidth of WIDTHS) {
    for (const cornerRadius of [undefined, 6]) {
      it(`stroke width ${strokeWidth ?? 'unset'}${cornerRadius === undefined ? '' : `, corner radius ${cornerRadius}`}`, async () => {
        const spec = {
          $schema: 'https://vega.github.io/schema/vega/v5.json',
          width: 120,
          height: 60,
          style: 'cell',
          config: { style: { cell: { stroke: '#ddd', ...(strokeWidth === undefined ? {} : { strokeWidth }), ...(cornerRadius === undefined ? {} : { cornerRadius }) } } },
          marks: [{ type: 'rect', encode: { update: { x: { value: 5 }, y: { value: 5 }, width: { value: 10 }, height: { value: 10 } } } }],
        }
        const vega = await renderWithVegaChecked(JSON.parse(JSON.stringify(spec)))
        expect(vega.errors).toEqual([])
        const mine = renderSpec(JSON.parse(JSON.stringify(spec))) as string
        expect(diffCanonical(canonicalizeSvg(vega.svg), canonicalizeSvg(mine)).slice(0, 3)).toEqual([])
      }, 30_000)
    }
  }
})
