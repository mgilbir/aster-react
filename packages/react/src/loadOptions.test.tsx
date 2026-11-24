// @vitest-environment jsdom
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { AsterUrlError } from '@aster-charts/core'
import { loadSpecData, loadSpecDataResource, useChartData, type UseChartResult } from './useChart'

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
    // (functions are keyed by identity -- DECISIONS, later decisions: useSpecData function options -- and only a `cacheKey`
    // shares a load across identities, with the latest function called)
    const allow = (): boolean => true
    const withAllow = loadSpecDataResource(spec, { fetch: f, allow })
    expect(loadSpecDataResource(spec, { fetch: f, allow })).toBe(withAllow)
    const other = loadSpecDataResource(spec, { fetch: f, allow: (): boolean => true })
    expect(other).not.toBe(withAllow)
    const named = loadSpecDataResource(spec, { fetch: f, allow, cacheKey: 'one' })
    expect(named).not.toBe(withAllow)
    expect(loadSpecDataResource(spec, { fetch: f, allow: (): boolean => true, cacheKey: 'one' })).toBe(named)
    await Promise.allSettled([a, b, withAllow, other, named])
  })

  // (these test the hooks, which no chart variant is involved in: each test loads its own urls, since the Suspense cache is
  // module-wide and equal inputs would share one load)
  let run = 0

  async function mountProbe(useIt: () => UseChartResult, give: (r: UseChartResult) => void): Promise<() => void> {
    function Probe(): React.ReactElement {
      give(useIt())
      return <div />
    }
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => { root.render(<React.Suspense fallback={null}><Probe /></React.Suspense>) })
    return () => act(() => { root.unmount() })
  }

  it('useChartData splits loader options from chart options: the loader gets baseURL, the chart gets width, height and limits', async () => {
    const file = `data-${++run}.csv`
    const fetchImpl = csv()
    let result: UseChartResult | null = null
    const spec1 = specOf(file)
    const unmount = await mountProbe(() => useChartData(spec1, { fetch: fetchImpl, baseURL: 'https://data.example.com/', width: 80, height: 70 }), (r) => { result = r })
    await act(async () => { for (let i = 0; i < 100 && !result; i++) await new Promise((r) => setTimeout(r, 10)) })
    expect(result!.error).toBeNull()
    // the loader's side: the relative url was resolved against baseURL
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0].toString()).toBe(`https://data.example.com/${file}`)
    // the chart's side: the size reached the drawing (the spec itself says 50 x 50)
    expect(result!.svg).toMatch(/<svg[^>]* width="80"[^>]* height="70"/)
    unmount()

    // `limits` reach the chart as well as the loader: a budget only the drawing can break (the SVG's length) is enforced
    const file2 = `data-${++run}.csv`
    let limited: UseChartResult | null = null
    const spec2 = specOf(file2)
    const limitedFetch = csv()
    const unmount2 = await mountProbe(
      () => useChartData(spec2, { fetch: limitedFetch, baseURL: 'https://data.example.com/', limits: { maxSvgLength: 10 } }),
      (r) => { limited = r },
    )
    await act(async () => { for (let i = 0; i < 100 && !limited; i++) await new Promise((r) => setTimeout(r, 10)) })
    expect(limited!.error).toMatchObject({ code: 'ASTER_LIMIT' })
    unmount2()
  })

  it('useChartData loads a {signal} url for the host\'s signal value, and again when it changes (C531)', async () => {
    const fetchImpl = csv()
    const dir = `https://data.example.com/v${++run}/`
    const spec = {
      width: 50, height: 50, padding: 0, autosize: 'none',
      signals: [{ name: 'file', value: 'spec.csv' }],
      data: [{ name: 't', url: { signal: `'${dir}' + file` }, format: { type: 'csv' } }],
      marks: [],
    } as never
    let result: UseChartResult | null = null
    function Probe({ file }: { file: string }): React.ReactElement {
      result = useChartData(spec, { fetch: fetchImpl, allow: ANY, signals: { file }, width: 50, height: 50 })
      return <div />
    }
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const urls = (): string[] => (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]))
    for (const file of ['a.csv', 'b.csv']) {
      result = null
      await act(async () => { root.render(<React.Suspense fallback={null}><Probe file={file} /></React.Suspense>) })
      await act(async () => { for (let i = 0; i < 100 && !result; i++) await new Promise((r) => setTimeout(r, 10)) })
      expect(result!.error).toBeNull()
    }
    expect(urls()).toEqual([`${dir}a.csv`, `${dir}b.csv`])
    act(() => { root.unmount() })
  })
})

afterEach(() => { document.body.innerHTML = '' })
