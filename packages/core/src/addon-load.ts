/**
 * Opt-in data-loading addon. Importing (or dynamic-importing) this module
 * registers the text-format readers (csv/tsv/dsv via the owned d3-dsv port,
 * topojson via the owned topojson-client port) and provides `loadSpecData`, which resolves every `url`
 * dataset in a spec into inline values:
 *
 *   import { loadSpecData } from '@aster/core/load'
 *   renderSpec(await loadSpecData(spec))
 *
 * Inline JSON values and `format.parse` type coercion work without the addon
 * (vega-loader-identical semantics ship in the core); csv/tsv/dsv/topojson
 * strings and URL datasets need it.
 */
import { dsvFormat } from './dsv.js'
import { feature as topoFeature, mesh as topoMesh } from './topojson.js'
import { dataFormatRegistry } from './registry.js'
import { readData, type DataFormatSpec, type inferTypes as _inferTypes } from './data-format.js'
import type { VgSpec } from './types.js'
import { AsterLimitError, checkRowCount, withLimits, type SpecLimits } from './limits.js'
import { AsterUrlError, DEFAULT_LOAD_PROTOCOLS, checkBasicUrl, type UrlPolicyBase } from './url-policy.js'

function delimited(delimiter: string) {
  return (data: unknown, format: Record<string, unknown>) => {
    let text = String(data)
    const header = format.header as unknown[] | undefined
    if (header) {
      text = header.map((h) => '"' + String(h).replaceAll('"', '""') + '"').join(delimiter) + '\n' + text
    }
    return dsvFormat(delimiter).parse(text) as unknown as Record<string, unknown>[]
  }
}

dataFormatRegistry.set('csv', delimited(','))
dataFormatRegistry.set('tsv', delimited('\t'))
dataFormatRegistry.set('dsv', (data: unknown, format: Record<string, unknown>) => delimited(String(format.delimiter ?? ','))(data, format))

dataFormatRegistry.set('topojson', (data, format) => {
  // vega-loader topojson: the input may be the topology object or an array
  // holding it; parse via the JSON reader first.
  const [topo] = readData(Array.isArray(data) ? (data as unknown[])[0] : data, {
    ...format,
    type: 'json',
  }) as unknown as [Record<string, unknown>]
  if (!topo || (topo as Record<string, unknown>).type !== 'Topology') {
    throw new Error('[aster] topojson data must be a Topology object')
  }
  // `format.feature` / `format.mesh` name an object of the topology: look it up
  // by OWN property (topojson.ts rejects `constructor`, `__proto__`, ...), and
  // the decoded coordinates are metered against the limits in scope (C60).
  if (format.feature) {
    const fc = topoFeature(topo as never, String(format.feature))
    return (fc as { features?: unknown[] }).features as Record<string, unknown>[]
  }
  if (format.mesh) {
    const meshGeom = topoMesh(topo as never, String(format.mesh))
    return [{ type: 'GeometryCollection', geometries: [meshGeom] }] as Record<string, unknown>[]
  }
  throw new Error('[aster] topojson format requires "feature" or "mesh"')
})

// ---------------------------------------------------------------------------
// URL loading with a policy (C6, C60)
// ---------------------------------------------------------------------------

/** Typed loader failure that is not a budget: the URL policy refused a request, or the response was unusable. */
export { AsterUrlError } from './url-policy.js'

/** Options for {@link loadSpecData}. Every default is the safe one; see docs/LIMITS.md. */
export interface LoadOptions {
  /** Fetch implementation. Defaults to `globalThis.fetch`. */
  fetch?: typeof globalThis['fetch']
  /**
   * Base for relative `url`s (the origin of your data service, or
   * `location.href` in a browser). Without it a relative url is an error. A url
   * on the base's own origin is treated as host-chosen: it needs no `allow`.
   */
  baseURL?: string
  /** Allowed protocols, with the trailing colon. Default `['http:', 'https:']`; add `'data:'` to permit data URLs. */
  protocols?: readonly string[]
  /**
   * Veto hook, consulted for the initial URL and again for every redirect hop.
   * Return true to permit. For an allowlist of origins this is the place.
   */
  allow?: (url: URL) => boolean | Promise<boolean>
  /**
   * Permit loopback, private, link-local and other non-public hosts (by the
   * host literal in the URL). Default false. Does not apply to the baseURL's
   * own origin. It cannot see DNS: a public name that resolves to a private
   * address is only stopped by `allow` or by network egress rules.
   */
  allowPrivateNetwork?: boolean
  /** Abort the whole load. */
  signal?: AbortSignal
  /** Per-request timeout in milliseconds, covering headers AND body. Default 10 000. */
  timeoutMs?: number
  /** Largest response body, in bytes, enforced while the stream is read. Default 10 485 760. */
  maxBytes?: number
  /** Requests in flight at once. Default 4. */
  maxConcurrent?: number
  /** Redirect hops followed (each re-checked against the policy). Default 5. */
  maxRedirects?: number
  /**
   * Budgets applied to what is loaded: `maxRows` per loaded dataset,
   * `maxGeneratedRows`/`maxRows` over decoded topojson coordinates, and
   * `maxTimeMs` over the whole call.
   */
  limits?: SpecLimits
}

