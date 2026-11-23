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
/**
 * Measured widths, one cache per measurer (a provider, or the canvas when there is none): a scoped provider
 * (`withTextMetricsProvider`, a per-call `textMetrics`) neither reads another's widths nor clears them. Each is bounded, and
 * cleared whole when full. A key is the font's length, the font, then the text: no font and text can make another pair's key.
 */
const CANVAS_WIDTHS = new Map<string, number>()
const PROVIDER_WIDTHS = new WeakMap<TextMetricsProvider, Map<string, number>>()
const WIDTH_CACHE_MAX = 8000

function widthsOf(provider: TextMetricsProvider | null): Map<string, number> {
  if (provider === null) return CANVAS_WIDTHS
  let widths = PROVIDER_WIDTHS.get(provider)
  if (widths === undefined) PROVIDER_WIDTHS.set(provider, (widths = new Map()))
  return widths
}

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

/**
 * Set the measurer every chart uses from now on (null: the canvas, or the estimate where there is none). Setting one forgets
 * the widths it measured before (a host sets it again once its fonts have loaded).
 */
export function setTextMetricsProvider(provider: TextMetricsProvider | null): void {
  activeProvider = provider
  widthsOf(provider).clear()
}

export function getTextMetricsProvider(): TextMetricsProvider | null {
  return activeProvider
}

/** Run `fn` with a scoped provider (used by <Chart>/renderSpec); none given keeps the one in force. */
export function withTextMetricsProvider<T>(provider: TextMetricsProvider | null | undefined, fn: () => T): T {
  return provider ? withExactTextMetricsProvider(provider, fn) : fn()
}

/** Run `fn` with exactly this measurer in force, null (the canvas, or the estimate) included: how a scene is drawn under its own. */
export function withExactTextMetricsProvider<T>(provider: TextMetricsProvider | null, fn: () => T): T {
  if (provider === activeProvider) return fn()
  const prev = activeProvider
  activeProvider = provider
  try {
    return fn()
  } finally {
    activeProvider = prev
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

/**
 * A new canvas element of the host (what vega-canvas's `canvas()` is in a browser), or null where the host has none to draw on
 * (Node, jsdom without a canvas package).
 */
export function createHostCanvas(): HTMLCanvasElement | null {
  if (canvasContext() === null) return null
  try { return document.createElement('canvas') } catch { return null }
}

/** True when vega-style canvas measurement is possible in this environment. */
export function usingCanvasTextMetrics(): boolean {
  return activeProvider != null || canvasContext() != null
}

export interface FontProps {
  fontSize?: unknown
  /** The font family (vega's `font` channel). */
  font?: unknown
  fontWeight?: unknown
  fontStyle?: unknown
  fontVariant?: unknown
}

/** vega-scenegraph `fontSize(item)`: default 11. */
export function fontFontSize(item: FontProps): number {
  return item.fontSize != null ? +item.fontSize || 0 : 11
}

/**
 * vega-scenegraph `font(item)`: `[style ][variant ][weight ]{size}px {family}`, the size as `fontFontSize` reads it and the
 * family the item's `font`, else `sans-serif`. The one font text is measured with and drawn with (canvas.ts, label-draw.ts).
 */
export function fontString(item: FontProps): string {
  return (
    (item.fontStyle ? item.fontStyle + ' ' : '') +
    (item.fontVariant ? item.fontVariant + ' ' : '') +
    (item.fontWeight ? item.fontWeight + ' ' : '') +
    fontFontSize(item) + 'px ' +
    ((item.font as string | undefined) || 'sans-serif')
  )
}

/** vega-scenegraph `_measureWidth`: provider/canvas measurement, cached by font+text. */
export function measureText(text: string, font: string, item?: FontProps): number {
  const widths = widthsOf(activeProvider)
  const key = `${font.length}:${font}${text}`
  let w = widths.get(key)
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
    if (widths.size >= WIDTH_CACHE_MAX) widths.clear()
    widths.set(key, w)
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
 * Where a text item is anchored: its x/y, pushed `radius` out along the direction `theta` (radians, clockwise from twelve
 * o'clock). The item keeps all four channels as encoded; every renderer and the bounds go through this to find the anchor.
 */
export function textAnchor(item: { x?: unknown; y?: unknown; radius?: unknown; theta?: unknown }): [number, number] {
  const x = +(item.x as number) || 0
  const y = +(item.y as number) || 0
  const radius = +(item.radius as number) || 0
  if (!radius) return [x, y]
  const angle = (+(item.theta as number) || 0) - Math.PI / 2
  return [x + radius * Math.cos(angle), y + radius * Math.sin(angle)]
}

/** The fields of a text item that decide how a line is cut to its `limit`. */
export interface TruncateProps extends FontProps {
  limit?: unknown
  ellipsis?: unknown
  dir?: unknown
}

/**
 * A line of text cut to the item's `limit` (a pixel width), the one place every renderer and the bounds ask. A line that fits is
 * kept whole. Otherwise the longest piece that still fits next to the ellipsis is kept, with the ellipsis (an empty one is
 * the default "\u2026") where the text was cut: the start of the line, or its end when `dir` is `rtl`.
 */
export function truncateToLimit(item: TruncateProps, text: string): string {
  const limit = +(item.limit as number)
  if (!(limit > 0) || !text.length) return text
  const widthOf = (s: string): number => itemTextWidth(item, s)
  if (widthOf(text) < limit) return text
  const ellipsis = (item.ellipsis as string | undefined) || '\u2026'
  const room = limit - widthOf(ellipsis)
  let lo = 0
  let hi = text.length
  if (item.dir === 'rtl') {
    // the shortest cut, from the end, whose remainder fits
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (widthOf(text.slice(mid)) > room) lo = mid + 1
      else hi = mid
    }
    return ellipsis + text.slice(lo)
  }
  while (lo < hi) {
    const mid = 1 + ((lo + hi) >>> 1)
    if (widthOf(text.slice(0, mid)) < room) lo = mid
    else hi = mid - 1
  }
  return text.slice(0, lo) + ellipsis
}
