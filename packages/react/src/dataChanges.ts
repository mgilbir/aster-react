/**
 * Validation for the `dataChanges` prop (per-datum differential updates).
 *
 * The differential path trusts the host: an index outside the row array, a
 * fractional index, or a dataset whose length changed would make the runtime
 * reuse stale scene items and the chart would keep showing old values. Anything
 * the host did not state correctly is dropped (the full
 * re-encode is always correct) and reported, instead of being accepted silently.
 * One bad dataset drops the whole changeset: a changeset that omits a dataset
 * tells the runtime that dataset did not change.
 */

export interface DataChangesValidation {
  /** The changeset when every dataset passed; otherwise undefined (full diff). */
  changes: Record<string, number[]> | undefined
  /** Human-readable problems, one per rejected dataset. */
  problems: string[]
}

/**
 * @param changes   the host's `dataChanges`
 * @param data      the `data` prop the changes refer to
 * @param prevLengths row counts of the previously evaluated `data` (changes
 *                  are only valid for an unchanged length/order)
 */
export function validateDataChanges(
  changes: Record<string, number[]> | undefined,
  data: Record<string, unknown[]> | undefined,
  prevLengths: ReadonlyMap<string, number>,
): DataChangesValidation {
  if (changes == null) return { changes: undefined, problems: [] }
  const out: Record<string, number[]> = {}
  const problems: string[] = []
  for (const [name, indices] of Object.entries(changes)) {
    const rows = data?.[name]
    if (!Array.isArray(rows)) {
      problems.push(`dataChanges["${name}"]: no "${name}" array in the data prop`)
      continue
    }
    if (!Array.isArray(indices)) {
      problems.push(`dataChanges["${name}"]: expected an array of row indices`)
      continue
    }
    const prev = prevLengths.get(name)
    if (prev !== undefined && prev !== rows.length) {
      problems.push(`dataChanges["${name}"]: row count changed (${prev} -> ${rows.length}); per-datum changes need an unchanged length/order`)
      continue
    }
    // (by position, not by value: `find` returns the element, so an `undefined` element -- or a hole, which every array method
    // but a plain loop skips -- read as "nothing bad", C101)
    let bad = -1
    for (let k = 0; k < indices.length; k++) {
      const i: unknown = indices[k]
      if (!Number.isInteger(i) || (i as number) < 0 || (i as number) >= rows.length) { bad = k; break }
    }
    if (bad !== -1) {
      const what = bad in indices ? String(indices[bad]) : 'a hole'
      problems.push(`dataChanges["${name}"]: index ${what} (at position ${bad}) is not an integer in [0, ${rows.length})`)
      continue
    }
    out[name] = indices
  }
  return { changes: problems.length === 0 && Object.keys(out).length ? out : undefined, problems }
}
