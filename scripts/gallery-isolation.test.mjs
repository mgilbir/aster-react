/**
 * The default `pnpm test` (and the `unit` CI jobs) must pass in a clean checkout: no fetched gallery cache
 * (packages/conformance/.gallery, a download that only the nightly gallery step makes) and no browser-less surprises.
 *
 * Tests that need the cache are named `*.gallery.test.ts`; vitest.config.mjs does not collect them and points the cache
 * at a directory that does not exist, so a test that reads it anyway fails on EVERY machine (not only on CI, where the
 * cache is absent). They run in `pnpm conformance:gallery` (vitest.gallery.config.mjs), where a missing cache is a failure.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CACHE_DIR, readManifest, verifyCache } from '../packages/conformance/src/gallery/cache.ts'
import { listGallery } from '../packages/conformance/src/gallery/lib.ts'
import { spawnAsync } from './lib/spawn-async.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const vitestList = async (config) => {
  const r = await spawnAsync(process.execPath, ['node_modules/vitest/vitest.mjs', 'list', '--filesOnly', ...(config ? ['--config', config] : [])], { cwd: ROOT, timeout: 120_000 })
  expect(r.status, r.stderr).toBe(0)
  return r.stdout.split('\n').map((l) => l.trim()).filter((l) => l.endsWith('.ts') || l.endsWith('.mts') || l.endsWith('.mjs'))
}

describe('the default test run does not depend on the fetched gallery cache', () => {
  it('sees no cache: the cache directory is absent and listing the gallery fails', () => {
    expect(process.env.ASTER_GALLERY_CACHE_DIR, 'vitest.config.mjs hides the cache').toBeTruthy()
    expect(CACHE_DIR).toBe(process.env.ASTER_GALLERY_CACHE_DIR)
    expect(verifyCache(readManifest()).length).toBeGreaterThan(0)
    expect(() => listGallery()).toThrow(/ENOENT/)
  })

  it('collects no *.gallery.test.ts, and the gallery config collects exactly those', async () => {
    const onDisk = (await spawnAsync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', '*.gallery.test.ts'], { cwd: ROOT })).stdout.split('\n').filter(Boolean)
    expect(onDisk.length, 'at least the data-preload test is a gallery test').toBeGreaterThan(0)
    const dflt = await vitestList()
    expect(dflt.filter((f) => f.endsWith('.gallery.test.ts'))).toEqual([])
    expect(dflt.length).toBeGreaterThan(100) // the default run is still the whole suite
    const gallery = await vitestList('vitest.gallery.config.mjs')
    expect(gallery.map((f) => f.replace(/^.*packages\//, 'packages/')).sort()).toEqual(onDisk.sort())
  }, 240_000)

  it('the gallery gate runs them, hard (a failure is a gate failure; a missing cache stops the gate first)', () => {
    const run = readFileSync(join(ROOT, 'packages/conformance/src/gallery/run.ts'), 'utf8')
    expect(run).toContain('vitest.gallery.config.mjs')
    expect(run).toMatch(/runGalleryTests\(\)\) !== 0\) problem\(/)
    expect(run.indexOf('verifyCache(manifest)')).toBeLessThan(run.indexOf('runGalleryTests()'))
  })
})
