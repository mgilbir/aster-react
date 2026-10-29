import * as vl from 'vega-lite'
import { readFileSync, writeFileSync } from 'node:fs'
import { compile } from '@aster/vl'
import { vegaSvg } from './src/gallery/oracle.js'
const spec = JSON.parse(readFileSync(process.argv[2]!, 'utf8'))
const o = (vl as any).compile(JSON.parse(JSON.stringify(spec))).spec
const a = compile(JSON.parse(JSON.stringify(spec)) as never) as any
writeFileSync('/tmp/gallery-vl-round2-scratch/o.svg', (await vegaSvg(o)).replace(/></g, '>\n<'))
writeFileSync('/tmp/gallery-vl-round2-scratch/a.svg', (await vegaSvg(a)).replace(/></g, '>\n<'))
process.exit(0)
