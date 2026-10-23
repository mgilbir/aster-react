import { describe, it, expect, vi, afterEach } from 'vitest'
import { loadSpecDataResource } from './useChart'

describe('Vega-Lite registry is shared across package copies (C92)', () => {
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

describe('useSpecData does not cache a failure forever (C92)', () => {
  const spec = { data: [{ name: 't', url: 'https://example.test/d.csv', format: { type: 'csv' } }], marks: [] } as never

  it('a rejected load is retried on the next request', async () => {
    let calls = 0
    const fetchImpl = (async () => {
      calls++
      if (calls === 1) throw new Error('network down')
      return { ok: true, status: 200, text: async () => 'x,y\n1,2\n' }
    }) as unknown as typeof fetch
    const first = loadSpecDataResource(spec, { fetch: fetchImpl })
    await expect(first).rejects.toThrow(/network down/)
    // While the failure is the current result, the same promise is returned (Suspense needs a stable thenable)...
    await Promise.resolve()
    // ...but once it settled as rejected a new request retries.
    const second = loadSpecDataResource(spec, { fetch: fetchImpl })
    expect(second).not.toBe(first)
    await expect(second).resolves.toBeDefined()
    // A successful load stays cached.
    expect(loadSpecDataResource(spec, { fetch: fetchImpl })).toBe(second)
    expect(calls).toBe(2)
  })
})
