/**
 * The nightly's closing step must fail the job on a failed OR skipped check, and pass only when every check passed.
 * A summary that has never been seen to fail proves nothing: each case here runs the real script.
 */
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { summarize } from './nightly-summary.mjs'

const script = join(dirname(fileURLToPath(import.meta.url)), 'nightly-summary.mjs')
const run = (steps) => spawnSync(process.execPath, [script], { encoding: 'utf8', env: { PATH: process.env.PATH, ...(steps === undefined ? {} : { STEPS: JSON.stringify(steps) }) } })
const ok = { outcome: 'success', conclusion: 'success' }

describe('nightly-summary', () => {
  it('passes when every check passed', () => {
    const r = run({ install: ok, gates: ok, fuzz: ok })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('all 3 checks passed')
  })

  it('FAILS, and names the check, when one failed -- the others are still listed', () => {
    const r = run({ install: ok, gates: { outcome: 'failure' }, fuzz: ok })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('gates (failure)')
    expect(r.stdout).toMatch(/PASS\s+fuzz/)
  })

  it('FAILS on a check that was skipped: it did not run, so it did not pass', () => {
    const r = run({ install: { outcome: 'failure' }, gates: { outcome: 'skipped' } })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('gates (skipped)')
  })

  it('refuses to pass on nothing: no STEPS, or an empty context', () => {
    expect(run(undefined).status).toBe(2)
    expect(run({}).status).toBe(2)
  })

  it('summarize lists every step with its outcome', () => {
    expect(summarize({ a: ok, b: { outcome: 'cancelled' } })).toEqual({ rows: [['a', 'success'], ['b', 'cancelled']], bad: ['b (cancelled)'] })
  })
})
