// @vitest-environment jsdom
/**
 * The gradient of a scale through the DOM renderer, against the pinned real Vega: the same generated specs as
 * scripts/differential-gradient.test.mts (which holds the string renderer to it), serialized from the DOM the patcher builds.
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { compileChart, evaluateChart } from '@aster-charts/core'
import { renderSceneToDomElement } from '@aster-charts/core/dom'
import { canonicalizeSvg, diffCanonical } from '../src/normalize.js'
import { gradientSpec, makeRng } from '../scripts/gradient-gen.mts'
import { scaled } from '../scripts/differential-gen.mts'

describe('the gradient of a scale in the DOM is painted as vega paints it', () => {
  it(`${scaled(150)} generated specs`, { timeout: 600_000 }, async () => {
    const r = makeRng(405)
    const bad: string[] = []
    let compared = 0
    for (let c = 0; c < scaled(150); c++) {
      const { spec, label } = gradientSpec(r)
      let runtime: unknown
      try { runtime = vega.parse(structuredClone(spec) as never) } catch { continue }
      const View = (vega as unknown as { View: new (rt: unknown, o: unknown) => { runAsync(): Promise<void>; toSVG(): Promise<string>; finalize(): void } }).View
      const quiet = { level() { return 0 }, error() { return this }, warn() { return this }, info() { return this }, debug() { return this } }
      const view = new View(runtime, { renderer: 'none', logger: quiet })
      let want: string
      try { await view.runAsync(); want = await view.toSVG() } finally { view.finalize() }
      const scene = evaluateChart(compileChart(structuredClone(spec) as never), { logger: { error: () => {}, warn: () => {} } } as never)
      const got = new XMLSerializer().serializeToString(renderSceneToDomElement(scene))
      compared++
      const d = diffCanonical(canonicalizeSvg(want), canonicalizeSvg(got))
      if (d.length) bad.push(`#${c} ${label}: ${d.slice(0, 2).join(' | ')}`)
    }
    expect(bad.length, `${bad.length} specs differ:\n${bad.slice(0, 6).join('\n')}`).toBe(0)
    expect(compared).toBeGreaterThan(scaled(150) * 0.7)
  })
})
