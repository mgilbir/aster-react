// @vitest-environment jsdom
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { AsterUrlError } from '@aster-charts/core'
import { loadSpecData, loadSpecDataResource, useChartData, type UseChartResult } from './useChart'
import { forEachVariant } from './testing/variants'

const specOf = (url: string): never => ({
  width: 50, height: 50, padding: 0, autosize: 'none',
  data: [{ name: 't', url, format: { type: 'csv' } }],
  marks: [],
}) as never

const csv = (text = 'x,y\n1,2\n'): typeof fetch =>
  vi.fn(async () => ({ ok: true, status: 200, headers: new Headers(), body: null, text: async () => text, arrayBuffer: async () => new TextEncoder().encode(text).buffer })) as unknown as typeof fetch

/** An explicit URL policy, which every network load needs (one function, so the Suspense resource key is stable). */
const ANY = (): boolean => true

const rowsOf = (s: Record<string, unknown>): unknown[] => ((s.data as Array<{ values?: unknown[] }>)[0]!.values ?? [])

describe('loader options are forwarded', () => {
  it('a relative url needs baseURL, and baseURL resolves it', async () => {
    const fetchImpl = csv()
    await expect(loadSpecData(specOf('data.csv'), { fetch: fetchImpl })).rejects.toBeInstanceOf(AsterUrlError)
    expect(fetchImpl).not.toHaveBeenCalled()
    const loaded = await loadSpecData(specOf('data.csv'), { fetch: fetchImpl, baseURL: 'https://data.example.com/v1/' })
    expect(rowsOf(loaded as never)).toHaveLength(1)
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0].toString()).toBe('https://data.example.com/v1/data.csv')
  })

  it('allow vetoes before any request; protocols and allowPrivateNetwork are honoured', async () => {
    const fetchImpl = csv()
    await expect(loadSpecData(specOf('https://evil.example.com/x.csv'), { fetch: fetchImpl, allow: (u) => u.host === 'good.example.com' })).rejects.toBeInstanceOf(AsterUrlError)
    await expect(loadSpecData(specOf('http://localhost:8080/x.csv'), { fetch: fetchImpl })).rejects.toBeInstanceOf(AsterUrlError)
    await expect(loadSpecData(specOf('http://localhost:8080/x.csv'), { fetch: fetchImpl, allowPrivateNetwork: true })).rejects.toThrow(/explicit URL policy/)
    await expect(loadSpecData(specOf('http://localhost:8080/x.csv'), { fetch: fetchImpl, allowPrivateNetwork: true, allow: ANY })).resolves.toBeDefined()
    // a public url needs the policy too
    await expect(loadSpecData(specOf('https://good.example.com/x.csv'), { fetch: fetchImpl })).rejects.toThrow(/explicit URL policy/)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    await expect(loadSpecData(specOf('data:text/csv,x%0A1'), { fetch: fetchImpl })).rejects.toBeInstanceOf(AsterUrlError)
    await expect(loadSpecData(specOf('data:text/csv,x%0A1'), { fetch: fetchImpl, protocols: ['data:'] })).resolves.toBeDefined()
  })

  it('maxBytes and limits reach the loader', async () => {
    const big = csv('x,y\n' + '1,2\n'.repeat(500))
    await expect(loadSpecData(specOf('https://good.example.com/x.csv'), { fetch: big, allow: ANY, maxBytes: 100 })).rejects.toMatchObject({ code: 'ASTER_LIMIT' })
    await expect(loadSpecData(specOf('https://good.example.com/x.csv'), { fetch: big, allow: ANY, limits: { maxRows: 10 } })).rejects.toMatchObject({ code: 'ASTER_LIMIT' })
  })

  it('the Suspense resource is keyed on the options: same options share a promise, different ones do not', async () => {
    const spec = specOf('https://good.example.com/x.csv')
    const f = csv()
    const a = loadSpecDataResource(spec, { fetch: f, allow: ANY, timeoutMs: 5000 })
    expect(loadSpecDataResource(spec, { fetch: f, allow: ANY, timeoutMs: 5000 })).toBe(a)
    const b = loadSpecDataResource(spec, { fetch: f, allow: ANY, timeoutMs: 6000 })
    expect(b).not.toBe(a)
    // (C50: a function option is read through a latest-ref, so an inline arrow re-created by each render is the same option;
    // what used to be asserted here -- a new identity is a new load -- is what made a suspended component reload forever.
    // Functions with different code are still different loads, and `cacheKey` separates closures of the same code.)
    const allow = (): boolean => true
    const withAllow = loadSpecDataResource(spec, { fetch: f, allow })
    expect(loadSpecDataResource(spec, { fetch: f, allow: (): boolean => true })).toBe(withAllow)
    expect(loadSpecDataResource(spec, { fetch: f, allow: (): boolean => false })).not.toBe(withAllow)
    expect(loadSpecDataResource(spec, { fetch: f, allow, cacheKey: 'other' })).not.toBe(withAllow)
    await Promise.allSettled([a, b, withAllow])
  })

  let variantRun = 0
  forEachVariant(['svg'], (Chart) => {
    it('useChartData splits loader options from chart options', async () => {
      // (each variant loads its own url: the Suspense cache is module-wide, so equal inputs would share one load)
      const file = `data-${++variantRun}.csv`
      const fetchImpl = csv()
      let result: UseChartResult | null = null
      function Chart(): React.ReactElement {
        result = useChartData(specOf(file), { fetch: fetchImpl, baseURL: 'https://data.example.com/', limits: { maxRows: 100 }, width: 50, height: 50 })
        return <div />
      }
      const host = document.createElement('div')
      document.body.appendChild(host)
      const root = createRoot(host)
      await act(async () => { root.render(<React.Suspense fallback={null}><Chart /></React.Suspense>) })
      await act(async () => { for (let i = 0; i < 100 && !result; i++) await new Promise((r) => setTimeout(r, 10)) })
      expect(result!.error).toBeNull()
      expect(result!.svg).toContain('<svg')
      expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0].toString()).toBe(`https://data.example.com/${file}`)
      act(() => { root.unmount() })
    })

    it('useChartData loads a {signal} url for the host\'s signal value, and again when it changes (C531)', async () => {
      const fetchImpl = csv()
      // (each variant its own urls: the Suspense cache is module-wide, so equal inputs would share one load)
      const dir = `https://data.example.com/v${++variantRun}/`
      const spec = {
        width: 50, height: 50, padding: 0, autosize: 'none',
        signals: [{ name: 'file', value: 'spec.csv' }],
        data: [{ name: 't', url: { signal: `'${dir}' + file` }, format: { type: 'csv' } }],
        marks: [],
      } as never
      let result: UseChartResult | null = null
      function Chart({ file }: { file: string }): React.ReactElement {
        result = useChartData(spec, { fetch: fetchImpl, allow: ANY, signals: { file }, width: 50, height: 50 })
        return <div />
      }
      const host = document.createElement('div')
      document.body.appendChild(host)
      const root = createRoot(host)
      const urls = (): string[] => (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]))
      for (const file of ['a.csv', 'b.csv']) {
        result = null
        await act(async () => { root.render(<React.Suspense fallback={null}><Chart file={file} /></React.Suspense>) })
        await act(async () => { for (let i = 0; i < 100 && !result; i++) await new Promise((r) => setTimeout(r, 10)) })
        expect(result!.error).toBeNull()
      }
      expect(urls()).toEqual([`${dir}a.csv`, `${dir}b.csv`])
      act(() => { root.unmount() })
    })
  })
})

afterEach(() => { document.body.innerHTML = '' })
