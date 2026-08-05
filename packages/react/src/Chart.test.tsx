import * as React from 'react'
import { renderToString } from 'react-dom/server'
import { describe, it, expect } from 'vitest'
import { Chart } from './Chart'

describe('Chart', () => {
  it('renders an SVG for a minimal line chart spec', () => {
    const spec = {
      $schema: 'https://vega.github.io/schema/vega/v6.json',
      width: 400,
      height: 300,
      padding: 5,
      background: 'white',
      autosize: 'none',
      data: [
        {
          name: 'table',
          values: [{ x: 0, y: 10 }, { x: 1, y: 20 }, { x: 2, y: 15 }],
        },
      ],
      scales: [
        {
          name: 'x',
          type: 'linear',
          domain: { data: 'table', field: 'x' } as never,
          range: 'width',
          nice: true,
        },
        {
          name: 'y',
          type: 'linear',
          domain: { data: 'table', field: 'y' } as never,
          range: [{ signal: 'height' }, 0],
          nice: true,
        },
      ],
      marks: [
        {
          type: 'line',
          from: { data: 'table' },
          encode: {
            update: {
              x: { scale: 'x', field: 'x' },
              y: { scale: 'y', field: 'y' },
              stroke: { value: 'steelblue' },
              strokeWidth: { value: 2 },
            },
          },
        },
      ],
    }
    const markup = renderToString(
      <Chart spec={spec} ariaLabel="t" />
    )
    expect(markup).toContain('<svg')
  })

  it('container div has width 100% and height 100% inline style', () => {
    const spec = {
      $schema: 'https://vega.github.io/schema/vega/v6.json',
      width: 400,
      height: 300,
      padding: 5,
      background: 'white',
      autosize: 'none',
      data: [
        {
          name: 'table',
          values: [{ x: 0, y: 10 }, { x: 1, y: 20 }, { x: 2, y: 15 }],
        },
      ],
      scales: [
        {
          name: 'x',
          type: 'linear',
          domain: { data: 'table', field: 'x' } as never,
          range: 'width',
          nice: true,
        },
        {
          name: 'y',
          type: 'linear',
          domain: { data: 'table', field: 'y' } as never,
          range: [{ signal: 'height' }, 0],
          nice: true,
        },
      ],
      marks: [
        {
          type: 'line',
          from: { data: 'table' },
          encode: {
            update: {
              x: { scale: 'x', field: 'x' },
              y: { scale: 'y', field: 'y' },
              stroke: { value: 'steelblue' },
              strokeWidth: { value: 2 },
            },
          },
        },
      ],
    }
    const markup = renderToString(
      <Chart spec={spec} ariaLabel="t" />
    )
    expect(markup).toMatch(/style=".*width:100%.*height:100%.*"/)
  })
})
