/**
 * The `wordcloud` transform: words packed into a rectangle, largest first, each as near as it can get to a random start point.
 *
 * The layout is Jason Davies' d3-cloud (after Jonathan Feinberg's "Wordle"), the one vega-wordcloud runs, and its placements are
 * what the transform is pinned to: the same words, the same `random` stream and the same host canvas give the same cloud, which is
 * checked word for word against vega in Chromium (conformance/src/wordcloud-vs-vega.test.ts). What that fixes is shared with it,
 * and only that:
 *
 * - the order the stream is drawn in: two numbers for a word's start (x, then y), then one for the direction of its spiral, in
 *   order of font size (largest first, ties in data order); a word with no sprite draws no direction. The accessors of a word are
 *   called in a fixed order too (an expression may draw from the stream);
 * - the spiral, from the start, in whole pixels, until it leaves the rectangle;
 * - the sprite of a word: the ink of `text + 'm'` drawn in a cell as wide as that rounds up to 32 pixels (turned, the bounding box
 *   of it) and twice its size high, on a sheet that holds many words, so that the outline of one reaches into the cell of the next;
 *   the rows above its first inked row are dropped, and so is its last row;
 * - collision, the ink of a word against the ink laid so far, once the word lies within the extent of what has been laid.
 *
 * Everything else is this engine's: the sheet is planned before anything is drawn on it and only as high as its words, and read
 * back once; the ink goes straight into rows of 32-bit words (`Word.rows`); the board is one typed array; the extent is four
 * numbers; spirals step a shared point; a word is a plain object. The sheet is the host's canvas, as in vega, so a browser lays out
 * the cloud vega does. Where there is none (Node, jsdom without a canvas package) vega cannot lay a cloud out; this engine then
 * draws each word as the box its advance width and font size make, on the coverage-only canvas of `raster.ts` (the one `label`
 * avoids marks with), measured by the engine's text metrics. That cloud is deterministic and well formed, and not the one a
 * browser draws.
 *
 * Registered by `@aster/core/transforms`.
 */
/*
Copyright (c) 2013, Jason Davies.
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

  * Redistributions of source code must retain the above copyright notice, this
    list of conditions and the following disclaimer.

  * Redistributions in binary form must reproduce the above copyright notice,
    this list of conditions and the following disclaimer in the documentation
    and/or other materials provided with the distribution.

  * The name Jason Davies may not be used to endorse or promote products
    derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL JASON DAVIES BE LIABLE FOR ANY DIRECT, INDIRECT,
INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF
LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE
OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF
ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
*/

import { AlphaCanvas } from './raster.js'
import { meterTick } from './limits.js'
import { createHostCanvas, estimateTextWidth, measureText, usingCanvasTextMetrics } from './text-metrics.js'
import { fieldOf } from './transform-agg.js'
import type { Row, TransformContext } from './transform.js'

type Rec = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

// --- where a word's ink comes from ---------------------------------------------------------------

/** A word and the place it takes: its inputs, its box once it has a sprite, its position once it has one. */
interface Word {
  datum: Rec
  text: unknown
  font: unknown
  style: unknown
  weight: unknown
  rotate: number
  size: number
  padding: number
  /** The position of the word's centre while it is placed, and the start of its spiral before. */
  x: number
  y: number
  /** The box of the sprite, from the centre: x0 = -x1 is the width / 2, y0 the first inked row, y1 the last. */
  x0: number
  y0: number
  x1: number
  y1: number
  /** The ink, `rows` rows of `w32` 32-bit words, the leftmost pixel being the high bit. */
  rows: Int32Array
  w32: number
  /** Whether the word has a sprite (READY), is waiting for one (PENDING) or the sheet has no room for it (FAILED). */
  state: number
}

const PENDING = 0, READY = 1, FAILED = 2

/** Pixels of a sheet: `stride` entries to a pixel, SHEET pixels to a row; a pixel has ink when its first entry is not 0. */
interface Ink { data: ArrayLike<number>; stride: number }

