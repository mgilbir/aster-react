// @vitest-environment node
/**
 * A stroke whose pen is a pixel or less across is a hairline to a browser canvas (Skia: SkDrawTreatAsHairline): one pixel thick
 * along the axis the line runs less along, spread over the two pixels it straddles there, its alpha scaled by the pen's width, no
 * joins. A coverage-only context that strokes it as a polygon of the pen's own width inks one column where the browser inks two
 * (audit 2026-11-22, C208: 124 pixels the browser inks that the engine left empty, 356 the other way, over the recorded drawings).
 *
 * The first block is what Chromium 151 left in the alpha channel for these very drawings (recorded with
 * `page.evaluate` on a 12 x 12 canvas, black); the second holds the model that makes those numbers.
 */
import { describe, expect, it } from 'vitest'
import { AlphaCanvas } from './raster.js'
import { mulberry32 } from './scene-fuzz.testlib.js'

function line(width: number, pts: number[], cap = 'butt', size = 12): AlphaCanvas {
  const c = new AlphaCanvas(size, size)
  c.lineWidth = width
  c.lineCap = cap
  c.beginPath()
  c.moveTo(pts[0]!, pts[1]!)
  for (let i = 2; i < pts.length; i += 2) c.lineTo(pts[i]!, pts[i + 1]!)
  c.stroke()
  return c
}
const row = (c: AlphaCanvas, y: number): number[] => Array.from(c.alpha.slice(y * c.width, (y + 1) * c.width))

describe('a pen of a pixel or less is drawn as the browser draws a hairline', () => {
  it('a half pixel pen on a pixel row is the whole row at half alpha, and one row off it is split between two rows (recorded in Chromium)', () => {
    expect(row(line(0.5, [1, 5.5, 10, 5.5]), 5)).toEqual([0, 127, 127, 127, 127, 127, 127, 127, 127, 127, 0, 0])
    const off = line(0.5, [1, 5.25, 10, 5.25])
    expect(row(off, 4).slice(1, 10)).toEqual(Array(9).fill(31))
    expect(row(off, 5).slice(1, 10)).toEqual(Array(9).fill(95))
    // (a pen of exactly one pixel is a hairline too, at full alpha: the split of a line a quarter of a pixel off the row)
    const full = line(1, [1, 5.25, 10, 5.25])
    expect(row(full, 4).slice(1, 10)).toEqual(Array(9).fill(63))
    expect(row(full, 5).slice(1, 10)).toEqual(Array(9).fill(192))
  })

  it('a slanted line takes two pixels in each column it crosses, and the pixels that carry ink are the browser\'s (recorded in Chromium)', () => {
    const want = [
      '0 21 0 0 0 0 0 0 0 0 0 0', '0 106 63 0 0 0 0 0 0 0 0 0', '0 0 63 106 21 0 0 0 0 0 0 0', '0 0 0 21 106 63 0 0 0 0 0 0',
      '0 0 0 0 0 63 106 21 0 0 0 0', '0 0 0 0 0 0 21 106 63 0 0 0', '0 0 0 0 0 0 0 0 63 106 0 0', '0 0 0 0 0 0 0 0 0 21 0 0',
    ].map((r) => r.split(' ').map(Number))
    const c = line(0.5, [1, 1, 10, 7])
    for (let y = 0; y < 12; y++) {
      const got = row(c, y)
      const exp = want[y] ?? Array(12).fill(0)
      // the ink is the same pixels; the values are one alpha step apart at most (a rounding of the browser's blend)
      expect(got.map((v) => v !== 0), `row ${y}`).toEqual(exp.map((v) => v !== 0))
      got.forEach((v, x) => expect(Math.abs(v - exp[x]!), `(${x},${y})`).toBeLessThanOrEqual(1))
    }
  })

  it('a square cap goes half a pixel past the end (recorded in Chromium: 63 at the ends of a 127 row)', () => {
    expect(row(line(0.5, [3, 5.5, 8, 5.5], 'square'), 5)).toEqual([0, 0, 63, 127, 127, 127, 127, 127, 63, 0, 0, 0])
  })

  it('a pen over a pixel is a stroke of that width, not a hairline (no jump in what is inked at the boundary)', () => {
    const thin = line(1, [1, 5.5, 10, 5.5])
    const wide = line(1.5, [1, 5.5, 10, 5.5])
    expect(row(thin, 5)[4]).toBe(255)
    expect(row(wide, 4)[4]).toBeGreaterThan(0) // 1.5 wide on a row centre: a quarter pixel either side
    expect(row(wide, 5)[4]).toBe(255)
  })
})

