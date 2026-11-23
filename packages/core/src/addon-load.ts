/**
 * Opt-in data-loading addon. Importing (or dynamic-importing) this module
 * registers the text-format readers (csv/tsv/dsv via the owned d3-dsv port,
 * topojson via the owned topojson-client port) and provides `loadSpecData`, which resolves every `url`
 * dataset in a spec into inline values:
 *
 *   import { allowOrigins, loadSpecData } from '@aster-charts/core/load'
 *   renderSpec(await loadSpecData(spec, { allow: allowOrigins(['https://data.example.com']) }))
 *
 * Inline JSON values and `format.parse` type coercion work without the addon
 * (vega-loader-identical semantics ship in the core); csv/tsv/dsv/topojson
 * strings and URL datasets need it.
 */
import type { HostAbortSignal, HostFetch, HostUrl } from './host-types.js'
import { dsvFormat } from './dsv.js'
import { feature as topoFeature, mesh as topoMesh, type MeshFilter } from './topojson.js'
import { dataFormatRegistry } from './registry.js'
import { readData, type DataFormatSpec } from './data-format.js'
import type { VgSpec } from './types.js'
import { dataInputOf, specList } from './spec-structure.js'
import { compileExpr, type ExpressionRuntime } from './expression.js'
import { parseExpression } from './expr-parser.js'
import { AsterLimitError, assertSpecDepth, checkRowCount, withLimits, type SpecLimits } from './limits.js'
import { AsterUrlError, DEFAULT_LOAD_PROTOCOLS, checkBasicUrl, type UrlPolicyBase } from './url-policy.js'
import { isNonPublicHost } from './load-host.js'

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

/** vega-loader's mesh filters: `interior` keeps the arcs two different shapes share, `exterior` the arcs of one shape only. */
const MESH_FILTERS: Readonly<Record<string, MeshFilter>> = {
  interior: (a, b) => a !== b,
  exterior: (a, b) => a === b,
}

dataFormatRegistry.set('topojson', (data, format) => {
  // The input is the topology (or an array holding it), read as JSON with the format's `property` path. `parse` is not applied
  // here: readData applies it to the decoded features, as vega-loader's `read` does.
  const json = dataFormatRegistry.get('json')!
  const [topo] = json(Array.isArray(data) ? (data as unknown[])[0] : data, { property: format.property }) as unknown as [Record<string, unknown>]
  if (!topo || (topo as Record<string, unknown>).type !== 'Topology') {
    throw new Error('[aster] topojson data must be a Topology object')
  }
  // `format.feature` / `format.mesh` name an object of the topology: look it up
  // by OWN property (topojson.ts rejects `constructor`, `__proto__`, ...), and
  // the decoded coordinates are metered against the limits in scope.
  if (format.feature) {
    // a GeometryCollection decodes to a FeatureCollection (its features are the rows); any other object to one Feature
    const decoded = topoFeature(topo as never, String(format.feature)) as { features?: unknown[] }
    return (decoded.features ?? [decoded]) as Record<string, unknown>[]
  }
  if (format.mesh) {
    // (a filter name vega-loader does not know is no filter, as there)
    const filter = typeof format.filter === 'string' && Object.hasOwn(MESH_FILTERS, format.filter) ? MESH_FILTERS[format.filter] : undefined
    // the row is the MultiLineString geometry itself
    return [topoMesh(topo as never, String(format.mesh), filter)] as unknown as Record<string, unknown>[]
  }
  throw new Error('[aster] topojson format requires "feature" or "mesh"')
})

// ---------------------------------------------------------------------------
// URL loading with a policy
// ---------------------------------------------------------------------------

/** Typed loader failure that is not a budget: the URL policy refused a request, or the response was unusable. */
export { AsterUrlError } from './url-policy.js'

