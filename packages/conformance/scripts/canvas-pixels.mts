/**
 * Pixels of a live `<canvas>` in a Playwright page, and the one comparison of two pictures every pixel gate uses.
 *
 * The browser gates that drive a chart on the canvas renderer (signals, selections), the canvas parity gate and its phases
 * and the batched-SVG gate compare two pictures with `comparePixels` (in Node through `pixelDiff`, in a page through the
 * source text `COMPARE_PIXELS_SOURCE`). A pixel differs when the sum of its four channel differences exceeds `pixel`. Two
 * pictures agree only when ALL of these hold:
 *   - the same size;
 *   - at most `ratio` of the pixels differ and the mean per-channel difference is at most `mean` (the noise envelope
 *     measured over the corpus: path coordinates rounded to three decimals, see browser-canvas-parity.mts);
 *   - LOCALITY: no `window`x`window` square holds more than `local` differing pixels. The global limits alone let a whole
 *     small mark through (a missing 5x5 mark is 25 pixels of 127,100); rounding noise is spread along edges, a missing,
 *     moved or recoloured mark is concentrated, and a square of the picture sees it;
 *   - INK: where one picture has ink the other has ink too. A picture "has ink" when it is not one uniform colour; a
 *     comparison of a picture with ink against a blank one is a difference whatever the counts say, and the gates count a
 *     comparison of two blank pictures apart from the ones that compared something (`inked` in the result).
 */

/**
 * Chromium's tolerance, measured over the corpus against vega's own canvas (see `browser-canvas-parity.mts`). `local`: the
 * most differing pixels any agreeing entry has in one 8x8 square is 7 (legend-discretizing-labels.vg: the antialiased ring
 * of a 6 px legend circle, drawn from rounded path text where vega's canvas draws an arc; the next is 2), Chromium,
 * 2026-11-23. A missing 3x3 mark is 9, a missing 5x5 one 25, a 7x7 one moved by a pixel 14.
 */
export const CANVAS_LIMITS = { pixel: 48, ratio: 0.0005, mean: 0.05, window: 8, local: 7 } as const
export type PixelLimits = { pixel: number; ratio: number; mean: number; window: number; local: number }

export interface Pixels { w: number; h: number; b64: string }

/** What `comparePixels` found: `error` is null when the pictures agree within the limits. */
export interface PixelComparison {
  error: string | null
  bad: number
  ratio: number
  mean: number
  /** the most differing pixels in one `window`x`window` square, and that square's top-left corner */
  local: number
  at: [number, number] | null
  /** whether each picture has ink (is not one uniform colour) */
  inkA: boolean
  inkB: boolean
}

/**
 * Compare two RGBA pictures of `w` x `h` pixels. Self-contained (no reference to anything outside its body), so a page can
 * run the same code from `COMPARE_PIXELS_SOURCE`.
 */
export function comparePixels(a: ArrayLike<number>, b: ArrayLike<number>, w: number, h: number, limits: PixelLimits): PixelComparison {
  const count = w * h
  const uniform = (d: ArrayLike<number>): boolean => {
    for (let i = 4; i < count * 4; i++) if (d[i] !== d[i % 4]) return false
    return true
  }
  const inkA = count > 0 && !uniform(a)
  const inkB = count > 0 && !uniform(b)
  if (count === 0) return { error: null, bad: 0, ratio: 0, mean: 0, local: 0, at: null, inkA, inkB }
  // differing pixels, and their summed-area table for the locality test
  const W = w + 1
  const sat = new Int32Array(W * (h + 1))
  let bad = 0
  let sum = 0
  for (let y = 0; y < h; y++) {
    let row = 0
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const d = Math.abs(a[i]! - b[i]!) + Math.abs(a[i + 1]! - b[i + 1]!) + Math.abs(a[i + 2]! - b[i + 2]!) + Math.abs(a[i + 3]! - b[i + 3]!)
      sum += d
      if (d > limits.pixel) {
        bad++
        row++
      }
      sat[(y + 1) * W + x + 1] = sat[y * W + x + 1]! + row
    }
  }
  let local = 0
  let at: [number, number] | null = null
  if (bad > 0) {
    const k = Math.min(limits.window, w, h)
    for (let y = k; y <= h; y++) {
      for (let x = k; x <= w; x++) {
        const n = sat[y * W + x]! - sat[(y - k) * W + x]! - sat[y * W + x - k]! + sat[(y - k) * W + x - k]!
        if (n > local) {
          local = n
          at = [x - k, y - k]
        }
      }
    }
  }
  const ratio = bad / count
  const mean = sum / (count * 4)
  const problems: string[] = []
  if (inkA !== inkB) problems.push(inkA ? 'the first picture has ink, the second is blank' : 'the second picture has ink, the first is blank')
  if (ratio > limits.ratio || mean > limits.mean) problems.push(`${bad} of ${count} pixels differ (ratio ${ratio.toExponential(2)}), mean ${mean.toFixed(3)}`)
  if (local > limits.local) problems.push(`${local} differing pixels in the ${limits.window}x${limits.window} square at ${at ? at.join(',') : '-'} (a mark missing, moved or recoloured)`)
  return { error: problems.length ? problems.join('; ') : null, bad, ratio, mean, local, at, inkA, inkB }
}

/**
 * `comparePixels` as a page-code expression: `const comparePixels = <this>` declares it in a page script. (The TypeScript
 * loader may wrap inner functions in a `__name` helper to keep their names; the expression brings its own.)
 */
export const COMPARE_PIXELS_SOURCE = `(() => { const __name = (f) => f; return ${comparePixels.toString()} })()`

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

/** How two pictures differ: null when they agree within the limits (`comparePixels`), else what is wrong. */
export function pixelDiff(a: Pixels, b: Pixels, limits: PixelLimits = CANVAS_LIMITS): string | null {
  if (a.w !== b.w || a.h !== b.h) return `size ${a.w}x${a.h} != ${b.w}x${b.h}`
  if (a.b64 === b.b64) return null
  return comparePixels(Buffer.from(a.b64, 'base64'), Buffer.from(b.b64, 'base64'), a.w, a.h, limits).error
}

/** Whether a picture has ink (is not one uniform colour): a comparison of two blank pictures proves nothing. */
export function hasInk(p: Pixels): boolean {
  if (!p.b64) return false
  const d = Buffer.from(p.b64, 'base64')
  for (let i = 4; i < d.length; i++) if (d[i] !== d[i % 4]) return true
  return false
}
