// @vitest-environment node
/**
 * Whether a continuous position scale reaches zero when the spec does not say (`zeroByDefault`), against vega-lite 6.4.3: for every
 * mark, the axes of a spec with two measures, and each orientation asked for. The zero that vega-lite compiles into the x and y scales
 * is the one the function must give for the mark, the axis and the orientation the mark settles on.
 */
import { describe, it, expect } from 'vitest'
import * as vl from 'vega-lite'
import { zeroByDefault } from '../../vl/src/scaleprops.js'

const MARKS = ['bar', 'area', 'line', 'trail', 'point', 'circle', 'square', 'tick', 'rule', 'text']
const DATA = Array.from({ length: 12 }, (_, i) => ({ a: i + 1, b: (i * 5) % 11 + 1 }))
const silent: any = { level: () => silent, warn: () => silent, info: () => silent, debug: () => silent, error: () => silent }

describe('zeroByDefault is what vega-lite compiles', () => {
  for (const mark of MARKS) {
    for (const orient of ['vertical', 'horizontal'] as const) {
      it(`${mark}, ${orient}`, () => {
        const spec = { data: { values: DATA }, mark: { type: mark, orient }, encoding: { x: { field: 'a', type: 'quantitative' }, y: { field: 'b', type: 'quantitative' } } }
        const compiled = (vl as any).compile(spec, { logger: silent }).spec
        for (const channel of ['x', 'y']) {
          const scale = compiled.scales.find((s: any) => s.name === channel)
          expect(scale.zero, `${mark} ${orient}: vega-lite's zero on ${channel}`).toBeDefined()
          // (a trail has no orientation to ask for: vega-lite runs it vertically whatever is asked)
          const settled = mark === 'trail' ? 'vertical' : orient
          expect(zeroByDefault(mark, channel, settled), `${mark} ${orient}, ${channel}`).toBe(scale.zero)
        }
      })
    }
  }
  it('is true off the position channels', () => {
    for (const mark of MARKS) for (const channel of ['color', 'size', 'theta', 'radius']) expect(zeroByDefault(mark, channel, 'vertical')).toBe(true)
  })
  it('is true whatever the orientation of a mark that runs along no axis', () => {
    for (const mark of ['point', 'circle', 'square', 'tick', 'rule', 'text', 'rect', 'arc']) for (const orient of ['vertical', 'horizontal']) for (const channel of ['x', 'y']) expect(zeroByDefault(mark, channel, orient)).toBe(true)
  })
})
