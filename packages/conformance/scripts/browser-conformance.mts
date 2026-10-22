/**
 * Browser conformance gate: renders every corpus entry through BOTH the
 * official vega toolchain (vega-embed, in a real browser where canvas text
 * measurement is live) and aster, then canonicalizes and diffs — the same
 * oracle protocol as the Node harness, but in the environment users actually
 * run in.
 *
 * This gate exists because the Node harness runs both engines in jsdom, where
 * neither can measure text: vega falls back to the same headless estimate
 * aster ported, so text-metric divergence is invisible there by construction.
 * The browser gate is the oracle that catches it.
 *
 * Run: npx tsx scripts/browser-conformance.mts [--limit=N] [--filter=substr]
 */
import { readdirSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const THIS_DIR = dirname(fileURLToPath(import.meta.url))
const CONF_DIR = dirname(THIS_DIR)
const OUT_DIR = join(CONF_DIR, '.tmp-browser-conformance')

const argv = process.argv.slice(2)
const arg = (n: string, d: string): string => argv.find((a) => a.startsWith(`--${n}=`))?.split('=')[1] ?? d
const LIMIT = Number(arg('limit', '0'))
const FILTER = arg('filter', '')

interface Entry { name: string; spec: Record<string, unknown> }

function loadCorpus(): Entry[] {
  const corpus = join(CONF_DIR, 'corpus')
  const files = readdirSync(corpus, { recursive: true }).filter((f) => String(f).endsWith('.json')).map(String).sort()
  const entries: Entry[] = []
  for (const f of files) {
    const spec = JSON.parse(readFileSync(join(corpus, f), 'utf8')) as Record<string, unknown>
    entries.push({ name: f.replace(/\.vl\.json$|\.json$/, ''), spec })
  }
  return entries
}

const entries = loadCorpus().filter((e) => !FILTER || e.name.includes(FILTER)).slice(0, LIMIT || undefined)
console.log(`[browser-conformance] ${entries.length} corpus entries`)

// Page entry: vega-embed (oracle) + aster, and the canonicalizer, all in-page.
const entrySrc = `
import embed from 'vega-embed'
import { renderSpec, compileChart, evaluateChart } from '@aster/core'
import { loadSpecData, TRUSTED_LOAD_OPTIONS } from '@aster/core/load'
import { compile } from '@aster/vl'
import '@aster/core/geo'
import '@aster/core/transforms'
import { canonicalizeSvg, diffCanonical } from '../src/normalize.js'

window.__runEntry = async (entry) => {
  const spec = entry.spec
  const isVl = String(spec.$schema ?? '').includes('vega-lite')
  try {
    // oracle: official vega (embed compiles Vega-Lite itself)
    const host = document.createElement('div')
    document.body.appendChild(host)
    const result = await embed(host, spec, { actions: false, renderer: 'svg' })
    const oracleSvg = host.querySelector('svg')?.outerHTML ?? ''
    result.finalize()
    host.remove()
    // aster: own VL compiler for VL entries, then load URL data + renderSpec
    const compiled = isVl ? compile(spec) : spec
    const loaded = await loadSpecData(compiled as never, TRUSTED_LOAD_OPTIONS)
    const ourSvg = renderSpec(loaded as never)
    const diffs = diffCanonical(canonicalizeSvg(oracleSvg), canonicalizeSvg(ourSvg))
    return { pass: diffs.length === 0, diffs: diffs.slice(0, 8), error: null }
  } catch (err) {
    return { pass: false, diffs: [], error: err instanceof Error ? err.message : String(err) }
  }
}
`

rmSync(OUT_DIR, { recursive: true, force: true })
mkdirSync(OUT_DIR, { recursive: true })
writeFileSync(join(OUT_DIR, 'page-entry.ts'), entrySrc)
writeFileSync(join(OUT_DIR, 'corpus.json'), JSON.stringify(entries))

await build({
  entryPoints: [join(OUT_DIR, 'page-entry.ts')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  outfile: join(OUT_DIR, 'page.js'),
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'silent',
  // Workspace deps resolve via node_modules symlinks + each package's
  // "exports" map (which covers the @aster/core subpath addons).
})

writeFileSync(join(OUT_DIR, 'index.html'), `<!doctype html><html><body><script src="./page.js"></script></body></html>`)

const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage', '--js-flags=--max-old-space-size=4096'] })
const page = await browser.newPage()
page.on('pageerror', (e) => console.error('[page]', e.message.slice(0, 200)))
await page.goto(`file://${join(OUT_DIR, 'index.html')}`)
await page.waitForFunction(() => '__runEntry' in window, null, { timeout: 30_000 })
await page.evaluate((data) => { (window as unknown as { __corpus: unknown }).__corpus = data }, entries)

let passed = 0
const failures: Array<{ name: string; diffs: string[]; error?: string }> = []
const t0 = Date.now()
for (let i = 0; i < entries.length; i++) {
  const r = await page.evaluate((idx: number) => {
    const entries = (window as unknown as { __corpus: Entry[] }).__corpus
    return (window as unknown as { __runEntry: (e: Entry) => Promise<{ pass: boolean; diffs: string[]; error: string | null }> }).__runEntry(entries[idx]!)
  }, i)
  if (r.pass) passed++
  else failures.push({ name: entries[i]!.name, diffs: r.diffs, error: r.error ?? undefined })
  if ((i + 1) % 50 === 0) console.log(`  ${i + 1}/${entries.length} (${((Date.now() - t0) / 1000).toFixed(0)}s)`)
}
await browser.close()
rmSync(OUT_DIR, { recursive: true, force: true })

console.log(`\n[browser-conformance] ${passed}/${entries.length} passed (${((Date.now() - t0) / 1000).toFixed(0)}s)`)
if (failures.length) {
  console.log(`[browser-conformance] failing: ${failures.map((f) => f.name).join(', ')}`)
  for (const f of failures) {
    if (f.error) console.log(`  ${f.name}: ERROR ${f.error.slice(0, 120)}`)
    else for (const d of f.diffs.slice(0, 2)) console.log(`  ${f.name}: ${d.slice(0, 160)}`)
  }
}