/** Where a word is drawn on the sheet: a w x h cell at (x, y), the word in the middle of it. */
interface Cell { d: Word; text: string; font: string; px: number; x: number; y: number; w: number; h: number }

interface Surface {
  /** The advance of `text` set in `font` (`px` pixels). */
  measure(text: string, font: string, px: number): number
  /** A sheet SHEET pixels wide and `height` high with the cells drawn on it, each word turned by its `rotate`, its outline `padding` wide. */
  paint(cells: Cell[], height: number): Ink
}

/** The width of a word where the engine measures text (the host's provider, the browser's canvas) or, lacking both, vega's headless estimate. */
const advance = (text: string, font: string, px: number): number => (usingCanvasTextMetrics() ? measureText(text, font) : estimateTextWidth(text, px))

const RADIANS = Math.PI / 180

/** The host's canvas, as wide as the sheet and as high as the words on it. */
function hostSurface(canvas: HTMLCanvasElement): Surface {
  const ctx = canvas.getContext('2d')!
  canvas.width = SHEET
  return {
    measure: (text, font) => { ctx.font = font; return ctx.measureText(text).width },
    paint(cells, height) {
      canvas.height = height // (which also clears it, and resets the state set below)
      ctx.fillStyle = ctx.strokeStyle = 'red'
      ctx.textAlign = 'center'
      for (const { d, text, font, x, y, w, h } of cells) {
        ctx.save()
        ctx.font = font
        ctx.translate(x + (w >> 1), y + (h >> 1))
        if (d.rotate) ctx.rotate(d.rotate * RADIANS)
        ctx.fillText(text, 0, 0)
        if (d.padding) {
          ctx.lineWidth = 2 * d.padding
          ctx.strokeText(text, 0, 0)
        }
        ctx.restore()
      }
      // (the red channel carries the ink)
      return { data: ctx.getImageData(0, 0, SHEET, height).data, stride: 4 }
    },
  }
}

/** No canvas: a word is the box its advance width and size make (its outline, `padding` more on every side). */
const boxSurface: Surface = {
  measure: advance,
  paint(cells, height) {
    const c = new AlphaCanvas(SHEET, height)
    for (const { d, text, font, px, x, y, w, h } of cells) {
      if (text === '') continue
      c.save()
      c.translate(x + (w >> 1), y + (h >> 1))
      if (d.rotate) c.rotate(d.rotate * RADIANS)
      const tw = advance(text, font, px)
      const box = (pad: number): void => {
        c.beginPath()
        c.rect(-tw / 2 - pad, -px - pad, tw + 2 * pad, px + 2 * pad)
        c.fill()
      }
      box(0)
      if (d.padding) box(d.padding)
      c.restore()
    }
    return { data: c.alpha, stride: 1 }
  },
}

/** The sheet the words are drawn on and read back from, as wide and as high as vega's: where a word lands depends on the ink around it. */
const SHEET = 2048

/** The size of the cell a word is drawn in. */
function cellOf(d: Word, surface: Surface): Cell {
  const px = ~~(d.size + 1)
  const font = d.style + ' ' + d.weight + ' ' + px + 'px ' + d.font
  const text = String(d.text)
  let w = surface.measure(text + 'm', font, px)
  let h = d.size << 1
  if (d.rotate) {
    const sr = Math.sin(d.rotate * RADIANS)
    const cr = Math.cos(d.rotate * RADIANS)
    const wcr = w * cr, wsr = w * sr, hcr = h * cr, hsr = h * sr
    w = (Math.max(Math.abs(wcr + hsr), Math.abs(wcr - hsr)) + 0x1f) >> 5 << 5
    h = ~~Math.max(Math.abs(wsr + hcr), Math.abs(wsr - hcr))
  } else {
    w = (w + 0x1f) >> 5 << 5
  }
  return { d, text, font, px, x: 0, y: 0, w, h }
}

/**
 * Cut the sprites of the words from `start` on: they are set in rows on one sheet, left to right, until the next does not fit, and
 * drawn together, so the outline of a word that reaches into the cell of another is ink there too (the layout is pinned to this).
 * A word is sprited when its turn comes, and the first of a sheet that does not fit has no sprite (`failed`).
 */
