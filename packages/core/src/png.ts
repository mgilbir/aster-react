/**
 * A scene as a PNG (`@aster-charts/core/png`): the scene painted by the canvas renderer and encoded by the platform canvas.
 *
 *   const blob = await renderSceneToPng(scene, { scale: 2 })
 *
 * Nothing is serialized to SVG and nothing is loaded into an `<img>` from a `blob:` or `data:` url, so it works on a page whose
 * Content-Security-Policy does not allow those in `img-src`. The only images it loads are the scene's own image marks (their
 * `url`, already vetted by the chart's `urlPolicy`), which the SVG draws from the same urls: loaded as vega's canvas loads them
 * (`crossOrigin = "anonymous"`), so the canvas stays readable; one that does not load is not drawn, and `onImageError` says so.
 *
 * An opt-in entry: it imports the canvas renderer, which a chart that never exports does not need.
 */
import { renderSceneToCanvas, type CanvasLike } from './canvas.js'
import { IMAGE_CONCURRENCY, loadImages, sceneImageUrls, withSceneImages } from './image-load.js'
import type { SceneRoot } from './types.js'

export interface PngOptions {
  /** Pixels per scene unit (the device pixel ratio of the image). Default 1. A finite number above 0. */
  scale?: number
  /**
   * How long to wait for the image marks' images, all of them together, in milliseconds (default 10 000, at most
   * {@link PNG_MAX_IMAGE_TIMEOUT_MS}). An image that has not loaded by then is not drawn, like one that failed, and its request
   * is abandoned; so the export never waits longer than this for images, however many the scene has.
   */
  imageTimeoutMs?: number
  /**
   * Called for each image mark url that could not be loaded (a network error, a cross-origin server that does not allow CORS,
   * the timeout, or no `Image` in this environment); that image is not in the PNG. Without it a failed image is still left out.
   */
  onImageError?: (url: string, error: Error) => void
}

/** The largest width or height, in pixels, of the image `renderSceneToPng` makes. */
export const PNG_MAX_SIDE = 32_767
/** The largest area, in pixels, of the image `renderSceneToPng` makes (16 384 x 16 384). */
export const PNG_MAX_PIXELS = 268_435_456
/** The default `imageTimeoutMs`. */
export const PNG_IMAGE_TIMEOUT_MS = 10_000
/** The largest `imageTimeoutMs`: what a timer can wait (2^31 - 1 ms, about 24.8 days). */
export const PNG_MAX_IMAGE_TIMEOUT_MS = 2_147_483_647
/** How many image mark urls are loaded at once (a scene with thousands of urls does not make thousands of requests at once). */
export const PNG_IMAGE_CONCURRENCY = IMAGE_CONCURRENCY

/** A canvas this module can paint and encode: a `<canvas>` element or an `OffscreenCanvas`. */
interface PngCanvas {
  width: number
  height: number
  getContext(type: '2d'): unknown
  toBlob?(callback: (blob: Blob | null) => void, type?: string): void
  convertToBlob?(options?: { type?: string }): Promise<Blob>
}

/**
 * Paint `scene` with the canvas renderer and encode it as a PNG. The image is `ceil(width * scale)` x `ceil(height * scale)`
 * pixels; the scene's `background` is painted (none: transparent), exactly as `renderSceneToCanvas` paints it on screen.
 *
 * Rejects with a `RangeError` for a `scale` that is not a finite number above 0, for a scene with no area, and for an image
 * beyond {@link PNG_MAX_SIDE} / {@link PNG_MAX_PIXELS}; with an `Error` when this environment has no canvas or the canvas
 * cannot be encoded (a browser may refuse a canvas far below those caps, and an image drawn into it from another origin without
 * CORS makes it unreadable).
 */
