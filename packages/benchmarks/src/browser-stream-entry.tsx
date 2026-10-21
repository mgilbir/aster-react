/**
 * Browser streaming benchmark API for `<ChartStream>` (R13 / P0).
 * Bundled by scripts/browser-stream.bench.mjs and driven through window.__streamBench.
 */
import * as React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ChartStream, type ChartStreamHandle } from '@aster/react'

type Renderer = 'svg' | 'canvas'
type FlushPolicy = 'microtask' | 'raf'

interface Session {
  host: HTMLDivElement
  root: Root
  ref: React.RefObject<ChartStreamHandle | null>
}

let session: Session | null = null

const rows = (n: number, from = 0): Array<{ x: number; y: number }> =>
  Array.from({ length: n }, (_, i) => {
    const k = from + i
    return { x: (k % 1000) / 1000, y: ((k * 7) % 100) / 10 }
  })

const SPEC = {
  $schema: 'https://vega.github.io/schema/vega/v6.json',
  width: 800, height: 500, padding: 0, autosize: 'none', background: 'white',
  data: [{ name: 't', values: [] as Array<{ x: number; y: number }> }],
  scales: [
    { name: 'x', type: 'linear', domain: [0, 1], range: [0, 800] },
    { name: 'y', type: 'linear', domain: [0, 10], range: [500, 0] },
  ],
  marks: [{
    type: 'symbol', from: { data: 't' },
    encode: { update: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'y' }, size: { value: 8 } } },
  }],
} as never

function teardown(): void {
  if (!session) return
  session.root.unmount()
  session.host.remove()
  session = null
}

function waitFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()))
}

async function mount(points: number, renderer: Renderer, flushPolicy: FlushPolicy): Promise<void> {
  teardown()
  const host = document.createElement('div')
  host.style.width = '800px'
  host.style.height = '500px'
  document.body.appendChild(host)
  const root = createRoot(host)
  const ref = React.createRef<ChartStreamHandle>()
  session = { host, root, ref }
  root.render(
    <ChartStream
      ref={ref}
      spec={SPEC}
      width={800}
      height={500}
      renderer={renderer}
      a11y={false}
      streamOptions={{
        initial: { data: { t: rows(points) } },
        flushPolicy,
        autoFlush: true,
      }}
    />,
  )
  // Wait for the initial scene to hit the DOM/canvas.
  for (let i = 0; i < 240; i++) {
    if (host.querySelector('svg, canvas')) return
    await waitFrame()
  }
  throw new Error('stream chart did not render')
}

async function frames(points: number, seconds: number, batch: number, renderer: Renderer, flushPolicy: FlushPolicy) {
  await mount(points, renderer, flushPolicy)
  const host = session!.host
  const ref = session!.ref
  const frameTimes: number[] = []
  let updates = 0
  let mutations = 0
  const observer = new MutationObserver((list) => { mutations += list.length })
  observer.observe(host, { subtree: true, childList: true, attributes: true, characterData: true })
  let next = points
  const end = performance.now() + seconds * 1000
  let prev = performance.now()
  await new Promise<void>((resolve) => {
    const loop = (): void => {
      const t = performance.now()
      if (t >= end) { resolve(); return }
      frameTimes.push(t - prev)
      prev = t
      ref.current?.push({ append: { t: rows(batch, next) } })
      next += batch
      updates++
      requestAnimationFrame(loop)
    }
    requestAnimationFrame(loop)
  })
  // let the final flush/patch paint
  await waitFrame()
  await waitFrame()
  observer.disconnect()
  return { frameTimes: frameTimes.slice(1), updates, mutations, nodes: host.querySelectorAll('*').length }
}

function reset(): void {
  teardown()
}


const api = { mount, frames, reset }
;(window as unknown as { __streamBench: typeof api }).__streamBench = api
