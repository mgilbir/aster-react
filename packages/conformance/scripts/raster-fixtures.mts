/**
 * Record the alpha channel a real browser canvas (Chromium) leaves for each drawing of `src/raster-shapes.ts`, into
 * `src/raster-fixtures.json`: the ground truth `raster-vs-chromium.test.ts` holds the engine's coverage-only context to.
 *
 *   pnpm --filter @aster/conformance exec tsx scripts/raster-fixtures.mts
 */
import { writeFileSync } from 'node:fs'
import { chromium } from 'playwright'
import { GENERATED_SHAPES, SHAPES } from '../src/raster-shapes.js'
import { AlphaCanvas } from '../../core/src/raster.js'

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()
const out = await page.evaluate((shapes) => {
  const alphas: Record<string, number[]> = {}
  for (const s of shapes) {
    const c = document.createElement('canvas')
    c.width = s.w
    c.height = s.h
    const ctx = c.getContext('2d') as unknown as Record<string, unknown> & CanvasRenderingContext2D
    for (const cmd of s.cmds) {
      if (Array.isArray(cmd)) (ctx[cmd[0] as string] as (...a: unknown[]) => void).apply(ctx, cmd.slice(1))
      else ctx[cmd.set] = cmd.value
    }
    const d = ctx.getImageData(0, 0, s.w, s.h).data
    const a: number[] = []
    for (let i = 3; i < d.length; i += 4) a.push(d[i]!)
    alphas[s.name] = a
  }
  return alphas
}, [...SHAPES, ...GENERATED_SHAPES])
const version = browser.version()
await browser.close()

// The ratchet baseline of the GENERATED drawings: how far the engine's context is from the browser's on each (pixels that
// differ in "has any alpha", and the summed absolute alpha difference). `raster-vs-chromium.test.ts` lets it get no worse.
const baseline: Record<string, { mask: number; abs: number }> = {}
for (const s of GENERATED_SHAPES) {
  const c = new AlphaCanvas(s.w, s.h) as unknown as Record<string, unknown> & { alpha: Uint8Array }
  for (const cmd of s.cmds) {
    if (Array.isArray(cmd)) (c[cmd[0] as string] as (...a: unknown[]) => void).apply(c, cmd.slice(1))
    else c[cmd.set] = cmd.value
  }
  const want = out[s.name]!
  let mask = 0
  let abs = 0
  for (let i = 0; i < want.length; i++) {
    if ((want[i] !== 0) !== (c.alpha[i] !== 0)) mask++
    abs += Math.abs(want[i]! - c.alpha[i]!)
  }
  baseline[s.name] = { mask, abs }
}
writeFileSync(new URL('../src/raster-fixtures.json', import.meta.url), JSON.stringify({ browser: `Chromium ${version}`, alpha: out, baseline }) + '\n')
console.log(`recorded ${SHAPES.length + GENERATED_SHAPES.length} drawings from Chromium ${version}`)
