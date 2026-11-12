// @vitest-environment node
/**
 * `renderSceneToPng` (`@aster-charts/core/png`, #144), with the platform pieces stubbed: an `OffscreenCanvas` whose context
 * records every paint (canvas-record.testlib) and an `Image` the test settles. What is checked here is the module's own logic:
 * the size and the scale, what is painted (exactly what `renderSceneToCanvas` paints for the same scene), the image marks loaded
 * (once per url, with CORS, in the copy of the scene and never in the chart's), the failures it reports, and the errors it
 * throws. That a real browser encodes the same pixels is the browser gate's (packages/react/scripts/browser-interaction.mts).
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { compileChart } from './compiler.js'
import { evaluateChart } from './evaluate.js'
import { renderSceneToCanvas, type CanvasLike } from './canvas.js'
import { makeRecorder, type PaintRecord } from './canvas-record.testlib.js'
import { renderSceneToPng, PNG_IMAGE_CONCURRENCY, PNG_MAX_IMAGE_TIMEOUT_MS, PNG_MAX_PIXELS, PNG_MAX_SIDE } from './png.js'
import type { SceneRoot, VgSpec } from './types.js'

type Draw = { source: unknown; box: number[] }

/** A recording 2D context that also records `drawImage` (the recorder itself draws no bitmaps). */
function recordingContext(): { ctx: CanvasLike; records: PaintRecord[]; draws: Draw[]; scales: number[][] } {
  const { ctx, records } = makeRecorder()
  const draws: Draw[] = []
  const scales: number[][] = []
  const scale = ctx.scale.bind(ctx)
  ctx.scale = (x: number, y: number) => { scales.push([x, y]); scale(x, y) }
  ctx.drawImage = (source: unknown, ...box: number[]) => { draws.push({ source, box }) }
  return { ctx, records, draws, scales }
}

interface FakeCanvas { width: number; height: number; ctx: ReturnType<typeof recordingContext> }
let canvases: FakeCanvas[] = []
let encode: (c: FakeCanvas) => Promise<Blob> = async (c) => new Blob([`png ${c.width}x${c.height}`], { type: 'image/png' })

function installCanvas(): void {
  canvases = []
  class OffscreenCanvasStub {
    width: number
    height: number
    readonly rec = recordingContext()
    constructor(w: number, h: number) { this.width = w; this.height = h; canvases.push(this as unknown as FakeCanvas) }
    get ctx() { return this.rec }
    getContext(type: string) { return type === '2d' ? this.rec.ctx : null }
    convertToBlob() { return encode(this as unknown as FakeCanvas) }
  }
  vi.stubGlobal('OffscreenCanvas', OffscreenCanvasStub)
}

/** An `Image` whose loads the test decides: by url, `ok` (with a size), `error`, or `never`. */
const imageOutcome = new Map<string, 'ok' | 'error' | 'never'>()
const created: Array<{ src: string; crossOrigin: string | null; canvases: number }> = []
/** Loads in flight now, the most there were at once, and the loads abandoned (`src` emptied). */
const flight = { now: 0, max: 0, aborted: 0 }
function installImage(delay = 1): void {
  created.length = 0
  flight.now = 0
  flight.max = 0
  flight.aborted = 0
  class ImageStub {
    crossOrigin: string | null = null
    decoding = 'auto'
    naturalWidth = 0
    naturalHeight = 0
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    private _src = ''
    get src() { return this._src }
    set src(v: string) {
      if (v === '') { flight.aborted++; this._src = v; return }
      this._src = v
      created.push({ src: v, crossOrigin: this.crossOrigin, canvases: canvases.length })
      const outcome = imageOutcome.get(v) ?? 'ok'
      if (outcome === 'never') return
      flight.max = Math.max(flight.max, ++flight.now)
      setTimeout(() => {
        flight.now--
        if (outcome === 'ok') { this.naturalWidth = 20; this.naturalHeight = 10; this.onload?.() }
        else this.onerror?.()
      }, delay)
    }
  }
  vi.stubGlobal('Image', ImageStub)
}

afterEach(() => {
  vi.unstubAllGlobals()
  imageOutcome.clear()
  encode = async (c) => new Blob([`png ${c.width}x${c.height}`], { type: 'image/png' })
})

const sceneOf = (spec: Record<string, unknown>): SceneRoot => evaluateChart(compileChart(spec as VgSpec), {})

