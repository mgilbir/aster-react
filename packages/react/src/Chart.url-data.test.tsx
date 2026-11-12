// @vitest-environment jsdom
/**
 * `urlData="refuse"` through the React shells and hooks (#143): a spec with a `url` dataset is refused at once, through
 * `onError` / the hook's `error`, with the `AsterUrlError` that names the dataset, and NOTHING is imported for it first: not the
 * `load` add-on its csv format names, not the `transforms` add-on its `pie` needs.
 *
 * This file imports no add-on, directly or through a helper (vitest gives each file its own module registry), so the
 * registries start empty and "nothing was imported" is `isAddonLoaded(...) === false`; the first test checks that premise.
 * No spec rendered here without the refusal needs an add-on.
 */
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { describe, it, expect, afterEach } from 'vitest'
import { AsterUrlError, type VgSpec } from '@aster-charts/core'
import { isAddonLoaded } from '@aster-charts/core/addons'
import { compile } from '@aster-charts/vl'
import { forEachVariant } from './testing/variants'
import { useChart, type UseChartResult } from './useChart'
import { useChartStream, type UseChartStreamResult } from './useChartStream'
import { ChartStream } from './ChartStream'
import {
  useChartWorker, handleWorkerMessage, prepareWorkerMessage, type WorkerChartResult,
} from './worker'
import { useChartWorkerStream, type WorkerChartStreamResult } from './useChartWorkerStream'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const CSV_URL = 'https://example.org/data.csv'
/** The issue's repro, compiled by `@aster-charts/vl`: `source_0` is a csv url dataset (the `load` add-on). */
const VL_URL = compile({
  data: { url: CSV_URL },
  mark: 'bar',
  encoding: { x: { field: 'a', type: 'nominal' }, y: { field: 'b', type: 'quantitative' } },
} as never) as unknown as VgSpec
/** A url dataset (csv: `load`) feeding a `pie` (`transforms`): the shell would import both without the refusal. */
const PIE_URL = {
  width: 100, height: 100,
  data: [{ name: 'source_0', url: CSV_URL, format: { type: 'csv' }, transform: [{ type: 'pie', field: 'b' }] }],
  marks: [{ type: 'arc', from: { data: 'source_0' }, encode: { update: { x: { value: 50 }, y: { value: 50 }, startAngle: { field: 'startAngle' }, endAngle: { field: 'endAngle' }, outerRadius: { value: 40 } } } }],
} as unknown as VgSpec
/** A json url dataset in a nested group: needs no add-on, so it renders when url data is allowed (a group's dataset is the group's own: `data` does not reach it, and it draws empty). */
const NESTED_JSON_URL = {
  width: 100, height: 60,
  marks: [{
    type: 'group',
    data: [{ name: 'inner', url: 'https://example.org/inner.json' }],
    marks: [{ type: 'symbol', from: { data: 'inner' }, encode: { update: { x: { field: 'x' }, y: { value: 10 }, size: { value: 30 } } } }],
  }],
} as unknown as VgSpec
const ROWS = { source_0: [{ a: 'x', b: 1 }, { a: 'y', b: 2 }] }
const INNER_ROWS = { inner: [{ x: 10 }, { x: 40 }] }

const nothingLoaded = (): void => {
  expect(isAddonLoaded('load')).toBe(false)
  expect(isAddonLoaded('transforms')).toBe(false)
  expect(isAddonLoaded('geo')).toBe(false)
}

const roots: Array<{ unmount(): void }> = []
afterEach(() => { act(() => { for (const r of roots.splice(0)) r.unmount() }); document.body.innerHTML = '' })
function mount(node: React.ReactElement): { container: HTMLElement; render(node: React.ReactElement): void } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => { root.render(node) })
  return { container, render: (n) => act(() => { root.render(n) }) }
}
/** Let effects, microtasks and a few timers run (inside act). */
async function settle(ms = 50): Promise<void> {
  await act(async () => { await new Promise((r) => setTimeout(r, ms)) })
}
const expectRefusal = (e: unknown, dataset: string): void => {
  expect(e).toBeInstanceOf(AsterUrlError)
  expect((e as AsterUrlError).code).toBe('ASTER_URL_DENIED')
  expect((e as Error).message).toContain(`dataset "${dataset}"`)
  expect((e as Error).message).toContain('url data is not allowed')
}