/** Options for {@link loadSpecData}. Every default is the safe one; see docs/LIMITS.md. */
export interface LoadOptions {
  /** Fetch implementation. Defaults to `globalThis.fetch`. It must honour `redirect: 'manual'` (see docs/LIMITS.md). */
  fetch?: HostFetch
  /**
   * Base for relative `url`s (the origin of your data service, or
   * `location.href` in a browser). Without it a relative url is an error. When no
   * `allow` is given, a url on the base's own origin is permitted (the base is the host's
   * choice) and every other network url is refused; with `allow`, the hook decides every url.
   * The base's own origin is exempt from the private-network check.
   */
  baseURL?: string
  /** Allowed protocols, with the trailing colon. Default `['http:', 'https:']`; add `'data:'` to permit data URLs. */
  protocols?: readonly string[]
  /**
   * The URL policy: consulted for the initial URL and again for every redirect hop, BEFORE it is requested;
   * it must return exactly `true` to permit. Required for any network url that is not on the `baseURL`'s
   * origin: without it such a url is refused. {@link allowOrigins} makes an origin allowlist.
   */
  allow?: (url: HostUrl) => boolean | Promise<boolean>
  /**
   * Permit loopback, private, link-local and other non-public hosts (by the
   * host literal in the URL). Default false. Does not apply to the baseURL's
   * own origin. It cannot see DNS: a public name that resolves to a private
   * address is only stopped by `allow` or by network egress rules.
   */
  allowPrivateNetwork?: boolean
  /** Abort the whole load. */
  signal?: HostAbortSignal
  /** Per-request timeout in milliseconds, covering headers AND body. Default 10 000. */
  timeoutMs?: number
  /** Largest response body, in bytes, enforced while the stream is read. Default 10 485 760. */
  maxBytes?: number
  /** Bytes read into datasets in one call, summed over every dataset (one that names a url another one loaded counts again). Default 52 428 800. */
  maxTotalBytes?: number
  /** HTTP requests one call makes, redirect hops included (several datasets naming one url make one request). Default 100. */
  maxRequests?: number
  /** Requests in flight at once. Default 4. */
  maxConcurrent?: number
  /** Redirect hops followed per request (each vetted by the whole policy before it is requested). Default 5. */
  maxRedirects?: number
  /**
   * The values the host sets on the spec's top-level signals (as `RuntimeInput.signals`): a `{signal}` url reads them
   * instead of the spec's own initial values.
   */
  signals?: Readonly<Record<string, unknown>>
  /**
   * Budgets applied to what is loaded: `maxRows` per loaded dataset,
   * `maxGeneratedRows`/`maxRows` over decoded topojson coordinates, every budget over
   * the `{signal}` url expressions it evaluates, and `maxTimeMs` over the whole call.
   */
  limits?: SpecLimits
}

/** Defaults, exported so docs and tests can state them. */
export const LOAD_DEFAULTS = {
  timeoutMs: 10_000,
  maxBytes: 10 * 1024 * 1024,
  maxTotalBytes: 50 * 1024 * 1024,
  maxRequests: 100,
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

/**
 * An `allow` policy that permits exactly the given origins (`'https://data.example.com'`; a full URL stands for its
 * origin). Throws a TypeError for an entry that has no origin (a relative url, `data:`, `file:`).
 */
export function allowOrigins(origins: Iterable<string>): (url: URL) => boolean {
  const allowed = new Set<string>()
  for (const entry of origins as Iterable<unknown>) {
    let origin = 'null'
    if (typeof entry === 'string') {
      try { origin = new URL(entry).origin } catch { /* reported below */ }
    }
    if (origin === 'null') throw new TypeError(`[aster] allowOrigins: ${JSON.stringify(entry)} is not an absolute URL with an origin (e.g. "https://data.example.com")`)
    allowed.add(origin)
  }
  return (url: URL) => allowed.has(url.origin)
}

// --- host classification -----------------------------------------------------

export { isNonPublicHost } from './load-host.js'

// --- options ------------------------------------------------------------------

/** The largest delay a timer takes (a longer one fires at once). */
const MAX_TIMER_MS = 2_147_483_647

function invalidOption(name: string, expected: string, value: unknown): TypeError {
  let shown: string
  try { shown = typeof value === 'function' ? 'a function' : typeof value === 'bigint' ? `${value}n` : JSON.stringify(value) ?? String(value) } catch { shown = String(value) }
  return new TypeError(`[aster] loadSpecData: ${name} must be ${expected}, got ${shown}`)
}

/** An integer option in [min, max], or its default when undefined. */
function integerOption(opts: LoadOptions, name: keyof typeof LOAD_DEFAULTS, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const v = opts[name]
  if (v === undefined) return LOAD_DEFAULTS[name]
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    throw invalidOption(name, `an integer from ${min} to ${max === Number.MAX_SAFE_INTEGER ? 'Number.MAX_SAFE_INTEGER' : max}`, v)
  }
  return v
}

