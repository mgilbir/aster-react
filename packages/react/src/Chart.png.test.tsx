// @vitest-environment jsdom
/**
 * `getPng` on the chart's ref (#144): it paints `getScene()` with the canvas renderer, loaded on demand, and encodes it with the
 * canvas's own `toBlob`. jsdom has no 2D context, so `HTMLCanvasElement.prototype.getContext` / `toBlob` are stubbed with a
 * context that logs every call: the log of a `getPng` is compared with the log of `renderSceneToCanvas` painting the same scene,
 * so what is checked here is the plumbing (which scene, which scale, which reporter, which capability). The pixels a real browser
 * encodes are checked in Chromium (scripts/browser-interaction.mts).
 */
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import type { VgSpec } from '@aster-charts/core'
import { renderSceneToCanvas, type CanvasLike } from '@aster-charts/core/canvas'
import { forEachVariant } from './testing/variants'
import type { ChartHandle } from './chart-types'
import { SvgChart } from './SvgChart'
import { png } from './png-capability'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** A 2D context that logs every method call and property write, in order. */
function loggingContext(log: unknown[]): CanvasLike {
  const target: Record<string | symbol, unknown> = {}
  return new Proxy(target, {
    get(t, key) {
      if (key in t) return t[key]
      if (key === 'measureText') return (text: string) => ({ width: String(text).length * 6 })
      return (...args: unknown[]) => {
        log.push([String(key), ...args.map((a) => (typeof a === 'object' && a !== null ? '[object]' : a))])
        return { addColorStop: () => undefined }
      }
    },
    set(t, key, value) {
      log.push(['=', String(key), typeof value === 'object' && value !== null ? '[object]' : value])
      t[key] = value
      return true
    },
  }) as unknown as CanvasLike
}

let painted: unknown[][] = []
let sizes: Array<[number, number]> = []
beforeEach(() => {
  painted = []
  sizes = []
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    const log: unknown[] = []
    painted.push(log)
    sizes.push([this.width, this.height])
    return loggingContext(log) as never
  })
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (this: HTMLCanvasElement, cb: BlobCallback, type?: string) {
    cb(new Blob([`${this.width}x${this.height}`], { type: type ?? 'image/png' }))
  })
})
afterEach(() => { vi.restoreAllMocks(); document.body.innerHTML = '' })

const BARS = {
  width: 120, height: 70, padding: 5, background: 'white',
  data: [{ name: 't', values: [{ k: 'a', v: 3 }, { k: 'b', v: 7 }] }],
  scales: [
    { name: 'x', type: 'band', domain: { data: 't', field: 'k' }, range: 'width', padding: 0.2 },
    { name: 'y', type: 'linear', domain: [0, 8], range: 'height' },
  ],
  axes: [{ scale: 'y', orient: 'left' }],
  marks: [{ type: 'rect', from: { data: 't' }, encode: { update: {
    x: { scale: 'x', field: 'k' }, width: { scale: 'x', band: 1 }, y: { scale: 'y', field: 'v' }, y2: { scale: 'y', value: 0 }, fill: { value: 'steelblue' },
  } } }],
} as unknown as VgSpec
const IMAGE = {
  width: 40, height: 40,
  marks: [{ type: 'image', encode: { update: { url: { value: 'https://img.example/x.png' }, x: { value: 0 }, y: { value: 0 }, width: { value: 10 }, height: { value: 10 } } } }],
} as unknown as VgSpec

/** What `renderSceneToCanvas` logs for `scene` at `dpr`, on the same logging context. */
function directLog(scene: Parameters<typeof renderSceneToCanvas>[0], dpr: number): unknown[] {
  const log: unknown[] = []
  renderSceneToCanvas(scene, loggingContext(log), { dpr })
  return log
}

function mountWith(element: (ref: React.RefObject<ChartHandle | null>) => React.ReactElement): { ref: React.RefObject<ChartHandle | null>; container: HTMLElement } {
  const ref = React.createRef<ChartHandle>()
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => { root.render(element(ref)) })
  return { ref, container }
}

/** `getPng` of a mounted chart, with its painting checked against a direct paint of the same scene. */
async function expectPng(ref: React.RefObject<ChartHandle | null>, scale: number | undefined): Promise<void> {
  const scene = ref.current!.getScene()!
  const blob = await ref.current!.getPng(scale === undefined ? undefined : { scale })
  const s = scale ?? 1
  const [w, h] = [Math.ceil(scene.width * s), Math.ceil(scene.height * s)]
  expect(blob).toBeInstanceOf(Blob)
  expect(blob!.type).toBe('image/png')
  expect(await blob!.text()).toBe(`${w}x${h}`)
  expect(sizes.at(-1)).toEqual([w, h])
  expect(painted.at(-1)).toEqual(directLog(scene, s))
  expect(painted.at(-1)!.length).toBeGreaterThan(10)
}

forEachVariant(['png'], (Chart, variant) => {
  describe('getPng', () => {
    it('paints getScene() with the canvas renderer at the scale and encodes it as a PNG', async () => {
      const { ref } = mountWith((r) => <Chart ref={r} spec={BARS} width={120} height={70} a11y={false} />)
      await expectPng(ref, undefined)
      await expectPng(ref, 2)
      await expectPng(ref, 1.5)
    })

    it('resolves null without a scene (the error state), and rejects a bad scale', async () => {
      const bad = { ...BARS, marks: [{ type: 'rect', from: { data: 'nope' } }] } as unknown as VgSpec
      const { ref, container } = mountWith((r) => <Chart ref={r} spec={bad} onError={() => undefined} />)
      expect(container.querySelector('[role="alert"]')).not.toBeNull()
      await expect(ref.current!.getPng()).resolves.toBeNull()
      const ok = mountWith((r) => <Chart ref={r} spec={BARS} width={120} height={70} a11y={false} />)
      await expect(ok.ref.current!.getPng({ scale: 0 })).rejects.toBeInstanceOf(RangeError)
    })

    it(`an image that does not load is left out and reported through the chart's logger (${variant.name})`, async () => {
      // jsdom does not load images: an Image whose load fails stands in for a server without CORS
      class FailingImage {
        crossOrigin: string | null = null
        onload: (() => void) | null = null
        onerror: (() => void) | null = null
        set src(_v: string) { setTimeout(() => this.onerror?.(), 0) }
      }
      vi.stubGlobal('Image', FailingImage)
      try {
        const warned: unknown[][] = []
        const logger = { error: () => undefined, warn: (...a: unknown[]) => { warned.push(a) } }
        const { ref } = mountWith((r) => <Chart ref={r} spec={IMAGE} width={40} height={40} a11y={false} logger={logger} />)
        expect(await ref.current!.getPng()).toBeInstanceOf(Blob)
        expect(warned.length).toBe(1)
        expect(String(warned[0]![0])).toMatch(/^\[aster\] getPng: .*did not load/)
        expect(warned[0]![1]).toBe('https://img.example/x.png')
        // an onImageError of the call replaces the logger
        const seen: string[] = []
        await ref.current!.getPng({ onImageError: (url) => seen.push(url) })
        expect(seen).toEqual(['https://img.example/x.png'])
        expect(warned.length).toBe(1)
      } finally {
        vi.unstubAllGlobals()
      }
    })
  })
})

describe('<SvgChart png={png}>', () => {
  it('has the same getPng as <Chart>', async () => {
    const { ref } = mountWith((r) => <SvgChart ref={r} spec={BARS} width={120} height={70} a11y={false} png={png} />)
    await expectPng(ref, 2)
  })
})