/** Defaults, exported so docs and tests can state them. */
export const LOAD_DEFAULTS = {
  timeoutMs: 10_000,
  maxBytes: 10 * 1024 * 1024,
  maxConcurrent: 4,
  maxRedirects: 5,
} as const

/**
 * A policy for a host that loads its OWN, trusted specs (a demo, a test
 * harness, the conformance runners): any http(s) or data URL, private hosts
 * included. Never use it for specs you did not write.
 */
export const TRUSTED_LOAD_OPTIONS: Readonly<Pick<LoadOptions, 'protocols' | 'allow' | 'allowPrivateNetwork'>> = {
  protocols: ['http:', 'https:', 'data:'],
  allow: () => true,
  allowPrivateNetwork: true,
}

// --- host classification -----------------------------------------------------

function ipv4Octets(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!m) return null
  const o = m.slice(1).map(Number)
  return o.every((x) => x <= 255) ? o : null
}

function privateIPv4(o: number[]): boolean {
  const [a, b, c] = o as [number, number, number, number]
  return (
    a === 0 || a === 10 || a === 127 ||                 // this-network, private, loopback
    (a === 100 && b >= 64 && b <= 127) ||               // carrier-grade NAT
    (a === 169 && b === 254) ||                         // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||                // private
    (a === 192 && b === 0 && c === 0) ||                // IETF protocol assignments
    (a === 192 && b === 168) ||                         // private
    (a === 198 && (b === 18 || b === 19)) ||            // benchmarking
    a >= 224                                            // multicast and reserved
  )
}

/** Expand an IPv6 literal (no brackets, no zone) to eight 16-bit groups, or null. */
function ipv6Groups(host: string): number[] | null {
  let h = host
  const dotted = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(h)
  if (dotted) {
    const o = ipv4Octets(dotted[1]!)
    if (!o) return null
    h = h.slice(0, -dotted[1]!.length) + ((o[0]! << 8) | o[1]!).toString(16) + ':' + ((o[2]! << 8) | o[3]!).toString(16)
  }
  const halves = h.split('::')
  if (halves.length > 2) return null
  const left = halves[0] ? halves[0].split(':') : []
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const missing = 8 - left.length - right.length
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null
  const parts = [...left, ...new Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...right]
  if (parts.length !== 8) return null
  const out = parts.map((p) => (/^[0-9a-f]{1,4}$/i.test(p) ? parseInt(p, 16) : NaN))
  return out.some(Number.isNaN) ? null : out
}

/**
 * True when the host literal in a URL names a non-public destination:
 * `localhost` and local-only suffixes, loopback/private/link-local/reserved
 * IPv4, and the IPv6 equivalents including IPv4-mapped, NAT64 and 6to4 forms.
 * The WHATWG URL parser has already normalised octal/hex/decimal IPv4 spellings.
 */
export function isNonPublicHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '')
  if (host === '' || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.localdomain')) return true
  const v4 = ipv4Octets(host)
  if (v4) return privateIPv4(v4)
  if (host.includes(':')) {
    const g = ipv6Groups(host.split('%')[0]!)
    if (!g) return true // unparseable literal: fail closed
    const embedded = (hi: number, lo: number): number[] => [hi >> 8, hi & 255, lo >> 8, lo & 255]
    if (g.every((x) => x === 0)) return true                                                   // ::
    if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true                         // ::1
    if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) return privateIPv4(embedded(g[6]!, g[7]!)) // ::ffff:a.b.c.d, ::a.b.c.d
    if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return privateIPv4(embedded(g[6]!, g[7]!)) // 64:ff9b::/96
    if (g[0] === 0x2002) return privateIPv4(embedded(g[1]!, g[2]!))                            // 6to4
    if ((g[0]! & 0xfe00) === 0xfc00) return true                                               // fc00::/7 unique local
    if ((g[0]! & 0xffc0) === 0xfe80) return true                                               // fe80::/10 link-local
    if ((g[0]! & 0xff00) === 0xff00) return true                                               // multicast
    return false
  }
  return false
}

