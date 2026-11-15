// @vitest-environment jsdom
/**
 * A scene that leaves the accessible tree as it was renders nothing of the accessible overlay again: on a pointer move the chart is
 * rendered for its new scene, and every node of the overlay (one per axis and mark, with its handlers and style) was rendered and
 * diffed again although none of them changed.
 *
 * Whether a node's element was rendered is read off the props React keeps on it (a new object for each render of the element); a
 * node that changes is rendered with what it holds now.
 */
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import * as React from 'react'
import { describe, it, expect } from 'vitest'
import { forEachVariant } from './testing/variants'
import type { ChartHandle } from './chart-types'

/** The props React rendered an element with last (React keeps them on the element). */
const reactProps = (el: Element): unknown => {
  const key = Object.keys(el).find((k) => k.startsWith('__reactProps'))
  return key === undefined ? undefined : (el as unknown as Record<string, unknown>)[key]
}

forEachVariant(['svg'], (Chart) => {
  const spec = {
    width: 300, height: 200, padding: 20, autosize: 'none',
    signals: [{ name: 'other', value: 0 }, { name: 'title', value: 'Days' }],
    data: [{ name: 't', values: [{ x: 1, y: 2 }, { x: 4, y: 3 }] }],
    scales: [{ name: 'x', type: 'linear', domain: [0, 10], range: 'width' }, { name: 'y', type: 'linear', domain: [0, 10], range: 'height' }],
    axes: [{ scale: 'x', orient: 'bottom', title: { signal: 'title' } }, { scale: 'y', orient: 'left' }],
    marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'y' }, opacity: { signal: 'other ? 0.5 : 1' } } } }],
  }

  describe('the accessible overlay renders again only what changed', () => {
    it('a signal that leaves the tree as it was renders none of its nodes; a title that changes renders its axis node', () => {
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      const ref = React.createRef<ChartHandle>()
      act(() => { root.render(<Chart ref={ref} spec={spec} width={340} height={240} signals={{ other: 0 }} />) })
      const nodes = (): Element[] => [...container.querySelectorAll('[data-a11y-id]')]
      const before = nodes().map(reactProps)
      expect(before.length).toBeGreaterThan(2)
      expect(before.every((p) => p !== undefined)).toBe(true)
      act(() => { root.render(<Chart ref={ref} spec={spec} width={340} height={240} signals={{ other: 1 }} />) })
      // (a new scene: its marks changed opacity, the tree did not)
      expect(nodes().map(reactProps).every((p, i) => p === before[i])).toBe(true)
      const label = (): string | null => nodes()[0]!.getAttribute('aria-label')
      expect(label()).toContain('Days')
      act(() => { root.render(<Chart ref={ref} spec={spec} width={340} height={240} signals={{ other: 1, title: 'Months' }} />) })
      expect(label()).toContain('Months')
      // (the same chart: a node changed, so the overlay is rendered again)
      const after = nodes().map(reactProps)
      expect(after[0]).not.toBe(before[0])
      act(() => { root.unmount() })
      container.remove()
    })
  })
})
