/**
 * Structural guards for .github/workflows/release.yml (C77). The workflow is never run
 * by tests; these assert the properties that keep a release safe.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const WF = process.env.ASTER_RELEASE_WORKFLOW ?? join(root, '.github', 'workflows', 'release.yml')
const text = readFileSync(WF, 'utf8')

/** Split the `jobs:` block into { name -> body } (jobs are the 2-space-indented keys). */
function jobs() {
  const at = text.indexOf('\njobs:\n')
  const body = text.slice(at + '\njobs:\n'.length)
  const out = {}
  let cur = null
  for (const line of body.split('\n')) {
    const m = /^ {2}([\w-]+):\s*$/.exec(line)
    if (m) { cur = m[1]; out[cur] = []; continue }
    if (cur) out[cur].push(line)
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.join('\n')]))
}
const topLevel = text.slice(0, text.indexOf('\njobs:\n'))
const stripComments = (s) => s.replace(/^\s*#.*$/gm, '').replace(/\s+#\s.*$/gm, '')
const J = jobs()

describe('release.yml trigger', () => {
  const on = stripComments(topLevel).match(/^on:\n([\s\S]*?)(?=^\S)/m)?.[1] ?? ''
  it('runs on pushed version tags only', () => {
    expect(on).toMatch(/^\s+push:\n\s+tags:/m)
    expect(on).not.toMatch(/workflow_dispatch|workflow_call|pull_request|schedule|branches/)
    const tags = [...on.matchAll(/^\s+- '([^']+)'\s*$/gm)].map((m) => m[1])
    expect(tags.length).toBeGreaterThan(0)
    for (const t of tags) expect(t, 'tag patterns must demand a numeric version').toMatch(/^v\[0-9\]\+\.\[0-9\]\+\.\[0-9\]\+/)
  })
})

describe('release.yml permissions', () => {
  it('is read-only at the top level', () => {
    const perms = stripComments(topLevel).match(/^permissions:\n((?:\s+.+\n)+)/m)?.[1] ?? ''
    expect(perms).toMatch(/contents:\s*read/)
    expect(perms).not.toMatch(/id-token|write/)
  })

  it('grants id-token: write to the publish job only', () => {
    const all = stripComments(text).match(/id-token:\s*write/g) ?? []
    expect(all.length).toBe(1)
    expect(stripComments(J.publish)).toMatch(/id-token:\s*write/)
    for (const [name, body] of Object.entries(J)) if (name !== 'publish') expect(stripComments(body), name).not.toMatch(/id-token/)
  })

  it('keeps the npm token out of every job except publish', () => {
    for (const [name, body] of Object.entries(J)) {
      if (name !== 'publish') expect(stripComments(body), name).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN|secrets\./)
    }
    expect(stripComments(J.publish)).toMatch(/NODE_AUTH_TOKEN:\s*\$\{\{\s*secrets\.NPM_TOKEN\s*\}\}/)
  })
})

describe('release.yml job split', () => {
  it('has a verify job and a publish job that needs it', () => {
    expect(Object.keys(J).sort()).toEqual(['publish', 'verify'])
    expect(J.publish).toMatch(/^\s+needs:\s*verify\s*$/m)
  })

  it('publish installs, builds and tests nothing (no lifecycle scripts run with the token)', () => {
    const steps = stripComments(J.publish)
    expect(steps).not.toMatch(/\bpnpm\b|npm (ci|install|i|run|test)\b|pnpm\/action-setup|actions\/checkout/)
    expect(steps).toMatch(/npm publish/)
    expect(steps).toMatch(/--ignore-scripts/)
  })

  it('verify installs with a frozen lockfile and runs the full gate list before packing', () => {
    const v = stripComments(J.verify)
    const at = (re) => v.search(re)
    expect(at(/pnpm install --frozen-lockfile/)).toBeGreaterThan(-1)
    expect(at(/run:\s*pnpm check\s*$/m)).toBeGreaterThan(at(/pnpm install --frozen-lockfile/))
    expect(at(/pnpm pack/)).toBeGreaterThan(at(/run:\s*pnpm check\s*$/m))
  })

  it('publish runs in a protected environment', () => {
    expect(stripComments(J.publish)).toMatch(/^\s+environment:\s*\S+/m)
    expect(stripComments(J.verify)).not.toMatch(/environment:/)
  })

  it('checks the tag against every package version, and that it is on main, before anything else runs', () => {
    const v = stripComments(J.verify)
    expect(v).toMatch(/node scripts\/check-release-tag\.mjs "\$GITHUB_REF_NAME"/)
    expect(v).toMatch(/git merge-base --is-ancestor "\$GITHUB_SHA" origin\/main/)
    expect(v.search(/check-release-tag/)).toBeLessThan(v.search(/pnpm install/))
  })
})

describe('release.yml actions are pinned by commit SHA', () => {
  it('every `uses:` is owner/repo@<40 hex>', () => {
    const uses = [...stripComments(text).matchAll(/^\s*(?:- )?uses:\s*(\S+)/gm)].map((m) => m[1])
    expect(uses.length).toBeGreaterThan(3)
    for (const u of uses) expect(u, 'pin by full commit SHA, not a tag').toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/)
  })
})

describe('scripts/check-release-tag.mjs', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'aster-reltag-'))
  afterAll(() => rmSync(tmp, { recursive: true, force: true }))
  const fixture = (versions) => {
    const dir = mkdtempSync(join(tmp, 'r-'))
    for (const [pkg, version] of Object.entries(versions)) {
      mkdirSync(join(dir, 'packages', pkg), { recursive: true })
      writeFileSync(join(dir, 'packages', pkg, 'package.json'), JSON.stringify({ name: `@aster/${pkg}`, version }))
    }
    return dir
  }
  const run = (tag, dir) => {
    try {
      execFileSync(process.execPath, [join(root, 'scripts', 'check-release-tag.mjs'), tag, '--root', dir], { stdio: 'pipe' })
      return 0
    } catch (e) { return e.status }
  }

  it('accepts a tag equal to every package version', () => {
    expect(run('v1.2.3', fixture({ core: '1.2.3', react: '1.2.3', vl: '1.2.3' }))).toBe(0)
    expect(run('v1.2.3-rc.1', fixture({ core: '1.2.3-rc.1', react: '1.2.3-rc.1', vl: '1.2.3-rc.1' }))).toBe(0)
  })
  it('rejects a package that disagrees with the tag, and malformed tags', () => {
    expect(run('v1.2.3', fixture({ core: '1.2.3', react: '1.2.3', vl: '1.2.4' }))).toBe(1)
    expect(run('v1.2.3', fixture({ core: '1.2.2', react: '1.2.3', vl: '1.2.3' }))).toBe(1)
    const ok = fixture({ core: '1.2.3', react: '1.2.3', vl: '1.2.3' })
    for (const bad of ['1.2.3', 'v1.2', 'latest', 'v1.2.3;rm', 'release-1.2.3']) expect(run(bad, ok), bad).toBe(1)
  })
  it('checks the real repository', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'packages', 'core', 'package.json'), 'utf8'))
    expect(run(`v${pkg.version}`, root)).toBe(0)
  })
})