// --- the fetch pipeline -----------------------------------------------------

class Semaphore {
  private waiting: Array<() => void> = []
  private active = 0
  constructor(private readonly max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    // A finishing task hands its slot straight to the next waiter (active stays
    // constant), so a caller arriving in between cannot exceed the cap.
    if (this.active < this.max) this.active++
    else await new Promise<void>((resolve) => this.waiting.push(resolve))
    try {
      return await fn()
    } finally {
      const next = this.waiting.shift()
      if (next) next()
      else this.active--
    }
  }
}

interface ResolvedOptions {
  fetchImpl: typeof globalThis['fetch']
  policy: UrlPolicyBase
  allow?: LoadOptions['allow']
  allowPrivateNetwork: boolean
  baseOrigin: string | null
  timeoutMs: number
  maxBytes: number
  maxRedirects: number
  signal: AbortSignal
  sem: Semaphore
}

/** Run the policy on one URL (initial or redirect hop). Returns the parsed URL. */
async function vet(raw: string, o: ResolvedOptions): Promise<URL> {
  const url = checkBasicUrl(raw, o.policy, DEFAULT_LOAD_PROTOCOLS)
  if (!url) throw new AsterUrlError(raw, 'a relative url needs the baseURL option')
  // data: carries its own bytes: nothing to reach, no origin to compare
  if (url.protocol !== 'data:') {
    const sameOrigin = o.baseOrigin != null && url.origin === o.baseOrigin
    if (!sameOrigin && !o.allowPrivateNetwork && isNonPublicHost(url.hostname)) {
      throw new AsterUrlError(raw, 'the host is loopback, private or otherwise non-public (set allowPrivateNetwork to permit)')
    }
  }
  if (o.allow && (await o.allow(url)) !== true) throw new AsterUrlError(raw, 'refused by the allow hook')
  return url
}

const REDIRECT = new Set([301, 302, 303, 307, 308])

function timeoutError(url: string, ms: number): AsterLimitError {
  return new AsterLimitError(`timeoutMs ${ms} exceeded loading ${url.length > 120 ? url.slice(0, 120) + '...' : url}`)
}

async function readBounded(res: Response, url: string, o: ResolvedOptions): Promise<string> {
  const declared = Number(res.headers?.get?.('content-length'))
  if (Number.isFinite(declared) && declared > o.maxBytes) {
    try { await res.body?.cancel() } catch { /* nothing to release */ }
    throw new AsterLimitError(`maxBytes ${declared} > ${o.maxBytes} (content-length of ${url})`)
  }
  const reader = res.body?.getReader?.()
  if (!reader) {
    // Not a streaming Response (a minimal fetch shim): the size can only be
    // checked once the text exists; the caller's `fetch` owns bounding it.
    const text = await res.text()
    const size = new TextEncoder().encode(text).byteLength
    if (size > o.maxBytes) throw new AsterLimitError(`maxBytes ${size} > ${o.maxBytes} (${url})`)
    return text
  }
  const aborted = new Promise<never>((_, reject) => {
    const fail = () => reject(o.signal.reason ?? new DOMException('aborted', 'AbortError'))
    if (o.signal.aborted) fail()
    else o.signal.addEventListener('abort', fail, { once: true })
  })
  aborted.catch(() => { /* observed through the race below */ })
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await Promise.race([reader.read(), aborted])
    if (done) break
    total += value.byteLength
    if (total > o.maxBytes) {
      await reader.cancel().catch(() => undefined)
      throw new AsterLimitError(`maxBytes ${total} > ${o.maxBytes} (reading ${url})`)
    }
    chunks.push(value)
  }
  const all = new Uint8Array(total)
  let at = 0
  for (const c of chunks) { all.set(c, at); at += c.byteLength }
  return new TextDecoder('utf-8').decode(all)
}

