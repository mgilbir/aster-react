import * as vega from 'vega'
import * as vl from 'vega-lite'
import { readFileSync } from 'node:fs'
import { compile } from '@aster/vl'
import { BASE_URL, fileFetch } from './src/gallery/lib.js'
const spec = JSON.parse(readFileSync(process.argv[2]!, 'utf8'))
const which = process.argv[3] === 'o' ? (vl as any).compile(spec).spec : compile(spec as never)
const loader = vega.loader({ baseURL: BASE_URL, mode: 'http' })
;(loader as any).http = async (url: string, options: any) => { const res = await fileFetch(url); const t = options?.response; return (t && typeof (res as any)[t] === 'function' ? (res as any)[t]() : res.text()) as any }
const view = new vega.View(vega.parse(which), { renderer: 'none', loader, logLevel: vega.Warn })
await view.runAsync()
const out: any = {}
for (const k of (process.argv[4] ?? '').split(',').filter(Boolean)) { try { out[k] = view.signal(k) } catch (e) { out[k] = 'ERR ' + e } }
console.log(JSON.stringify(out))
for (const d of (process.argv[5] ?? '').split(',').filter(Boolean)) { try { console.log(d, view.data(d).length, JSON.stringify(view.data(d).slice(0, 2))) } catch (e) { console.log(d, 'ERR', String(e)) } }
process.exit(0)
