// @vitest-environment jsdom
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, it, expect } from 'vitest'
import { forEachVariant } from './testing/variants'

// The matrix runs every test below on <Chart>, <SvgChart> and <SvgChart interaction={interaction}>;
// `Chart` is the variant's component (see testing/variants.tsx).
/** The opening tag of the markup's first element: the chart's container. */
const firstTag = (markup: string): string => /^<[^>]*>/.exec(markup)![0]

forEachVariant(['svg'], (Chart, variant) => {
  describe('Chart', () => {
    it('renders an SVG for a minimal line chart spec', () => {
      const spec = {
        $schema: 'https://vega.github.io/schema/vega/v6.json',
        width: 400,
        height: 300,
        padding: 5,
        background: 'white',
        autosize: 'none',
        data: [
          {
            name: 'table',
            values: [{ x: 0, y: 10 }, { x: 1, y: 20 }, { x: 2, y: 15 }],
          },
        ],
        scales: [
          {
            name: 'x',
            type: 'linear',
            domain: { data: 'table', field: 'x' } as never,
            range: 'width',
            nice: true,
          },
          {
            name: 'y',
            type: 'linear',
            domain: { data: 'table', field: 'y' } as never,
            range: [{ signal: 'height' }, 0],
            nice: true,
          },
        ],
        marks: [
          {
            type: 'line',
            from: { data: 'table' },
            encode: {
              update: {
                x: { scale: 'x', field: 'x' },
                y: { scale: 'y', field: 'y' },
                stroke: { value: 'steelblue' },
                strokeWidth: { value: 2 },
              },
            },
          },
        ],
      }
      const markup = renderToString(
        <Chart spec={spec} ariaLabel="t" />
      )
      expect(markup).toContain('<svg')
    })

    it('renders bind controls for signal.bind', () => {
      const spec = {
        width: 100, height: 100,
        signals: [{ name: 'year', value: 2000, bind: { input: 'range', min: 1850, max: 2000, step: 10 } }],
        data: [{ name: 't', values: [{ x: 1, y: 1 }] }],
        marks: [],
      }
      const markup = renderToString(<Chart spec={spec as never} />)
      expect(markup).toContain('data-testid="chart-binds"')
      expect(markup).toContain('type="range"')
      expect(markup).toContain('year')
    })

    variant.it(['interaction'], 'positions tooltip/a11y absolute children against the chart container', () => {
      const spec = { width: 100, height: 100, data: [{ name: 't', values: [{ x: 1, y: 1 }] }], marks: [] }
      const markup = renderToString(<Chart spec={spec as never} tooltip />)
      // React serializes the inline style; the container must establish a
      // containing block even without selection/pan interaction.
      // (the container: the chart's own element, the first tag of the markup, not a style that appears somewhere inside it)
      expect(firstTag(markup)).toContain('position:relative')
    })

    it('container div has width 100% and height 100% inline style', () => {
      const spec = {
        $schema: 'https://vega.github.io/schema/vega/v6.json',
        width: 400,
        height: 300,
        padding: 5,
        background: 'white',
        autosize: 'none',
        data: [
          {
            name: 'table',
            values: [{ x: 0, y: 10 }, { x: 1, y: 20 }, { x: 2, y: 15 }],
          },
        ],
        scales: [
          {
            name: 'x',
            type: 'linear',
            domain: { data: 'table', field: 'x' } as never,
            range: 'width',
            nice: true,
          },
          {
            name: 'y',
            type: 'linear',
            domain: { data: 'table', field: 'y' } as never,
            range: [{ signal: 'height' }, 0],
            nice: true,
          },
        ],
        marks: [
          {
            type: 'line',
            from: { data: 'table' },
            encode: {
              update: {
                x: { scale: 'x', field: 'x' },
                y: { scale: 'y', field: 'y' },
                stroke: { value: 'steelblue' },
                strokeWidth: { value: 2 },
              },
            },
          },
        ],
      }
      const markup = renderToString(
        <Chart spec={spec} ariaLabel="t" />
      )
      expect(firstTag(markup)).toMatch(/style="[^"]*width:100%;height:100%[^"]*"/)
    })

    it('the signals prop is drawn: other values, other markup, and a mounted chart given new values shows what a fresh mount of them shows', () => {
      const spec: Record<string, unknown> = {
        $schema: 'https://vega.github.io/schema/vega/v6.json',
        width: 400,
        height: 300,
        padding: 5,
        background: 'white',
        autosize: 'none',
        signals: [
          { name: 'shift', value: 10 },
        ],
        data: [
          {
            name: 'table',
            values: [
              { x: 0, y: 2 },
              { x: 1, y: 4 },
              { x: 2, y: 3 },
              { x: 3, y: 5 },
            ],
            transform: [
              { type: 'formula', expr: 'datum.y + shift', as: 'y2' },
            ],
          },
        ],
        scales: [
          {
            name: 'x',
            type: 'linear',
            domain: { data: 'table', field: 'x' },
            range: 'width',
            nice: true,
          },
          {
            name: 'y',
            type: 'linear',
            domain: { data: 'table', field: 'y2' },
            range: [{ signal: 'height' }, 0],
            nice: true,
          },
        ],
        marks: [
          {
            type: 'line',
            from: { data: 'table' },
            encode: {
              update: {
                x: { scale: 'x', field: 'x' },
                y: { scale: 'y', field: 'y2' },
                stroke: { value: 'steelblue' },
                strokeWidth: { value: 2 },
              },
            },
          },
        ],
      }

      const markupA = renderToString(<Chart spec={spec} ariaLabel="t" signals={{ shift: 25 }} />)
      const markupB = renderToString(<Chart spec={spec} ariaLabel="t" signals={{ shift: 30 }} />)

      expect(markupA).toContain('<svg')
      expect(markupB).toContain('<svg')
      expect(markupA).not.toEqual(markupB)

      // the same on a MOUNTED chart: the change re-renders it, and it equals a fresh mount (the markup carries the useId of its root)
      const dom = (node: React.ReactElement): string => {
        const container = document.createElement('div')
        document.body.appendChild(container)
        const root = createRoot(container)
        act(() => { root.render(node) })
        const html = container.innerHTML
        act(() => { root.unmount() })
        container.remove()
        return html
      }
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      act(() => { root.render(<Chart spec={spec as never} ariaLabel="t" signals={{ shift: 25 }} />) })
      const before = container.innerHTML
      act(() => { root.render(<Chart spec={spec as never} ariaLabel="t" signals={{ shift: 30 }} />) })
      expect(container.innerHTML).not.toBe(before)
      expect(container.innerHTML).toBe(dom(<Chart spec={spec as never} ariaLabel="t" signals={{ shift: 30 }} />))
      act(() => { root.unmount() })
      container.remove()
    })
  })
})
