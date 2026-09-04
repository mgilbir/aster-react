import * as vl from 'vega-lite'
import { renderSpec } from '@aster/core'
import { loadSpecData } from '@aster/core/load'
import { canonicalizeSvg, diffCanonical } from '../src/normalize.js'
import { renderWithVega } from '../src/render-vega.js'
import * as fs from 'node:fs'

const spec = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const vg = process.argv[2].endsWith('.vl.json') ? (vl.compile(spec).spec as any) : spec
const oracleSvg = await renderWithVega(vg)
const ourSvg = renderSpec(await loadSpecData(vg as never) as never)
const diffs = diffCanonical(canonicalizeSvg(oracleSvg), canonicalizeSvg(ourSvg))
console.log(`${diffs.length} diffs`)
for (const d of diffs.slice(0, 6)) console.log(d)
