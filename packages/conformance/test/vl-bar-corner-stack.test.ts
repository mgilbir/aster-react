// @vitest-environment node
/**
 * A rounded bar's stack is clipped in one group that carries the radii (vega-lite mark.ts getStackGroup), also when the bar has no
 * dimension channel: the rows are then one stack, grouped by nothing (C442: a typeless `y` with a linear scale on a rounded bar drew
 * flat rects). Every combination below is held to vega-lite's chart, in real Vega.
 */
import { describe, it } from 'vitest'
import { drawsLikeVegaLite, caseName } from './vl-composition-render.js'

const data = { values: [{ a: 'A', b: 28, c: 'x' }, { a: 'B', b: 55, c: 'y' }, { a: 'C', b: 43, c: 'x' }, { a: 'A', b: 12, c: 'y' }] }
const RADII: Array<[string, Record<string, unknown>]> = [['cornerRadius', { cornerRadius: 3 }], ['cornerRadiusEnd', { cornerRadiusEnd: 4 }], ['cornerRadiusTopLeft', { cornerRadiusTopLeft: 5 }]]
const MEASURES: Array<[string, Record<string, unknown>]> = [['typed', { field: 'b', type: 'quantitative' }], ['typeless, linear scale', { field: 'b', scale: { type: 'linear' } }], ['summed', { field: 'b', type: 'quantitative', aggregate: 'sum' }]]

describe('a rounded bar is clipped in its stack\'s group, as vega-lite draws it', () => {
  for (const [rName, radius] of RADII) {
    for (const [mName, measure] of MEASURES) {
      for (const horizontal of [false, true]) {
        const [m, d] = horizontal ? ['x', 'y'] : ['y', 'x']
        for (const [dName, dim] of [['no dimension', undefined], ['a nominal dimension', { field: 'a', type: 'nominal' }]] as const) {
          for (const colour of [false, true]) {
            const encoding: Record<string, unknown> = { [m]: measure, ...(dim ? { [d]: dim } : {}), ...(colour ? { color: { field: 'c', type: 'nominal' } } : {}) }
            const spec = { data, mark: { type: 'bar', ...radius, ...(horizontal ? { orient: 'horizontal' } : {}) }, encoding }
            it(caseName(rName, mName, horizontal ? 'horizontal' : 'vertical', dName, colour && 'coloured'), () => drawsLikeVegaLite(spec), 30_000)
          }
        }
      }
    }
  }
})
