import * as vl from 'vega-lite'
import { compile } from '@aster/vl'
const spec = JSON.parse(process.argv[2])
const o = (vl as any).compile(JSON.parse(JSON.stringify(spec))).spec
const a = compile(JSON.parse(JSON.stringify(spec)) as never) as any
const find=(vg:any,pat:RegExp)=>{const out:string[]=[];const w=(p:string,v:any)=>{if(Array.isArray(v))v.forEach((x,i)=>w(p+'['+i+']',x));else if(v&&typeof v==='object')for(const[k,x]of Object.entries(v))w(p+'.'+k,x);else if(typeof v==='string'&&pat.test(v))out.push(p+' = '+v)};w('',vg);return out}
const pat=new RegExp(process.argv[3])
console.log('ORACLE');find(o,pat).forEach(x=>console.log(x));console.log('ASTER');find(a,pat).forEach(x=>console.log(x))
