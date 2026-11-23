/**
 * The comparison of the composition-shape tests: a spec through vega-lite 6.4.3 and through @aster-charts/vl, each rendered by real
 * Vega, must draw the same SVG, and Aster's Vega must raise no message that vega-lite's does not. A spec vega-lite refuses, or whose
 * output Vega refuses, must be refused by @aster-charts/vl with a VLCompileError. The names of datasets, signals and scales are the
 * compilers' to choose: only what is drawn is compared.
 */
import { expect } from 'vitest'
import * as vl from 'vega-lite'
import { compile, VLCompileError } from '@aster-charts/vl'
import { renderWithVegaChecked } from '../src/render-vega.js'
import { canonicalizeSvg, diffCanonical } from '../src/normalize.js'

const plain = (v: unknown): any => JSON.parse(JSON.stringify(v))
const quiet = { level: () => quiet, warn: () => quiet, info: () => quiet, debug: () => quiet, error: () => quiet }

/** What vega-lite's output draws, or why there is nothing to match. */
async function oracle(spec: unknown): Promise<{ svg: string; messages: Set<string> } | { refused: string }> {
  let out: Record<string, unknown>
  try {
    out = (vl as any).compile(plain(spec), { logger: quiet }).spec
  } catch (e) {
    return { refused: `vega-lite: ${(e as Error).message}` }
  }
  const r = await renderWithVegaChecked(out)
  if (r.errors.length) return { refused: `vega: ${r.errors.join('; ')}` }
  return { svg: r.svg, messages: new Set(r.warnings) }
}

export async function drawsLikeVegaLite(spec: unknown): Promise<void> {
  const ref = await oracle(spec)
  if ('refused' in ref) {
    expect(() => compile(plain(spec)), `${ref.refused}: @aster-charts/vl must refuse it too`).toThrow(VLCompileError)
    return
  }
  const ours = compile(plain(spec)) as Record<string, unknown>
  const mine = await renderWithVegaChecked(plain(ours))
  expect([...mine.errors, ...mine.warnings].filter((m) => !ref.messages.has(m)), 'Vega messages').toEqual([])
  expect(diffCanonical(canonicalizeSvg(ref.svg), canonicalizeSvg(mine.svg)).slice(0, 3)).toEqual([])
}

/** The name of a generated case: its parts, joined. */
export const caseName = (...parts: Array<string | undefined | false>): string => parts.filter(Boolean).join(' / ')
