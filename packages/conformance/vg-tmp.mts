// compile a gallery/VL spec with both compilers, render both with REAL vega, print the canonical diff (separates compiler from runtime)
import * as vl from 'vega-lite'
import { readFileSync } from 'node:fs'
import { compile } from '@aster/vl'
import { vegaSvg, settle } from './src/gallery/oracle.js'
import { canonicalizeSvg, diffCanonical } from './src/normalize.js'
const spec = JSON.parse(readFileSync(process.argv[2]!, 'utf8'))
const o = (vl as any).compile(JSON.parse(JSON.stringify(spec))).spec
const a = compile(JSON.parse(JSON.stringify(spec)) as never) as any
let so = '', sa = ''
try { so = await vegaSvg(o) } catch (e) { console.log('ORACLE threw', String(e)) }
try { sa = await vegaSvg(a) } catch (e) { console.log('ASTER output under vega threw', String(e)) }
await settle()
if (so && sa) console.log(diffCanonical(canonicalizeSvg(so), canonicalizeSvg(sa)).slice(0, 5))
process.exit(0)
