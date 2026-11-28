/**
 * The expected-differences table (scripts/lib/expected-differences.mjs, gate `test`) for the vitest differentials of `src/` and `scripts/`.
 *
 * A difference an oracle comparison does not make agree is never dropped: it is named in the one table (gate `test`, case
 * `<file>: <case>`, with the reason) and the test calls {@link expectKnownDifference} where it compared the two sides. The case is still
 * computed on both sides on every run and must STILL DIFFER, so a fix on either side fails the test (`FIXED-GAP`) until the entry is
 * removed, and {@link expectEveryKnownDifferenceCompared} fails an entry whose case is no longer compared (renamed, deleted: `STALE-GAP`).
 * The table therefore names only differences that exist.
 *
 * One helper for both directories: it lives in `src/` because the build of the package (tsconfig.build.json) reads `src/` and cannot import a
 * `.mts`; the differentials of `scripts/` import it with its `.ts` extension and pass their own `encode` (differential-util.mts `enc`, which keeps
 * NaN, -0, dates and the like apart where JSON would conflate them).
 */
import { expect } from 'vitest'
import { EXPECTED_DIFFERENCES } from '../../../scripts/lib/expected-differences.mjs'

const compared = new Set<string>()
const key = (file: string, name: string): string => `${file}: ${name}`

/**
 * Assert that the table lists `file: name` and that the two sides (documents, outcomes) still differ, as `encode` sees them (JSON by
 * default); return the reason.
 */
export function expectKnownDifference(file: string, name: string, oracle: unknown, aster: unknown, encode: (v: unknown) => unknown = (v) => v): string {
  const entry = EXPECTED_DIFFERENCES.find((e) => e.gate === 'test' && e.case === key(file, name))
  expect(entry, `${key(file, name)} is not in scripts/lib/expected-differences.mjs`).toBeDefined()
  compared.add(key(file, name))
  expect(JSON.stringify(encode(aster)), `FIXED-GAP ${key(file, name)}: the two sides agree now; remove the entry`).not.toBe(JSON.stringify(encode(oracle)))
  return entry!.reason
}

/** The entries of `file` that were never compared in this run (call it from the file's last test, in a full run). */
export function expectEveryKnownDifferenceCompared(file: string): void {
  const stale = EXPECTED_DIFFERENCES.filter((e) => e.gate === 'test' && e.case.startsWith(`${file}: `) && !compared.has(e.case))
  expect(stale.map((e) => e.case), 'STALE-GAP: listed in expected-differences.mjs but never compared').toEqual([])
}
