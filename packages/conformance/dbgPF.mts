import { readFileSync } from 'node:fs'
import { renderWithVega } from './src/render-vega.ts'
import * as vl from 'vega-lite'
for (const f of ['point-filled-stroke', 'detail-line', 'multi-line']) {
  const spec = JSON.parse(readFileSync(`corpus/${f}.vl.json`, 'utf8'))
  const compiled = (vl.compile as any)(spec).spec
  console.log('===', f, JSON.stringify(compiled.legends?.[0]).slice(0, 260))
  const svg = await renderWithVega(compiled)
  const paths = (svg.match(/<path[^>]*d="M0,0h\d+v\d+[^"]*"[^>]*>/g) ?? [])
  for (const p of paths.slice(0, 6)) console.log('  ', p.slice(p.indexOf('d="') + 3, p.indexOf('"', p.indexOf('d="') + 3)).slice(0, 40))
}
