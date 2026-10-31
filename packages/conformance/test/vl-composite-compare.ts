// @vitest-environment node
/** The comparison of the composite-mark tests: one spec through vega-lite and through Aster, on the marks, axes, scales, legends and signals, the expressions and the SVG. */
import { expect } from 'vitest'
import * as vl from 'vega-lite'
import { compile } from '@aster/vl'
import { renderWithVega, renderWithVegaChecked } from '../src/render-vega.js'
import { canonicalizeSvg, diffCanonical } from '../src/normalize.js'
import { expressionDiff } from './vl-expressions.js'
import { withOracleRandom } from '../src/gallery/seeded.js'
import { pickSpec, plain } from './vl-composite-pick.js'


export async function compare(spec: Record<string, any>): Promise<void> {
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
  expect([...mine.errors, ...mine.warnings].filter((m) => !inherited.has(m)), "render messages").toEqual([])
  expect(diffCanonical(canonicalizeSvg(ref), canonicalizeSvg(mine.svg)).slice(0, 2)).toEqual([])
}