describe('premise', () => {
  it('no add-on is registered in this file, and the specs need what the tests say', async () => {
    nothingLoaded()
    const { addonsNeeded } = await import('@aster-charts/core/addons')
    expect(addonsNeeded(VL_URL)).toEqual(['load'])
    expect(addonsNeeded(PIE_URL)).toEqual(['transforms', 'load'])
    expect(addonsNeeded(NESTED_JSON_URL)).toEqual([])
  })
})

forEachVariant(['svg'], (Chart) => {
  describe('urlData="refuse"', () => {
    for (const [name, spec, dataset] of [['the Vega-Lite repro (csv url)', VL_URL, 'source_0'], ['a url dataset feeding a pie', PIE_URL, 'source_0']] as const) {
      it(`refuses ${name} in the first commit, through onError, importing nothing`, async () => {
        const errors: Error[] = []
        const { container } = mount(<Chart spec={spec} data={ROWS} urlData="refuse" width={200} height={100} a11y={false} onError={(e) => errors.push(e)} />)
        // synchronous: no suspense wait for an add-on, no chart, the error state
        expect(container.querySelector('svg')).toBeNull()
        expect(container.querySelector('[role="alert"]')).not.toBeNull()
        await settle()
        expect(errors.length).toBe(1)
        expectRefusal(errors[0], dataset)
        nothingLoaded()
      })
    }

    it('refuses a single-object `data` (a one-element list to the compiler) before importing what else the spec needs', async () => {
      const single = { ...PIE_URL, data: (PIE_URL as unknown as { data: unknown[] }).data[0] } as unknown as VgSpec
      const errors: Error[] = []
      const { container } = mount(<Chart spec={single} data={ROWS} urlData="refuse" width={200} height={100} a11y={false} onError={(e) => errors.push(e)} />)
      expect(container.querySelector('svg')).toBeNull()
      await settle()
      expectRefusal(errors[0], 'source_0')
      nothingLoaded()
    })

    it('applies to a url dataset in a nested group, and follows the prop both ways', async () => {
      const errors: Error[] = []
      const el = (urlData?: 'refuse' | 'allow') => <Chart spec={NESTED_JSON_URL} data={INNER_ROWS} urlData={urlData} width={100} height={60} a11y={false} onError={(e) => errors.push(e)} />
      const { container, render } = mount(el())
      expect(container.querySelector('svg .mark-symbol')).not.toBeNull()
      render(el('refuse'))
      await settle()
      expect(container.querySelector('svg')).toBeNull()
      expectRefusal(errors.at(-1), 'inner')
      render(el('allow'))
      await settle()
      expect(container.querySelector('svg .mark-symbol')).not.toBeNull()
    })

    it('reports an invalid mode instead of allowing', async () => {
      const errors: Error[] = []
      const { container } = mount(<Chart spec={NESTED_JSON_URL} data={INNER_ROWS} urlData={'deny' as never} width={100} height={60} a11y={false} onError={(e) => errors.push(e)} />)
      await settle()
      expect(container.querySelector('svg')).toBeNull()
      expect(errors[0]).toBeInstanceOf(TypeError)
      expect(errors[0]!.message).toContain('urlData')
    })
  })
})

