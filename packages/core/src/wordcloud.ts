/**
 * The `wordcloud` transform: a port of vega-wordcloud 5.1.2 (`Wordcloud.js`) and of the layout it wraps, Jason Davies' d3-cloud
 * (`CloudLayout.js`, after Jonathan Feinberg's "Wordle" algorithm), statement for statement: the order the words are sprited in,
 * where the spiral starts and how it steps, how a sprite is cut from the sheet and trimmed, the collision test against the board
 * of bits, and the order the injected `random` is drawn in (two draws per word to pick its start, one per word for the direction
 * of the spiral), so that the same random numbers give the same cloud.
 *
 * What d3-cloud draws its sprites on is a canvas: it fills each word's text on a 2048 x 2048 sheet and reads which pixels have any
 * ink (`getImageData`, the red channel of a red fill). The words land where the glyphs of the font that draws them leave room, so
 * the sheet is the host's canvas, as vega's (vega-canvas) is: a browser's `document.createElement('canvas')`. Where the host has
 * none (Node, jsdom without a canvas package) vega has none either and cannot lay a cloud out; this engine then draws the words
 * into the coverage-only context of `raster.ts` (the one the `label` transform draws the marks it avoids into), where a word is
 * the box its advance width and font size make, measured by the engine's text metrics. The cloud is then deterministic and well
 * formed, and not the one a browser draws.
 *
 * Registered by `@aster/core/transforms`.
 */
import { AlphaCanvas } from './raster.js'
import { meterTick } from './limits.js'
import { createHostCanvas, estimateTextWidth, measureText, usingCanvasTextMetrics } from './text-metrics.js'
import { fieldOf } from './transform-agg.js'
import type { Row, TransformContext } from './transform.js'

type Rec = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

// --- the sheet ---------------------------------------------------------------------------------

/** The part of a canvas 2D context d3-cloud draws its sprites with. */
export interface CloudContext {
  fillStyle: unknown
  strokeStyle: unknown
  textAlign: string
  font: string
  lineWidth: number
  clearRect(x: number, y: number, w: number, h: number): void
  save(): void
  restore(): void
  translate(x: number, y: number): void
  rotate(angle: number): void
  fillText(text: string, x: number, y: number): void
  strokeText(text: string, x: number, y: number): void
  measureText(text: string): { width: number }
  getImageData(x: number, y: number, w: number, h: number): { data: ArrayLike<number> }
}

/** vega-canvas `canvas()`: a canvas to draw on. */
export interface CloudCanvas {
  width: number
  height: number
  getContext(kind: '2d'): CloudContext | null
}

/** The width of a word where the engine measures text (the host's provider, the browser's canvas) or, lacking both, vega's headless estimate. */
function advance(text: string, font: string): number {
  if (usingCanvasTextMetrics()) return measureText(text, font)
  return estimateTextWidth(text, Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 10))
}

/** A canvas that holds coverage only (see the file header): a word is a box. */
class HeadlessCanvas implements CloudCanvas {
  private w = 300
  private h = 150
  private inner: AlphaCanvas | null = null
  private readonly context = new HeadlessContext(() => this.surface())

  get width(): number { return this.w }
  set width(v: number) { this.w = v >>> 0; this.inner = null }
  get height(): number { return this.h }
  set height(v: number) { this.h = v >>> 0; this.inner = null }

  private surface(): AlphaCanvas {
    return this.inner ?? (this.inner = new AlphaCanvas(this.w, this.h))
  }

  getContext(): CloudContext { return this.context }
}

