// @vitest-environment jsdom
/**
 * `useSpecData` under the React boundary's identity rule (C48, C50; DECISIONS Q19).
 *
 * The load is a Suspense resource, so the cache it is read from must hand the SAME promise to every render that asks for the same
 * load, including the renders of a component that never committed (React keeps no state for it). These tests render the hook the
 * way an app writes it -- every input position as a literal rebuilt by every render, the parent re-rendering continuously -- and
 * count the fetches. They run on React's real scheduler (no `act`): `act` holds React's retries in its own queue, which hides the
 * loops these tests exist to catch.
 *
 * - Every option slot, inline and hoisted, crossed with an inline or hoisted spec: one fetch, then the data.
 * - A rejected load: one fetch, the error boundary shows it, and nothing fetches again, whatever re-renders, until an input
 *   changes or the boundary's reset calls `resetSpecDataErrors()`; each of those is one new attempt.
 * - Two components that ask for the same load share it; two with different data options, different `allow` code or different
 *   `cacheKey`s do not, and neither evicts the other.
 */
import * as React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { VgSpec } from '@aster-charts/core'
import { loadSpecDataResource, resetSpecDataErrors, useSpecData, type UseSpecDataOptions } from './useChart'

const ACT = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
let actBefore: boolean | undefined
beforeAll(() => { actBefore = ACT.IS_REACT_ACT_ENVIRONMENT; ACT.IS_REACT_ACT_ENVIRONMENT = false })
afterAll(() => { ACT.IS_REACT_ACT_ENVIRONMENT = actBefore })

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms
  while (!cond() && Date.now() < end) await sleep(5)
}

/** A fetch whose answer the test decides, counting calls. */
function makeFetch(answer: () => 'ok' | 'fail') {
  const state = { calls: 0 }
  const impl = (async () => {
    state.calls++
    await sleep(2)
    return answer() === 'ok'
      ? new Response('[{"x":1},{"x":2}]', { status: 200, headers: { 'content-type': 'application/json' } })
      : new Response('nope', { status: 500 })
  }) as typeof fetch
  return { state, impl }
}

let seq = 0
/** A spec with one url dataset, unique per test (the cache is module-wide). */
function urlSpec(): VgSpec {
  return { width: 50, height: 20, data: [{ name: 't', url: `https://data.example.com/${++seq}.json` }], marks: [] } as VgSpec
}
const deepCopy = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T

class Boundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) { return { error } }
  /** The boundary's reset, as react-error-boundary's `onReset` wires it. */
  reset = (): void => { resetSpecDataErrors(); this.setState({ error: null }) }
  /** A reset that does not tell the cache (the rejection is what the children read again). */
  resetOnly = (): void => this.setState({ error: null })
  override render() {
    return this.state.error ? <p data-testid="err">{this.state.error.message}</p> : this.props.children
  }
}

interface Mounted { root: Root; host: HTMLElement; boundary: React.RefObject<Boundary | null>; stop: () => void }

/** Mount `Child` under a boundary and Suspense, with a parent that re-renders every few ms (as a live app does). */
function mount(Child: () => React.ReactElement): Mounted {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const boundary = React.createRef<Boundary>()
  let tick: (() => void) | null = null
  function Parent(): React.ReactElement {
    const [, set] = React.useState(0)
    tick = () => set((n) => n + 1)
    return <Boundary ref={boundary}><React.Suspense fallback={<p data-testid="loading">loading</p>}><Child /></React.Suspense></Boundary>
  }
  root.render(<Parent />)
  const timer = setInterval(() => tick?.(), 3)
  return { root, host, boundary, stop: () => clearInterval(timer) }
}

const mounted: Mounted[] = []
afterEach(async () => {
  for (const m of mounted.splice(0)) { m.stop(); m.root.unmount() }
  document.body.innerHTML = ''
  await sleep(0)
})

/** The URL policy every network load needs (loadSpecData has no default): one function, so the loads that do not vary it share it. */
const POLICY = (url: URL): boolean => url.hostname === 'data.example.com'

/**
 * Every option of `loadSpecData`, as a literal rebuilt by each call (a new function, array or object with the same content).
 * The record names every key of `UseSpecDataOptions`: a new option is a compile error here until it is covered.
 */
