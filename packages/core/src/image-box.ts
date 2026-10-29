/**
 * An image mark item's bitmap and box (vega-scenegraph marks/image.js: getImage, imageWidth, imageHeight, the align / baseline
 * offsets). The bitmap is the item's `image` (a canvas-shaped value: a `heatmap` transform's, or the host's) unless the item has a
 * `url` of its own that the image was not loaded from; with no bitmap the box is the item's `width` / `height`, else 0.
 */

/** What an image item holds as its bitmap: vega's loaded `Image` or canvas (`src`, or `toDataURL()`). */
export interface ItemImage {
  width: number
  height: number
  url?: string
  src?: string
  complete?: boolean
  toDataURL?(): string
  toCanvasSource?(): unknown
}

interface ImageItem { image?: unknown; url?: string; width?: number; height?: number; aspect?: boolean; x?: number; y?: number; align?: string; baseline?: string }

/**
 * vega `getImage`: the item's own bitmap, unless it was loaded from another `url` than the item's now (vega loads the new one). A
 * bitmap that records no url (a `heatmap`'s canvas, one the host drew) is the item's.
 */
export function itemImage(it: object): ItemImage | undefined {
  const i = it as ImageItem
  const image = i.image as ItemImage | null | undefined
  if (!image || typeof image !== 'object') return undefined
  return i.url && image.url !== undefined && i.url !== image.url ? undefined : image
}

/** The href vega writes for a bitmap: its `src`, else the data URL of a canvas. */
export function imageHref(image: ItemImage): string {
  return !image.src && image.toDataURL ? image.toDataURL() : image.src || ''
}

export function imageBox(it: object): { x: number; y: number; w: number; h: number } {
  const i = it as ImageItem
  const image = itemImage(it)
  const w = i.width != null ? i.width
    : !image || !image.width ? 0
      : i.aspect !== false && i.height ? (i.height * image.width) / image.height
        : image.width
  const h = i.height != null ? i.height
    : !image || !image.height ? 0
      : i.aspect !== false && i.width ? (i.width * image.height) / image.width
        : image.height
  return {
    x: (i.x || 0) - (i.align === 'center' ? w / 2 : i.align === 'right' ? w : 0),
    y: (i.y || 0) - (i.baseline === 'middle' ? h / 2 : i.baseline === 'bottom' ? h : 0),
    w,
    h,
  }
}
