/**
 * A sweep case must reach both sides with a chart to render. A case with no usable spec reads as "both refused", which is
 * agreement, so a generator and a runner that disagree on the field name pass while checking nothing (the values sweep once
 * emitted `specText` while the runner read `spec`: 500 cases, 500 "both refused", PASS).
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { spawnAsync } from '../../../scripts/lib/spawn-async.mjs'
import { generate } from '../src/sweeps/values.mjs'

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..')
const FIXTURE_SWEEP = '../../test-fixtures/sweep-spec-contract'
const OK = ['--floor', '1', '--min-ok', '1', '--max-node-error', '0']

async function sweep(sweepName, fixture, ...args) {
  const r = await spawnAsync('npx', ['tsx', 'src/run-sweep.ts', sweepName, ...args], {
    cwd: pkg, encoding: 'utf8', env: { ...process.env, FIXTURE: fixture }, timeout: 120_000,
  })
  return { code: r.status, out: r.stdout + r.stderr }
}

describe('sweep cases carry a chart', { timeout: 60_000 }, () => {
  it('a case whose chart is JSON text is rendered, not refused', async () => {
    const r = await sweep(FIXTURE_SWEEP, 'spec-text', ...OK)
    expect(r.code, r.out).toBe(0)
    expect(r.out).toMatch(/1 ok, 0 retained, 0 both-refused/)
  })

  for (const fixture of ['no-spec', 'bad-text', 'text-not-an-object']) {
    it(`fails the run before it renders anything: ${fixture}`, async () => {
      const r = await sweep(FIXTURE_SWEEP, fixture, '--floor', '1', '--min-ok', '0', '--max-node-error', '0')
      expect(r.code, r.out).toBe(1)
      expect(r.out).toMatch(/no usable spec/)
      expect(r.out).not.toMatch(/results:/)
    })
  }

  it('every case the values sweep generates has a chart, and its negative zero is still negative zero', () => {
    const { cases } = generate()
    expect(cases.length).toBeGreaterThan(400)
    for (const c of cases) {
      const spec = c.spec ?? JSON.parse(c.specText)
      expect(typeof spec, c.name).toBe('object')
    }
    const zero = cases.filter((c) => c.property === 'with-a-negative-zero')
    expect(zero.length).toBeGreaterThan(5)
    for (const c of zero) {
      const values = JSON.parse(c.specText).data[0].values.map((r) => r.v)
      expect(values.some((v) => Object.is(v, -0)), c.name).toBe(true)
    }
  })
})