class HeadlessContext implements CloudContext {
  constructor(private readonly surface: () => AlphaCanvas) {}
  get fillStyle(): unknown { return this.surface().fillStyle }
  set fillStyle(v: unknown) { this.surface().fillStyle = v }
  get strokeStyle(): unknown { return this.surface().strokeStyle }
  set strokeStyle(v: unknown) { this.surface().strokeStyle = v }
  get textAlign(): string { return this.surface().textAlign }
  set textAlign(v: string) { this.surface().textAlign = v }
  get font(): string { return this.surface().font }
  set font(v: string) { this.surface().font = v }
  get lineWidth(): number { return this.surface().lineWidth }
  set lineWidth(v: number) { this.surface().lineWidth = v }

  clearRect(x: number, y: number, w: number, h: number): void {
    const s = this.surface()
    const x0 = Math.max(0, Math.floor(x)), x1 = Math.min(s.width, Math.ceil(x + w))
    const y0 = Math.max(0, Math.floor(y)), y1 = Math.min(s.height, Math.ceil(y + h))
    for (let row = y0; row < y1; row++) s.alpha.fill(0, row * s.width + x0, row * s.width + x1)
  }
  save(): void { this.surface().save() }
  restore(): void { this.surface().restore() }
  translate(x: number, y: number): void { this.surface().translate(x, y) }
  rotate(angle: number): void { this.surface().rotate(angle) }
  measureText(text: string): { width: number } { return { width: advance(text, this.font) } }

  /** The box of a word: `pad` more on every side for a stroke. */
  private box(text: string, x: number, y: number, pad: number): void {
    const s = this.surface()
    const size = Number(/(\d+(?:\.\d+)?)px/.exec(this.font)?.[1] ?? 10)
    const w = advance(text, this.font)
    const left = this.textAlign === 'center' ? x - w / 2 : this.textAlign === 'right' || this.textAlign === 'end' ? x - w : x
    s.beginPath()
    s.rect(left - pad, y - size - pad, w + 2 * pad, size + 2 * pad)
    s.fill()
  }
  fillText(text: string, x: number, y: number): void {
    if (text !== '') this.box(String(text), x, y, 0)
  }
  strokeText(text: string, x: number, y: number): void {
    if (text !== '') this.box(String(text), x, y, this.lineWidth / 2)
  }

  getImageData(x: number, y: number, w: number, h: number): { data: ArrayLike<number> } {
    const s = this.surface()
    const data = new Uint8ClampedArray(w * h * 4)
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const a = s.alpha[(y + j) * s.width + x + i]!
        if (a) {
          const k = (j * w + i) * 4
          data[k] = 255
          data[k + 3] = a
        }
      }
    }
    return { data }
  }
}

/** vega-canvas `canvas()`. */
function newCanvas(): CloudCanvas {
  return createHostCanvas() ?? new HeadlessCanvas()
}

// --- d3-cloud ------------------------------------------------------------------------------------

const cloudRadians = Math.PI / 180
const cw = (1 << 11) >> 5
const ch = 1 << 11

type Spiral = (size: [number, number]) => (t: number) => [number, number] | undefined

function archimedeanSpiral(size: [number, number]): (t: number) => [number, number] {
  const e = size[0] / size[1]
  return (t) => [e * (t *= 0.1) * Math.cos(t), t * Math.sin(t)]
}

function rectangularSpiral(size: [number, number]): (t: number) => [number, number] {
  const dy = 4
  const dx = (dy * size[0]) / size[1]
  let x = 0
  let y = 0
  return (t) => {
    const sign = t < 0 ? -1 : 1
    // See triangular numbers: T_n = n * (n + 1) / 2.
    switch ((Math.sqrt(1 + 4 * sign * t) - sign) & 3) {
      case 0: x += dx; break
      case 1: y += dy; break
      case 2: x -= dx; break
      default: y -= dy; break
    }
    return [x, y]
  }
}

const spirals: Record<string, Spiral> = { archimedean: archimedeanSpiral, rectangular: rectangularSpiral }

export interface CloudWord {
  text: unknown
  font: unknown
  style: unknown
  weight: unknown
  rotate: number
  size: number
  padding: number
  xoff: number
  yoff: number
  x1: number
  y1: number
  x0: number
  y0: number
  x: number
  y: number
  hasText: boolean
  sprite: number[] | null
  width: number
  height: number
  datum: Rec
}

