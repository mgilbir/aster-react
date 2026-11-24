// @vitest-environment node
/**
 * `limits.regex: 'refuse'` (core limits.ts, #174) refuses exactly the specs that make regular expressions, and nothing else:
 *  - over the whole corpus (Vega specs, and Vega-Lite specs as Aster's own compiler emits them), a chart whose spec makes none
 *    draws the same document under the option; one that does is refused with a limit error, for a site that is a regex. The
 *    refused files are pinned, so a new false positive (an ordinary spec refused) or a missed one changes the list;
 *  - from Vega-Lite, a regex in a `calculate`, a `filter`, a mark property `{expr}` or a param's expression is refused.
 *
 * These run against the built packages (the `build` gate precedes `test`).
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import '@aster-charts/core/geo'
import '@aster-charts/core/transforms'
import { compileChart, evaluateChart, renderSceneToSvg, renderSpec } from '@aster-charts/core'
import { loadSpecData, TRUSTED_LOAD_OPTIONS } from '@aster-charts/core/load'
import { compile } from '@aster-charts/vl'

const CORPUS = join(dirname(fileURLToPath(import.meta.url)), '..', 'corpus')
const REFUSE = { regex: 'refuse' } as const
/**
 * The corpus files whose spec makes a regular expression: expr-fns calls `test(datum.b > 50, ...)` (a pattern made of the text
 * `true`). t-countpattern is not one: its countpattern takes the engine's default pattern.
 */
const REFUSED = new Map([['expr-fns.vg.json', ["(test(datum.b > 50, rgb('#4c78a8'), hsl(120, 1, 0.5)))"]]])

const errorOf = (fn: () => unknown): Error | null => {
  try { fn() } catch (e) { return e as Error }
  return null
}

describe("limits.regex: 'refuse' over the corpus", () => {
  const files = readdirSync(CORPUS).filter((n) => n.endsWith('.json')).sort()
  // one test per file: a single loop over the corpus exceeds the 5 s default under a parallel suite
  for (const f of files) {
    it(f, async () => {
      const raw = JSON.parse(readFileSync(join(CORPUS, f), 'utf8'))
      const spec = f.endsWith('.vl.json') ? (compile(raw as never) as Record<string, unknown>) : raw
      const loaded = await loadSpecData(spec as never, TRUSTED_LOAD_OPTIONS)
      const chart = compileChart(loaded as never)
      const plainErr = errorOf(() => evaluateChart(chart))
      const err = errorOf(() => evaluateChart(compileChart(loaded as never), { limits: REFUSE }))
      const sites = (chart as { regexSites?: readonly string[] }).regexSites ?? []
      // (exactly the pinned files make a regex: judged per file, so it holds however the tests are run or ordered)
      expect(sites.length > 0, `${f} ${REFUSED.has(f) ? 'is pinned as making a regex and makes none' : 'makes a regex and is not pinned'}`).toBe(REFUSED.has(f))
      if (sites.length === 0) {
        // makes none: the same document, or the same failure as without the option
        if (plainErr) expect(err?.message).toBe(plainErr.message)
        else expect(renderSceneToSvg(evaluateChart(compileChart(loaded as never), { limits: REFUSE }))).toBe(renderSceneToSvg(evaluateChart(compileChart(loaded as never))))
        return
      }
      expect((err as { code?: string } | null)?.code, f).toBe('ASTER_LIMIT')
      expect(err!.message, f).toContain("limits.regex: 'refuse'")
      // the sites are the pinned ones, word for word (a loose pattern would pass any text that holds two slashes)
      expect([...sites], f).toEqual(REFUSED.get(f))
    })
  }
  it('the pinned files exist in the corpus', () => {
    for (const f of REFUSED.keys()) expect(files, f).toContain(f)
  })
})

describe("Vega-Lite: a spec that makes a regular expression is refused under limits.regex: 'refuse'", () => {
  const data = { values: [{ a: 'aab', x: 1, y: 2 }, { a: 'ba', x: 2, y: 3 }] }
  const unit = (extra: Record<string, unknown>): Record<string, unknown> => ({
    $schema: 'https://vega.github.io/schema/vega-lite/v6.json', width: 80, height: 60, data, mark: 'point',
    encoding: { x: { field: 'x', type: 'quantitative' }, y: { field: 'y', type: 'quantitative' } }, ...extra,
  })
  const CASES: Array<[string, Record<string, unknown>]> = [
    ['calculate', unit({ transform: [{ calculate: "test('a+', datum.a) ? 1 : 0", as: 'r' }] })],
    ['calculate, bracketed call', unit({ transform: [{ calculate: "(test)('a+', datum.a) ? 1 : 0", as: 'r' }] })],
    ['calculate, literal', unit({ transform: [{ calculate: "replace(datum.a, / a+/, '')", as: 'r' }] })],
    ['calculate, regexp', unit({ transform: [{ calculate: "split(datum.a, regexp(','))", as: 'r' }] })],
    ['filter', unit({ transform: [{ filter: "test('a', datum.a)" }] })],
    ['mark property expr', unit({ mark: { type: 'point', size: { expr: "test('a', 'a') ? 50 : 10" } } })],
    ['param expression', unit({ params: [{ name: 'p', expr: "test('a', 'a')" }] })],
    ['condition test', unit({ encoding: { x: { field: 'x', type: 'quantitative' }, y: { field: 'y', type: 'quantitative' }, color: { condition: { test: "test('a', datum.a)", value: 'red' }, value: 'blue' } } })],
  ]
  for (const [what, vlSpec] of CASES) {
    it(what, () => {
      const vg = compile(vlSpec as never) as never
      expect(() => renderSpec(vg), `${what} draws without the option`).not.toThrow()
      const err = errorOf(() => renderSpec(vg, { limits: REFUSE }))
      expect((err as { code?: string } | null)?.code, what).toBe('ASTER_LIMIT')
      expect(err!.message, what).toContain("limits.regex: 'refuse'")
    })
  }
  it("a text pattern stays allowed: replace(datum.a, 'a+', '')", () => {
    const vg = compile(unit({ transform: [{ calculate: "replace(datum.a, 'a+', '')", as: 'r' }] }) as never) as never
    expect(renderSpec(vg, { limits: REFUSE })).toBe(renderSpec(vg))
  })
})
