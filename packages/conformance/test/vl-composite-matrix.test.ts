// @vitest-environment node
/**
 * Every composite mark (boxplot, errorbar, errorband) x extent x orientation x input form, against vega-lite 6.4.3.
 *
 * A composite mark normalizes to a layer of simple marks over one aggregate transform. For each case the two compilers' output is compared on
 * what that normalization makes observable: the marks (in layer order, with their names, styles, encodes, tooltips and descriptions), the
 * axes (titles), the scales, the legends, the signals; the expression sets; and the SVG real Vega renders from each. The names of the
 * datasets a mark reads, the datasets a group mark carries, and the order of the keys of an object are what the compilers are free to differ in. A spec vega-lite
 * refuses must be refused here (the message is Aster's own).
 */
import { describe, it, expect } from 'vitest'
import * as vl from 'vega-lite'
import { compile } from '@aster/vl'
import { renderWithVega, renderWithVegaChecked } from '../src/render-vega.js'
import { canonicalizeSvg, diffCanonical } from '../src/normalize.js'
import { expressionDiff } from './vl-expressions.js'
import { withOracleRandom } from '../src/gallery/seeded.js'
import { GROUPS } from './vl-composite-matrix-cases.js'

const plain = (v: unknown) => JSON.parse(JSON.stringify(v))

/** The same name on both sides: Aster's name for a field with a path or a space in it carries a hash and has no `.` (names.ts `safeKey`). */
const HASH = /_[0-9a-f]{6}(?![0-9A-Za-z])/g
const sameName = (s: string, side: 'oracle' | 'aster'): string => (side === 'aster' ? s.replace(HASH, '') : s).replace(/\\\./g, '_').replace(/(?<=\w)\.(?=\w)/g, '_')
const canon = (v: unknown, side: 'oracle' | 'aster'): unknown => {
  if (Array.isArray(v)) return v.map((x) => canon(x, side))
  if (typeof v === 'string') return sameName(v, side)
  if (v === null || typeof v !== 'object') return v
  const o = v as Record<string, unknown>
  return Object.fromEntries(Object.keys(o).sort().filter((k) => !(k === 'data' && Array.isArray(o[k]))).map((k) => [k, k === 'from' ? '<from>' : canon(o[k], side)]))
}
const pickSpec = (s: any, side: 'oracle' | 'aster'): unknown => canon(plain({
  marks: s.marks,
  // (Aster names `formatType: "time"` on the axis of a time unit, which vega infers from a time scale)
  axes: (s.axes ?? []).map(({ formatType, ...axis }: any) => (formatType === 'time' ? axis : { ...axis, formatType })),
  scales: (s.scales ?? []).map(({ domain: _d, ...rest }: any) => rest),
  legends: s.legends,
  signals: s.signals,
}), side)




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
  expect(pickSpec(ours, 'aster')).toEqual(pickSpec(oracle, 'oracle'))
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
