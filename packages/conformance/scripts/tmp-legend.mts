import {readFileSync} from 'node:fs'
import {compileChart,evaluateChart} from '@aster/core'
const spec=JSON.parse(readFileSync('/tmp/case-ours.vg.json','utf8'))
const chart=compileChart(spec as never); const scene:any=evaluateChart(chart,{})
function walk(n:any,p=''){ if(n&&n.role==='legend'){ console.log('LEGEND',n.x,n.y,n.width,n.height); for(const it of n.items||[]) console.log(it.text??it.path,it.x,it.y,it.fill,it.fontSize) } for(const it of n.items||[]) walk(it,p) }
walk(scene)
