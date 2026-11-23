// @vitest-environment node
/**
 * What loadSpecData guarantees whatever the fetch, the hook and the response do (C14, C235, C236, C237, C268, C531, C402, and the
 * required URL policy of DECISIONS Q3). Every fetch here is a stub: no network.
 */
import { describe, expect, it } from 'vitest'
import { AsterUrlError, LOAD_DEFAULTS, allowOrigins, loadSpecData, type LoadOptions } from './addon-load.js'
import { AsterLimitError } from './limits.js'
import type { VgSpec } from './types.js'

const ANY = (): boolean => true
const spec = (...defs: Array<Record<string, unknown>>): VgSpec => ({ data: defs } as unknown as VgSpec)
const one = (url: unknown, extra: Record<string, unknown> = {}): VgSpec => spec({ name: 't', url, ...extra })
const valuesOf = (s: VgSpec, i = 0): unknown => (s.data as unknown as Array<{ values: unknown }>)[i]!.values
const never = <T>(): Promise<T> => new Promise<T>(() => undefined)
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Settle `p` within `ms`, or report that it was still pending. */
async function within<T>(p: Promise<T>, ms: number): Promise<{ value?: T; error?: unknown; pending?: true; ms: number }> {
  const t0 = Date.now()
  const timeout = sleep(ms).then(() => 'pending' as const)
  const r = await Promise.race([p.then((value) => ({ value }), (error: unknown) => ({ error })), timeout])
  return r === 'pending' ? { pending: true, ms: Date.now() - t0 } : { ...r, ms: Date.now() - t0 }
}

// -- the URL policy is required -----------------------------------------------------------------------------------

describe('a network url needs an explicit policy (DECISIONS Q3)', () => {
  const requested: string[] = []
  const stub = (async (u: string) => { requested.push(String(u)); return new Response('[{"a":1}]') }) as unknown as typeof fetch

  it('without allow or a baseURL it is on, every public http(s) url is refused before any request', async () => {
    requested.length = 0
    for (const url of ['https://example.com/a.json', 'http://data.example.org/x', 'https://vega.github.io/vega-datasets/data/cars.json', '//cdn.example.net/a.json']) {
      const err = await loadSpecData(one(url), { fetch: stub }).catch((e) => e)
      expect(err, url).toBeInstanceOf(AsterUrlError)
      expect(String(err.message)).toMatch(/explicit URL policy/)
    }
    expect(requested).toEqual([])
  })

  it('allowOrigins is an origin allowlist; a url on the baseURL origin needs none; data: needs only the protocol', async () => {
    requested.length = 0
    const allow = allowOrigins(['https://data.example.com', 'https://cdn.example.net/any/path'])
    expect(valuesOf(await loadSpecData(one('https://data.example.com/a.json'), { fetch: stub, allow }))).toEqual([{ a: 1 }])
    expect(valuesOf(await loadSpecData(one('https://cdn.example.net/b.json'), { fetch: stub, allow }))).toEqual([{ a: 1 }])
    await expect(loadSpecData(one('https://data.example.com.evil.example.org/a.json'), { fetch: stub, allow })).rejects.toThrow(/allow hook/)
    await expect(loadSpecData(one('http://data.example.com/a.json'), { fetch: stub, allow })).rejects.toThrow(/allow hook/)
    expect(valuesOf(await loadSpecData(one('rows.json'), { fetch: stub, baseURL: 'https://app.example.com/v1/' }))).toEqual([{ a: 1 }])
    expect(valuesOf(await loadSpecData(one('data:application/json,[{"d":1}]'), { protocols: ['data:'] }))).toEqual([{ d: 1 }])
    expect(requested).toEqual(['https://data.example.com/a.json', 'https://cdn.example.net/b.json', 'https://app.example.com/v1/rows.json'])
    for (const bad of ['data.example.com', '/rel', 'data:text/plain,x', 'file:///etc/passwd', 5 as unknown as string]) {
      expect(() => allowOrigins([bad]), String(bad)).toThrow(TypeError)
    }
  })
})

// -- redirects: every hop vetted before it is requested, in every environment (C268) ----------------------------------

