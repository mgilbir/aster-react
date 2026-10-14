import { loadSpecData } from '@aster/core/load'
import { renderWithVega } from './src/render-vega.ts'
const base: any = {
  $schema: 'https://vega.github.io/schema/vega/v6.json',
  width: 200, height: 120, padding: 5, background: 'white',
  data: [{ name: 't', values: [
    { c: 'alpha', v: 28, g: 'north' }, { c: 'beta', v: 55, g: 'south' },
    { c: 'gamma', v: 43, g: 'north' }, { c: 'delta', v: 91, g: 'east' }] }],
  scales: [
    { name: 'x', type: 'linear', domain: { data: 't', field: 'c' }, range: 'width' },
    { name: 'y', type: 'linear', domain: { data: 't', field: 'v' }, range: 'height' },
  ],
  marks: [{ type: 'area', from: { data: 't' }, encode: { enter: {
    x: { scale: 'x', field: 'c' },
    y: { scale: 'y', field: 'v' }, y2: { scale: 'y', value: 0 },
    fill: { value: 'steelblue' } } } }],
}
for (const [name, cfg] of [['base', {}], ['yc-0', { yc: 0 }], ['yc-8', { yc: 8 }], ['y2-100', { y2: 100 }], ['height-40', { height: 40 }]] as [string, any][]) {
  const spec = JSON.parse(JSON.stringify(base))
  if (Object.keys(cfg).length) (spec as any).config = { area: cfg }
  const svg = await renderWithVega(await loadSpecData(spec) as never)
  console.log('===', name)
  for (const m of svg.match(/<path d="M-?[\d.]+[^"]*"/g) ?? []) console.log('  ', m.slice(0, 130))
}
