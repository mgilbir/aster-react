import { execFileSync } from 'node:child_process'
import { defineConfig } from 'vitest/config'

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
    env: { ASTER_V8_SORT_FLAG: hasMaglevReducers ? MAGLEV_REDUCERS_FLAG : '' },
  },
})
