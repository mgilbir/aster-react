/**
 * Record the alpha channel a real browser canvas (Chromium) leaves for each drawing of `src/raster-shapes.ts`, into
 * `src/raster-fixtures.json`: the ground truth `raster-vs-chromium.test.ts` holds the engine's coverage-only context to.
 *
 *   pnpm --filter @aster-charts/conformance exec tsx scripts/raster-fixtures.mts
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { chromium } from 'playwright'
import { GENERATED_SHAPES, SHAPES } from '../src/raster-shapes.js'
import { drawShape, measure, type Disagreement } from '../src/raster-measure.js'
// (the shapes drawn read the path reader from a slot the public entries fill: core's own modules, so the part is imported too)
import '../../core/src/part-svgpath.js'
import { cli } from '../../../scripts/lib/cli.mjs'

// `--rebaseline` keeps the alpha already recorded (and the browser's name) and only recounts the baseline against the engine as it is now.
cli({ url: import.meta.url, flags: { rebaseline: 'bool' } })
const FILE = new URL('../src/raster-fixtures.json', import.meta.url)

let out: Record<string, number[]>
let browserName: string
if (process.argv.includes('--rebaseline')) {
  const recorded = JSON.parse(readFileSync(FILE, 'utf8')) as { browser: string; alpha: Record<string, number[]> }
  out = recorded.alpha
  browserName = recorded.browser
} else {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  out = await page.evaluate((shapes) => {
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
  browserName = `Chromium ${browser.version()}`
  await browser.close()
}

// The ratchet baseline of EVERY drawing (the hand ones and the generated): how far the engine's context is from the browser's on each,
// pixel counts of the two kinds of disagreement on "has any alpha" kept apart (see src/raster-measure.ts) and the summed absolute
// alpha difference. `raster-vs-chromium.test.ts` lets none of the three get worse.
const baseline: Record<string, Disagreement> = {}
for (const s of [...SHAPES, ...GENERATED_SHAPES]) baseline[s.name] = measure(out[s.name]!, drawShape(s))
writeFileSync(FILE, JSON.stringify({ browser: browserName, alpha: out, baseline }) + '\n')
console.log(`recorded ${SHAPES.length + GENERATED_SHAPES.length} drawings from ${browserName}`)
