import * as vl from 'vega-lite'
import { readFileSync } from 'node:fs'
const spec = JSON.parse(readFileSync(process.argv[2]!, 'utf8'))
const o = (vl as any).compile(spec).spec
const pick = eval('(vg)=>' + process.argv[3])
console.log(typeof pick(o) === 'string' ? pick(o) : JSON.stringify(pick(o), null, 1))
