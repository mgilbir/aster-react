/**
 * Record the alpha channel a real browser canvas (Chromium) leaves for each drawing of `src/raster-shapes.ts`, into
 * `src/raster-fixtures.json`: the ground truth `raster-vs-chromium.test.ts` holds the engine's coverage-only context to.
 *
 *   pnpm --filter @aster/conformance exec tsx scripts/raster-fixtures.mts
 */
import { writeFileSync } from 'node:fs'
import { chromium } from 'playwright'
import { SHAPES } from '../src/raster-shapes.js'

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
}, SHAPES)
const version = browser.version()
await browser.close()
writeFileSync(new URL('../src/raster-fixtures.json', import.meta.url), JSON.stringify({ browser: `Chromium ${version}`, alpha: out }) + '\n')
console.log(`recorded ${SHAPES.length} drawings from Chromium ${version}`)
