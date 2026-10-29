import { readFileSync } from 'node:fs'
import '@aster/core/geo'
import '@aster/core/transforms'
import { renderSpec } from '@aster/core'
import { loadSpecData, TRUSTED_LOAD_OPTIONS } from '@aster/core/load'
import * as vl from 'vega-lite'
import { compile } from '@aster/vl'
import { vegaSvg } from './src/gallery/oracle.js'
import { BASE_URL, fileFetch } from './src/gallery/lib.js'
import { canonicalizeSvg, diffCanonical } from './src/normalize.js'
const spec = JSON.parse(readFileSync(process.argv[2]!, 'utf8'))
const ourVg = compile(JSON.parse(JSON.stringify(spec)) as never) as any
const o = (vl as any).compile(JSON.parse(JSON.stringify(spec))).spec
const loaded = await loadSpecData(JSON.parse(JSON.stringify(ourVg)) as never, { ...TRUSTED_LOAD_OPTIONS, fetch: fileFetch, baseURL: BASE_URL })
const mine = renderSpec(loaded as never) as string
const vegaOfMine = await vegaSvg(ourVg)
const oracle = await vegaSvg(o)
console.log('vega(aster out) vs oracle:', diffCanonical(canonicalizeSvg(oracle), canonicalizeSvg(vegaOfMine)).slice(0, 3))
console.log('aster runtime vs oracle:', diffCanonical(canonicalizeSvg(oracle), canonicalizeSvg(mine)).slice(0, 6))
process.exit(0)
