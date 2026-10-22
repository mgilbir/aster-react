// @vitest-environment node
/**
 * C6 / C60: loadSpecData takes a URL policy. Real HTTP servers on 127.0.0.1 so
 * redirects, stalls, endless bodies and concurrency are the real thing.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { loadSpecData, isNonPublicHost, AsterUrlError, LOAD_DEFAULTS, TRUSTED_LOAD_OPTIONS } from './addon-load.js'
import { AsterLimitError } from './limits.js'
import type { VgSpec } from './types.js'

interface TestServer { server: Server; origin: string; port: number; hits: string[]; open: Set<ServerResponse> }

async function listen(handler: (req: IncomingMessage, res: ServerResponse, s: TestServer) => void): Promise<TestServer> {
  const s: TestServer = { server: undefined as never, origin: '', port: 0, hits: [], open: new Set() }
  s.server = createServer((req, res) => {
    s.hits.push(req.url ?? '')
    s.open.add(res)
    res.on('close', () => s.open.delete(res))
    handler(req, res, s)
  })
  await new Promise<void>((r) => s.server.listen(0, '127.0.0.1', r))
  s.port = (s.server.address() as AddressInfo).port
  s.origin = `http://127.0.0.1:${s.port}`
  return s
}
const close = (s: TestServer): Promise<void> => new Promise((r) => { for (const res of s.open) res.destroy(); s.server.closeAllConnections?.(); s.server.close(() => r()) })

const spec = (...defs: Array<Record<string, unknown>>): VgSpec => ({ data: defs } as unknown as VgSpec)
const valuesOf = (s: VgSpec, i = 0): unknown => (s.data as unknown as Array<{ values: unknown }>)[i]!.values

let secret: TestServer // the "internal service" a hostile spec wants to reach
let main: TestServer   // the host's own data service
let redirector: TestServer
let stall: TestServer
let endless: TestServer
let slowGate: TestServer
const gate = { inflight: 0, max: 0 }
const ENDLESS_CHUNK = 'x'.repeat(1000)
let endlessSent = 0

beforeAll(async () => {
  secret = await listen((_req, res) => { res.setHeader('content-type', 'application/json'); res.end('[{"secret":"internal"}]') })
  main = await listen((req, res) => {
    if (req.url === '/rows.json') { res.setHeader('content-type', 'application/json'); res.end('[{"a":1},{"a":2}]') }
    else if (req.url?.startsWith('/big-declared')) { res.setHeader('content-length', '50000000'); res.write('['); setTimeout(() => res.destroy(), 200) }
    else res.writeHead(404).end('no')
  })
  redirector = await listen((req, res) => {
    const to = new URL(req.url!, 'http://x').searchParams.get('to') ?? ''
    if (req.url?.startsWith('/loop')) { res.writeHead(302, { location: '/loop' }).end(); return }
    if (req.url?.startsWith('/ok')) { res.setHeader('content-type', 'application/json'); res.end('[{"ok":true}]'); return }
    res.writeHead(302, { location: to }).end()
  })
  stall = await listen((req, res) => {
    if (req.url?.startsWith('/headers-never')) return // never answer
    if (req.url?.startsWith('/drip')) { res.writeHead(200, { 'content-type': 'application/json' }); res.write('['); return } // headers, then silence
  })
  endless = await listen((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    const pump = (): void => {
      if (res.destroyed) return
      endlessSent += ENDLESS_CHUNK.length
      if (res.write(ENDLESS_CHUNK)) setImmediate(pump)
      else res.once('drain', pump)
    }
    pump()
  })
  slowGate = await listen((_req, res) => {
    gate.inflight++; gate.max = Math.max(gate.max, gate.inflight)
    setTimeout(() => { gate.inflight--; res.setHeader('content-type', 'application/json'); res.end('[{"n":1}]') }, 60)
  })
})
afterAll(async () => { await Promise.all([secret, main, redirector, stall, endless, slowGate].map(close)) })

describe('default policy (C6)', () => {
  it('loopback / private targets are denied by default and the server is never contacted', async () => {
    for (const url of [`${secret.origin}/x`, `http://localhost:${secret.port}/x`, `http://[::1]:${secret.port}/x`, `http://0x7f.1:${secret.port}/x`,
      `http://2130706433:${secret.port}/x`, `http://[::ffff:127.0.0.1]:${secret.port}/x`, 'http://169.254.169.254/latest/meta-data', 'http://10.0.0.5/x', 'http://192.168.1.1/x']) {
      await expect(loadSpecData(spec({ name: 't', url }))).rejects.toBeInstanceOf(AsterUrlError)
    }
    expect(secret.hits).toEqual([])
  })

  it('an allow hook cannot open the private network by itself; allowPrivateNetwork is a separate, explicit switch', async () => {
    const before = secret.hits.length
    await expect(loadSpecData(spec({ name: 't', url: `${secret.origin}/x` }), { allow: () => true })).rejects.toThrow(/non-public/)
    expect(secret.hits.length).toBe(before)
    const loaded = await loadSpecData(spec({ name: 't', url: `${secret.origin}/x` }), { allow: () => true, allowPrivateNetwork: true })
    expect(valuesOf(loaded)).toEqual([{ secret: 'internal' }])
  })

  it('the allow hook can veto a public url (called with the parsed URL)', async () => {
    const seen: string[] = []
    const fetchSpy = (async () => { throw new Error('must not be fetched') }) as unknown as typeof fetch
    await expect(loadSpecData(spec({ name: 't', url: 'https://data.example.test/a.json' }), {
      fetch: fetchSpy, allow: (u) => { seen.push(u.hostname); return u.hostname === 'ok.example.test' },
    })).rejects.toThrow(/allow hook/)
    expect(seen).toEqual(['data.example.test'])
  })

  it('relative urls resolve against baseURL and are trusted there, even on loopback', async () => {
    const loaded = await loadSpecData(spec({ name: 't', url: '/rows.json' }), { baseURL: main.origin })
    expect(valuesOf(loaded)).toEqual([{ a: 1 }, { a: 2 }])
  })

  it('a relative url without baseURL is an actionable error', async () => {
    await expect(loadSpecData(spec({ name: 't', url: 'rows.json' }))).rejects.toThrow(/relative url needs the baseURL option/)
  })

  it('a url that leaves the baseURL origin needs allow, and the private-network rule still applies to it', async () => {
    const before = secret.hits.length
    await expect(loadSpecData(spec({ name: 't', url: `${secret.origin}/x` }), { baseURL: main.origin })).rejects.toBeInstanceOf(AsterUrlError)
    expect(secret.hits.length).toBe(before)
  })

  it.each(['file:///etc/passwd', 'ftp://example.test/x', 'javascript:alert(1)', 'blob:http://example.test/x', 'https://user:pw@example.test/x'])(
    'protocol/credential denial: %s', async (url) => {
      await expect(loadSpecData(spec({ name: 't', url }), { fetch: (async () => { throw new Error('fetched') }) as unknown as typeof fetch }))
        .rejects.toBeInstanceOf(AsterUrlError)
    })

  it('data: urls are denied by default and allowed only when the protocol is opted in (and the hook agrees)', async () => {
    const d = spec({ name: 't', url: 'data:application/json,[{"a":1}]' })
    await expect(loadSpecData(d)).rejects.toThrow(/protocol data: is not allowed/)
    expect(valuesOf(await loadSpecData(d, { protocols: ['data:'] }))).toEqual([{ a: 1 }])
    await expect(loadSpecData(d, { protocols: ['data:'], allow: () => false })).rejects.toThrow(/allow hook/)
    // http is no longer allowed once the host narrowed the protocols
    await expect(loadSpecData(spec({ name: 't', url: 'https://example.test/a.json' }), { protocols: ['data:'] })).rejects.toThrow(/protocol https: is not allowed/)
  })

  it('the host classification table', () => {
    for (const h of ['localhost', 'foo.localhost', 'a.local', 'svc.internal', '127.0.0.1', '127.1.2.3', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.0.1',
      '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '[::1]', '[::]', '[fc00::1]', '[fd12:3456::1]', '[fe80::1]', '[::ffff:7f00:1]', '[::ffff:10.0.0.1]', '[64:ff9b::a00:1]', '[2002:7f00:1::]']) {
      expect(isNonPublicHost(h), h).toBe(true)
    }
    for (const h of ['example.com', '93.184.216.34', '8.8.8.8', '172.15.0.1', '172.32.0.1', '[2606:4700::1111]', '[::ffff:808:808]', '100.63.0.1', '192.0.2.1']) {
      expect(isNonPublicHost(h), h).toBe(false)
    }
  })
})

describe('redirects are re-checked hop by hop (C6)', () => {
  it('a redirect from the host\'s own service to a loopback/private host is denied before it is requested', async () => {
    const before = secret.hits.length
    const err = await loadSpecData(spec({ name: 't', url: `/go?to=${encodeURIComponent(secret.origin + '/stolen')}` }), { baseURL: redirector.origin }).catch((e) => e)
    expect(err).toBeInstanceOf(AsterUrlError)
    expect(String(err.message)).toMatch(/non-public/)
    expect(redirector.hits.at(-1)).toMatch(/^\/go\?to=/) // the first hop WAS requested (it is the host's own origin)...
    expect(secret.hits.length).toBe(before)             // ...the redirect target never was
  })

  it('hop 1 allowed, hop 2 denied by the allow hook: the second target is never contacted', async () => {
    const before = secret.hits.length
    await expect(loadSpecData(spec({ name: 't', url: `${redirector.origin}/go?to=${encodeURIComponent(secret.origin + '/stolen')}` }), {
      allowPrivateNetwork: true,
      allow: (u) => u.port === String(redirector.port),
    })).rejects.toThrow(/allow hook/)
    expect(secret.hits.length).toBe(before)
  })

  it('a permitted redirect is followed; a redirect loop stops at maxRedirects with an AsterLimitError', async () => {
    const ok = await loadSpecData(spec({ name: 't', url: `${redirector.origin}/go?to=${encodeURIComponent(redirector.origin + '/ok')}` }), TRUSTED_LOAD_OPTIONS)
    expect(valuesOf(ok)).toEqual([{ ok: true }])
    const err = await loadSpecData(spec({ name: 't', url: `${redirector.origin}/loop` }), { ...TRUSTED_LOAD_OPTIONS, maxRedirects: 3 }).catch((e) => e)
    expect(err).toBeInstanceOf(AsterLimitError)
    expect(String(err.message)).toMatch(/maxRedirects/)
  })

  it('a fetch that follows redirects itself is checked after the fact', async () => {
    const lying = (async () => ({ ok: true, status: 200, redirected: true, url: 'http://127.0.0.1:9/secret', headers: new Headers(), text: async () => '[]' })) as unknown as typeof fetch
    await expect(loadSpecData(spec({ name: 't', url: 'https://public.example.test/a.json' }), { fetch: lying })).rejects.toThrow(/non-public/)
  })
})

describe('bounded in time, bytes and concurrency (C6)', () => {
  it('a server that never answers: timeoutMs aborts with an AsterLimitError, in bounded time', async () => {
    const t0 = performance.now()
    const err = await loadSpecData(spec({ name: 't', url: `${stall.origin}/headers-never` }), { ...TRUSTED_LOAD_OPTIONS, timeoutMs: 200 }).catch((e) => e)
    expect(err).toBeInstanceOf(AsterLimitError)
    expect(String(err.message)).toMatch(/timeoutMs 200/)
    expect(performance.now() - t0).toBeLessThan(2 * 200 + 400)
  }, 15_000)

  it('a server that sends headers and then stalls the body is cut off too', async () => {
    const t0 = performance.now()
    const err = await loadSpecData(spec({ name: 't', url: `${stall.origin}/drip` }), { ...TRUSTED_LOAD_OPTIONS, timeoutMs: 200 }).catch((e) => e)
    expect(err).toBeInstanceOf(AsterLimitError)
    expect(performance.now() - t0).toBeLessThan(2 * 200 + 400)
  }, 15_000)

  it('the whole-call limits.maxTimeMs and an AbortSignal both stop the load', async () => {
    const t0 = performance.now()
    const a = await loadSpecData(spec({ name: 't', url: `${stall.origin}/headers-never` }), { ...TRUSTED_LOAD_OPTIONS, limits: { maxTimeMs: 150 } }).catch((e) => e)
    expect(a).toBeInstanceOf(AsterLimitError)
    expect(String(a.message)).toMatch(/maxTimeMs/)
    expect(performance.now() - t0).toBeLessThan(2 * 150 + 400)
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 100)
    const b = await loadSpecData(spec({ name: 't', url: `${stall.origin}/headers-never` }), { ...TRUSTED_LOAD_OPTIONS, signal: ac.signal }).catch((e) => e)
    expect(b).toBeInstanceOf(Error)
    expect(b).not.toBeInstanceOf(AsterLimitError)
  }, 15_000)

  it('an endless body is cut off at maxBytes WHILE it streams (the server never finishes)', async () => {
    endlessSent = 0
    const err = await loadSpecData(spec({ name: 't', url: `${endless.origin}/` }), { ...TRUSTED_LOAD_OPTIONS, maxBytes: 20_000, timeoutMs: 10_000 }).catch((e) => e)
    expect(err).toBeInstanceOf(AsterLimitError)
    expect(String(err.message)).toMatch(/maxBytes \d+ > 20000/)
    // the producer was stopped long before it could have buffered anything large
    expect(endlessSent).toBeLessThan(20_000 + 5_000_000)
  }, 15_000)

  it('a declared content-length over maxBytes is refused without reading the body', async () => {
    const err = await loadSpecData(spec({ name: 't', url: `${main.origin}/big-declared` }), { ...TRUSTED_LOAD_OPTIONS, maxBytes: 1000 }).catch((e) => e)
    expect(err).toBeInstanceOf(AsterLimitError)
    expect(String(err.message)).toMatch(/content-length/)
  }, 15_000)

  it('concurrency is capped (default 4, configurable)', async () => {
    const many = spec(...Array.from({ length: 12 }, (_, i) => ({ name: 'd' + i, url: `${slowGate.origin}/${i}` })))
    gate.inflight = 0; gate.max = 0
    const loaded = await loadSpecData(many, TRUSTED_LOAD_OPTIONS)
    expect((loaded.data as unknown[]).length).toBe(12)
    expect(gate.max).toBe(LOAD_DEFAULTS.maxConcurrent)
    gate.max = 0
    await loadSpecData(many, { ...TRUSTED_LOAD_OPTIONS, maxConcurrent: 2 })
    expect(gate.max).toBe(2)
  }, 15_000)

  it('limits.maxRows applies to what is loaded', async () => {
    const err = await loadSpecData(spec({ name: 't', url: `${main.origin}/rows.json` }), { ...TRUSTED_LOAD_OPTIONS, limits: { maxRows: 1 } }).catch((e) => e)
    expect(err).toBeInstanceOf(AsterLimitError)
    expect(String(err.message)).toMatch(/maxRows/)
  })
})

describe('what is loaded (C60)', () => {
  const okFetch = (body: string): typeof fetch => (async () => ({ ok: true, status: 200, headers: new Headers(), text: async () => body })) as unknown as typeof fetch

  it('group-level url datasets (nested at any depth) are resolved, the input spec is not mutated', async () => {
    const input = {
      data: [{ name: 'top', url: 'https://example.test/a.json' }],
      marks: [{ type: 'group', data: [{ name: 'g1', url: 'https://example.test/b.json' }],
        marks: [{ type: 'group', data: [{ name: 'g2', url: 'https://example.test/c.json' }], marks: [] }] }],
    } as unknown as VgSpec
    const before = JSON.stringify(input)
    const out = await loadSpecData(input, { fetch: okFetch('[{"v":1}]') }) as unknown as {
      data: Array<{ values: unknown }>; marks: Array<{ data: Array<{ values: unknown }>; marks: Array<{ data: Array<{ values: unknown }> }> }> }
    expect(out.data[0]!.values).toEqual([{ v: 1 }])
    expect(out.marks[0]!.data[0]!.values).toEqual([{ v: 1 }])
    expect(out.marks[0]!.marks[0]!.data[0]!.values).toEqual([{ v: 1 }])
    expect(JSON.stringify(input)).toBe(before)
  })

  it('a url dataset nobody loaded is an error at evaluation, never an empty chart', async () => {
    const { renderSpec } = await import('./index.js')
    const s = spec({ name: 't', url: 'https://example.test/a.json' })
    expect(() => renderSpec(s)).toThrow(/dataset "t" has a url but no data was loaded for it.*loadSpecData/)
    // host-supplied rows are fine
    expect(() => renderSpec(s, { data: { t: [{ a: 1 }] } })).not.toThrow()
    // a loaded spec is fine
    const loaded = await loadSpecData(s, { fetch: okFetch('[{"a":1}]') })
    expect(() => renderSpec(loaded)).not.toThrow()
  })

  it('a signal-valued url is a clear error rather than a silent empty dataset', async () => {
    await expect(loadSpecData(spec({ name: 't', url: { signal: 'u' } }))).rejects.toThrow(/url must be a string/)
  })

  it('format.parse date patterns work like vega-loader (date:/utc: with quotes)', async () => {
    const rows = 'd,u,n\n15/01/2024,2024-01-15,5\n'
    const loaded = await loadSpecData(spec({ name: 't', url: 'https://example.test/a.csv', format: { type: 'csv', parse: { d: "date:'%d/%m/%Y'", u: 'utc:"%Y-%m-%d"', n: 'number' } } }), { fetch: okFetch(rows) })
    const row = (valuesOf(loaded) as Array<Record<string, unknown>>)[0]!
    expect(row.d).toBeInstanceOf(Date)
    expect((row.d as Date).getFullYear()).toBe(2024)
    expect((row.d as Date).getMonth()).toBe(0)
    expect((row.d as Date).getDate()).toBe(15)
    expect((row.u as Date).toISOString()).toBe('2024-01-15T00:00:00.000Z')
    expect(row.n).toBe(5)
  })

  it('topojson: object names are looked up as OWN properties', async () => {
    const topo = JSON.stringify({ type: 'Topology', arcs: [], objects: { g: { type: 'GeometryCollection', geometries: [] } } })
    for (const feature of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      await expect(loadSpecData(spec({ name: 't', url: 'https://example.test/t.json', format: { type: 'topojson', feature } }), { fetch: okFetch(topo) }))
        .rejects.toThrow(/topojson object ".*" not found/)
    }
    const ok = await loadSpecData(spec({ name: 't', url: 'https://example.test/t.json', format: { type: 'topojson', feature: 'g' } }), { fetch: okFetch(topo) })
    expect(valuesOf(ok)).toEqual([])
  })

  it('topojson loaded over the wire is metered against the limits (22 KB -> millions of points)', async () => {
    const arc = Array.from({ length: 500 }, (_, i) => [i, i % 5])
    const topo = JSON.stringify({ type: 'Topology', arcs: [arc], objects: { g: { type: 'GeometryCollection', geometries: [{ type: 'Polygon', arcs: [new Array(4000).fill(0)] }] } } })
    expect(topo.length).toBeLessThan(40_000)
    const err = await loadSpecData(spec({ name: 't', url: 'https://example.test/t.json', format: { type: 'topojson', feature: 'g' } }),
      { fetch: okFetch(topo), limits: { maxRows: 50_000 } }).catch((e) => e)
    expect(err).toBeInstanceOf(AsterLimitError)
    expect(String(err.message)).toMatch(/maxRows/)
  })
})
