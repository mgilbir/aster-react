import { describe, it, expect } from 'vitest'
import { compileChart } from './compiler.js'
import { evaluateChart, getChartInfo } from './runtime.js'

describe('autosize compilation', () => {
  it('parses string autosize as-is', () => {
    expect(compileChart({ autosize: 'pad' } as never).autosize).toBe('pad')
    expect(compileChart({ autosize: 'none' } as never).autosize).toBe('none')
    expect(compileChart({ autosize: 'fit' } as never).autosize).toBe('fit')
  })

  it('parses {type} object autosize', () => {
    expect(compileChart({ autosize: { type: 'pad' } } as never).autosize).toBe('pad')
    expect(compileChart({ autosize: { type: 'none' } } as never).autosize).toBe('none')
  })

  it('missing autosize -> undefined', () => {
    expect(compileChart({} as never).autosize).toBeUndefined()
  })
})

describe('autosize pad vs none', () => {
  it('evaluateChart: autosize != "none" expands padding.left from axis title+labels', () => {
    const common = {
      width: 400,
      height: 300,
      padding: { top: 0, right: 0, bottom: 0, left: 0 } as const,
      data: [{ name: 'table', values: [{ v: 0 }, { v: 100 }] }],
      scales: [
        { name: 'x', type: 'linear' as const, domain: [] as never, range: [0, 400] as never },
        { name: 'y', type: 'linear' as const, domain: [] as never, range: [300, 0] as never },
      ],
      axes: [
        {
          scale: 'y',
          orient: 'left' as const,
          labels: true,
          domain: true,
          title: 'Y-Value',
        },
      ],
      marks: [
        { type: 'point', name: 'pts', from: { data: 'table' } as const } as never,
      ],
    }

    // Spec with autosize: 'none' – padding stays at base (0).
    const specNone = { ...common, autosize: 'none' }
    const chartNone = compileChart(specNone)
    const sceneNone = evaluateChart(chartNone, { width: 400, height: 300 })

    // Spec WITHOUT autosize -> default pad path (autosize !== 'none').
    const specPad = { ...common }
    const chartPad = compileChart(specPad)
    const scenePad = evaluateChart(chartPad, { width: 400, height: 300 })

    // With autosize: 'none', padding.left should stay at 0.
    // With default (pad), padding.left should expand to fit axis title on the left.
    expect(scenePad.padding!.left).toBeGreaterThan(sceneNone.padding!.left)
  })

  it('getChartInfo returns same padding as evaluateChart for pad specs', () => {
    const spec = {
      width: 400,
      height: 300,
      padding: { top: 0, right: 0, bottom: 0, left: 0 } as const,
      data: [{ name: 'table', values: [{ v: 0 }, { v: 100 }] }],
      scales: [
        { name: 'x', type: 'linear' as const, domain: [] as never, range: [0, 400] as never },
        { name: 'y', type: 'linear' as const, domain: [] as never, range: [300, 0] as never },
      ],
      axes: [
        {
          scale: 'y',
          orient: 'left' as const,
          labels: true,
          domain: true,
          title: 'Y-Value',
        },
      ],
      marks: [
        { type: 'point', name: 'pts', from: { data: 'table' } as const } as never,
      ],
    }
    const info = getChartInfo(spec, { width: 400, height: 300 })
    const scene = evaluateChart(compileChart(spec), { width: 400, height: 300 })
    expect(info.padding).toEqual(scene!.padding)
  })
})

describe('NaN fix (Bug 1)', () => {
  it('NaN size falls through to override', () => {
    // When width is NaN (from vega-lite {signal: 'width'} compile),
    // resolveSize should fall through to the override, not return NaN.
    const spec = { width: { signal: 'width' } as unknown, height: { signal: 'height' } as unknown }
    const chart = compileChart(spec)
    const scene = evaluateChart(chart, { width: 600, height: 400 })
    expect(Number.isNaN(scene.width)).toBe(false)
    expect(scene.width).toBeGreaterThan(0)
  })
})