function cutSprites(words: Word[], start: number, surface: Surface): void {
  const cells: Cell[] = []
  let x = 0, y = 0, rowHeight = 0
  for (let k = start; k < words.length; k++) {
    const cell = cellOf(words[k]!, surface)
    if (cell.h > rowHeight) rowHeight = cell.h
    if (x + cell.w >= SHEET) { x = 0; y += rowHeight; rowHeight = 0 }
    if (y + cell.h >= SHEET) break
    cell.x = x
    cell.y = y
    cells.push(cell)
    x += cell.w
  }
  if (!cells.length) { words[start]!.state = FAILED; return }
  const height = cells.reduce((m, c) => Math.max(m, c.y + c.h + 1), 1)
  const { data, stride } = surface.paint(cells, Math.min(height, SHEET))
  for (const { d, x, y, w, h } of cells) {
    // the box: the rows above the first inked one are dropped, and the last row of the cell (an empty word keeps none)
    const hh = h >> 1
    const rows = Math.max(hh, 0) * 2
    const at = (i: number, j: number): number => data[((y + j) * SHEET + x + i) * stride] ?? 0
    let top = 0
    scan: for (; top < rows; top++) for (let i = 0; i < w; i++) if (at(i, top)) break scan
    d.x1 = w >> 1
    d.x0 = -d.x1
    d.y0 = top - hh
    d.y1 = rows - hh - 1
    d.w32 = w >> 5
    d.rows = new Int32Array(Math.max(rows - 1 - top, 0) * d.w32)
    for (let j = 0, n = d.rows.length / (d.w32 || 1); j < n; j++) {
      for (let i = 0; i < w; i++) if (at(i, top + j)) d.rows[j * d.w32 + (i >> 5)]! |= 1 << (31 - (i & 31))
    }
    d.state = READY
  }
}

// --- the layout ----------------------------------------------------------------------------------

/** Where the spiral is: `step(t)` moves `at` to its t-th point (the rectangular one is incremental: t must come in sequence). */
interface Point { x: number; y: number }
type Spiral = (size: [number, number], at: Point) => (t: number) => void

const spirals: Record<string, Spiral> = {
  archimedean: (size, at) => {
    const e = size[0] / size[1]
    return (t) => { t *= 0.1; at.x = e * t * Math.cos(t); at.y = t * Math.sin(t) }
  },
  rectangular: (size, at) => {
    const dy = 4
    const dx = (dy * size[0]) / size[1]
    at.x = at.y = 0
    return (t) => {
      const sign = t < 0 ? -1 : 1
      // the corner of the square spiral that the triangular numbers T_n = n (n + 1) / 2 mark
      switch ((Math.sqrt(1 + 4 * sign * t) - sign) & 3) {
        case 0: at.x += dx; break
        case 1: at.y += dy; break
        case 2: at.x -= dx; break
        default: at.y -= dy; break
      }
    }
  },
}

/**
 * The ink of `d`, centred at (x, y), against the board (a bit per pixel, `sw` 32-bit words to a row). When `stamp` is set the ink
 * is laid on the board, else the answer is whether it meets ink there. A row of the sprite is shifted right by `x0 mod 32` bits
 * into the cells it overlaps, the bits shifted out of a cell going into the next; for a shift of 0 that carry is not shifted at all
 * (32 is 0 as a shift count), so the cell takes the whole of the one before: the layout is pinned to this.
 */
function overlay(board: Int32Array, sw: number, d: Word, stamp: boolean): boolean {
  const { rows, w32 } = d
  const lx = d.x + d.x0
  const shift = lx & 31
  const back = 32 - shift
  const height = w32 ? rows.length / w32 : 0
  let cell = (d.y + d.y0) * sw + (lx >> 5)
  for (let j = 0; j < height; j++, cell += sw) {
    let last = 0
    for (let i = 0; i <= w32; i++) {
      const bits = (last << back) | (i < w32 ? (last = rows[j * w32 + i]!) >>> shift : 0)
      if (stamp) board[cell + i] = (board[cell + i] ?? 0) | bits
      else if (bits & board[cell + i]!) return true
    }
  }
  return false
}

