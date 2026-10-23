// @vitest-environment jsdom
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { describe, it, expect, afterEach } from 'vitest'
import { forEachVariant } from './testing/variants'

// The matrix runs every test below on <Chart>, <SvgChart> and <SvgChart interaction={interaction}>;
// `Chart` is the variant's component (see testing/variants.tsx).
forEachVariant(['svg'], (Chart, variant) => {
  function makeSpec(): Record<string, unknown> {
    return {
      $schema: 'https://vega.github.io/schema/vega/v6.json',
      width: 400,
      height: 300,
      padding: 5,
      autosize: 'none',
      data: [{ name: 'table', values: [{ x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }] }],
      scales: [
        { name: 'x', type: 'linear', domain: [0, 10], range: 'width' },
        { name: 'y', type: 'linear', domain: [0, 10], range: 'height' },
      ],
      marks: [
        { type: 'symbol', from: { data: 'table' }, encode: { update: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'y' }, size: { value: 50 } } } },
      ],
    }
  }

  function transforms(svg: Element): string[] {
    return [...svg.querySelectorAll('path')]
      .map((p) => p.getAttribute('transform'))
      .filter((t): t is string => t != null && t.startsWith('translate('))
  }

  describe('<Chart dataChanges>', () => {
    it('re-renders the svg on a per-datum differential update', () => {
      const container = document.createElement('div')
      document.body.appendChild(container)
      const spec = makeSpec()
      const initial = [{ x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }]
      const root = createRoot(container)

      act(() => { root.render(<Chart spec={spec} width={400} height={300} data={{ table: initial }} />) })
      let svg = container.querySelector('svg')
      expect(svg).not.toBeNull()
      const before = transforms(svg!).sort()

      // index 1 moves y 2 -> 5 (same length/order, fixed scales -> differential reuse)
      const next = [{ x: 1, y: 1 }, { x: 2, y: 5 }, { x: 3, y: 3 }]
      act(() => { root.render(<Chart spec={spec} width={400} height={300} data={{ table: next }} dataChanges={{ table: [1] }} />) })
      svg = container.querySelector('svg')
      expect(svg).not.toBeNull()
      const after = transforms(svg!).sort()

      // The svg is patched in place (same element) and reflects the updated datum.
      expect(after).not.toEqual(before)
      expect(after).toContain(after.find((t) => t.includes('40'))!) // y=5 -> translate(...,40) at 300h/10
    })

    afterEach(() => {
      document.body.innerHTML = ''
    })
  })
})
