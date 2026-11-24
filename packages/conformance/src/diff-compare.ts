/**
 * How conformance:diff (diff.ts, diff-signals.ts) compares the two sides of one step: the incremental path and its reference,
 * each run on its own (audit C193). Nothing is skipped:
 *   - both rendered: they agree when what a host reads of the rendered SVG is the same -- its root, its records and its
 *     accessibility structure (a stale aria-label, role or class on a kept node is a difference);
 *   - one threw: a difference (an incremental path that throws where the reference renders, or the reverse);
 *   - both threw: they agree only on the same error (a refusal both make is agreement, as in every gate).
 */
import type { CanonicalResult } from './normalize.js'

/** One side of a comparison: its value, or the error it threw. */
export type Attempt<T> = { ok: true; value: T } | { ok: false; error: string }

export function attempt<T>(f: () => T): Attempt<T> {
  try {
    return { ok: true, value: f() }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** Whether two canonical renders read the same to a host: root, records and accessibility structure. */
export function sameRender(a: CanonicalResult, b: CanonicalResult): boolean {
  return a.root === b.root && a.records.join('\u0000') === b.records.join('\u0000') && a.structure.join('\n') === b.structure.join('\n')
}

/** The verdict on one step: null when the sides agree, else what differs (`what` names the step). */
export function stepDifference(what: string, inc: Attempt<CanonicalResult>, ref: Attempt<CanonicalResult>): string | null {
  if (inc.ok && ref.ok) return sameRender(inc.value, ref.value) ? null : `${what}: the render differs`
  if (!inc.ok && !ref.ok) return inc.error === ref.error ? null : `${what}: the incremental path threw ${JSON.stringify(inc.error.slice(0, 100))}, the reference ${JSON.stringify(ref.error.slice(0, 100))}`
  return `${what}: only the ${inc.ok ? 'reference' : 'incremental path'} threw (${(inc.ok ? (ref as { error: string }).error : (inc as { error: string }).error).slice(0, 120)})`
}
