// @vitest-environment jsdom
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { describe, it, expect, afterEach } from 'vitest'
import type { ChartHandle } from './Chart'
import { forEachVariant } from './testing/variants'

// The view's background, padding and size as `{signal}` properties (vega: signals of the view). A <Chart> draws what the signals
// hold, and a write through the `signals` prop, `setSignal` or an event handler lays the view out again.
forEachVariant(['svg'], (Chart, variant) => {
  const spec = {
    $schema: 'https://vega.github.io/schema/vega/v6.json',
    width: { signal: 'w * 2' }, height: 40, autosize: 'none',
    background: { signal: 'c' }, padding: { signal: 'p' },
    signals: [
      { name: 'c', value: 'red' },
      { name: 'p', value: 5, on: [{ events: 'click', update: 'p + 10' }] },
      { name: 'w', value: 30 },
    ],
    marks: [{ type: 'rect', encode: { update: { x: { value: 0 }, y: { value: 0 }, width: { value: 10 }, height: { value: 10 }, fill: { value: 'steelblue' } } } }],
  } as never

  // (the same view with no event stream: every variant draws it, an event loop or not)
  const plain = { ...(spec as Record<string, unknown>), signals: [{ name: 'c', value: 'red' }, { name: 'p', value: 5 }, { name: 'w', value: 30 }] } as never

  const svgOf = (el: HTMLElement): SVGSVGElement => el.querySelector('svg')!
  const background = (el: HTMLElement): string | null => svgOf(el).querySelector(':scope > rect')?.getAttribute('fill') ?? null
  const translate = (el: HTMLElement): string | null => svgOf(el).querySelector(':scope > g')?.getAttribute('transform') ?? null
  const size = (el: HTMLElement): [string | null, string | null] => [svgOf(el).getAttribute('width'), svgOf(el).getAttribute('height')]

  describe('view properties that are signals', () => {
    afterEach(() => { document.body.innerHTML = '' })

    it('draws what the signals hold, and follows the signals prop and setSignal', () => {
      const ref = React.createRef<ChartHandle>()
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      act(() => { root.render(<Chart ref={ref} spec={plain} />) })
      expect(background(container)).toBe('red')
      expect(translate(container)).toBe('translate(5,5)')
      expect(size(container)).toEqual(['70', '50'])
      act(() => { root.render(<Chart ref={ref} spec={plain} signals={{ c: 'blue', p: 20, w: 50 }} />) })
      expect(background(container)).toBe('blue')
      expect(translate(container)).toBe('translate(20,20)')
      expect(size(container)).toEqual(['140', '80'])
      act(() => { ref.current!.setSignal('c', null) })
      // (a falsy background draws none)
      expect(background(container)).toBeNull()
      act(() => { root.unmount() })
    })

    variant.it(['signals'], 'an event handler that writes the padding lays the view out again', () => {
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      act(() => { root.render(<Chart spec={spec} />) })
      expect(translate(container)).toBe('translate(5,5)')
      act(() => { svgOf(container).dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      expect(translate(container)).toBe('translate(15,15)')
      expect(size(container)).toEqual(['90', '70'])
      act(() => { root.unmount() })
    })
  })
})