export interface CloudOptions {
  size: [number, number]
  text: (d: Rec) => unknown
  font: (d: Rec) => unknown
  fontStyle: (d: Rec) => unknown
  fontWeight: (d: Rec) => unknown
  fontSize: (d: Rec) => number
  rotate: (d: Rec) => number
  padding: (d: Rec) => number
  spiral: Spiral
  random: () => number
}

/** d3-cloud's `cloud.layout()` over `words` (the data). Returns the placed words, in the order they were placed. */
export function cloudLayout(words: Rec[], o: CloudOptions, makeCanvas: () => CloudCanvas = newCanvas): CloudWord[] {
  const { size, random } = o
  const contextAndRatio = getContext(makeCanvas())
  const board = zeroArray((size[0] >> 5) * size[1])
  let bounds: Array<{ x: number; y: number }> | null = null
  const n = words.length
  let i = -1
  const tags: CloudWord[] = []
  const data = words.map((d): CloudWord => ({
    text: o.text(d),
    font: o.font(d),
    style: o.fontStyle(d),
    weight: o.fontWeight(d),
    rotate: o.rotate(d),
    size: ~~(o.fontSize(d) + 1e-14),
    padding: o.padding(d),
    xoff: 0,
    yoff: 0,
    x1: 0,
    y1: 0,
    x0: 0,
    y0: 0,
    x: 0,
    y: 0,
    hasText: false,
    sprite: null,
    width: 0,
    height: 0,
    datum: d,
  })).sort((a, b) => b.size - a.size)

  while (++i < n) {
    const d = data[i]!
    d.x = (size[0] * (random() + 0.5)) >> 1
    d.y = (size[1] * (random() + 0.5)) >> 1
    cloudSprite(contextAndRatio, d, data, i)
    if (d.hasText && place(board, d, bounds)) {
      tags.push(d)
      if (bounds) cloudBounds(bounds, d)
      else bounds = [{ x: d.x + d.x0, y: d.y + d.y0 }, { x: d.x + d.x1, y: d.y + d.y1 }]
      // Temporary hack
      d.x -= size[0] >> 1
      d.y -= size[1] >> 1
    }
  }
  return tags

  function getContext(canvas: CloudCanvas): { context: CloudContext; ratio: number } {
    canvas.width = canvas.height = 1
    const ratio = Math.sqrt(canvas.getContext('2d')!.getImageData(0, 0, 1, 1).data.length >> 2)
    canvas.width = (cw << 5) / ratio
    canvas.height = ch / ratio

    const context = canvas.getContext('2d')!
    context.fillStyle = context.strokeStyle = 'red'
    context.textAlign = 'center'

    return { context, ratio }
  }

  function place(board: number[], tag: CloudWord, bounds: Array<{ x: number; y: number }> | null): boolean {
    const startX = tag.x
    const startY = tag.y
    const maxDelta = Math.hypot(size[0], size[1])
    const s = o.spiral(size)
    const dt = random() < 0.5 ? 1 : -1
    let t = -dt
    let dxdy: [number, number] | undefined

    while ((dxdy = s((t += dt)))) {
      meterTick('wordcloud')
      const dx = ~~dxdy[0]
      const dy = ~~dxdy[1]

      if (Math.min(Math.abs(dx), Math.abs(dy)) >= maxDelta) break

      tag.x = startX + dx
      tag.y = startY + dy

      if (tag.x + tag.x0 < 0 || tag.y + tag.y0 < 0 || tag.x + tag.x1 > size[0] || tag.y + tag.y1 > size[1]) continue
      // TODO only check for collisions within current bounds.
      if (!bounds || !cloudCollide(tag, board, size[0])) {
        if (!bounds || collideRects(tag, bounds)) {
          const sprite = tag.sprite!
          const w = tag.width >> 5
          const sw = size[0] >> 5
          const lx = tag.x - (w << 4)
          const sx = lx & 0x7f
          const msx = 32 - sx
          const h = tag.y1 - tag.y0
          let x = (tag.y + tag.y0) * sw + (lx >> 5)
          let last: number
          for (let j = 0; j < h; j++) {
            last = 0
            for (let i = 0; i <= w; i++) {
              board[x + i] = (board[x + i] as number | undefined ?? 0) | (last << msx) | (i < w ? (last = sprite[j * w + i]!) >>> sx : 0)
            }
            x += sw
          }
          tag.sprite = null
          return true
        }
      }
    }
    return false
  }
}

