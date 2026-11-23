/**
 * The publish step of the Release workflow, run for real against a fake `npm` on PATH, and the tag/dist-tag rules it uses.
 * C66: a prerelease tag must never publish as `latest`. C231: a run that failed halfway must be finishable by re-running.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { PUBLISH_ORDER, distTagFor, versionOfTag } from './lib/release.mjs'
import { spawnAsync } from './lib/spawn-async.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const tmp = mkdtempSync(join(tmpdir(), 'aster-relpub-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

// A prerelease and a stable form of every shape semver 2.0.0 allows; `pre` is what the test expects, written by hand.
const VERSIONS = [
  ['0.4.2', false], ['1.0.0', false], ['10.20.30', false], ['0.0.0', false],
  ['1.0.0-rc.1', true], ['1.0.0-alpha', true], ['1.0.0-alpha.1', true], ['1.0.0-0.3.7', true], ['1.0.0-x.7.z.92', true],
  ['1.0.0-x-y-z.--', true], ['1.0.0-beta-1', true], ['1.0.0-rc.1-2', true], ['0.5.0-next.0', true], ['2.0.0-0', true],
  ['1.0.0-1a', true], ['1.0.0-a.b.c.d.e.f', true], ['1.0.0-RC.1', true], ['1.0.0-rc', true],
]
const NOT_VERSIONS = [
  '', '1.2.3', 'v1.2', 'v1.2.3.4', 'latest', 'v1.2.3;rm', 'release-1.2.3', 'v01.2.3', 'v1.02.3', 'v1.2.03', 'v1.2.3-', 'v1.2.3-01',
  'v1.2.3-rc..1', 'v1.2.3-rc.', 'v1.2.3+build', 'v1.2.3-rc.1+build', 'V1.2.3', 'v1.2.3 ', ' v1.2.3', 'v1.2.3\n', 'v1.2.3-rc_1', 'v-1.2.3',
]

describe('tag and dist-tag rules', () => {
  it.each(VERSIONS)('v%s is a version tag and publishes under %s', (version, pre) => {
    expect(versionOfTag(`v${version}`)).toBe(version)
    expect(distTagFor(version)).toBe(pre ? 'next' : 'latest')
  })
  it.each(NOT_VERSIONS)('%j is not a version tag', (tag) => {
    expect(versionOfTag(tag)).toBeNull()
  })
  it('distTagFor refuses what is not a version', () => {
    for (const bad of ['', 'v1.2.3', '1.2', '1.2.3+b', 'latest']) expect(() => distTagFor(bad), bad).toThrow()
  })
  it('publishes the dependencies before their dependents', () => {
    expect(PUBLISH_ORDER).toEqual(['core', 'vl', 'react'])
    const react = JSON.parse(readFileSync(join(root, 'packages/react/package.json'), 'utf8'))
    for (const dep of ['core', 'vl']) expect(PUBLISH_ORDER.indexOf(dep)).toBeLessThan(PUBLISH_ORDER.indexOf('react'))
    expect(Object.keys({ ...react.dependencies, ...react.peerDependencies })).toEqual(expect.arrayContaining(['@aster-charts/core']))
  })
})

/**
 * A fake `npm`: `view <name>@<version> version` answers from FAKE_PUBLISHED (comma separated name@version), E404 otherwise, or a
 * 503 for FAKE_VIEW_DOWN; `publish` appends its argv to FAKE_LOG and fails for FAKE_FAIL (a package name fragment).
 */
function fakeNpm() {
  const bin = mkdtempSync(join(tmp, 'bin-'))
  const file = join(bin, 'npm')
  writeFileSync(file, `#!/usr/bin/env node
const a = process.argv.slice(2)
const env = process.env
if (a[0] === 'view') {
  if (env.FAKE_VIEW_DOWN) { console.error('npm error code E503\\nnpm error 503 Service Unavailable'); process.exit(1) }
  const spec = a[1]
  if ((env.FAKE_PUBLISHED ?? '').split(',').includes(spec)) { console.log(spec.slice(spec.lastIndexOf('@') + 1)); process.exit(0) }
  console.error('npm error code E404\\nnpm error 404 Not Found - GET https://registry.npmjs.org/x'); process.exit(1)
}
if (a[0] === 'publish') {
  require('node:fs').appendFileSync(env.FAKE_LOG, JSON.stringify(a) + '\\n')
  if (env.FAKE_FAIL && a[1].includes(env.FAKE_FAIL)) { console.error('npm error code E503'); process.exit(1) }
  process.exit(0)
}
process.exit(99)
`)
  chmodSync(file, 0o755)
  return bin
}
const bin = fakeNpm()

