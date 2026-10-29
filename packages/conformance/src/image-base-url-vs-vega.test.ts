/**
 * vega's loader resolves a relative image url against its `baseURL` (vega-loader `sanitize`): `base + '/' + url` unless
 * the url already has a scheme-and-host (`https://...`, `//host/...`, `data:`). The SVG carries the resolved url. The
 * engine's counterpart of the loader's `baseURL` is the url policy's, and an image drawn under it must carry the same
 * url. Without a base both leave the url as written.
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { renderSpec } from '@aster/core'
import { canonicalizeSvg, diffCanonical } from './normalize.js'

const spec = (url: string): Record<string, unknown> => ({
  width: 100, height: 40, padding: 5, autosize: 'none',
  data: [{ name: 't', values: [{ u: url, x: 0 }, { u: url + '#2', x: 30 }] }],
  marks: [{ type: 'image', from: { data: 't' }, encode: { update: { url: { field: 'u' }, x: { field: 'x' }, y: { value: 5 }, width: { value: 20 }, height: { value: 20 } } } }],
})

async function vegaSvg(s: Record<string, unknown>, baseURL: string | undefined): Promise<string> {
  const view = new vega.View(vega.parse(structuredClone(s) as never), { renderer: 'none', ...(baseURL !== undefined ? { loader: vega.loader({ baseURL }) } : {}) })
  try { await view.runAsync(); return await view.toSVG() } finally { view.finalize() }
}

const BASES: Array<string | undefined> = ['https://a.example/x', 'https://a.example/x/', 'https://a.example', undefined]
const URLS = ['img/p.png', '/img/p.png', '../p.png', '//cdn.example/p.png', 'https://b.example/p.png', 'HTTPS://b.example/p.png', 'data:image/png;base64,AAAA']

describe('image urls resolve against the base url like vega\'s loader', () => {
  for (const base of BASES) {
    for (const url of URLS) {
      it(`${base ?? '(no base)'} + ${url}`, async () => {
        const s = spec(url)
        const want = await vegaSvg(s, base)
        const got = renderSpec(structuredClone(s) as never, base !== undefined ? { urlPolicy: { baseURL: base } } : {})
        expect(diffCanonical(canonicalizeSvg(want), canonicalizeSvg(got))).toEqual([])
        // not vacuous: with a base and a relative url, vega changed it
        if (base !== undefined && url === 'img/p.png') expect(want).toContain(`${base.replace(/\/$/, '')}/img/p.png`)
      })
    }
  }
})