/** A fetch that answers from a table of url -> response maker, recording each request and its redirect mode. */
function routes(table: Record<string, () => Response | Record<string, unknown>>): { fetch: typeof fetch; requests: Array<[string, string | undefined]> } {
  const requests: Array<[string, string | undefined]> = []
  const fetchImpl = (async (u: string, init?: RequestInit) => {
    requests.push([String(u), init?.redirect])
    const make = table[String(u)]
    if (!make) return new Response('not found', { status: 404 })
    return make() as Response
  }) as unknown as typeof fetch
  return { fetch: fetchImpl, requests }
}
const redirect = (to: string, status = 302) => (): Response => new Response(null, { status, headers: { location: to } })

describe('redirects (C268)', () => {
  it('a browser-style opaque redirect is refused without following it: one manual request, never a follow', async () => {
    const r = routes({ 'https://pub.example.com/a': () => ({ type: 'opaqueredirect', status: 0, ok: false, redirected: false, url: '', headers: new Headers() }) })
    const err = await loadSpecData(one('https://pub.example.com/a'), { fetch: r.fetch, allow: ANY }).catch((e) => e)
    expect(err).toBeInstanceOf(AsterUrlError)
    expect(String(err.message)).toMatch(/cannot be vetted before it is requested/)
    expect(r.requests).toEqual([['https://pub.example.com/a', 'manual']])
  })

  it('chains of every length: each hop is vetted before it is requested, maxRedirects is enforced, a non-public hop is never requested', async () => {
    for (let length = 0; length <= 7; length++) {
      for (const maxRedirects of [0, 1, 3, 5, 6]) {
        for (const privateAt of [-1, 0, Math.floor(length / 2), length - 1]) {
          if (privateAt >= length) continue
          // hop i redirects to hop i+1; the hop at `privateAt` points at a private address instead
          const table: Record<string, () => Response> = {}
          const hop = (i: number): string => `https://h${i}.example.com/x`
          for (let i = 0; i < length; i++) table[hop(i)] = redirect(i === privateAt ? 'http://10.0.0.7/admin' : hop(i + 1))
          table[hop(length)] = () => new Response('[{"ok":1}]')
          table['http://10.0.0.7/admin'] = () => new Response('[{"secret":1}]')
          const r = routes(table)
          const vetted: string[] = []
          const allow = (u: URL): boolean => { vetted.push(u.href); return true }
          const result = await loadSpecData(one(hop(0)), { fetch: r.fetch, allow, maxRedirects }).then((s) => valuesOf(s), (e: unknown) => e)
          const label = `length ${length} maxRedirects ${maxRedirects} privateAt ${privateAt}`
          // every request was vetted before it was made, in order, and made in manual mode
          for (const [k, [u, mode]] of r.requests.entries()) {
            expect(mode, label).toBe('manual')
            expect(vetted[k], label).toBe(u)
          }
          expect(r.requests.some(([u]) => u.startsWith('http://10.')), label).toBe(false)
          // (hop k's redirect is followed, and its target vetted, only while k < maxRedirects)
          const reachesPrivate = privateAt >= 0 && privateAt < Math.min(length, maxRedirects)
          if (reachesPrivate) {
            expect(result, label).toBeInstanceOf(AsterUrlError)
            expect(String((result as Error).message), label).toMatch(/non-public/)
          } else if (length > maxRedirects) {
            expect(result, label).toBeInstanceOf(AsterLimitError)
            expect(String((result as Error).message), label).toMatch(new RegExp(`maxRedirects ${maxRedirects + 1} > ${maxRedirects}`))
            expect(r.requests.length, label).toBe(maxRedirects + 1)
          } else {
            expect(result, label).toEqual([{ ok: 1 }])
            expect(r.requests.length, label).toBe(length + 1)
          }
        }
      }
    }
  })

  it('a Location that is not a URL is an AsterUrlError, and a redirect without one is too', async () => {
    const bad = routes({ 'https://a.example.com/x': redirect('http://[::1') })
    const e1 = await loadSpecData(one('https://a.example.com/x'), { fetch: bad.fetch, allow: ANY }).catch((e) => e)
    expect(e1).toBeInstanceOf(AsterUrlError)
    expect(String(e1.message)).toMatch(/Location that is not a valid URL/)
    const none = routes({ 'https://a.example.com/x': () => new Response(null, { status: 301 }) })
    await expect(loadSpecData(one('https://a.example.com/x'), { fetch: none.fetch, allow: ANY })).rejects.toBeInstanceOf(AsterUrlError)
  })
})

