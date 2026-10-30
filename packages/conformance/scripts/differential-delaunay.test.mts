/**
 * LIVE generated differential for the geometry under the `voronoi` transform, against the reference libraries themselves:
 *   - `orientation` against robust-predicates' `orient2d` (the sign, on nearly collinear, exactly collinear and repeated
 *     triples at many scales),
 *   - `triangulate` against delaunator (triangles, half-edges and hull, array for array),
 *   - the clipped cells of `voronoi` against d3-delaunay's (corner for corner, in the same order).
 * Point sets come from `voronoi-cases.mts`. Nothing is recorded: both sides run in this process.
 */
import { describe, expect, it, vi } from 'vitest'
import { orientation } from '../../core/src/orient.ts'
import { triangulate } from '../../core/src/delaunay.ts'
import { voronoi } from '../../core/src/voronoi.ts'
import { importChain, seeded } from './upstream.mts'
import { MODES, points } from './voronoi-cases.mts'

const { orient2d } = (await importChain('vega', 'vega-voronoi', 'd3-delaunay', 'delaunator', 'robust-predicates')) as { orient2d: (...a: number[]) => number }
const { default: Delaunator } = (await importChain('vega', 'vega-voronoi', 'd3-delaunay', 'delaunator')) as { default: new (c: Float64Array) => { triangles: Uint32Array; halfedges: Int32Array; hull: Uint32Array } }
const { Delaunay } = (await importChain('vega', 'vega-voronoi', 'd3-delaunay')) as { Delaunay: new (c: Float64Array) => { voronoi(b: number[]): { _clip(i: number): number[] | null } } }

// generated differentials are heavy; a loaded machine must not turn them into timeouts
vi.setConfig({ testTimeout: 120_000 })

const sign = (v: number): number => (v < 0 ? -1 : v > 0 ? 1 : 0)

/** `x` moved by `ulps` units in the last place. */
function nudge(x: number, ulps: number): number {
  const f = new Float64Array([x])
  const b = new BigInt64Array(f.buffer)
  b[0] = b[0]! + BigInt(x >= 0 ? ulps : -ulps)
  return f[0]!
}

describe('orientation vs robust-predicates orient2d', () => {
  it('has the same sign on random, nearly collinear, exactly collinear and repeated triples', () => {
    const r = seeded(2024)
    const tally = { neg: 0, zero: 0, pos: 0 }
    for (let i = 0; i < 60000; i++) {
      const scale = 10 ** (r.int(17) - 8)
      const shift = r.pick([0, 0, 1, -37.5, 1e6]) * scale
      const p = () => [shift + (r.next() - 0.5) * scale, shift + (r.next() - 0.5) * scale]
      let [ax, ay] = p() as [number, number]
      let [bx, by] = p() as [number, number]
      let cx: number
      let cy: number
      switch (r.int(9)) {
        case 0: [cx, cy] = p() as [number, number]; break
        case 1: { const t = r.next(); cx = ax + t * (bx - ax); cy = ay + t * (by - ay); break }
        case 2: { const t = r.next() * 3 - 1; cx = nudge(ax + t * (bx - ax), r.int(5) - 2); cy = nudge(ay + t * (by - ay), r.int(5) - 2); break }
        case 3: { const k = r.pick([1, 2, 3, 0.5, 10]); ax = r.int(50) * k; ay = r.int(50) * k; bx = r.int(50) * k; by = r.int(50) * k; const t = r.int(5); cx = ax + t * (bx - ax); cy = ay + t * (by - ay); break }
        case 4: { const t = r.pick([0.1, 0.3, 0.7]); cx = ax + t * (bx - ax); cy = ay + t * (by - ay); cx = nudge(cx, r.int(3) - 1); break }
        case 5: [cx, cy] = [ax, ay]; break
        case 6: {
          // points of very different magnitudes on (nearly) one line: the differences are not exact
          const big = r.pick([1, 1e3, 1e8, 1e15])
          const tiny = r.pick([1e-20, 1e-12, 1e-3])
          ax = r.pick([1, 2, 3]) * big; ay = r.pick([1, 2, 3]) * big
          bx = ax + r.pick([1, 2, 4]) * big; by = ay + r.pick([1, 2, 4]) * big
          cx = r.pick([0, 1, 2]) * tiny + (r.int(2) ? ax : bx); cy = r.pick([0, 1, 2]) * tiny + (r.int(2) ? ay : by)
          break
        }
        case 7: {
          // only one of the four differences is inexact: a = 1 against c = t makes a - c round, the others do not
          const t = 2 ** -(54 + r.int(16)) * r.pick([1, 3, 5])
          ;[ax, ay, bx, cx, cy] = [1, 1, 3 * t, t, 0]
          by = nudge(2 * t, r.int(9) - 4)
          if (r.int(2)) [ax, ay, bx, by, cx, cy] = [ay, ax, by, bx, cy, cx]
          break
        }
        default: { cx = nudge(ax, r.int(7) - 3); cy = nudge(ay, r.int(7) - 3); bx = nudge(ax, r.int(7) - 3); by = nudge(ay, r.int(7) - 3) }
      }
      const want = sign(orient2d(ax, ay, bx, by, cx, cy))
      expect(sign(orientation(ax, ay, bx, by, cx, cy)), JSON.stringify([ax, ay, bx, by, cx, cy])).toBe(want)
      tally[want < 0 ? 'neg' : want > 0 ? 'pos' : 'zero']++
    }
    // all three outcomes are exercised, and a good share are the hard ones
    expect(tally.neg).toBeGreaterThan(5000)
    expect(tally.pos).toBeGreaterThan(5000)
    expect(tally.zero).toBeGreaterThan(2000)
  })

  it('agrees with the plain determinant wherever that is certain, and says NaN for NaN', () => {
    expect(orientation(0, 0, 1, 0, 0, 1)).toBeLessThan(0)
    expect(orientation(0, 0, 0, 1, 1, 0)).toBeGreaterThan(0)
    expect(orientation(NaN, 0, 1, 0, 0, 1)).toBeNaN()
  })
})

