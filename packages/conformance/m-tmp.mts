import * as vl from 'vega-lite'
import { compile } from '@aster/vl'
const spec = JSON.parse(process.argv[2])
const o = (vl as any).compile(JSON.parse(JSON.stringify(spec))).spec
let a: any; try { a = compile(JSON.parse(JSON.stringify(spec)) as never) as any } catch (e) { a = {error: String(e)} }
const pick=(vg:any)=>JSON.stringify(eval('(vg)=>'+process.argv[3])(vg),null,1)
console.log('ORACLE',pick(o));console.log('ASTER',pick(a))
