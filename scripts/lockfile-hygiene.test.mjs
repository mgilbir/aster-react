/**
 * What the lockfile and the manifests must keep true (C393):
 *  - `packageManager` carries the integrity hash of the pnpm it names (`pnpm@x.y.z+sha512.<hex>`), so a tampered registry copy of pnpm is
 *    refused by the tool that reads the field;
 *  - the oracle packages (`vega`, `vega-*`, `react-vega`) are pinned to exact versions in EVERY workspace manifest: the baseline of the
 *    published performance numbers and of the conformance corpus is the version, not what a lockfile refresh resolves a range to;
 *  - the lockfile resolves nothing the registry has deprecated (`deprecated:` on a resolution), so a deprecated transitive is replaced
 *    (an override with the reason in pnpm-workspace.yaml) rather than carried.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const json = (p) => JSON.parse(readFileSync(join(root, p), 'utf8'))
const workspaceManifests = ['package.json', ...['packages', 'apps'].flatMap((d) => readdirSync(join(root, d)).map((n) => join(d, n, 'package.json')))]

describe('the lockfile and the manifests', () => {
  it('packageManager names the pnpm version with its sha512', () => {
    expect(json('package.json').packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+\+sha512\.[0-9a-f]{128}$/)
  })

  it('every oracle package is an exact version in every workspace manifest', () => {
    const loose = []
    for (const file of workspaceManifests) {
      const m = json(file)
      for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
        for (const [name, range] of Object.entries(m[field] ?? {})) {
          if (/^(vega|vega-[a-z-]+|react-vega)$/.test(name) && !/^\d+\.\d+\.\d+$/.test(range)) loose.push(`${file}: ${name} ${range}`)
        }
      }
    }
    expect(loose).toEqual([])
  })

  it('the lockfile resolves no package the registry has deprecated', () => {
    const lock = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8')
    const deprecated = []
    let current = ''
    for (const line of lock.split('\n')) {
      const key = /^ {2}'?([^\s'][^:]*?)'?:\s*$/.exec(line)
      if (key) current = key[1]
      if (/^ {4}deprecated:/.test(line)) deprecated.push(`${current}: ${line.trim().slice(0, 100)}`)
    }
    expect(deprecated).toEqual([])
  })

  it('the checks see a loose range and a deprecation (a planted one is found)', () => {
    expect(/^\d+\.\d+\.\d+$/.test('^6.3.1')).toBe(false)
    expect(/^ {4}deprecated:/.test('    deprecated: Old versions of glob are not supported')).toBe(true)
    expect('pnpm@11.20.0').not.toMatch(/\+sha512\.[0-9a-f]{128}$/)
  })
})
