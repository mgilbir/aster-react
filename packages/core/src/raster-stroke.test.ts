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
