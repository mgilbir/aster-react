import * as vl from 'vega-lite'
const rows = [{ c: 'alpha', v: 28, t: '2024-01-07' }, { c: 'beta', v: 55, t: '2024-03-19' }]
const spec: any = { $schema: 'https://vega.github.io/schema/vega-lite/v6.json', width: 200, height: 120, data: { values: rows }, mark: 'arc', encoding: { theta: { field: 't', type: 'temporal', timeUnit: 'year' }, color: { field: 'c', type: 'nominal' } } }
const c: any = vl.compile(spec).spec
for (const d of c.data ?? []) if (d.transform) console.log(d.name, JSON.stringify(d.transform))
console.log('arc:', JSON.stringify({ sa: c.marks?.[0]?.encode?.update?.startAngle, ea: c.marks?.[0]?.encode?.update?.endAngle }))
console.log('theta:', JSON.stringify(c.scales?.find((s: any) => s.name === 'theta')?.domain))