/** Bars, text, an axis, a gradient fill (the scene's `defs`) and a background. */
const BARS = sceneOf({
  width: 120, height: 80, padding: 5, background: '#fafafa',
  data: [{ name: 't', values: [{ k: 'a', v: 3 }, { k: 'b', v: 7 }] }],
  scales: [
    { name: 'x', type: 'band', domain: { data: 't', field: 'k' }, range: 'width', padding: 0.2 },
    { name: 'y', type: 'linear', domain: [0, 8], range: 'height' },
  ],
  axes: [{ scale: 'y', orient: 'left' }],
  marks: [
    { type: 'rect', from: { data: 't' }, encode: { update: {
      x: { scale: 'x', field: 'k' }, width: { scale: 'x', band: 1 }, y: { scale: 'y', field: 'v' }, y2: { scale: 'y', value: 0 },
      fill: { value: { gradient: 'linear', stops: [{ offset: 0, color: 'red' }, { offset: 1, color: 'blue' }] } },
    } } },
    { type: 'text', encode: { update: { x: { value: 10 }, y: { value: 10 }, text: { value: 'hello' } } } },
  ],
})

/** Image marks: two items share a url, one fails, one never loads; nested in a group too. */
const IMAGES = sceneOf({
  width: 100, height: 60,
  data: [{ name: 'i', values: [{ u: 'https://img.example/a.png', x: 0 }, { u: 'https://img.example/a.png', x: 30 }, { u: 'https://img.example/broken.png', x: 60 }] }],
  marks: [
    { type: 'image', from: { data: 'i' }, encode: { update: { url: { field: 'u' }, x: { field: 'x' }, y: { value: 0 }, width: { value: 20 }, height: { value: 10 } } } },
    { type: 'group', encode: { update: { x: { value: 0 }, y: { value: 30 }, width: { value: 100 }, height: { value: 30 } } }, marks: [
      { type: 'image', encode: { update: { url: { value: 'https://img.example/nested.png' }, x: { value: 5 }, y: { value: 5 }, width: { value: 20 }, height: { value: 10 } } } },
    ] },
  ],
})

/** What `renderSceneToCanvas` paints for `scene` at `dpr`, straight onto a recorder. */
function direct(scene: SceneRoot, dpr: number): PaintRecord[] {
  const rec = recordingContext()
  renderSceneToCanvas(scene, rec.ctx, { dpr })
  return rec.records
}

