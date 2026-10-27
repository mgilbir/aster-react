import { defineConfig } from 'vitest/config'

// Everything else is vitest's default (pool, worker count, include globs, per-file environment docblocks).
export default defineConfig({
  test: {
    // See scripts/vitest-yield.setup.mjs: keeps a worker's event loop turning between tests.
    setupFiles: ['./scripts/vitest-yield.setup.mjs'],
  },
})