// Fetches a monochrome sprite bitmap for the specified text.
// Load in batches for speed.
function cloudSprite(contextAndRatio: { context: CloudContext; ratio: number }, d: CloudWord, data: CloudWord[], di: number): void {
  if (d.sprite) return
  const c = contextAndRatio.context
  const ratio = contextAndRatio.ratio

  c.clearRect(0, 0, (cw << 5) / ratio, ch / ratio)
  let x = 0
  let y = 0
  let maxh = 0
  const n = data.length
  let w: number, w32: number, h: number, i: number, j: number
  --di
  while (++di < n) {
    d = data[di]!
    c.save()
    c.font = d.style + ' ' + d.weight + ' ' + ~~((d.size + 1) / ratio) + 'px ' + d.font
    w = c.measureText(d.text + 'm').width * ratio
    h = d.size << 1
    if (d.rotate) {
      const sr = Math.sin(d.rotate * cloudRadians)
      const cr = Math.cos(d.rotate * cloudRadians)
      const wcr = w * cr
      const wsr = w * sr
      const hcr = h * cr
      const hsr = h * sr
      w = (Math.max(Math.abs(wcr + hsr), Math.abs(wcr - hsr)) + 0x1f) >> 5 << 5
      h = ~~Math.max(Math.abs(wsr + hcr), Math.abs(wsr - hcr))
    } else {
      w = (w + 0x1f) >> 5 << 5
    }
    if (h > maxh) maxh = h
    if (x + w >= (cw << 5)) {
      x = 0
      y += maxh
      maxh = 0
    }
    if (y + h >= ch) break
    c.translate((x + (w >> 1)) / ratio, (y + (h >> 1)) / ratio)
    if (d.rotate) c.rotate(d.rotate * cloudRadians)
    c.fillText(d.text as string, 0, 0)
    if (d.padding) {
      c.lineWidth = 2 * d.padding
      c.strokeText(d.text as string, 0, 0)
    }
    c.restore()
    d.width = w
    d.height = h
    d.xoff = x
    d.yoff = y
    d.x1 = w >> 1
    d.y1 = h >> 1
    d.x0 = -d.x1
    d.y0 = -d.y1
    d.hasText = true
    x += w
  }
  const pixels = c.getImageData(0, 0, (cw << 5) / ratio, ch / ratio).data
  const sprite: number[] = []
  while (--di >= 0) {
    d = data[di]!
    if (!d.hasText) continue
    w = d.width
    w32 = w >> 5
    h = d.y1 - d.y0
    // Zero the buffer
    for (i = 0; i < h * w32; i++) sprite[i] = 0
    x = d.xoff
    if (x == null) return
    y = d.yoff
    let seen = 0
    let seenRow = -1
    for (j = 0; j < h; j++) {
      for (i = 0; i < w; i++) {
        const k = w32 * j + (i >> 5)
        const m = pixels[((y + j) * (cw << 5) + (x + i)) << 2] ? 1 << (31 - (i % 32)) : 0
        sprite[k] = sprite[k]! | m
        seen |= m
      }
      if (seen) seenRow = j
      else {
        d.y0++
        h--
        j--
        y++
      }
    }
    d.y1 = d.y0 + seenRow
    d.sprite = sprite.slice(0, (d.y1 - d.y0) * w32)
  }
}

