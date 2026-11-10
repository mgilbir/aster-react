import { describe, expect, it } from 'vitest'
import { tooltipContent } from './tooltip-content'

// Expected values are vega-tooltip 1.0.0's `formatValue(value, String, 2)` for the same inputs (its HTML table read as rows).
describe('tooltipContent (what vega-tooltip shows)', () => {
  it('no tooltip for null, undefined and the empty string', () => {
    for (const v of [null, undefined, '']) expect(tooltipContent(v)).toBeNull()
  })

  it('an object: title, then a row per defined key; nested values as JSON, cycles as [Circular]', () => {
    const circ: Record<string, unknown> = { n: 1 }
    circ.self = circ
    expect(tooltipContent({ title: 'T', a: { b: { c: { d: 1 } } }, x: circ, k: null, u: undefined, b: true })).toEqual({
      title: 'T',
      rows: [['a', '{"b":{"c":{"d":1}}}'], ['x', '{"n":1,"self":"[Circular]"}'], ['k', 'null'], ['b', 'true']],
    })
    expect(tooltipContent({ v: { a: { b: { c: 1 } } } })).toEqual({ rows: [['v', '{"a":{"b":{"c":1}}}']] })
  })

  it('an array as [a, b], strings bare and the rest as JSON; a primitive as text; an empty object as {}', () => {
    expect(tooltipContent([1, 'a', { k: [1, 2] }])).toEqual({ text: '[1, a, {"k":[1,2]}]' })
    expect(tooltipContent(0)).toEqual({ text: '0' })
    expect(tooltipContent(false)).toEqual({ text: 'false' })
    expect(tooltipContent({})).toEqual({ text: '{}' })
  })

  it('the image key is not shown (a data URL would bypass urlPolicy): an image-only object shows nothing', () => {
    expect(tooltipContent({ image: 'u.png' })).toBeNull()
    expect(tooltipContent({ title: 'T', image: 'u.png' })).toEqual({ title: 'T', rows: [] })
  })
})
