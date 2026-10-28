// @vitest-environment jsdom
/**
 * Add-on auto-load through the hooks (see Chart.autoload.test.tsx for the shells): with nothing imported, `useChart` and
 * `useChartStream` suspend while the add-on their spec needs loads, then return what the static path renders; the main-thread
 * fallbacks of the worker hooks wait for it too. One add-on per hook keeps each test independent of the others' loads.
 * No add-on is imported by this file.
 */
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderSpec, type VgSpec } from '@aster/core'
import { isAddonLoaded } from '@aster/core/addons'
import { useChart } from './useChart'
import { useChartStream } from './useChartStream'
import { useChartWorker } from './worker'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const CORPUS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'conformance', 'corpus')
const corpus = (name: string): VgSpec => JSON.parse(readFileSync(join(CORPUS, name), 'utf8')) as VgSpec
const PIE = corpus('t-pie.vg.json')
const MAP = corpus('geo-vlout-mercator-translate.vg.json')
const roots: Array<{ unmount(): void }> = []
afterEach(() => { act(() => { for (const r of roots.splice(0)) r.unmount() }); document.body.innerHTML = '' })

async function until(ready: () => boolean, ms = 8000): Promise<void> {
  const t0 = Date.now()
  while (!ready() && Date.now() - t0 < ms) await act(async () => { await new Promise((r) => setTimeout(r, 10)) })
}

function mount(node: React.ReactElement): { container: HTMLElement; settled: Promise<void> } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  const settled = act(() => { root.render(<React.Suspense fallback={<i data-testid="fallback" />}>{node}</React.Suspense>) }) as unknown as Promise<void>
  return { container, settled }
}

describe('hooks, with nothing imported', () => {
  it('starts with no add-on registered', () => {
    expect((['transforms', 'geo', 'load'] as const).some(isAddonLoaded)).toBe(false)
  })

  it('useChart suspends while the transforms add-on loads, then returns the static path svg', async () => {
    let result: ReturnType<typeof useChart> | null = null
    function Probe() {
      result = useChart(PIE, { width: 300, height: 200 })
      return <div data-testid="probe" dangerouslySetInnerHTML={{ __html: result.svg ?? '' }} />
    }
    const { container, settled } = mount(<Probe />)
    expect(container.querySelector('[data-testid="fallback"]')).not.toBeNull()
    expect(result).toBeNull()
    await settled
    await until(() => container.querySelector('svg') !== null)
    expect(result!.error).toBeNull()
    expect(isAddonLoaded('transforms')).toBe(true)
    expect(isAddonLoaded('geo')).toBe(false)
    expect(result!.svg).toBe(renderSpec(PIE, { width: 300, height: 200 }))
  })

  it('useChartStream suspends while the geo add-on loads, then primes the first scene', async () => {
    let result: ReturnType<typeof useChartStream> | null = null
    function Probe() {
      result = useChartStream(MAP)
      return <div data-testid="probe" dangerouslySetInnerHTML={{ __html: result.svg ?? '' }} />
    }
    const { container, settled } = mount(<Probe />)
    expect(container.querySelector('[data-testid="fallback"]')).not.toBeNull()
    await settled
    await until(() => container.querySelector('svg') !== null)
    expect(result!.error).toBeNull()
    expect(isAddonLoaded('geo')).toBe(true)
    expect(result!.svg).toBe(renderSpec(MAP))
  })

  it('useChartWorker without a Worker waits for the load add-on, then applies the result', async () => {
    const CSV: VgSpec = {
      width: 100, height: 40, padding: 0,
      data: [{ name: 't', values: 'k,v\na,1\nb,2', format: { type: 'csv', parse: { v: 'number' } } }],
      scales: [{ name: 'x', type: 'linear', domain: { data: 't', field: 'v' }, range: 'width' }],
      marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'v' }, y: { value: 10 } } } }],
    }
    expect(isAddonLoaded('load')).toBe(false)
    let seen: ReturnType<typeof useChartWorker> | null = null
    function Probe() { seen = useChartWorker(CSV, { width: 100, height: 40 }); return null }
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    act(() => { root.render(<Probe />) })
    // the first commit: still waiting, nothing reported
    expect(seen!.pending).toBe(true)
    expect(seen!.error).toBeNull()
    await until(() => !seen!.pending)
    expect(seen!.error).toBeNull()
    expect(isAddonLoaded('load')).toBe(true)
    expect(seen!.svg).toBe(renderSpec(CSV, { width: 100, height: 40 }))
  })
})
