import * as vl from 'vega-lite'
import { compile } from '@aster/vl'
import { readFileSync } from 'node:fs'
const spec = JSON.parse(readFileSync(process.argv[2]!, 'utf8'))
const o = (vl as any).compile(JSON.parse(JSON.stringify(spec))).spec
let a: any; try { a = compile(JSON.parse(JSON.stringify(spec)) as never) as any } catch (e) { a = { error: String(e) } }
const pick = eval('(vg)=>' + process.argv[3])
const j = (x: unknown) => JSON.stringify(x, null, 1)
const jo = j(pick(o)), ja = j(pick(a))
console.log('ORACLE', jo.slice(0, +(process.argv[4] ?? 3000)))
console.log('ASTER', ja.slice(0, +(process.argv[4] ?? 3000)))
console.log(jo === ja ? 'IDENTICAL' : 'DIFFERENT')
