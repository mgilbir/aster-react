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
import { itemImage, type ItemImage } from './image-box.js'
import type { SceneGroup, SceneItem, SceneRoot } from './types.js'

export interface PngOptions {
  /** Pixels per scene unit (the device pixel ratio of the image). Default 1. A finite number above 0. */
  scale?: number
  /**
   * How long to wait for one image mark's image, in milliseconds (default 10 000). An image that has not loaded by then is not
   * drawn, like one that failed.
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
  if (typeof timeout !== 'number' || !(timeout >= 0)) {
    throw new RangeError(`[aster] renderSceneToPng: imageTimeoutMs must be a number of milliseconds, got ${String(timeout)}`)
  }
  const { width: w, height: h } = pixelSize(scene, scale)
  const canvas = createCanvas(w, h)
  // web fonts still loading would draw text in a fallback face: wait for them, as the page will
  await fontsReady()
  const painted = await withImages(scene, timeout, options.onImageError)
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

function createCanvas(width: number, height: number): PngCanvas {
  const g = globalThis as { document?: { createElement?(tag: string): unknown }; OffscreenCanvas?: new (w: number, h: number) => PngCanvas }
  let canvas: PngCanvas | undefined
  if (typeof g.document?.createElement === 'function') canvas = g.document.createElement('canvas') as PngCanvas
  else if (typeof g.OffscreenCanvas === 'function') canvas = new g.OffscreenCanvas(width, height)
  if (canvas == null) throw new Error('[aster] renderSceneToPng: this environment has no canvas (no document, no OffscreenCanvas)')
  canvas.width = width
  canvas.height = height
  return canvas
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

// ---------------------------------------------------------------------------
// Image marks
// ---------------------------------------------------------------------------

/** An image item the canvas renderer would leave blank: it has a `url` and no loaded bitmap of it. */
function needsImage(it: SceneItem): it is SceneItem & { url: string } {
  const url = (it as { url?: unknown }).url
  if (typeof url !== 'string' || url === '') return false
  const img = itemImage(it)
  return img == null || img.complete === false
}

/** The urls of every image item that needs its image loaded, in scene order (each once). */
function imageUrls(nodes: readonly SceneGroup[] | undefined, out: Set<string>): Set<string> {
  for (const node of nodes ?? []) {
    if (node.marktype === 'image') {
      for (const it of node.items ?? []) if (needsImage(it)) out.add(it.url)
    } else {
      for (const it of node.items ?? []) if (Array.isArray((it as SceneGroup).items)) imageUrls([it as SceneGroup], out)
    }
  }
  return out
}

/** A copy of `o` with its own properties (non-enumerable ones too) and prototype, and `patch` over them. */
function copyWith<T extends object>(o: T, patch: Partial<T>): T {
  return Object.assign(Object.create(Object.getPrototypeOf(o) as object | null, Object.getOwnPropertyDescriptors(o)) as T, patch)
}

/**
 * `scene` with every image item that needs one given its loaded bitmap, copied along the paths to those items only: the scene
 * the chart holds is never written (its items are shared with the screen and with later evaluations).
 */
async function withImages(scene: SceneRoot, timeout: number, onError: PngOptions['onImageError']): Promise<SceneRoot> {
  const urls = imageUrls(scene.items, new Set())
  if (urls.size === 0) return scene
  const loaded = new Map<string, ItemImage>()
  await Promise.all([...urls].map(async (url) => {
    try {
      loaded.set(url, await loadImage(url, timeout))
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e))
      if (onError) {
        try { onError(url, error) } catch { /* a throwing reporter does not stop the export */ }
      }
    }
  }))
  if (loaded.size === 0) return scene
  const mapNodes = (nodes: SceneGroup[]): SceneGroup[] => {
    let changed = false
    const out = nodes.map((node) => {
      const next = mapNode(node)
      if (next !== node) changed = true
      return next
    })
    return changed ? out : nodes
  }
  const mapNode = (node: SceneGroup): SceneGroup => {
    const items = node.items
    if (!items) return node
    let changed = false
    const out = items.map((it) => {
      let next: SceneItem = it
      if (node.marktype === 'image') {
        const img = needsImage(it) ? loaded.get(it.url) : undefined
        if (img) next = copyWith(it, { image: img } as Partial<SceneItem>)
      } else if (Array.isArray((it as SceneGroup).items)) {
        next = mapNode(it as SceneGroup)
      }
      if (next !== it) changed = true
      return next
    })
    return changed ? copyWith(node, { items: out as SceneGroup['items'] }) : node
  }
  const items = mapNodes(scene.items)
  return items === scene.items ? scene : copyWith(scene, { items })
}

type ImageElement = {
  crossOrigin: string | null
  decoding?: string
  src: string
  naturalWidth: number
  naturalHeight: number
  onload: ((this: unknown) => void) | null
  onerror: ((this: unknown) => void) | null
}

/** Load one image as vega's canvas does (`crossOrigin = "anonymous"`), as the bitmap the canvas renderer draws. */
function loadImage(url: string, timeout: number): Promise<ItemImage> {
  const Img = (globalThis as { Image?: new () => ImageElement }).Image
  if (typeof Img !== 'function') return Promise.reject(new Error(`[aster] renderSceneToPng: image ${url} not drawn: no Image in this environment`))
  return new Promise<ItemImage>((resolve, reject) => {
    const img = new Img()
    let timer: ReturnType<typeof setTimeout> | undefined
    const done = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      img.onload = null
      img.onerror = null
    }
    img.onload = () => {
      done()
      if (!(img.naturalWidth > 0 && img.naturalHeight > 0)) {
        reject(new Error(`[aster] renderSceneToPng: image ${url} not drawn: it has no size`))
        return
      }
      resolve({ width: img.naturalWidth, height: img.naturalHeight, url, complete: true, toCanvasSource: () => img })
    }
    img.onerror = () => {
      done()
      reject(new Error(`[aster] renderSceneToPng: image ${url} not drawn: it did not load (a cross-origin image is drawn only when its server allows CORS)`))
    }
    timer = setTimeout(() => {
      done()
      reject(new Error(`[aster] renderSceneToPng: image ${url} not drawn: it did not load within ${timeout} ms`))
    }, timeout)
    img.crossOrigin = 'anonymous'
    img.decoding = 'async'
    img.src = url
  })
}
