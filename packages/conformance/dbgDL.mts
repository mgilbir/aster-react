import { readFileSync } from 'node:fs'
import { renderWithVega } from './src/render-vega.ts'
import * as vl from 'vega-lite'
const spec = JSON.parse(readFileSync('corpus/detail-line.vl.json', 'utf8'))
const compiled = (vl.compile as any)(spec).spec
const svg = await renderWithVega(compiled)
process.stdout.write('LEN ' + svg.length + '\n')
const i = svg.indexOf('role="legend"')
process.stdout.write('IDX ' + i + '\n')
process.stdout.write(svg.slice(i, i + 600) + '\n')
