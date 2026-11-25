/**
 * The expected-differences table (scripts/lib/expected-differences.mjs, gate `test`) for the vitest differentials of `src/`.
 *
 * A difference an oracle comparison here does not make agree is never dropped: it is named in the one table (gate `test`, case
 * `<file>: <case>`, with the reason) and the test calls {@link expectKnownDifference} where it compared the two sides. The case is still
 * computed on both sides on every run and must STILL DIFFER, so a fix on either side fails the test (`FIXED-GAP`) until the entry is
 * removed. (The differentials of `scripts/` serve the same table through a helper of their own: the build of `src/` cannot import a `.mts`.)
 */
import { expect } from 'vitest'
import { EXPECTED_DIFFERENCES } from '../../../scripts/lib/expected-differences.mjs'

const key = (file: string, name: string): string => `${file}: ${name}`

/** Assert that the table lists `file: name` and that the two sides (plain values: documents, outcomes) still differ; return the reason. */
export function expectKnownDifference(file: string, name: string, oracle: unknown, aster: unknown): string {
  const entry = EXPECTED_DIFFERENCES.find((e) => e.gate === 'test' && e.case === key(file, name))
  expect(entry, `${key(file, name)} is not in scripts/lib/expected-differences.mjs`).toBeDefined()
  expect(JSON.stringify(aster), `FIXED-GAP ${key(file, name)}: the two sides agree now; remove the entry`).not.toBe(JSON.stringify(oracle))
  return entry!.reason
}
