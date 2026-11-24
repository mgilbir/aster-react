/**
 * The engine's coverage-only 2D context (`@aster-charts/core` raster.ts, what the `label` transform draws the marks it avoids into) against
 * the alpha channel a real browser canvas leaves for the same drawing (`raster-fixtures.json`, recorded in Chromium by
 * `scripts/raster-fixtures.mts` from the drawings of `raster-shapes.ts`). A label is placed where no pixel under it has any
 * alpha, so what matters is which edge pixels have a little: the contexts are not equal bit for bit (Skia's analytic coverage
 * is not an area), but they must agree on that to within a few pixels of a drawing, on the total coverage, and on the quirks
 * that decide it -- a path's vertices snap in y to a quarter pixel (a circle moved down by an eighth of a pixel stays where it
 * was or jumps a quarter), and a conic circle is four quads.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { GENERATED_SHAPES, SHAPES, type RasterShape } from './raster-shapes.js'
import { drawShape as draw, measure, type Disagreement } from './raster-measure.js'

const FIXTURES = JSON.parse(readFileSync(new URL('./raster-fixtures.json', import.meta.url), 'utf8')) as { browser: string; alpha: Record<string, number[]>; baseline: Record<string, Disagreement> }

/**
 * A drawing may not be further from the browser's than when it was recorded: no more pixels the browser inks and the engine leaves empty
 * (`missing`: a label may land on ink), no more the other way (`extra`: a halo), and the summed alpha difference may not grow. The two
 * pixel counts are held apart, so a change that removes halo pixels and drops faint ink in the same measure does not pass.
 */
function expectNoWorse(s: RasterShape): void {
  const base = FIXTURES.baseline[s.name]
  expect(base, `${s.name} has no recorded baseline: node scripts/raster-fixtures.mts --rebaseline`).toBeDefined()
  const now = measure(FIXTURES.alpha[s.name]!, draw(s))
  expect(now.missing, 'pixels the browser inks and the engine leaves empty').toBeLessThanOrEqual(base!.missing)
  expect(now.extra, 'pixels the engine inks and the browser leaves empty').toBeLessThanOrEqual(base!.extra)
  expect(now.abs, 'summed alpha difference from the browser').toBeLessThanOrEqual(base!.abs)
}

describe(`raster.ts against ${FIXTURES.browser}'s canvas`, () => {
  for (const s of SHAPES) {
    it(s.name, () => {
      const want = FIXTURES.alpha[s.name]!
      const got = draw(s)
      let on = 0
      let nonzeroDiffs = 0
      let maxDiff = 0
      let sumWant = 0
      let sumGot = 0
      for (let i = 0; i < want.length; i++) {
        if (want[i]) on++
        if ((want[i] !== 0) !== (got[i] !== 0)) nonzeroDiffs++
        maxDiff = Math.max(maxDiff, Math.abs(want[i]! - got[i]!))
        sumWant += want[i]!
        sumGot += got[i]!
      }
      expect(on).toBeGreaterThan(10)
      expect(sumGot / sumWant).toBeGreaterThan(0.94)
      expect(sumGot / sumWant).toBeLessThan(1.03)
      expect(nonzeroDiffs).toBeLessThanOrEqual(Math.max(8, Math.ceil(on * 0.05)))
      expect(maxDiff).toBeLessThanOrEqual(55)
      // (the tolerances above are loose: the recorded disagreement of THIS drawing is what it may not exceed)
      expectNoWorse(s)
    })
  }

  it('a circle moves in steps of a quarter pixel as it is moved down, as in the browser', () => {
    const circles = SHAPES.filter((s) => s.name.startsWith('circle r=2.5 cy='))
    expect(circles.length).toBe(8)
    const same = (g: ArrayLike<number>, h: ArrayLike<number>): boolean => g.length === h.length && Array.prototype.every.call(g, (v: number, k: number) => v === h[k])
    // for each position, the index of the FIRST grid equal to it: 'a grid repeats an earlier one' is not enough, an engine that
    // snaps cy = 5.250 to 5.000 instead of up to 5.250's neighbour repeats the same positions with another grid
    const firstEqual = (grids: ArrayLike<number>[]): number[] => grids.map((g) => grids.findIndex((h) => same(g, h)))
    const chromeGrids = circles.map((s) => FIXTURES.alpha[s.name]!)
    const engineGrids = circles.map((s) => draw(s))
    const chrome = firstEqual(chromeGrids)
    const engine = firstEqual(engineGrids)
    // the browser draws some of the eight identically (those within a quarter-pixel step): so must the engine, the same ones
    expect(chrome).toEqual([0, 1, 1, 3, 3, 5, 5, 7])
    expect(engine).toEqual(chrome)
    // and the last is the first moved down one whole row (cy = 5.875 snaps to 6.000, cy = 5.000 is 5.000)
    const [w, h] = [circles[0]!.w, circles[0]!.h]
    for (const grids of [chromeGrids, engineGrids]) {
      const first = grids[0]!
      const last = grids[7]!
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        expect(last[y * w + x], `row ${y} column ${x}`).toBe(y === 0 ? 0 : first[(y - 1) * w + x])
      }
    }
  })

  // The generated drawings (curves of every size, arcs of every sweep, transformed circles, every cap and join, dashes) hold the
  // engine to the same ratchet as the hand ones, with no tolerance of their own: a change to how curves are cut, how vertices snap
  // or how coverage is summed moves these numbers. Where the browser spreads a sub-pixel stroke over two or three columns the engine
  // draws one (`missing` of the thin cubics): a documented deviation (docs/ARCHITECTURE.md "Deviations from Vega"), pinned here.
  describe('generated drawings (ratchet against the recorded disagreement)', () => {
    for (const s of GENERATED_SHAPES) {
      it(s.name, () => { expectNoWorse(s) })
    }
  })

  it('every drawing has a recorded baseline and an alpha of its own size', () => {
    for (const s of [...SHAPES, ...GENERATED_SHAPES]) {
      expect(FIXTURES.alpha[s.name]?.length, s.name).toBe(s.w * s.h)
      expect(FIXTURES.baseline[s.name], s.name).toBeDefined()
    }
    expect(Object.keys(FIXTURES.baseline).length).toBe(SHAPES.length + GENERATED_SHAPES.length)
  })
})
