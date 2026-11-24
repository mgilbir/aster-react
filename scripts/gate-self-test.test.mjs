/**
 * Every gate of scripts/gates.mjs must be able to fail, and the way it fails is declared in its `verdict`:
 *
 *   - `selfTest`: the script reports to runGate (scripts/lib/run-gate.mjs) and sets no exit code of its own. It is run three
 *     times, narrowed to a few cases: as is (it must pass: the control, so a failure below cannot come from the harness or
 *     the cases), with --plant-difference (it must fail and name a DIFFERS case: the comparator and the exit path can fail),
 *     and narrowed to nothing (it must fail on its FLOOR: zero cases is not a pass).
 *   - `proof`: a tool with its own exit status (tsc, knip, vitest), or a test file that exercises the gate's failure paths.
 *   - `exits`: a measuring script; it must at least have a failing exit path.
 *
 * Needs `pnpm build` (the gates judge dist; the `build` gate runs before `test`) and Playwright Chromium.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { GATES } from './gates.mjs'
import { spawnAsync } from './lib/spawn-async.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(join(root, rel), 'utf8')
const PACKAGES = {
  '@aster-charts/conformance': 'packages/conformance',
  '@aster-charts/react': 'packages/react',
  '@aster-charts/benchmarks': 'packages/benchmarks',
}
const rootPkg = JSON.parse(read('package.json'))
const empty = mkdtempSync(join(tmpdir(), 'aster-gate-self-test-'))
afterAll(() => rmSync(empty, { recursive: true, force: true }))

/** The package directory, script file and fixed arguments a gate runs (`tsx <file> <args>` in a package's scripts). */
function scriptOf(gate) {
  let pkg
  let name
  if (gate.args[0] === '--filter') [pkg, name] = [gate.args[1], gate.args[3]]
  else {
    const cmd = rootPkg.scripts[gate.args[0]]
    const m = /^pnpm --filter (\S+) run (\S+)$/.exec(cmd ?? '')
    if (!m) return null
    ;[pkg, name] = [m[1], m[2]]
  }
  const dir = PACKAGES[pkg]
  const cmd = JSON.parse(read(`${dir}/package.json`)).scripts[name]
  const m = /^tsx (\S+)((?: --[\w-]+(?:=\S+)?)*)$/.exec(cmd ?? '')
  if (!m) return null
  // (the fixed options a script always needs, such as --replay; not the floors, which a narrowed run does not apply)
  const fixed = m[2].trim().split(/\s+/).filter((a) => a && !/^--(min|max)-/.test(a))
  return { dir, file: `${dir}/${m[1]}`, fixed }
}

async function runScript(s, run, extra = []) {
  const args = (run.args ?? []).map((a) => a.replace('<empty>', empty))
  const r = await spawnAsync('npx', ['tsx', s.file.slice(s.dir.length + 1), ...s.fixed, ...args, ...extra], {
    cwd: join(root, s.dir), env: { ...process.env, ...(run.env ?? {}) }, timeout: 900_000,
  })
  return { code: r.status, out: `${r.stdout}${r.stderr}` }
}

describe('every gate declares how it fails', () => {
  it('each gate has a verdict of one known kind', () => {
    for (const g of GATES) {
      const kinds = Object.keys(g.verdict ?? {})
      expect(kinds.length === 1 && ['selfTest', 'proof', 'exits'].includes(kinds[0]), `${g.name}: ${JSON.stringify(g.verdict)}`).toBe(true)
    }
  })

  it('a gate whose script reports to runGate is self-tested, and sets no exit code of its own', () => {
    for (const g of GATES) {
      const s = scriptOf(g)
      if (!s) continue
      const src = read(s.file)
      const usesRunGate = /from '[./]*scripts\/lib\/run-gate\.mjs'/.test(src) && /\brunGate\(/.test(src)
      if ('selfTest' in g.verdict) {
        expect(usesRunGate, `${g.name}: ${s.file} must report to runGate`).toBe(true)
        // (only bad usage exits on its own: 2)
        const exits = [...src.matchAll(/process\.exit\(([^)]*)\)|process\.exitCode\s*=/g)].filter((m) => m[1] !== '2')
        expect(exits.map((m) => m[0]), `${g.name}: ${s.file} sets its own exit code`).toEqual([])
      } else {
        expect(usesRunGate, `${g.name}: ${s.file} reports to runGate, so it must be self-tested (verdict.selfTest)`).toBe(false)
      }
    }
  })

  it('a `proof` names an existing test file, or the gate is a tool with an exit status of its own', () => {
    for (const g of GATES.filter((x) => 'proof' in x.verdict)) {
      const p = g.verdict.proof
      if (/\.(m?[jt]s|tsx)$/.test(p)) {
        expect(existsSync(join(root, p)), `${g.name}: ${p}`).toBe(true)
        expect(p, `${g.name}: a proof is a test file`).toMatch(/\.test\./)
      } else {
        expect(['build', 'knip', 'typecheck', 'test'], `${g.name}: only a tool gate proves itself by its exit status`).toContain(g.name)
        expect(rootPkg.scripts[g.args[0]], g.name).toMatch(/^(pnpm -r (build|typecheck)|knip\b|vitest\b)/)
      }
    }
  })

  it('an `exits` script has a failing exit path', () => {
    for (const g of GATES.filter((x) => 'exits' in x.verdict)) {
      expect(read(g.verdict.exits), `${g.name}: ${g.verdict.exits}`).toMatch(/process\.exit\(1\)|process\.exitCode = (1|\w+ \? 1 : 0)/)
    }
  })
})

describe('each self-tested gate passes its control, fails a planted difference and fails on zero cases', () => {
  for (const g of GATES.filter((x) => 'selfTest' in x.verdict)) {
    const { narrow, none, noneWhy } = g.verdict.selfTest
    const s = scriptOf(g)
    it.concurrent(g.name, { timeout: 1_800_000 }, async () => {
      expect(s, `${g.name}: the gate runs \`tsx <script>\` in a package`).not.toBeNull()
      const control = await runScript(s, narrow)
      expect(control.code, `${g.name} control:\n${control.out.slice(-3000)}`).toBe(0)
      expect(control.out).toMatch(new RegExp(`\\[${g.name}\\] PASS:`))
      const planted = await runScript(s, narrow, ['--plant-difference'])
      expect(planted.code, `${g.name} planted:\n${planted.out.slice(-3000)}`).toBe(1)
      expect(planted.out).toMatch(new RegExp(`\\[${g.name}\\] DIFFERS `))
      if (none === null) {
        expect(noneWhy, `${g.name}: a gate that cannot be narrowed to nothing says why`).toMatch(/\w+(\s+\w+){3,}/)
        return
      }
      const zero = await runScript(s, none)
      expect(zero.code, `${g.name} zero cases:\n${zero.out.slice(-3000)}`).toBe(1)
      expect(zero.out).toMatch(new RegExp(`\\[${g.name}\\] FLOOR `))
    })
  }
})
