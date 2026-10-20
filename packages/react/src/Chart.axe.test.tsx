// @vitest-environment jsdom
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { describe, it, expect, afterEach } from 'vitest'
import axe from 'axe-core'
import { Chart } from './Chart'

const spec = {
  $schema: 'https://vega.github.io/schema/vega/v6.json',
  width: 240, height: 140, padding: 5, autosize: 'none',
  data: [{ name: 't', values: [{ c: 'a', v: 3 }, { c: 'b', v: 7 }, { c: 'c', v: 5 }] }],
  scales: [
    { name: 'x', type: 'band', domain: { data: 't', field: 'c' }, range: 'width' },
    { name: 'y', type: 'linear', domain: [0, 8], range: 'height' },
  ],
  axes: [{ scale: 'x', orient: 'bottom', title: 'Category' }, { scale: 'y', orient: 'left', title: 'Value' }],
  title: { text: 'Axe chart' },
  marks: [{ type: 'rect', from: { data: 't' }, encode: { update: {
    x: { scale: 'x', field: 'c' }, width: { scale: 'x', band: 1 },
    y: { scale: 'y', field: 'v' }, y2: { scale: 'y', value: 0 }, fill: { value: 'steelblue' },
    description: { field: 'c' },
  } } }],
} as never

describe('accessibility audit', () => {
  afterEach(() => { document.body.innerHTML = '' })

  it('passes axe WCAG A/AA rules for the chart accessibility tree', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    act(() => { root.render(<Chart spec={spec} width={240} height={140} ariaLabel="Axe chart" />) })
    const results = await axe.run(container, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
      rules: { 'color-contrast': { enabled: false } },
    })
    expect(results.violations).toEqual([])
    act(() => { root.unmount() })
  })
})