const isFunction = (v: unknown): boolean => typeof v === 'function'
const isAbortSignal = (v: unknown): v is AbortSignal =>
  v !== null && typeof v === 'object' && typeof (v as AbortSignal).aborted === 'boolean' && typeof (v as AbortSignal).addEventListener === 'function'

interface Budget {
  requests: number
  bytes: number
}

interface ResolvedOptions {
  fetchImpl: typeof globalThis['fetch']
  policy: UrlPolicyBase
  allow?: LoadOptions['allow']
  allowPrivateNetwork: boolean
  baseOrigin: string | null
  timeoutMs: number
  maxBytes: number
  maxTotalBytes: number
  maxRequests: number
  maxRedirects: number
  maxConcurrent: number
  signals: Readonly<Record<string, unknown>> | undefined
  limits: SpecLimits | undefined
}

/** Check every option once, before anything is planned or requested: a wrong value is a TypeError, never a disabled cap. */
function resolveOptions(opts: unknown): ResolvedOptions & { signal: AbortSignal | undefined } {
  if (opts === null || typeof opts !== 'object') throw invalidOption('options', 'an object', opts)
  const o = opts as LoadOptions
  if (o.fetch !== undefined && !isFunction(o.fetch)) throw invalidOption('fetch', 'a function', o.fetch)
  if (o.allow !== undefined && !isFunction(o.allow)) throw invalidOption('allow', 'a function', o.allow)
  if (o.allowPrivateNetwork !== undefined && typeof o.allowPrivateNetwork !== 'boolean') throw invalidOption('allowPrivateNetwork', 'a boolean', o.allowPrivateNetwork)
  if (o.signal !== undefined && !isAbortSignal(o.signal)) throw invalidOption('signal', 'an AbortSignal', o.signal)
  if (o.protocols !== undefined && (!Array.isArray(o.protocols) || !o.protocols.every((p) => typeof p === 'string' && /^[a-z][a-z0-9+.-]*:$/.test(p)))) {
    throw invalidOption('protocols', 'an array of lower-case protocols with their trailing colon (["https:"])', o.protocols)
  }
  if (o.signals !== undefined && (o.signals === null || typeof o.signals !== 'object' || Array.isArray(o.signals))) throw invalidOption('signals', 'an object of signal values', o.signals)
  if (o.limits !== undefined && (o.limits === null || typeof o.limits !== 'object')) throw invalidOption('limits', 'an object', o.limits)
  let baseOrigin: string | null = null
  if (o.baseURL !== undefined) {
    if (typeof o.baseURL !== 'string') throw invalidOption('baseURL', 'a string', o.baseURL)
    try {
      baseOrigin = new URL(o.baseURL).origin
    } catch {
      throw new AsterUrlError(o.baseURL, 'baseURL is not a valid absolute URL')
    }
  }
  // bound: a browser's fetch throws "Illegal invocation" when called as a method of another object
  const fetchImpl = o.fetch ?? (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined)
  if (!fetchImpl) throw new Error('[aster] no fetch implementation available; pass one via loadSpecData(spec, { fetch })')
  return {
    fetchImpl,
    policy: { ...(o.baseURL !== undefined ? { baseURL: o.baseURL } : {}), ...(o.protocols ? { protocols: o.protocols } : {}) },
    ...(o.allow ? { allow: o.allow } : {}),
    allowPrivateNetwork: o.allowPrivateNetwork === true,
    baseOrigin,
    timeoutMs: integerOption(o, 'timeoutMs', 1, MAX_TIMER_MS),
    maxBytes: integerOption(o, 'maxBytes', 0),
    maxTotalBytes: integerOption(o, 'maxTotalBytes', 0),
    maxRequests: integerOption(o, 'maxRequests', 1),
    maxConcurrent: integerOption(o, 'maxConcurrent', 1),
    maxRedirects: integerOption(o, 'maxRedirects', 0),
    signals: o.signals,
    limits: o.limits,
    signal: o.signal,
  }
}

