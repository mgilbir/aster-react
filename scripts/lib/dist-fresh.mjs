/**
 * Whether a package's `dist` was built after the last edit of its sources.
 *
 * The gates that import `@aster-charts/core`, `/vl` or `/react` judge the BUILT packages (`packages/<name>/dist`). Run
 * standalone after editing `src` without `pnpm build`, such a gate judged the previous engine and said nothing (C564).
 * `runGate` (run-gate.mjs) asks this first for the packages a gate declares it `reads`, and refuses to run on a stale build.
 *
 * Stale means: a source file that the build compiles (`src/**` `.ts`/`.tsx`/`.mts`, not a test, testlib or testkit) is newer
 * than the newest file of `dist`, or `dist` is missing. `tsc` (each package's build) rewrites every output on each build.
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const COMPILED = /\.(?:ts|tsx|mts)$/
const NOT_BUILT = /\.(?:test|testlib|testkit)\.(?:ts|tsx|mts)$|\.d\.ts$/

/** The newest modification time (ms) of the files under `dir` that `keep` accepts; -1 when there are none. */
function newest(dir, keep) {
  let t = -1
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) t = Math.max(t, newest(p, keep))
    else if (keep(e.name)) t = Math.max(t, statSync(p).mtimeMs)
  }
  return t
}

/**
 * The reason the build of these packages is stale, or null when every one is fresh.
 * @param {string[]} packages package directory names under `packages/` (`core`, `vl`, `react`)
 * @param {string} [repo] the repository root (a test points it at a scratch copy)
 */
export function staleDist(packages, repo = REPO) {
  for (const name of packages) {
    const src = join(repo, 'packages', name, 'src')
    const dist = join(repo, 'packages', name, 'dist')
    if (!existsSync(dist)) return `packages/${name}/dist is missing: run \`pnpm build\``
    const s = newest(src, (f) => COMPILED.test(f) && !NOT_BUILT.test(f))
    const d = newest(dist, () => true)
    if (s > d) return `packages/${name}/src was edited after packages/${name}/dist was built: run \`pnpm build\` (the gate judges dist)`
  }
  return null
}
