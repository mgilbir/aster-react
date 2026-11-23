/**
 * The probes under packages/benchmarks/scripts/probes/ are the commands docs/PERFORMANCE.md prints beside its before/after pairs (C370):
 * each must run against a built tree, take the tree as its first argument and refuse to run without one. Sizes are small here; the
 * figures belong to the documented sizes. Needs `pnpm build`.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { spawnAsync } from './lib/spawn-async.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dir = join(root, 'packages', 'benchmarks', 'scripts', 'probes')
const probe = (name, ...args) => spawnAsync(process.execPath, [join(dir, name), ...args], { cwd: root, timeout: 150_000 })

/** Probe file -> arguments after the tree that keep the run short. */
const SMALL = {
  'fit-view-update.mjs': ['1'],
  'time-tick.mjs': [],
  'selection-reuse.mjs': [],
  'selection-fit.mjs': [],
  'selection-unread.mjs': [],
  'discrete-scale-appends.mjs': ['500', '3'],
  'group-marks.mjs': ['500', '3'],
}

describe('the probes of docs/PERFORMANCE.md', () => {
  const doc = readFileSync(join(root, 'docs', 'PERFORMANCE.md'), 'utf8')
  const files = readdirSync(dir).filter((f) => f.endsWith('.mjs') && f !== 'tree-root.mjs')

  it('every probe file is named by the doc, every probe path the doc prints exists, and each has an entry in this test', () => {
    for (const f of files) expect(doc.includes(f), `${f} is not named in docs/PERFORMANCE.md`).toBe(true)
    for (const m of doc.matchAll(/packages\/benchmarks\/scripts\/probes\/([\w-]+\.mjs)/g)) expect(files, `the doc prints a probe that does not exist: ${m[1]}`).toContain(m[1])
    expect(doc).not.toMatch(/probes? kept outside the repository/)
    for (const f of files) expect(Object.keys(SMALL).concat('selection-drag.mjs'), `${f} needs an entry in this test`).toContain(f)
  })

  for (const [name, args] of Object.entries(SMALL)) {
    it(`${name} runs on this tree`, async () => {
      const r = await probe(name, '.', ...args)
      expect(r.status, r.stderr).toBe(0)
      expect(r.stdout.trim().length).toBeGreaterThan(20)
    }, 160_000)
  }

  it('refuses to run without a tree, or on one that is not built', async () => {
    const none = await probe('time-tick.mjs')
    expect(none.status).toBe(2)
    expect(none.stderr).toMatch(/usage: node <probe>\.mjs <built worktree/)
    const empty = await probe('time-tick.mjs', join(root, 'docs'))
    expect(empty.status).toBe(2)
    expect(empty.stderr).toMatch(/dist is missing/)
  })
})
