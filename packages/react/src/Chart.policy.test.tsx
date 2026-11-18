// @vitest-environment jsdom
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { AsterLimitError, AsterUrlError } from '@aster-charts/core'
import type { ChartHandle } from './Chart'
import { ChartStream, type ChartStreamHandle } from './ChartStream'
import { useChart, type UseChartResult } from './useChart'
import { forEachVariant } from './testing/variants'

const imgSpec = {
  width: 80, height: 40, padding: 0, autosize: 'none',
  data: [{ name: 't', values: [{ u: 'https://good.example/a.png', x: 0 }, { u: 'https://evil.example/b.png', x: 20 }] }],
  marks: [{ type: 'image', from: { data: 't' }, encode: { update: { url: { field: 'u' }, x: { field: 'x' }, y: { value: 0 }, width: { value: 10 }, height: { value: 10 } } } }],
} as never

const urls = (scene: { items: unknown[] } | null): unknown[] => {
  const out: unknown[] = []
  const walk = (n: unknown): void => {
    const g = n as { marktype?: string; items?: Array<{ url?: unknown }> }
    if (g.marktype === 'image') for (const it of g.items ?? []) out.push(it.url)
    else for (const c of (g.items ?? [])) walk(c)
  }
  for (const n of scene?.items ?? []) walk(n)
  return out
}

const mount = (node: React.ReactElement) => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => { root.render(node) })
  return { container, root }
}
afterEach(() => { document.body.innerHTML = '' })

describe('urlPolicy reaches evaluation', () => {
  const allow = (u: URL): boolean => u.host === 'good.example'

  forEachVariant(['svg'], (Chart) => {
    it('<Chart> drops denied images through onDeny', () => {
      const onDeny = vi.fn()
      const ref = React.createRef<ChartHandle>()
      mount(<Chart ref={ref} spec={imgSpec} width={80} height={40} urlPolicy={{ allow, onDeny }} />)
      expect(onDeny).toHaveBeenCalledWith('https://evil.example/b.png', expect.any(AsterUrlError))
      expect(urls(ref.current!.getScene())).toEqual(['https://good.example/a.png', undefined])
    })
  })

  forEachVariant(['svg'], (Chart) => {
    it('<Chart> without onDeny: a denial is the error state, reported once as an AsterUrlError', () => {
      const onError = vi.fn<(e: Error) => void>()
      const { container } = mount(<Chart spec={imgSpec} width={80} height={40} urlPolicy={{ allow }} onError={onError} />)
      expect(container.querySelector('[role="alert"]')).not.toBeNull()
      expect(onError).toHaveBeenCalledTimes(1)
      expect(onError.mock.calls[0]![0]).toBeInstanceOf(AsterUrlError)
    })
  })

  forEachVariant(['svg'], (Chart) => {
    it('<Chart> without a policy and without limits keeps vega behaviour (images as given)', () => {
      const ref = React.createRef<ChartHandle>()
      mount(<Chart ref={ref} spec={imgSpec} width={80} height={40} />)
      expect(urls(ref.current!.getScene())).toHaveLength(2)
    })
  })

  it('useChart forwards it too, and re-evaluates when it changes', () => {
    let result: UseChartResult | null = null
    function Probe({ policy }: { policy: Parameters<typeof useChart>[1] extends infer O ? (O extends { urlPolicy?: infer P } ? P : never) : never }): React.ReactElement {
      result = useChart(imgSpec, { urlPolicy: policy, width: 80, height: 40 })
      return <div />
    }
    const { root } = mount(<Probe policy={{ allow: () => true }} />)
    expect(result!.error).toBeNull()
    act(() => { root.render(<Probe policy={{ allow }} />) })
    expect(result!.error).toBeInstanceOf(AsterUrlError)
  })

  it('<ChartStream> applies it to every flush', async () => {
    const onDeny = vi.fn()
    const ref = React.createRef<ChartStreamHandle>()
    mount(<ChartStream ref={ref} spec={imgSpec} width={80} height={40} urlPolicy={{ allow, onDeny }} />)
    await act(async () => { await new Promise((r) => setTimeout(r, 30)) })
    expect(onDeny).toHaveBeenCalledWith('https://evil.example/b.png', expect.any(AsterUrlError))
    onDeny.mockClear()
    await act(async () => { ref.current!.push({ append: { t: [{ u: 'https://evil.example/c.png', x: 40 }] } }); await new Promise((r) => setTimeout(r, 30)) })
    expect(onDeny.mock.calls.map((c) => c[0])).toContain('https://evil.example/c.png')
  })
})

describe("limits.regex: 'refuse' reaches evaluation", () => {
  // a spec that makes a regular expression from row data (an expression, as an untrusted spec would write one)
  const regexSpec = {
    width: 80, height: 40, padding: 0, autosize: 'none',
    data: [{ name: 't', values: [{ s: 'aab' }], transform: [{ type: 'formula', expr: "test('a+', datum.s) ? 'y' : 'n'", as: 'r' }] }],
    marks: [{ type: 'text', from: { data: 't' }, encode: { update: { text: { field: 'r' } } } }],
  } as never

  forEachVariant(['svg'], (Chart) => {
    it('<Chart>: the error state, reported once as an AsterLimitError; without the option it draws', () => {
      const onError = vi.fn<(e: Error) => void>()
      const { container } = mount(<Chart spec={regexSpec} width={80} height={40} limits={{ regex: 'refuse' }} onError={onError} />)
      expect(container.querySelector('[role="alert"]')).not.toBeNull()
      expect(onError).toHaveBeenCalledTimes(1)
      expect(onError.mock.calls[0]![0]).toBeInstanceOf(AsterLimitError)
      expect(onError.mock.calls[0]![0].message).toContain("limits.regex: 'refuse'")
      document.body.innerHTML = ''
      const drawn = mount(<Chart spec={regexSpec} width={80} height={40} limits={{}} onError={onError} />)
      expect(drawn.container.querySelector('[role="alert"]')).toBeNull()
      expect(drawn.container.querySelector('text')?.textContent).toBe('y')
    })
  })

  it('useChart', () => {
    let result: UseChartResult | null = null
    function Probe(): React.ReactElement {
      result = useChart(regexSpec, { limits: { regex: 'refuse' }, width: 80, height: 40 })
      return <div />
    }
    mount(<Probe />)
    expect(result!.error).toBeInstanceOf(AsterLimitError)
  })

  it('<ChartStream>', async () => {
    const onStreamError = vi.fn()
    mount(<ChartStream spec={regexSpec} width={80} height={40} limits={{ regex: 'refuse' }} onStreamError={onStreamError} />)
    await act(async () => { await new Promise((r) => setTimeout(r, 30)) })
    expect(onStreamError).toHaveBeenCalled()
    expect(onStreamError.mock.calls[0]![0]).toBeInstanceOf(AsterLimitError)
  })
})
