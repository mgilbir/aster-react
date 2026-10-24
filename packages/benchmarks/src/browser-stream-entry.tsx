/**
 * Browser streaming benchmark API for `<ChartStream>` (R13 / P0).
 * Bundled by scripts/browser-stream.bench.mjs and driven through window.__streamBench.
 *
 * Two engines run the *same* streaming workload (same spec, same rows, one
 * append per animation frame):
 *
 * - `aster` — `<ChartStream push({ append })>` with the microtask/raf flush
 *   policies,
 * - `vega`  — a plain `vega.View` driven through the documented streaming
 *   API, `view.change('t', changeset().insert(rows))`, either `.run()`
 *   (synchronous, flush-in-frame) or `.runAsync()` (microtask-ish, the path
 *   vega-embed/React wrappers use).
 *
 * Both are measured with the identical frame-pacing protocol, so the table
 * answers "what does Vega's own incremental append cost on this stream?".
 */
import * as React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { changeset, parse as parseVega, View } from 'vega'
import { ChartStream, type ChartStreamHandle } from '@aster/react'

export type Engine = 'aster' | 'vega'
type Renderer = 'svg' | 'canvas'
type FlushPolicy = 'microtask' | 'raf' | 'run' | 'runAsync'

type Session =
  | { engine: 'aster'; host: HTMLDivElement; root: Root; ref: React.RefObject<ChartStreamHandle | null> }
  | { engine: 'vega'; host: HTMLDivElement; view: View }

let session: Session | null = null

const rows = (n: number, from = 0): Array<{ x: number; y: number }> =>
  Array.from({ length: n }, (_, i) => {
    const k = from + i
    return { x: (k % 1000) / 1000, y: ((k * 7) % 100) / 10 }
  })

/**
 * Valid Vega spec, accepted by both the aster compiler and `vega.parse`.
 *
 * The symbol fill is explicit on purpose. Vega paints a bare symbol with its default
 * config fill (#4c78a8) and Aster does too since the default config is applied; before
 * that, the Aster side painted NOTHING (fill none) while vega painted 100k circles, so a
 * 100k SVG frame measured compositor raster on one engine and an empty layer on the
 * other (77 ms -> 148 ms per item, 16.7 -> 33.4 ms dense, with no change in JS work).
 * Stating the fill makes every build and both engines paint the same pixels, so the
 * numbers are comparable across history. The JS-side regression guard is the dense
 * DOM pass in `bench:incremental`.
 */
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
    encode: { update: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'y' }, size: { value: 8 }, fill: { value: '#4c78a8' } } },
  }],
}

function teardown(): void {
  if (!session) return
  if (session.engine === 'vega') {
    session.view.finalize()
  } else {
    session.root.unmount()
  }
  session.host.remove()
  session = null
}

function waitFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()))
}

async function mount(
  points: number,
  renderer: Renderer,
  flushPolicy: FlushPolicy,
  engine: Engine,
  denseMarks = false,
): Promise<void> {
  teardown()
  const host = document.createElement('div')
  host.style.width = '800px'
  host.style.height = '500px'
  document.body.appendChild(host)

  if (engine === 'vega') {
    // Same initial dataset the aster stream gets through `streamOptions.initial`.
    const spec = { ...SPEC, data: [{ name: 't', values: rows(points) }] }
    const view = new View(parseVega(spec as never), { renderer, logLevel: 0 })
      .initialize(host)
      .run()
    session = { engine: 'vega', host, view }
  } else {
    const root = createRoot(host)
    const ref = React.createRef<ChartStreamHandle>()
    session = { engine: 'aster', host, root, ref }
    root.render(
      <ChartStream
        ref={ref}
        spec={SPEC as never}
        width={800}
        height={500}
        renderer={renderer}
        denseMarks={denseMarks}
        a11y={false}
        streamOptions={{
          initial: { data: { t: rows(points) } },
          flushPolicy: flushPolicy as 'microtask' | 'raf',
          autoFlush: true,
        }}
      />,
    )
  }

  // Wait for the initial scene to hit the DOM/canvas.
  for (let i = 0; i < 240; i++) {
    if (host.querySelector('svg, canvas')) return
    await waitFrame()
  }
  throw new Error(`${engine} chart did not render`)
}

/** The documented Vega append path, both synchronous and async variants. */
function appendVega(view: View, batch: Array<{ x: number; y: number }>, policy: FlushPolicy): void {
  const update = view.change('t', changeset().insert(batch))
  if (policy === 'runAsync') {
    void update.runAsync().catch((err: unknown) => console.error('[stream-bench] vega runAsync', err))
  } else {
    update.run()
  }
}

async function frames(
  points: number,
  seconds: number,
  batch: number,
  renderer: Renderer,
  flushPolicy: FlushPolicy,
  engine: Engine,
  denseMarks = false,
) {
  await mount(points, renderer, flushPolicy, engine, denseMarks)
  const active = session!
  const host = active.host
  const ref = active.engine === 'aster' ? active.ref : null
  const view = active.engine === 'vega' ? active.view : null
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
      const batchRows = rows(batch, next)
      // Both engines do the same amount of work per frame: one append.
      if (view) appendVega(view, batchRows, flushPolicy)
      else ref?.current?.push({ append: { t: batchRows } })
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
  // Sanity: the Vega dataflow must actually contain every appended row. A
  // silently dropped change would make Vega look faster for doing less work.
  const rowsAppended = view ? view.data('t').length : null
  return {
    frameTimes: frameTimes.slice(1),
    updates,
    mutations,
    nodes: host.querySelectorAll('*').length,
    rows: rowsAppended,
    svgNodes: host.querySelectorAll('svg path').length,
  }
}

function reset(): void {
  teardown()
}


const api = { mount, frames, reset }
;(window as unknown as { __streamBench: typeof api }).__streamBench = api
