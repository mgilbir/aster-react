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

/**
 * Host-provided text measurement. A provider replaces the offscreen-canvas
 * measurement for every layout/bounds call (and therefore also applies in
 * Node/headless or when a custom font must be measured by the host's own
 * engine). Return a non-negative advance width in CSS pixels.
 */
export interface TextMetricsProvider {
  measure(text: string, font: string, fontSize: number, item?: FontProps): number
}

let activeProvider: TextMetricsProvider | null = null
let activeProviderId = 0
let providerSeq = 0

export function setTextMetricsProvider(provider: TextMetricsProvider | null): void {
  activeProvider = provider
  activeProviderId = provider ? ++providerSeq : 0
  widthCache.clear()
}

export function getTextMetricsProvider(): TextMetricsProvider | null {
  return activeProvider
}

/** Run `fn` with a scoped provider (used by <Chart>/renderSpec). */
export function withTextMetricsProvider<T>(provider: TextMetricsProvider | null | undefined, fn: () => T): T {
  if (!provider || provider === activeProvider) return fn()
  const prev = activeProvider
  const prevId = activeProviderId
  setTextMetricsProvider(provider)
  try {
    return fn()
  } finally {
    activeProvider = prev
    activeProviderId = prevId
  }
}

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
  return activeProvider != null || canvasContext() != null
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

/** vega-scenegraph `_measureWidth`: provider/canvas measurement, cached by font+text. */
export function measureText(text: string, font: string, item?: FontProps): number {
  const key = `${activeProviderId}|(${font}) ${text}`
  let w = widthCache.get(key)
  if (w === undefined) {
    if (activeProvider) {
      try {
        const measured = activeProvider.measure(text, font, fontFontSize(item ?? {}), item)
        w = Number.isFinite(measured) && measured >= 0 ? measured : estimateTextWidth(text, fontFontSize(item ?? {}))
      } catch {
        w = estimateTextWidth(text, fontFontSize(item ?? {}))
      }
    } else {
      const ctx = canvasContext()
      if (!ctx) return 0
      ctx.font = font
      w = ctx.measureText(text).width
    }
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
    return fs <= 0 || !text ? 0 : measureText(text, fontString(item), item)
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
    return measureText(text, fontString({ fontSize, fontWeight }), { fontSize, fontWeight })
  }
  return estimateTextWidth(text, fontSize)
}
