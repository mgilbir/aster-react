/**
 * The outline Aster's pointer and `intersect()` test for path text, against the path vega draws from the same text: vega's own
 * `pathParse` + `pathRender` (what a path mark, a custom symbol shape and a `{path}` clip draw) onto the recording context
 * (canvas-recorder.ts), whose `isPointInPath` answers from the drawn outline, against Aster's outline (`pathMarkPolys`: a path mark's;
 * `pathPolys`: a shape mark's and a clip's, replayed through `tracePath`) and its non-zero winding test, at a grid of points. A point
 * where the recording's answer changes within 0.3 px is an edge, where flattening decides: it is counted, not compared.
 *
 * The texts are the generated specs' (geometry-specs.ts) and every form the audit found drawn wrong (C142, C415, C455): a subpath
 * that goes on after Z without a move, H / V / A / S / T after Z, arcs too small for their chord, elliptical and turned arcs,
 * relative curves.
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { pathMarkPolys, pathPolys } from '../../core/src/geometry-read.js'
import { insidePolys } from '../../core/src/path-flatten.js'
import { recorder } from './canvas-recorder.js'
import { PATHS } from './geometry-specs.js'

const V = vega as unknown as { pathParse(d: string): unknown; pathRender(ctx: unknown, path: unknown, l: number, t: number, sx?: number, sy?: number): void }

const TEXTS = [...PATHS.filter((d) => d.length > 4),
  'M100,100L150,100L150,150ZL50,150L50,100Z', 'M0,0L60,0L60,60ZH30V30Z', 'M0,0L60,0L60,60ZV30H30Z', 'M0,0L40,0L40,40ZA10,10,0,0,1,20,20Z',
  'M10,50A10,10,0,0,1,90,50Z', 'M100,100L200,100A50,25,0,0,1,300,100L300,200L100,200Z', 'M0,0A30,15,30,1,1,60,30Z', 'M0,0L40,0L40,40ZS60,60 80,40Z',
  'M0,0L40,0L40,40ZT80,40Z', 'M0,0L40,0L40,40Zl-20,20l-20,-20z']

function vegaInside(d: string): (x: number, y: number) => boolean {
  const rec = recorder()
  const ctx = rec.ctx as unknown as { beginPath(): void; isPointInPath(x: number, y: number): boolean }
  ctx.beginPath()
  V.pathRender(ctx, V.pathParse(d), 0, 0)
  return (x, y) => ctx.isPointInPath(x, y)
}

describe('path outlines against the path vega draws from the same text', () => {
  for (const [label, outline] of [['a path mark (pathMarkPolys)', (d: string) => pathMarkPolys(d, 1, 1)], ['a shape or a clip (pathPolys)', pathPolys]] as const) {
    it(`${label}: inside the same points, every text`, () => {
      const differ: string[] = []
      let decisive = 0
      let inside = 0
      for (const d of TEXTS) {
        const want = vegaInside(d)
        const polys = outline(d)
        for (let x = -12.37; x < 320; x += 2.93) {
          for (let y = -12.71; y < 220; y += 2.89) {
            const w = want(x, y)
            if ([[0.3, 0], [-0.3, 0], [0, 0.3], [0, -0.3]].some(([dx, dy]) => want(x + dx!, y + dy!) !== w)) continue
            decisive++
            if (w) inside++
            if (insidePolys(polys, x, y) !== w && differ.length < 10) differ.push(`${d} at (${x.toFixed(2)}, ${y.toFixed(2)}): vega ${w}`)
          }
        }
      }
      expect(differ).toEqual([])
      expect(inside).toBeGreaterThan(2000)
      expect(decisive).toBeGreaterThan(50_000)
    })
  }
})
