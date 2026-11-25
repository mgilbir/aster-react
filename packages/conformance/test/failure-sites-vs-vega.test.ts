/**
 * Operators of a mark or a layout that throw, against real vega (C121, C398).
 *
 * A mark's `clip` given as an expression (`{signal}`, `{path: {signal}}`), a pre-faceted group mark over a datum whose field holds
 * no array (missing, null, a number, a string, an object), a `layout` parameter or a list parameter of a guide (`values: [{signal}]`)
 * that throws: vega's dataflow logs the error once and stops the run at that operator -- what was ranked before it is drawn, nothing
 * after it is. Aster threw raw exceptions out of `renderSpec` for the first two and said nothing for the last two. Generated over
 * every mark type for the clip, both forms, at the top level and in a group, marks before and after the failing one.
 */
import { describe, expect, it } from 'vitest'
import { renderSpec } from '@aster-charts/core'
import { renderWithVegaChecked } from '../src/render-vega.js'
import { canonicalizeSvg, diffCanonical } from '../src/normalize.js'

type Spec = Record<string, unknown>
const TYPES = ['rect', 'symbol', 'text', 'rule', 'path', 'arc', 'line', 'area', 'group'] as const
const enc = (type: string, x: number): Spec => ({
  x: { value: x }, y: { value: 10 },
  ...(type === 'rect' || type === 'group' ? { width: { value: 8 }, height: { value: 8 }, fill: { value: '#c33' } } : {}),
  ...(type === 'symbol' ? { size: { value: 60 }, fill: { value: '#33c' } } : {}),
  ...(type === 'text' ? { text: { value: 'T' } } : {}),
  ...(type === 'rule' ? { x2: { value: x + 10 }, stroke: { value: '#000' } } : {}),
  ...(type === 'path' ? { path: { value: 'M0,0L5,5' }, stroke: { value: '#000' } } : {}),
  ...(type === 'arc' ? { outerRadius: { value: 6 }, startAngle: { value: 0 }, endAngle: { value: 2 }, fill: { value: '#3c3' } } : {}),
  ...(type === 'line' || type === 'area' ? { stroke: { value: '#000' }, fill: { value: '#ccc' }, y2: { value: 20 } } : {}),
})

function cases(): Array<[string, Spec]> {
  const out: Array<[string, Spec]> = []
  const frame = { width: 120, height: 60, padding: 5, signals: [{ name: 'o', value: null }] }
  const clips = [{ signal: 'o.v' }, { path: { signal: 'o.v' } }]
  for (const type of TYPES) {
    for (const [k, clip] of clips.entries()) {
      const failing = { type, clip, encode: { update: enc(type, 30) } }
      const marks = [{ type: 'rect', encode: { update: enc('rect', 5) } }, failing, { type: 'symbol', encode: { update: enc('symbol', 60) } }]
      out.push([`${type} clip form ${k}`, { ...frame, marks }])
      out.push([`${type} clip form ${k} in a group`, { ...frame, marks: [{ type: 'group', encode: { update: { width: { value: 100 }, height: { value: 50 } } }, marks }] }])
    }
  }
  for (const [name, held] of [['missing', undefined], ['null', null], ['a number', 5], ['a string', 'ab'], ['an object', { a: 1 }], ['an array (control)', [{ v: 1 }]]] as const) {
    const values = [{ k: 'a', kids: [{ v: 2 }] }, held === undefined ? { k: 'b' } : { k: 'b', kids: held }]
    out.push([`a pre-faceted group mark over a field holding ${name}`, {
      ...frame, data: [{ name: 't', values }],
      marks: [
        { type: 'rect', encode: { update: enc('rect', 5) } },
        { type: 'group', from: { facet: { data: 't', name: 'f', field: 'kids' } }, encode: { update: { x: { value: 20 } } }, marks: [{ type: 'symbol', from: { data: 'f' }, encode: { update: { x: { field: 'v' }, size: { value: 30 } } } }] },
        { type: 'symbol', encode: { update: enc('symbol', 60) } },
      ],
    }])
  }
  out.push(['the view layout holds a signal that throws', { ...frame, layout: { columns: { signal: 'o.v' } }, data: [{ name: 't', values: [{ v: 1 }] }], marks: [{ type: 'rect', encode: { update: enc('rect', 5) } }] }])
  out.push(['a group layout holds a signal that throws', { ...frame, marks: [{ type: 'group', layout: { columns: { signal: 'o.v' } }, marks: [{ type: 'group', encode: { update: { width: { value: 9 }, height: { value: 9 } } } }] }, { type: 'rect', encode: { update: enc('rect', 60) } }] }])
  const scales = [{ name: 'c', type: 'ordinal', domain: ['a', 'b'], range: ['red', 'blue'] }, { name: 'x', type: 'linear', domain: [0, 1], range: 'width' }]
  out.push(['a legend values list holds a signal that throws', { ...frame, scales, legends: [{ fill: 'c', values: ['a', { signal: 'o.v' }] }], marks: [{ type: 'rect', encode: { update: enc('rect', 5) } }] }])
  out.push(['an axis values list holds a signal that throws', { ...frame, scales, axes: [{ scale: 'x', orient: 'bottom', values: [0, { signal: 'o.v' }] }], marks: [{ type: 'rect', encode: { update: enc('rect', 5) } }] }])
  return out
}

describe('an operator of a mark or a layout that throws (C121, C398): logged once, the pass stopped where vega stops it', () => {
  for (const [name, spec] of cases()) {
    it(name, async () => {
      const vega = await renderWithVegaChecked(JSON.parse(JSON.stringify(spec)))
      const errors: unknown[] = []
      const mine = renderSpec(JSON.parse(JSON.stringify(spec)), { logger: { error: (e: unknown) => { errors.push(e) }, warn: () => {} } } as never) as string
      expect(errors.map((e) => (e as Error).message ?? String(e))).toEqual(vega.errors)
      expect(diffCanonical(canonicalizeSvg(vega.svg), canonicalizeSvg(mine)).slice(0, 3)).toEqual([])
    }, 30_000)
  }
})
