/**
 * The checkout a probe measures: its first argument (a path to a built worktree; `.` from the repository root). The probes read
 * the `dist` of each package, so they run against any tree, which is how a change is measured against its base: build both, run the same probe
 * on each, alternating, and compare the medians.
 */
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

export function treeRoot(argv = process.argv) {
  const arg = argv[2]
  if (!arg || arg.startsWith('-')) {
    console.error('usage: node <probe>.mjs <built worktree, "." for this one> [probe arguments]')
    process.exit(2)
  }
  const root = resolve(arg)
  for (const pkg of ['core', 'vl', 'react']) {
    if (!existsSync(join(root, 'packages', pkg, 'dist', 'index.js'))) {
      console.error(`${root}/packages/${pkg}/dist is missing: run pnpm build in that worktree`)
      process.exit(2)
    }
  }
  return root
}
