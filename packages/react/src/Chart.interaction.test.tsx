// @vitest-environment jsdom
import { beforeEach } from 'vitest'
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { Chart } from './Chart'

function makeBrushVegaSpec() {
  return {
    $schema: 'https://vega.github.io/schema/vega/v6.json',
    width: 400,
    height: 300,
    padding: 5,
    background: 'white',
    autosize: 'none',
    signals: [
      { name: 'brush', value: null, type: 'object' },
    ],
    data: [
      {
        name: 'table',
        values: [
          { x: 1, y: 2 }, { x: 2, y: 4 }, { x: 3, y: 3 },
          { x: 4, y: 5 }, { x: 5, y: 2 },
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
        type: 'point',
        from: { data: 'table' },
        encode: {
          update: {
            x: { scale: 'x', field: 'x' },
            y: { scale: 'y', field: 'y' },
            fill: { value: 'steelblue' },
            fillOpacity: { value: 0.7 },
            size: { value: 50 },
          },
        },
      },
    ],
  }
}

describe('Chart brush interaction', () => {
  const setPointerCaptures = vi.fn()
  const releasePointerCaptures = vi.fn()

  beforeEach(() => {
    ;(Element.prototype as unknown as Record<string, unknown>).setPointerCapture = setPointerCaptures
    ;(Element.prototype as unknown as Record<string, unknown>).releasePointerCapture = releasePointerCaptures
    ;(Element.prototype as unknown as Record<string, unknown>).hasPointerCapture = vi.fn(() => false)
    ;(Element.prototype as unknown as Record<string, unknown>).getPointerCapture = vi.fn(() => null)
  })

  afterEach(() => {
    setPointerCaptures.mockReset()
    releasePointerCaptures.mockReset()
    document.body.innerHTML = ''
  })

  it('dispatching pointer events on the overlay calls onSelect with a valid interval', () => {
    const onSelect = vi.fn()
    const spec = makeBrushVegaSpec()

    const container = document.createElement('div')
    container.style.width = '445px'
    container.style.height = '340px'
    document.body.appendChild(container)

    let root: ReturnType<typeof createRoot> | null = null

    act(() => {
      root = createRoot(container)
      root.render(<Chart spec={spec} width={400} height={300} onSelect={onSelect} ariaLabel="brush test" />)
    })

    // Verify the interactive overlay exists
    const overlay = container.querySelector('[data-testid="chart-brush-overlay"]')
    expect(overlay).not.toBeNull()

    // Mock getBoundingClientRect so coordinates map correctly
    const rect: DOMRect = {
      left: 0, top: 0, width: 445, height: 340,
      right: 445, bottom: 340, x: 0, y: 0,
      toJSON: () => ({}),
    }
    overlay!.getBoundingClientRect = () => rect as DOMRect
    ;(container as HTMLElement).getBoundingClientRect = () => rect as DOMRect

    // Simulate drag: pointerdown → pointermove → pointerup
    act(() => {
      overlay!.dispatchEvent(new PointerEvent('pointerdown', {
        clientX: 100, clientY: 80, pointerId: 1, bubbles: true,
      }))
    })
    act(() => {
      overlay!.dispatchEvent(new PointerEvent('pointermove', {
        clientX: 200, clientY: 150, pointerId: 1, bubbles: true,
      }))
    })
    act(() => {
      overlay!.dispatchEvent(new PointerEvent('pointerup', {
        clientX: 200, clientY: 150, pointerId: 1, bubbles: true,
      }))
    })

    // onSelect should have been called once with a non-null interval
    expect(onSelect).toHaveBeenCalledTimes(1)
    const interval = onSelect.mock.calls[0]![0] as any
    expect(interval).not.toBeNull()
    expect(Array.isArray(interval!.x)).toBe(true)
    expect(Array.isArray(interval!.y)).toBe(true)
    expect(interval!.x!.length).toBe(2)
    expect(interval!.y!.length).toBe(2)
    expect(Number.isFinite(interval!.x![0])).toBe(true)
    expect(Number.isFinite(interval!.x![1])).toBe(true)
    expect(Number.isFinite(interval!.y![0])).toBe(true)
    expect(Number.isFinite(interval!.y![1])).toBe(true)

    root!.unmount()
  })
})
