// @vitest-environment jsdom
/**
 * The hooks given a different `spec`: useChart, useChartStream, useChartWorker and useChartWorkerStream (with and without a Worker).
 *
 * Same relation as the components (`Chart.spec-swap.test.tsx`): after a swap the hook's result is the result of a hook mounted
 * with the new spec -- A -> B and A -> B -> A -- whatever the old spec had accumulated (streamed rows, an open worker
 * stream) and however it was sized.
 */
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { renderSceneToSvg, type SceneRoot, type VgSpec } from '@aster/core'
import { act } from 'react'
import { describe, it, expect, afterEach } from 'vitest'
import { useChart } from './useChart'
import { useChartStream, type UseChartStreamResult } from './useChartStream'
import { useChartWorker, handleChartWorkerRequest, handleChartWorkerStreamRequest, type ChartWorkerStreamRequest } from './worker'
import { useChartWorkerStream, type WorkerChartStreamResult } from './useChartWorkerStream'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const base = { $schema: 'https://vega.github.io/schema/vega/v6.json', padding: 0, autosize: 'none' }
/** Two charts that share a dataset name and size but nothing else: the case an incremental update could confuse. */
const dots = {
  ...base, width: 200, height: 100,
  data: [{ name: 't', values: [{ x: 0, y: 1 }, { x: 1, y: 2 }, { x: 2, y: 3 }] }],
  scales: [{ name: 'x', type: 'linear', domain: [0, 3], range: 'width' }, { name: 'y', type: 'linear', domain: [0, 4], range: 'height' }],
  marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'y' }, size: { value: 20 } } } }],
} as unknown as VgSpec
const bars = {
  ...base, width: 200, height: 100,
  data: [{ name: 't', values: [{ x: 5, y: 9 }, { x: 6, y: 2 }, { x: 7, y: 4 }] }],
  scales: [{ name: 'x', type: 'band', domain: { data: 't', field: 'x' }, range: 'width' }, { name: 'y', type: 'linear', domain: [0, 10], range: 'height' }],
  marks: [{ type: 'rect', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'x' }, width: { scale: 'x', band: 1 }, y: { scale: 'y', field: 'y' }, y2: { scale: 'y', value: 0 } } } }],
} as unknown as VgSpec
const labelled = {
  ...base, width: 120, height: 60,
  data: [{ name: 't', values: [{ k: 'a' }, { k: 'b' }] }],
  marks: [{ type: 'text', from: { data: 't' }, encode: { update: { x: { value: 5 }, y: { signal: 'datum.k == "a" ? 10 : 30' }, text: { field: 'k' } } } }],
} as unknown as VgSpec
const SPECS: Record<string, VgSpec> = { dots, bars, labelled }

function host(): { render(node: React.ReactElement): void; unmount(): void } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  return { render: (node) => { act(() => { root.render(node) }) }, unmount: () => { act(() => { root.unmount() }) } }
}
afterEach(() => { document.body.innerHTML = '' })
const settle = async (): Promise<void> => { await act(async () => { await new Promise((r) => setTimeout(r, 20)) }) }
const svgOf = (scene: SceneRoot | null): string | null => (scene ? renderSceneToSvg(scene) : null)

/** Every ordered pair, and the round trip, through `read(spec)` -- a probe of one hook. */
function swapSuite(name: string, mountProbe: () => { set(spec: VgSpec): Promise<void>; read(): Promise<string | null>; unmount(): void }): void {
  describe(name, () => {
    it('shows what a fresh mount of the new spec shows, for every ordered pair and A -> B -> A', async () => {
      const fresh: Record<string, string | null> = {}
      for (const [n, spec] of Object.entries(SPECS)) {
        const p = mountProbe()
        await p.set(spec)
        fresh[n] = await p.read()
        p.unmount()
        expect(fresh[n], `${name}: ${n} renders`).toContain('<svg')
      }
      for (const [an, a] of Object.entries(SPECS)) {
        for (const [bn, b] of Object.entries(SPECS)) {
          if (an === bn) continue
          const p = mountProbe()
          await p.set(a)
          await p.set(b)
          expect(await p.read(), `${an} -> ${bn}`).toBe(fresh[bn])
          await p.set(a)
          expect(await p.read(), `${an} -> ${bn} -> ${an}`).toBe(fresh[an])
          p.unmount()
        }
      }
    })
  })
}

swapSuite('useChart', () => {
  const h = host()
  let current: ReturnType<typeof useChart> | null = null
  const Probe = ({ spec }: { spec: VgSpec }): React.ReactElement => { current = useChart(spec); return <i /> }
  return { set: async (spec) => { h.render(<Probe spec={spec} />) }, read: async () => current!.svg, unmount: h.unmount }
})

