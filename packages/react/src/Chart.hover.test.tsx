// @vitest-environment jsdom
/**
 * `encode.hover` in `<Chart>` (C76): the pointer entering an item of a mark with a `hover` set encodes the item with it, leaving it
 * encodes it with the mark's `update` set, as vega's view.hover() does (on by default, as vega-embed has it for a Vega spec). A chart
 * that declares no signal still binds the loop for it, and the items a handler asks to be encoded again reach the evaluation
 * through the signal store. (The differential against vega's view is packages/conformance/src/hover-vs-vega.test.ts; this pins
 * the React side: the loop is bound, the store carries the requests, every variant that interacts.)
 */
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { describe, it, expect, afterEach } from 'vitest'
import { forEachVariant } from './testing/variants'

const spec = (): Record<string, unknown> => ({
  $schema: 'https://vega.github.io/schema/vega/v6.json',
  width: 200, height: 120, padding: 8, autosize: 'none',
  data: [{ name: 'd', values: [{ k: 'a', x: 10 }, { k: 'b', x: 70 }] }],
  marks: [{
    type: 'rect', from: { data: 'd' },
    encode: {
      enter: { y: { value: 10 }, width: { value: 40 }, height: { value: 40 } },
      update: { x: { field: 'x' }, fill: { value: 'steelblue' } },
      hover: { fill: { value: 'firebrick' }, stroke: { value: 'black' } },
    },
  }],
})

forEachVariant(['svg'], (Chart, variant) => {
  const mounted: Array<() => void> = []
  afterEach(() => { while (mounted.length) mounted.pop()!(); document.body.innerHTML = '' })

  function mount(props: Record<string, unknown>): { container: HTMLElement; fire(type: string, p: [number, number]): void; fills(): string[] } {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    act(() => { root.render(React.createElement(Chart as never, props)) })
    mounted.push(() => act(() => root.unmount()))
    const container = host.firstElementChild as HTMLElement
    container.getBoundingClientRect = () => ({ left: 0, top: 0, right: 216, bottom: 136, width: 216, height: 136 } as DOMRect)
    for (const el of container.querySelectorAll('svg')) (el as SVGElement).getBoundingClientRect = container.getBoundingClientRect
    return {
      container,
      fire(type, [x, y]) {
        const target = container.querySelector('svg') ?? container
        act(() => { target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y })) })
        for (const el of container.querySelectorAll('svg')) (el as SVGElement).getBoundingClientRect = container.getBoundingClientRect
      },
      fills: () => [...container.querySelectorAll('.mark-rect path')].map((p) => `${p.getAttribute('fill')}/${p.getAttribute('stroke') ?? '-'}`),
    }
  }

  describe('encode.hover', () => {
    variant.it(['interaction'], 'hovering an item encodes it with the hover set; leaving it runs the update set (hover-only channels stay)', () => {
      const m = mount({ spec: spec() })
      expect(m.fills()).toEqual(['steelblue/-', 'steelblue/-'])
      m.fire('pointerover', [30 + 8, 30 + 8])
      expect(m.fills()).toEqual(['firebrick/black', 'steelblue/-'])
      m.fire('pointerout', [30 + 8, 30 + 8])
      // (vega's leave runs `update`: the fill goes back, the stroke only `hover` writes stays)
      expect(m.fills()).toEqual(['steelblue/black', 'steelblue/-'])
      m.fire('pointerover', [90 + 8, 30 + 8])
      expect(m.fills()).toEqual(['steelblue/black', 'firebrick/black'])
    })
  })
})
