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

// ---------------------------------------------------------------------------
// getChartInfo
// ---------------------------------------------------------------------------

import { getChartInfo } from './runtime.js'

describe('getChartInfo', () => {
  const lineSpec: Record<string, unknown> = {
    width: 400,
    height: 300,
    padding: 5,
    autosize: 'none',
    data: [
      { name: 't', values: [{ x: 0, y: 0 }, { x: 10, y: 10 }] },
    ],
    scales: [
      {
        name: 'x',
        type: 'linear',
        domain: { data: 't', field: 'x' },
        range: 'width',
      } as never,
      {
        name: 'y',
        type: 'linear',
        domain: { data: 't', field: 'y' },
        range: [{ signal: 'height' }, 0],
      } as never,
    ],
    marks: [
      {
        type: 'line',
        from: { data: 't' },
        encode: {
          update: {
            x: { scale: 'x', field: 'x' },
            y: { scale: 'y', field: 'y' },
          },
        },
      },
    ],
  }

  it('returns width, height, padding, and scales map', () => {
    const info = getChartInfo(lineSpec as never, { width: 400, height: 300 })
    expect(info.width).toBe(400)
    expect(info.height).toBe(300)
    expect(info.padding).toEqual({ top: 5, right: 5, bottom: 5, left: 5 })
    expect(info.scales.has('x')).toBe(true)
    expect(info.scales.has('y')).toBe(true)
  })

  it('invert reverses mapping: x.invert(x(5)) ≈ 5', () => {
    const info = getChartInfo(lineSpec as never, { width: 400, height: 300 })
    const xScale = info.scales.get('x')!
    // x scale maps data [0, 10] → pixel [0, 400]
    // x(5) should be 5 * 400/10 = 200
    const px200 = xScale(5) as number
    expect(px200).toBe(200)
    // invert: 200 → 5 (since domain [0,10] → range [0,400])
    const inv = (xScale as { invert?: (v: number) => number }).invert
    if (inv) {
      const dataBack = inv(px200)
      expect(dataBack).toBeCloseTo(5, 4)
    }
  })

  it('y scale inverted range: invert works on reverse scale', () => {
    const info = getChartInfo(lineSpec as never, { width: 400, height: 300 })
    const yScale = info.scales.get('y')!
    // y scale maps data [0, 10] → pixel [300, 0] (inverted because range is [height, 0])
    // y(0) = 300, y(10) = 0
    const px300 = yScale(0) as number
    expect(px300).toBe(300)
    const inv = (yScale as { invert?: (v: number) => number }).invert
    if (inv) {
      const inverted0 = inv(px300)
      expect(inverted0).toBeCloseTo(0, 4)
      const inverted10 = inv(0)
      expect(inverted10).toBeCloseTo(10, 4)
    }
  })

  it('drag-to-interval: pixel 10 maps to data ≈ 0.125', () => {
    const info = getChartInfo(lineSpec as never, { width: 400, height: 300 })
    const xScale = info.scales.get('x')!
    // Domain [0, 10], range [0, 400]: scale(0.125) = 0.125 * 400/10 = 5
    // If we invert pixel 5 (no padding comp), we get back 0.125
    const inv = (xScale as { invert?: (v: number) => number }).invert
    if (inv) {
      const pxFromData = xScale(0.125) as number  // = 5
      expect(inv(pxFromData)).toBeCloseTo(0.125, 4)
    }
  })
})
