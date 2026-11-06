/**
 * Copy the repository-level licence files into a package before packing.
 *
 * `npm pack`/`pnpm publish` run this as `prepack` from the package directory.
 * The published tarballs must carry the BSD-3-Clause licence and the
 * third-party notices (the engine transcribes behaviour and colour palettes
 * from vega-* / d3-* projects under BSD-3/ISC).
 *
 * Usage: node scripts/copy-legal.mjs   (from the package directory; takes no arguments)
 *
 * Exit codes: 0 copied, 1 a licence file is missing, 2 bad usage (any argument other than --help).
 *
 * This file stays free of imports from scripts/lib: scripts/verify-publish.test.mjs copies it alone into a scratch repository
 * and runs it as the `prepack` hook. It answers --help itself instead of through scripts/lib/cli.mjs.
 */
import { copyFileSync, existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2).filter((a) => a !== '--')
if (args.length > 0) {
  const help = args.includes('--help') || args.includes('-h')
  const usage = 'Usage: scripts/copy-legal.mjs'
  if (help) {
    const header = /^\/\*\*([\s\S]*?)\*\//.exec(readFileSync(fileURLToPath(import.meta.url), 'utf8'))?.[1] ?? ''
    console.log(`${usage}\n\n${header.split('\n').map((l) => l.replace(/^\s*\* ?/, '').trimEnd()).join('\n').trim()}`)
    process.exit(0)
  }
  console.error(`scripts/copy-legal.mjs: unknown option ${JSON.stringify(args[0])}\n${usage}\n(--help prints the header of the script)`)
  process.exit(2)
}

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