// -- the clock does not depend on the fetch honouring the signal (C235) ---------------------------------------------

describe('timeoutMs, limits.maxTimeMs and the caller\'s signal hold whatever the fetch, the hook or the body do (C235)', () => {
  /** Ways a load can stall, none of which honours the abort signal. */
  const stalls: Record<string, () => Pick<LoadOptions, 'fetch' | 'allow'>> = {
    'fetch never settles': () => ({ fetch: (() => never()) as unknown as typeof fetch, allow: ANY }),
    'fetch answers after 2 s': () => ({ fetch: (async () => { await sleep(2000); return new Response('[]') }) as unknown as typeof fetch, allow: ANY }),
    'allow hook never settles': () => ({ fetch: (async () => new Response('[]')) as unknown as typeof fetch, allow: () => never<boolean>() }),
    'text() never settles (no stream)': () => ({ fetch: (async () => ({ ok: true, status: 200, headers: new Headers(), text: () => never<string>() })) as unknown as typeof fetch, allow: ANY }),
    'body stream stalls after a chunk': () => ({
      fetch: (async () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('[')) } }))) as unknown as typeof fetch,
      allow: ANY,
    }),
    'read() answers after 2 s': () => ({
      fetch: (async () => ({
        ok: true, status: 200, headers: new Headers(),
        body: { getReader: () => ({ read: async () => { await sleep(2000); return { done: true, value: undefined } }, cancel: async () => undefined }), cancel: async () => undefined },
      })) as unknown as typeof fetch,
      allow: ANY,
    }),
  }
  const stoppers: Record<string, (o: Pick<LoadOptions, 'fetch' | 'allow'>) => { options: LoadOptions; expect: (e: unknown) => void }> = {
    timeoutMs: (o) => ({ options: { ...o, timeoutMs: 80 }, expect: (e) => { expect(e).toBeInstanceOf(AsterLimitError); expect(String((e as Error).message)).toMatch(/timeoutMs 80/) } }),
    'limits.maxTimeMs': (o) => ({ options: { ...o, limits: { maxTimeMs: 80 } }, expect: (e) => { expect(e).toBeInstanceOf(AsterLimitError); expect(String((e as Error).message)).toMatch(/maxTimeMs/) } }),
    'caller abort': (o) => {
      const ac = new AbortController()
      setTimeout(() => ac.abort(new Error('caller gave up')), 80)
      return { options: { ...o, signal: ac.signal }, expect: (e) => expect(String((e as Error).message)).toMatch(/caller gave up/) }
    },
  }
  for (const [stall, make] of Object.entries(stalls)) {
    for (const [stopper, stop] of Object.entries(stoppers)) {
      it(`${stall}: ${stopper} ends the call`, async () => {
        const { options, expect: check } = stop(make())
        const r = await within(loadSpecData(one('https://slow.example.com/a.json'), options), 1000)
        expect(r.pending, `still pending after ${r.ms} ms`).toBeUndefined()
        expect(r.value).toBeUndefined()
        check(r.error)
        expect(r.ms).toBeLessThan(800)
      })
    }
  }

  it('a response that resolves after the caller aborted is never taken', async () => {
    const ac = new AbortController()
    const p = loadSpecData(one('https://a.example.com/x'), {
      allow: ANY, signal: ac.signal,
      fetch: (async () => { ac.abort(new Error('aborted mid-flight')); return new Response('[{"late":1}]') }) as unknown as typeof fetch,
    })
    await expect(p).rejects.toThrow(/aborted mid-flight/)
  })
})

// -- options are validated (C237) -----------------------------------------------------------------------------------

