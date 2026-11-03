// @vitest-environment node
/**
 * The gradient of a scale, against the pinned real Vega, in this process.
 *
 * A mark channel painted by `{gradient: <scale>, start, stop, count}` or by the expression `gradient(scale, start, stop, count)` is a
 * linear gradient whose stops come from the scale: its tick values (`count`, else 15) and the ends of its domain at the fraction
 * the scale puts them at, in the colour the scale gives; a scale without ticks (discretizing, ordinal) uses its domain; a domain
 * with no width is stretched onto [0, 1]. Generated over the kinds of scale, the options, the marks that paint (fill, stroke, both,
 * conditionals, shared gradients, a scale named by a signal or by a field), and compared as the picture (strict canonicalizer:
 * every gradient definition resolved to its coordinates and stops) from the string renderer (the DOM one is gradient-dom-vs-vega), and the errors
 * logged (a scale that cannot draw a gradient fails in vega's encode, and the pass stops there).
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { renderSpec } from '@aster/core'
import { canonicalizeSvg, diffCanonical } from '../src/normalize.js'
import { gradientSpec, makeRng } from './gradient-gen.mts'
import { scaled } from './differential-gen.mts'

type Spec = Record<string, unknown>

async function onVega(spec: Spec): Promise<{ svg: string; errors: string[] } | { threw: string }> {
  const errors: string[] = []
  const logger = { level() { return 2 }, error: (...a: unknown[]) => { errors.push(String(a[0])); return logger }, warn: () => logger, info: () => logger, debug: () => logger }
  const View = (vega as unknown as { View: new (rt: unknown, o: unknown) => { runAsync(): Promise<void>; toSVG(): Promise<string>; finalize(): void } }).View
  let runtime: unknown
  // (an entry with a start missing and a count given is `gradient("g",,5)` in vega's expression: a syntax error in vega.parse)
  try { runtime = vega.parse(structuredClone(spec) as never) } catch (e) { return { threw: (e as Error).message } }
  const view = new View(runtime, { renderer: 'none', logger })
  try {
    await view.runAsync()
    return { svg: await view.toSVG(), errors }
  } finally {
    view.finalize()
  }
}

function onAster(spec: Spec): { svg: string; errors: string[] } | { threw: string } {
  const errors: string[] = []
  try { return aster(spec, errors) } catch (e) { return { threw: (e as Error).message } }
}

function aster(spec: Spec, errors: string[]): { svg: string; errors: string[] } {
  const logger = { error: (...a: unknown[]) => { errors.push(String(a[0])) }, warn: () => {} }
  const svg = renderSpec(structuredClone(spec) as never, { logger } as never)
  return { svg, errors }
}

describe('the gradient of a scale is painted as vega paints it', () => {
  it(`${scaled(400)} generated specs`, { timeout: 600_000 }, async () => {
    const r = makeRng(404)
    const bad: string[] = []
    let withGradient = 0
    let failed = 0
    let threw = 0
    const kinds = new Set<string>()
    for (let c = 0; c < scaled(400); c++) {
      const { spec, label } = gradientSpec(r)
      const want = await onVega(spec)
      const got = onAster(spec)
      const tag = `#${c} ${label}`
      kinds.add(label.split(' ')[0]!)
      if ('threw' in want || 'threw' in got) {
        threw++
        if (JSON.stringify(want) !== JSON.stringify(got)) bad.push(`${tag}: vega ${JSON.stringify('threw' in want ? want.threw : 'drew')}, aster ${JSON.stringify('threw' in got ? got.threw : 'drew')}`)
        continue
      }
      if (want.errors.length) failed++
      else if (/<(linear|radial)Gradient/.test(want.svg)) withGradient++
      if (JSON.stringify(want.errors) !== JSON.stringify(got.errors)) { bad.push(`${tag}: vega logged ${JSON.stringify(want.errors)}, aster ${JSON.stringify(got.errors.slice(0, 2))}`); continue }
      const canon = canonicalizeSvg(want.svg)
      const d = diffCanonical(canon, canonicalizeSvg(got.svg))
      if (d.length) bad.push(`${tag}: ${d.slice(0, 2).join(' | ')}`)
    }
    expect(bad.length, `${bad.length} specs differ:\n${bad.slice(0, 8).join('\n')}`).toBe(0)
    // not vacuous: most specs draw gradients in vega, some fail there, and every kind of scale was drawn
    expect(withGradient).toBeGreaterThan(scaled(400) * 0.5)
    expect(failed).toBeGreaterThan(0)
    expect(threw).toBeGreaterThan(0)
    expect(kinds.size).toBeGreaterThanOrEqual(15)
  })
})
