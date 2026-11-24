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

// The default run is pinned to UTC (docs/TESTING.md, "Time zones"): a machine in another zone runs what CI runs. A zone given in
// TZ is kept: the tz-matrix gate (scripts/test-tz.mjs) runs the zone-aware suites under other zones that way. Set here, in the host,
// so every worker it starts inherits it.
if (!process.env.TZ) process.env.TZ = 'UTC'

// Everything else is vitest's default (pool, worker count, include globs, per-file environment docblocks).
export default defineConfig({
  test: {
    // See scripts/vitest-yield.setup.mjs: keeps a worker's event loop turning between tests.
    // See scripts/vitest-engine.setup.mjs: pins the engine's sort so the in-process oracle (real Vega) is deterministic.
    // See scripts/vitest-react-act.setup.mjs: React's act environment is on in every file, not from the first test that sets it.
    // See scripts/vitest-core-parts.setup.mjs: core's own unit tests get the parts of the engine the public entries carry.
    // See packages/conformance/scripts/engine-sharing.setup.mjs: a conformance test that hands one object to vega and to Aster fails.
    setupFiles: ['./scripts/vitest-yield.setup.mjs', './scripts/vitest-engine.setup.mjs', './scripts/vitest-react-act.setup.mjs', './scripts/vitest-core-parts.setup.mjs', './packages/conformance/scripts/engine-sharing.setup.mjs'],
    // `*.gallery.test.ts` needs the fetched gallery cache: it runs in `pnpm conformance:gallery` (vitest.gallery.config.mjs), not here.
    exclude: [...configDefaults.exclude, '**/*.gallery.test.ts'],
    env: {
      TZ: process.env.TZ,
      ASTER_V8_SORT_FLAG: hasMaglevReducers ? MAGLEV_REDUCERS_FLAG : '',
      // The default run never sees the fetched gallery cache, even on a machine that has one: a test that reads it fails
      // here, on every machine, instead of passing locally and failing on CI (scripts/gallery-isolation.test.mjs).
      ASTER_GALLERY_CACHE_DIR: join(tmpdir(), 'aster-no-gallery-cache-in-the-default-run'),
    },
  },
})
