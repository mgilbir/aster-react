// @vitest-environment jsdom
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { describe, it, expect } from 'vitest'
import { forEachVariant } from './testing/variants'

// The matrix runs every test below on <Chart>, <SvgChart> and <SvgChart interaction={interaction}>;
// `Chart` is the variant's component (see testing/variants.tsx).
forEachVariant(['svg'], (Chart, variant) => {
  /**
   * Regression guard for the no-op re-render path: an inline-literal spec (fresh
   * object, identical content) must not re-parse the SVG or re-run the pipeline.
   */
  function makeSpec() {
    return {
      $schema: 'https://vega.github.io/schema/vega/v6.json',
      width: 200,
      height: 100,
      padding: 5,
      background: 'white',
      autosize: 'none',
      data: [{ name: 'table', values: Array.from({ length: 20 }, (_, i) => ({ x: i, y: (i * 7) % 13 })) }],
      scales: [
        { name: 'x', type: 'linear', domain: [0, 20], range: [0, 200] },
        { name: 'y', type: 'linear', domain: [0, 13], range: [100, 0] },
      ],
      axes: [
        { scale: 'x', orient: 'bottom', grid: true },
        { scale: 'y', orient: 'left', grid: true },
      ],
      marks: [{
        type: 'symbol',
        from: { data: 'table' },
        encode: { update: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'y' }, size: { value: 20 } } },
      }],
    }
  }

  function renderChart(root: ReturnType<typeof createRoot>, spec: Record<string, unknown>): Promise<void> {
    return act(async () => {
      root.render(<Chart spec={spec as never} width={200} height={100} a11y={false} />)
    })
  }

  describe('Chart no-op re-renders', () => {
    it('keeps the <svg> and writes no DOM on identical content', async () => {
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)

      const spec = makeSpec()
      await renderChart(root, spec)
      expect(container.querySelector('svg')).not.toBeNull()

      // The commit that drops the first-render markup may rebuild once; from then
      // on identical content must be a pure no-op.
      await renderChart(root, { ...spec })
      const svg = container.querySelector('svg')!

      let mutations = 0
      const observer = new MutationObserver((records) => { mutations += records.length })
      observer.observe(container, { subtree: true, childList: true, attributes: true, characterData: true })
      await renderChart(root, { ...spec })
      await renderChart(root, { ...spec })
      observer.disconnect()

      expect(container.querySelector('svg')).toBe(svg)
      expect(mutations).toBe(0)

      await act(async () => { root.unmount() })
      container.remove()
    })
  })
})
