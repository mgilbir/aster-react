// @vitest-environment jsdom
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { describe, it, expect } from 'vitest'
import { forEachVariant } from './testing/variants'

// The matrix runs every test below on <Chart>, <SvgChart> and <SvgChart interaction={interaction}>;
// `Chart` is the variant's component (see testing/variants.tsx).
forEachVariant(['svg', 'canvas'], (Chart, variant) => {
  function makeSpec() {
    return {
      $schema: 'https://vega.github.io/schema/vega/v6.json',
      width: 200,
      height: 100,
      padding: 5,
      background: 'white',
      autosize: 'none',
      data: [
        { name: 'table', values: [{ x: 0, y: 10 }, { x: 1, y: 20 }, { x: 2, y: 15 }] },
      ],
      scales: [
        { name: 'x', type: 'linear', domain: { data: 'table', field: 'x' } as never, range: 'width' },
        { name: 'y', type: 'linear', domain: { data: 'table', field: 'y' } as never, range: [100, 0] as never },
      ],
      marks: [
        {
          type: 'line',
          from: { data: 'table' },
          encode: {
            enter: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'y' }, stroke: { value: 'steelblue' }, strokeWidth: { value: 2 } },
          },
        },
      ],
    }
  }

  describe('Chart renderer="canvas"', () => {
    it('renders a canvas element sized to the scene', async () => {
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      await act(async () => {
        root.render(<Chart spec={makeSpec()} width={200} height={100} renderer="canvas" />)
      })
      const canvas = container.querySelector('canvas')
      expect(canvas).not.toBeNull()
      // Scene size = spec size + padding (autosize pad)
      expect(Number(canvas!.getAttribute('width'))).toBe(210)
      expect(Number(canvas!.getAttribute('height'))).toBe(110)
      expect(canvas!.style.width).toBe('210px')
      await act(async () => {
        root.unmount()
      })
    })

    it('emits no SVG markup in canvas mode', async () => {
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      await act(async () => {
        root.render(<Chart spec={makeSpec()} width={200} height={100} renderer="canvas" />)
      })
      expect(container.querySelector('svg')).toBeNull()
      await act(async () => {
        root.unmount()
      })
    })

    it('redraws without leaking elements when the spec changes', async () => {
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      await act(async () => {
        root.render(<Chart spec={makeSpec()} width={200} height={100} renderer="canvas" />)
      })
      const spec2 = makeSpec()
      ;(spec2.data![0]! as { values: unknown[] }).values = [{ x: 0, y: 5 }, { x: 1, y: 9 }, { x: 2, y: 1 }]
      await act(async () => {
        root.render(<Chart spec={spec2} renderer="canvas" />)
      })
      // Still exactly one canvas, no stray SVG nodes.
      expect(container.querySelectorAll('canvas').length).toBe(1)
      expect(container.querySelector('svg')).toBeNull()
      await act(async () => {
        root.unmount()
      })
    })

    it('shows a tooltip via the scene hit index in canvas mode', async () => {
      const spec = {
        $schema: 'https://vega.github.io/schema/vega/v6.json',
        width: 100,
        height: 100,
        padding: 0,
        autosize: 'none',
        data: [{ name: 'table', values: [{ cat: 'a', v: 5 }, { cat: 'b', v: 7 }] }],
        scales: [
          { name: 'x', type: 'band', domain: { data: 'table', field: 'cat' } as never, range: [0, 100] as never },
          { name: 'y', type: 'linear', domain: [0, 10] as never, range: [100, 0] as never },
        ],
        marks: [{
          type: 'rect',
          from: { data: 'table' },
          encode: {
            enter: {
              x: { scale: 'x', field: 'cat' }, width: { scale: 'x', band: 1 },
              y: { scale: 'y', field: 'v' }, y2: { scale: 'y', value: 0 },
              fill: { value: '#4c78a8' },
            },
          },
        }],
      }
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      await act(async () => {
        root.render(<Chart spec={spec} width={100} height={100} renderer="canvas" tooltip />)
      })
      // The first bar spans x [0,50); hover at (20, 80) — inside the bar (v=5 →
      // y from 50 to 100) — and the tooltip should carry the datum.
      const canvas = container.querySelector('canvas')!
      await act(async () => {
        canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: 20, clientY: 80, bubbles: true }))
      })
      const tip = container.querySelector('[data-testid="chart-tooltip"]')
      expect(tip?.textContent).toContain('cat')
      expect(tip?.textContent).toContain('a')
      await act(async () => {
        root.unmount()
      })
    })

    it('SSR renders empty for canvas mode without throwing', async () => {
      const { renderToString } = await import('react-dom/server')
      const html = renderToString(<Chart spec={makeSpec()} renderer="canvas" />)
      expect(html).toContain('<canvas')
      expect(html).not.toContain('<svg')
    })
  })
})
