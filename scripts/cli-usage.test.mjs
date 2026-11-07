/**
 * Every command-line entry point answers `--help` (usage on stdout, exit 0) and rejects an option it does not declare
 * (error and usage on stderr, exit 2) BEFORE it does any work, so a typo such as `--flor 10` cannot be silently ignored.
 * The entry points are the files named by the `package.json` scripts plus the ones the docs and workflows run directly;
 * the last test fails when a script of a `package.json` is missing from the list.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { cli } from './lib/cli.mjs'
import { spawnAsync } from './lib/spawn-async.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** Entry points that are not named by a package.json script: run by a workflow, a prepack hook or a documented command. */
const NOT_IN_PACKAGE_JSON = [
  'scripts/nightly-summary.mjs',
  'scripts/copy-legal.mjs',
  'scripts/check-release-tag.mjs',
  'packages/conformance/scripts/browser-canvas-append.mts',
  'packages/conformance/scripts/browser-canvas-symbols.mts',
  'packages/conformance/scripts/gallery-triage.mts',
  'packages/conformance/scripts/raster-fixtures.mts',
  'packages/conformance/src/diff-vl.ts',
  'packages/conformance/src/show-case.ts',
  'packages/benchmarks/scripts/audit-live-parity.mts',
]

/** The files that package.json scripts run (`node x.mjs`, `tsx x.ts`, `node --import tsx x.tsx`). */
function fromPackageJson() {
  const out = new Set()
  for (const dir of ['.', ...readdirSync(join(ROOT, 'packages')).map((p) => `packages/${p}`)]) {
    const file = join(ROOT, dir, 'package.json')
    if (!existsSync(file)) continue
    for (const cmd of Object.values(JSON.parse(readFileSync(file, 'utf8')).scripts ?? {})) {
      for (const m of cmd.matchAll(/(?:^|\s)((?:\.\.\/)*[\w./-]+\.(?:mjs|mts|ts|tsx))(?=\s|$)/g)) {
        const abs = join(ROOT, dir, m[1])
        if (existsSync(abs)) out.add(abs.slice(ROOT.length + 1))
      }
    }
  }
  return out
}

/** Runs as the `prepack` hook from a scratch copy that holds this one file (scripts/verify-publish.test.mjs), so it answers --help itself. */
const SELF_CONTAINED = 'scripts/copy-legal.mjs'

const CLIS = [...new Set([...fromPackageJson(), ...NOT_IN_PACKAGE_JSON])].sort()

function command(rel) {
  if (!rel.startsWith('packages/')) return [process.execPath, [join(ROOT, rel)]]
  const pkg = rel.split('/').slice(0, 2).join('/')
  return [join(ROOT, pkg, 'node_modules', '.bin', 'tsx'), [join(ROOT, rel)]]
}

async function run(rel, ...args) {
  const [cmd, base] = command(rel)
  const r = await spawnAsync(cmd, [...base, ...args], { cwd: ROOT, timeout: 90_000, env: { ...process.env, STEPS: '' } })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

describe('command-line entry points', { timeout: 120_000 }, () => {
  it('lists the scripts it covers', () => {
    expect(CLIS.length).toBeGreaterThan(30)
    for (const rel of CLIS) expect(existsSync(join(ROOT, rel)), rel).toBe(true)
  })

  it.concurrent.each(CLIS)('%s --help prints the usage and exits 0', async (rel) => {
    for (const flag of ['--help', '-h']) {
      const r = await run(rel, flag)
      expect(r.code, `${rel} ${flag}: ${r.err}`).toBe(0)
      expect(r.out, `${rel} ${flag}`).toMatch(/^Usage: /)
      expect(r.err).toBe('')
    }
  })

  it.concurrent.each(CLIS)('%s rejects an unknown option with exit 2', async (rel) => {
    const r = await run(rel, '--no-such-option')
    expect(r.code, `${rel}: ${r.err}`).toBe(2)
    expect(r.err).toMatch(/unknown option "--no-such-option"/)
    expect(r.err).toMatch(/Usage: /)
    expect(r.out).toBe('')
  })

  it('every script a package.json runs is covered (a new CLI needs cli() from scripts/lib/cli.mjs)', () => {
    for (const rel of fromPackageJson()) {
      if (rel === SELF_CONTAINED) continue
      expect(readFileSync(join(ROOT, rel), 'utf8'), `${rel} does not call cli()`).toMatch(/\bcli\(\{/)
    }
  })

  it('copy-legal stays free of scripts/lib: verify-publish.test.mjs copies that one file into a scratch repository', () => {
    expect(readFileSync(join(ROOT, SELF_CONTAINED), 'utf8')).not.toMatch(/from '\.\/lib\//)
  })
})

describe('cli() argument checking', () => {
  const url = new URL('./gates.mjs', import.meta.url).href
  const check = (argv, flags = { list: 'bool', only: 'value', limit: 'eq', floor: 'both' }) => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((code) => { throw new Error(`exit ${code}`) })
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      cli({ url, flags, argv })
      return 'ok'
    } catch (e) {
      return e.message
    } finally {
      exit.mockRestore()
      log.mockRestore()
    }
  }

  it('accepts every declared form, positionals, a bare -- and dash-leading values', () => {
    expect(check(['--', '--list', '--only', '-x', '--limit=5', '--floor', '3', '--floor=3', 'filter', '-1'])).toBe('ok')
  })

  it('rejects an undeclared option, a wrong attachment and a negated name', () => {
    expect(check(['--bogus'])).toBe('exit 2')
    expect(check(['--limit', '5'])).toBe('exit 2')
    expect(check(['--list=1'])).toBe('exit 2')
    expect(check(['--only=a'])).toBe('exit 2')
    expect(check(['-x'])).toBe('exit 2')
  })

  it('exits 0 on --help even after other arguments', () => {
    expect(check(['--list', '--help'])).toBe('exit 0')
  })
})
