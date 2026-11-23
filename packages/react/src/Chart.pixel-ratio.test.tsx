// @vitest-environment jsdom
/**
 * The canvas follows a change of `devicePixelRatio` (a browser zoom, a window moved to another screen) when it happens, not
 * at the next scene change (C505): the chart listens to the `(resolution: Ndppx)` media query, as vega-view's
 * watchPixelRatio does, and re-sizes the backing store.
 */
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { forEachVariant } from './testing/variants'

const spec = {
  width: 200, height: 100, padding: 0, autosize: 'none',
  marks: [{ type: 'rect', encode: { enter: { x: { value: 10 }, y: { value: 10 }, width: { value: 50 }, height: { value: 30 }, fill: { value: 'teal' } } } }],
}

/** `window.matchMedia` whose resolution queries can be told that they changed, and `devicePixelRatio` to set. */
function fakeScreen(): { set(ratio: number): void; listeners(): number; restore(): void } {
  const queries = new Set<{ media: string; fns: Set<() => void> }>()
  const prevMatch = window.matchMedia
  const prevRatio = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio')
  let ratio = 1
  Object.defineProperty(window, 'devicePixelRatio', { get: () => ratio, configurable: true })
  window.matchMedia = ((media: string) => {
    const q = { media, fns: new Set<() => void>() }
    queries.add(q)
    return {
      media, get matches() { return media === `(resolution: ${ratio}dppx)` },
      addEventListener: (_t: string, fn: () => void) => q.fns.add(fn),
      removeEventListener: (_t: string, fn: () => void) => q.fns.delete(fn),
    } as unknown as MediaQueryList
  }) as typeof window.matchMedia
  return {
    set(next) {
      const was = ratio
      ratio = next
      // the query that matched before no longer does: it changes
      for (const q of [...queries]) if (q.media === `(resolution: ${was}dppx)`) for (const fn of [...q.fns]) fn()
    },
    listeners: () => [...queries].reduce((n, q) => n + q.fns.size, 0),
    restore() {
      window.matchMedia = prevMatch
      if (prevRatio) Object.defineProperty(window, 'devicePixelRatio', prevRatio)
      else delete (window as { devicePixelRatio?: number }).devicePixelRatio
    },
  }
}

let restore: (() => void) | null = null
afterEach(() => { restore?.(); restore = null; document.body.innerHTML = '' })

forEachVariant(['canvas'], (Chart) => {
  describe('devicePixelRatio', () => {
    it('a change re-sizes the canvas at once, and unmounting stops listening', () => {
      ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
      const screen = fakeScreen()
      restore = () => screen.restore()
      const el = document.createElement('div')
      document.body.appendChild(el)
      const root = createRoot(el)
      act(() => { root.render(<Chart spec={spec as never} renderer="canvas" a11y={false} />) })
      const canvas = el.querySelector('canvas')!
      expect([canvas.width, canvas.height, canvas.style.width]).toEqual([200, 100, ''])
      act(() => screen.set(2))
      expect([canvas.width, canvas.height, canvas.style.width]).toEqual([400, 200, '200px'])
      act(() => screen.set(1.5))
      expect([canvas.width, canvas.height, canvas.style.width]).toEqual([300, 150, '200px'])
      act(() => root.unmount())
      expect(screen.listeners()).toBe(0)
    })
  })
})
