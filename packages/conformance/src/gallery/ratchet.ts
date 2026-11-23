/**
 * The gallery ratchet files against their own history (C262).
 *
 * `run.ts` compares a run with `floors.json`, the passing lists and the manifest, and nothing compares those files with what they
 * were: a change that lowers a floor, deletes ids from a passing list, drops specs from the manifest (the cache key and the spec count
 * both come from it) or points `repo` / `commit` somewhere else leaves a green nightly. The PR CI does not run the gallery, so this is
 * the part of the ratchet that runs there: a pure comparison of a snapshot of the files at the base with one of them now.
 */
import type { Manifest } from './cache.js'

export interface RatchetSnapshot {
  floors: {
    pass: Record<string, Record<string, number>>
    maxUnverifiable: Record<string, Record<string, number>>
    swap: { minRunnable: number; maxUnverifiable: number }
  }
  /** passing-<path>.txt, by path (`static`, `react`) */
  passing: Record<string, readonly string[]>
  /** swap-pairs.txt: one `A => B` per entry */
  swapPairs: readonly string[]
  manifest: Pick<Manifest, 'sources'>
}

/** A deliberate, reviewed change the ratchet may not refuse: what moved, to what, and why. Lives in gallery/ratchet-overrides.json. */
export interface RatchetOverride {
  /** the field: `floors.maxUnverifiable.react.vega`, `manifest.vega.commit`, `manifest.vega.files`, `passing.static`, ... */
  field: string
  /** the value (or count) the change moves it to; the override covers that change and no other */
  to: string | number
  reason: string
}

export function parseLines(text: string): string[] {
  return text.split('\n').filter(Boolean)
}

/**
 * The ways `now` weakens `base`: a floor lowered, a ceiling of unverifiable specs raised, a passing id gone, the swap sample eroded
 * (its floor below the pair count, or fewer pairs than there were), a source with fewer files, another repo or commit. An override
 * names one such change by its field and its new value and gives a reason; it covers nothing else.
 */
export function ratchetProblems(base: RatchetSnapshot, now: RatchetSnapshot, overrides: readonly RatchetOverride[] = []): string[] {
  const problems: string[] = []
  const allowed = (field: string, to: string | number): boolean => overrides.some((o) => o.field === field && o.to === to && o.reason.trim().length >= 20)
  const weaker = (field: string, to: string | number, message: string): void => {
    if (!allowed(field, to)) problems.push(`${field}: ${message} (an intended change is recorded in gallery/ratchet-overrides.json with a reason)`)
  }

  for (const [path, kinds] of Object.entries(base.floors.pass)) {
    for (const [kind, floor] of Object.entries(kinds)) {
      const now_ = now.floors.pass[path]?.[kind]
      if (now_ === undefined || now_ < floor) weaker(`floors.pass.${path}.${kind}`, now_ ?? 'missing', `the floor went from ${floor} to ${now_ ?? 'nothing'}: a floor only goes up`)
    }
  }
  for (const [path, kinds] of Object.entries(base.floors.maxUnverifiable)) {
    for (const [kind, ceiling] of Object.entries(kinds)) {
      const now_ = now.floors.maxUnverifiable[path]?.[kind]
      if (now_ === undefined || now_ > ceiling) weaker(`floors.maxUnverifiable.${path}.${kind}`, now_ ?? 'missing', `the ceiling of unverifiable specs went from ${ceiling} to ${now_ ?? 'nothing'}: it only goes down`)
    }
  }
  if (now.floors.swap.minRunnable < base.floors.swap.minRunnable) weaker('floors.swap.minRunnable', now.floors.swap.minRunnable, `went from ${base.floors.swap.minRunnable} to ${now.floors.swap.minRunnable}`)
  if (now.floors.swap.maxUnverifiable > base.floors.swap.maxUnverifiable) weaker('floors.swap.maxUnverifiable', now.floors.swap.maxUnverifiable, `went from ${base.floors.swap.maxUnverifiable} to ${now.floors.swap.maxUnverifiable}`)

  for (const [path, ids] of Object.entries(base.passing)) {
    const kept = new Set(now.passing[path] ?? [])
    const gone = ids.filter((id) => !kept.has(id))
    if (gone.length) weaker(`passing.${path}`, kept.size, `${gone.length} spec(s) left the list of passing specs: ${gone.slice(0, 5).join(', ')}${gone.length > 5 ? ', ...' : ''}`)
  }
  // (the swap sample cannot erode: every committed pair is a runnable pair, so the floor IS the pair count)
  if (now.floors.swap.minRunnable !== now.swapPairs.length) weaker('floors.swap.minRunnable', now.floors.swap.minRunnable, `${now.swapPairs.length} pairs are committed and ${now.floors.swap.minRunnable} must run: a pair that is skipped is a sample that eroded`)
  const pairs = new Set(now.swapPairs)
  const dropped = base.swapPairs.filter((p) => !pairs.has(p))
  if (dropped.length) weaker('swapPairs', pairs.size, `${dropped.length} committed pair(s) left swap-pairs.txt: ${dropped.slice(0, 3).join('; ')}`)

  for (const [name, source] of Object.entries(base.manifest.sources)) {
    const next = now.manifest.sources[name]
    if (!next) { weaker(`manifest.${name}`, 'missing', 'the source left the manifest'); continue }
    for (const key of ['repo', 'commit'] as const) {
      if (next[key] !== source[key]) weaker(`manifest.${name}.${key}`, next[key], `moved from ${source[key]} to ${next[key]}: the gallery is the one the oracle is pinned to`)
    }
    const before = Object.keys(source.files).length
    const after = Object.keys(next.files).length
    if (after < before) weaker(`manifest.${name}.files`, after, `${before} spec files became ${after}: specs cannot leave the denominator`)
    const changed = Object.entries(source.files).filter(([f, hash]) => next.files[f] !== undefined && next.files[f] !== hash).map(([f]) => f)
    if (changed.length) weaker(`manifest.${name}.hashes`, changed.length, `${changed.length} spec file(s) have another hash: ${changed.slice(0, 3).join(', ')}`)
  }
  return problems
}

/** Spec files with byte-identical content (the manifest hashes every file): they count twice in the denominator and are one spec. */
export function duplicateSpecs(manifest: Pick<Manifest, 'sources'>): string[][] {
  const byHash = new Map<string, string[]>()
  for (const [name, source] of Object.entries(manifest.sources)) {
    for (const [file, hash] of Object.entries(source.files)) byHash.set(hash, [...(byHash.get(hash) ?? []), `${name}/${file}`])
  }
  return [...byHash.values()].filter((g) => g.length > 1).map((g) => g.sort()).sort()
}
