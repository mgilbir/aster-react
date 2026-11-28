/**
 * The directory the schema sweeps (and diff-vl, show-case) read the oracle's packages through: every package of vega's and
 * vega-lite's stores, side by side, as symlinks. Made in a temp directory that the caller removes with `removeShimNodeModules`
 * (and that scripts/lib/temp-dir.mjs removes at the latest when the process ends).
 */
import { mkdirSync, readdirSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { makeTempDir, removeTempDir } from '../../../../scripts/lib/temp-dir.mjs'

/**
 * @param {NodeRequire} require a `require` that resolves `vega` and `vega-lite`
 * @returns {string} the path of the `node_modules` directory
 */
export function makeShimNodeModules(require) {
  const dir = makeTempDir('aster-shim-')
  const nodeModules = join(dir, 'node_modules')
  mkdirSync(nodeModules)
  const stores = [
    join(dirname(require.resolve('vega')), '..', '..'), // vega@x.y.z/node_modules (vega, vega-scenegraph, vega-projection)
    join(dirname(require.resolve('vega-lite')), '..', '..'), // vega-lite@x/node_modules
  ]
  const seen = new Set()
  for (const store of stores) {
    let entries = []
    try { entries = readdirSync(store) } catch { continue }
    for (const name of entries) {
      if (seen.has(name) || name.startsWith('.')) continue
      seen.add(name)
      try { symlinkSync(join(store, name), join(nodeModules, name), 'dir') } catch { /* already linked */ }
    }
  }
  return nodeModules
}

/** Remove what `makeShimNodeModules` made (the temp directory that holds `nodeModules`). @param {string} nodeModules */
export function removeShimNodeModules(nodeModules) {
  removeTempDir(dirname(nodeModules))
}
