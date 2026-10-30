import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configDefaults, defineConfig } from 'vitest/config'

// Does this V8 have Maglev's inlined `Array.prototype.sort`? (V8 15.x; the flag below turns it off.) Asked once here, in the
// host, and handed to the workers, so no worker has to spawn a process. See scripts/vitest-engine.setup.mjs.
const MAGLEV_REDUCERS_FLAG = '--maglev-disable-builtin-reducers'
let hasMaglevReducers = false
try {
  hasMaglevReducers = execFileSync(process.execPath, ['--v8-options'], { encoding: 'utf8', maxBuffer: 1 << 26 }).includes(MAGLEV_REDUCERS_FLAG)
} catch {
  hasMaglevReducers = false
}

// Everything else is vitest's default (pool, worker count, include globs, per-file environment docblocks).
export default defineConfig({
  test: {
    // See scripts/vitest-yield.setup.mjs: keeps a worker's event loop turning between tests.
    // See scripts/vitest-engine.setup.mjs: pins the engine's sort so the in-process oracle (real Vega) is deterministic.
    setupFiles: ['./scripts/vitest-yield.setup.mjs', './scripts/vitest-engine.setup.mjs'],
    // `*.gallery.test.ts` needs the fetched gallery cache: it runs in `pnpm conformance:gallery` (vitest.gallery.config.mjs), not here.
    exclude: [...configDefaults.exclude, '**/*.gallery.test.ts'],
    env: {
      ASTER_V8_SORT_FLAG: hasMaglevReducers ? MAGLEV_REDUCERS_FLAG : '',
      // The default run never sees the fetched gallery cache, even on a machine that has one: a test that reads it fails
      // here, on every machine, instead of passing locally and failing on CI (scripts/gallery-isolation.test.mjs).
      ASTER_GALLERY_CACHE_DIR: join(tmpdir(), 'aster-no-gallery-cache-in-the-default-run'),
    },
  },
})