describe('the model: one pixel thick across the axis the line runs along, alpha the pen\'s width', () => {
  it('the alpha of every column a mostly horizontal line crosses sums to the pen\'s width (generated lines, widths and offsets)', () => {
    const r = mulberry32(208)
    for (let i = 0; i < 80; i++) {
      const width = 0.1 + r() * 0.9
      const x0 = 3 + r() * 10
      const y0 = 5 + r() * 20
      const x1 = x0 + 8 + r() * 12
      const y1 = y0 + (r() - 0.5) * 12 // (never steeper than 45 degrees: mostly horizontal)
      const c = line(width, [x0, y0, x1, y1], 'butt', 40)
      // the columns well inside the segment: both pixels of the pair are in the column, so the column's alpha is the pen's width
      for (let x = Math.ceil(x0) + 1; x < Math.floor(x1) - 1; x++) {
        let sum = 0
        for (let y = 0; y < 40; y++) sum += c.alpha[y * 40 + x]!
        expect(Math.abs(sum - 255 * width), `line ${i} width ${width.toFixed(2)} column ${x}`).toBeLessThanOrEqual(3)
      }
    }
  })

  it('a steep line does the same down its rows, and a line and its reverse are the same pixels', () => {
    const r = mulberry32(2080)
    for (let i = 0; i < 60; i++) {
      const width = 0.1 + r() * 0.9
      const p = [3 + r() * 30, 3 + r() * 30, 3 + r() * 30, 3 + r() * 30]
      const a = line(width, p, 'butt', 40)
      const b = line(width, [p[2]!, p[3]!, p[0]!, p[1]!], 'butt', 40)
      expect(Array.from(b.alpha), `line ${i}`).toEqual(Array.from(a.alpha))
      if (Math.abs(p[3]! - p[1]!) > Math.abs(p[2]! - p[0]!)) {
        const [top, bottom] = p[1]! < p[3]! ? [p[1]!, p[3]!] : [p[3]!, p[1]!]
        for (let y = Math.ceil(top) + 1; y < Math.floor(bottom) - 1; y++) {
          let sum = 0
          for (let x = 0; x < 40; x++) sum += a.alpha[y * 40 + x]!
          expect(Math.abs(sum - 255 * width), `line ${i} row ${y}`).toBeLessThanOrEqual(3)
        }
      }
    }
  })

  it('overlapping segments add their alphas, as a canvas draws them one by one (a line out and back)', () => {
    const once = line(0.5, [1, 5.5, 10, 5.5])
    const twice = line(0.5, [1, 5.5, 10, 5.5, 1, 5.5])
    expect(row(once, 5)[4]).toBe(127)
    expect(row(twice, 5)[4]).toBeGreaterThan(180)
  })

  it('a pen with a scale that makes it wider than a pixel is not a hairline, and one scaled down to under a pixel is', () => {
    const c = new AlphaCanvas(12, 12)
    c.scale(0.5, 0.5)
    c.lineWidth = 1.5 // 0.75 pixels on the canvas
    c.beginPath()
    c.moveTo(2, 11)
    c.lineTo(20, 11)
    c.stroke()
    expect(row(c, 5)[4]).toBe(191) // 0.75 of a pixel row's centre line, at 255 * 0.75
    const w = new AlphaCanvas(12, 12)
    w.scale(2, 2)
    w.lineWidth = 0.75 // 1.5 pixels
    w.beginPath()
    w.moveTo(1, 2.5)
    w.lineTo(5, 2.5)
    w.stroke()
    expect(row(w, 4)[4]).toBeGreaterThan(0)
    expect(row(w, 5)[4]).toBeGreaterThan(0)
  })
})
