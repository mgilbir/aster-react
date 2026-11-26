/**
 * gallery-fetch (C508): every request has a deadline, and `--regenerate` leaves a cache its manifest verifies (it used to
 * hash the files without writing them, then print `ok` over the mismatching cache). A local server stands in for GitHub.
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import {  } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { download, regenerate } from './gallery-fetch.mts'
import { sha256, verifyCache, type Manifest } from '../src/gallery/cache.js'
import { makeTempDir, removeTempDir } from '../../../scripts/lib/temp-dir.mjs'

const FILES: Record<string, string> = { 'a.vg.json': '{"a":1}', 'b.vg.json': '{"b":2}', 'skip.txt': 'not a spec' }
let server: Server
let base = ''
let hangs = 0
const scratch = makeTempDir('aster-gallery-fetch-test-')

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? ''
    // a stalled connection: the headers never come
    if (url.startsWith('/hang')) { hangs++; return }
    if (url.startsWith('/repos/')) {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ truncated: false, tree: [...Object.keys(FILES).map((f) => ({ path: `examples/${f}`, type: 'blob' })), { path: 'examples/sub/c.vg.json', type: 'blob' }] }))
      return
    }
    const name = url.split('/').pop()!
    if (name === 'LICENSE') { res.end('MIT'); return }
    if (name in FILES) { res.end(FILES[name]); return }
    res.statusCode = 404
    res.end()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => {
  server.closeAllConnections()
  server.close()
  removeTempDir(scratch)
})

const at = () => ({ raw: base, api: base, timeoutMs: 200, backoffMs: 10 })

describe('gallery-fetch', () => {
  it('a stalled request is aborted at its deadline and tried again, then reported', async () => {
    const t0 = Date.now()
    await expect(download(`${base}/hang/x.json`, at())).rejects.toThrow(/hang\/x\.json/)
    expect(hangs).toBe(4)
    expect(Date.now() - t0).toBeLessThan(5000)
  }, 10_000)

  it('--regenerate writes the files it hashes into the cache, so the new manifest verifies it', async () => {
    const manifest: Manifest = {
      note: '', vegaDatasets: '',
      sources: { vega: { repo: 'o/r', tag: 't', commit: '0123456789abcdef', upstreamDir: 'examples', suffix: '.vg.json', cacheDir: 'vega', licenseSha256: 'stale', files: { 'old.vg.json': 'stale' } } },
    }
    const cache = join(scratch, 'cache')
    await regenerate(manifest, cache, null, at())
    expect(manifest.sources.vega!.files).toEqual({ 'a.vg.json': sha256(Buffer.from(FILES['a.vg.json']!)), 'b.vg.json': sha256(Buffer.from(FILES['b.vg.json']!)) })
    expect(verifyCache(manifest, cache)).toEqual([])
  })
})
