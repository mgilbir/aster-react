// @vitest-environment node
/**
 * The color legend @aster/vl emits (gradient vs symbols, symbol type, reduced opacity, fill vs
 * stroke) must be vega-lite's for every mark and every color field type.
 */
import { describe, it, expect } from 'vitest'
import * as vl from 'vega-lite'
import { compile } from '@aster/vl'

const data = { values: [{ c: 'A', x: 1, y: 2, v: 5, t: '2024-01-01' }, { c: 'B', x: 2, y: 4, v: 9, t: '2024-02-01' }] }
const MARKS = ['bar', 'point', 'circle', 'square', 'line', 'tick', 'text', 'area', 'trail', 'rect', 'rule', 'arc']
const COLOR: Record<string, { field: string; type: string }> = {
  quantitative: { field: 'v', type: 'quantitative' },
  nominal: { field: 'c', type: 'nominal' },
  temporal: { field: 't', type: 'temporal' },
}

describe('legends match vega-lite', () => {
  for (const mark of MARKS) {
    for (const [kind, color] of Object.entries(COLOR)) {
      it(`${mark} colored by a ${kind} field`, () => {
        const encoding: Record<string, unknown> = {
          x: mark === 'bar' ? { field: 'c', type: 'nominal' } : { field: 'x', type: 'quantitative' },
          y: { field: 'y', type: 'quantitative' },
          color,
        }
        if (mark === 'text') encoding.text = { field: 'c', type: 'nominal' }
        if (mark === 'arc') { delete encoding.x; delete encoding.y; encoding.theta = { field: 'y', type: 'quantitative' } }
        const spec = { data, mark, encoding }
        const expected = (vl as any).compile(spec).spec.legends
        expect(JSON.parse(JSON.stringify(compile(spec as never).legends))).toEqual(expected)
      })
    }
  }
  for (const mark of ['bar', 'point', 'line', 'text', 'tick', 'circle']) {
    for (const channel of ['size', 'opacity', 'strokeWidth']) {
      for (const withColor of [false, true]) {
        it(`${mark} ${channel} legend${withColor ? ' beside a color legend' : ''}`, () => {
          const encoding: Record<string, unknown> = {
            x: mark === 'bar' ? { field: 'c', type: 'nominal' } : { field: 'x', type: 'quantitative' },
            y: { field: 'y', type: 'quantitative' },
            [channel]: { field: 'v', type: 'quantitative' },
            ...(withColor ? { color: { field: 'c', type: 'nominal' } } : {}),
          }
          if (mark === 'text') encoding.text = { field: 'c', type: 'nominal' }
          const spec = { data, mark, encoding }
          const pick = (lgs: any[]) => lgs.find((l) => l[channel])
          expect(JSON.parse(JSON.stringify(pick(compile(spec as never).legends as any[])))).toEqual(pick((vl as any).compile(spec).spec.legends))
        })
      }
    }
  }
})
