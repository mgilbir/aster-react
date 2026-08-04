import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as vl from 'vega-lite'
import { renderSpec } from '@aster/core'
import { renderWithVega } from './render-vega.js'
import { canonicalizeSvg } from './normalize.js'

const name = process.argv[2] ?? 'bar-basic'
const kind = name.endsWith('.vl') ? 'vl' : name.endsWith('.vg') ? 'vg' : 'vl'
const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'corpus')
const file = kind === 'vl' ? `${name}.vl.json` : `${name}.vg.json`
const spec = JSON.parse(readFileSync(join(dir, file), 'utf8'))
const vgSpec = (kind === 'vl' ? vl.compile(spec as any).spec as unknown as Record<string, unknown> : spec) as Record<string, unknown>

const oracle = canonicalizeSvg(await renderWithVega(vgSpec as unknown as Record<string, unknown>))
const ours = canonicalizeSvg(renderSpec(vgSpec))

console.log('=== ORACLE (vega) ===')
console.log(oracle.records.join('\n'))
console.log('\n=== OURS (aster) ===')
console.log(ours.records.join('\n'))