const controller = new AbortController()
const INLINE: { [K in keyof Required<UseSpecDataOptions>]: () => UseSpecDataOptions[K] } = {
  fetch: () => undefined, // (the counting fetch is added by each case, inline or hoisted)
  baseURL: () => 'https://data.example.com/',
  protocols: () => ['https:', 'http:'],
  allow: () => (url: URL) => url.hostname === 'data.example.com',
  allowPrivateNetwork: () => false,
  signal: () => controller.signal, // a stateful object: compared by identity, so the host memoizes it (here: one controller)
  timeoutMs: () => 5000,
  maxBytes: () => 1_000_000,
  maxTotalBytes: () => 5_000_000,
  maxRequests: () => 10,
  maxConcurrent: () => 2,
  maxRedirects: () => 3,
  limits: () => ({ maxRows: 1000 }),
  signals: () => ({ file: 'data.csv' }),
  cacheKey: () => 'user-1',
}
const SLOTS = (Object.keys(INLINE) as Array<keyof UseSpecDataOptions>).filter((k) => k !== 'fetch')

describe('useSpecData: one load per input, whatever literals the render rebuilds (C50)', () => {
  const cases: Array<{ name: string; inlineSpec: boolean; inlineFetch: boolean; slot: keyof UseSpecDataOptions | null }> = []
  for (const inlineSpec of [false, true]) {
    for (const inlineFetch of [false, true]) {
      cases.push({ name: `spec ${inlineSpec ? 'inline' : 'hoisted'}, fetch ${inlineFetch ? 'inline' : 'hoisted'}, no other option`, inlineSpec, inlineFetch, slot: null })
      for (const slot of SLOTS) cases.push({ name: `spec ${inlineSpec ? 'inline' : 'hoisted'}, fetch ${inlineFetch ? 'inline' : 'hoisted'}, inline ${slot}`, inlineSpec, inlineFetch, slot })
    }
  }

  it.each(cases)('$name', async ({ inlineSpec, inlineFetch, slot }) => {
    const spec = urlSpec()
    const f = makeFetch(() => 'ok')
    let rendersWithData = 0
    function Child(): React.ReactElement {
      const options: UseSpecDataOptions = {
        allow: POLICY,
        fetch: inlineFetch ? ((...a: Parameters<typeof fetch>) => f.impl(...a)) as typeof fetch : f.impl,
        ...(slot ? { [slot]: INLINE[slot]() } : {}),
      }
      const loaded = useSpecData(inlineSpec ? deepCopy(spec) : spec, options)
      rendersWithData++
      const rows = (loaded.data as Array<{ values?: unknown[] }>)[0]!.values!
      return <p data-testid="rows">{rows.length}</p>
    }
    const m = mount(Child)
    mounted.push(m)
    await until(() => m.host.querySelector('[data-testid="rows"]') != null)
    // keep re-rendering for a while: nothing may fetch again
    await sleep(120)
    expect(m.host.querySelector('[data-testid="err"]')?.textContent ?? null).toBe(null)
    expect(m.host.querySelector('[data-testid="rows"]')?.textContent).toBe('2')
    expect(rendersWithData).toBeGreaterThan(5)
    expect(f.state.calls).toBe(1)
  })
})

