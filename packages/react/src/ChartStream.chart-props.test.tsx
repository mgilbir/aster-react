// @vitest-environment jsdom
/**
 * The `<Chart>` props a stream component takes mean on it what they mean on `<Chart>` (C272): the stream evaluates, so
 * `random` is the stream's source of random numbers and `logger` hears what its evaluations log (relayed from a worker), and
 * `onError` hears the stream's failures. Each is checked against `<Chart>` with the same props (the stream's first scene is the
 * chart's scene), on `<ChartStream>` and on `<ChartWorkerStream>` with and without a Worker.
 */
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { forEachVariant } from './testing/variants'
import { ChartStream, type ChartStreamHandle } from './ChartStream'
import { ChartWorkerStream, type ChartWorkerStreamHandle } from './ChartWorkerStream'
import { handleChartWorkerStreamRequest, type ChartWorkerStreamRequest } from './worker-impl'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const randomSpec = {
  width: 80, height: 40, padding: 0, autosize: 'none',
  data: [{ name: 't', values: [{ i: 0 }, { i: 1 }, { i: 2 }], transform: [{ type: 'formula', as: 'r', expr: 'random()' }] }],
  marks: [{ type: 'text', from: { data: 't' }, encode: { update: { text: { field: 'r' }, x: { value: 0 }, y: { field: 'i', mult: 10 } } } }],
} as never
// an encode expression that throws on one row: vega logs it and draws the rest
const loggingSpec = {
  width: 100, height: 60, padding: 0, autosize: 'none',
  data: [{ name: 't', values: [{ a: 1, o: { x: 1 } }, { a: 2 }] }],
  marks: [{ type: 'rect', from: { data: 't' }, encode: { update: { x: { signal: 'datum.o.x * 10' }, y: { value: 0 }, width: { value: 5 }, height: { value: 5 } } } }],
} as never
const plainSpec = {
  width: 100, height: 60, padding: 0, autosize: 'none',
  data: [{ name: 't', values: [{ x: 1 }] }],
  marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { field: 'x' }, y: { value: 5 } } } }],
} as never

class FakeWorker {
  listeners = new Set<(e: MessageEvent) => void>()
  streams = new Map<number, never>()
  addEventListener(type: string, fn: (e: MessageEvent) => void): void { if (type === 'message') this.listeners.add(fn) }
  removeEventListener(_t: string, fn: (e: MessageEvent) => void): void { this.listeners.delete(fn) }
  postMessage(msg: ChartWorkerStreamRequest): void {
    const r = handleChartWorkerStreamRequest(structuredClone(msg), this.streams as never)
    setTimeout(() => { for (const fn of [...this.listeners]) fn({ data: structuredClone(r) } as MessageEvent) }, 0)
  }
  terminate(): void {}
}

const counting = (): (() => number) => { let n = 0; return () => ++n / 100 }
const texts = (el: HTMLElement): string[] => [...el.querySelectorAll('text')].map((t) => t.textContent ?? '')

function mount(node: React.ReactElement): { host: HTMLElement; root: ReturnType<typeof createRoot> } {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  act(() => { root.render(node) })
  return { host, root }
}
const wait = (ms = 40): Promise<void> => act(async () => { await new Promise((r) => setTimeout(r, ms)) })

afterEach(() => { document.body.innerHTML = '' })

/** A ref both shells can fill: what each shell's handle is assignable from. */
type StreamRef = ChartStreamHandle & ChartWorkerStreamHandle
type Shell = 'ChartStream' | 'ChartWorkerStream (no Worker)' | 'ChartWorkerStream (Worker)'

function streamShell(shell: Shell, props: Record<string, unknown>, ref?: React.RefObject<StreamRef | null>): React.ReactElement {
  const p = props as unknown as React.ComponentProps<typeof ChartStream>
  if (shell === 'ChartStream') return <ChartStream ref={ref} {...p} />
  const worker = shell === 'ChartWorkerStream (Worker)' ? new FakeWorker() as unknown as Worker : null
  return <ChartWorkerStream ref={ref} {...(p as React.ComponentProps<typeof ChartWorkerStream>)} streamOptions={{ worker }} />
}

// (the reference is <Chart> with the same props, on every variant of the matrix; the stream components are the subject)
forEachVariant(['svg'], (Chart) => {
  describe('random: the stream evaluates with it, as <Chart> does', () => {
    it.each(['ChartStream', 'ChartWorkerStream (no Worker)'] as const)('%s draws what <Chart random> draws', async (shell) => {
      const chart = mount(<Chart spec={randomSpec} width={80} height={40} random={counting()} />)
      const stream = mount(streamShell(shell, { spec: randomSpec, width: 80, height: 40, random: counting() }))
      await wait()
      expect(texts(chart.host)).toEqual(['0.01', '0.02', '0.03'])
      expect(texts(stream.host)).toEqual(texts(chart.host))
    })

    it('ChartWorkerStream with a Worker: a function cannot cross, so it is refused with an error (not silently dropped)', async () => {
      const errors: Error[] = []
      mount(streamShell('ChartWorkerStream (Worker)', { spec: randomSpec, width: 80, height: 40, random: counting(), onError: (e: Error) => errors.push(e) }))
      await wait()
      expect(errors).toHaveLength(1)
      expect(errors[0]!.message).toMatch(/random/)
    })
  })

  describe('logger: hears what the stream’s evaluations log, as <Chart logger> does', () => {
    it.each(['ChartStream', 'ChartWorkerStream (no Worker)', 'ChartWorkerStream (Worker)'] as const)('%s', async (shell) => {
      const chartLog: string[] = []
      const streamLog: string[] = []
      const of = (into: string[]) => ({ error: (...a: unknown[]) => { into.push(String((a[0] as Error)?.message ?? a[0])) }, warn: () => {} })
      mount(<Chart spec={loggingSpec} width={100} height={60} logger={of(chartLog)} />)
      mount(streamShell(shell, { spec: loggingSpec, width: 100, height: 60, logger: of(streamLog) }))
      await wait()
      expect(chartLog.length).toBeGreaterThan(0)
      expect(streamLog).toEqual(chartLog)
    })
  })

  describe('onError: hears a stream failure once, as onStreamError does', () => {
    it.each(['ChartStream', 'ChartWorkerStream (no Worker)', 'ChartWorkerStream (Worker)'] as const)('%s', async (shell) => {
      const onError: Error[] = []
      const onStreamError: Error[] = []
      const ref = React.createRef<StreamRef>()
      mount(streamShell(shell, {
        spec: plainSpec, width: 100, height: 60, limits: { maxRows: 3 },
        onError: (e: Error) => onError.push(e), onStreamError: (e: Error) => onStreamError.push(e),
      }, ref))
      await wait()
      act(() => { ref.current!.push({ append: { t: [{ x: 2 }, { x: 3 }, { x: 4 }, { x: 5 }] } }) })
      await wait()
      expect(onStreamError).toHaveLength(1)
      expect(onError).toEqual(onStreamError)
      expect(onError[0]!.message).toMatch(/maxRows/)
    })
  })
})
