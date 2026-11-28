import { describe, it, expect, vi, afterEach } from 'vitest'
import { loadSpecDataResource, resetSpecDataErrors } from './useChart'

describe('Vega-Lite registry is shared across package copies', () => {
  afterEach(async () => {
    const reg = await import('./vl-registry')
    reg.resetVegaLiteCompiler()
  })

  it('a compiler registered through one copy is visible to another copy', async () => {
    vi.resetModules()
    const copyA = await import('./vl-registry')
    vi.resetModules()
    const copyB = await import('./vl-registry')
    expect(copyA).not.toBe(copyB) // two evaluated copies of the module
    copyA.resetVegaLiteCompiler()
    expect(copyB.hasVegaLiteCompiler()).toBe(false)
    copyA.registerVegaLiteCompiler((spec) => ({ ...spec, compiledBy: 'A' }))
    expect(copyB.hasVegaLiteCompiler()).toBe(true)
    expect(copyB.compileVegaLite({})).toEqual({ compiledBy: 'A' })
    copyB.resetVegaLiteCompiler()
    expect(copyA.hasVegaLiteCompiler()).toBe(false)
  })
})

describe('useSpecData does not cache a failure forever', () => {
  /** The URL policy every network load needs (one function, so the resource key is stable). */
  const allow = (u: URL): boolean => u.origin === 'https://example.com'
  const spec = { data: [{ name: 't', url: 'https://example.com/d.csv', format: { type: 'csv' } }], marks: [] } as never

  // (DECISIONS Q19: a rejected load surfaces once and is retried after the error boundary's reset or an input change, never by
  // itself; the old contract -- "the next request retries" -- is what made a suspended component refetch forever, C48)
  it('a rejected load is retried after resetSpecDataErrors()', async () => {
    let calls = 0
    const fetchImpl = (async () => {
      calls++
      if (calls === 1) throw new Error('network down')
      return { ok: true, status: 200, text: async () => 'x,y\n1,2\n' }
    }) as unknown as typeof fetch
    const first = loadSpecDataResource(spec, { fetch: fetchImpl, allow })
    await expect(first).rejects.toThrow(/network down/)
    // While the failure is the current result, the same promise is returned (Suspense needs a stable thenable)...
    await Promise.resolve()
    expect(loadSpecDataResource(spec, { fetch: fetchImpl, allow })).toBe(first)
    // ...and after a reset a new request retries.
    resetSpecDataErrors()
    const second = loadSpecDataResource(spec, { fetch: fetchImpl, allow })
    expect(second).not.toBe(first)
    await expect(second).resolves.toBeDefined()
    // A successful load stays cached, and a reset leaves it alone.
    expect(loadSpecDataResource(spec, { fetch: fetchImpl, allow })).toBe(second)
    resetSpecDataErrors()
    expect(loadSpecDataResource(spec, { fetch: fetchImpl, allow })).toBe(second)
    expect(calls).toBe(2)
  })
})
