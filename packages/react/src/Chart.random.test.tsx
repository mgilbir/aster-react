// @vitest-environment jsdom
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { describe, it, expect, afterEach } from 'vitest'
import { forEachVariant } from './testing/variants'

const spec = {
  width: 80, height: 40, padding: 0, autosize: 'none',
  data: [{ name: 't', values: [{ i: 0 }, { i: 1 }, { i: 2 }], transform: [{ type: 'formula', as: 'r', expr: 'random()' }] }],
  marks: [{ type: 'text', from: { data: 't' }, encode: { update: { text: { field: 'r' }, x: { value: 0 }, y: { field: 'i', mult: 10 } } } }],
} as never

/** A counter-based source: the n-th draw is n / 100, so which draws a chart made is visible in what it shows. */
const counting = (): { next: () => number; drawn: () => number } => {
  let n = 0
  return { next: () => ++n / 100, drawn: () => n }
}

const texts = (container: HTMLElement): string[] => [...container.querySelectorAll('text')].map((t) => t.textContent ?? '')

afterEach(() => { document.body.innerHTML = '' })

describe('<Chart random> (the per-chart counterpart of vega\'s setRandom)', () => {
  forEachVariant(['svg'], (Chart) => {
    it('expressions draw from the given source, once per row, in row order', () => {
      const source = counting()
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      act(() => { root.render(<Chart spec={spec} width={80} height={40} random={source.next} />) })
      expect(texts(container)).toEqual(['0.01', '0.02', '0.03'])
      expect(source.drawn()).toBe(3)
    })

    it('a resize does not redraw: the transform\'s inputs did not change, and vega\'s dataflow would not have rerun it', () => {
      const source = counting()
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      act(() => { root.render(<Chart spec={spec} width={80} height={40} random={source.next} />) })
      act(() => { root.render(<Chart spec={spec} width={120} height={60} random={source.next} />) })
      expect(texts(container)).toEqual(['0.01', '0.02', '0.03'])
      expect(source.drawn()).toBe(3)
    })

    it('without a source expressions use Math.random', () => {
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      const real = Math.random
      Math.random = () => 0.5
      try {
        act(() => { root.render(<Chart spec={spec} width={80} height={40} />) })
      } finally {
        Math.random = real
      }
      expect(texts(container)).toEqual(['0.5', '0.5', '0.5'])
    })
  })
})