// Use mask-based collision detection.
function cloudCollide(tag: CloudWord, board: number[], sw: number): boolean {
  sw >>= 5
  const sprite = tag.sprite!
  const w = tag.width >> 5
  const lx = tag.x - (w << 4)
  const sx = lx & 0x7f
  const msx = 32 - sx
  const h = tag.y1 - tag.y0
  let x = (tag.y + tag.y0) * sw + (lx >> 5)
  let last: number
  for (let j = 0; j < h; j++) {
    last = 0
    for (let i = 0; i <= w; i++) {
      if (((last << msx) | (i < w ? (last = sprite[j * w + i]!) >>> sx : 0)) & board[x + i]!) return true
    }
    x += sw
  }
  return false
}

function cloudBounds(bounds: Array<{ x: number; y: number }>, d: CloudWord): void {
  const b0 = bounds[0]!
  const b1 = bounds[1]!
  if (d.x + d.x0 < b0.x) b0.x = d.x + d.x0
  if (d.y + d.y0 < b0.y) b0.y = d.y + d.y0
  if (d.x + d.x1 > b1.x) b1.x = d.x + d.x1
  if (d.y + d.y1 > b1.y) b1.y = d.y + d.y1
}

function collideRects(a: CloudWord, b: Array<{ x: number; y: number }>): boolean {
  return a.x + a.x1 > b[0]!.x && a.x + a.x0 < b[1]!.x && a.y + a.y1 > b[0]!.y && a.y + a.y0 < b[1]!.y
}

// TODO reuse arrays?
function zeroArray(n: number): number[] {
  const a: number[] = []
  let i = -1
  while (++i < n) a[i] = 0
  return a
}

// --- vega-wordcloud ------------------------------------------------------------------------------

const Output = ['x', 'y', 'font', 'fontSize', 'fontStyle', 'fontWeight', 'angle']

/** An `expr`-able parameter: a literal, `{field}` / a field name, or `{expr}` (a function of the tuple). */
function param(p: unknown, ctx: TransformContext, asField = false): unknown {
  if (typeof p === 'string' && asField) return fieldOf(p)
  if (p !== null && typeof p === 'object' && !Array.isArray(p)) {
    const o = p as { field?: unknown; expr?: unknown }
    if (typeof o.field === 'string') return fieldOf(o.field)
    if (typeof o.expr === 'string') {
      const f = ctx.runtime.expr(o.expr)
      return (d: Row) => f(d, ctx.signals)
    }
  }
  return p
}

/**
 * vega-util `extent(array, f)`, statement for statement: the first value that is not null or NaN starts the extent, null is skipped
 * after it and NaN fails every comparison. When no value qualifies the search runs one past the end, so `f` is called with
 * `undefined` (a field accessor throws there, which is how a cloud of words with no font size ends in vega).
 */
function extentBy(array: Rec[], f: (d: Rec) => unknown): [unknown, unknown] {
  let i = 0
  let n: number
  let v: unknown
  let min: unknown
  let max: unknown
  if (array && (n = array.length)) {
    for (v = f(array[i]!); i < n && (v == null || v !== v); v = f(array[++i]!));
    min = max = v
    for (; i < n; ++i) {
      v = f(array[i]!)
      if (v != null) {
        if ((v as number) < (min as number)) min = v
        if ((v as number) > (max as number)) max = v
      }
    }
  }
  return [min, max]
}

/**
 * d3-scale `scaleSqrt().domain(domain).range(range)`: the domain through the signed square root, normalised, then interpolated
 * (`a * (1 - t) + b * t`). A degenerate domain maps to the middle of the range; NaN maps to `undefined`.
 */
