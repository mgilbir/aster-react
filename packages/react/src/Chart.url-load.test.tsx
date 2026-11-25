// @vitest-environment jsdom
/**
 * `urlLoad`: a chart that loads its own url datasets and loads them again when a signal their urls read changes inside the chart
 * (a bound input here), as a vega view does. The rows drawn are checked against the rows each url serves; the load's failures go
 * to the one error channel; a load a newer url supersedes is aborted and never draws; nothing is fetched without the prop.
 * (The differential against vega itself, in a browser, is `scripts/browser-url-reload.mts`.)
 */
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { act } from 'react'
import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest'
import { AsterUrlError, type VgSpec } from '@aster-charts/core'
import { forEachVariant } from './testing/variants'
import type { ChartHandle } from './chart-types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ROWS: Record<string, Array<{ v: number }>> = {
  'a.json': [{ v: 10 }, { v: 20 }],
  'b.json': [{ v: 10 }, { v: 20 }, { v: 30 }],
  'c.json': [{ v: 5 }],
}
const SPEC = {
  width: 100, height: 40, padding: 0, autosize: 'none',
  signals: [
    { name: 'which', value: 'a', bind: { input: 'select', options: ['a', 'b', 'c', 'missing'] } },
    { name: 'other', value: 1, bind: { input: 'range', min: 0, max: 9, step: 1 } },
  ],
  data: [{ name: 'rows', url: { signal: "'https://data.example.com/' + which + '.json'" } }],
  marks: [{ type: 'rect', from: { data: 'rows' }, encode: { update: {
    x: { signal: 'datum.v' }, y: { value: 0 }, width: { value: 4 }, height: { signal: 'other * 3' }, fill: { value: 'steelblue' },
  } } }],
} as unknown as VgSpec
const allow = (url: URL): boolean => url.origin === 'https://data.example.com'

// (the loader add-on is imported once up front, so a test's waits are for the chart and not for the module system)
beforeAll(async () => { await import('@aster-charts/core/load') })

const roots: Array<{ unmount(): void }> = []
afterEach(() => { act(() => { for (const r of roots.splice(0)) r.unmount() }); document.body.innerHTML = '' })
function mount(node: React.ReactElement): { container: HTMLElement; render(n: React.ReactElement): void } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => { root.render(node) })
  return { container, render: (n) => act(() => { root.render(n) }) }
}
async function settle(ms = 30): Promise<void> {
  await act(async () => { await new Promise((r) => setTimeout(r, ms)) })
}
/** The x of each rect drawn: the `v` of each row. */
const drawn = (ref: React.RefObject<ChartHandle | null>): number[] => {
  const out: number[] = []
  const walk = (items: unknown[]): void => {
    for (const it of items as Array<{ marktype?: string; items?: unknown[]; x?: number }>) {
      if (it.marktype === 'rect') for (const r of it.items as Array<{ x: number }>) out.push(r.x)
      else if (it.items) walk(it.items)
    }
  }
  walk(ref.current!.getScene()!.items as unknown[])
  return out
}
function pick(container: HTMLElement, value: string): void {
  const select = container.querySelector('select') as HTMLSelectElement
  select.value = [...select.options].find((o) => o.textContent === value)!.value
  act(() => { select.dispatchEvent(new Event('change', { bubbles: true })) })
}
const respond = (rows: unknown): Response => new Response(JSON.stringify(rows), { status: 200 })
const nameOf = (url: string): string => url.slice(url.lastIndexOf('/') + 1)

/** A fetch that serves ROWS, records every request and its abort signal, and can hold a url until released. */
function fakeFetch(hold: Set<string> = new Set()) {
  const calls: string[] = []
  const signals: Record<string, AbortSignal> = {}
  const release: Record<string, () => void> = {}
  const fetch = vi.fn((url: string, init?: { signal?: AbortSignal }) => {
    const name = nameOf(String(url))
    calls.push(name)
    if (init?.signal) signals[name] = init.signal
    const answer = (): Response => (name in ROWS ? respond(ROWS[name]) : new Response('no', { status: 404 }))
    if (!hold.has(name)) return Promise.resolve(answer())
    return new Promise<Response>((resolve, reject) => {
      release[name] = () => resolve(answer())
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true })
    })
  })
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls, signals, release }
}

