/**
 * A batched run of closed symbols on a browser's 2D context is assembled from one `Path2D` per symbol (Blink measures
 * the whole path on every `closePath`, so closing 100k symbols in one growing path took 17 s). The route must draw
 * exactly the geometry the plain route draws, and only a real browser context may take it. The pixels and the time are
 * checked in Chromium by `pnpm conformance:canvas` (browser-canvas-symbols.mts); this file pins the calls.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderSceneToCanvas, type CanvasLike } from './canvas.js'
import type { SceneRoot } from './types.js'

type Call = [string, ...unknown[]]
const GEOMETRY = ['moveTo', 'lineTo', 'bezierCurveTo', 'quadraticCurveTo', 'arc', 'closePath']

class FakePath2D {
  static made: FakePath2D[] = []
  calls: Call[] = []
  added: FakePath2D[] = []
  constructor() {
    FakePath2D.made.push(this)
    for (const m of GEOMETRY) (this as unknown as Record<string, unknown>)[m] = (...a: unknown[]) => { this.calls.push([m, ...a]) }
  }
  addPath(p: FakePath2D): void { this.added.push(p) }
}

class FakeBrowserContext {}

function context(Base: new () => object): { ctx: CanvasLike; log: Call[] } {
  const log: Call[] = []
  const ctx = new Base() as Record<string, unknown>
  for (const m of [...GEOMETRY, 'beginPath', 'fill', 'stroke', 'save', 'restore', 'translate', 'rotate', 'scale', 'setLineDash', 'clip', 'fillRect']) {
    ctx[m] = (...a: unknown[]) => { log.push([m, ...a]) }
  }
  return { ctx: ctx as unknown as CanvasLike, log }
}

const scene = (shape: string, n: number, extra: Record<string, unknown> = {}): SceneRoot => ({
  width: 200, height: 120, padding: { top: 0, right: 0, bottom: 0, left: 0 },
  items: [{ marktype: 'symbol', items: Array.from({ length: n }, (_, i) => ({ x: 5 + (i % 40) * 4.5, y: 7 + Math.floor(i / 40) * 3.25, size: 30, shape, fill: '#4c78a8', ...extra })) }],
}) as unknown as SceneRoot

/** The path calls a render made beyond what an empty scene of the same frame makes (the frame's own clip path comes first). */
function geometryBeyondFrame(log: Call[], empty: Call[]): Call[] {
  const all = log.filter((c) => GEOMETRY.includes(c[0] as string))
  const frame = empty.filter((c) => GEOMETRY.includes(c[0] as string))
  expect(all.slice(0, frame.length)).toEqual(frame)
  return all.slice(frame.length)
}

beforeEach(() => {
  FakePath2D.made = []
  vi.stubGlobal('Path2D', FakePath2D)
  vi.stubGlobal('CanvasRenderingContext2D', FakeBrowserContext)
})
afterEach(() => { vi.unstubAllGlobals() })

describe('a batched run of closed symbols', () => {
  for (const shape of ['square', 'cross', 'diamond', 'triangle-up', 'arrow', 'wedge', 'M-1,-1L1,-1L1,1L-1,1Z']) {
    it(`${shape}: a browser context gets one Path2D per symbol, added to the run's path, and the same geometry as the plain route`, () => {
      const empty = context(Object)
      renderSceneToCanvas(scene(shape, 0), empty.ctx)
      const plain = context(Object)
      renderSceneToCanvas(scene(shape, 300), plain.ctx)
      const browser = context(FakeBrowserContext)
      renderSceneToCanvas(scene(shape, 300), browser.ctx)

      // the plain route closes each symbol on the context's own path
      const plainGeometry = geometryBeyondFrame(plain.log, empty.log)
      expect(plainGeometry.filter((c) => c[0] === 'closePath')).toHaveLength(300)
      // the browser route never closes on the context: one fill of the run's path
      expect(geometryBeyondFrame(browser.log, empty.log)).toEqual([])
      const fills = browser.log.filter((c) => c[0] === 'fill')
      expect(fills).toHaveLength(1)
      const whole = fills[0]![1] as FakePath2D
      expect(whole).toBeInstanceOf(FakePath2D)
      expect(whole.added).toHaveLength(300)
      // the same calls, in the same order, with the same numbers
      expect(whole.added.flatMap((p) => p.calls)).toEqual(plainGeometry)
    })
  }

  it('a stroked run is stroked from the same Path2D', () => {
    const browser = context(FakeBrowserContext)
    renderSceneToCanvas(scene('square', 300, { fill: null, stroke: '#e45756', strokeWidth: 2 }), browser.ctx)
    const strokes = browser.log.filter((c) => c[0] === 'stroke')
    expect(strokes).toHaveLength(1)
    expect((strokes[0]![1] as FakePath2D).added).toHaveLength(300)
  })

  it('circles and open shapes never close, so they stay on the context\'s own path', () => {
    for (const shape of ['circle', 'stroke']) {
      const browser = context(FakeBrowserContext)
      renderSceneToCanvas(scene(shape, 300), browser.ctx)
      expect(FakePath2D.made).toHaveLength(0)
      expect(browser.log.filter((c) => c[0] === 'fill' || c[0] === 'stroke').every((c) => c.length === 1)).toBe(true)
    }
  })

  it('a context that is not a browser\'s, or a page without Path2D, gets the plain route', () => {
    const other = context(Object)
    renderSceneToCanvas(scene('square', 300), other.ctx)
    expect(FakePath2D.made).toHaveLength(0)
    vi.stubGlobal('Path2D', undefined)
    const empty = context(Object)
    renderSceneToCanvas(scene('square', 0), empty.ctx)
    const noPath2D = context(FakeBrowserContext)
    renderSceneToCanvas(scene('square', 300), noPath2D.ctx)
    expect(geometryBeyondFrame(noPath2D.log, empty.log).filter((c) => c[0] === 'closePath')).toHaveLength(300)
  })

  it('fewer than 256 symbols are drawn one by one, as before', () => {
    const empty = context(Object)
    renderSceneToCanvas(scene('square', 0), empty.ctx)
    const browser = context(FakeBrowserContext)
    renderSceneToCanvas(scene('square', 20), browser.ctx)
    expect(FakePath2D.made).toHaveLength(0)
    expect(geometryBeyondFrame(browser.log, empty.log).filter((c) => c[0] === 'closePath')).toHaveLength(20)
  })
})
