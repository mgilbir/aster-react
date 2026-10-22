/**
 * Copy the repository-level licence files into a package before packing.
 *
 * `npm pack`/`pnpm publish` run this as `prepack` from the package directory.
 * The published tarballs must carry the BSD-3-Clause licence and the
 * third-party notices (the engine transcribes behaviour and colour palettes
 * from vega-* / d3-* projects under BSD-3/ISC).
 */
import { copyFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = dirname(here)
for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) {
  const src = join(root, file)
  const dest = join(process.cwd(), file)
  if (!existsSync(src)) {
    console.error(`[copy-legal] missing ${src}`)
    process.exit(1)
  }
  copyFileSync(src, dest)
}
