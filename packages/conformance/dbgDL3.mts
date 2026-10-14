import { readFileSync } from 'node:fs'
import { renderWithVega } from './src/render-vega.ts'
import * as vl from 'vega-lite'
const spec = JSON.parse(readFileSync('corpus/detail-line.vl.json', 'utf8'))
const compiled = (vl.compile as any)(spec).spec
const svg = await renderWithVega(compiled)
const i = svg.indexOf('>cat<')
process.stdout.write(svg.slice(Math.max(0, i - 900), i + 30) + '\n')