swapSuite('useChartStream', () => {
  const h = host()
  let current: UseChartStreamResult | null = null
  const Probe = ({ spec }: { spec: VgSpec }): React.ReactElement => { current = useChartStream(spec); return <i /> }
  return {
    // rows streamed into the old spec belong to its stream: they must not follow the chart to the next spec
    set: async (spec) => {
      h.render(<Probe spec={spec} />)
      await settle()
      if (spec === dots) { act(() => { current!.push({ append: { t: [{ x: 2.5, y: 3.5 }] } }) }); await settle() }
    },
    read: async () => current!.svg,
    unmount: h.unmount,
  }
})

/** A Worker that answers in-process, and keeps its open streams for inspection. */
class FakeWorker {
  listeners = new Set<(event: MessageEvent) => void>()
  streams = new Map<number, never>()
  addEventListener(type: string, fn: (event: MessageEvent) => void): void { if (type === 'message') this.listeners.add(fn) }
  removeEventListener(_type: string, fn: (event: MessageEvent) => void): void { this.listeners.delete(fn) }
  postMessage(request: { kind?: string; id: number; spec?: never }): void {
    const response = request.kind === 'stream'
      ? handleChartWorkerStreamRequest(request as unknown as ChartWorkerStreamRequest, this.streams as never)
      : handleChartWorkerRequest(request as never)
    queueMicrotask(() => { for (const fn of this.listeners) fn({ data: response } as MessageEvent) })
  }
  terminate(): void { /* nothing to stop */ }
}

for (const withWorker of [false, true]) {
  const label = withWorker ? 'with a Worker' : 'without a Worker (in-process fallback)'
  swapSuite(`useChartWorker, ${label}`, () => {
    const h = host()
    const worker = withWorker ? new FakeWorker() : undefined
    let current: ReturnType<typeof useChartWorker> | null = null
    const Probe = ({ spec }: { spec: VgSpec }): React.ReactElement => { current = useChartWorker(spec, worker ? { worker: worker as unknown as Worker } : {}); return <i /> }
    return {
      set: async (spec) => { h.render(<Probe spec={spec} />); await settle() },
      read: async () => { await settle(); return current!.pending ? 'pending' : current!.svg },
      unmount: h.unmount,
    }
  })

  const streamSuite = (): { fake: FakeWorker | undefined; probe: ReturnType<Parameters<typeof swapSuite>[1]> } => {
    const h = host()
    const fake = withWorker ? new FakeWorker() : undefined
    let current: WorkerChartStreamResult | null = null
    const Probe = ({ spec }: { spec: VgSpec }): React.ReactElement => { current = useChartWorkerStream(spec, fake ? { worker: fake as unknown as Worker } : {}); return <i /> }
    return {
      fake,
      probe: {
        set: async (spec) => {
          h.render(<Probe spec={spec} />)
          await settle()
          if (spec === dots) { act(() => { current!.push({ append: { t: [{ x: 2.5, y: 3.5 }] } }) }); await settle() }
        },
        read: async () => svgOf(current!.scene),
        unmount: h.unmount,
      },
    }
  }
  swapSuite(`useChartWorkerStream, ${label}`, () => streamSuite().probe)

  if (withWorker) {
    describe('useChartWorkerStream, with a Worker', () => {
      it('closes the old spec\'s stream in the worker when the spec changes (one open stream, none after unmount)', async () => {
        const { fake, probe } = streamSuite()
        await probe.set(dots)
        expect(fake!.streams.size).toBe(1)
        await probe.set(bars)
        await probe.set(labelled)
        await probe.set(dots)
        expect(fake!.streams.size).toBe(1)
        probe.unmount()
        await settle()
        expect(fake!.streams.size).toBe(0)
      })
    })
  }
}

describe('a data-only change stays on the incremental session (useChart)', () => {
  it('keeps the session and evaluates the new rows against the same compiled chart', () => {
    const h = host()
    let current: ReturnType<typeof useChart> | null = null
    const withRows = (n: number): VgSpec => ({ ...(dots as object), data: [{ name: 't', values: Array.from({ length: n }, (_, i) => ({ x: i, y: i })) }] }) as unknown as VgSpec
    const Probe = ({ spec }: { spec: VgSpec }): React.ReactElement => { current = useChart(spec); return <i /> }
    h.render(<Probe spec={withRows(3)} />)
    const first = current!
    const compiled = (first.scene as unknown as { compiled: unknown }).compiled
    h.render(<Probe spec={withRows(4)} />)
    expect(current!.session).toBe(first.session)
    expect((current!.scene as unknown as { compiled: unknown }).compiled).toBe(compiled)
    h.unmount()
  })
})
