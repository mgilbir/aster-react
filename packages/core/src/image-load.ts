/**
 * The bitmaps of a scene's image marks (shared by the on-screen canvas renderer and `renderSceneToPng`). The canvas renderer draws
 * an image item from the bitmap it holds (`item.image`) and never fetches; these find the items that have a `url` and no bitmap of
 * it, load their urls as vega's canvas loads them, and give a copy of the scene those bitmaps.
 */
import { itemImage, type ItemImage } from './image-box.js'
import type { SceneGroup, SceneItem, SceneRoot } from './types.js'

/** How many image urls are loaded at once (a scene with thousands of urls does not make thousands of requests at once). */
export const IMAGE_CONCURRENCY = 6

/** An image item the canvas renderer would leave blank: it has a `url` and no loaded bitmap of it. */
function needsImage(it: SceneItem): it is SceneItem & { url: string } {
  const url = (it as { url?: unknown }).url
  if (typeof url !== 'string' || url === '') return false
  const img = itemImage(it)
  return img == null || img.complete === false
}

/** The urls of the image items the canvas renderer would leave blank (a `url` and no loaded bitmap of it), in scene order, each once. */
export function sceneImageUrls(scene: SceneRoot): string[] {
  return [...imageUrls(scene.items, new Set())]
}

/** {@link sceneImageUrls} into `out`, over a list of mark nodes. */
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

/** What {@link loadImages} takes. */
export interface ImageLoadOptions {
  /** The wait for all of them together, in milliseconds; at it the loads still running are abandoned and the rest never start. */
  timeoutMs: number
  /** Called once for each url that did not load (a throwing reporter is ignored). */
  onError?: (url: string, error: Error) => void
  /** Who loads them, at the head of each error message. */
  who?: string
}

/**
 * Load `urls` as the bitmaps the canvas renderer draws, as vega's canvas loads images (`crossOrigin = "anonymous"`, so a canvas
 * drawn with them stays readable): at most {@link IMAGE_CONCURRENCY} at a time, with one deadline for all of them. Resolves with
 * the ones that loaded; each that did not is reported to `onError`.
 */
export async function loadImages(urls: Iterable<string>, options: ImageLoadOptions): Promise<Map<string, ItemImage>> {
  const { timeoutMs: timeout, onError, who = 'image' } = options
  const loaded = new Map<string, ItemImage>()
  const queue = [...new Set(urls)]
  if (queue.length === 0) return loaded
  const report = (url: string, error: Error): void => {
    if (onError) {
      try { onError(url, error) } catch { /* a throwing reporter does not stop the load */ }
    }
  }
  const late = (url: string): Error => new Error(`[aster] ${who}: image ${url} not drawn: it did not load within ${timeout} ms`)
  // one deadline for all of them: at it, the loads in flight are abandoned and the ones still queued are not started
  let expired = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<void>((resolve) => { timer = setTimeout(() => { expired = true; resolve() }, timeout) })
  const worker = async (): Promise<void> => {
    for (let url = queue.shift(); url !== undefined; url = queue.shift()) {
      if (expired) { report(url, late(url)); continue }
      const load = loadImage(url, who)
      const outcome = await Promise.race([
        load.promise.then((image) => ({ image }), (error: unknown) => ({ error: error instanceof Error ? error : new Error(String(error)) })),
        deadline.then(() => null),
      ])
      if (outcome === null) {
        load.abort()
        report(url, late(url))
      } else if ('image' in outcome) loaded.set(url, outcome.image)
      else report(url, outcome.error)
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(IMAGE_CONCURRENCY, queue.length) }, worker))
  } finally {
    clearTimeout(timer)
  }
  return loaded
}

/**
 * `scene` with every image item that needs a bitmap and has one in `bitmaps` (by its url) given it, copied along the paths to those
 * items only: the scene the chart holds is never written (its items are shared with the screen and with later evaluations). The
 * very same scene when nothing is given.
 */
export function withSceneImages(scene: SceneRoot, bitmaps: ReadonlyMap<string, ItemImage>): SceneRoot {
  if (bitmaps.size === 0) return scene
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
        const img = needsImage(it) ? bitmaps.get(it.url) : undefined
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

/**
 * Load one image as vega's canvas does (`crossOrigin = "anonymous"`), as the bitmap the canvas renderer draws. `abort` gives up on
 * it: the handlers are dropped and the request is cancelled (an empty `src` fetches nothing and ends the current one).
 */
function loadImage(url: string, who: string): { promise: Promise<ItemImage>; abort: () => void } {
  const Img = (globalThis as { Image?: new () => ImageElement }).Image
  if (typeof Img !== 'function') {
    return { promise: Promise.reject(new Error(`[aster] ${who}: image ${url} not drawn: no Image in this environment`)), abort: () => undefined }
  }
  const img = new Img()
  const promise = new Promise<ItemImage>((resolve, reject) => {
    img.onload = () => {
      img.onload = img.onerror = null
      if (!(img.naturalWidth > 0 && img.naturalHeight > 0)) {
        reject(new Error(`[aster] ${who}: image ${url} not drawn: it has no size`))
        return
      }
      resolve({ width: img.naturalWidth, height: img.naturalHeight, url, complete: true, toCanvasSource: () => img })
    }
    img.onerror = () => {
      img.onload = img.onerror = null
      reject(new Error(`[aster] ${who}: image ${url} not drawn: it did not load (a cross-origin image is drawn only when its server allows CORS)`))
    }
    img.crossOrigin = 'anonymous'
    img.decoding = 'async'
    img.src = url
  })
  return {
    promise,
    abort: () => {
      img.onload = img.onerror = null
      img.src = ''
    },
  }
}
