/**
 * The published packages declare `engines.node >= 20`. This test executes the built dist of core, vl and react (server-rendering
 * <Chart> and <SvgChart>) on the Node that runs vitest, in a child process with no test framework: the `unit (node 20)` CI job
 * selects it (scripts/node20-selection.test.mjs requires that), so the Node 20 claim is something a run observes (DECISIONS Q22).
 * Needs `pnpm build`. The engines of all three packages must stay what this job covers.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { spawnAsync } from './lib/spawn-async.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

describe('dist runs on the Node under test', () => {
  it('core renders, vl compiles, react server-renders <Chart> and <SvgChart>', async () => {
    const r = await spawnAsync(process.execPath, [join(ROOT, 'scripts/lib/dist-node-smoke.mjs')], { cwd: ROOT, timeout: 120_000 })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout.trim()).toBe(`ok node ${process.versions.node}`)
  }, 150_000)

  it('the Node floor the packages declare is one a CI job executes dist on', () => {
    const ci = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8')
    const matrix = /node:\s*\[([^\]]+)\]/.exec(ci)?.[1].split(',').map((s) => s.trim()) ?? []
    for (const pkg of ['core', 'react', 'vl']) {
      const floor = /^>=\s*(\d+)$/.exec(JSON.parse(readFileSync(join(ROOT, 'packages', pkg, 'package.json'), 'utf8')).engines.node)?.[1]
      expect(floor, `${pkg} engines.node is ">=<major>"`).toBeDefined()
      expect(matrix, `${pkg} declares Node ${floor}: the unit matrix must run on it`).toContain(floor)
    }
    // and the job that runs on that floor selects this file
    expect(ci).toMatch(/vitest\.mjs run [^\n]*dist-node-smoke\.test/)
  })
})
