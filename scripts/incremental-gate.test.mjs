/**
 * The `incremental-append` gate (packages/benchmarks/src/incremental.bench.tsx) must be able to fail (C641): its floors are overrides on the
 * command line, so a floor no run can meet makes it exit 1 and says which floor, and an override that is not a positive number is refused
 * (it used to become NaN or 0 and turn the floor off). Small sizes: this proves the gate bites, not what the floors are.
 * Needs `pnpm build` (the bench reads dist).
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { spawnAsync } from './lib/spawn-async.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const bench = (...args) => spawnAsync(
  process.execPath,
  [join(root, 'packages', 'benchmarks', 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'src/incremental.bench.tsx', '--points=2000', '--reps=10', '--vega=0', '--dense-points=5000', ...args],
  { cwd: join(root, 'packages', 'benchmarks'), timeout: 110_000 },
)
const out = (r) => r.stdout + r.stderr

describe('bench:incremental floors', () => {
  const UNMEETABLE = '1000000000'
  for (const [flag, message] of [
    ['--min-append', /FAIL: incremental append is [\d.]+x cheaper than full re-evaluation; floor 1000000000x/],
    ['--min-replace', /FAIL: whole-array replacement is [\d.]+x cheaper than a full evaluation; floor 1000000000x/],
    ['--min-dom', /FAIL: DOM patching is [\d.]+x cheaper than full SVG serialization; floor 1000000000x/],
    ['--min-dense', /FAIL: a dense append patch is only [\d.]+x cheaper than a full mount \(floor 1000000000x\)/],
  ]) {
    it(`${flag} set to a floor no run can meet exits 1 and names that floor`, async () => {
      const r = await bench(`${flag}=${UNMEETABLE}`)
      expect(r.status, out(r)).toBe(1)
      expect(out(r)).toMatch(message)
    }, 120_000)
  }

  for (const bad of ['abc', '', '0', '-3', 'NaN', 'Infinity', '1e999']) {
    it(`--min-append=${JSON.stringify(bad)} is refused with exit 2 instead of switching the floor off`, async () => {
      const r = await bench(`--min-append=${bad}`)
      expect(r.status, out(r)).toBe(2)
      expect(out(r)).toMatch(/--min-append needs a finite number above 0/)
      expect(out(r)).not.toMatch(/\[incremental\] pass/)
    }, 120_000)
  }

  it('every floor override is validated, not only --min-append', async () => {
    for (const flag of ['--min-replace', '--min-dom', '--min-dense', '--max-append-growth']) {
      const r = await bench(`${flag}=abc`)
      expect(r.status, `${flag}: ${out(r)}`).toBe(2)
    }
  }, 120_000)
})