// --- aborting -------------------------------------------------------------------

/**
 * `p`, unless `signal` aborts first: then the abort's reason. A value that arrives after the abort is never taken, so a
 * `fetch`, an `allow` hook or a body that ignores the signal cannot outlive the timeout, the deadline or the caller's abort.
 */
function untilAborted<T>(p: T | PromiseLike<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    // (the abandoned promise may still settle: observed, so a rejection is not reported as unhandled)
    Promise.resolve(p).then(undefined, () => undefined)
    return Promise.reject(signal.reason)
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    Promise.resolve(p).then(
      (v) => { signal.removeEventListener('abort', onAbort); if (signal.aborted) reject(signal.reason); else resolve(v) },
      (e: unknown) => { signal.removeEventListener('abort', onAbort); reject(signal.aborted ? signal.reason : e) },
    )
  })
}

/** A signal that aborts when either does (AbortSignal.any where the runtime has it; Node 20.0-20.2 does not). */
function eitherSignal(a: AbortSignal, b: AbortSignal): AbortSignal {
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([a, b])
  const both = new AbortController()
  for (const s of [a, b]) {
    if (s.aborted) { both.abort(s.reason); break }
    s.addEventListener('abort', () => both.abort(s.reason), { once: true })
  }
  return both.signal
}

/** Release a body nobody will read, without waiting for it (a body that never settles must not hold the call). */
function discard(res: Response): void {
  try { res.body?.cancel().catch(() => undefined) } catch { /* nothing to release */ }
}

// --- the fetch pipeline -----------------------------------------------------

class Semaphore {
  private waiting: Array<() => void> = []
  private active = 0
  constructor(private readonly max: number) {}
  async run<T>(fn: () => Promise<T>, signal: AbortSignal): Promise<T> {
    // A finishing task hands its slot straight to the next waiter (active stays
    // constant), so a caller arriving in between cannot exceed the cap.
    if (this.active < this.max) this.active++
    else {
      const turn = new Promise<void>((resolve) => this.waiting.push(resolve))
      try {
        await untilAborted(turn, signal)
      } catch (e) {
        // an aborted waiter keeps its place in the queue, and hands the slot on as soon as it is given it
        void turn.then(() => this.release())
        throw e
      }
    }
    try {
      return await fn()
    } finally {
      this.release()
    }
  }
  private release(): void {
    const next = this.waiting.shift()
    if (next) next()
    else this.active--
  }
}

/** Why a network url without an explicit policy is refused. */
const NO_POLICY = 'loadSpecData needs an explicit URL policy for network urls: pass `allow` (an allowlist, e.g. allowOrigins(["https://data.example.com"])), or a `baseURL` whose origin the url is on'

/** Run the policy on one URL (initial or redirect hop), before it is requested. Returns the parsed URL. */
async function vet(raw: string, o: ResolvedOptions, signal: AbortSignal): Promise<URL> {
  const url = checkBasicUrl(raw, o.policy, DEFAULT_LOAD_PROTOCOLS)
  if (!url) throw new AsterUrlError(raw, 'a relative url needs the baseURL option')
  // data: carries its own bytes: nothing to reach, no origin to compare
  const network = url.protocol !== 'data:'
  const onBase = network && o.baseOrigin != null && url.origin === o.baseOrigin
  if (network && !onBase && !o.allowPrivateNetwork && isNonPublicHost(url.hostname)) {
    throw new AsterUrlError(raw, 'the host is loopback, private or otherwise non-public (set allowPrivateNetwork to permit)')
  }
  if (o.allow) {
    if ((await untilAborted(o.allow(url), signal)) !== true) throw new AsterUrlError(raw, 'refused by the allow hook')
  } else if (network && !onBase) {
    throw new AsterUrlError(raw, NO_POLICY)
  }
  return url
}

