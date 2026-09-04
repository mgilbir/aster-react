import * as fs from 'node:fs'
import { renderWithVega } from '../src/render-vega.js'
const spec = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const isVl = process.argv[2].endsWith('.vl.json')
let vg = spec as any
if (isVl) { const vl = await import('vega-lite'); vg = vl.compile(spec).spec }
const svg = await renderWithVega(vg)
fs.writeFileSync(process.argv[3], svg)
console.log('written')
