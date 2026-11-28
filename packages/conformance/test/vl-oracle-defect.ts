/**
 * DECISIONS Q9 in the parity tests (maintainer, 2026-11-25): where vega-lite's own output demonstrably fails in real Vega or draws nothing,
 * a parity case asserts both that (a) real Vega fails on it, or draws nothing from it, and (b) the compiler throws the typed VLCompileError.
 * The evidence is taken per case, from the render: a case whose vega-lite chart renders is compared as any other, so if vega-lite ever
 * draws one of these, the case fails (the refusal is then a gap to close), and nothing is skipped by name or by kind.
 */
import { renderWithVegaCounted } from '../src/render-vega.js'

/** Why vega-lite's compiled `oracle` is not a chart (Vega fails, or it holds no mark, or its geometry is NaN), or undefined when it draws. */
export async function oracleDefect(oracle: Record<string, unknown>): Promise<string | undefined> {
  let drawn: { svg: string; markItems: number }
  try {
    drawn = await renderWithVegaCounted(JSON.parse(JSON.stringify(oracle)))
  } catch (e) {
    return `real Vega fails on it: ${(e as Error).message.split('\n')[0]}`
  }
  if (drawn.markItems === 0) return 'real Vega draws no mark from it'
  if (/\bNaN\b/.test(drawn.svg)) return 'real Vega draws NaN geometry from it'
  return undefined
}
