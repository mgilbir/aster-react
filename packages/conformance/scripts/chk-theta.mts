import * as vl from 'vega-lite'
import { renderWithVega } from '../src/render-vega.js'
import { renderSpec } from '@aster/core'
import { compile as compileOurs } from '@aster/vl'
import '@aster/core/transforms'
const spec: any = {
  $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
  width: 200, height: 120,
  data: { values: [{ c: 'alpha', v: 28 }, { c: 'beta', v: 55 }, { c: 'gamma', v: 43 }, { c: 'delta', v: 91 }] },
  mark: 'arc',
  encoding: { theta: { field: 'v', type: 'quantitative' }, radius: { field: 'w', type: 'quantitative' } },
}
const o = await renderWithVega(vl.compile(spec).spec)
const u = renderSpec(compileOurs(spec) as never) as string
console.log('oracle arcs:', [...o.matchAll(/<path[^>]*fill[^>]*>/g)].map(m => /d="([^"]*)"/.exec(m[0])?.[1]).slice(0, 4))
console.log('ours arcs:', [...u.matchAll(/<path[^>]*fill[^>]*>/g)].map(m => /d="([^"]*)"/.exec(m[0])?.[1]).slice(0, 4))
const co: any = vl.compile(spec).spec
const cu: any = compileOurs(spec)
console.log('oracle arc:', JSON.stringify(co.marks?.[0]?.encode?.update))
console.log('ours arc:', JSON.stringify(cu.marks?.[0]?.encode?.update))
console.log('oracle theta scale:', JSON.stringify(co.scales?.find((s: any) => s.name === 'theta')))
console.log('ours theta scale:', JSON.stringify(cu.scales?.find((s: any) => s.name === 'theta')))
console.log('oracle radius scale:', JSON.stringify(co.scales?.find((s: any) => s.name === 'radius')))
console.log('ours radius scale:', JSON.stringify(cu.scales?.find((s: any) => s.name === 'radius')))
console.log('oracle outerRadius:', JSON.stringify(co.marks?.[0]?.encode?.update?.outerRadius), 'ours:', JSON.stringify(cu.marks?.[0]?.encode?.update?.outerRadius))
console.log('oracle data:', JSON.stringify(co.data?.filter((d: any) => d.transform)))
console.log('ours data:', JSON.stringify(cu.data?.filter((d: any) => d.transform)))
