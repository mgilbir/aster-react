import '@aster/core/geo'
import '@aster/core/transforms'
import { renderSpec } from '@aster/core'
import { loadSpecData } from '@aster/core/load'
const spec: any = {
  $schema: 'https://vega.github.io/schema/vega/v6.json',
  width: 200, height: 120, padding: 5, background: 'white',
  data: [{ name: 't', values: [{ c: 'north', v: 28 }] }],
  scales: [
    { name: 'y', type: 'linear', domain: [0, 100], range: [120, 0] },
    { name: 'x', type: 'band', domain: { data: 't', field: 'c' }, range: 'width' },
  ],
  axes: [{ orient: 'left', scale: 'y', title: 'amount' }, { orient: 'bottom', scale: 'x' }],
  marks: [],
}
const svg = renderSpec(await loadSpecData(spec) as never)
const i = svg.indexOf('amount')
console.log(svg.slice(i-260, i+40))
