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
    }
    const base = renderSpec(spec as never)
    const zoomed = renderSpec(spec as never, { domainRaw: { x: [0, 5], y: [2.5, 7.5] } })
    expect(base).not.toEqual(zoomed)
    // x=10 maps outside the zoomed domain (exact raw domain, no nice/zero pass)
    expect(zoomed).toContain('translate(200,')
  })
})
