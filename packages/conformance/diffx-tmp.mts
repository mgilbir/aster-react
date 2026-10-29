import * as vl from 'vega-lite'
import { compile } from '@aster/vl'
import { expressionDiff } from './test/vl-expressions.js'
const spec = JSON.parse(process.argv[2])
const o = (vl as any).compile(JSON.parse(JSON.stringify(spec))).spec
const a = compile(JSON.parse(JSON.stringify(spec)) as never) as any
console.log(expressionDiff(a, o) || 'SAME')
if (process.argv[3]) { console.log(JSON.stringify(process.argv[3]==='o'?o:a, null, 1)) }
