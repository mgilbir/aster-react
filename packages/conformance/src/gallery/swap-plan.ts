/**
 * What the spec-swap path runs: the COMMITTED pair list (gallery/swap-pairs.txt), checked against the current listing and the
 * current fresh-mount passing list. Pure (no browser, no fs), so the logic is tested on its own (swap-plan.test.ts).
 *
 * The list is an artifact, not a function of the passing lists: when another change raises or lowers them, the same pairs are
 * run. A pair whose B does not pass a fresh mount today (or whose A / B left the gallery) is SKIPPED with a reason and
 * reported, never counted as a swap regression -- the static and react ratchets already catch a fresh-mount regression. The
 * sample cannot erode silently: fewer runnable pairs than the floor fails the gate.
 */
export interface SwapSkip { id: string; reason: string }
export interface SwapPlan<S extends { id: string }> {
  runnable: Array<{ id: string; a: S; b: S }>
  skipped: SwapSkip[]
}

export function parsePairId(id: string): [string, string] {
  const parts = id.split(' => ')
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error(`swap-pairs.txt: "${id}" is not "A => B"`)
  return [parts[0], parts[1]]
}

/**
 * `byId`: the gallery listing; `passing`: the specs a fresh mount passes today (passing-react.txt).
 * A needs only to exist (it is the live spec that gets replaced; one that a fresh mount does not match is still a fine "old" chart);
 * B must pass fresh, so "equals a fresh mount" and "equals vega" are one claim.
 */
export function planSwap<S extends { id: string }>(ids: readonly string[], byId: ReadonlyMap<string, S>, passing: ReadonlySet<string>): SwapPlan<S> {
  const plan: SwapPlan<S> = { runnable: [], skipped: [] }
  for (const id of ids) {
    const [aId, bId] = parsePairId(id)
    const a = byId.get(aId)
    const b = byId.get(bId)
    if (!a) plan.skipped.push({ id, reason: `A (${aId}) is no longer in the gallery` })
    else if (!b) plan.skipped.push({ id, reason: `B (${bId}) is no longer in the gallery` })
    else if (!passing.has(bId)) plan.skipped.push({ id, reason: 'B no longer passes fresh' })
    else plan.runnable.push({ id, a, b })
  }
  return plan
}

/** The problems a plan and its results make for the gate (empty = holds). `results`: status per runnable pair id. */
export function swapGateProblems(plan: SwapPlan<{ id: string }>, results: ReadonlyMap<string, string>, minRunnable: number): string[] {
  const problems: string[] = []
  if (plan.runnable.length < minRunnable) problems.push(`swap: ${plan.runnable.length} runnable pairs < floor ${minRunnable} (${plan.skipped.length} skipped)`)
  const bad = plan.runnable.filter((p) => results.get(p.id) !== 'pass')
  if (bad.length) problems.push(`swap: ${bad.length} runnable pair(s) did not pass: ${bad.map((p) => `${p.id} [${results.get(p.id) ?? 'not run'}]`).join(', ')}`)
  return problems
}