const REDIRECT = new Set([301, 302, 303, 307, 308])

/**
 * One request, counted against `maxRequests` and raced against the abort. A fetch from another realm (jsdom's
 * AbortController against Node's fetch) rejects a foreign signal with a TypeError; then the request goes without it (the
 * race still ends the call at the abort; the socket may outlive it in that case).
 */
async function request(href: string, o: ResolvedOptions, budget: Budget, signal: AbortSignal): Promise<Response> {
  if (++budget.requests > o.maxRequests) throw new AsterLimitError(`maxRequests ${budget.requests} > ${o.maxRequests} (${shortUrl(href)})`)
  try {
    return await untilAborted(o.fetchImpl(href, { signal, redirect: 'manual' }), signal)
  } catch (e) {
    if (signal.aborted || !(e instanceof TypeError) || !/signal/i.test(e.message)) throw e
    return untilAborted(o.fetchImpl(href, { redirect: 'manual' }), signal)
  }
}

const shortUrl = (url: string): string => (url.length > 120 ? url.slice(0, 120) + '...' : url)

function timeoutError(url: string, ms: number): AsterLimitError {
  return new AsterLimitError(`timeoutMs ${ms} exceeded loading ${shortUrl(url)}`)
}

interface Body { text: string; bytes: number }

async function readBounded(res: Response, url: string, o: ResolvedOptions, signal: AbortSignal): Promise<Body> {
  const declared = Number(res.headers?.get?.('content-length'))
  if (Number.isFinite(declared) && declared > o.maxBytes) {
    discard(res)
    throw new AsterLimitError(`maxBytes ${declared} > ${o.maxBytes} (content-length of ${url})`)
  }
  const reader = res.body?.getReader?.()
  if (!reader) {
    // Not a streaming Response (a minimal fetch shim): the size can only be
    // checked once the text exists; the caller's `fetch` owns bounding it.
    const text = await untilAborted(res.text(), signal)
    const bytes = new TextEncoder().encode(text).byteLength
    if (bytes > o.maxBytes) throw new AsterLimitError(`maxBytes ${bytes} > ${o.maxBytes} (${url})`)
    return { text, bytes }
  }
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await untilAborted(reader.read(), signal)
      if (done) break
      total += value.byteLength
      if (total > o.maxBytes) throw new AsterLimitError(`maxBytes ${total} > ${o.maxBytes} (reading ${url})`)
      chunks.push(value)
    }
  } catch (e) {
    // stop the producer: a stream nobody reads any more
    reader.cancel().catch(() => undefined)
    throw e
  }
  const all = new Uint8Array(total)
  let at = 0
  for (const c of chunks) { all.set(c, at); at += c.byteLength }
  return { text: new TextDecoder('utf-8').decode(all), bytes: total }
}

/**
 * Fetch one URL under the policy. Every hop is vetted before it is requested, in every environment: a redirect whose
 * target the runtime hides (a browser answers `redirect: 'manual'` with an opaque response) or that the fetch followed on
 * its own cannot have been, and is refused.
 */
