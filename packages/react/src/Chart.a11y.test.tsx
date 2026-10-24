// @vitest-environment jsdom
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { describe, it, expect, afterEach } from 'vitest'
import type { ChartHandle } from './Chart'
import { forEachVariant } from './testing/variants'

// The matrix runs every test below on <Chart>, <SvgChart> and <SvgChart interaction={interaction}>;
// `Chart` is the variant's component (see testing/variants.tsx).
forEachVariant(['svg'], (Chart, variant) => {
  function spec(padding: number) {
    return {
      $schema: 'https://vega.github.io/schema/vega/v6.json',
      width: 200, height: 100, padding, autosize: 'none',
      data: [{ name: 't', values: [{ px: 0, py: 0, c: 'a' }, { px: 5, py: 5, c: 'b' }, { px: 10, py: 10, c: 'c' }] }],
      scales: [
        { name: 'x', type: 'linear', domain: [0, 10], range: 'width', nice: false },
        { name: 'y', type: 'linear', domain: [0, 10], range: 'height', nice: false },
      ],
      axes: [{ scale: 'x', orient: 'bottom' }, { scale: 'y', orient: 'left' }],
      marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: {
        x: { scale: 'x', field: 'px' }, y: { scale: 'y', field: 'py' }, size: { value: 100 }, description: { field: 'c' },
      } } }],
    } as never
  }

  function mount(node: React.ReactElement) {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(node) })
    return container
  }
  afterEach(() => { document.body.innerHTML = '' })

  const nodes = (c: HTMLElement): HTMLElement[] => [...c.querySelectorAll<HTMLElement>('[data-a11y-id]')]
  const press = (el: HTMLElement, key: string): void => {
    act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })) })
  }

  describe('roving tabindex (C67)', () => {
    it('exactly one a11y node is a tab stop; the rest are tabindex -1', () => {
      const c = mount(<Chart spec={spec(5)} width={200} height={100} />)
      const all = nodes(c)
      expect(all.length).toBeGreaterThan(4)
      expect(all.filter((n) => n.tabIndex === 0)).toHaveLength(1)
      expect(all.filter((n) => n.getAttribute('tabindex') === '-1')).toHaveLength(all.length - 1)
    })

    it('arrow keys move focus and the tab stop follows it', () => {
      const c = mount(<Chart spec={spec(5)} width={200} height={100} />)
      const marks = nodes(c).filter((n) => n.dataset.a11yKind === 'mark')
      expect(marks.length).toBe(3)
      act(() => { marks[0]!.focus() })
      expect(marks[0]!.tabIndex).toBe(0)
      press(marks[0]!, 'ArrowRight')
      expect(document.activeElement).toBe(marks[1])
      expect(marks[1]!.tabIndex).toBe(0)
      expect(marks[0]!.tabIndex).toBe(-1)
      expect(nodes(c).filter((n) => n.tabIndex === 0)).toHaveLength(1)
      const all = nodes(c)
      press(marks[1]!, 'End')
      expect(document.activeElement).toBe(all.at(-1))
      expect(all.filter((n) => n.tabIndex === 0)).toEqual([all.at(-1)])
      press(all.at(-1)!, 'ArrowLeft')
      press(document.activeElement as HTMLElement, 'Home')
      expect(document.activeElement).toBe(all[0])
    })

    it('PageDown/PageUp leave a slider axis (whose arrows pan) for the neighbouring node', () => {
      const c = mount(<Chart spec={spec(5)} width={200} height={100} panZoom />)
      const all = nodes(c)
      const slider = all.find((n) => n.getAttribute('role') === 'slider')!
      act(() => { slider.focus() })
      const idx = all.indexOf(slider)
      press(slider, 'PageDown')
      expect(document.activeElement).toBe(all[(idx + 1) % all.length])
      press(document.activeElement as HTMLElement, 'PageUp')
      expect(document.activeElement).toBe(slider)
    })
  })

  describe('a11y nodes sit on the rendered marks, padding included (C67)', () => {
    it.each([5, 40])('padding %i', (padding) => {
      const ref = React.createRef<ChartHandle>()
      const c = mount(<Chart ref={ref} spec={spec(padding)} width={200} height={100} />)
      const scene = ref.current!.getScene()!
      const symbols = (function find(n: unknown): Array<{ x: number; y: number }> {
        const g = n as { marktype?: string; role?: string; items?: unknown[] }
        if (g.marktype === 'symbol' && g.role === 'mark') return g.items as Array<{ x: number; y: number }>
        return (g.items ?? []).flatMap((i) => (Array.isArray((i as { items?: unknown[] }).items) ? find(i) : []))
      })({ items: scene.items })
      const marks = nodes(c).filter((n) => n.dataset.a11yKind === 'mark')
      expect(marks).toHaveLength(symbols.length)
      symbols.forEach((s, i) => {
        const el = marks[i]!
        const left = parseFloat(el.style.left)
        const top = parseFloat(el.style.top)
        const w = parseFloat(el.style.width)
        const h = parseFloat(el.style.height)
        // The element's box (in the chart's coordinates) contains the symbol's centre in the padded SVG.
        const cx = padding + s.x
        const cy = padding + s.y
        expect(cx).toBeGreaterThanOrEqual(left - 0.5)
        expect(cx).toBeLessThanOrEqual(left + w + 0.5)
        expect(cy).toBeGreaterThanOrEqual(top - 0.5)
        expect(cy).toBeLessThanOrEqual(top + h + 0.5)
      })
    })
  })
})