describe('every option is validated once, before anything is requested (C237)', () => {
  const numeric: Record<string, { ok: number[]; bad: unknown[] }> = {
    timeoutMs: { ok: [1, 5000, 2_147_483_647], bad: [NaN, Infinity, -1, 0, 1.5, '100', null, 2_147_483_648, 10n] },
    maxBytes: { ok: [0, 1, 10_000_000], bad: [NaN, Infinity, -1, 1.5, '100', null, {}] },
    maxTotalBytes: { ok: [0, 1, 10_000_000], bad: [NaN, Infinity, -1, 2.5, '1', null] },
    maxRequests: { ok: [1, 100], bad: [NaN, 0, -1, 1.5, Infinity, '4'] },
    maxConcurrent: { ok: [1, 4, 64], bad: [NaN, 0, -1, 1.5, Infinity, '4', null] },
    maxRedirects: { ok: [0, 1, 20], bad: [NaN, -1, 1.5, Infinity, '5', null] },
  }
  for (const [name, { ok, bad }] of Object.entries(numeric)) {
    it(`${name}: a value that is not a whole number in range is a TypeError, and nothing is fetched`, async () => {
      let calls = 0
      const fetchImpl = (async () => { calls++; return new Response('[]') }) as unknown as typeof fetch
      for (const v of bad) {
        const err = await loadSpecData(one('https://a.example.com/x'), { allow: ANY, fetch: fetchImpl, [name]: v } as LoadOptions).catch((e) => e)
        expect(err, `${name}: ${String(v)}`).toBeInstanceOf(TypeError)
        expect(String(err.message)).toMatch(new RegExp(`loadSpecData: ${name} must be`))
      }
      expect(calls).toBe(0)
      // (a valid value is taken: whatever the call then does, it is not refused for the option)
      for (const v of ok) {
        const r = await loadSpecData(one('https://a.example.com/x'), { allow: ANY, fetch: fetchImpl, [name]: v } as LoadOptions).catch((e) => e)
        expect(r, `${name}: ${v}`).not.toBeInstanceOf(TypeError)
      }
      expect(calls).toBe(ok.length)
    })
  }

  it('the other options: type-checked, a wrong one is a TypeError', async () => {
    const cases: Array<[keyof LoadOptions, unknown]> = [
      ['fetch', 'globalThis.fetch'], ['allow', true], ['allowPrivateNetwork', 'yes'], ['allowPrivateNetwork', 1], ['signal', {}], ['signal', 'abort'],
      ['protocols', 'https:'], ['protocols', ['https']], ['protocols', ['HTTPS:']], ['baseURL', 42], ['signals', 'x'], ['signals', [1]], ['limits', 5],
    ]
    for (const [name, v] of cases) {
      const err = await loadSpecData(one('https://a.example.com/x'), { allow: ANY, fetch: (async () => new Response('[]')) as unknown as typeof fetch, [name]: v } as LoadOptions).catch((e) => e)
      expect(err, `${name}: ${JSON.stringify(v)}`).toBeInstanceOf(TypeError)
    }
    await expect(loadSpecData(one('https://a.example.com/x'), null as unknown as LoadOptions)).rejects.toBeInstanceOf(TypeError)
  })

  it('maxConcurrent: 1 runs every request, one at a time (a disabled semaphore would hang)', async () => {
    let inflight = 0
    let max = 0
    const fetchImpl = (async () => { inflight++; max = Math.max(max, inflight); await sleep(5); inflight--; return new Response('[]') }) as unknown as typeof fetch
    const many = spec(...Array.from({ length: 6 }, (_, i) => ({ name: 'd' + i, url: `https://a.example.com/${i}` })))
    await loadSpecData(many, { allow: ANY, fetch: fetchImpl, maxConcurrent: 1 })
    expect(max).toBe(1)
  })
})

// -- request and byte budgets, one request per url (C236) --------------------------------------------------------------

