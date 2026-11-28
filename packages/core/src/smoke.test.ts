import { describe, it, expect } from 'vitest'

describe('smoke', () => {
  it('1 + 1 === 2', () => {
    expect(1 + 1).toBe(2)
  })
})

describe('runtime scale-domain overrides', () => {
  it('domainRaw replaces the data domain for marks and guides', async () => {
    const { renderSpec } = await import('./index.js')
    const spec = {
      width: 100, height: 100, padding: 0, autosize: 'none',
      data: [{ name: 't', values: [{ x: 0, y: 0 }, { x: 10, y: 10 }] }],
      scales: [
        { name: 'x', type: 'linear', domain: [0, 10], range: [0, 100], nice: true },
        { name: 'y', type: 'linear', domain: [0, 10], range: [100, 0], zero: true },
      ],
      marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: {
        x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'y' }, size: { value: 30 },
      } } }],
      axes: [{ scale: 'x', orient: 'bottom', values: [0, 5, 10] }],
    }
    const base = renderSpec(spec as never)
    const zoomed = renderSpec(spec as never, { domainRaw: { x: [0, 5], y: [2.5, 7.5] } })
    expect(base).not.toEqual(zoomed)
    // x=10 maps outside the zoomed domain (exact raw domain, no nice/zero pass)
    expect(zoomed).toContain('translate(200,')
    // the guide follows the override too: the axis label for 5 moves from x=50 to the zoomed x=100, and 10 falls outside
    const labels = (svg: string): string[] => [...svg.matchAll(/<text transform="translate\(([-\d.]+),[^"]*"[^>]*>([^<]*)<\/text>/g)].map((m) => `${m[2]}@${m[1]}`)
    expect(labels(base)).toEqual(['0@0.5', '5@50.5', '10@100.5'])
    expect(labels(zoomed)).toEqual(['0@0.5', '5@100.5'])
  })
})
