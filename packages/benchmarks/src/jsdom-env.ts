/**
 * Install a jsdom-backed DOM as process globals so React and Vega run
 * headless. Must be called BEFORE importing react-dom/client or vega.
 */
import { JSDOM } from 'jsdom'

export function setupJsdom(): JSDOM {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/',
  })
  const win = dom.window as unknown as Window & typeof globalThis
  const g = globalThis as Record<string, unknown>
  const define = (key: string, value: unknown): void => {
    Object.defineProperty(g, key, { value, writable: true, configurable: true })
  }

  define('window', win)
  // Copy every window property Node doesn't already provide (ShadowRoot,
  // MutationObserver, Element, getComputedStyle, requestAnimationFrame, ...).
  for (const key of Object.getOwnPropertyNames(win)) {
    if (key in g) continue
    let value: unknown
    try {
      value = (win as unknown as Record<string, unknown>)[key]
    } catch {
      continue
    }
    define(key, value)
  }
  return dom
}
