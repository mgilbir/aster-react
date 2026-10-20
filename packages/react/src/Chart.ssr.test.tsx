// @vitest-environment jsdom
import * as React from 'react'
import { renderToString } from 'react-dom/server'
import { hydrateRoot } from 'react-dom/client'
import { act } from 'react'
import { describe, it, expect, afterEach } from 'vitest'
import { Chart } from './Chart'
import { hydrateChart, renderChartToStaticMarkup } from './ssr'

const spec = {
  $schema: 'https://vega.github.io/schema/vega/v6.json',
  width: 120, height: 80, padding: 5, autosize: 'none',
  data: [{ name: 't', values: [{ x: 0, y: 1 }, { x: 1, y: 2 }] }],
  scales: [
    { name: 'x', type: 'linear', domain: [0, 1], range: 'width' },
    { name: 'y', type: 'linear', domain: [0, 2], range: 'height' },
  ],
  axes: [{ scale: 'x', orient: 'bottom' }],
  marks: [{ type: 'line', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'y' }, stroke: { value: 'steelblue' } } } }],
} as never

describe('SSR string render + hydration (R11.3)', () => {
  afterEach(() => { document.body.innerHTML = '' })

  it('ships the full SVG in the server string', () => {
    const server = renderToString(<Chart spec={spec} width={120} height={80} ariaLabel="ssr" />)
    expect(server).toContain('<svg')
    expect(server).toContain('data-aster-view="base"')
    expect(server).not.toContain('aria-busy')
    expect(renderChartToStaticMarkup(spec as never, { width: 120, height: 80 })).toContain('<svg')
  })

  it('hydrates the server svg through the DOM patcher without replacing it', () => {
    const container = document.createElement('div')
    container.innerHTML = renderChartToStaticMarkup(spec as never, { width: 120, height: 80 })
    document.body.appendChild(container)
    const before = container.querySelector('svg')!
    const result = hydrateChart(container, spec as never, { width: 120, height: 80, tooltips: true })
    expect(result.reused).toBe(true)
    expect(result.svg).toBe(before)
    expect(container.querySelector('svg .mark-line path')).not.toBeNull()
    expect(container.querySelectorAll('svg')).toHaveLength(1)
  })

  it('reaches the same DOM through React hydration', async () => {
    const server = renderToString(<Chart spec={spec} width={120} height={80} ariaLabel="ssr" />)
    const container = document.createElement('div')
    container.innerHTML = server
    document.body.appendChild(container)
    const root = hydrateRoot(container, <Chart spec={spec} width={120} height={80} ariaLabel="ssr" />)
    await act(async () => { await Promise.resolve() })
    expect(container.querySelectorAll('svg')).toHaveLength(1)
    expect(container.querySelector('svg .mark-line path')).not.toBeNull()
    act(() => { root.unmount() })
  })
})
