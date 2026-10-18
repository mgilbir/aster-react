import * as vl from 'vega-lite'
const rows = [{ c: 'alpha', v: 28 }, { c: 'beta', v: 55 }]
for (const bp of [0, 0.5]) {
  const spec: any = { $schema: 'https://vega.github.io/schema/vega-lite/v6.json', width: 200, height: 120, data: { values: rows }, mark: 'arc', encoding: { theta: { field: 'v', type: 'quantitative', bandPosition: bp }, color: { field: 'c', type: 'nominal' } } }
  const c: any = vl.compile(spec).spec
  console.log('bp', bp, 'arc:', JSON.stringify({ sa: c.marks?.[0]?.encode?.update?.startAngle, ea: c.marks?.[0]?.encode?.update?.endAngle, d: c.scales?.find((s: any) => s.name === 'theta')?.domain }))
  for (const d of c.data ?? []) if (d.transform?.some((t: any) => t.type === 'stack')) console.log('  stack:', JSON.stringify(d.transform.find((t: any) => t.type === 'stack')))
}