async function fetchText(raw: string, o: ResolvedOptions, budget: Budget, sem: Semaphore, overall: AbortSignal): Promise<Body> {
  return sem.run(async () => {
    const own = new AbortController()
    const timer = setTimeout(() => own.abort(timeoutError(raw, o.timeoutMs)), o.timeoutMs)
    const signal = eitherSignal(own.signal, overall)
    try {
      let url = await vet(raw, o, signal)
      for (let hop = 0; ; hop++) {
        const res = await request(url.href, o, budget, signal)
        if (res.type === 'opaqueredirect') {
          throw new AsterUrlError(url.href, 'the response is a redirect whose target this environment hides (a browser), so the next hop cannot be vetted before it is requested; serve the data without a redirect')
        }
        if (REDIRECT.has(res.status)) {
          const location = res.headers?.get?.('location')
          discard(res)
          if (!location) throw new AsterUrlError(url.href, `HTTP ${res.status} redirect without a Location`)
          if (hop >= o.maxRedirects) throw new AsterLimitError(`maxRedirects ${hop + 1} > ${o.maxRedirects} (${shortUrl(raw)})`)
          let next: string
          try {
            next = new URL(location, url).href
          } catch {
            throw new AsterUrlError(location, `the redirect from ${shortUrl(url.href)} has a Location that is not a valid URL`)
          }
          url = await vet(next, o, signal)
          continue
        }
        if (res.redirected) {
          discard(res)
          throw new AsterUrlError(res.url || url.href, 'the fetch followed a redirect on its own, so the hop was not vetted before it was requested (a custom fetch must honour redirect: "manual")')
        }
        if (!res.ok) {
          discard(res)
          throw new Error(`[aster] failed to load dataset url ${raw}: HTTP ${res.status}`)
        }
        return await readBounded(res, raw, o, signal)
      }
    } catch (e) {
      // a timeout or the deadline surfaces as the AsterLimitError carried by the abort reason
      if (signal.aborted) throw signal.reason
      throw e
    } finally {
      clearTimeout(timer)
    }
  }, overall)
}

// --- walking the spec ---------------------------------------------------------

type Json = Record<string, unknown>

interface LoadTask { def: Json; url: string; format: DataFormatSpec | undefined; name: string }

const NO_DATA_RUNTIME: ExpressionRuntime = {
  scale: () => undefined,
  data: () => undefined,
  expr: (e) => compileExpr(e, NO_DATA_RUNTIME),
}

/** The names an expression reads (its free identifiers: not a property name, not a called function's name). */
function namesRead(code: string): string[] {
  const out = new Set<string>()
  const stack: unknown[] = [parseExpression(code)]
  while (stack.length) {
    const n = stack.pop()
    if (n === null || typeof n !== 'object') continue
    if (Array.isArray(n)) { for (const x of n) stack.push(x); continue }
    const node = n as Json
    switch (node.type) {
      case 'Identifier': out.add(node.name as string); break
      case 'MemberExpression': stack.push(node.object); if (node.computed) stack.push(node.property); break
      case 'CallExpression': stack.push(node.arguments); break
      case 'Property': stack.push(node.value); break
      default: for (const k of Object.keys(node)) if (k !== 'type') stack.push(node[k])
    }
  }
  return [...out]
}

/**
 * The signals one scope declares (the view's or a group mark's), and the values worked out so far. A `{signal}` url is
 * evaluated, as vega does when the view starts, over the signals it reads: the closest declaration in its scope or one around
 * it, each from its `value` (or the host's, for a top-level signal) or its `init` / `update` expression over the signals that
 * one reads in turn. Only what the url reads is evaluated.
 */
class SignalScope {
  private readonly defs = new Map<string, Json>()
  private readonly values = new Map<string, unknown>()
  private readonly pending = new Set<string>()
  /** The view's numeric `width` / `height` (vega's view signals of those names). */
  readonly viewSize = new Map<string, unknown>()

  constructor(readonly parent: SignalScope | null, signals: unknown, private readonly host?: Readonly<Record<string, unknown>>) {
    for (const def of specList(signals)) {
      if (def && typeof def === 'object' && typeof (def as Json).name === 'string') this.defs.set((def as Json).name as string, def as Json)
    }
  }

  /** The value of `name` as seen from this scope (undefined when no scope declares it). */
  value(name: string): unknown {
    for (let s: SignalScope | null = this; s; s = s.parent) if (s.declares(name)) return s.own(name)
    return undefined
  }

  private declares(name: string): boolean {
    return this.defs.has(name) || this.viewSize.has(name) || (this.host !== undefined && Object.hasOwn(this.host, name))
  }

