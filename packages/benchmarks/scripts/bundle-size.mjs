/**
 * Bundle-size comparison: what a React app pays (min + gzip) to embed one
 * chart, per approach. react/react-dom are external (identical for all rows)
 * and reported separately.
 */
import { build } from 'esbuild'
import { gzipSync, brotliCompressSync } from 'node:zlib'
import { writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { table, fmt } from '../src/stats.js'

const THIS_DIR = dirname(fileURLToPath(import.meta.url))
const PKG_DIR = dirname(THIS_DIR)
const MONOREPO_ROOT = dirname(dirname(PKG_DIR))
const TMP = join(PKG_DIR, '.tmp-bundle')
const REACT_ALIAS = join(MONOREPO_ROOT, 'node_modules', '.pnpm')

const ENTRIES = [
  {
    label: '@aster/react <Chart>',
    file: 'aster.tsx',
    src: `import { Chart } from '@aster/react'
export default Chart`,
  },
  {
    label: 'react-vega <VegaEmbed>',
    file: 'react-vega.tsx',
    src: `import { VegaEmbed } from 'react-vega'
export default VegaEmbed`,
  },
  {
    label: 'vega-embed (official tutorial)',
    file: 'vega-embed.ts',
    src: `import embed from 'vega-embed'
export default embed`,
  },
]

rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })

const kb = (n) => fmt(n / 1024, 1)

const rows = []
for (const entry of ENTRIES) {
  const entryPath = join(TMP, entry.file)
  const outPath = join(TMP, 'out.js')
  writeFileSync(entryPath, entry.src)
  await build({
    entryPoints: [entryPath],
    bundle: true,
    minify: true,
    format: 'esm',
    platform: 'browser',
    outfile: outPath,
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'silent',
    // No manual aliases: workspace deps resolve through node_modules symlinks
    // and each package's package.json "exports" map, which stays correct as
    // @aster/core grows subpath exports (dom, canvas, hit, ...).
  })
  const buf = readFileSync(outPath)
  rows.push([entry.label, kb(buf.length), kb(gzipSync(buf).length), kb(brotliCompressSync(buf).length)])
}

rmSync(TMP, { recursive: true, force: true })
console.log(table('Embedding payload (kB) — chart library only, react external', ['approach', 'min', 'gzip', 'brotli'], rows))
