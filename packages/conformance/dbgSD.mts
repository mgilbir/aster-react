import '@aster/core/geo'
import '@aster/core/transforms'
import { renderSpec } from '@aster/core'
import { loadSpecData } from '@aster/core/load'
const spec: any = {
  $schema: 'https://vega.github.io/schema/vega/v6.json',
  width: 200, height: 120, padding: 5,
  data: [{ name: 't', values: [{ c: 'north', v: 1 }] }],
  scales: [{ name: 'colour', type: 'ordinal', domain: { data: 't', field: 'c' }, range: 'category' }],
  legends: [{ fill: 'colour', symbolDash: [4, 2] }],
  marks: [],
}
const svg = renderSpec(await loadSpecData(spec) as never)
const i = svg.indexOf('role="legend"')
console.log(svg.slice(i, i + 320))