  private own(name: string): unknown {
    if (this.host !== undefined && Object.hasOwn(this.host, name)) return this.host[name]
    if (this.values.has(name)) return this.values.get(name)
    const def = this.defs.get(name)
    if (!def) return this.viewSize.get(name)
    // (a definition that reads itself, directly or through others, has no value yet: undefined, as an unset signal)
    if (this.pending.has(name)) return undefined
    this.pending.add(name)
    let v: unknown = def.value
    try {
      const expr = typeof def.init === 'string' ? def.init : typeof def.update === 'string' ? def.update : undefined
      if (v === undefined && expr !== undefined) v = this.evaluate(expr)
    } finally {
      this.pending.delete(name)
    }
    this.values.set(name, v)
    return v
  }

  /**
   * An expression over the signals it reads. A budget refusal (the regular-expression screen, the clock) is the call's
   * failure; any other error leaves the value undefined, as a signal that needs data or scales is when the view starts.
   */
  evaluate(expr: string): unknown {
    try {
      const signals: Json = Object.create(null) as Json
      for (const name of namesRead(expr)) signals[name] = this.value(name)
      return compileExpr(expr, NO_DATA_RUNTIME)(undefined, signals)
    } catch (e) {
      if (e instanceof AsterLimitError) throw e
      return undefined
    }
  }
}

/**
 * Copy only the paths of `spec` that hold url datasets (top level AND inside
 * nested group marks, at any depth) and queue one task per dataset. The input is
 * never mutated; untouched branches are shared with it. A `{signal}` url is
 * evaluated in its own scope (see SignalScope).
 */
function planLoads(spec: Json, tasks: LoadTask[], hostSignals: Readonly<Record<string, unknown>> | undefined): Json {
  // a deep or cyclic spec is a typed refusal here, as in every other entry point, never a stack overflow
  assertSpecDepth(spec)
  // (the lists are read as the compiler reads them, vega-util `array()`: a single object is a one-element list, and a list made
  // of one is returned as an array when something in it changed)
  const visitData = (list: unknown, scope: SignalScope): unknown => {
    if (list == null) return list
    let changed = false
    const out = specList(list).map((d) => {
      const def = d as Json | null
      // (a dataset vega loads from its url: no values, a url; see dataInputOf)
      if (def && typeof def === 'object' && dataInputOf(def) === 'url') {
        // vega loads a `{signal}` url dynamically (a Load operator re-run when the signal changes); a static spec
        // is loaded for the value the signal has when the view starts
        const expr = typeof def.url === 'object' && def.url !== null ? (def.url as Json).signal : undefined
        const url = typeof def.url === 'string' ? def.url : typeof expr === 'string' ? scope.evaluate(expr) : undefined
        if (typeof url !== 'string') {
          throw new Error(`[aster] dataset "${String(def.name)}": url must be a string (or a {signal} whose initial value is one)`)
        }
        const copy: Json = { ...def }
        tasks.push({ def: copy, url, format: def.format as DataFormatSpec | undefined, name: String(def.name) })
        changed = true
        return copy
      }
      return d
    })
    return changed ? out : list
  }
  const visitMarks = (marks: unknown, outer: SignalScope): unknown => {
    if (marks == null) return marks
    let changed = false
    const out = specList(marks).map((m) => {
      if (!m || typeof m !== 'object') return m
      const mark = m as Json
      // a group mark is a scope: its signals are seen by its own datasets and marks
      const scope = mark.type === 'group' && mark.signals != null ? new SignalScope(outer, mark.signals) : outer
      const data = visitData(mark.data, scope)
      const inner = visitMarks(mark.marks, scope)
      if (data === mark.data && inner === mark.marks) return m
      changed = true
      return { ...mark, ...(data !== mark.data ? { data } : {}), ...(inner !== mark.marks ? { marks: inner } : {}) }
    })
    return changed ? out : marks
  }
  const view = new SignalScope(null, spec.signals, hostSignals)
  for (const k of ['width', 'height'] as const) if (typeof spec[k] === 'number') view.viewSize.set(k, spec[k])
  const data = visitData(spec.data, view)
  const marks = visitMarks(spec.marks, view)
  if (data === spec.data && marks === spec.marks) return spec
  return { ...spec, ...(data !== spec.data ? { data } : {}), ...(marks !== spec.marks ? { marks } : {}) }
}

