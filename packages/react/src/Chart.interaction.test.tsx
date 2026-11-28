// @vitest-environment jsdom
import { beforeEach } from 'vitest'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { forEachVariant } from './testing/variants'
import { stubPointerCapture, type PointerCaptureStub } from './testing/pointer-capture'

// The matrix runs every test below on <Chart>, <SvgChart> and <SvgChart interaction={interaction}>;
// `Chart` is the variant's component (see testing/variants.tsx).
forEachVariant(['svg'], (Chart, variant) => {
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
          type: 'symbol',
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
    let pointerCapture: PointerCaptureStub

    beforeEach(() => {
      pointerCapture = stubPointerCapture()
    })

    afterEach(() => {
      pointerCapture.restore()
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

      act(() => { root!.unmount() })
    })
  })

  describe('Chart point selection', () => {
    let pointerCapture: PointerCaptureStub
    beforeEach(() => {
      pointerCapture = stubPointerCapture()
    })
    afterEach(() => { pointerCapture.restore(); document.body.innerHTML = '' })

    variant.it(['interaction'], 'reports the clicked datum and clears interval selection on a click', async () => {
      const onPointSelect = vi.fn()
      const onSelect = vi.fn()
      const spec = {
        $schema: 'https://vega.github.io/schema/vega/v6.json',
        width: 100, height: 100, padding: 0, autosize: 'none',
        data: [{ name: 't', values: [{ cat: 'a', v: 5 }, { cat: 'b', v: 7 }] }],
        scales: [
          { name: 'x', type: 'band', domain: { data: 't', field: 'cat' } as never, range: [0, 100] as never },
          { name: 'y', type: 'linear', domain: [0, 10] as never, range: [100, 0] as never },
        ],
        marks: [{
          type: 'rect', from: { data: 't' },
          encode: { enter: {
            x: { scale: 'x', field: 'cat' }, width: { scale: 'x', band: 1 },
            y: { scale: 'y', field: 'v' }, y2: { scale: 'y', value: 0 }, fill: { value: '#4c78a8' },
          } },
        }],
      }
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      await act(async () => {
        root.render(<Chart spec={spec} width={100} height={100} onPointSelect={onPointSelect} onSelect={onSelect} />)
      })
      const overlay = container.querySelector('[data-testid="chart-brush-overlay"]')!
      const rect = { left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
      overlay.getBoundingClientRect = () => rect
      ;(container as HTMLElement).getBoundingClientRect = () => rect
      await act(async () => {
        overlay.dispatchEvent(new PointerEvent('pointerdown', { clientX: 20, clientY: 80, pointerId: 1, bubbles: true }))
      })
      await act(async () => {
        overlay.dispatchEvent(new PointerEvent('pointerup', { clientX: 20, clientY: 80, pointerId: 1, bubbles: true }))
      })
      expect(onPointSelect).toHaveBeenCalledTimes(1)
      expect(onPointSelect.mock.calls[0]![0]).toMatchObject({ cat: 'a', v: 5 })
      expect(onSelect).toHaveBeenCalledWith(null)
      await act(async () => { root.unmount() })
    })

    // a click selects what vega's event item is (the topmost item that takes the pointer): an item of a mark without `from` is
    // selected with vega's `{}`, a group's box and what lies under another item are not
    variant.it(['interaction'], 'selects the event item: a mark without `from` gives `{}`, a group box gives null', async () => {
      const onPointSelect = vi.fn()
      const box = (x: number, extra: Record<string, unknown>): Record<string, unknown> => ({ x: { value: x }, width: { value: 30 }, y: { value: 0 }, height: { value: 100 }, ...extra })
      const spec = {
        width: 100, height: 100, padding: 0, autosize: 'none',
        data: [{ name: 't', values: [{ id: 'under' }] }],
        marks: [
          { type: 'rect', from: { data: 't' }, encode: { update: box(0, { width: { value: 60 }, fill: { value: 'red' } }) } },
          { type: 'rect', encode: { update: box(30, { fill: { value: 'transparent' } }) } },
          { type: 'group', encode: { update: box(70, { fill: { value: '#eee' } }) } },
        ],
      }
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      await act(async () => { root.render(<Chart spec={spec} width={100} height={100} onPointSelect={onPointSelect} />) })
      const overlay = container.querySelector('[data-testid="chart-brush-overlay"]')!
      const rect = { left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
      overlay.getBoundingClientRect = () => rect
      ;(container as HTMLElement).getBoundingClientRect = () => rect
      const click = async (x: number): Promise<unknown> => {
        await act(async () => { overlay.dispatchEvent(new PointerEvent('pointerdown', { clientX: x, clientY: 50, pointerId: 1, bubbles: true })) })
        await act(async () => { overlay.dispatchEvent(new PointerEvent('pointerup', { clientX: x, clientY: 50, pointerId: 1, bubbles: true })) })
        return onPointSelect.mock.calls.at(-1)![0]
      }
      expect(await click(10)).toEqual({ id: 'under' })
      // the transparent rect without `from` is drawn over the red one
      expect(await click(45)).toEqual({})
      expect(await click(85)).toBeNull()
      await act(async () => { root.unmount() })
    })
  })
})
