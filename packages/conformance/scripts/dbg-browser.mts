/**
 * Debug: dump oracle + aster SVGs for one corpus entry, in-browser.
 * Usage: npx tsx scripts/dbg-browser.mts <corpus-name-substr> [outprefix]
 */
import { readdirSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const THIS_DIR = dirname(fileURLToPath(import.meta.url))
const CONF_DIR = dirname(THIS_DIR)
const OUT_DIR = join(CONF_DIR, '.tmp-dbg-browser')

const name = process.argv[2] ?? 'bar-color-blueorange'
const prefix = process.argv[3] ?? 'dbg'

const corpus = join(CONF_DIR, 'corpus')
const files = readdirSync(corpus, { recursive: true }).filter((f) => String(f).endsWith('.json')).map(String).sort()
const hit = files.find((f) => f.includes(name))
if (!hit) { console.error(`no corpus entry matching ${name}`); process.exit(1) }
const spec = JSON.parse(readFileSync(join(corpus, hit), 'utf8'))

const entrySrc = `
import embed from 'vega-embed'
import { renderSpec } from '@aster/core'
import { compile } from '@aster/vl'
import '@aster/core/transforms'
import '@aster/core/geo'

window.__run = async (spec) => {
  const isVl = String(spec.$schema ?? '').includes('vega-lite')
  const host = document.createElement('div')
  document.body.appendChild(host)
  await embed(host, spec, { actions: false, renderer: 'svg' })
  const oracleSvg = host.querySelector('svg')?.outerHTML ?? ''
  host.remove()
  const compiled = isVl ? compile(spec) : spec
  const ourSvg = renderSpec(compiled)
  return { oracleSvg, ourSvg }
}
`

rmSync(OUT_DIR, { recursive: true, force: true })
mkdirSync(OUT_DIR, { recursive: true })
writeFileSync(join(OUT_DIR, 'entry.ts'), entrySrc)
await build({
  entryPoints: [join(OUT_DIR, 'entry.ts')],
  bundle: true, format: 'iife', platform: 'browser',
  outfile: join(OUT_DIR, 'page.js'), define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent',
})
writeFileSync(join(OUT_DIR, 'index.html'), `<!doctype html><html><body><script src="./page.js"></script></body></html>`)

const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] })
const page = await browser.newPage()
await page.goto(`file://${join(OUT_DIR, 'index.html')}`)
await page.waitForFunction(() => '__run' in window, null, { timeout: 30_000 })
const { oracleSvg, ourSvg } = await page.evaluate(async (s) => await (window as any).__run(s), spec)
await browser.close()
rmSync(OUT_DIR, { recursive: true, force: true })

writeFileSync(`/tmp/${prefix}-oracle.svg`, oracleSvg)
writeFileSync(`/tmp/${prefix}-ours.svg`, ourSvg)
console.log(`wrote /tmp/${prefix}-oracle.svg and /tmp/${prefix}-ours.svg (${oracleSvg.length} / ${ourSvg.length} bytes)`)
