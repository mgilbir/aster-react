// @vitest-environment node
/**
 * Bounds that drive the autosize padding: an arc sweeps from its start angle to its end angle in either direction (a stack emits
 * descending ones) and covers the interval between them; a polar text (`radius`, `theta`) is anchored at the offset point.
 */
import { describe, it, expect } from 'vitest'
import { renderSpec } from '@aster/core'
import { renderWithVegaChecked } from '../src/render-vega.js'
import { canonicalizeSvg, diffCanonical } from '../src/normalize.js'

const frame = { $schema: 'https://vega.github.io/schema/vega/v5.json', width: 120, height: 120, padding: 5 }
const TAU = 2 * Math.PI
const arc = (start: number, end: number, extra: Record<string, unknown> = {}): any => ({
  ...frame,
  marks: [{ type: 'arc', encode: { update: { x: { value: 60 }, y: { value: 60 }, outerRadius: { value: 70 }, startAngle: { value: start }, endAngle: { value: end }, fill: { value: 'tomato' }, stroke: { value: 'white' }, ...extra } } }],
})
const polar = (radius: number, theta: number, extra: Record<string, unknown> = {}): any => ({
  ...frame,
  marks: [{ type: 'text', encode: { update: { x: { value: 60 }, y: { value: 60 }, radius: { value: radius }, theta: { value: theta }, text: { value: 'label' }, align: { value: 'center' }, baseline: { value: 'middle' }, ...extra } } }],
})
const CASES: Array<[string, any]> = [
  ['an ascending arc across 9 o\'clock', arc(Math.PI * 0.6, Math.PI * 1.6)],
  ['a descending arc across 9 o\'clock', arc(Math.PI * 1.6, Math.PI * 0.6)],
  ['a descending arc across 3 o\'clock', arc(1.2, -0.8)],
  ['a descending arc, less than a quarter', arc(0.9, 0.2)],
  ['a descending arc, more than a half', arc(5.5, 0.4)],
  ['a descending arc from a full turn', arc(TAU, 0.1)],
  ['a descending arc with an inner radius', arc(4.2, 1.1, { innerRadius: { value: 20 } })],
  ['a descending arc with an inner radius and no stroke', arc(4.2, 1.1, { innerRadius: { value: 20 }, stroke: { value: null } })],
  ['an arc past a full turn', arc(0, TAU + 0.5)],
  ['a polar text to the right', polar(80, Math.PI / 2)],
  ['a polar text below', polar(80, Math.PI)],
  ['a polar text to the left', polar(90, -Math.PI / 2)],
  ['a polar text above, rotated', polar(80, 0, { angle: { value: 25 } })],
  ['a polar text with an offset and a font size', polar(75, 2.2, { dx: { value: 4 }, dy: { value: -3 }, fontSize: { value: 18 } })],
]
describe('mark bounds under autosize pad', () => {
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
