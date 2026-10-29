import * as vl from 'vega-lite'
import { readFileSync } from 'node:fs'
import { compile } from '@aster/vl'
import { vegaSvg, settle } from './src/gallery/oracle.js'
const spec = JSON.parse(readFileSync(process.argv[2]!, 'utf8'))
const o = (vl as any).compile(JSON.parse(JSON.stringify(spec))).spec
const a = compile(JSON.parse(JSON.stringify(spec)) as never) as any
const so = await vegaSvg(o), sa = await vegaSvg(a)
console.log(so.length, sa.length, (so.match(/<path/g) || []).length, (sa.match(/<path/g) || []).length)
const bars = (s: string) => [...s.matchAll(/d="(M[\d.,]+L[\d.,]+L[\d.,]+L[\d.,]+Z)" fill="#4c78a8"/g)].map(m => m[1])
const bo = bars(so), ba = bars(sa)
console.log(bo.length, ba.length, bo.filter((x) => !ba.includes(x)).slice(0,3), ba.filter((x) => !bo.includes(x)).slice(0,3))
const cl = (s: string) => [...new Set([...s.matchAll(/<rect[^>]*width="(\d+)"[^>]*height="(\d+)"/g)].map(m => m[1]+"x"+m[2]))]; console.log(cl(so), cl(sa)); console.log(so.slice(0,600)); console.log(sa.slice(0,600)); process.exit(0)
