import { describe, expect, it } from 'vitest'
import { renderSpec } from './index.js'

const spec = (symbols: Record<string, unknown>) => ({
  width: 100,
  height: 80,
  data: [{ name: 't', values: [{ x: 1, y: 2, v: 5 }, { x: 2, y: 4, v: 9 }] }],
  scales: [
    { name: 'x', type: 'linear', domain: { data: 't', field: 'x' }, range: 'width' },
    { name: 'y', type: 'linear', domain: { data: 't', field: 'y' }, range: 'height' },
    { name: 'size', type: 'linear', domain: { data: 't', field: 'v' }, range: [4, 100] },
  ],
  marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'y' }, size: { scale: 'size', field: 'v' } } } }],
  legends: [{ size: 'size', symbolType: 'circle', title: 'v', encode: { symbols: { update: symbols } } }],
})

describe('size legend symbols', () => {
  it('are opaque unless the symbols encode says otherwise, like vega', () => {
    const plain = renderSpec(spec({ fill: { value: 'transparent' }, stroke: { value: '#4c78a8' } }) as never)
    expect(plain).not.toContain('opacity="0.7"')
    const reduced = renderSpec(spec({ fill: { value: 'transparent' }, stroke: { value: '#4c78a8' }, opacity: { value: 0.7 } }) as never)
    expect(reduced).toContain('opacity="0.7"')
  })
})
