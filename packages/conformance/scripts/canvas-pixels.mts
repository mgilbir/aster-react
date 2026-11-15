/**
 * Pixels of a live `<canvas>` in a Playwright page, and the canvas gate's comparison of two of them.
 *
 * The browser gates that drive a chart on the canvas renderer (signals, selections) compare what vega's canvas renderer and
 * Aster's paint after every step with the measured tolerance of the canvas pixel gate (`browser-canvas-parity.mts`, which
 * imports the same numbers): a pixel differs when the sum of its four channel differences exceeds `pixel`; a picture may have
 * at most `ratio` of its pixels differ, and a mean per-channel difference of at most `mean`.
 */

/** Chromium's tolerance, measured over the corpus against vega's own canvas (see `browser-canvas-parity.mts`). */
export const CANVAS_LIMITS = { pixel: 48, ratio: 0.0005, mean: 0.05 } as const

export interface Pixels { w: number; h: number; b64: string }

/**
 * Page code (a function expression, as text) that reads a canvas's backing pixels: `{ w, h, b64 }` (RGBA, base64). A canvas
 * of no width or height has no pixels; its size is still compared.
 */
export const READ_PIXELS = `(canvas) => {
  if (!canvas || canvas.width === 0 || canvas.height === 0) return { w: canvas ? canvas.width : -1, h: canvas ? canvas.height : -1, b64: '' }
  const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height)
  let s = ''
  for (let i = 0; i < data.length; i += 0x8000) s += String.fromCharCode.apply(null, data.subarray(i, i + 0x8000))
  return { w: canvas.width, h: canvas.height, b64: btoa(s) }
}`

/** How two pictures differ: null when they agree within the limits, else what is wrong. */
export function pixelDiff(a: Pixels, b: Pixels, limits: { pixel: number; ratio: number; mean: number } = CANVAS_LIMITS): string | null {
  if (a.w !== b.w || a.h !== b.h) return `size ${a.w}x${a.h} != ${b.w}x${b.h}`
  if (a.b64 === b.b64) return null
  const da = Buffer.from(a.b64, 'base64')
  const db = Buffer.from(b.b64, 'base64')
  const count = a.w * a.h
  let bad = 0
  let sum = 0
  for (let i = 0; i < count * 4; i += 4) {
    const d = Math.abs(da[i]! - db[i]!) + Math.abs(da[i + 1]! - db[i + 1]!) + Math.abs(da[i + 2]! - db[i + 2]!) + Math.abs(da[i + 3]! - db[i + 3]!)
    sum += d
    if (d > limits.pixel) bad++
  }
  const ratio = bad / count
  const mean = sum / (count * 4)
  return ratio > limits.ratio || mean > limits.mean ? `pixels differ: ${bad} of ${count} (ratio ${ratio.toExponential(2)}), mean ${mean.toFixed(3)}` : null
}

/** Whether a picture has any ink at all (a comparison of two blank canvases proves nothing). */
export function hasInk(p: Pixels): boolean {
  if (!p.b64) return false
  const d = Buffer.from(p.b64, 'base64')
  for (let i = 3; i < d.length; i += 4) if (d[i] !== 0) return true
  return false
}
