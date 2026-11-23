// @vitest-environment node
/**
 * The pen's join (`lineJoin`, `miterLimit`) belongs to the vertices of a PATH, between its segments and curves. A curve is
 * flattened into a run of chords before it is stroked, and the vertices the flattening makes are not vertices of the path: a
 * canvas strokes a curve as its smooth offset whatever `lineJoin` says. Mitering them grew a spike at every tight turn of a stroked
 * curve (audit 2026-11-22, C482: a cubic with a sharp turn inked two rows beyond the browser's outline, and `label` kept
 * a label off pixels the mark never covered).
 */
import { describe, expect, it } from 'vitest'
import { AlphaCanvas } from './raster.js'
import { mulberry32 } from './scene-fuzz.testlib.js'

type Draw = (c: AlphaCanvas) => void

function stroked(draw: Draw, join: string, opts: { w: number; h: number; width: number; cap: string; miterLimit?: number }): Uint8Array {
  const c = new AlphaCanvas(opts.w, opts.h)
  c.lineWidth = opts.width
  c.lineCap = opts.cap
  c.lineJoin = join
  c.miterLimit = opts.miterLimit ?? 4
  c.beginPath()
  draw(c)
  c.stroke()
  return c.alpha
}

const JOINS = ['miter', 'round', 'bevel']

describe('a stroked curve does not depend on lineJoin', () => {
  it('cubic, quadratic and a curve after a straight segment: the same pixels under every join, at every width and cap', () => {
    const r = mulberry32(482)
    let tight = 0
    for (let i = 0; i < 60; i++) {
      const p = Array.from({ length: 8 }, () => 2 + r() * 60)
      const kind = i % 3
      const draw: Draw = (c) => {
        c.moveTo(p[0]!, p[1]!)
        // (a curve alone, then a straight segment into it would be a real corner: kind 2 starts the curve where the line ends,
        // tangent to nothing, and the corner at that point is the path's own -- so only the curve's interior is compared there)
        if (kind === 0) c.bezierCurveTo(p[2]!, p[3]!, p[4]!, p[5]!, p[6]!, p[7]!)
        else if (kind === 1) c.quadraticCurveTo(p[2]!, p[3]!, p[4]!, p[5]!)
        else c.bezierCurveTo(p[6]!, p[1]!, p[2]!, p[7]!, p[4]!, p[5]!)
      }
      const width = 1 + r() * 5
      for (const cap of ['butt', 'round', 'square']) {
        const opts = { w: 64, h: 64, width, cap }
        const [miter, ...others] = JOINS.map((j) => stroked(draw, j, opts))
        for (const o of others) expect(Array.from(o), `curve ${i} kind ${kind} width ${width.toFixed(2)} ${cap}`).toEqual(Array.from(miter!))
      }
      if (kind === 0) tight++
    }
    expect(tight).toBeGreaterThan(15)
  })

  it('the curve the audit recorded (drawing 31 of raster-shapes: a cubic with a sharp turn): no ink beyond the round outline', () => {
    const draw: Draw = (c) => { c.moveTo(6.125, 39.75); c.bezierCurveTo(9.875, 4.125, 2.375, 68.25, 25.75, 39.875) }
    const opts = { w: 32, h: 75, width: 2.75, cap: 'round', miterLimit: 4 }
    const miter = stroked(draw, 'miter', opts)
    const round = stroked(draw, 'round', opts)
    expect(Array.from(miter)).toEqual(Array.from(round))
    // Chromium's first inked row is 27; the miter spike put ink on rows 25 and 26
    const firstRow = (a: Uint8Array): number => { for (let i = 0; i < a.length; i++) if (a[i]) return Math.floor(i / opts.w); return -1 }
    expect(firstRow(miter)).toBeGreaterThanOrEqual(27)
  })

  it('control: at a corner of the path itself the join still decides the pixels (miter, bevel and round differ)', () => {
    const draw: Draw = (c) => { c.moveTo(4, 30); c.lineTo(20, 8); c.lineTo(36, 30) }
    const opts = { w: 40, h: 36, width: 6, cap: 'butt', miterLimit: 10 }
    const [miter, round, bevel] = JOINS.map((j) => Array.from(stroked(draw, j, opts)))
    expect(miter).not.toEqual(bevel)
    expect(round).not.toEqual(bevel)
    expect(miter).not.toEqual(round)
    // a curve ending in a line: the corner where they meet is the path's own
    const mixed: Draw = (c) => { c.moveTo(4, 30); c.quadraticCurveTo(10, 4, 20, 8); c.lineTo(36, 30) }
    const [m2, , b2] = JOINS.map((j) => Array.from(stroked(mixed, j, opts)))
    expect(m2).not.toEqual(b2)
  })
})

