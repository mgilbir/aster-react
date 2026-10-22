import { describe, expect, it } from 'vitest'
import { renderSpec } from './index.js'

const spec = (sort: unknown) => ({
  width: 100,
  height: 100,
  data: [{ name: 't', values: [{ x: 0, y: 10, w: 3 }, { x: 1, y: 50, w: 1 }, { x: 2, y: 30, w: 2 }] }],
  scales: [
    { name: 'x', type: 'linear', domain: [0, 2], range: 'width' },
    { name: 'y', type: 'linear', domain: [0, 100], range: 'height' },
  ],
  marks: [{ type: 'line', from: { data: 't' }, ...(sort ? { sort } : {}), encode: { update: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'y' } } } }],
})
const pathOf = (svg: string): string => [...svg.matchAll(/<path[^>]* d="(M[^"]*L[^"]*)"/g)].map((m) => m[1]!)[0]!

describe('mark sort by datum accessors (vega-lite getSort)', () => {
  it('orders line vertices by datum["w"], as vega does', () => {
    const plain = pathOf(renderSpec(spec(undefined) as never))
    const sorted = pathOf(renderSpec(spec({ field: ['datum["w"]'], order: ['ascending'] }) as never))
    expect(plain).not.toBe(sorted)
    // w ascending visits x = 1, 2, 0: pixel x 50, 100, 0
    expect(sorted).toMatch(/^M50,.*L100,.*L0,/)
  })

  it('honours descending order', () => {
    const desc = pathOf(renderSpec(spec({ field: ['datum["w"]'], order: ['descending'] }) as never))
    expect(desc).toMatch(/^M0,.*L100,.*L50,/)
  })
})

describe('aggregate-positioned facet groups (vega-lite stack_group_main)', () => {
  const ext = (op: string, f: string) => `scale('y',datum["${op}_${f}"])`
  const all = `${ext('min', 'v_start')},${ext('max', 'v_start')},${ext('min', 'v_end')},${ext('max', 'v_end')}`
  const stackSpec = (cornerRadius: unknown) => ({
    width: 100,
    height: 100,
    autosize: 'none',
    data: [{ name: 't', values: [{ c: 'a', v_start: 0, v_end: 20 }, { c: 'b', v_start: 0, v_end: 60 }] }],
    scales: [
      { name: 'x', type: 'band', domain: { data: 't', field: 'c' }, range: [0, { signal: 'width' }], paddingInner: 0.1 },
      { name: 'y', type: 'linear', domain: [0, 100], range: [{ signal: 'height' }, 0] },
    ],
    marks: [
      {
        type: 'group',
        from: { facet: { data: 't', name: 'g', groupby: ['c'], aggregate: { fields: ['v_start', 'v_start', 'v_end', 'v_end'], ops: ['min', 'max', 'min', 'max'] } } },
        encode: {
          update: {
            x: { scale: 'x', field: 'c' },
            width: { signal: "bandwidth('x')" },
            y: { signal: `min(${all})` },
            y2: { signal: `max(${all})` },
            clip: { value: true },
            ...cornerRadius as object,
          },
        },
        marks: [
          {
            type: 'group',
            encode: { update: { y: { field: { group: 'y' }, mult: -1 }, width: { field: { group: 'width' } } } },
            marks: [{ type: 'rect', from: { data: 'g' }, encode: { update: { fill: { value: '#444' }, width: { field: { group: 'width' } }, y: { scale: 'y', field: 'v_end' }, y2: { scale: 'y', field: 'v_start' } } } }],
          },
        ],
      },
    ],
  })

  it('places each group at its own stack top and keeps the chart at its set size', () => {
    const svg = renderSpec(stackSpec({ cornerRadius: { value: 6 } }) as never)
    // bar b is 60 tall: its group starts at y = 40, the inner group shifts back by 40
    expect(svg).toContain('transform="translate(0,80)"')
    expect(svg).toContain('transform="translate(52.631578947368425,40)"')
    expect(svg).toContain('transform="translate(0,-40)"')
    expect(svg).toMatch(/<svg[^>]* height="100"/)
  })

  it('rounds a single corner of the group', () => {
    const top = renderSpec(stackSpec({ cornerRadiusTopLeft: { value: 6 } }) as never)
    expect(top).toContain('<clipPath id="clip1"><path d="M6,0L47')
  })
})
