import { readFileSync } from 'node:fs'
import { renderWithVega } from './src/render-vega.ts'
import * as vl from 'vega-lite'
const spec = JSON.parse(readFileSync('corpus/legend-scatter.vl.json', 'utf8'))
const compiled = (vl.compile as any)(spec).spec
console.log('legend:', JSON.stringify(compiled.legends?.[0]))
const svg = await renderWithVega(compiled)
const paths = (svg.match(/<path[^>]*d="M0,0[^"]*"[^>]*>/g) ?? [])
for (const p of paths.slice(0, 6)) console.log('  ', p.slice(p.indexOf('d="') + 3, p.indexOf('"', p.indexOf('d="') + 3)).slice(0, 40))
const texts = (svg.match(/<text[^>]*>[^<]*<\/text>/g) ?? []).filter((t) => />(A|B|C|D)<|>cat</.test(t))
for (const t of texts.slice(0, 3)) console.log('  tx:', t.slice(t.indexOf('translate'), t.indexOf('rotate') > 0 ? t.indexOf('rotate') : t.indexOf('>') + 8))
