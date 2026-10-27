/**
 * run-sweep must never pass vacuously or reclassify an Aster failure.
 * Drives the real CLI against synthetic sweeps (test-fixtures/sweep-fixture.mjs).
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { spawnAsync } from '../../../scripts/lib/spawn-async.mjs'

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..')
const SWEEP = '../../test-fixtures/sweep-fixture'
const OK = ['--floor', '1', '--min-ok', '0', '--max-node-error', '0']

async function sweep(fixture, ...args) {
  const r = await spawnAsync('npx', ['tsx', 'src/run-sweep.ts', SWEEP, ...args], {
    cwd: pkg, encoding: 'utf8', env: { ...process.env, FIXTURE: fixture }, timeout: 120_000,
  })
  return { code: r.status, out: r.stdout + r.stderr }
}

describe('run-sweep verdicts', { timeout: 60_000 }, () => {
  it('control: a clean sweep with sane floors passes', async () => {
    const r = await sweep('good', '--floor', '2', '--min-ok', '2', '--max-node-error', '0')
    expect(r.code, r.out).toBe(0)
    expect(r.out).toMatch(/2 ok/)
  })

  it('requires floors: no flags is a usage error, not a pass', async () => {
    const r = await sweep('good')
    expect(r.code, r.out).toBe(2)
    expect(r.out).toMatch(/--floor is required/)
  })

  it('rejects a non-numeric floor (NaN compares false against everything)', async () => {
    const r = await sweep('good', '--floor', 'abc', '--min-ok', '0', '--max-node-error', '0')
    expect(r.code, r.out).toBe(2)
  })

  it('fails when the generated count is under the floor', async () => {
    const r = await sweep('good', '--floor', '3', '--min-ok', '0', '--max-node-error', '0')
    expect(r.code, r.out).toBe(1)
    expect(r.out).toMatch(/FLOOR FAILED/)
  })

  it('fails when a --filter typo matches no case', async () => {
    const r = await sweep('good', '--filter', 'zzz-no-such-case')
    expect(r.code, r.out).toBe(1)
    expect(r.out).toMatch(/NO CASES RAN/)
  })

  it('fails when fewer comparisons are ok than --min-ok', async () => {
    const r = await sweep('good', '--floor', '1', '--min-ok', '3', '--max-node-error', '0')
    expect(r.code, r.out).toBe(1)
    expect(r.out).toMatch(/OK FLOOR FAILED/)
  })

  it('fails on an Aster crash', async () => {
    const r = await sweep('plain-crash', ...OK)
    expect(r.code, r.out).toBe(1)
    expect(r.out).toMatch(/\[engine-error\] x-plain/)
  })

  it('does NOT mask an Aster crash on a ci0/ci1 case as nondeterministic', async () => {
    const r = await sweep('ci-crash', ...OK)
    expect(r.code, r.out).toBe(1)
    expect(r.out).toMatch(/\[engine-error\] x-aggregate-ci0/)
    expect(r.out).toMatch(/1 engine-error, 0 differ, 0 nondeterministic/)
  })

  it('still tolerates genuinely random oracle output on a ci case', async () => {
    const r = await sweep('ci-random', ...OK)
    expect(r.code, r.out).toBe(0)
    expect(r.out).toMatch(/1 nondeterministic/)
  })

  it('does NOT mask a real difference on a ci case when the oracle is deterministic', async () => {
    const r = await sweep('ci-differ', ...OK)
    expect(r.code, r.out).toBe(1)
    expect(r.out).toMatch(/\[differ\] x-aggregate-ci0/)
    expect(r.out).toMatch(/0 nondeterministic/)
  })

  it('an oracle document nobody can judge is an oracle-side failure, held to the node-error ceiling', async () => {
    const over = await sweep('oracle-unjudgeable', '--floor', '2', '--min-ok', '1', '--max-node-error', '0')
    expect(over.code, over.out).toBe(1)
    expect(over.out).toMatch(/\[node-error\] sideways: the oracle's own document cannot be judged/)
    expect(over.out).toMatch(/NODE-ERROR CEILING EXCEEDED/)
    const within = await sweep('oracle-unjudgeable', '--floor', '2', '--min-ok', '1', '--max-node-error', '1')
    expect(within.code, within.out).toBe(0)
  })

  it('an engine document the canonicalizer cannot judge is still a difference', async () => {
    const r = await sweep('ours-unjudgeable', '--floor', '1', '--min-ok', '0', '--max-node-error', '5')
    expect(r.code, r.out).toBe(1)
    expect(r.out).toMatch(/\[differ\] sideways .*canonicalizer cannot judge/)
  })

  it('counts oracle-side node-errors against a ceiling', async () => {
    const over = await sweep('node-error', '--floor', '2', '--min-ok', '1', '--max-node-error', '0')
    expect(over.code, over.out).toBe(1)
    expect(over.out).toMatch(/NODE-ERROR CEILING EXCEEDED/)
    const within = await sweep('node-error', '--floor', '2', '--min-ok', '1', '--max-node-error', '1')
    expect(within.code, within.out).toBe(0)
  })

  it('a signal write the engine renders like vega is ok', async () => {
    const r = await sweep('write-ok', '--floor', '1', '--min-ok', '1', '--max-node-error', '0')
    expect(r.code, r.out).toBe(0)
    expect(r.out).toMatch(/1 ok, 0 retained/)
  })

  it('writes reach the engine: an engine that differs from both vega renders is a difference', async () => {
    const r = await sweep('write-differ', '--floor', '1', '--min-ok', '0', '--max-node-error', '0', '--max-retained', '1')
    expect(r.code, r.out).toBe(1)
    expect(r.out).toMatch(/0 retained/)
    expect(r.out).toMatch(/1 differ/)
  })

  it("counts cases where vega's own second render differs from its fresh one against a ceiling", async () => {
    const over = await sweep('write-retained', '--floor', '1', '--min-ok', '0', '--max-node-error', '0', '--max-retained', '0')
    expect(over.code, over.out).toBe(1)
    expect(over.out).toMatch(/1 retained/)
    expect(over.out).toMatch(/RETAINED CEILING EXCEEDED/)
    const within = await sweep('write-retained', '--floor', '1', '--min-ok', '0', '--max-node-error', '0', '--max-retained', '1')
    expect(within.code, within.out).toBe(0)
  })

  it('retained cases without a ceiling are not a pass', async () => {
    const r = await sweep('write-retained', '--floor', '1', '--min-ok', '0', '--max-node-error', '0')
    expect(r.code, r.out).toBe(1)
    expect(r.out).toMatch(/no --max-retained ceiling/)
  })
})
