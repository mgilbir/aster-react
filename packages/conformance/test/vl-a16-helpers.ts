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

/** The names of the datasets a spec defines, and the ones its marks and scales read: vega parses a spec that reads a dataset nothing defines. */
function datasetRefs(vg: Record<string, any>): { defined: Set<string>; read: Set<string> } {
  const defined = new Set<string>()
  const read = new Set<string>()
  const walk = (o: unknown): void => {
    if (Array.isArray(o)) { o.forEach(walk); return }
    if (o === null || typeof o !== 'object') return
    const r = o as Record<string, any>
    if (Array.isArray(r.data)) for (const d of r.data) if (d?.name) defined.add(d.name)
    if (r.from?.facet?.name) defined.add(r.from.facet.name)
    // (a named mark is a dataset of its scope too)
    if (typeof r.name === 'string' && typeof r.type === 'string' && r.encode !== undefined) defined.add(r.name)
    if (typeof r.from?.data === 'string') read.add(r.from.data)
    if (typeof r.from?.facet?.data === 'string') read.add(r.from.facet.data)
    if (typeof r.data === 'string') read.add(r.data)
    for (const [k, x] of Object.entries(r)) if (k !== 'values') walk(x)
  }
  walk(vg)
  return { defined, read }
}

/** Whether vega runs the Vega without logging an error and without reading a dataset nothing defines (the oracle's own output may not run). */
export async function runs(vg: Record<string, any>): Promise<boolean> {
  const { defined, read } = datasetRefs(vg)
  if ([...read].some((name) => !defined.has(name))) return false
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

export { pick, stream } from './vl-a16-rng.js'
