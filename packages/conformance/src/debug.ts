import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as vl from 'vega-lite'
import '@aster/core/geo' // registers d3-geo/d3-contour for geo/projection/contour specs
import { renderSpec } from '@aster/core'
import { renderWithVega } from './render-vega.js'
import { canonicalizeSvg } from './normalize.js'

const base = process.argv[2] ?? 'bar-basic'
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const candidates = [
  { dir: 'corpus', file: `${base}.vl.json`, kind: 'vl' as const },
  { dir: 'corpus', file: `${base}.vg.json`, kind: 'vg' as const },
  { dir: 'probes', file: `${base}.vl.json`, kind: 'vl' as const },
  { dir: 'probes', file: `${base}.vg.json`, kind: 'vg' as const },
]
const hit = candidates.find((c) => existsSync(join(root, c.dir, c.file)))
if (!hit) {
  console.error(`[debug] spec not found: ${base} (looked in corpus/ and probes/)`)
  process.exit(1)
}
const spec = JSON.parse(readFileSync(join(root, hit.dir, hit.file), 'utf8'))
const vgSpec = (hit.kind === 'vl' ? vl.compile(spec as any).spec as unknown as Record<string, unknown> : spec) as Record<string, unknown>

const oracle = canonicalizeSvg(await renderWithVega(vgSpec as unknown as Record<string, unknown>))
const ours = canonicalizeSvg(renderSpec(vgSpec))

console.log('=== ORACLE (vega) ===')
console.log(oracle.records.join('\n'))
console.log('\n=== OURS (aster) ===')
console.log(ours.records.join('\n'))
