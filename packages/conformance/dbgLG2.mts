import { loadSpecData } from '@aster/core/load'
import { renderWithVega } from './src/render-vega.ts'
const base: any = {
  width: 200, height: 120, padding: 5, background: 'white',
  title: { text: 'Quarterly totals', subtitle: 'by region' },
  data: [{ name: 't', values: [
    { c: 'alpha', v: 28, g: 'north' }, { c: 'beta', v: 55, g: 'south' },
    { c: 'gamma', v: 43, g: 'north' }, { c: 'delta', v: 91, g: 'east' }] }],
  scales: [
    { name: 'x', type: 'band', domain: { data: 't', field: 'c' }, range: 'width', padding: 0.1 },
    { name: 'y', type: 'linear', domain: { data: 't', field: 'v' }, range: 'height', nice: true },
    { name: 'colour', type: 'ordinal', domain: { data: 't', field: 'g' }, range: 'category' },
  ],
  axes: [
    { orient: 'bottom', scale: 'x', title: 'category' },
    { orient: 'left', scale: 'y', title: 'amount', tickCount: 4 },
  ],
  legends: [{ fill: 'colour', title: 'region' }],
  marks: [{ type: 'rect', from: { data: 't' }, encode: { enter: {
    x: { scale: 'x', field: 'c' }, width: { scale: 'x', band: 1 },
    y: { scale: 'y', field: 'v' }, y2: { scale: 'y', value: 0 },
    fill: { scale: 'colour', field: 'g' } } } }],
}
const svg = await renderWithVega(await loadSpecData(base) as never)
const i = svg.indexOf('mark-group role-legend')
process.stdout.write(svg.slice(i - 60, i + 1900).split('><').join('>\n<') + '\n')
