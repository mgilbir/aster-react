// @vitest-environment node
/**
 * Paint that names another document, in a real Chromium (core paint-url.ts, #178):
 *  - the test oracle (core css-url.testlib.ts) says a paint names another document exactly when Chromium requests one for
 *    it, so the unit tests that lean on the oracle are judged by the browser's own reading;
 *  - the SVG Aster writes for those paints (a data field, an expression, the background) makes Chromium request nothing.
 *
 * Every page sets `<base href>` to another directory, so a URL Chromium resolves against the base (`url(" #a")`,
 * `url(\20#a)`) shows up as a request too; a URL within the page (`url(#a)`) never does.
 *
 * These run against the built packages (the `build` gate precedes `test`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { chromium, type Browser } from 'playwright'
import { renderSpec } from '@aster-charts/core'
import { namesAnotherDocument } from '../../core/src/css-url.testlib.js'

/** Paint texts: within the page, another document, and each way an escape changes which one it is. */
const PAINTS = [
  'url(#a)', 'url("#a")', "url('#a')", 'url( #a )', 'URL(#a) red', 'url("#a" ) red', 'url(\\#a)', 'url(\\23 a)', 'url("\\23 a")',
  'url("#a\\"")', 'url(#a\\"x.svg)', '\\75 rl(#a)', 'url("\\\n#a")',
  'url(x.svg#a)', '\\75 rl(x.svg#a)', 'url(x.svg#a) red',
  // #178: an escaped quote is a character of the URL
  'url(\\"#a\\")', "url(\\'#a\\')", 'url(\\"#a\\") red', 'url(\\"x.svg#a\\") red', 'url("\\"#a")', 'url(\\22#a\\22)',
  // escaped or quoted whitespace starts the URL: it resolves against the base
  'url(\\20#a)', 'url(\\9#a)', 'url(" #a")', 'url("\\20#a")',
  '#336699', 'steelblue', 'none',
]
/** Texts that are no paint at all (a browser drops them and fetches nothing), for Aster's output only. */
const NOT_PAINT = ['red url(x.svg#a)', 'red url(\\"#a\\")', 'rgb(url(x.svg))']

let server: Server
let browser: Browser
let origin = ''
/** the requests since the last reset, other than the page itself */
const requests: string[] = []
const PAGE = '/page/x.html'

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === PAGE) {
      res.setHeader('content-type', 'text/html')
      res.end('<!doctype html><html><head><base href="/base/y.html"></head><body><div id="host"></div></body></html>')
      return
    }
    if (req.url !== '/favicon.ico') requests.push(req.url ?? '')
    res.statusCode = 404
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] })
}, 60_000)

afterAll(async () => {
  await browser?.close()
  await new Promise<void>((resolve) => server?.close(() => resolve()))
})

/** The requests Chromium makes while it draws this markup (inline SVG in a fresh page). */
async function requestsFor(markup: string): Promise<string[]> {
  const page = await browser.newPage()
  try {
    await page.goto(origin + PAGE)
    requests.length = 0
    await page.evaluate((m) => { document.getElementById('host')!.innerHTML = m }, markup)
    // computed style forces the paint servers to resolve; then give their requests time to arrive
    await page.evaluate(() => { for (const el of document.querySelectorAll('#host *')) getComputedStyle(el).fill })
    await page.waitForTimeout(150)
    return [...requests]
  } finally {
    await page.close()
  }
}

/** an attribute value, escaped as an HTML serializer escapes it */
const attr = (s: string): string => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
/** one rect filled with the paint, in a document that defines `#a` */
const svgWithFill = (paint: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><defs><linearGradient id="a"><stop offset="0" stop-color="red"/></linearGradient></defs><rect width="20" height="20" fill="${attr(paint)}"/></svg>`

describe('paint references in Chromium', () => {
  it('the test oracle names another document exactly when Chromium requests one', { timeout: 120_000 }, async () => {
    const disagree: string[] = []
    let fetched = 0
    for (const p of PAINTS) {
      const got = await requestsFor(svgWithFill(p))
      if (got.length > 0) fetched++
      if ((got.length > 0) !== namesAnotherDocument(p)) disagree.push(`${JSON.stringify(p)}: oracle ${namesAnotherDocument(p)}, Chromium requested ${JSON.stringify(got)}`)
    }
    expect(disagree).toEqual([])
    // (both sides are exercised: some paints are fetched, some are not)
    expect(fetched).toBeGreaterThan(5)
    expect(fetched).toBeLessThan(PAINTS.length - 5)
  })

  it('the SVG Aster writes for every paint, from a field, an expression and the background, requests nothing', { timeout: 120_000 }, async () => {
    for (const p of [...PAINTS, ...NOT_PAINT]) {
      const spec = {
        width: 40, height: 20, padding: 0, autosize: 'none', background: p,
        data: [{ name: 't', values: [{ p }] }],
        marks: [{
          type: 'rect', from: { data: 't' },
          encode: { update: { x: { value: 0 }, y: { value: 0 }, width: { value: 10 }, height: { value: 10 }, fill: { field: 'p' }, stroke: { signal: 'datum.p' } } },
        }],
      }
      const svg = renderSpec(spec as never)
      expect(await requestsFor(svg), `${JSON.stringify(p)}\n${svg}`).toEqual([])
    }
  })
})
