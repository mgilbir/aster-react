import * as vl from 'vega-lite'
const rows = [{ c: 'alpha', v: 28 }, { c: 'beta', v: 55 }]
for (const [tag, enc] of [
  ['format', { x: { field: 'w', type: 'quantitative' }, y: { field: 'c', type: 'nominal' }, color: { field: 'v', type: 'quantitative', legend: { format: '.2f' } } }],
  ['cornerRadius', { x: { field: 'w', type: 'quantitative' }, y: { field: 'c', type: 'nominal' }, color: { field: 'v', type: 'quantitative', legend: { cornerRadius: 8 } } }],
] as const) {
  const spec: any = { $schema: 'https://vega.github.io/schema/vega-lite/v6.json', width: 200, height: 120, data: { values: [...rows, { c: 'gamma', w: 5, v: 43 }] }, mark: 'point', encoding: enc }
  const c: any = vl.compile(spec).spec
  console.log('==', tag)
  console.log('  legend:', JSON.stringify(c.legends?.[0]))
}
