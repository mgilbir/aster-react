// @vitest-environment node
/**
 * The label rasterizer's strokes where making them exactly would cost more than any canvas (C16, C94): what is drawn into the
 * canvas must be what the exact stroke covers there, and the work must not grow with the stroke's size.
 */
import { describe, expect, it } from 'vitest'
import { AlphaCanvas } from './raster.js'

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
    // 1e6 px of line, a 4 px period: 250 000 dashes, of which the canvas sees 25
    const c = new AlphaCanvas(100, 20)
    c.lineWidth = 2
    c.setLineDash([2, 2])
    c.beginPath()
    c.moveTo(-1e6 + 0.5, 10)
    c.lineTo(100, 10)
    c.stroke()
    const short = new AlphaCanvas(100, 20)
    short.lineWidth = 2
    short.setLineDash([2, 2])
    // the same phase at x = 0: the line before the canvas is a whole number of periods (1e6 / 4)
    short.beginPath()
    short.moveTo(0.5, 10)
    short.lineTo(100, 10)
    short.stroke()
    expect(Array.from(c.alpha)).toEqual(Array.from(short.alpha))
  })
})
