import {readFileSync} from 'node:fs'
import * as vega from 'vega'
import {compileChart, buildScale} from '@aster/core'
const spec=JSON.parse(readFileSync('/tmp/case-ours.vg.json','utf8'))
const rt=vega.parse(spec); const view=new (vega as any).View(rt,{renderer:'none'}); await view.runAsync()
const os=view.scale('color'); console.log('oracle domain',os.domain(),'range',os.range()); console.log('oracle vals',[3,5,7,9].map(v=>os(v)))
const chart=compileChart(spec as never); const sc=chart.scales.find(s=>s.name==='color')!; if ((sc as any).range==='category') (sc as any).range='tableau10'
const rows=(spec.data as any[]).find(d=>d.values)?.values ?? []
const our=buildScale(sc as any,{width:200,height:120,signals:{width:200,height:120},dataField:(_d,f)=>rows.map((r:any)=>r[f]),dataRows:()=>rows})
console.log('our domain',our.domain(),'range',our.range()); console.log('our vals',[3,5,7,9].map(v=>String(our(v))))
view.finalize()
