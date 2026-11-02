/**
 * The `unit (node 20)` CI job runs only the engine-sensitive, jsdom-free suites: jsdom (through its undici) does not load on
 * Node 20, so a jsdom suite that the job's filter picks up fails there at load time while every other job is green.
 *
 * The filter is the argument list of the job's "Engine-sensitive unit tests (Node 20, no jsdom)" step in ci.yml; this test reads
 * it from there (so it follows the workflow), lists the files vitest selects with it, and requires that none of them asks for
 * the jsdom environment or imports jsdom.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { spawnAsync } from './lib/spawn-async.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** The filters of the Node 20 step: the arguments after `vitest.mjs run`. */
function node20Filters() {
  const ci = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8')
  const step = ci.split(/\n\s*- name: /).find((s) => s.startsWith('Engine-sensitive unit tests (Node 20'))
  expect(step, 'the Node 20 step is in ci.yml').toBeDefined()
  const run = /run:\s*node node_modules\/vitest\/vitest\.mjs run (.+)/.exec(step)
  expect(run, 'the Node 20 step runs vitest with filters').not.toBeNull()
  return run[1].trim().split(/\s+/)
}

const usesJsdom = (source) =>
  /@vitest-environment\s+jsdom/.test(source) || /from\s+['"]jsdom['"]|require\(\s*['"]jsdom['"]\s*\)/.test(source)

describe('the Node 20 job selects only jsdom-free suites', () => {
  it('no file its filter selects asks for jsdom', async () => {
    const filters = node20Filters()
    const r = await spawnAsync(process.execPath, ['node_modules/vitest/vitest.mjs', 'list', '--filesOnly', ...filters], { cwd: ROOT, timeout: 120_000 })
    expect(r.status, r.stderr).toBe(0)
    const files = r.stdout.split('\n').map((l) => l.trim()).filter((l) => /\.(m?[jt]s)$/.test(l))
    expect(files.length, 'the filter selects some suites').toBeGreaterThan(10)
    const offenders = files.filter((f) => usesJsdom(readFileSync(join(ROOT, f), 'utf8')))
    expect(offenders).toEqual([])
  }, 150_000)
})