// ---------------------------------------------------------------------------------------------------------------
/**
 * The label rasterizer's strokes where making them exactly would cost more than any canvas (C16, C94): what is drawn into the
 * canvas must be what the exact stroke covers there, and the work must not grow with the stroke's size.
 */

const covered = (c: AlphaCanvas, x: number, y: number): boolean => c.alpha[y * c.width + x]! > 0

describe('an immense round cap is made as far as the canvas sees it (C94)', () => {
  it('the edge of a disk of radius 1e9 crossing the canvas is where the circle is (generated positions)', () => {
    const r = 1e9
    // the centre is far to the left and half a step of a 4096-point disk above the canvas, so that a coarse disk's chord, not
    // one of its corners, crosses the canvas: it would miss the circle there by about r (1 - cos(pi / 4096)), 294 pixels
    const cy = 50 - r * Math.sin(Math.PI / 4096)
    for (const edge of [20.5, 60.25, 133.75, 180.5]) {
      const cx = edge - Math.sqrt(r * r - (50 - cy) ** 2)
      const c = new AlphaCanvas(200, 100)
      c.lineWidth = 2 * r
      c.lineCap = 'round'
      c.beginPath()
      // a zero-length line: its round cap is one disk
      c.moveTo(cx, cy)
      c.lineTo(cx, cy)
      c.stroke()
      for (let y = 0; y < 100; y += 7) {
        const x = cx + Math.sqrt(r * r - (y + 0.5 - cy) ** 2)
        expect(covered(c, Math.floor(x) - 2, y), `edge ${edge}, row ${y}: circle at ${x}`).toBe(true)
        expect(covered(c, Math.ceil(x) + 1, y), `edge ${edge}, row ${y}: circle at ${x}`).toBe(false)
      }
    }
  })
})

describe('a dash pattern of very many dashes (C16)', () => {
  it('a contour of more than a million dashes is stroked undashed, as Skia gives up', () => {
    const c = new AlphaCanvas(100, 20)
    c.lineWidth = 4
    c.setLineDash([1e-7])
    c.beginPath()
    c.moveTo(0, 10)
    c.lineTo(100, 10)
    c.stroke()
    for (let x = 0; x < 100; x++) expect(covered(c, x, 10), `x ${x}`).toBe(true)
  })

  it('a long line of a coarse dash keeps its phase into the canvas', () => {
    // 1e5 px of line, a 4 px period: 25 000 dashes, of which the canvas sees 25
    const c = new AlphaCanvas(100, 20)
    c.lineWidth = 2
    c.setLineDash([2, 2])
    c.beginPath()
    c.moveTo(-1e5 + 0.5, 10)
    c.lineTo(100, 10)
    c.stroke()
    const short = new AlphaCanvas(100, 20)
    short.lineWidth = 2
    short.setLineDash([2, 2])
    // the same phase at x = 0: the line before the canvas is a whole number of periods (1e5 / 4)
    short.beginPath()
    short.moveTo(0.5, 10)
    short.lineTo(100, 10)
    short.stroke()
    expect(Array.from(c.alpha)).toEqual(Array.from(short.alpha))
  })
})
