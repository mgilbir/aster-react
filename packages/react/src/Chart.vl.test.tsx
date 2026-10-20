// @vitest-environment jsdom
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { describe, it, expect, afterEach } from 'vitest'
import { Chart } from './Chart'
import { useChart } from './useChart'
import { isVegaLiteSpec, normalizeChartSpec } from './spec'

const vlSpec = {
  $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
  width: 200, height: 100,
  data: { values: [{ c: 'a', v: 3 }, { c: 'b', v: 7 }] },
  mark: 'bar',
  encoding: {
    x: { field: 'c', type: 'nominal' },
    y: { field: 'v', type: 'quantitative' },
  },
} as never

describe('direct Vega-Lite input (R11.1)', () => {
  afterEach(() => { document.body.innerHTML = '' })

  it('detects and normalizes a VL spec without importing vega-lite', () => {
    expect(isVegaLiteSpec(vlSpec)).toBe(true)
    const vg = normalizeChartSpec(vlSpec)
    expect(Array.isArray(vg.marks)).toBe(true)
    expect(vg.$schema).toContain('vega/v6')
  })

  it('renders a VL spec through <Chart>', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(<Chart spec={vlSpec} width={200} height={100} a11y={false} tooltip />) })
    expect(container.querySelector('svg .mark-rect')).not.toBeNull()
    expect(container.querySelector('svg path[data-datum]')).not.toBeNull()
    act(() => { root.unmount() })
  })

  it('renders a VL spec through the headless hook', () => {
    function Probe() {
      const { svg, error } = useChart(vlSpec)
      return <div data-testid="probe" data-error={error?.message ?? ''} dangerouslySetInnerHTML={svg ? { __html: svg } : undefined} />
    }
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(<Probe />) })
    expect(container.querySelector('[data-testid="probe"]')!.getAttribute('data-error')).toBe('')
    expect(container.querySelector('svg')).not.toBeNull()
    act(() => { root.unmount() })
  })
})
