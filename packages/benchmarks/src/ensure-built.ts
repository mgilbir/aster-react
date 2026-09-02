import { statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const ROOT = dirname(dirname(PKG_DIR))

/** The benches run against built dist so they measure what consumers get. */
export function ensureBuilt(): void {
  for (const pkg of ['core', 'react']) {
    try {
      statSync(join(ROOT, 'packages', pkg, 'dist', 'index.js'))
    } catch {
      console.error(`packages/${pkg}/dist is missing — run \`pnpm build\` at the repo root first`)
      process.exit(1)
    }
  }
}