interface LayoutOptions {
  size: [number, number]
  spiral: Spiral
  random: () => number
  text: (d: Rec) => unknown
  font: (d: Rec) => unknown
  fontStyle: (d: Rec) => unknown
  fontWeight: (d: Rec) => unknown
  fontSize: (d: Rec) => number
  rotate: (d: Rec) => number
  padding: (d: Rec) => number
}

/** Place the words of `data`, largest first; returns the ones that found room. */
function layout(data: Rec[], o: LayoutOptions): Word[] {
  const { size, random } = o
  const [width, height] = size
  const canvas = createHostCanvas()
  const surface = canvas ? hostSurface(canvas) : boxSurface
  const sw = width >> 5
  // (one cell past the end: a sprite at the far corner carries into it)
  const board = new Int32Array(Math.max(0, Math.ceil(sw * height)) + 1)
  const maxDelta = Math.hypot(width, height)
  const at: Point = { x: 0, y: 0 }
  const placed: Word[] = []
  // the extent of what is placed: a word must touch it to be tried against the board
  let left = 0, top = 0, right = 0, bottom = 0

  // (the order the accessors are called in is observable: an expression may draw from the stream)
  const words = data.map((datum): Word => ({
    datum, text: o.text(datum), font: o.font(datum), style: o.fontStyle(datum), weight: o.fontWeight(datum),
    rotate: o.rotate(datum), size: ~~(o.fontSize(datum) + 1e-14), padding: o.padding(datum),
    x: 0, y: 0, x0: 0, y0: 0, x1: 0, y1: 0, rows: new Int32Array(0), w32: 0, state: PENDING,
  })).sort((a, b) => b.size - a.size)

  for (let i = 0; i < words.length; i++) {
    const d = words[i]!
    d.x = (width * (random() + 0.5)) >> 1
    d.y = (height * (random() + 0.5)) >> 1
    if (d.state === PENDING) cutSprites(words, i, surface)
    if (d.state === FAILED) continue

    const startX = d.x
    const startY = d.y
    const step = o.spiral(size, at)
    const dt = random() < 0.5 ? 1 : -1
    let found = false
    for (let t = 0; ; t += dt) {
      meterTick('wordcloud')
      step(t)
      const dx = ~~at.x
      const dy = ~~at.y
      if (Math.min(Math.abs(dx), Math.abs(dy)) >= maxDelta) break
      d.x = startX + dx
      d.y = startY + dy
      if (d.x + d.x0 < 0 || d.y + d.y0 < 0 || d.x + d.x1 > width || d.y + d.y1 > height) continue
      if (placed.length && !(d.x + d.x1 > left && d.x + d.x0 < right && d.y + d.y1 > top && d.y + d.y0 < bottom)) continue
      if (placed.length && overlay(board, sw, d, false)) continue
      found = true
      break
    }
    if (!found) continue
    overlay(board, sw, d, true)
    if (placed.length) {
      left = Math.min(left, d.x + d.x0); top = Math.min(top, d.y + d.y0)
      right = Math.max(right, d.x + d.x1); bottom = Math.max(bottom, d.y + d.y1)
    } else {
      left = d.x + d.x0; top = d.y + d.y0; right = d.x + d.x1; bottom = d.y + d.y1
    }
    placed.push(d)
  }
  return placed
}

// --- the transform -------------------------------------------------------------------------------

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
 * vega-util `extent(array, f)`: the first value that is not null or NaN starts the extent, null is skipped
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

  const words = layout(data, {
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

  for (const w of words) {
    const d = w.datum
    d[as[0]!] = w.x
    d[as[1]!] = w.y
    d[as[2]!] = w.font
    d[as[3]!] = w.size
    d[as[4]!] = w.style
    d[as[5]!] = w.weight
    d[as[6]!] = w.rotate
  }
  return data
}
