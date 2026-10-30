import { describe, expect, it } from 'vitest'
import { Bounds } from './bounds.js'
import { BoundsPen } from './bounds-pen.js'

function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296)
}

const box = (b: Bounds): number[] => [b.x1, b.y1, b.x2, b.y2]

describe('BoundsPen', () => {
  it('a cubic is measured where it turns, in x and in y, on both roots', () => {
    const r = lcg(7)
    for (let n = 0; n < 300; n++) {
      const p = Array.from({ length: 8 }, () => r() * 200 - 100) as [number, number, number, number, number, number, number, number]
      const b = new Bounds()
      const pen = new BoundsPen(b)
      pen.moveTo(p[0], p[1])
      pen.bezierCurveTo(p[2], p[3], p[4], p[5], p[6], p[7])
      // dense sampling of the same curve
      let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity
      for (let i = 0; i <= 20000; i++) {
        const t = i / 20000, s = 1 - t
        const x = s * s * s * p[0] + 3 * s * s * t * p[2] + 3 * s * t * t * p[4] + t * t * t * p[6]
        const y = s * s * s * p[1] + 3 * s * s * t * p[3] + 3 * s * t * t * p[5] + t * t * t * p[7]
        x1 = Math.min(x1, x); x2 = Math.max(x2, x); y1 = Math.min(y1, y); y2 = Math.max(y2, y)
      }
      box(b).forEach((v, i) => expect(Math.abs(v - [x1, y1, x2, y2][i]!)).toBeLessThan(0.05))
      // and never inside the sampled extent
      expect(b.x1).toBeLessThanOrEqual(x1 + 1e-9)
      expect(b.x2).toBeGreaterThanOrEqual(x2 - 1e-9)
      expect(b.y1).toBeLessThanOrEqual(y1 + 1e-9)
      expect(b.y2).toBeGreaterThanOrEqual(y2 - 1e-9)
    }
  })

  it('a cubic whose derivative is only linear still turns once', () => {
    // x control values 0, -3, -2, 3: x'(t) is linear and zero at t = 0.375, where x is lowest
    const b = new Bounds()
    const pen = new BoundsPen(b)
    pen.moveTo(0, 0)
    pen.bezierCurveTo(-3, 1, -2, 2, 3, 3)
    let low = Infinity
    for (let i = 0; i <= 10000; i++) {
      const t = i / 10000, s = 1 - t
      low = Math.min(low, 3 * s * s * t * -3 + 3 * s * t * t * -2 + t * t * t * 3)
    }
    expect(b.x1).toBeCloseTo(low, 6)
    expect(low).toBeLessThan(-0.5)
  })

  it('an arc is measured at its ends and the quarter turns it passes, either way round', () => {
    const r = lcg(11)
    for (let n = 0; n < 300; n++) {
      const cx = r() * 100, cy = r() * 100, rad = 1 + r() * 50
      const a0 = (r() - 0.5) * 14, a1 = a0 + (r() - 0.5) * 6
      const ccw = r() < 0.5
      const b = new Bounds()
      new BoundsPen(b).arc(cx, cy, rad, a0, a1, ccw)
      // walk the arc: clockwise adds angle, counterclockwise subtracts it; the way round is the remainder of the difference
      let sweep = ccw ? a0 - a1 : a1 - a0
      sweep %= 2 * Math.PI
      if (sweep < 0) sweep += 2 * Math.PI
      let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity
      for (let i = 0; i <= 20000; i++) {
        const a = a0 + (ccw ? -1 : 1) * sweep * (i / 20000)
        const x = cx + rad * Math.cos(a), y = cy + rad * Math.sin(a)
        x1 = Math.min(x1, x); x2 = Math.max(x2, x); y1 = Math.min(y1, y); y2 = Math.max(y2, y)
      }
      if (Math.abs(a1 - a0) > 2 * Math.PI - 1e-8) continue
      box(b).forEach((v, i) => expect(Math.abs(v - [x1, y1, x2, y2][i]!)).toBeLessThan(0.02))
    }
  })

  it('a turned pen rotates points about the origin and the angles of an arc, not its centre', () => {
    const b = new Bounds()
    const pen = new BoundsPen(b, 90)
    pen.moveTo(10, 0)
    pen.lineTo(10, 5)
    expect(box(b).map((v) => Math.round(v * 1e9) / 1e9)).toEqual([-5, 10, 0, 10])
    const c = new Bounds()
    new BoundsPen(c, 90).arc(30, 0, 4, 0, Math.PI / 2)
    // angles 90 and 180 degrees about the unturned centre (30, 0)
    expect(c.x1).toBeCloseTo(26, 9)
    expect(c.y2).toBeCloseTo(4, 9)
  })
})