describe('a call is bounded in requests and bytes, and one url is requested once (C236)', () => {
  it('20 000 datasets naming one url make one request', async () => {
    let calls = 0
    const fetchImpl = (async () => { calls++; return new Response('[{"a":1}]') }) as unknown as typeof fetch
    const many = spec(...Array.from({ length: 20_000 }, (_, i) => ({ name: 'd' + i, url: 'https://a.example.com/same.json' })))
    const loaded = await loadSpecData(many, { allow: ANY, fetch: fetchImpl })
    expect(calls).toBe(1)
    expect(valuesOf(loaded, 19_999)).toEqual([{ a: 1 }])
    // the same url written two ways is one url
    calls = 0
    await loadSpecData(spec({ name: 'a', url: 'https://A.example.com/x/../same.json' }, { name: 'b', url: 'https://a.example.com/same.json' }), { allow: ANY, fetch: fetchImpl })
    expect(calls).toBe(1)
  })

  it('maxRequests bounds the requests, redirect hops included', async () => {
    let calls = 0
    const fetchImpl = (async () => { calls++; return new Response('[]') }) as unknown as typeof fetch
    const distinct = (n: number): VgSpec => spec(...Array.from({ length: n }, (_, i) => ({ name: 'd' + i, url: `https://a.example.com/${i}` })))
    await expect(loadSpecData(distinct(LOAD_DEFAULTS.maxRequests), { allow: ANY, fetch: fetchImpl })).resolves.toBeDefined()
    calls = 0
    const err = await loadSpecData(distinct(LOAD_DEFAULTS.maxRequests + 1), { allow: ANY, fetch: fetchImpl, maxConcurrent: 1 }).catch((e) => e)
    expect(err).toBeInstanceOf(AsterLimitError)
    expect(String(err.message)).toMatch(new RegExp(`maxRequests ${LOAD_DEFAULTS.maxRequests + 1} > ${LOAD_DEFAULTS.maxRequests}`))
    expect(calls).toBe(LOAD_DEFAULTS.maxRequests)
    // two hops are two requests
    const r = routes({ 'https://a.example.com/r': redirect('https://a.example.com/ok'), 'https://a.example.com/ok': () => new Response('[]') })
    await expect(loadSpecData(one('https://a.example.com/r'), { allow: ANY, fetch: r.fetch, maxRequests: 1 })).rejects.toThrow(/maxRequests 2 > 1/)
  })

  it('maxTotalBytes bounds the bytes read into datasets, summed over them', async () => {
    const body = '[' + Array.from({ length: 100 }, () => '{"a":1}').join(',') + ']' // 801 bytes
    const fetchImpl = (async () => new Response(body)) as unknown as typeof fetch
    const datasets = (n: number, same: boolean): VgSpec => spec(...Array.from({ length: n }, (_, i) => ({ name: 'd' + i, url: `https://a.example.com/${same ? 0 : i}` })))
    await expect(loadSpecData(datasets(3, false), { allow: ANY, fetch: fetchImpl, maxTotalBytes: 3 * 801 })).resolves.toBeDefined()
    for (const same of [false, true]) {
      const err = await loadSpecData(datasets(4, same), { allow: ANY, fetch: fetchImpl, maxTotalBytes: 3 * 801 }).catch((e) => e)
      expect(err, `same url: ${same}`).toBeInstanceOf(AsterLimitError)
      expect(String(err.message)).toMatch(/maxTotalBytes 3204 > 2403/)
    }
  })
})

// -- {signal} urls: evaluated under the limits, in their own scope, reading only what they read (C14, C531) -----------

