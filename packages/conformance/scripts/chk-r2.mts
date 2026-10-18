import * as vl from 'vega-lite'
const rows = [{ c: 'alpha', v: 28, w: 3 }, { c: 'beta', v: 55, w: 7 }]
for (const [tag, enc] of [
  ['stack-center', { theta: { field: 'v', type: 'quantitative' }, radius: { field: 'w', type: 'quantitative', stack: 'center' } }],
  ['sort-desc', { theta: { field: 'v', type: 'quantitative' }, radius: { field: 'w', type: 'quantitative', sort: 'descending' } }],
] as const) {
  const spec: any = { $schema: 'https://vega.github.io/schema/vega-lite/v6.json', width: 200, height: 120, data: { values: rows }, mark: 'arc', encoding: enc }
  const c: any = vl.compile(spec).spec
  console.log('==', tag)
  for (const d of c.data ?? []) if (d.transform) console.log('  ', d.name, JSON.stringify(d.transform))
  console.log('  arc:', JSON.stringify({ oa: c.marks?.[0]?.encode?.update?.outerRadius, ia: c.marks?.[0]?.encode?.update?.innerRadius, sa: c.marks?.[0]?.encode?.update?.startAngle }))
  console.log('  radius scale:', JSON.stringify(c.scales?.find((s: any) => s.name === 'radius')))
}
