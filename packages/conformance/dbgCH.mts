import { renderWithVega } from './src/render-vega.ts'
const base: any = {
  $schema: 'https://vega.github.io/schema/vega/v6.json',
  width: 200, height: 120, padding: 5,
  data: [{ name: 't', values: [
    { c: 'alpha', v: 28, g: 'north' }, { c: 'beta', v: 55, g: 'south' },
    { c: 'gamma', v: 43, g: 'north' }, { c: 'delta', v: 91, g: 'east' }] }],
  scales: [
    { name: 'x', type: 'band', domain: { data: 't', field: 'c' }, range: 'width', padding: 0.1 },
    { name: 'y', type: 'linear', domain: { data: 't', field: 'v' }, range: 'height', nice: true },
    { name: 'colour', type: 'ordinal', domain: { data: 't', field: 'g' }, range: 'category' },
  ],
  legends: [{ fill: 'colour', title: 'region' }],
  marks: [],
}
for (const over of [undefined, { clipHeight: 0.5 }, { clipHeight: 8 }, { titlePadding: 0 }, { titleFontSize: 0 }]) {
  const spec = JSON.parse(JSON.stringify(base))
  if (over) Object.assign(spec.legends[0], over)
  const svg = await renderWithVega(spec)
  const paths = (svg.match(/<path[^>]*d="M0,0[^"]*"[^>]*>/g) ?? [])
  console.log('===', JSON.stringify(over ?? 'base'))
  for (const p of paths.slice(0, 6)) console.log('  ', p.slice(p.indexOf('d="') + 3, p.indexOf('"', p.indexOf('d="') + 3)))
}
