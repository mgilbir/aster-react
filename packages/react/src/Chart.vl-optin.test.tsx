// @vitest-environment jsdom
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { describe, it, expect } from 'vitest'
import { hasVegaLiteCompiler } from './vl-registry'
import { isVegaLiteSpec, normalizeChartSpec } from './spec'
import { forEachVariant } from './testing/variants'

const vlSpec = {
  $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
  width: 200,
  height: 100,
  data: { values: [{ c: 'a', v: 3 }] },
  mark: 'bar',
  encoding: { x: { field: 'c', type: 'nominal' }, y: { field: 'v', type: 'quantitative' } },
} as never

// This file deliberately does NOT import '@aster-charts/react/vl': the base entry must
// keep working for Vega specs and fail loudly (with instructions) for VL ones.
describe('Vega-Lite is opt-in', () => {
  it('does not have a compiler registered by default', () => {
    expect(hasVegaLiteCompiler()).toBe(false)
  })

  it('detects VL but explains how to enable it', () => {
    expect(isVegaLiteSpec(vlSpec)).toBe(true)
    expect(() => normalizeChartSpec(vlSpec)).toThrow(/import '@aster-charts\/react\/vl'/)
  })

  it('leaves Vega specs untouched', () => {
    const vega = {
      $schema: 'https://vega.github.io/schema/vega/v6.json',
      width: 10, height: 10, data: [], marks: [],
    }
    expect(normalizeChartSpec(vega as never)).toBe(vega)
  })

  forEachVariant(['svg'], (Chart) => {
    it('reports a VL spec without the compiler through the error state and onError (with the fix), never a throw', () => {
      ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      const errors: Error[] = []
      // A missing addon is reported like every other chart failure (one error channel): the alert, and `onError` with the
      // exact import to add. It does not unmount the host's tree.
      act(() => { root.render(<Chart spec={vlSpec} width={200} height={100} a11y={false} onError={(e) => errors.push(e)} />) })
      expect(container.querySelector('[role="alert"]')).not.toBeNull()
      expect(errors).toHaveLength(1)
      expect(errors[0]!.message).toMatch(/@aster-charts\/react\/vl/)
      act(() => root.unmount())
      container.remove()
    })
  })
})
