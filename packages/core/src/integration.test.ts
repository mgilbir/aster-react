import { describe, it, expect } from 'vitest'
import { renderSpec } from './index.js'

describe('integration', () => {
  it('renderSpec produces correct SVG for a line chart spec', () => {
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
          values: [
            { x: 0, y: 10 },
            { x: 1, y: 20 },
            { x: 2, y: 15 },
          ],
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
    const svg = renderSpec(spec)
    expect(svg).toContain('<svg')
    expect(svg).toContain('M0,0h400v300h-400Z')
    // Check line path: x=0→M0, y=10→pos 150; x=1→pos 200, y=20→pos 0; x=2→pos 400, y=15→pos 75
    expect(svg).toContain('M0,150L200,0L400,75')
  })

  it('RuntimeInput width/height override an explicit numeric spec size', () => {
    const spec = {
      $schema: 'https://vega.github.io/schema/vega/v6.json',
      width: 400,
      height: 300,
      padding: 5,
      data: [{ name: 'table', values: [{ x: 0, y: 10 }, { x: 1, y: 20 }, { x: 2, y: 15 }] }],
      scales: [
        { name: 'x', type: 'linear', domain: { data: 'table', field: 'x' } as never, range: 'width', nice: true },
        { name: 'y', type: 'linear', domain: { data: 'table', field: 'y' } as never, range: [{ signal: 'height' }, 0], nice: true },
      ],
      marks: [
        {
          type: 'line',
          from: { data: 'table' },
          encode: { update: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'y' }, stroke: { value: 'steelblue' } } },
        },
      ],
    }
    const svg = renderSpec(spec, { width: 700, height: 500 })
    expect(svg).toContain('width="710"')
    expect(svg).toContain('M0,0h700v500h-700Z')
    expect(svg).toContain('M0,250L350,0L700,125')
  })
})
