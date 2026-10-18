import * as vl from 'vega-lite'
const rows = [{ c: 'alpha', v: 28 }, { c: 'beta', v: 55 }, { c: 'gamma', v: 43 }, { c: 'delta', v: 91 }]
for (const [tag, enc] of [
  ['field+color', { theta: { field: 'v', type: 'quantitative' }, color: { field: 'c', type: 'nominal' } }],
  ['agg+color', { theta: { aggregate: 'average', field: 'v', type: 'quantitative' }, color: { field: 'c', type: 'nominal' } }],
  ['agg only', { theta: { aggregate: 'average', field: 'v', type: 'quantitative' } }],
  ['field+radius', { theta: { field: 'v', type: 'quantitative' }, radius: { field: 'w', type: 'quantitative' } }],
] as const) {
  const spec: any = { $schema: 'https://vega.github.io/schema/vega-lite/v6.json', width: 200, height: 120, data: { values: rows }, mark: 'arc', encoding: enc }
  const c: any = vl.compile(spec).spec
  const d0 = (c.data ?? []).find((d: any) => d.name === 'data_0')
  const stack = JSON.stringify(d0?.transform ?? []).includes('stack')
  const rule = c.marks?.[0]?.encode?.update
  console.log(tag, '| stack:', stack, '| startAngle:', JSON.stringify(rule.startAngle), 'endAngle:', JSON.stringify(rule.endAngle), '| theta domain:', JSON.stringify(c.scales?.find((s: any) => s.name === 'theta')?.domain), '| outerRadius:', JSON.stringify(rule.outerRadius), '| groups:', c.marks?.[0]?.groupby)
}