/** Fetch one URL under the policy; resolves to the body text and the final URL. */
async function fetchText(raw: string, o: ResolvedOptions): Promise<{ text: string; finalUrl: URL }> {
  return o.sem.run(async () => {
    const own = new AbortController()
    const timer = setTimeout(() => own.abort(timeoutError(raw, o.timeoutMs)), o.timeoutMs)
    // AbortSignal.any needs Node >= 20.3; older runtimes get the same effect by forwarding.
    let signal: AbortSignal
    if (typeof AbortSignal.any === 'function') signal = AbortSignal.any([own.signal, o.signal])
    else {
      signal = own.signal
      if (o.signal.aborted) own.abort(o.signal.reason)
      else o.signal.addEventListener('abort', () => own.abort(o.signal.reason), { once: true })
    }
    const scoped: ResolvedOptions = { ...o, signal }
    try {
      let url = await vet(raw, o)
      for (let hop = 0; ; hop++) {
        // redirect:'manual' so every hop is vetted BEFORE it is requested
        let res = await o.fetchImpl(url.href, { signal, redirect: 'manual' })
        if (res.type === 'opaqueredirect') {
          // Browsers hide the Location of a manual redirect. Follow it, then vet the
          // final URL (the request was already sent: the browser's own origin rules apply).
          res = await o.fetchImpl(url.href, { signal, redirect: 'follow' })
          if (res.url) await vet(res.url, o)
        } else if (REDIRECT.has(res.status)) {
          const location = res.headers?.get?.('location')
          try { await res.body?.cancel() } catch { /* nothing to release */ }
          if (!location) throw new AsterUrlError(url.href, `HTTP ${res.status} redirect without a Location`)
          if (hop >= o.maxRedirects) throw new AsterLimitError(`maxRedirects ${hop + 1} > ${o.maxRedirects} (${raw})`)
          url = await vet(new URL(location, url).href, o)
          continue
        } else if (res.url && res.url !== url.href && res.redirected) {
          await vet(res.url, o) // a fetch that followed on its own: check where it ended up
        }
        if (!res.ok) throw new Error(`[aster] failed to load dataset url ${raw}: HTTP ${res.status}`)
        return { text: await readBounded(res, raw, scoped), finalUrl: url }
      }
    } catch (e) {
      // a timeout surfaces as the AsterLimitError carried by the abort reason
      if (own.signal.aborted && own.signal.reason instanceof AsterLimitError) throw own.signal.reason
      throw e
    } finally {
      clearTimeout(timer)
    }
  })
}

function formatTypeFor(format: DataFormatSpec | undefined, url: URL): string {
  const type = format?.type
  if (type) return type
  // vega-loader infers the format from the url extension
  const ext = /\.([a-z0-9]+)$/i.exec(url.pathname)?.[1]?.toLowerCase()
  return ext === 'tsv' ? 'tsv' : ext === 'csv' || ext === 'dsv' ? 'csv' : 'json'
}

// --- walking the spec ---------------------------------------------------------

type Json = Record<string, unknown>

interface LoadTask { def: Json; url: string; format: DataFormatSpec | undefined; name: string }

/**
 * Copy only the paths of `spec` that hold url datasets (top level AND inside
 * nested group marks, at any depth) and queue one task per dataset. The input is
 * never mutated; untouched branches are shared with it.
 */
function planLoads(spec: Json, tasks: LoadTask[]): Json {
  const visitData = (list: unknown): unknown => {
    if (!Array.isArray(list)) return list
    let changed = false
    const out = list.map((d) => {
      const def = d as Json | null
      if (def && typeof def === 'object' && def.url != null && def.values == null) {
        if (typeof def.url !== 'string') {
          throw new Error(`[aster] dataset "${String(def.name)}": url must be a string (a signal-valued url cannot be resolved ahead of time)`)
        }
        const copy: Json = { ...def }
        tasks.push({ def: copy, url: def.url, format: def.format as DataFormatSpec | undefined, name: String(def.name) })
        changed = true
        return copy
      }
      return d
    })
    return changed ? out : list
  }
  const visitMarks = (marks: unknown): unknown => {
    if (!Array.isArray(marks)) return marks
    let changed = false
    const out = marks.map((m) => {
      if (!m || typeof m !== 'object') return m
      const mark = m as Json
      const data = visitData(mark.data)
      const inner = visitMarks(mark.marks)
      if (data === mark.data && inner === mark.marks) return m
      changed = true
      return { ...mark, ...(data !== mark.data ? { data } : {}), ...(inner !== mark.marks ? { marks: inner } : {}) }
    })
    return changed ? out : marks
  }
  const data = visitData(spec.data)
  const marks = visitMarks(spec.marks)
  if (data === spec.data && marks === spec.marks) return spec
  return { ...spec, ...(data !== spec.data ? { data } : {}), ...(marks !== spec.marks ? { marks } : {}) }
}

