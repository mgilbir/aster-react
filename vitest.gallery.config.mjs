import { defineConfig } from 'vitest/config'

// The tests that need the FETCHED gallery cache (packages/conformance/.gallery) and run only inside `pnpm conformance:gallery`
// (packages/conformance/src/gallery/run.ts starts this config once the cache is verified). The default run (vitest.config.mjs)
// excludes them and hides the cache; here the cache is the real one, and a missing cache is a failure, never a skip.
export default defineConfig({
  test: {
    include: ['packages/conformance/src/gallery/**/*.gallery.test.ts'],
    setupFiles: ['./scripts/vitest-yield.setup.mjs'],
  },
})