/** A tarball dir for `version` with every package, optionally leaving one out. */
function tarballs(version, omit) {
  const dir = mkdtempSync(join(tmp, 'tgz-'))
  for (const pkg of PUBLISH_ORDER) if (pkg !== omit) writeFileSync(join(dir, `aster-charts-${pkg}-${version}.tgz`), 'x')
  return dir
}

async function publish(tag, dir, env = {}, extra = []) {
  const log = join(mkdtempSync(join(tmp, 'log-')), 'publish.jsonl')
  writeFileSync(log, '')
  const r = await spawnAsync(process.execPath, [join(root, 'scripts/release-publish.mjs'), tag, dir, ...extra], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_LOG: log, ...env }, timeout: 30_000,
  })
  const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  return { status: r.status, out: r.stdout + r.stderr, calls }
}
const tagOf = (call) => call[call.indexOf('--tag') + 1]
const nameOf = (call) => /aster-charts-(\w+)-/.exec(call[1])[1]

describe('scripts/release-publish.mjs', () => {
  it.each(VERSIONS)('%s: every package is published with --tag matching the version, in dependency order', async (version, pre) => {
    const r = await publish(`v${version}`, tarballs(version))
    expect(r.status, r.out).toBe(0)
    expect(r.calls.map(nameOf)).toEqual(PUBLISH_ORDER)
    for (const c of r.calls) {
      expect(tagOf(c), JSON.stringify(c)).toBe(pre ? 'next' : 'latest')
      expect(c).toEqual(expect.arrayContaining(['--access', 'public', '--provenance', '--ignore-scripts']))
    }
  })

  it('a prerelease is never published without `--tag next`, a stable release always with `--tag latest`', async () => {
    const pre = await publish('v0.5.0-rc.1', tarballs('0.5.0-rc.1'))
    expect(pre.calls.every((c) => c.includes('--tag') && tagOf(c) === 'next')).toBe(true)
    const stable = await publish('v0.5.0', tarballs('0.5.0'))
    expect(stable.calls.every((c) => c.includes('--tag') && tagOf(c) === 'latest')).toBe(true)
  })

  it('a run that failed halfway is finished by re-running: published versions are skipped', async () => {
    const dir = tarballs('0.5.0')
    const first = await publish('v0.5.0', dir, { FAKE_FAIL: 'aster-charts-vl' })
    expect(first.status).toBe(1)
    expect(first.calls.map(nameOf)).toEqual(['core', 'vl']) // react is not attempted after vl fails
    expect(first.out).toMatch(/re-run the job/)
    const second = await publish('v0.5.0', dir, { FAKE_PUBLISHED: '@aster-charts/core@0.5.0' })
    expect(second.status, second.out).toBe(0)
    expect(second.calls.map(nameOf)).toEqual(['vl', 'react'])
    expect(second.out).toMatch(/@aster-charts\/core@0.5.0 is already on the registry/)
    const third = await publish('v0.5.0', dir, { FAKE_PUBLISHED: '@aster-charts/core@0.5.0,@aster-charts/vl@0.5.0,@aster-charts/react@0.5.0' })
    expect(third.status, third.out).toBe(0)
    expect(third.calls).toEqual([])
  })

  it('a registry answer that is neither "published" nor "E404" fails without publishing anything', async () => {
    const r = await publish('v0.5.0', tarballs('0.5.0'), { FAKE_VIEW_DOWN: '1' })
    expect(r.status).toBe(1)
    expect(r.calls).toEqual([])
    expect(r.out).toMatch(/other than "not published"/)
  })

  it('refuses a missing tarball before publishing any package, and a tag that is not a version', async () => {
    const missing = await publish('v0.5.0', tarballs('0.5.0', 'react'))
    expect(missing.status).toBe(1)
    expect(missing.calls).toEqual([])
    expect(missing.out).toMatch(/aster-charts-react-0\.5\.0\.tgz is missing/)
    const wrongVersion = await publish('v0.5.1', tarballs('0.5.0'))
    expect(wrongVersion.status).toBe(1)
    expect(wrongVersion.calls).toEqual([])
    for (const bad of ['latest', 'v1.2', 'v1.2.3+x']) {
      const r = await publish(bad, tarballs('1.2.3'))
      expect(r.status, bad).toBe(1)
      expect(r.calls, bad).toEqual([])
    }
  })

  it('--dry-run prints the commands and publishes nothing; bad usage exits 2', async () => {
    const dry = await publish('v0.5.0-rc.1', tarballs('0.5.0-rc.1'), {}, ['--dry-run'])
    expect(dry.status).toBe(0)
    expect(dry.calls).toEqual([])
    expect(dry.out).toMatch(/--tag next/)
    expect((await publish('v0.5.0', tarballs('0.5.0'), {}, ['--nope'])).status).toBe(2)
    const none = await spawnAsync(process.execPath, [join(root, 'scripts/release-publish.mjs')], { timeout: 30_000 })
    expect(none.status).toBe(2)
  })
})
