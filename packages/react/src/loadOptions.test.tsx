// @vitest-environment jsdom
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { AsterUrlError } from '@aster/core'
import { loadSpecData, loadSpecDataResource, useChartData, type UseChartResult } from './useChart'

const specOf = (url: string): never => ({
  width: 50, height: 50, padding: 0, autosize: 'none',
  data: [{ name: 't', url, format: { type: 'csv' } }],
  marks: [],
}) as never

const csv = (text = 'x,y\n1,2\n'): typeof fetch =>
  vi.fn(async () => ({ ok: true, status: 200, headers: new Headers(), body: null, text: async () => text, arrayBuffer: async () => new TextEncoder().encode(text).buffer })) as unknown as typeof fetch

const rowsOf = (s: Record<string, unknown>): unknown[] => ((s.data as Array<{ values?: unknown[] }>)[0]!.values ?? [])

describe('loader options are forwarded (C93 / LoadOptions)', () => {
  it('a relative url needs baseURL, and baseURL resolves it', async () => {
    const fetchImpl = csv()
    await expect(loadSpecData(specOf('data.csv'), { fetch: fetchImpl })).rejects.toBeInstanceOf(AsterUrlError)
    expect(fetchImpl).not.toHaveBeenCalled()
    const loaded = await loadSpecData(specOf('data.csv'), { fetch: fetchImpl, baseURL: 'https://data.example/v1/' })
    expect(rowsOf(loaded as never)).toHaveLength(1)
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0].toString()).toBe('https://data.example/v1/data.csv')
  })

  it('allow vetoes before any request; protocols and allowPrivateNetwork are honoured', async () => {
    const fetchImpl = csv()
    await expect(loadSpecData(specOf('https://evil.example/x.csv'), { fetch: fetchImpl, allow: (u) => u.host === 'good.example' })).rejects.toBeInstanceOf(AsterUrlError)
    await expect(loadSpecData(specOf('http://localhost:8080/x.csv'), { fetch: fetchImpl })).rejects.toBeInstanceOf(AsterUrlError)
    await expect(loadSpecData(specOf('http://localhost:8080/x.csv'), { fetch: fetchImpl, allowPrivateNetwork: true })).resolves.toBeDefined()
    await expect(loadSpecData(specOf('data:text/csv,x%0A1'), { fetch: fetchImpl })).rejects.toBeInstanceOf(AsterUrlError)
    await expect(loadSpecData(specOf('data:text/csv,x%0A1'), { fetch: fetchImpl, protocols: ['data:'] })).resolves.toBeDefined()
  })

  it('maxBytes and limits reach the loader', async () => {
    const big = csv('x,y\n' + '1,2\n'.repeat(500))
    await expect(loadSpecData(specOf('https://good.example/x.csv'), { fetch: big, maxBytes: 100 })).rejects.toThrow()
    await expect(loadSpecData(specOf('https://good.example/x.csv'), { fetch: big, limits: { maxRows: 10 } })).rejects.toMatchObject({ code: 'ASTER_LIMIT' })
  })

  it('the Suspense resource is keyed on the options: same options share a promise, different ones do not', async () => {
    const spec = specOf('https://good.example/x.csv')
    const f = csv()
    const a = loadSpecDataResource(spec, { fetch: f, timeoutMs: 5000 })
    expect(loadSpecDataResource(spec, { fetch: f, timeoutMs: 5000 })).toBe(a)
    const b = loadSpecDataResource(spec, { fetch: f, timeoutMs: 6000 })
    expect(b).not.toBe(a)
    const allow = (): boolean => true
    expect(loadSpecDataResource(spec, { fetch: f, allow })).not.toBe(loadSpecDataResource(spec, { fetch: f, allow: () => true }))
    await Promise.all([a, b])
  })

  it('useChartData splits loader options from chart options', async () => {
    const fetchImpl = csv()
    let result: UseChartResult | null = null
    function Chart(): React.ReactElement {
      result = useChartData(specOf('data.csv'), { fetch: fetchImpl, baseURL: 'https://data.example/', limits: { maxRows: 100 }, width: 50, height: 50 })
      return <div />
    }
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => { root.render(<React.Suspense fallback={null}><Chart /></React.Suspense>) })
    await act(async () => { for (let i = 0; i < 100 && !result; i++) await new Promise((r) => setTimeout(r, 10)) })
    expect(result!.error).toBeNull()
    expect(result!.svg).toContain('<svg')
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0].toString()).toBe('https://data.example/data.csv')
    act(() => { root.unmount() })
  })
})

afterEach(() => { document.body.innerHTML = '' })