describe('renderSceneToPng', () => {
  it('paints exactly what renderSceneToCanvas paints, at the scale, on a ceil(size x scale) canvas', async () => {
    installCanvas()
    // (1.01 makes a fraction under one half: the canvas is rounded up, so nothing at the edge is cut off)
    expect(BARS.width * 1.01 % 1).toBeGreaterThan(0)
    expect(BARS.width * 1.01 % 1).toBeLessThan(0.5)
    for (const scale of [1, 2, 1.5, 0.3, 1.01]) {
      const blob = await renderSceneToPng(BARS, { scale })
      const c = canvases.at(-1)!
      expect([c.width, c.height]).toEqual([Math.ceil(BARS.width * scale), Math.ceil(BARS.height * scale)])
      expect(await blob.text()).toBe(`png ${c.width}x${c.height}`)
      // the same paints, in the same order, in the same state: background, gradient, text and guides included
      expect(c.ctx.records).toEqual(direct(BARS, scale))
      expect(c.ctx.records.length).toBeGreaterThan(5)
      if (scale !== 1) expect(c.ctx.scales[0]).toEqual([scale, scale])
    }
  })

  it('defaults to scale 1', async () => {
    installCanvas()
    await renderSceneToPng(BARS)
    expect([canvases[0]!.width, canvases[0]!.height]).toEqual([Math.ceil(BARS.width), Math.ceil(BARS.height)])
    expect(canvases[0]!.ctx.records).toEqual(direct(BARS, 1))
  })

  it('refuses a bad scale, a scene without area and an oversized image before making a canvas', async () => {
    installCanvas()
    for (const scale of [0, -1, NaN, Infinity, '2' as never]) {
      await expect(renderSceneToPng(BARS, { scale })).rejects.toBeInstanceOf(RangeError)
    }
    await expect(renderSceneToPng({ ...BARS, width: 0 })).rejects.toThrow(/no area/)
    await expect(renderSceneToPng({ ...BARS, width: NaN })).rejects.toThrow(/no finite size/)
    // a side over the cap, and an area over the cap with both sides under it
    await expect(renderSceneToPng({ ...BARS, width: PNG_MAX_SIDE + 1, height: 1 })).rejects.toThrow(/too large/)
    const side = Math.floor(Math.sqrt(PNG_MAX_PIXELS)) + 1
    expect(side).toBeLessThan(PNG_MAX_SIDE)
    await expect(renderSceneToPng({ ...BARS, width: side, height: side })).rejects.toThrow(/too large/)
    // a timer cannot wait past 2^31 - 1 ms: Infinity or more would fire at once and drop every image
    for (const imageTimeoutMs of [-1, NaN, Infinity, PNG_MAX_IMAGE_TIMEOUT_MS + 1]) {
      await expect(renderSceneToPng(BARS, { imageTimeoutMs })).rejects.toBeInstanceOf(RangeError)
    }
    expect(canvases).toEqual([])
    await expect(renderSceneToPng(BARS, { imageTimeoutMs: PNG_MAX_IMAGE_TIMEOUT_MS })).resolves.toBeInstanceOf(Blob)
    canvases = []
    // the cap itself is allowed (nothing is painted beyond the stub here)
    await expect(renderSceneToPng({ ...BARS, width: PNG_MAX_SIDE, height: 1 })).resolves.toBeInstanceOf(Blob)
  })

  it('without any canvas it says so, before requesting any image', async () => {
    await expect(renderSceneToPng(BARS)).rejects.toThrow(/no canvas/)
    installImage()
    await expect(renderSceneToPng(IMAGES)).rejects.toThrow(/no canvas/)
    expect(created).toEqual([])
  })

  it('makes the canvas only once the images are in (its memory is not held while they load)', async () => {
    installCanvas()
    installImage()
    await renderSceneToPng(IMAGES)
    expect(created.length).toBe(3)
    expect(created.every((c) => c.canvases === 0)).toBe(true)
    expect(canvases.length).toBe(1)
  })

  const manyImages = (n: number): SceneRoot => sceneOf({
    width: 400, height: 20,
    data: [{ name: 'i', values: Array.from({ length: n }, (_, i) => ({ u: `https://img.example/${i}.png`, x: i * 20 })) }],
    marks: [{ type: 'image', from: { data: 'i' }, encode: { update: { url: { field: 'u' }, x: { field: 'x' }, y: { value: 0 }, width: { value: 10 }, height: { value: 10 } } } }],
  })

  it(`loads at most ${PNG_IMAGE_CONCURRENCY} images at once`, async () => {
    installCanvas()
    installImage(5)
    const n = PNG_IMAGE_CONCURRENCY * 3 + 1
    const errors: string[] = []
    await renderSceneToPng(manyImages(n), { onImageError: (url) => errors.push(url) })
    expect(created.length).toBe(n)
    expect(flight.max).toBe(PNG_IMAGE_CONCURRENCY)
    expect(errors).toEqual([])
    expect(canvases[0]!.ctx.draws.length).toBe(n)
  })

  it('imageTimeoutMs bounds the wait for all images together: loads in flight are abandoned, queued ones never start', async () => {
    installCanvas()
    installImage()
    const n = PNG_IMAGE_CONCURRENCY * 3 + 1
    for (let i = 0; i < n; i++) imageOutcome.set(`https://img.example/${i}.png`, 'never')
    const errors: string[] = []
    const t0 = Date.now()
    await renderSceneToPng(manyImages(n), { imageTimeoutMs: 40, onImageError: (url, e) => errors.push(`${url}: ${e.message}`) })
    // one deadline, not one per image: n / 6 batches of 40 ms would be 160 ms and more
    expect(Date.now() - t0).toBeLessThan(150)
    expect(created.length).toBe(PNG_IMAGE_CONCURRENCY)
    expect(flight.aborted).toBe(PNG_IMAGE_CONCURRENCY)
    expect(errors.length).toBe(n)
    expect(errors.every((e) => /within 40 ms/.test(e))).toBe(true)
    expect(canvases[0]!.ctx.draws.length).toBe(0)
  })

  it('images that load before the deadline are drawn, the rest are left out', async () => {
    installCanvas()
    // 20 ms each, 6 at a time, a 30 ms deadline: the first six are in, the second six are cut off mid-load
    installImage(20)
    const n = PNG_IMAGE_CONCURRENCY * 3
    const errors: string[] = []
    await renderSceneToPng(manyImages(n), { imageTimeoutMs: 30, onImageError: (url) => errors.push(url) })
    expect(canvases[0]!.ctx.draws.length).toBe(PNG_IMAGE_CONCURRENCY)
    expect(errors.length).toBe(n - PNG_IMAGE_CONCURRENCY)
  })

  it('reports a canvas that cannot be read back (cross-origin without CORS) and one the browser will not encode', async () => {
    installCanvas()
    encode = () => Promise.reject(new DOMException('The canvas has been tainted by cross-origin data.', 'SecurityError'))
    await expect(renderSceneToPng(BARS)).rejects.toThrow(/could not be read back/)
    encode = () => Promise.resolve(null as never)
    await expect(renderSceneToPng(BARS)).rejects.toThrow(/could not encode/)
  })

  it('loads each image mark url once, with CORS, and draws the loaded bitmaps; a failure is reported and left out', async () => {
    installCanvas()
    installImage()
    imageOutcome.set('https://img.example/broken.png', 'error')
    const before = JSON.stringify(IMAGES)
    const errors: Array<[string, string]> = []
    const blob = await renderSceneToPng(IMAGES, { onImageError: (url, e) => errors.push([url, e.message]) })
    expect(blob).toBeInstanceOf(Blob)
    // one request per url, each anonymous CORS (vega's canvas default), set before `src`
    expect(created.map((c) => c.src).sort()).toEqual(['https://img.example/a.png', 'https://img.example/broken.png', 'https://img.example/nested.png'])
    expect(created.every((c) => c.crossOrigin === 'anonymous')).toBe(true)
    // the two items of a.png and the nested one are drawn; broken.png is not
    const draws = canvases[0]!.ctx.draws
    expect(draws.length).toBe(3)
    expect(draws.every((d) => (d.source as { src: string }).src !== 'https://img.example/broken.png')).toBe(true)
    expect(errors.length).toBe(1)
    expect(errors[0]![0]).toBe('https://img.example/broken.png')
    expect(errors[0]![1]).toMatch(/did not load/)
    // the chart's scene is untouched: no bitmap was written into it
    expect(JSON.stringify(IMAGES)).toBe(before)
    const imageItems = (IMAGES.items[0]!.items as Array<{ items?: unknown[] }>)
    expect(JSON.stringify(imageItems)).not.toContain('"image"')
  })

  it('an image that never loads is given up after imageTimeoutMs', async () => {
    installCanvas()
    installImage()
    imageOutcome.set('https://img.example/a.png', 'never')
    imageOutcome.set('https://img.example/broken.png', 'error')
    const errors: string[] = []
    const t0 = Date.now()
    await renderSceneToPng(IMAGES, { imageTimeoutMs: 30, onImageError: (url, e) => errors.push(`${url}: ${e.message}`) })
    expect(Date.now() - t0).toBeLessThan(2000)
    expect(errors.some((e) => e.startsWith('https://img.example/a.png') && /within 30 ms/.test(e))).toBe(true)
    expect(canvases[0]!.ctx.draws.length).toBe(1) // only nested.png
  })

  it('without Image (a worker) image marks are reported and left out; the rest is painted', async () => {
    installCanvas()
    const errors: string[] = []
    await renderSceneToPng(IMAGES, { onImageError: (url) => errors.push(url) })
    expect(errors.sort()).toEqual(['https://img.example/a.png', 'https://img.example/broken.png', 'https://img.example/nested.png'])
    expect(canvases[0]!.ctx.draws.length).toBe(0)
  })

  it('a throwing onImageError does not stop the export', async () => {
    installCanvas()
    installImage()
    imageOutcome.set('https://img.example/broken.png', 'error')
    await expect(renderSceneToPng(IMAGES, { onImageError: () => { throw new Error('reporter') } })).resolves.toBeInstanceOf(Blob)
  })

  it('an item whose bitmap of its own url is loaded is drawn as it is; one still loading is loaded', async () => {
    installCanvas()
    installImage()
    const ready = { width: 4, height: 4, url: 'https://img.example/ready.png', complete: true, toCanvasSource: () => 'ready-pixels' }
    const pending = { width: 4, height: 4, url: 'https://img.example/pending.png', complete: false, toCanvasSource: () => 'never-drawn' }
    const scene = sceneOf({
      width: 40, height: 40,
      data: [{ name: 'h', values: [{ img: ready, u: ready.url }, { img: pending, u: pending.url }] }],
      marks: [{ type: 'image', from: { data: 'h' }, encode: { update: { image: { field: 'img' }, url: { field: 'u' }, x: { value: 0 }, y: { value: 0 }, width: { value: 4 }, height: { value: 4 } } } }],
    })
    await renderSceneToPng(scene)
    expect(created.map((c) => c.src)).toEqual(['https://img.example/pending.png'])
    const sources = canvases[0]!.ctx.draws.map((d) => d.source)
    expect(sources[0]).toBe('ready-pixels')
    expect((sources[1] as { src: string }).src).toBe('https://img.example/pending.png')
  })

  it('a bitmap the scene already holds (a heatmap) is drawn as it is, not loaded', async () => {
    installCanvas()
    installImage()
    const bitmap = { width: 4, height: 4, complete: true, toCanvasSource: () => 'pixels' }
    const scene = sceneOf({
      width: 40, height: 40,
      data: [{ name: 'h', values: [{ img: bitmap }] }],
      marks: [{ type: 'image', from: { data: 'h' }, encode: { update: { image: { field: 'img' }, x: { value: 0 }, y: { value: 0 }, width: { value: 4 }, height: { value: 4 } } } }],
    })
    await renderSceneToPng(scene)
    expect(created).toEqual([])
    expect(canvases[0]!.ctx.draws.map((d) => d.source)).toEqual(['pixels'])
  })
})
