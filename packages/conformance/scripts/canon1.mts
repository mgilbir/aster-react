import * as vl from 'vega-lite'
import * as fs from 'node:fs'
import { renderSpec } from '@aster/core'
import { renderWithVega } from '../src/render-vega.js'
import { canonicalizeSvg } from '../src/normalize.js'
const name = process.argv[2]
const spec = JSON.parse(fs.readFileSync(`corpus/${name}.vl.json`, 'utf8'))
const vg = vl.compile(spec).spec as any
const a = canonicalizeSvg(await renderWithVega(vg)).records
const b = canonicalizeSvg(renderSpec(vg)).records
const ta = a.filter(r => r.startsWith('text|')), tb = b.filter(r => r.startsWith('text|'))
console.log(`${name}: oracle text records: ${ta.length}, ours: ${tb.length}`)
console.log('oracle first 3:', ta.slice(0, 3))
