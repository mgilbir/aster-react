// @vitest-environment jsdom
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { describe, it, expect, afterEach } from 'vitest'
import { forEachVariant } from './testing/variants'

// The matrix runs every test below on <Chart>, <SvgChart> and <SvgChart interaction={interaction}>;
// `Chart` is the variant's component (see testing/variants.tsx).
forEachVariant(['svg', 'interaction'], (Chart, variant) => {
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

    // C21 is fixed in core: the scene's datum is the pure source row, so the tooltip
    // needs no list of "engine" field names to hide (which also hid real data fields).
    describe('shows pure datum values', () => {
      const row = { label: 'L', x: 1, y: 2, size: 'XL', fill: 'red', text: 'hello', description: 'a thing', limit: 7 }
      const dataSpec = { ...spec, data: [{ name: 'table', values: [row] }] }
      const rect = { left: 0, top: 0, width: 410, height: 310, right: 410, bottom: 310, x: 0, y: 0, toJSON: () => ({}) } as DOMRect

      it('SVG: every source field is listed with its source value; renderTooltip gets the exact row', () => {
        const seen: unknown[] = []
        const container = document.createElement('div')
        document.body.appendChild(container)
        const root = createRoot(container)
        act(() => { root.render(<Chart spec={dataSpec} width={400} height={300} tooltip />) })
        const sym = container.querySelector('svg path[data-datum]') as Element
        act(() => { sym.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 40, clientY: 60 })) })
        const text = container.querySelector('[data-testid="chart-tooltip"]')!.textContent!
        for (const [k, v] of Object.entries(row)) expect(text).toContain(`${k}: ${v}`)
        act(() => { root.render(<Chart spec={dataSpec} width={400} height={300} renderTooltip={(d) => { seen.push(d); return null }} />) })
        const sym2 = container.querySelector('svg path[data-datum]') as Element
        act(() => { sym2.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 40, clientY: 60 })) })
        expect(seen.at(-1)).toEqual(row)
      })

      variant.it(['canvas', 'interaction'], 'canvas: the same values via the hit index', () => {
        const container = document.createElement('div')
        document.body.appendChild(container)
        const root = createRoot(container)
        act(() => { root.render(<Chart spec={dataSpec} width={400} height={300} renderer="canvas" tooltip />) })
        const host = container.firstElementChild as HTMLElement
        host.getBoundingClientRect = () => rect
        // symbol at x=1,y=2 on 0..10 scales over 400x300 + 5 padding
        act(() => { host.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 5 + 40, clientY: 5 + 300 - 60 })) })
        const text = container.querySelector('[data-testid="chart-tooltip"]')?.textContent ?? ''
        for (const [k, v] of Object.entries(row)) expect(text).toContain(`${k}: ${v}`)
      })
    })

    afterEach(() => { document.body.innerHTML = '' })
  })
})