describe('triangulate vs delaunator', () => {
  for (const [m, mode] of MODES.entries()) {
    it(`${mode} point sets give the same triangulation`, () => {
      const r = seeded(500 + m)
      let triangles = 0
      for (let i = 0; i < 150; i++) {
        const rows = points(r, mode, r.pick([0, 1, 2, 3, 4, 7, 20, 100, 400]))
        const coords = new Float64Array(rows.length * 2)
        rows.forEach((row, j) => { coords[2 * j] = row.x as number; coords[2 * j + 1] = row.y as number })
        const want = new Delaunator(coords.slice())
        const got = triangulate(coords.slice())
        const tag = JSON.stringify({ mode, rows })
        expect(Array.from(got.triangles), tag).toEqual(Array.from(want.triangles))
        expect(Array.from(got.halfedges), tag).toEqual(Array.from(want.halfedges))
        expect(Array.from(got.hull), tag).toEqual(Array.from(want.hull))
        triangles += got.triangles.length / 3
      }
      expect(triangles).toBeGreaterThanOrEqual(mode === 'equal' || mode === 'diagonal' || mode === 'row' || mode === 'column' || mode === 'oneLine' ? 0 : 400)
    })
  }

  it('large collinear and repeated sets (2000 points) give the same degenerate hull', () => {
    const r = seeded(7)
    for (const mode of ['diagonal', 'row', 'column', 'oneLine', 'equal'] as const) {
      const rows = points(r, mode, 2000)
      const coords = new Float64Array(rows.length * 2)
      rows.forEach((row, j) => { coords[2 * j] = row.x as number; coords[2 * j + 1] = row.y as number })
      const want = new Delaunator(coords.slice())
      const got = triangulate(coords.slice())
      expect(Array.from(got.hull), mode).toEqual(Array.from(want.hull))
      expect(got.triangles.length, mode).toBe(want.triangles.length)
    }
  })

  it('a large scattered set (20000 points) and a large lattice give the same triangulation', () => {
    const r = seeded(1)
    for (const mode of ['scattered', 'lattice'] as const) {
      const rows = points(r, mode, 20000)
      const coords = new Float64Array(rows.length * 2)
      rows.forEach((row, j) => { coords[2 * j] = row.x as number; coords[2 * j + 1] = row.y as number })
      const want = new Delaunator(coords.slice())
      const got = triangulate(coords.slice())
      expect(got.triangles.length).toBe(want.triangles.length)
      expect(got.triangles.every((v, k) => v === want.triangles[k])).toBe(true)
      expect(got.halfedges.every((v, k) => v === want.halfedges[k])).toBe(true)
      expect(Array.from(got.hull)).toEqual(Array.from(want.hull))
    }
  })
})

describe('voronoi cells vs d3-delaunay', () => {
  for (const [m, mode] of MODES.entries()) {
    it(`${mode} point sets give the same clipped cells`, () => {
      const r = seeded(900 + m)
      let cells = 0
      for (let i = 0; i < 100; i++) {
        const rows = points(r, mode, r.pick([1, 2, 3, 4, 7, 20, 100]))
        const coords = new Float64Array(rows.length * 2)
        rows.forEach((row, j) => { coords[2 * j] = row.x as number; coords[2 * j + 1] = row.y as number })
        const bounds = r.pick([[0, 0, 200, 150], [-10, -10, 210, 160], [20, 30, 60, 50], [-1e5, -1e5, 1e5, 1e5], [0, 0, 1, 1]])
        // d3 nudges collinear points in its own copy of the array, as the port does in its own
        const want = new Delaunay(coords.slice()).voronoi(bounds)
        const got = voronoi(coords.slice(), { xmin: bounds[0]!, ymin: bounds[1]!, xmax: bounds[2]!, ymax: bounds[3]! })
        for (let k = 0; k < rows.length; k++) {
          const cell = got.cell(k)
          expect(cell, JSON.stringify({ mode, rows, bounds, k })).toEqual(want._clip(k))
          if (cell) cells++
        }
      }
      expect(cells).toBeGreaterThan(40)
    })
  }
})
