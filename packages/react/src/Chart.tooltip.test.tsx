// @vitest-environment jsdom
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { describe, it, expect, afterEach } from 'vitest'
import { Chart } from './Chart'

const spec = {
  $schema: 'https://vega.github.io/schema/vega/v6.json',
  width: 400,
  height: 300,
  padding: 5,
  autosize: 'none',
  data: [{ name: 'table', values: [{ x: 1, y: 2 }, { x: 2, y: 3 }] }],
  scales: [
    { name: 'x', type: 'linear', domain: [0, 10], range: 'width' },
    { name: 'y', type: 'linear', domain: [0, 10], range: 'height' },
  ],
  marks: [
    { type: 'symbol', from: { data: 'table' }, encode: { update: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'y' }, size: { value: 50 } } } },
  ],
}

describe('<Chart tooltip>', () => {
  it('shows the hovered datum in a tooltip', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(<Chart spec={spec} width={400} height={300} tooltip />) })
    const svg = container.querySelector('svg')!
    expect(svg).not.toBeNull()
    // Hover over the first symbol (data-datum stamped on the item element).
    const sym = svg.querySelector('path[data-datum]') as Element
    expect(sym).not.toBeNull()
    const rect = container.getBoundingClientRect()
    act(() => {
      sym.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: rect.left + 40, clientY: rect.top + 60 }))
    })
    const tip = container.querySelector('[data-testid="chart-tooltip"]')
    expect(tip).not.toBeNull()
    expect(tip!.textContent).toContain('x:')
    expect(tip!.textContent).toContain('y:')
  })

  it('renders a custom tooltip through the renderTooltip slot', () => {
    const labeledSpec = {
      ...spec,
      data: [{ name: 'table', values: [{ x: 1, y: 2, label: 'a' }, { x: 2, y: 3, label: 'b' }] }],
    }
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => {
      root.render(
        <Chart
          spec={labeledSpec}
          width={400}
          height={300}
          renderTooltip={(d) => <span data-testid="custom-tip">{`point ${d.label}`}</span>}
        />,
      )
    })
    const sym = container.querySelector('svg path[data-datum]') as Element
    act(() => {
      sym.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 40, clientY: 60 }))
    })
    const tip = container.querySelector('[data-testid="chart-tooltip"]')!
    expect(tip.querySelector('[data-testid="custom-tip"]')?.textContent).toBe('point a')
    act(() => { root.unmount() })
  })

  afterEach(() => { document.body.innerHTML = '' })
})