/**
 * Fetch every `url` dataset in the spec - top level and inside group marks -
 * and inline its values, so the synchronous compile/evaluate/render pipeline
 * can run unchanged. Datasets already carrying `values` are left untouched.
 * Returns a copy of the spec with the loaded paths replaced (the input itself when
 * it has no url dataset); the input is never mutated.
 *
 * The spec is untrusted: every URL passes the policy in {@link LoadOptions}
 * before a request is made, every redirect hop is vetted before it is requested,
 * and the response is bounded in time and bytes. A network url needs an explicit
 * policy: `allow` (an allowlist), or a `baseURL` it is on; non-public hosts are
 * refused unless `allowPrivateNetwork` is set. The format of a url dataset is its
 * `format.type`, json by default, as in vega.
 */
export async function loadSpecData<T extends VgSpec>(spec: T, opts: LoadOptions = {}): Promise<T> {
  const { signal: callerSignal, ...o } = resolveOptions(opts)
  const started = Date.now()
  const maxTime = o.limits?.maxTimeMs
  const timed = typeof maxTime === 'number' && Number.isFinite(maxTime)
  /** The limits for the synchronous work done now: `maxTimeMs` is what is left of the call's budget. */
  const limitsNow = (): SpecLimits | undefined => (timed ? { ...o.limits, maxTimeMs: Math.max(0, maxTime - (Date.now() - started)) } : o.limits)

  const tasks: LoadTask[] = []
  // the `{signal}` url expressions run under the limits, as every other evaluation does
  const planned = withLimits(limitsNow(), () => planLoads(spec as unknown as Json, tasks, o.signals)) as unknown as T
  if (!tasks.length) return spec

  // One signal for the whole call: the caller's, plus the limits' wall clock.
  const overall = new AbortController()
  const wall = timed
    ? setTimeout(() => overall.abort(new AsterLimitError('maxTimeMs exceeded during loadSpecData')), Math.min(MAX_TIMER_MS, Math.max(0, maxTime - (Date.now() - started))))
    : null
  const onCallerAbort = (): void => overall.abort(callerSignal?.reason ?? new DOMException('This operation was aborted', 'AbortError'))
  if (callerSignal?.aborted) onCallerAbort()
  else callerSignal?.addEventListener('abort', onCallerAbort, { once: true })

  const budget: Budget = { requests: 0, bytes: 0 }
  const sem = new Semaphore(o.maxConcurrent)
  // one request per url: datasets naming the same one share it
  const bodies = new Map<string, Promise<Body>>()
  const bodyOf = (url: string): Promise<Body> => {
    let key = url
    try { key = new URL(url, o.policy.baseURL).href } catch { /* refused by the policy */ }
    let p = bodies.get(key)
    if (!p) {
      p = fetchText(url, o, budget, sem, overall.signal)
      p.catch(() => undefined) // (observed by every task that awaits it)
      bodies.set(key, p)
    }
    return p
  }
  try {
    await untilAborted(Promise.all(
      tasks.map(async (task) => {
        const { text, bytes } = await bodyOf(task.url)
        if ((budget.bytes += bytes) > o.maxTotalBytes) throw new AsterLimitError(`maxTotalBytes ${budget.bytes} > ${o.maxTotalBytes} (dataset "${task.name}")`)
        // Parsing runs in the limits scope so the readers, topojson expansion and row counts are metered.
        const rows = withLimits(limitsNow(), () => {
          const parsed = readData(text, { ...task.format, type: task.format?.type || 'json' })
          checkRowCount(parsed.length, `dataset "${task.name}"`)
          return parsed
        })
        // The format is consumed by the load (readData applies type + parse);
        // strip it so the runtime treats the inlined rows as pre-parsed.
        delete task.def.format
        task.def.values = rows
      }),
    ), overall.signal)
  } catch (e) {
    // one failure abandons the rest: cancel in-flight requests
    if (!overall.signal.aborted) overall.abort(e)
    throw e
  } finally {
    if (wall) clearTimeout(wall)
    callerSignal?.removeEventListener('abort', onCallerAbort)
  }
  return planned
}

export { readData, type DataFormatSpec, coerceRows } from './data-format.js'
