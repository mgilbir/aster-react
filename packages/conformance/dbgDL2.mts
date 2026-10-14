import { readFileSync } from 'node:fs'
import { renderWithVega } from './src/render-vega.ts'
import * as vl from 'vega-lite'
const spec = JSON.parse(readFileSync('corpus/detail-line.vl.json', 'utf8'))
const compiled = (vl.compile as any)(spec).spec
process.stdout.write('LEG ' + JSON.stringify(compiled.legends) + '\n')
const svg = await renderWithVega(compiled)
const i = svg.indexOf('legends')
process.stdout.write(svg.slice(i - 60, i + 900) + '\n')
