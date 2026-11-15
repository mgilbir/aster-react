// @vitest-environment jsdom
/**
 * <Chart renderer="canvas"> paints nothing for a scene that paints the pixels already on the canvas: on the chart-bench survival chart
 * a pointer move changes only the tooltip of a transparent rect, and every move cleared and repainted the whole canvas.
 *
 * The canvas is a recording stand-in (jsdom draws nothing): a full repaint begins with a clear of the whole canvas.
 */
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { forEachVariant } from './testing/variants'

let clears = 0
beforeEach(() => {
  clears = 0
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function () {
    return new Proxy({}, {
      get(t: Record<string | symbol, unknown>, key) {
        if (key in t) return t[key]
        if (key === 'measureText') return (text: string) => ({ width: String(text).length * 6 })
        if (key === 'clearRect') return () => { clears++ }
        return () => ({ addColorStop: () => undefined })
      },
      set(t: Record<string | symbol, unknown>, key, v) { t[key] = v; return true },
    }) as never
  })
})
afterEach(() => { vi.restoreAllMocks() })

const frame = (): Promise<void> => new Promise((r) => setTimeout(r, 40))

forEachVariant(['canvas'], (Chart) => {
  const spec = {
    width: 300, height: 200, padding: 10, autosize: 'none',
    signals: [{ name: 'hoverX', value: null }, { name: 'hi', value: 'a' }],
    data: [{ name: 't', values: Array.from({ length: 30 }, (_, i) => ({ k: 'abc'[i % 3], x: i, y: (i * 7) % 11 })) }],
    scales: [{ name: 'x', type: 'linear', domain: [0, 30], range: 'width' }, { name: 'y', type: 'linear', domain: [0, 11], range: 'height' }],
    marks: [
      { type: 'symbol', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'y' }, fill: { signal: "datum.k == hi ? 'red' : 'grey'" } } } },
      { type: 'rect', encode: { update: { x: { value: 0 }, x2: { signal: 'width' }, y: { value: 0 }, y2: { signal: 'height' }, fill: { value: 'transparent' }, tooltip: { signal: "'Day ' + hoverX" } } } },
    ],
  }

  describe('a canvas scene that paints the same pixels', () => {
    it('is not painted; a scene that paints others is', async () => {
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      act(() => { root.render(<Chart spec={spec} renderer="canvas" width={320} height={220} signals={{ hoverX: 0 }} />) })
      await act(frame)
      const painted = clears
      expect(painted).toBeGreaterThan(0)
      for (let i = 1; i <= 5; i++) {
        act(() => { root.render(<Chart spec={spec} renderer="canvas" width={320} height={220} signals={{ hoverX: i }} />) })
        await act(frame)
      }
      expect(clears).toBe(painted)
      act(() => { root.render(<Chart spec={spec} renderer="canvas" width={320} height={220} signals={{ hoverX: 5, hi: 'b' }} />) })
      await act(frame)
      expect(clears).toBeGreaterThan(painted)
      act(() => { root.unmount() })
      container.remove()
    })
  })
})