function sqrtScale(domain: [unknown, unknown], range: readonly number[]): (x: unknown) => number | undefined {
  const tr = (x: number): number => (x < 0 ? -Math.sqrt(-x) : Math.sqrt(x))
  const d = domain
  const a = tr(Number(d[0]))
  const b = tr(Number(d[1]))
  const reversed = b < a
  const lo = reversed ? b : a
  const hi = reversed ? a : b
  const span = hi - lo
  const norm = span ? (x: number): number => (x - lo) / span : (): number => (isNaN(span) ? NaN : 0.5)
  const r0 = reversed ? +range[1]! : +range[0]!
  const r1 = reversed ? +range[0]! : +range[1]!
  return (x) => {
    const v = +(x as number)
    if (isNaN(v)) return undefined
    const t = norm(tr(v))
    return r0 * (1 - t) + r1 * t
  }
}

/**
 * The `wordcloud` transform. The words are the tuples (the encoded items of the mark it is a transform of): the position, font
 * size and the other outputs are written onto them; a word that finds no room has no position (NaN) and a font size of 0.
 */
export function wordcloudRows(rows: Row[], t: Record<string, unknown>, ctx: TransformContext): Row[] {
  const size = t.size as [number, number] | undefined
  if (size && !(size[0] && size[1])) throw new Error('Wordcloud size dimensions must be non-zero.')

  const as = (t.as as string[] | undefined) ?? Output
  const data = (ctx.inPlace ? rows : rows.map((r) => ({ ...r }))) as Rec[]

  let fontSize: unknown = param(t.fontSize, ctx) || 14
  let range: readonly number[] | null | undefined
  if (typeof fontSize === 'function') {
    // (vega-parser leaves a parameter the spec does not give undefined: the default [10, 50] of the definition is documentation, and
    // a field-valued font size with no `fontSizeRange` is the size as it is)
    range = t.fontSizeRange as readonly number[] | null | undefined
  } else {
    const constant = fontSize
    fontSize = () => constant
  }
  if (range) {
    const fsize = fontSize as (d: Rec) => unknown
    const sizeScale = sqrtScale(extentBy(data, fsize), range)
    fontSize = (x: Rec) => sizeScale(fsize(x))
  }

  for (const d of data) {
    d[as[0]!] = NaN
    d[as[1]!] = NaN
    d[as[3]!] = 0
  }

  const functor = (p: unknown): ((d: Rec) => any) => (typeof p === 'function' ? (p as (d: Rec) => any) : () => p) // eslint-disable-line @typescript-eslint/no-explicit-any
  const spiralName = (t.spiral as string | undefined) || 'archimedean'
  const spiral = spirals[spiralName]
  if (spiral === undefined) throw new Error(`Wordcloud spiral "${spiralName}" is not archimedean or rectangular.`)
  const layoutSize: [number, number] = [+(size?.[0] ?? 500), +(size?.[1] ?? 500)]
  const random = ctx.runtime.random ?? Math.random

  const words = cloudLayout(data, {
    size: layoutSize,
    text: functor(param(t.text, ctx, true)),
    font: functor(param(t.font, ctx) || 'sans-serif'),
    fontStyle: functor(param(t.fontStyle, ctx) || 'normal'),
    fontWeight: functor(param(t.fontWeight, ctx) || 'normal'),
    fontSize: functor(fontSize),
    rotate: functor(param(t.rotate, ctx) || 0),
    padding: functor(param(t.padding, ctx) || 1),
    spiral,
    random,
  })

  const dx = layoutSize[0] >> 1
  const dy = layoutSize[1] >> 1
  for (const w of words) {
    const d = w.datum
    d[as[0]!] = w.x + dx
    d[as[1]!] = w.y + dy
    d[as[2]!] = w.font
    d[as[3]!] = w.size
    d[as[4]!] = w.style
    d[as[5]!] = w.weight
    d[as[6]!] = w.rotate
  }
  return data
}
