// @vitest-environment jsdom
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { describe, it, expect, afterEach } from 'vitest'
import { compile } from '@aster-charts/vl'
import { forEachVariant } from './testing/variants'
import type { TooltipInfo } from './chart-types'

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
      { type: 'symbol', from: { data: 'table' }, encode: { update: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'y' }, size: { value: 50 }, tooltip: { signal: 'datum' } } } },
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
      // Hover over the first symbol, at x=1,y=2 on 0..10 scales over 400x300 + 5 padding (the datum comes from the scene hit index; the markup carries no stamp of it).
      const sym = svg.querySelector('.mark-symbol path') as Element
      expect(sym).not.toBeNull()
      const rect = container.getBoundingClientRect()
      act(() => {
        sym.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: rect.left + 45, clientY: rect.top + 245 }))
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
      const sym = container.querySelector('svg .mark-symbol path') as Element
      act(() => {
        sym.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 45, clientY: 245 }))
      })
      const tip = container.querySelector('[data-testid="chart-tooltip"]')!
      expect(tip.querySelector('[data-testid="custom-tip"]')?.textContent).toBe('point a')
      act(() => { root.unmount() })
    })

    // The scene's datum is the pure source row, so the tooltip
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
        const sym = container.querySelector('svg .mark-symbol path') as Element
        act(() => { sym.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 45, clientY: 245 })) })
        const text = container.querySelector('[data-testid="chart-tooltip"]')!.textContent!
        for (const [k, v] of Object.entries(row)) expect(text).toContain(`${k}: ${v}`)
        act(() => { root.render(<Chart spec={dataSpec} width={400} height={300} renderTooltip={(d) => { seen.push(d); return null }} />) })
        const sym2 = container.querySelector('svg .mark-symbol path') as Element
        act(() => { sym2.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 45, clientY: 245 })) })
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

    // Issue #129: vega (with vega-tooltip) shows the item's `tooltip` value, not the datum.
    describe("shows the item's tooltip value, as vega-tooltip does", () => {
      const hover = (tooltipEncode: Record<string, unknown> | null, props: Record<string, unknown> = { tooltip: true }): { tip: Element | null; root: { unmount(): void } } => {
        const update: Record<string, unknown> = { ...spec.marks[0]!.encode.update }
        delete update.tooltip
        if (tooltipEncode) update.tooltip = tooltipEncode
        const tipSpec = { ...spec, data: [{ name: 'table', values: [{ x: 1, y: 2, label: 'a' }] }], marks: [{ ...spec.marks[0]!, encode: { update } }] }
        const container = document.createElement('div')
        document.body.appendChild(container)
        const root = createRoot(container)
        act(() => { root.render(<Chart spec={tipSpec} width={400} height={300} {...props} />) })
        const sym = container.querySelector('svg .mark-symbol path') as Element
        act(() => { sym.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 45, clientY: 245 })) })
        return { tip: container.querySelector('[data-testid="chart-tooltip"]'), root }
      }

      it('a mark without a tooltip channel shows no tooltip', () => {
        expect(hover(null).tip).toBeNull()
      })

      it("an object: its title, then a row per defined key; nested objects as JSON", () => {
        const { tip } = hover({ signal: "{title: 'Point ' + datum.label, X: datum.x, nested: {a: 1}, gone: datum.missing}" })
        const lines = [...tip!.children].map((c) => c.textContent)
        expect(lines).toEqual(['Point a', 'X: 1', 'nested: {"a":1}'])
      })

      it('a string or a number is the text; an array is [a, b]; an empty string shows nothing', () => {
        expect(hover({ signal: "'x is ' + datum.x" }).tip!.textContent).toBe('x is 1')
        expect(hover({ field: 'y' }).tip!.textContent).toBe('2')
        expect(hover({ signal: "[datum.label, datum.x, {k: 1}]" }).tip!.textContent).toBe('[a, 1, {"k":1}]')
        expect(hover({ value: '' }).tip).toBeNull()
      })

      it("renderTooltip gets the datum and the item's tooltip value and the item", () => {
        const seen: Array<[Record<string, unknown>, TooltipInfo]> = []
        const { tip } = hover({ signal: '{N: datum.x}' }, { renderTooltip: (d: Record<string, unknown>, info: TooltipInfo) => { seen.push([d, info]); return <span data-testid="custom">{String((info.tooltip as { N: number }).N)}</span> } })
        expect(tip!.textContent).toBe('1')
        const [datum, info] = seen.at(-1)!
        expect(datum).toEqual({ x: 1, y: 2, label: 'a' })
        expect(info.tooltip).toEqual({ N: 1 })
        expect(info.item.datum).toBe(datum)
        // without a tooltip channel the custom renderer is still called for the datum, with an undefined value
        hover(null, { renderTooltip: (d: Record<string, unknown>, i: TooltipInfo) => { seen.push([d, i]); return null } })
        expect(seen.at(-1)![1].tooltip).toBeUndefined()
      })

      it("a Vega-Lite tooltip encoding: its titles and formats, none of the compiler's internal fields", () => {
        const vl = compile({
          width: 200, height: 100,
          data: { values: [{ date: '2026-01-01', n: 29 }] },
          mark: 'bar',
          encoding: {
            x: { field: 'date', type: 'temporal', timeUnit: 'yearmonthdate' },
            y: { field: 'n', type: 'quantitative', aggregate: 'sum' },
            tooltip: [{ field: 'date', type: 'temporal', timeUnit: 'yearmonthdate', title: 'Date' }, { field: 'n', type: 'quantitative', aggregate: 'sum', title: 'Count' }],
          },
        } as never) as never
        const container = document.createElement('div')
        document.body.appendChild(container)
        const root = createRoot(container)
        act(() => { root.render(<Chart spec={vl} tooltip />) })
        const bar = container.querySelector('svg .mark-rect path') as Element
        const box = bar.getAttribute('d')!.match(/-?[\d.]+/g)!.map(Number)
        const ox = Number(/translate\(([\d.]+),([\d.]+)\)/.exec(container.querySelector('svg > g')!.getAttribute('transform')!)![1])
        const oy = Number(/translate\(([\d.]+),([\d.]+)\)/.exec(container.querySelector('svg > g')!.getAttribute('transform')!)![2])
        act(() => { bar.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: ox + box[0]! + 2, clientY: oy + 98 })) })
        const lines = [...container.querySelector('[data-testid="chart-tooltip"]')!.children].map((c) => c.textContent)
        expect(lines).toEqual(['Date: Jan 01, 2026', 'Count: 29'])
        act(() => { root.unmount() })
      })
    })

    afterEach(() => { document.body.innerHTML = '' })
  })
})
