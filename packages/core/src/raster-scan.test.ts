// @vitest-environment node
/**
 * The coverage scan of `raster.ts` keeps the crossings of a sub-row sorted in place (typed arrays, an insertion sort over the
 * order the last sub-row left them in) instead of allocating an object per crossing and sorting with a comparator: a stroked curve
 * puts a disk at every flattened vertex, and the scan was most of what rasterising one cost (audit 2026-11-22, C482). The picture
 * is the same: the 122 recorded drawings (`raster-vs-chromium.test.ts`) hold every pixel as it was.
 */
import { describe, expect, it } from 'vitest'
import { sortCrossings } from './raster.js'
import { mulberry32 } from './scene-fuzz.testlib.js'

describe('the crossings of a scan line are sorted in place (C482 rework of the scan)', () => {
  it('stably, for every size up to a dense polygon, whatever the order they come in', () => {
    const r = mulberry32(482)
    type E = { id: number }
    for (let trial = 0; trial < 300; trial++) {
      const m = 2 + Math.floor(r() * (trial % 3 === 0 ? 400 : 30))
      const mode = trial % 4
      // ties on purpose: a few distinct x values
      const x = new Float64Array(m + 5)
      const w = new Int8Array(m + 5)
      const edges: E[] = []
      for (let i = 0; i < m; i++) {
        x[i] = mode === 0 ? Math.floor(r() * 5) : mode === 1 ? r() * 100 : mode === 2 ? m - i + r() * 0.1 : i + (r() - 0.5) * 3
        w[i] = r() < 0.5 ? 1 : -1
        edges.push({ id: i })
      }
      const ref = Array.from({ length: m }, (_, i) => ({ x: x[i]!, w: w[i]!, e: edges[i]! })).sort((p, q) => p.x - q.x)
      sortCrossings(x, w, edges as never, m)
      for (let i = 0; i < m; i++) {
        expect(x[i], `trial ${trial} slot ${i}`).toBe(ref[i]!.x)
        expect(w[i]).toBe(ref[i]!.w)
        expect(edges[i]).toBe(ref[i]!.e)
      }
    }
  })
})