describe('useSpecData: a rejected load surfaces once (C48, DECISIONS Q19)', () => {
  it.each([false, true])('inline spec %s: one fetch, the boundary shows the error and stays; its reset retries once', async (inline) => {
    const spec = urlSpec()
    let answer: 'ok' | 'fail' = 'fail'
    const f = makeFetch(() => answer)
    function Child(): React.ReactElement {
      const loaded = useSpecData(inline ? deepCopy(spec) : spec, { fetch: (...a) => f.impl(...a), allow: () => true })
      return <p data-testid="rows">{(loaded.data as Array<{ values?: unknown[] }>)[0]!.values!.length}</p>
    }
    const m = mount(Child)
    mounted.push(m)
    await until(() => m.host.querySelector('[data-testid="err"]') != null)
    await sleep(150)
    expect(m.host.querySelector('[data-testid="err"]')?.textContent).toMatch(/500/)
    expect(f.state.calls).toBe(1)
    // re-rendering the children without telling the cache reads the same rejection: no fetch
    m.boundary.current!.resetOnly()
    await sleep(150)
    expect(m.host.querySelector('[data-testid="err"]')).not.toBe(null)
    expect(f.state.calls).toBe(1)
    // the boundary's reset is a new attempt: one more fetch, and it fails again
    m.boundary.current!.reset()
    await until(() => f.state.calls >= 2 && m.host.querySelector('[data-testid="err"]') != null)
    await sleep(150)
    expect(f.state.calls).toBe(2)
    expect(m.host.querySelector('[data-testid="err"]')).not.toBe(null)
    // the service recovers; the next reset loads
    answer = 'ok'
    m.boundary.current!.reset()
    await until(() => m.host.querySelector('[data-testid="rows"]') != null)
    await sleep(100)
    expect(f.state.calls).toBe(3)
    expect(m.host.querySelector('[data-testid="rows"]')?.textContent).toBe('2')
  })

  it('a change of input after a failure is a new attempt; the failed input keeps its error until a reset', async () => {
    const spec = urlSpec()
    const f = makeFetch(() => 'fail')
    let timeoutMs = 4000
    function Child(): React.ReactElement {
      const loaded = useSpecData(spec, { allow: POLICY, fetch: f.impl, timeoutMs })
      return <p data-testid="rows">{(loaded.data as unknown[]).length}</p>
    }
    const m = mount(Child)
    mounted.push(m)
    await until(() => m.host.querySelector('[data-testid="err"]') != null)
    await sleep(100)
    expect(f.state.calls).toBe(1)
    timeoutMs = 4001
    m.boundary.current!.resetOnly()
    await until(() => f.state.calls >= 2 && m.host.querySelector('[data-testid="err"]') != null)
    await sleep(100)
    expect(f.state.calls).toBe(2)
    timeoutMs = 4000
    m.boundary.current!.resetOnly()
    await sleep(100)
    expect(m.host.querySelector('[data-testid="err"]')).not.toBe(null)
    expect(f.state.calls).toBe(2)
    m.boundary.current!.reset()
    await until(() => f.state.calls >= 3 && m.host.querySelector('[data-testid="err"]') != null)
    await sleep(100)
    expect(f.state.calls).toBe(3)
  })
})

