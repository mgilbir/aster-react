import { readFileSync } from 'node:fs'
import '@aster/core/geo'
import '@aster/core/transforms'
import { renderSpec } from '@aster/core'
import { loadSpecData, TRUSTED_LOAD_OPTIONS } from '@aster/core/load'
import { compile } from '@aster/vl'
import { BASE_URL, fileFetch } from './src/gallery/lib.js'
const spec = JSON.parse(readFileSync(process.argv[2]!, 'utf8'))
const ourVg = compile(JSON.parse(JSON.stringify(spec)) as never) as any
const loaded = await loadSpecData(JSON.parse(JSON.stringify(ourVg)) as never, { ...TRUSTED_LOAD_OPTIONS, fetch: fileFetch, baseURL: BASE_URL })
const svg = renderSpec(loaded as never) as string
console.log(svg.length)
process.exit(0)
