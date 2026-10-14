import { readFileSync } from 'node:fs'
import { renderSpec } from '@aster/core'
import { loadSpecData } from '@aster/core/load'
import { canonicalizeSvg, diffCanonical } from './src/normalize.ts'
import { renderWithVega } from './src/render-vega.ts'
const base: any = {
  $schema: 'https://vega.github.io/schema/vega/v6.json',
  width: 200, height: 120, padding: 5, title: { text: 'Quarterly totals', subtitle: 'by region' },
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
  legends: [{ fill: 'colour', title: 'region', titlePadding: 0 }],
  marks: [],
}
const ours = renderSpec(await loadSpecData(JSON.parse(JSON.stringify(base))) as never)
const oracle = await renderWithVega(base)
const a = canonicalizeSvg(oracle)
const b = canonicalizeSvg(ours)
console.log('ORACLE records:')
for (const r of a.records.slice(10, 20)) console.log(' ', r.slice(0, 130))