export async function renderSceneToPng(scene: SceneRoot, options: PngOptions = {}): Promise<Blob> {
  const scale = options.scale ?? 1
  if (typeof scale !== 'number' || !Number.isFinite(scale) || scale <= 0) {
    throw new RangeError(`[aster] renderSceneToPng: scale must be a finite number above 0, got ${String(scale)}`)
  }
  const timeout = options.imageTimeoutMs ?? PNG_IMAGE_TIMEOUT_MS
  if (typeof timeout !== 'number' || !(timeout >= 0 && timeout <= PNG_MAX_IMAGE_TIMEOUT_MS)) {
    // (a timer converts a larger value, Infinity included, to a wait of 0 or a wrapped one: every image would be dropped)
    throw new RangeError(`[aster] renderSceneToPng: imageTimeoutMs must be a number of milliseconds from 0 to ${PNG_MAX_IMAGE_TIMEOUT_MS}, got ${String(timeout)}`)
  }
  const { width: w, height: h } = pixelSize(scene, scale)
  // (an environment without a canvas fails here, before any image is requested; the canvas itself is made once they are in, so
  // its memory is not held while they load)
  const makeCanvas = canvasMaker()
  // web fonts still loading would draw text in a fallback face: wait for them, as the page will
  await fontsReady()
  const loaded = await loadImages(sceneImageUrls(scene), { timeoutMs: timeout, onError: options.onImageError, who: 'renderSceneToPng' })
  const painted = withSceneImages(scene, loaded)
  const canvas = makeCanvas(w, h)
  const ctx = canvas.getContext('2d') as CanvasLike | null
  if (ctx == null) throw new Error(`[aster] renderSceneToPng: no 2D context for a ${w} x ${h} canvas`)
  renderSceneToCanvas(painted, ctx, { dpr: scale })
  return encode(canvas, w, h)
}

function pixelSize(scene: SceneRoot, scale: number): { width: number; height: number } {
  const sw = scene?.width
  const sh = scene?.height
  if (typeof sw !== 'number' || typeof sh !== 'number' || !Number.isFinite(sw) || !Number.isFinite(sh)) {
    throw new RangeError(`[aster] renderSceneToPng: the scene has no finite size (${String(sw)} x ${String(sh)})`)
  }
  const width = Math.ceil(sw * scale)
  const height = Math.ceil(sh * scale)
  if (!(width >= 1 && height >= 1)) throw new RangeError(`[aster] renderSceneToPng: the scene has no area (${sw} x ${sh} at scale ${scale})`)
  if (width > PNG_MAX_SIDE || height > PNG_MAX_SIDE || width * height > PNG_MAX_PIXELS) {
    throw new RangeError(
      `[aster] renderSceneToPng: a ${width} x ${height} image is too large (at most ${PNG_MAX_SIDE} pixels a side and ${PNG_MAX_PIXELS} in all); use a smaller scale`,
    )
  }
  return { width, height }
}

/** How this environment makes a canvas: a `<canvas>` element, else an `OffscreenCanvas`; throws when it has neither. */
function canvasMaker(): (width: number, height: number) => PngCanvas {
  const g = globalThis as { document?: { createElement?(tag: string): unknown }; OffscreenCanvas?: new (w: number, h: number) => PngCanvas }
  const sized = (canvas: PngCanvas, width: number, height: number): PngCanvas => {
    canvas.width = width
    canvas.height = height
    return canvas
  }
  const doc = g.document
  if (typeof doc?.createElement === 'function') return (w, h) => sized(doc.createElement!('canvas') as PngCanvas, w, h)
  const Offscreen = g.OffscreenCanvas
  if (typeof Offscreen === 'function') return (w, h) => sized(new Offscreen(w, h), w, h)
  throw new Error('[aster] renderSceneToPng: this environment has no canvas (no document, no OffscreenCanvas)')
}

async function fontsReady(): Promise<void> {
  const fonts = (globalThis as { document?: { fonts?: { ready?: Promise<unknown> } } }).document?.fonts
  try { await fonts?.ready } catch { /* a font that failed to load is drawn in its fallback, as on the page */ }
}

function encode(canvas: PngCanvas, w: number, h: number): Promise<Blob> {
  const unreadable = (cause: unknown): Error =>
    new Error(
      `[aster] renderSceneToPng: the ${w} x ${h} canvas could not be read back (an image drawn into it from another origin without CORS makes it unreadable): ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    )
  const refused = (): Error => new Error(`[aster] renderSceneToPng: the browser could not encode a ${w} x ${h} canvas as a PNG (it may be too large for this device)`)
  if (typeof canvas.toBlob === 'function') {
    return new Promise<Blob>((resolve, reject) => {
      try {
        canvas.toBlob!((blob) => (blob ? resolve(blob) : reject(refused())), 'image/png')
      } catch (e) {
        reject(unreadable(e))
      }
    })
  }
  if (typeof canvas.convertToBlob === 'function') {
    return canvas.convertToBlob({ type: 'image/png' }).then(
      (blob) => blob ?? Promise.reject(refused()),
      (e: unknown) => Promise.reject(e instanceof DOMException && e.name === 'SecurityError' ? unreadable(e) : e),
    )
  }
  return Promise.reject(new Error('[aster] renderSceneToPng: this canvas cannot encode an image (no toBlob, no convertToBlob)'))
}
