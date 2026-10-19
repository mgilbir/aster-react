import {readFileSync} from 'node:fs'
import * as vega from 'vega'
import {compileChart, buildScale} from '@aster/core'
const spec=JSON.parse(readFileSync('/tmp/case-ours.vg.json','utf8'))
const rt=vega.parse(spec); const view=new (vega as any).View(rt,{renderer:'none'}); await view.runAsync()
const os=view.scale('color'); console.log('oracle domain',os.domain())
for (const n of [undefined,2,2.4,3,4,5,6,10]) console.log('o ticks',n,os.ticks(n))
const chart=compileChart(spec as never); const sc=chart.scales.find(s=>s.name==='color')!
const rows=(spec.data as any[]).find(d=>d.values)?.values ?? []
const our=buildScale(sc as any,{width:200,height:120,signals:{width:200,height:120},dataField:(_d,f)=>rows.map((r:any)=>r[f]),dataRows:()=>rows})
console.log('our domain',our.domain())
for (const n of [undefined,2,2.4,3,4,5,6,10]) console.log('u ticks',n,(our as any).ticks(n))
view.finalize()
