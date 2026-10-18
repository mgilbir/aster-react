import * as vl from 'vega-lite'
const rows = [{ c: 'alpha', v: 28 }, { c: 'beta', v: 55 }]
for (const sort of ['ascending', 'descending']) {
  const spec: any = { $schema: 'https://vega.github.io/schema/vega-lite/v6.json', width: 200, height: 120, data: { values: rows }, mark: 'arc', encoding: { theta: { field: 'v', type: 'quantitative', sort }, color: { field: 'c', type: 'nominal' } } }
  const c: any = vl.compile(spec).spec
  const d0 = (c.data ?? []).find((d: any) => d.transform?.some((t: any) => t.type === 'stack'))
  console.log(sort, '→ stack:', JSON.stringify(d0?.transform?.find((t: any) => t.type === 'stack')))
}