describe('a {signal} url (C14, C531)', () => {
  const stub = (seen: string[]): typeof fetch => (async (u: string) => { seen.push(String(u)); return new Response('[]') }) as unknown as typeof fetch
  const EVIL = "test(/(a+)+$/, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!')"

  it('is evaluated under the limits: a backtracking regular expression is refused at once, not run for seconds', async () => {
    const s = { signals: [{ name: 'u', init: `${EVIL} ? 'https://a.example.com/1' : 'https://a.example.com/2'` }], data: [{ name: 'd', url: { signal: 'u' } }] } as unknown as VgSpec
    for (const limits of [{ maxTimeMs: 200 }, { regex: 'refuse' as const }, { maxRows: 10 }]) {
      const r = await within(loadSpecData(s, { allow: ANY, fetch: stub([]), limits }), 3000)
      expect(r.pending, JSON.stringify(limits)).toBeUndefined()
      expect(r.error, JSON.stringify(limits)).toBeInstanceOf(AsterLimitError)
      expect(String((r.error as Error).message)).toMatch(/regexSafety/)
      expect(r.ms).toBeLessThan(1000)
    }
  })

  it('evaluates only the signals the url reads (a signal it does not read is never run)', async () => {
    const seen: string[] = []
    const s = {
      signals: [{ name: 'slow', init: EVIL }, { name: 'base', value: 'https://a.example.com/' }, { name: 'u', update: "base + 'x.json'" }],
      data: [{ name: 'd', url: { signal: 'u' } }],
    } as unknown as VgSpec
    const r = await within(loadSpecData(s, { allow: ANY, fetch: stub(seen) }), 3000)
    expect(r.pending).toBeUndefined()
    expect(r.error).toBeUndefined()
    expect(seen).toEqual(['https://a.example.com/x.json'])
  })

  it('reads the signals of its own scope: a group mark\'s, shadowing the view\'s, at any depth; the host\'s values win at the top', async () => {
    const seen: string[] = []
    const s = {
      width: 300,
      signals: [{ name: 'host', value: 'https://a.example.com/' }, { name: 'file', value: 'top.json' }],
      data: [{ name: 'top', url: { signal: "host + file + '?w=' + width" } }],
      marks: [{
        type: 'group',
        signals: [{ name: 'file', value: 'group.json' }, { name: 'sub', init: "'sub/' + file" }],
        data: [{ name: 'g', url: { signal: 'host + file' } }],
        marks: [{ type: 'group', data: [{ name: 'gg', url: { signal: 'host + sub' } }] }],
      }],
    } as unknown as VgSpec
    await loadSpecData(s, { allow: ANY, fetch: stub(seen) })
    expect(seen.sort()).toEqual(['https://a.example.com/group.json', 'https://a.example.com/sub/group.json', 'https://a.example.com/top.json?w=300'].sort())
    seen.length = 0
    await loadSpecData(s, { allow: ANY, fetch: stub(seen), signals: { file: 'host-chosen.json', width: 10 } })
    // the host sets the view's `file`; the group's own `file` still shadows it inside the group
    expect(seen.sort()).toEqual(['https://a.example.com/group.json', 'https://a.example.com/host-chosen.json?w=10', 'https://a.example.com/sub/group.json'].sort())
  })

  it('a signal that reads itself, directly or through another, has no value (no endless recursion)', async () => {
    const s = { signals: [{ name: 'a', init: 'b' }, { name: 'b', init: 'a' }], data: [{ name: 'd', url: { signal: 'a' } }] } as unknown as VgSpec
    await expect(loadSpecData(s, { allow: ANY, fetch: stub([]) })).rejects.toThrow(/url must be a string/)
  })
})

// -- deep and cyclic specs are typed refusals (C402) ------------------------------------------------------------------

describe('a deep or cyclic spec is an AsterLimitError, never a stack overflow (C402)', () => {
  it('20 000 nested groups, and a mark list that contains itself', async () => {
    let inner: Record<string, unknown> = { type: 'group', data: [{ name: 'd', url: 'https://a.example.com/x' }] }
    for (let i = 0; i < 20_000; i++) inner = { type: 'group', marks: [inner] }
    const deep = await loadSpecData({ marks: [inner] } as unknown as VgSpec, { allow: ANY, fetch: (async () => new Response('[]')) as unknown as typeof fetch }).catch((e) => e)
    expect(deep).toBeInstanceOf(AsterLimitError)
    const group: Record<string, unknown> = { type: 'group', data: [{ name: 'd', url: 'https://a.example.com/x' }] }
    group.marks = [group]
    const cyclic = await loadSpecData({ marks: [group] } as unknown as VgSpec, { allow: ANY, fetch: (async () => new Response('[]')) as unknown as typeof fetch }).catch((e) => e)
    expect(cyclic).toBeInstanceOf(AsterLimitError)
  })
})
