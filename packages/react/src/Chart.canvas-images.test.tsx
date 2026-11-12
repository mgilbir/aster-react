// @vitest-environment jsdom
/**
 * `<Chart renderer="canvas">` draws image marks that have a `url`, as vega's canvas renderer does: the canvas renderer draws a
 * bitmap and never fetches, so the chart loads each url (with CORS, as vega does) and repaints when it arrives. Loaded bitmaps are
 * kept from one scene to the next, a url that fails is reported once and not asked for again, and urls that leave the scene are
 * forgotten. jsdom has no 2D context and loads no image, so both are stubbed: the context records `drawImage`, the `Image` settles
 * as the test says. That real pixels match is the browser gate's (scripts/browser-interaction.mts).
 */
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { VgSpec } from '@aster-charts/core'
import { forEachVariant } from './testing/variants'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let draws: string[] = []
const requested: string[] = []
const outcome = new Map<string, 'ok' | 'error'>()

beforeEach(() => {
  draws = []
  requested.length = 0
  outcome.clear()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function () {
    return new Proxy({}, {
      get(t: Record<string | symbol, unknown>, key) {
        if (key in t) return t[key]
        if (key === 'measureText') return (text: string) => ({ width: String(text).length * 6 })
        if (key === 'drawImage') return (src: { src?: string }) => { draws.push(src.src ?? '?') }
        return () => ({ addColorStop: () => undefined })
      },
      set(t: Record<string | symbol, unknown>, key, v) { t[key] = v; return true },
    }) as never
  })
  class ImageStub {
    crossOrigin: string | null = null
    decoding = ''
    naturalWidth = 0
    naturalHeight = 0
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    src = ''
    constructor() {
      let src = ''
      Object.defineProperty(this, 'src', {
        get: () => src,
        set: (v: string) => {
          src = v
          if (v === '') return
          requested.push(`${v} ${this.crossOrigin}`)
          setTimeout(() => {
            if ((outcome.get(v) ?? 'ok') === 'ok') { this.naturalWidth = 8; this.naturalHeight = 8; this.onload?.() } else this.onerror?.()
          }, 1)
        },
      })
    }
  }
  vi.stubGlobal('Image', ImageStub)
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.innerHTML = '' })

const images = (urls: string[]): VgSpec => ({
  width: 120, height: 40, padding: 0, autosize: 'none',
  data: [{ name: 't', values: urls.map((u, i) => ({ u, x: i * 30 })) }],
  marks: [{ type: 'image', from: { data: 't' }, encode: { update: { url: { field: 'u' }, x: { field: 'x' }, y: { value: 0 }, width: { value: 20 }, height: { value: 20 } } } }],
} as unknown as VgSpec)

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
}

forEachVariant(['canvas'], (Chart) => {
  describe('renderer="canvas" draws image marks from their url', () => {
    it('loads each url once, with CORS, and repaints with the images when they arrive', async () => {
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      await act(async () => { root.render(<Chart spec={images(['https://img.example/a.png', 'https://img.example/b.png', 'https://img.example/a.png'])} renderer="canvas" a11y={false} />) })
      await settle()
      expect(requested.sort()).toEqual(['https://img.example/a.png anonymous', 'https://img.example/b.png anonymous'])
      // the last paint drew all three items
      expect(draws.slice(-3).sort()).toEqual(['https://img.example/a.png', 'https://img.example/a.png', 'https://img.example/b.png'])
      act(() => root.unmount())
    })

    it('keeps the images it has when the data changes, loads only new urls, and forgets urls the scene no longer has', async () => {
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      await act(async () => { root.render(<Chart spec={images(['https://img.example/a.png'])} renderer="canvas" a11y={false} />) })
      await settle()
      expect(requested).toEqual(['https://img.example/a.png anonymous'])
      // new data with the same url and a new one: a.png is drawn in the very next paint, only b.png is requested
      draws = []
      await act(async () => { root.render(<Chart spec={images(['https://img.example/a.png', 'https://img.example/b.png'])} renderer="canvas" a11y={false} />) })
      await act(async () => { await new Promise((r) => requestAnimationFrame(() => r(null))) })
      expect(draws[0]).toBe('https://img.example/a.png')
      await settle()
      expect(requested).toEqual(['https://img.example/a.png anonymous', 'https://img.example/b.png anonymous'])
      // a.png leaves the scene and comes back: it is loaded again (it was forgotten), so the cache never outgrows a scene
      await act(async () => { root.render(<Chart spec={images(['https://img.example/b.png'])} renderer="canvas" a11y={false} />) })
      await settle()
      await act(async () => { root.render(<Chart spec={images(['https://img.example/a.png', 'https://img.example/b.png'])} renderer="canvas" a11y={false} />) })
      await settle()
      expect(requested.filter((r) => r.startsWith('https://img.example/a.png')).length).toBe(2)
      act(() => root.unmount())
    })

    it('draws url images appended to a chart that had none (no append-only paint that would leave them blank)', async () => {
      const spec = {
        width: 120, height: 40, padding: 0, autosize: 'none',
        data: [{ name: 't' }],
        marks: [
          { type: 'symbol', encode: { update: { x: { value: 100 }, y: { value: 20 }, size: { value: 50 } } } },
          { type: 'image', from: { data: 't' }, encode: { update: { url: { field: 'u' }, x: { field: 'x' }, y: { value: 0 }, width: { value: 20 }, height: { value: 20 } } } },
        ],
      } as unknown as VgSpec
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      const first = [{ u: 'https://img.example/a.png', x: 0 }]
      await act(async () => { root.render(<Chart spec={spec} data={{ t: [] }} renderer="canvas" a11y={false} />) })
      await settle()
      await act(async () => { root.render(<Chart spec={spec} data={{ t: first }} renderer="canvas" a11y={false} />) })
      await settle()
      expect(requested).toEqual(['https://img.example/a.png anonymous'])
      expect(draws).toContain('https://img.example/a.png')
      // and rows appended after it keep it, and draw theirs
      await act(async () => { root.render(<Chart spec={spec} data={{ t: [...first, { u: 'https://img.example/b.png', x: 30 }] }} renderer="canvas" a11y={false} />) })
      await settle()
      expect(draws.slice(-2).sort()).toEqual(['https://img.example/a.png', 'https://img.example/b.png'])
      act(() => root.unmount())
    })

    it('reports a url that fails to the logger once, draws the rest, and does not ask for it again', async () => {
      outcome.set('https://img.example/broken.png', 'error')
      const warned: string[] = []
      const logger = { error: () => undefined, warn: (...a: unknown[]) => { warned.push(String(a[0])) } }
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      const spec = images(['https://img.example/a.png', 'https://img.example/broken.png'])
      await act(async () => { root.render(<Chart spec={spec} renderer="canvas" a11y={false} logger={logger} />) })
      await settle()
      // a re-render with new data that still names the broken url
      await act(async () => { root.render(<Chart spec={images(['https://img.example/a.png', 'https://img.example/broken.png', 'https://img.example/a.png'])} renderer="canvas" a11y={false} logger={logger} />) })
      await settle()
      expect(warned.length).toBe(1)
      expect(warned[0]).toMatch(/^\[aster\] canvas: image https:\/\/img\.example\/broken\.png not drawn: it did not load/)
      expect(requested.filter((r) => r.includes('broken')).length).toBe(1)
      expect(draws).toContain('https://img.example/a.png')
      expect(draws).not.toContain('https://img.example/broken.png')
      act(() => root.unmount())
    })
  })
})
