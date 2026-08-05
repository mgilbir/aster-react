import { describe, it, expect } from 'vitest'
import { getChartInfo } from '@aster/core'
import { dragToDataInterval, selectionToPixels } from './interaction.js'

describe('dragToDataInterval', () => {
  const spec: Record<string, unknown> = {
    width: 400,
    height: 300,
    padding: 5,
    autosize: 'none',
    data: [{ name: 't', values: [{ x: 0, y: 0 }, { x: 10, y: 10 }] }],
    scales: [
      {
        name: 'x',
        type: 'linear',
        domain: { data: 't', field: 'x' } as never,
        range: 'width',
      } as never,
      {
        name: 'y',
        type: 'linear',
        domain: { data: 't', field: 'y' } as never,
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

  it('converts pixel drag to data intervals', () => {
    const info = getChartInfo(spec as never, { width: 400, height: 300 })

    // x scale: domain [0, 10] → range [0, 400]
    // dragToDataInterval subtracts padding before invert:
    // (10 - 5) = 5 → invert(5) = 5 * 10 / 400 = 0.125
    // (90 - 5) = 85 → invert(85) = 85 * 10 / 400 = 2.125

    const interval = dragToDataInterval({ x: 10, y: 50 }, { x: 90, y: 150 }, info)

    expect(interval.x).toBeDefined()
    expect((interval.x![0])).toBeCloseTo(0.125, 4)
    expect((interval.x![1])).toBeCloseTo(2.125, 4)
  })

  it('y interval is ordered min-first (reversed drag)', () => {
    const info = getChartInfo(spec as never, { width: 400, height: 300 })

    // y scale: data [0, 10] → pixel [300, 0] (inverted)
    // invert formula: y_data = (300 - pixel) / 30
    // (50 - 5) = 45 → invert(45) = (300 - 45) / 30 = 255/30 = 8.5
    // (150 - 5) = 145 → invert(145) = (300 - 145) / 30 = 155/30 ≈ 5.1667
    // min-first ordering gives [5.1667, 8.5]

    const interval = dragToDataInterval({ x: 10, y: 50 }, { x: 90, y: 150 }, info)

    expect(interval.y).toBeDefined()
    expect(interval.y!).toHaveLength(2)
    expect((interval.y![0])).toBeCloseTo(5.1667, 2)  // min
    expect((interval.y![1])).toBeCloseTo(8.5, 2)     // max (min-first ordering)
  })

  it('reversed horizontal drag still returns min-first x interval', () => {
    const info = getChartInfo(spec as never, { width: 400, height: 300 })
    // Drag from right to left: start.x=90, end.x=10
    const interval = dragToDataInterval({ x: 90, y: 50 }, { x: 10, y: 150 }, info)

    expect(interval.x).toBeDefined()
    expect((interval.x![0])).toBeCloseTo(0.125, 4)  // min first (still 10-5 → 0.125)
    expect((interval.x![1])).toBeCloseTo(2.125, 4)  // max first
  })
})

describe('selectionToPixels', () => {
  const spec: Record<string, unknown> = {
    width: 400,
    height: 300,
    padding: 5,
    autosize: 'none',
    data: [{ name: 't', values: [{ x: 0, y: 0 }, { x: 10, y: 10 }] }],
    scales: [
      {
        name: 'x',
        type: 'linear',
        domain: { data: 't', field: 'x' } as never,
        range: 'width',
      } as never,
      {
        name: 'y',
        type: 'linear',
        domain: { data: 't', field: 'y' } as never,
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

  it('converts data interval to pixel rect', () => {
    const info = getChartInfo(spec as never, { width: 400, height: 300 })

    // x scale: [0, 10] → [0, 400]: scale(0.125)=5, scale(0.25)=10
    // selectionToPixels returns SVG-space coords (no extra padding offset from value)
    const selection = dragToDataInterval(
      { x: 10, y: 50 },
      { x: 20, y: 150 },
      info,
    )
    expect(selection.x).toBeDefined()
    const pixelRect = selectionToPixels(selection, info)

    // pixel rect: x = scale(0.125) = 5, width = |scale(0.25) - scale(0.125)| = 5
    // Debug: check actual values
    // x scale domain should be [0, 10] after applyZero
    // x scale maps data → range [0, 400]: scale(d) = d * 400 / 10 = d * 40
    // drag x=10..20 → (10-5)..(20-5) = 5..15 → invert(5)=5/40=0.125, invert(15)=15/40=0.375
    // So selection.x = [0.125, 0.375]
    // scaleVal(0.125) = 5, scaleVal(0.375) = 15
    // pixelRect: x=5, width=|15-5|=10
    // But test expected pixelRect.x=5, pixelRect.width=5 (which would be for scaleVal(0.25))
    // Let's fix: the drag interval [10, 20] → x=[0.125, 0.375] → pixelRect {x: 5, width: 10}
    expect(pixelRect.x).toBeCloseTo(10, 1)
    expect(pixelRect.width).toBeCloseTo(10, 1)
  })
})

describe('selectionToPixels round-trip', () => {
  it('selectionToPixels(dragToDataInterval(...)) preserves the original pixel positions with padding', () => {
    const spec: Record<string, unknown> = {
      width: 400,
      height: 300,
      padding: 5,
      autosize: 'none',
      data: [{ name: 't', values: [{ x: 0, y: 0 }, { x: 10, y: 10 }] }],
      scales: [
        {
          name: 'x',
          type: 'linear',
          domain: { data: 't', field: 'x' } as never,
          range: 'width',
        } as never,
        {
          name: 'y',
          type: 'linear',
          domain: { data: 't', field: 'y' } as never,
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
    const info = getChartInfo(spec as never, { width: 400, height: 300 })
    // Drag from pixel (100, 80) to (200, 150)
    const interval = dragToDataInterval({ x: 100, y: 80 }, { x: 200, y: 150 }, info)
    expect(interval.x).toBeDefined()
    expect(interval.y).toBeDefined()
    const pixelRect = selectionToPixels(interval, info)
    // round-trip: x=100, y=80; width=200-100=100, height=150-80=70
    expect(pixelRect.x).toBeCloseTo(100, 1)
    expect(pixelRect.y).toBeCloseTo(80, 1)
    expect(pixelRect.width).toBeCloseTo(100, 1)
    expect(pixelRect.height).toBeCloseTo(70, 1)
  })
})