/**
 * Fetch every `url` dataset in the spec - top level and inside group marks -
 * and inline its values, so the synchronous compile/evaluate/render pipeline
 * can run unchanged. Datasets already carrying `values` are left untouched.
 * Returns a new spec object; the input is not mutated.
 *
 * The spec is untrusted: every URL passes the policy in {@link LoadOptions}
 * before a request is made, redirects are re-checked hop by hop, and the
 * response is bounded in time and bytes. By default only public http(s)
 * hosts are reachable and relative urls need `baseURL`.
 */
export async function loadSpecData<T extends VgSpec>(spec: T, opts: LoadOptions = {}): Promise<T> {
  const tasks: LoadTask[] = []
  const planned = planLoads(spec as unknown as Json, tasks) as unknown as T
  if (!tasks.length) return spec
  const fetchImpl = opts.fetch ?? globalThis.fetch
  if (!fetchImpl) throw new Error('[aster] no fetch implementation available; pass one via loadSpecData(spec, { fetch })')

  let baseOrigin: string | null = null
  if (opts.baseURL != null) {
    try {
      baseOrigin = new URL(opts.baseURL).origin
    } catch {
      throw new AsterUrlError(opts.baseURL, 'baseURL is not a valid absolute URL')
    }
  }
  // One signal for the whole call: the caller's, plus the limits' wall clock.
  const overall = new AbortController()
  const maxTime = opts.limits?.maxTimeMs
  const wall = maxTime != null && Number.isFinite(maxTime) ? setTimeout(() => overall.abort(new AsterLimitError(`maxTimeMs exceeded during loadSpecData`)), Math.max(0, maxTime)) : null
  const onCallerAbort = () => overall.abort(opts.signal?.reason)
  if (opts.signal?.aborted) onCallerAbort()
  else opts.signal?.addEventListener('abort', onCallerAbort, { once: true })

  const o: ResolvedOptions = {
    fetchImpl,
    policy: { ...(opts.baseURL != null ? { baseURL: opts.baseURL } : {}), ...(opts.protocols ? { protocols: opts.protocols } : {}) },
    ...(opts.allow ? { allow: opts.allow } : {}),
    allowPrivateNetwork: opts.allowPrivateNetwork === true,
    baseOrigin,
    timeoutMs: opts.timeoutMs ?? LOAD_DEFAULTS.timeoutMs,
    maxBytes: opts.maxBytes ?? LOAD_DEFAULTS.maxBytes,
    maxRedirects: opts.maxRedirects ?? LOAD_DEFAULTS.maxRedirects,
    signal: overall.signal,
    sem: new Semaphore(Math.max(1, opts.maxConcurrent ?? LOAD_DEFAULTS.maxConcurrent)),
  }
  try {
    await Promise.all(
      tasks.map(async (task) => {
        const { text, finalUrl } = await fetchText(task.url, o)
        const type = formatTypeFor(task.format, finalUrl)
        // Parsing runs in the limits scope so topojson expansion and row counts are metered.
        const rows = withLimits(opts.limits, () => {
          const parsed = readData(text, { ...task.format, type })
          checkRowCount(parsed.length, `dataset "${task.name}"`)
          return parsed
        })
        // The format is consumed by the load (readData applies type + parse);
        // strip it so the runtime treats the inlined rows as pre-parsed.
        delete task.def.format
        task.def.values = rows
      }),
    )
  } catch (e) {
    // one failure abandons the rest: cancel in-flight requests
    overall.abort(e)
    throw e
  } finally {
    if (wall) clearTimeout(wall)
    opts.signal?.removeEventListener('abort', onCallerAbort)
  }
  return planned
}

export { readData, type DataFormatSpec, coerceRows } from './data-format.js'
export { dataFormatRegistry } from './registry.js'