describe('hooks', () => {
  it('useChart: `error` is the refusal, nothing imported', () => {
    let result: UseChartResult | null = null
    function Probe(): null { result = useChart(PIE_URL, { data: ROWS, urlData: 'refuse' }); return null }
    mount(<Probe />)
    expect(result!.scene).toBeNull()
    expectRefusal(result!.error, 'source_0')
    nothingLoaded()
  })

  it('useChartStream: the primed state is the refusal, and a change of urlData starts a new stream', () => {
    let result: UseChartStreamResult | null = null
    function Probe({ urlData }: { urlData?: 'refuse' }): null {
      result = useChartStream(NESTED_JSON_URL, { autoFlush: false, initial: { data: INNER_ROWS, ...(urlData ? { urlData } : {}) } })
      return null
    }
    const { render } = mount(<Probe />)
    expect(result!.error).toBeNull()
    expect(result!.scene).not.toBeNull()
    const allowing = result!.stream
    render(<Probe urlData="refuse" />)
    expect(result!.stream).not.toBe(allowing)
    expect(result!.scene).toBeNull()
    expectRefusal(result!.error, 'inner')
  })

  it('<ChartStream urlData="refuse"> reports the refusal through onStreamError, nothing imported', async () => {
    const errors: Error[] = []
    const { container } = mount(<ChartStream spec={PIE_URL} urlData="refuse" streamOptions={{ initial: { data: ROWS } }} onStreamError={(e) => errors.push(e)} />)
    await settle()
    expect(container.querySelector('svg')).toBeNull()
    expectRefusal(errors[0], 'source_0')
    nothingLoaded()
  })

  it('useChartWorker without a Worker: `error` is the refusal, nothing imported', async () => {
    let result: WorkerChartResult | null = null
    function Probe(): null { result = useChartWorker(PIE_URL, { data: ROWS, urlData: 'refuse' }); return null }
    mount(<Probe />)
    await settle()
    expect(result!.pending).toBe(false)
    expect(result!.svg).toBeNull()
    expect(result!.error?.name).toBe('AsterUrlError')
    expect(result!.error?.message).toContain('dataset "source_0"')
    nothingLoaded()
  })

  it('useChartWorkerStream without a Worker: `error` is the refusal, nothing imported', async () => {
    let result: WorkerChartStreamResult | null = null
    function Probe(): null { result = useChartWorkerStream(PIE_URL, { initial: { data: ROWS, urlData: 'refuse' } }); return null }
    mount(<Probe />)
    await settle()
    expect(result!.scene).toBeNull()
    expectRefusal(result!.error, 'source_0')
    nothingLoaded()
  })
})

describe('worker protocol', () => {
  it('a refusing request needs no add-on, and the handler answers with the typed refusal', () => {
    const request = { id: 1, spec: PIE_URL, input: { data: ROWS, urlData: 'refuse' } }
    expect(prepareWorkerMessage({ ...request, input: { data: ROWS } }).missing).toEqual(['transforms', 'load'])
    const prepared = prepareWorkerMessage(request)
    expect(prepared.missing).toEqual([])
    const response = handleWorkerMessage(prepared.data, new Map()) as { error?: { name: string; code?: string; message: string } }
    expect(response.error?.name).toBe('AsterUrlError')
    expect(response.error?.code).toBe('ASTER_URL_DENIED')
    expect(response.error?.message).toContain('dataset "source_0"')
    nothingLoaded()
  })

  it('a refusing stream init needs no add-on, and its first flush answers with the refusal', () => {
    const init = { kind: 'stream', id: 2, streamId: 3, op: 'init', spec: PIE_URL, options: { initial: { data: ROWS, urlData: 'refuse' } } }
    expect(prepareWorkerMessage({ ...init, options: { initial: { data: ROWS } } }).missing).toEqual(['transforms', 'load'])
    const prepared = prepareWorkerMessage(init)
    expect(prepared.missing).toEqual([])
    const response = handleWorkerMessage(prepared.data, new Map()) as { error?: { name: string; code?: string } }
    expect(response.error?.code).toBe('ASTER_URL_DENIED')
    nothingLoaded()
  })
})
