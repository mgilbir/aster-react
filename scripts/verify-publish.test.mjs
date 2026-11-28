/**
 * Fault-injection guard for scripts/verify-publish.mjs (the `verify-publish` gate).
 *
 * A gate that has never been seen to fail proves nothing. Each test copies the three public packages (manifests and
 * their built dist) into a scratch repository, plants ONE fault a release could ship, points the script at the copy with
 * ASTER_VERIFY_PUBLISH_ROOT and requires it to fail with that fault's message. The unmodified copy must pass, so a
 * failure cannot come from the harness. Needs `pnpm build` (the `build` gate runs first).
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { spawnAsync } from './lib/spawn-async.mjs'
import { makeTempDir, removeTempDir, sandboxEnv } from './lib/temp-dir.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const PUBLIC = ['core', 'react', 'vl']
const scratch = makeTempDir('aster-verify-publish-test-')
afterAll(() => removeTempDir(scratch))
// The script runs with its OS temp dir (TMPDIR) pointed at a directory of ours, and leaves nothing in it: not after a pass, not after
// a planted fault that ends the script with process.exit (a `finally` does not run then). A leaked tarball set is ~10 MB a run.
const sandbox = join(scratch, 'os-tmp')
mkdirSync(sandbox)
afterEach(() => {
  const left = readdirSync(sandbox)
  for (const d of left) rmSync(join(sandbox, d), { recursive: true, force: true })
  expect(left, 'verify-publish left temp directories behind').toEqual([])
})

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
  encoding: 'utf8', env: { ...process.env, ASTER_VERIFY_PUBLISH_ROOT: dir, ...sandboxEnv(sandbox), ...env }, timeout: 280_000,
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
    ['a declaration file missing from dist', (d) => rmSync(join(d, 'packages', 'core', 'dist', 'index.d.ts')), {}, /@aster-charts\/core tarball is missing dist\/index\.d\.ts/],
    ['a source map shipped without its sources (the `!dist/**/*.map` exclusion dropped from "files")', (d) => {
      writeFileSync(join(d, 'packages', 'core', 'dist', 'leak.js.map'), '{}')
      editManifest(d, 'core', (m) => { m.files = m.files.filter((f) => f !== '!dist/**/*.map') })
    }, {}, /@aster-charts\/core tarball ships source maps/],
    ['a JS file that references a source map that is not shipped', (d) => writeFileSync(join(d, 'packages', 'vl', 'dist', 'dangling.js'), 'export {}\n//# sourceMappingURL=dangling.js.map\n'), {}, /@aster-charts\/vl\/dist\/dangling\.js references a source map/],
    ['an exports entry whose target does not exist', (d) => editManifest(d, 'core', (m) => { m.exports['.'].default = './dist/does-not-exist.js' }), {}, /@aster-charts\/core tarball is missing dist\/does-not-exist\.js/],
    ['a `browser` target that is not in the tarball (Node never resolves it, so no import reads it)', (d) => editManifest(d, 'core', (m) => { m.exports['./probe-browser'] = { types: './dist/index.d.ts', browser: './dist/missing-browser.js', default: './dist/index.js' } }), {}, /@aster-charts\/core tarball is missing dist\/missing-browser\.js/],
    ['a `browser` condition that resolves somewhere else than it names (a condition order that lets `default` win)', (d) => {
      writeFileSync(join(d, 'packages', 'core', 'dist', 'browser-only.js'), 'export const browserOnly = 1\n')
      editManifest(d, 'core', (m) => { m.exports['./probe-browser'] = { types: './dist/index.d.ts', default: './dist/index.js', browser: './dist/browser-only.js' } })
    }, {}, /@aster-charts\/core\/probe-browser: a bundle built with the browser condition does not read \.\/dist\/browser-only\.js/],
    ['a nested condition whose file is missing', (d) => editManifest(d, 'vl', (m) => { m.exports['./probe'] = { types: './dist/index.d.ts', default: './dist/index.js', node: { import: './dist/index.js', require: './dist/missing.cjs' } } }), {}, /@aster-charts\/vl tarball is missing dist\/missing\.cjs/],
    ['an exports entry with no types condition', (d) => editManifest(d, 'vl', (m) => { delete m.exports['.'].types }), {}, /@aster-charts\/vl exports\["\."\] has no "types" condition/],
    ['a manifest with no sideEffects field', (d) => editManifest(d, 'vl', (m) => { delete m.sideEffects }), {}, /@aster-charts\/vl packed manifest declares no "sideEffects"/],
    ['a wrong licence', (d) => editManifest(d, 'react', (m) => { m.license = 'MIT' }), {}, /@aster-charts\/react has license MIT/],
    ['a blanket "sideEffects": false that shakes the registrations out of a bundle', (d) => editManifest(d, 'core', (m) => { m.sideEffects = false }), {}, /tree-shaken bundle built from the installed tarballs does not behave/],
    ['an evaluateChart that is handed no incremental engine', (d) => writeFileSync(join(d, 'packages', 'core', 'dist', 'evaluate.js'),
      `import { evaluateChartPending } from './runtime.js'\nexport function evaluateChart(chart, input = {}) { const p = evaluateChartPending(undefined, chart, input); p.commit(); return p.scene }\n`),
    {}, /needs the incremental engine|reeval bundle lacks the incremental engine/],
    ['an entry that reaches the incremental engine for every app (a renderSpec bundle then carries it)', (d) => {
      const file = join(d, 'packages', 'core', 'dist', 'index.js')
      writeFileSync(file, `import { incrementalEngine } from './incremental-engine.js'\nglobalThis.__engine = incrementalEngine\n${readFileSync(file, 'utf8')}`)
    }, {}, /the once bundle contains the incremental engine/],
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
