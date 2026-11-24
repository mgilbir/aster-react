/**
 * Comparing the outcomes of a call that either answered or threw, for the live differentials of expression functions (vitest only: the
 * helpers of `differential-util.mts` are also read by scripts that run outside it).
 */
import { expect } from 'vitest'

/**
 * `expect(got).toEqual(want)`, except that where both sides threw and vega's error carries its own words, Aster's message must be
 * those words (an Aster refusal that is the wrong refusal is a difference). Aster's `[aster] ` tag and an `Error: ` prefix are not words.
 */
export function expectSameOutcome(got: unknown, want: unknown, label: string): void {
  const g = got as { $?: string; message?: string } | null
  const w = want as { $?: string; message?: string } | null
  if (g?.$ === 'throw' && w?.$ === 'throw') {
    if (w.message !== undefined) expect(String(g.message).replace(/^\[aster\] /, '').replace(/^Error: /, ''), `${label}: the refusal's words`).toBe(w.message)
    return
  }
  expect(got, label).toEqual(want)
}
