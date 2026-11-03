/**
 * Fault-injection guard for scripts/verify-publish.mjs (the `verify-publish` gate).
 *
 * A gate that has never been seen to fail proves nothing. Each test copies the three public packages (manifests and
 * their built dist) into a scratch repository, plants ONE fault a release could ship, points the script at the copy with
 * ASTER_VERIFY_PUBLISH_ROOT and requires it to fail with that fault's message. The unmodified copy must pass, so a
 * failure cannot come from the harness. Needs `pnpm build` (the `build` gate runs first).
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { spawnAsync } from './lib/spawn-async.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const PUBLIC = ['core', 'react', 'vl']
const scratch = mkdtempSync(join(tmpdir(), 'aster-verify-publish-test-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

let n = 0
/** A scratch repository holding what `pnpm pack` and the script read: workspace files, legal files, manifests and dist. */
function copyRepo() {
  const dir = join(scratch, `repo${n++}`)
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  for (const f of ['package.json', 'pnpm-workspace.yaml', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'scripts/copy-legal.mjs']) cpSync(join(root, f), join(dir, f))
  for (const pkg of PUBLIC) {
    const from = join(root, 'packages', pkg)
    const to = join(dir, 'packages', pkg)
    mkdirSync(to, { recursive: true })
    cpSync(join(from, 'package.json'), join(to, 'package.json'))
    cpSync(join(from, 'dist'), join(to, 'dist'), { recursive: true })
    if (existsSync(join(from, 'README.md'))) cpSync(join(from, 'README.md'), join(to, 'README.md'))
    // the React peers are linked, never copied (the script resolves them from packages/react/node_modules)
    if (pkg === 'react') symlinkSync(join(from, 'node_modules'), join(to, 'node_modules'), 'dir')
  }
  return dir
}

const editManifest = (dir, pkg, edit) => {
  const file = join(dir, 'packages', pkg, 'package.json')
  const m = JSON.parse(readFileSync(file, 'utf8'))
  edit(m)
  writeFileSync(file, JSON.stringify(m, null, 2))
}

const verify = (dir, env = {}) => spawnAsync(process.execPath, [join(root, 'scripts', 'verify-publish.mjs')], {
  encoding: 'utf8', env: { ...process.env, ASTER_VERIFY_PUBLISH_ROOT: dir, ...env }, timeout: 280_000,
})
const out = (r) => r.stdout + r.stderr

describe('verify-publish', () => {
  it('passes on an unmodified copy of the packages (so the planted faults below are the only reason to fail)', async () => {
    const r = await verify(copyRepo())
    expect(out(r)).toContain('[verify-publish] PASS')
    expect(r.status).toBe(0)
  }, 300_000)

  const faults = [
    ['packing with npm leaves `workspace:` ranges in the manifest', undefined, { ASTER_VERIFY_PUBLISH_PACKER: 'npm' }, /packed manifest has \w+\.@?[\w/-]+ = "workspace:/],
    ['a THIRD_PARTY_NOTICES.md without licence texts', (d) => writeFileSync(join(d, 'THIRD_PARTY_NOTICES.md'), '# notices\n'), {}, /THIRD_PARTY_NOTICES\.md carries no licence texts/],
    ['a declaration file missing from dist', (d) => rmSync(join(d, 'packages', 'core', 'dist', 'index.d.ts')), {}, /@aster\/core tarball is missing dist\/index\.d\.ts/],
    ['a source map shipped without its sources (the `!dist/**/*.map` exclusion dropped from "files")', (d) => {
      writeFileSync(join(d, 'packages', 'core', 'dist', 'leak.js.map'), '{}')
      editManifest(d, 'core', (m) => { m.files = m.files.filter((f) => f !== '!dist/**/*.map') })
    }, {}, /@aster\/core tarball ships source maps/],
    ['a JS file that references a source map that is not shipped', (d) => writeFileSync(join(d, 'packages', 'vl', 'dist', 'dangling.js'), 'export {}\n//# sourceMappingURL=dangling.js.map\n'), {}, /@aster\/vl\/dist\/dangling\.js references a source map/],
    ['an exports entry whose target does not exist', (d) => editManifest(d, 'core', (m) => { m.exports['.'].default = './dist/does-not-exist.js' }), {}, /@aster\/core tarball is missing dist\/does-not-exist\.js/],
    ['an exports entry with no types condition', (d) => editManifest(d, 'vl', (m) => { delete m.exports['.'].types }), {}, /@aster\/vl exports\["\."\] has no "types" condition/],
    ['a manifest with no sideEffects field', (d) => editManifest(d, 'vl', (m) => { delete m.sideEffects }), {}, /@aster\/vl packed manifest declares no "sideEffects"/],
    ['a wrong licence', (d) => editManifest(d, 'react', (m) => { m.license = 'MIT' }), {}, /@aster\/react has license MIT/],
    ['a blanket "sideEffects": false that shakes the registrations out of a bundle', (d) => editManifest(d, 'core', (m) => { m.sideEffects = false }), {}, /tree-shaken bundle built from the installed tarballs does not behave/],
    ['a package whose dist was never built', (d) => rmSync(join(d, 'packages', 'react', 'dist'), { recursive: true }), {}, /packages\/react\/dist is missing/],
  ]
  for (const [name, plant, env, message] of faults) {
    it(`FAILS on ${name}`, async () => {
      const dir = copyRepo()
      plant?.(dir)
      const r = await verify(dir, env)
      expect(r.status, out(r)).toBe(1)
      expect(out(r)).toMatch(message)
      expect(out(r)).not.toContain('[verify-publish] PASS')
    }, 300_000)
  }
})
