/** Near-miss suggestions for the names a refusal lists (validate.ts, schema.ts). */

/** Optimal string alignment distance (insertions, deletions, substitutions, adjacent transpositions), capped at `max + 1`. */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array<number>(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) d[0]![j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[i - 2]![j - 2]! + 1)
      d[i]![j] = v
    }
  }
  return d[a.length]![b.length]!
}

/**
 * ` (did you mean "x"?)` for a value close to one of `candidates` (case aside, or a few edits away), else ` (expected one of ...)` when
 * the candidates are few enough to list, else nothing.
 */
export function suggest(value: unknown, candidates: Iterable<string>): string {
  const list = [...candidates]
  if (typeof value === 'string' && value !== '') {
    const lower = value.toLowerCase()
    const max = Math.max(1, Math.floor(value.length / 3))
    let best: string | undefined
    let bestD = max + 1
    for (const c of list) {
      const dist = c.toLowerCase() === lower ? 0 : editDistance(lower, c.toLowerCase(), max)
      if (dist < bestD) { best = c; bestD = dist }
    }
    if (best !== undefined) return ` (did you mean "${best}"?)`
  }
  return list.length <= 12 ? ` (expected one of ${list.join(', ')})` : ''
}
