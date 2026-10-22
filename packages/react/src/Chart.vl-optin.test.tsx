// @vitest-environment jsdom
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { describe, it, expect } from 'vitest'
import { Chart } from './Chart'
import { hasVegaLiteCompiler } from './vl-registry'
import { isVegaLiteSpec, normalizeChartSpec } from './spec'

const vlSpec = {
  $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
  width: 200,
  height: 100,
  data: { values: [{ c: 'a', v: 3 }] },
  mark: 'bar',
  encoding: { x: { field: 'c', type: 'nominal' }, y: { field: 'v', type: 'quantitative' } },
} as never

// This file deliberately does NOT import '@aster/react/vl': the base entry must
// keep working for Vega specs and fail loudly (with instructions) for VL ones.
describe('Vega-Lite is opt-in', () => {
  it('does not have a compiler registered by default', () => {
    expect(hasVegaLiteCompiler()).toBe(false)
  })

  it('detects VL but explains how to enable it', () => {
    expect(isVegaLiteSpec(vlSpec)).toBe(true)
    expect(() => normalizeChartSpec(vlSpec)).toThrow(/import '@aster\/react\/vl'/)
  })

  it('leaves Vega specs untouched', () => {
    const vega = {
      $schema: 'https://vega.github.io/schema/vega/v6.json',
      width: 10, height: 10, data: [], marks: [],
    }
    expect(normalizeChartSpec(vega as never)).toBe(vega)
  })

  it('fails fast (with the fix) when <Chart> receives a VL spec', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    // A missing addon is a configuration error, not a data error: throw with
    // the exact import to add rather than rendering a generic failure alert.
    expect(() => {
      act(() => { root.render(<Chart spec={vlSpec} width={200} height={100} a11y={false} />) })
    }).toThrow(/@aster\/react\/vl/)
    container.remove()
  })
})