describe('useSpecData: sharing between components', () => {
  function Two(a: UseSpecDataOptions, b: UseSpecDataOptions, spec: VgSpec): () => React.ReactElement {
    function A(): React.ReactElement { useSpecData(spec, { ...a }); return <i data-testid="a" /> }
    function B(): React.ReactElement { useSpecData(deepCopy(spec), { ...b }); return <i data-testid="b" /> }
    return function Both(): React.ReactElement {
      return <><React.Suspense fallback="a"><A /></React.Suspense><React.Suspense fallback="b"><B /></React.Suspense></>
    }
  }

  it('the same load (equal spec content, equal data options, the same fetch code) is fetched once', async () => {
    const spec = urlSpec()
    const f = makeFetch(() => 'ok')
    const m = mount(Two({ allow: POLICY, fetch: f.impl, timeoutMs: 5000 }, { allow: POLICY, fetch: f.impl, timeoutMs: 5000 }, spec))
    mounted.push(m)
    await until(() => m.host.querySelector('[data-testid="a"]') != null && m.host.querySelector('[data-testid="b"]') != null)
    await sleep(100)
    expect(f.state.calls).toBe(1)
  })

  it('different data options are two loads that settle (neither evicts the other)', async () => {
    const spec = urlSpec()
    const f = makeFetch(() => 'ok')
    const m = mount(Two({ allow: POLICY, fetch: f.impl }, { allow: POLICY, fetch: f.impl, timeoutMs: 5000 }, spec))
    mounted.push(m)
    await until(() => m.host.querySelector('[data-testid="a"]') != null && m.host.querySelector('[data-testid="b"]') != null)
    await sleep(150)
    expect(f.state.calls).toBe(2)
  })

  it('different `allow` code is never shared: each component is loaded under its own veto', async () => {
    const spec = urlSpec()
    const f = makeFetch(() => 'ok')
    const asked: string[] = []
    const m = mount(Two(
      { fetch: f.impl, allow: (u) => { asked.push(`a:${u.hostname}`); return true } },
      { fetch: f.impl, allow: (u) => { asked.push(`b:${u.hostname}`); return u.hostname === 'elsewhere.example.com' } },
      spec,
    ))
    mounted.push(m)
    await until(() => m.host.querySelector('[data-testid="a"]') != null && m.host.querySelector('[data-testid="err"]') != null, 2000)
    await sleep(100)
    // A loaded; B's own veto refused the url, so B's boundary shows the refusal instead of A's rows
    expect(asked.some((s) => s.startsWith('b:'))).toBe(true)
    expect(m.host.querySelector('[data-testid="err"]')?.textContent).toMatch(/allow|denied|refused/i)
  })

  it('closures of one factory are the same option; `cacheKey` keeps their loads apart', async () => {
    const spec = urlSpec()
    const f = makeFetch(() => 'ok')
    const who: string[] = []
    const fetchFor = (user: string): typeof fetch => (...a) => { who.push(user); return f.impl(...a) }
    const shared = mount(Two({ allow: POLICY, fetch: fetchFor('ann') }, { allow: POLICY, fetch: fetchFor('bob') }, spec))
    mounted.push(shared)
    await until(() => shared.host.querySelector('[data-testid="a"]') != null && shared.host.querySelector('[data-testid="b"]') != null)
    await sleep(50)
    expect(f.state.calls).toBe(1)
    const spec2 = urlSpec()
    who.length = 0
    const apart = mount(Two({ allow: POLICY, fetch: fetchFor('ann'), cacheKey: 'ann' }, { allow: POLICY, fetch: fetchFor('bob'), cacheKey: 'bob' }, spec2))
    mounted.push(apart)
    await until(() => apart.host.querySelector('[data-testid="a"]') != null && apart.host.querySelector('[data-testid="b"]') != null)
    await sleep(50)
    expect(who.sort()).toEqual(['ann', 'bob'])
  })

  it('the function called is the latest one given (a function option is read through a latest-ref)', async () => {
    const spec = urlSpec()
    const f = makeFetch(() => 'ok')
    const tags: number[] = []
    let tag = 1
    // `allow` is consulted before the fetch: holding it open lets the test re-render with a new `fetch` closure meanwhile
    let release: (v: boolean) => void = () => {}
    const gate = new Promise<boolean>((r) => { release = r })
    function Child(): React.ReactElement {
      const mine = tag
      const loaded = useSpecData(spec, { allow: () => gate, fetch: (...a) => { tags.push(mine); return f.impl(...a) } })
      return <p data-testid="rows">{(loaded.data as unknown[]).length}</p>
    }
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    mounted.push({ root, host, boundary: React.createRef(), stop: () => {} })
    root.render(<React.Suspense fallback="…"><Child key="c" /></React.Suspense>)
    await sleep(20)
    tag = 2
    root.render(<React.Suspense fallback="…"><Child key="c" /></React.Suspense>)
    await sleep(20)
    release(true)
    await until(() => host.querySelector('[data-testid="rows"]') != null)
    expect(tags).toEqual([2])
  })
})

describe('loadSpecDataResource (the promise useSpecData reads)', () => {
  it('equal content is the same promise; a rejection stays the answer until resetSpecDataErrors()', async () => {
    const spec = urlSpec()
    let calls = 0
    const fetchImpl = (async () => { calls++; return new Response('nope', { status: 500 }) }) as typeof fetch
    const first = loadSpecDataResource(spec, { allow: POLICY, fetch: fetchImpl })
    expect(loadSpecDataResource(deepCopy(spec), { allow: POLICY, fetch: (...a) => fetchImpl(...a) })).not.toBe(first) // different fetch code
    expect(loadSpecDataResource(deepCopy(spec), { allow: POLICY, fetch: fetchImpl })).toBe(first)
    await expect(first).rejects.toThrow(/500/)
    await sleep(20)
    expect(loadSpecDataResource(spec, { allow: POLICY, fetch: fetchImpl })).toBe(first)
    expect(resetSpecDataErrors()).toBeGreaterThanOrEqual(1)
    const second = loadSpecDataResource(spec, { allow: POLICY, fetch: fetchImpl })
    expect(second).not.toBe(first)
    await expect(second).rejects.toThrow(/500/)
    expect(calls).toBe(3)
  })
})
