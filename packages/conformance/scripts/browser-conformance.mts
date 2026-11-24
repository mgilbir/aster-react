/**
 * Browser conformance gate: renders every corpus entry through BOTH the
 * official vega toolchain (vega-embed, in a real browser where canvas text
 * measurement is live) and aster, then canonicalizes and diffs — the same
 * oracle protocol as the Node harness, but in the environment users actually
 * run in.
 *
 * This gate exists because the Node harness runs both engines in plain Node, where
 * neither can measure text: vega falls back to the same headless estimate
 * aster ported, so text-metric divergence is invisible there by construction.
 * The browser gate is the oracle that catches it.
 *
 * The verdict is runGate's (scripts/lib/run-gate.mjs): every entry that differs or throws, and every page error, fails the
 * gate; `compared` (the corpus entries compared) has a floor on a full run, and a filter that matches nothing fails.
 * `--plant-difference` adds a stray mark to Aster's SVG of every entry.
 *
 * Run after `pnpm build`: npx tsx scripts/browser-conformance.mts [--limit=N] [--filter=substr]
 */
import { readdirSync, readFileSync, writeFileSync, rmSync, mkdirSync, mkdtempSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { cli } from '../../../scripts/lib/cli.mjs'
import { GATE_FLAGS, intOption, runGate, type Gate } from '../../../scripts/lib/run-gate.mjs'

cli({ url: import.meta.url, flags: { limit: 'eq', filter: 'eq', ...GATE_FLAGS } })

const THIS_DIR = dirname(fileURLToPath(import.meta.url))
const CONF_DIR = dirname(THIS_DIR)
const OUT_DIR = mkdtempSync(join(CONF_DIR, '.tmp-browser-conformance-')) // (one directory per run: concurrent runs do not clobber each other)

const argv = process.argv.slice(2)
const arg = (n: string, d: string): string => argv.find((a) => a.startsWith(`--${n}=`))?.split('=')[1] ?? d
const LIMIT = intOption(argv.find((a) => a.startsWith('--limit='))?.split('=')[1], '--limit', 0)
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

const CONTAINER_W = 400
const CONTAINER_H = 300

// Page entry: vega-embed (oracle) + aster, and the canonicalizer, all in-page.
const entrySrc = `
import embed from 'vega-embed'
import { renderSpec, compileChart, evaluateChart } from '@aster-charts/core'
import { loadSpecData, TRUSTED_LOAD_OPTIONS } from '@aster-charts/core/load'
import { compile } from '@aster-charts/vl'
import '@aster-charts/core/geo'
import '@aster-charts/core/transforms'
import { canonicalizeSvg, diffCanonical } from '../src/normalize.js'
import { plantSvg } from '../src/gate-plant.js'

window.__runEntry = async (entry, plant) => {
  const spec = entry.spec
  const isVl = String(spec.$schema ?? '').includes('vega-lite')
  try {
    // oracle: official vega (embed compiles Vega-Lite itself)
    // The host has a size of its own: vega's containerSize() reads the view's container, so a Vega-Lite
    // "container" width/height depends on it (an unsized inline host is 0 x 0 until it has content).
    // Aster is handed the same size.
    const host = document.createElement('div')
    host.style.width = '${CONTAINER_W}px'
    host.style.height = '${CONTAINER_H}px'
    document.body.appendChild(host)
    // (vega changes the rows of an inline dataset in place -- a force layout rewrites its link rows -- so it gets a copy)
    const result = await embed(host, structuredClone(spec), { actions: false, renderer: 'svg' })
    // vega's string renderer (view.toSVG): the document Aster's renderSpec is the counterpart of. The DOM SVGRenderer
    // (what embed shows) has no hyperlinks at all: it leaves a link to the view's click handler, so its markup has no <a>.
    const oracleSvg = await result.view.toSVG()
    result.finalize()
    host.remove()
    // aster: own VL compiler for VL entries, then load URL data + renderSpec
    const compiled = isVl ? compile(spec) : spec
    const loaded = await loadSpecData(compiled as never, TRUSTED_LOAD_OPTIONS)
    const ourSvg = renderSpec(loaded as never, { containerSize: { width: ${CONTAINER_W}, height: ${CONTAINER_H} } })
    const diffs = diffCanonical(canonicalizeSvg(oracleSvg), canonicalizeSvg(plant ? plantSvg(ourSvg) : ourSvg))
    return { pass: diffs.length === 0, diffs: diffs.slice(0, 8), error: null }
  } catch (err) {
    return { pass: false, diffs: [], error: err instanceof Error ? err.message : String(err) }
  }
}
`

async function main(gate: Gate): Promise<void> {
  rmSync(OUT_DIR, { recursive: true, force: true })
  mkdirSync(OUT_DIR, { recursive: true })
  writeFileSync(join(OUT_DIR, 'page-entry.ts'), entrySrc)
  await build({
    entryPoints: [join(OUT_DIR, 'page-entry.ts')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    outfile: join(OUT_DIR, 'page.js'),
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'silent',
    // Workspace deps resolve via node_modules symlinks + each package's
    // "exports" map (which covers the @aster-charts/core subpath addons).
  })
  writeFileSync(join(OUT_DIR, 'index.html'), `<!doctype html><html><body><script src="./page.js"></script></body></html>`)

  const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage', '--js-flags=--max-old-space-size=4096'] })
  try {
    const page = await browser.newPage()
    page.on('pageerror', (e) => gate.problem(`page error: ${e.message.slice(0, 200)}`))
    await page.goto(`file://${join(OUT_DIR, 'index.html')}`)
    await page.waitForFunction(() => '__runEntry' in window, null, { timeout: 30_000 })
    await page.evaluate((data) => { (window as unknown as { __corpus: unknown }).__corpus = data }, entries)
    let passed = 0
    const t0 = Date.now()
    for (let i = 0; i < entries.length; i++) {
      const r = await page.evaluate(([idx, plant]) => {
        const entries = (window as unknown as { __corpus: Entry[] }).__corpus
        return (window as unknown as { __runEntry: (e: Entry, p: boolean) => Promise<{ pass: boolean; diffs: string[]; error: string | null }> }).__runEntry(entries[idx as number]!, plant as boolean)
      }, [i, gate.plant] as const)
      const name = entries[i]!.name
      if (r.error !== null) gate.error(name, r.error.slice(0, 200))
      else if (!r.pass) {
        gate.differ(name, (r.diffs[0] ?? 'differs').slice(0, 200))
        for (const d of r.diffs.slice(1, 3)) console.log(`  ${name}: ${d.slice(0, 160)}`)
      } else {
        passed++
        gate.agree(name)
      }
      if ((i + 1) % 50 === 0) console.log(`  ${i + 1}/${entries.length} (${((Date.now() - t0) / 1000).toFixed(0)}s)`)
    }
    console.log(`\n[browser-conformance] ${passed}/${entries.length} passed (${((Date.now() - t0) / 1000).toFixed(0)}s)`)
  } finally {
    await browser.close()
    rmSync(OUT_DIR, { recursive: true, force: true })
  }
}

await runGate({
  name: 'browser-conformance',
  counters: { compared: { floor: 1071, what: 'corpus entries compared in Chromium with live text metrics' } },
  partial: Boolean(FILTER) || LIMIT > 0,
  run: main,
})
