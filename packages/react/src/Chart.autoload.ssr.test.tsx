// @vitest-environment jsdom
/**
 * Add-on auto-load on the server. A synchronous render (`renderToString`, `renderChartToStaticMarkup`) cannot wait for an
 * import, so it uses what is loaded:
 *   - `renderToString` of a chart whose add-on is missing shows the <Suspense> fallback (React's own behaviour for a
 *     suspended boundary; the client renders the chart), never an error;
 *   - `await loadAddonsFor(spec)` before it makes the markup the full chart;
 *   - a streaming renderer (`renderToReadableStream`) waits for the import and sends the chart.
 * One add-on per test keeps them independent. No add-on is imported by this file.
 */
import * as React from 'react'
import { renderToString, renderToReadableStream } from 'react-dom/server'
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderSpec, type VgSpec } from '@aster/core'
import { isAddonLoaded } from '@aster/core/addons'
import { loadAddonsFor } from './addons'
import { renderChartToStaticMarkup } from './ssr'
import { forEachVariant } from './testing/variants'

const CORPUS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'conformance', 'corpus')
const corpus = (name: string): VgSpec => JSON.parse(readFileSync(join(CORPUS, name), 'utf8')) as VgSpec
const PIE = corpus('t-pie.vg.json')
const MAP = corpus('geo-vlout-mercator-translate.vg.json')
const CSV: VgSpec = {
  width: 100, height: 40, padding: 0,
  data: [{ name: 't', values: 'k,v\na,1\nb,2', format: { type: 'csv', parse: { v: 'number' } } }],
  scales: [{ name: 'x', type: 'linear', domain: { data: 't', field: 'v' }, range: 'width' }],
  marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'v' }, y: { value: 10 } } } }],
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let out = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return out + decoder.decode()
    out += decoder.decode(value, { stream: true })
  }
}
const svgOf = (html: string): string => html.slice(html.indexOf('<svg'), html.indexOf('</svg>') + 6)

describe('the server, with nothing imported', () => {
  it('starts with no add-on registered', () => {
    expect((['transforms', 'geo', 'load'] as const).some(isAddonLoaded)).toBe(false)
  })

  forEachVariant(['svg'], (Chart) => {
    it('renderToString: a missing add-on shows the Suspense fallback and throws nothing', async () => {
      // the first variant to run sees the add-on missing; the import it starts is done by the time the next one runs
      const fresh = !isAddonLoaded('transforms')
      const html = renderToString(<React.Suspense fallback={<i id="fb" />}><Chart spec={PIE} width={300} height={200} /></React.Suspense>)
      if (fresh) {
        expect(html).toContain('<i id="fb">')
        expect(html).not.toContain('<svg')
        await loadAddonsFor(PIE)
      }
      const again = renderToString(<React.Suspense fallback={<i id="fb" />}><Chart spec={PIE} width={300} height={200} /></React.Suspense>)
      expect(again).not.toContain('id="fb"')
      expect(again).toContain('<svg')
    })
  })

  it('a streaming render waits for the import and sends the chart', async () => {
    expect(isAddonLoaded('geo')).toBe(false)
    const { Chart } = await import('./Chart')
    const stream = await renderToReadableStream(<React.Suspense fallback={<i id="fb" />}><Chart spec={MAP} width={400} height={300} a11y={false} /></React.Suspense>)
    await stream.allReady
    const html = await readAll(stream)
    expect(isAddonLoaded('geo')).toBe(true)
    expect(html).toContain('<svg')
    expect(svgOf(html).replace(/<svg[^>]*>/, '')).toContain('class="mark-')
    expect(html).not.toContain('id="fb"')
  })

  it('renderChartToStaticMarkup is synchronous: it says what to do, and works after loadAddonsFor', async () => {
    expect(isAddonLoaded('load')).toBe(false)
    expect(() => renderChartToStaticMarkup(CSV)).toThrow(/load the addon first/)
    await loadAddonsFor(CSV)
    expect(renderChartToStaticMarkup(CSV)).toBe(renderSpec(CSV))
  })
})
