// @vitest-environment node
/**
 * Every selection type x binding x resolve x composition, against vega-lite 6.4.3.
 *
 * Each case is a small inline spec with one selection parameter used by a condition. For every one the two compilers' output
 * is compared on what the selection emits: every signal in order (names, init / update / on / push / bind), the store datasets,
 * the brush and voronoi marks (and the signals of the group scopes), the scales' `domainRaw`, the interactive legend encodes; the
 * compiled expression sets; and the SVG real Vega renders from each. A spec vega-lite refuses must be refused here (the message is Aster's own).
 */
import { describe, it, expect } from 'vitest'
import * as vl from 'vega-lite'
import { compile } from '@aster/vl'
import { renderWithVega, renderWithVegaChecked } from '../src/render-vega.js'
import { canonicalizeSvg, diffCanonical } from '../src/normalize.js'
import { expressionDiff } from './vl-expressions.js'
import { withOracleRandom } from '../src/gallery/seeded.js'
import { GROUPS } from './vl-selection-matrix-cases.js'

const plain = (v: unknown) => JSON.parse(JSON.stringify(v))

const signalsOf = (s: any): unknown[] => s.signals ?? []
const storesOf = (s: any): unknown[] => (s.data ?? []).filter((d: any) => /_store$/.test(d.name))
const marksOf = (ms: any[] | undefined, path = ''): unknown[] =>
  (ms ?? []).flatMap((m: any) => [
    {
      path: `${path}/${m.name}`, type: m.type, interactive: m.interactive, clip: m.clip, cursor: m.encode?.update?.cursor,
      encode: /brush|voronoi/.test(m.name) ? m.encode : undefined, transform: m.transform, signals: m.signals, from: /voronoi/.test(m.name) ? m.from : undefined,
    },
    ...marksOf(m.marks, `${path}/${m.name}`),
  ])
const scalesOf = (s: any): unknown[] => (s.scales ?? []).map((m: any) => ({ name: m.name, domainRaw: m.domainRaw })).sort((a: any, b: any) => (a.name < b.name ? -1 : 1))
const legendsOf = (s: any): unknown[] => (s.legends ?? []).map((l: any) => l.encode)
/** The order of the marks of a unit: the brush marks sit around the unit's own, the voronoi cells after the first. */
const markOrderOf = (ms: any[] | undefined): unknown[] => (ms ?? []).map((m: any) => [m.name, markOrderOf(m.marks)])

async function compare(spec: Record<string, any>): Promise<void> {
  let oracle: Record<string, any> | undefined
  let refusal: unknown
  try { oracle = (vl as any).compile(plain(spec)).spec } catch (e) { refusal = e }
  if (oracle === undefined) {
    expect(refusal).toBeInstanceOf(Error)
    expect(() => compile(plain(spec) as never), 'vega-lite refuses this spec').toThrow()
    return
  }
  const ours = compile(plain(spec) as never) as Record<string, any>
  expect(signalsOf(ours).map((s: any) => s.name), 'signal names, in order').toEqual(signalsOf(oracle).map((s: any) => s.name))
  expect(signalsOf(ours)).toEqual(signalsOf(oracle))
  expect(storesOf(ours)).toEqual(storesOf(oracle))
  expect(marksOf(ours.marks)).toEqual(marksOf(oracle.marks))
  expect(markOrderOf(ours.marks), 'the order of the marks').toEqual(markOrderOf(oracle.marks))
  expect(scalesOf(ours)).toEqual(scalesOf(oracle))
  expect(legendsOf(ours)).toEqual(legendsOf(oracle))
  const exprDiff = expressionDiff(ours, oracle)
  if (exprDiff !== '') expect.fail(`compiled expressions differ:\n${exprDiff}`)
  // (a bootstrap interval, `ci0` / `ci1`, draws random numbers: each render reads the same seeded stream from its start)
  const ref = await withOracleRandom(() => renderWithVega(oracle))
  const mine = await withOracleRandom(() => renderWithVegaChecked(plain(ours)))
  const refChecked = await withOracleRandom(() => renderWithVegaChecked(oracle))
  const inherited = new Set([...refChecked.errors, ...refChecked.warnings])
  expect([...mine.errors, ...mine.warnings].filter((m) => !inherited.has(m))).toEqual([])
  expect(diffCanonical(canonicalizeSvg(ref), canonicalizeSvg(mine.svg)).slice(0, 2)).toEqual([])
}

for (const [title, cases] of GROUPS) {
  describe(title, () => {
    for (const [name, spec] of cases) it(name, () => compare(spec), 30_000)
  })
}
