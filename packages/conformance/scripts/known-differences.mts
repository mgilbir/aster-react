/**
 * The expected-differences table (scripts/lib/expected-differences.mjs) for the vitest differentials.
 *
 * A generated or tabled differential never drops a case it cannot make agree: it names the difference in the one table
 * (gate `test`, case `<file>: <case>`, with the reason) and calls {@link expectKnownDifference} where it compared the two sides.
 * The case is still computed on both sides on every run and must STILL DIFFER, so a fix on either side fails the test until the
 * entry is removed, and {@link expectEveryKnownDifferenceCompared} fails an entry whose case is no longer compared (renamed,
 * deleted). The table therefore names only differences that exist.
 */
import { expect } from 'vitest'
import { EXPECTED_DIFFERENCES } from '../../../scripts/lib/expected-differences.mjs'
import { enc } from './differential-util.mts'

const compared = new Set<string>()
const key = (file: string, name: string): string => `${file}: ${name}`

/** Assert that the table lists `file: name` and that the two sides still differ; return the reason. */
export function expectKnownDifference(file: string, name: string, oracle: unknown, aster: unknown): string {
  const entry = EXPECTED_DIFFERENCES.find((e) => e.gate === 'test' && e.case === key(file, name))
  expect(entry, `${key(file, name)} is not in scripts/lib/expected-differences.mjs`).toBeDefined()
  compared.add(key(file, name))
  expect(JSON.stringify(enc(aster)), `FIXED-GAP ${key(file, name)}: the two sides agree now; remove the entry`).not.toBe(JSON.stringify(enc(oracle)))
  return entry!.reason
}

/** The entries of `file` that were never compared in this run (call it from the file's last test, in a full run). */
export function expectEveryKnownDifferenceCompared(file: string): void {
  const stale = EXPECTED_DIFFERENCES.filter((e) => e.gate === 'test' && e.case.startsWith(`${file}: `) && !compared.has(e.case))
  expect(stale.map((e) => e.case), 'STALE-GAP: listed in expected-differences.mjs but never compared').toEqual([])
}
