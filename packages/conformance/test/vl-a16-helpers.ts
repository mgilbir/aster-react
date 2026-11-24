// @vitest-environment node
/**
 * The comparison of the a16 differentials: one Vega-Lite spec through vega-lite 6.4.3 and through @aster-charts/vl, both outputs run by REAL
 * vega, and the pictures (canonical SVG), the tooltips and what vega logs compared. A spec vega-lite refuses must be refused here.
 */
import { expect } from 'vitest'
import * as vl from 'vega-lite'
import { compile, VLCompileError } from '@aster-charts/vl'
import { renderWithVegaChecked } from '../src/render-vega.js'
import { canonicalizeSvg, diffCanonical } from '../src/normalize.js'
import { withOracleRandom } from '../src/gallery/seeded.js'

export const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v))

const quiet = { level() { return quiet }, warn() { return quiet }, info() { return quiet }, debug() { return quiet }, error() { return quiet } }

/** What vega-lite makes of a spec: its Vega, or the error it threw. */
export function oracleOf(spec: Record<string, any>): { vega: Record<string, any> } | { refused: unknown } {
  try { return { vega: (vl as any).compile(plain(spec), { logger: quiet }).spec } } catch (e) { return { refused: e } }
}

/** Whether vega runs the Vega without logging an error (the oracle's own output may not run). */
export async function runs(vg: Record<string, any>): Promise<boolean> {
  const r = await withOracleRandom(() => renderWithVegaChecked(plain(vg)))
  return r.errors.length === 0
}

/**
 * Both engines draw the same: the spec compiles in both, vega runs both outputs, and the SVG, the tooltips and the messages vega logs
 * are equal. Vega-lite refusing the spec (or its output not running in vega) is the case where Aster must refuse it.
 */
export async function sameDrawing(spec: Record<string, any>): Promise<void> {
  const oracle = oracleOf(spec)
  if ('refused' in oracle) {
    expect(() => compile(plain(spec) as never), 'vega-lite refuses this spec').toThrow(VLCompileError)
    return
  }
  const ref = await withOracleRandom(() => renderWithVegaChecked(plain(oracle.vega)))
  if (ref.errors.length > 0) {
    // (vega-lite's own output does not run: there is no picture to match; the spec must be refused, not drawn wrong)
    expect(() => compile(plain(spec) as never), `vega-lite's output does not run in vega: ${ref.errors[0]}`).toThrow(VLCompileError)
    return
  }
  const ours = compile(plain(spec) as never)
  const mine = await withOracleRandom(() => renderWithVegaChecked(plain(ours) as Record<string, unknown>))
  expect(mine.errors, 'vega logs no error for Aster\'s output').toEqual([])
  // (a field Aster flattens is named by a safe key with a hash where vega-lite writes the path: the messages name the same field)
  const canon = (m: string): string => m.replace(/_[0-9a-f]{6}(?![0-9A-Za-z])/g, '').replace(/\\\./g, '_').replace(/(?<=\w)\.(?=\w)/g, '_').replace(/_+/g, '_')
  const inherited = new Set(ref.warnings.map(canon))
  expect(mine.warnings.filter((m) => !inherited.has(canon(m))), 'vega logs nothing new for Aster\'s output').toEqual([])
  expect(diffCanonical(canonicalizeSvg(ref.svg), canonicalizeSvg(mine.svg)).slice(0, 3)).toEqual([])
  expect(mine.tooltips).toEqual(ref.tooltips)
}

/** mulberry32: a fixed stream, so a failing case names a seed that can be run again. */
export function stream(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
export const pick = <T,>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!