forEachVariant(['svg', 'interaction'], (Chart) => {
  describe('<Chart urlLoad>: url data that follows a signal changed inside the chart', () => {
    it('draws the rows of the first url, then of the url a bound input selects', async () => {
      const f = fakeFetch()
      const ref = React.createRef<ChartHandle>()
      const { container } = mount(<Chart ref={ref} spec={SPEC} urlLoad={{ fetch: f.fetch, allow }} />)
      await settle()
      expect(drawn(ref)).toEqual([10, 20])
      pick(container, 'b')
      await settle()
      expect(drawn(ref)).toEqual([10, 20, 30])
      pick(container, 'c')
      await settle()
      expect(drawn(ref)).toEqual([5])
      expect(f.calls).toEqual(['a.json', 'b.json', 'c.json'])
    })

    it('draws the dataset empty until the first load arrives, and keeps the old rows while a newer url loads', async () => {
      const f = fakeFetch(new Set(['a.json', 'b.json']))
      const ref = React.createRef<ChartHandle>()
      const { container } = mount(<Chart ref={ref} spec={SPEC} urlLoad={{ fetch: f.fetch, allow }} />)
      await settle()
      expect(drawn(ref)).toEqual([])
      f.release['a.json']!()
      await settle()
      expect(drawn(ref)).toEqual([10, 20])
      pick(container, 'b')
      await settle()
      expect(drawn(ref)).toEqual([10, 20])
      f.release['b.json']!()
      await settle()
      expect(drawn(ref)).toEqual([10, 20, 30])
    })

    it('loads nothing again for a signal change that leaves every url as it was', async () => {
      const f = fakeFetch()
      const ref = React.createRef<ChartHandle>()
      const { container } = mount(<Chart ref={ref} spec={SPEC} urlLoad={{ fetch: f.fetch, allow }} />)
      await settle()
      const range = container.querySelector('input[type="range"]') as HTMLInputElement
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(range, '5')
      act(() => { range.dispatchEvent(new Event('input', { bubbles: true })) })
      await settle()
      expect(f.calls).toEqual(['a.json'])
      expect(drawn(ref)).toEqual([10, 20])
    })

    it('aborts the load a newer url supersedes, and it never draws', async () => {
      const f = fakeFetch(new Set(['b.json']))
      const ref = React.createRef<ChartHandle>()
      const onError = vi.fn()
      const { container } = mount(<Chart ref={ref} spec={SPEC} urlLoad={{ fetch: f.fetch, allow }} onError={onError} />)
      await settle()
      pick(container, 'b')
      await settle()
      expect(f.signals['b.json']!.aborted).toBe(false)
      pick(container, 'c')
      await settle()
      expect(f.signals['b.json']!.aborted).toBe(true)
      expect(drawn(ref)).toEqual([5])
      expect(onError).not.toHaveBeenCalled()
    })

    it('aborts a load still running when the chart unmounts', async () => {
      const f = fakeFetch(new Set(['a.json']))
      const { render } = mount(<Chart spec={SPEC} urlLoad={{ fetch: f.fetch, allow }} />)
      await settle()
      expect(f.signals['a.json']!.aborted).toBe(false)
      render(<div />)
      await settle()
      expect(f.signals['a.json']!.aborted).toBe(true)
    })

    it('reports a failed load once through onError, keeps the rows and the inputs, and a later good url recovers', async () => {
      const f = fakeFetch()
      const ref = React.createRef<ChartHandle>()
      const onError = vi.fn()
      const { container } = mount(<Chart ref={ref} spec={SPEC} urlLoad={{ fetch: f.fetch, allow }} onError={onError} />)
      await settle()
      pick(container, 'missing')
      await settle()
      expect(onError).toHaveBeenCalledTimes(1)
      expect(String(onError.mock.calls[0]![0].message)).toContain('HTTP 404')
      expect(drawn(ref)).toEqual([10, 20])
      pick(container, 'c')
      await settle()
      expect(drawn(ref)).toEqual([5])
      expect(onError).toHaveBeenCalledTimes(1)
    })

    it('needs the loader\'s URL policy: a network url nobody allowed fails with AsterUrlError and is never requested', async () => {
      const f = fakeFetch()
      const onError = vi.fn()
      mount(<Chart spec={SPEC} urlLoad={{ fetch: f.fetch }} onError={onError} />)
      await settle()
      expect(f.calls).toEqual([])
      expect(onError).toHaveBeenCalledTimes(1)
      expect(onError.mock.calls[0]![0]).toBeInstanceOf(AsterUrlError)
    })

    it('fetches nothing without the prop, and with urlData="refuse" refuses the dataset first', async () => {
      const f = fakeFetch()
      const onError = vi.fn()
      mount(<Chart spec={SPEC} onError={onError} />)
      await settle()
      expect(onError).toHaveBeenCalledTimes(1)
      const refused = vi.fn()
      mount(<Chart spec={SPEC} urlData="refuse" urlLoad={{ fetch: f.fetch, allow }} onError={refused} />)
      await settle()
      expect(f.calls).toEqual([])
      expect(refused.mock.calls[0]![0]).toBeInstanceOf(AsterUrlError)
    })

    it('a function option rebuilt by every render is no change: one load', async () => {
      const f = fakeFetch()
      const view = (n: number): React.ReactElement => <Chart spec={SPEC} signals={{ other: n }} urlLoad={{ fetch: (...a: Parameters<typeof fetch>) => f.fetch(...a), allow: (u) => allow(u) }} />
      const { render } = mount(view(1))
      await settle()
      render(view(2))
      await settle()
      render(view(3))
      await settle()
      expect(f.calls).toEqual(['a.json'])
    })

    it('the host\'s signals prop that changes the url loads the new one', async () => {
      const f = fakeFetch()
      const ref = React.createRef<ChartHandle>()
      const { render } = mount(<Chart ref={ref} spec={SPEC} signals={{ which: 'a' }} urlLoad={{ fetch: f.fetch, allow }} />)
      await settle()
      render(<Chart ref={ref} spec={SPEC} signals={{ which: 'b' }} urlLoad={{ fetch: f.fetch, allow }} />)
      await settle()
      expect(drawn(ref)).toEqual([10, 20, 30])
    })

    it('under StrictMode (effects run, are cleaned up and run again) the url is loaded and drawn', async () => {
      const f = fakeFetch()
      const ref = React.createRef<ChartHandle>()
      mount(<React.StrictMode><Chart ref={ref} spec={SPEC} urlLoad={{ fetch: f.fetch, allow }} /></React.StrictMode>)
      await settle()
      expect(drawn(ref)).toEqual([10, 20])
      expect(new Set(f.calls)).toEqual(new Set(['a.json']))
    })

    it('the server draws the dataset empty and fetches nothing (effects do not run there)', () => {
      const f = fakeFetch()
      const html = renderToString(<Chart spec={SPEC} urlLoad={{ fetch: f.fetch, allow }} />)
      expect(html).toContain('<svg')
      expect(html).not.toContain('role="alert"')
      expect(f.calls).toEqual([])
    })

    it('a url dataset in a nested group is loaded too', async () => {
      const f = fakeFetch()
      const nested = {
        width: 100, height: 40, padding: 0, autosize: 'none',
        marks: [{
          type: 'group',
          data: [{ name: 'inner', url: 'https://data.example.com/b.json' }],
          marks: [{ type: 'rect', from: { data: 'inner' }, encode: { update: { x: { signal: 'datum.v' }, y: { value: 0 }, width: { value: 4 }, height: { value: 5 } } } }],
        }],
      } as unknown as VgSpec
      const ref = React.createRef<ChartHandle>()
      mount(<Chart ref={ref} spec={nested} urlLoad={{ fetch: f.fetch, allow }} />)
      await settle()
      expect(drawn(ref)).toEqual([10, 20, 30])
    })
  })
})
