// @vitest-environment jsdom
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { describe, it, expect } from 'vitest'
import { Chart } from './Chart'

function makeSpec() {
  return {
    $schema: 'https://vega.github.io/schema/vega/v6.json',
    width: 200,
    height: 100,
    padding: 5,
    background: 'white',
    autosize: 'none',
    data: [
      { name: 'table', values: [{ x: 0, y: 10 }, { x: 1, y: 20 }, { x: 2, y: 15 }] },
    ],
    scales: [
      { name: 'x', type: 'linear', domain: { data: 'table', field: 'x' } as never, range: 'width' },
      { name: 'y', type: 'linear', domain: { data: 'table', field: 'y' } as never, range: [100, 0] as never },
    ],
    marks: [
      {
        type: 'line',
        from: { data: 'table' },
        encode: {
          enter: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'y' }, stroke: { value: 'steelblue' }, strokeWidth: { value: 2 } },
        },
      },
    ],
  }
}

describe('Chart renderer="canvas"', () => {
  it('renders a canvas element sized to the scene', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(<Chart spec={makeSpec()} width={200} height={100} renderer="canvas" />)
    })
    const canvas = container.querySelector('canvas')
    expect(canvas).not.toBeNull()
    // Scene size = spec size + padding (autosize pad)
    expect(Number(canvas!.getAttribute('width'))).toBe(210)
    expect(Number(canvas!.getAttribute('height'))).toBe(110)
    expect(canvas!.style.width).toBe('210px')
    await act(async () => {
      root.unmount()
    })
  })

  it('emits no SVG markup in canvas mode', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(<Chart spec={makeSpec()} width={200} height={100} renderer="canvas" />)
    })
    expect(container.querySelector('svg')).toBeNull()
    await act(async () => {
      root.unmount()
    })
  })

  it('redraws without leaking elements when the spec changes', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(<Chart spec={makeSpec()} width={200} height={100} renderer="canvas" />)
    })
    const spec2 = makeSpec()
    ;(spec2.data![0]! as { values: unknown[] }).values = [{ x: 0, y: 5 }, { x: 1, y: 9 }, { x: 2, y: 1 }]
    await act(async () => {
      root.render(<Chart spec={spec2} renderer="canvas" />)
    })
    // Still exactly one canvas, no stray SVG nodes.
    expect(container.querySelectorAll('canvas').length).toBe(1)
    expect(container.querySelector('svg')).toBeNull()
    await act(async () => {
      root.unmount()
    })
  })

  it('SSR renders empty for canvas mode without throwing', async () => {
    const { renderToString } = await import('react-dom/server')
    const html = renderToString(<Chart spec={makeSpec()} renderer="canvas" />)
    expect(html).toContain('<canvas')
    expect(html).not.toContain('<svg')
  })
})
