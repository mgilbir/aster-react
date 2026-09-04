import * as vega from 'vega'
const spec1 = {
  data: [{ name: 't', values: [{ x: '5', y: '2024-01-15', s: '007', b: 'true' }], format: { parse: { x: 'number', y: 'date', b: 'boolean' } } }],
  scales: [{ name: 'sc', type: 'linear', domain: { data: 't', field: 'x' }, range: [0, 1] }],
  marks: [{ type: 'rule', from: { data: 't' }, encode: { update: { text: { signal: 'datum.x + ":" + datum.y' } } } }],
}
const view = new vega.View(vega.parse(spec1 as never), { renderer: 'none' })
await view.runAsync()
console.log('Q1 inline + format.parse:', JSON.stringify(view.data('t' as never)))
const spec2 = { data: [{ name: 't', values: 'x,y\n1,2\n3,4', format: { type: 'csv' } }] }
const view2 = new vega.View(vega.parse(spec2 as never), { renderer: 'none' })
await view2.runAsync()
console.log('Q2 values-as-csv-string:', JSON.stringify(view2.data('t' as never)))
const spec3 = { data: [{ name: 't', url: 'data:text/csv,x,y%0A1,2%0A3,4', format: { type: 'csv' } }] }
const view3 = new vega.View(vega.parse(spec3 as never), { renderer: 'none' })
await view3.runAsync()
console.log('Q3 data-url csv:', JSON.stringify(view3.data('t' as never)))
const topo = { type: 'Topology', objects: { reg: { type: 'GeometryCollection', geometries: [{ type: 'Polygon', arcs: [], properties: { name: 'a' } }] } }, arcs: [] }
const spec4 = { data: [{ name: 'topo', values: topo as never }, { name: 'geo', source: 'topo', format: { type: 'topojson', feature: 'reg' } }] }
const view4 = new vega.View(vega.parse(spec4 as never), { renderer: 'none' })
await view4.runAsync()
console.log('Q4 topojson feature:', JSON.stringify(view4.data('geo' as never)).slice(0, 140))
const spec5 = { data: [{ name: 'j', values: '{"rows":[{"a":1},{"a":2}]}', format: { type: 'json', property: 'rows' } }] }
const view5 = new vega.View(vega.parse(spec5 as never), { renderer: 'none' })
await view5.runAsync()
console.log('Q5 json property:', JSON.stringify(view5.data('j' as never)))
view.finalize(); view2.finalize(); view3.finalize(); view4.finalize(); view5.finalize()
