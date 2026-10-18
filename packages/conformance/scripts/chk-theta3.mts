import * as vl from 'vega-lite'
const rows = [{ c: 'alpha', v: 28, w: 3 }, { c: 'beta', v: 55, w: 7 }]
for (const [tag, enc] of [
  ['agg+color', { theta: { aggregate: 'average', field: 'v', type: 'quantitative' }, color: { field: 'c', type: 'nominal' } }],
  ['agg+radius', { theta: { field: 'v', type: 'quantitative' }, radius: { aggregate: 'average', field: 'w', type: 'quantitative' } }],
] as const) {
  const spec: any = { $schema: 'https://vega.github.io/schema/vega-lite/v6.json', width: 200, height: 120, data: { values: rows }, mark: 'arc', encoding: enc }
  const c: any = vl.compile(spec).spec
  console.log('==', tag)
  for (const d of c.data ?? []) if (d.transform) console.log('  ', d.name, JSON.stringify(d.transform))
  console.log('   arc:', JSON.stringify(c.marks?.[0]?.encode?.update))
  console.log('   scales:', JSON.stringify((c.scales ?? []).map((s: any) => ({ n: s.name, d: s.domain, r: s.range }))))
}
