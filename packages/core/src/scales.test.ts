import { describe, it, expect } from 'vitest'
import { buildScale } from './scales.js'

describe('scales', () => {
  const dataFieldFn = (vals: unknown[]) => () => vals

  const makeCtx = (
    dataFieldFn: () => unknown[],
    signals: Record<string, unknown> = { width: 400, height: 300 },
  ) => ({
    width: 400,
    height: 300,
    signals,
    dataField: dataFieldFn as never,
  })

  it('linear scale with zero:true → domain [0,20]; scale(15)===75, scale(20)===0', () => {
    const ctx = makeCtx(() => [10, 20, 15])
    const s = buildScale(
      {
        name: 'yScale',
        type: 'linear',
        domain: { data: 't', field: 'y' } as never,
        range: [{ signal: 'height' }, 0] as never,
        nice: true,
        zero: true,
      },
      ctx,
    )
    const domain = s.domain() as number[]
    expect(domain[0]).toBe(0)
    expect(domain[1]).toBe(20)
    expect(s(15)).toBe(75)
    expect(s(20)).toBe(0)
  })

  it('linear scale with zero:false → domain [10,20]', () => {
    const ctx = makeCtx(() => [10, 20, 15])
    const s = buildScale(
      {
        name: 'yScale',
        type: 'linear',
        domain: { data: 't', field: 'y' } as never,
        range: [{ signal: 'height' }, 0] as never,
        nice: true,
        zero: false,
      },
      ctx,
    )
    const domain = s.domain() as number[]
    expect(domain[0]).toBe(10)
    expect(domain[1]).toBe(20)
  })

  it('band scale sorts domain alphabetically', () => {
    const ctx = makeCtx(() => ['b', 'a', 'c'])
    const s = buildScale(
      {
        name: 'xScale',
        type: 'band',
        domain: { data: 't', field: 'x', sort: true } as never,
        range: [0, 400] as never,
      },
      ctx,
    )
    const domain = s.domain() as string[]
    expect(domain).toEqual(['a', 'b', 'c'])
    expect(s.bandwidth!()).toBeGreaterThan(0)
  })

  it('log scale → domain [1,100]', () => {
    const ctx = makeCtx(() => [1, 10, 100])
    const s = buildScale(
      {
        name: 'logScale',
        type: 'log',
        domain: { data: 't', field: 'y' } as never,
        range: [0, 300] as never,
        base: 10,
      },
      ctx,
    )
    const domain = s.domain() as number[]
    expect(domain[0]).toBe(1)
    expect(domain[1]).toBe(100)
  })
})
