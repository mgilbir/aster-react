/**
 * React path of the gallery gate: the page bundle (page-entry.tsx) is served to headless Chromium from a fake origin
 * (https://gallery.invalid/); every other request is answered from the vendored data on disk or ABORTED. No network.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium, type BrowserContext } from 'playwright'
import { BASE_URL, localFileFor, readSpec, type GallerySpec, type Outcome } from './lib.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const MIME: Record<string, string> = { '.json': 'application/json', '.csv': 'text/csv', '.tsv': 'text/tab-separated-values', '.png': 'image/png', '.arrow': 'application/octet-stream' }

async function routeOffline(ctx: BrowserContext, html: string, js: string): Promise<void> {
  await ctx.route('**/*', async (route) => {
    const url = route.request().url()
    const u = new URL(url)
    if (url === `${BASE_URL}index.html`) return route.fulfill({ status: 200, contentType: 'text/html', body: html })
    if (url === `${BASE_URL}page.js`) return route.fulfill({ status: 200, contentType: 'text/javascript', body: js })
    const file = localFileFor(url)
    if (file !== null) {
      return route.fulfill({ status: 200, contentType: MIME[extname(file)] ?? 'application/octet-stream', headers: { 'access-control-allow-origin': '*' }, body: readFileSync(file) })
    }
    if (u.protocol === 'data:' || u.protocol === 'blob:') return route.continue()
    return route.abort('blockedbyclient')
  })
}

export async function runReact(specs: GallerySpec[], onResult: (o: Outcome) => void, workers = 3): Promise<Outcome[]> {
  const tmp = mkdtempSync(join(tmpdir(), 'aster-gallery-'))
  try {
    mkdirSync(tmp, { recursive: true })
    const bundle = await build({
      entryPoints: [join(HERE, 'page-entry.tsx')],
      bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'error',
    })
    const js = bundle.outputFiles[0]!.text
    const html = '<!doctype html><html><body><script src="./page.js"></script></body></html>'
    const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] })
    const results = new Map<string, Outcome>()
    const queue = [...specs]
    const worker = async (): Promise<void> => {
      const ctx = await browser.newContext()
      await routeOffline(ctx, html, js)
      let page = await ctx.newPage()
      const open = async (): Promise<void> => {
        await page.goto(`${BASE_URL}index.html`)
        await page.waitForFunction(() => '__runGallery' in window, null, { timeout: 30_000 })
      }
      await open()
      for (let g = queue.shift(); g; g = queue.shift()) {
        const t0 = Date.now()
        let o: Outcome
        try {
          const r = await page.evaluate((s) => (window as never as { __runGallery: (s: unknown) => Promise<Record<string, unknown>> }).__runGallery(s), { id: g.id, kind: g.kind, spec: readSpec(g) })
          o = { id: g.id, ms: Date.now() - t0, ...(r as object) } as Outcome
        } catch (e) {
          // the page itself died (crash / out of memory): a failure of the spec, and a fresh page for the next one
          o = { id: g.id, ms: Date.now() - t0, status: 'error', reason: 'page-crashed', first: (e instanceof Error ? e.message : String(e)).slice(0, 240) }
          await page.close().catch(() => undefined)
          page = await ctx.newPage()
          await open()
        }
        results.set(g.id, o)
        onResult(o)
      }
      await ctx.close()
    }
    await Promise.all(Array.from({ length: Math.min(workers, specs.length) }, worker))
    await browser.close()
    return specs.map((g) => results.get(g.id)!)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}
