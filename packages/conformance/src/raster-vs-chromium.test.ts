/**
 * The engine's coverage-only 2D context (`@aster/core` raster.ts, what the `label` transform draws the marks it avoids into) against
 * the alpha channel a real browser canvas leaves for the same drawing (`raster-fixtures.json`, recorded in Chromium by
 * `scripts/raster-fixtures.mts` from the drawings of `raster-shapes.ts`). A label is placed where no pixel under it has any
 * alpha, so what matters is which edge pixels have a little: the contexts are not equal bit for bit (Skia's analytic coverage
 * is not an area), but they must agree on that to within a few pixels of a drawing, on the total coverage, and on the quirks
 * that decide it -- a path's vertices snap in y to a quarter pixel (a circle moved down by an eighth of a pixel stays where it
 * was or jumps a quarter), and a conic circle is four quads.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { AlphaCanvas } from '../../core/src/raster.js'
import { SHAPES, type RasterShape } from './raster-shapes.js'

const FIXTURES = JSON.parse(readFileSync(new URL('./raster-fixtures.json', import.meta.url), 'utf8')) as { browser: string; alpha: Record<string, number[]> }

function draw(s: RasterShape): Uint8Array {
  const c = new AlphaCanvas(s.w, s.h) as unknown as Record<string, unknown> & { alpha: Uint8Array }
  for (const cmd of s.cmds) {
    if (Array.isArray(cmd)) (c[cmd[0]] as (...a: unknown[]) => void).apply(c, cmd.slice(1))
    else c[cmd.set] = cmd.value
  }
  return c.alpha
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
    })
  }

  it('a circle moves in steps of a quarter pixel as it is moved down, as in the browser', () => {
    const circles = SHAPES.filter((s) => s.name.startsWith('circle r=2.5 cy='))
    expect(circles.length).toBe(8)
    const pattern = (grids: ArrayLike<number>[]): string => grids.map((g, i) => grids.findIndex((h) => h.length === g.length && Array.prototype.every.call(g, (v: number, k: number) => v === h[k])) === i ? 'n' : 'r').join('')
    const chrome = pattern(circles.map((s) => FIXTURES.alpha[s.name]!))
    const engine = pattern(circles.map((s) => draw(s)))
    // the browser draws some of the eight identically (those within a quarter-pixel step): so must the engine, the same ones
    expect(chrome).toContain('r')
    expect(engine).toBe(chrome)
  })
})
