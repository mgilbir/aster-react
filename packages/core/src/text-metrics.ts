/**
 * Text metrics — a faithful port of vega-scenegraph's `util/text.js` text
 * measurement, including the canvas path vega uses when a DOM is available.
 *
 * Why this matters: vega measures text with a cached offscreen-canvas
 * `measureText` in browsers, and falls back to the headless estimate
 * (`~~(0.8 * len * fontSize)`) only when no canvas exists. Matching vega in a
 * real browser therefore requires measuring with the same font strings, not
 * just matching its estimate. The estimator remains the fallback so headless
 * environments (jsdom without the `canvas` package) keep the exact behaviour
 * the conformance harness pins.
 */
const widthCache = new Map<string, number>()
const WIDTH_CACHE_MAX = 8000

let ctx2d: CanvasRenderingContext2D | null | undefined

function canvasContext(): CanvasRenderingContext2D | null {
  if (ctx2d === undefined) {
    ctx2d = null
    try {
      if (typeof document !== 'undefined') {
        const c = document.createElement('canvas')
        ctx2d = (c.getContext('2d') as CanvasRenderingContext2D | null) ?? null
      }
    } catch {
      ctx2d = null
    }
  }
  return ctx2d
}

/** True when vega-style canvas measurement is possible in this environment. */
export function usingCanvasTextMetrics(): boolean {
  return canvasContext() != null
}

export interface FontProps {
  fontSize?: unknown
  fontFamily?: unknown
  fontWeight?: unknown
  fontStyle?: unknown
  fontVariant?: unknown
}

/** vega-scenegraph `fontSize(item)`: default 11. */
export function fontFontSize(item: FontProps): number {
  return item.fontSize != null ? +item.fontSize || 0 : 11
}

/** vega-scenegraph `font(item)`: `[style ][variant ][weight ]{size}px {family}`. */
export function fontString(item: FontProps): string {
  return (
    (item.fontStyle ? item.fontStyle + ' ' : '') +
    (item.fontVariant ? item.fontVariant + ' ' : '') +
    (item.fontWeight ? item.fontWeight + ' ' : '') +
    fontFontSize(item) + 'px ' +
    ((item.fontFamily as string | undefined) || 'sans-serif')
  )
}

/** vega-scenegraph `_measureWidth`: canvas measurement, LRU-ish cached by font+text. */
export function measureText(text: string, font: string): number {
  const key = `(${font}) ${text}`
  let w = widthCache.get(key)
  if (w === undefined) {
    const ctx = canvasContext()
    if (!ctx) return 0
    ctx.font = font
    w = ctx.measureText(text).width
    if (widthCache.size >= WIDTH_CACHE_MAX) widthCache.clear()
    widthCache.set(key, w)
  }
  return w
}

/** vega-scenegraph `_estimateWidth` (the no-canvas fallback): `~~(0.8 * len * fs)`. */
export function estimateTextWidth(text: string, fontSize: number): number {
  return ~~(0.8 * text.length * fontSize)
}

/**
 * vega `textMetrics.width(item, text)` dispatch: canvas measurement (with the
 * `fontSize <= 0 / empty text -> 0` guard) when a canvas exists, the headless
 * estimate (no guard, exactly as vega ships it) otherwise.
 */
export function itemTextWidth(item: FontProps, text: string): number {
  const fs = fontFontSize(item)
  if (usingCanvasTextMetrics()) {
    return fs <= 0 || !text ? 0 : measureText(text, fontString(item))
  }
  return estimateTextWidth(String(text ?? ''), fs)
}

/**
 * Measure a plain string with a nominal font (no scene item). `fontWeight`
 * maps straight onto the canvas font string; the estimate fallback ignores it
 * exactly like vega's headless path does.
 */
export function nominalTextWidth(text: string, fontSize: number, fontWeight?: unknown): number {
  if (usingCanvasTextMetrics()) {
    if (fontSize <= 0 || !text) return 0
    return measureText(text, fontString({ fontSize, fontWeight }))
  }
  return estimateTextWidth(text, fontSize)
}
