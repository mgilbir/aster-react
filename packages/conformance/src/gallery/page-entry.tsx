/**
 * The browser page of the gallery gate (bundled by react.ts). One function, `window.__runGallery(spec)`, which for ONE gallery spec
 *
 *   - renders it with real vega (vega-lite compiles first for Vega-Lite) in this Chromium: the oracle, with live canvas text metrics;
 *   - mounts <Chart> from @aster/react the way an app would: the Vega-Lite compiler registered through `@aster/react/vl`,
 *     the opt-in add-ons loaded, URL data supplied through `loadSpecData`, NO size props unless the (compiled) spec has numeric
 *     top-level width/height (then those exact numbers), in a 600 x 400 host;
 *   - compares the two canonical SVGs exactly.
 */
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import * as vega from 'vega'
import * as vl from 'vega-lite'
import '@aster/core/geo'
import '@aster/core/transforms'
import '@aster/react/vl'
import { Chart, loadSpecData, normalizeChartSpec } from '@aster/react'
import { TRUSTED_LOAD_OPTIONS } from '@aster/core/load'
import { summarizeDiffs } from './diffs.js'
import { canonicalizeSvg, diffCanonical } from '../normalize.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false

const BASE = 'https://gallery.invalid/'
const HOST_W = 600
const HOST_H = 400

interface In { id: string; kind: 'vega' | 'vl'; spec: Record<string, unknown> }
interface Out { status: 'pass' | 'fail' | 'error' | 'unverifiable'; reason?: string; first?: string; firstContent?: string; diffs?: number }

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 240)
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// errors thrown from callbacks nobody awaits (vega's scenegraph redraw): attribute them to the spec running instead of losing them
const stray: string[] = []
window.addEventListener('error', (e) => { stray.push(e.message) })
window.addEventListener('unhandledrejection', (e) => { stray.push(e.reason instanceof Error ? e.reason.message : String(e.reason)) })
const checkStray = async (): Promise<void> => {
  await sleep(0)
  if (stray.length) throw new Error(stray[0])
}

function makeHost(): HTMLDivElement {
  const host = document.createElement('div')
  host.style.cssText = `width:${HOST_W}px;height:${HOST_H}px;position:relative;overflow:hidden`
  document.body.appendChild(host)
  return host
}

async function oracleSvg(vg: Record<string, unknown>): Promise<string> {
  const host = makeHost()
  const loader = vega.loader({ baseURL: BASE })
  const view = new vega.View(vega.parse(vg as never), { renderer: 'svg', loader })
  try {
    view.initialize(host)
    await view.runAsync()
    view.finalize()
    return await view.toSVG()
  } finally {
    view.finalize()
    host.remove()
  }
}

async function chartSvg(vg: Record<string, unknown>): Promise<string> {
  const host = makeHost()
  const root = createRoot(host)
  let error: Error | null = null
  try {
    const loaded = (await loadSpecData(JSON.parse(JSON.stringify(vg)) as never, { ...TRUSTED_LOAD_OPTIONS, baseURL: BASE })) as Record<string, unknown>
    const props: Record<string, unknown> = {}
    if (typeof vg.width === 'number') props.width = vg.width
    if (typeof vg.height === 'number') props.height = vg.height
    root.render(React.createElement(Chart, { spec: loaded as never, onError: (e: Error) => { error = e }, ...props }))
    // settle: the svg exists and the markup stops changing (the container is measured after the first paint)
    let last = ''
    let stable = 0
    const t0 = performance.now()
    while (performance.now() - t0 < 8000) {
      await sleep(40)
      if (error) throw error
      const svg = host.querySelector('svg')
      const html = svg ? svg.outerHTML : ''
      if (html && html === last) { if (++stable >= 5) return html } else { stable = 0; last = html }
    }
    throw new Error(error ? (error as Error).message : 'no stable <svg> within 8 s')
  } finally {
    root.unmount()
    host.remove()
  }
}

;(window as unknown as { __runGallery: (g: In) => Promise<Out> }).__runGallery = async (g: In): Promise<Out> => {
  let vgOracle: Record<string, unknown>
  let oracle
  try {
    vgOracle = g.kind === 'vl' ? (vl.compile(g.spec as never).spec as unknown as Record<string, unknown>) : g.spec
    stray.length = 0
    // (vega changes the rows of an inline dataset in place -- a force layout rewrites its link rows -- so each run, and
    // the chart that follows, gets its own copy of the spec)
    const fresh = (): Record<string, unknown> => JSON.parse(JSON.stringify(vgOracle)) as Record<string, unknown>
    oracle = canonicalizeSvg(await oracleSvg(fresh()))
    await checkStray()
    const again = diffCanonical(oracle, canonicalizeSvg(await oracleSvg(fresh())))
    await checkStray()
    if (again.length) return { status: 'unverifiable', reason: 'oracle-nondeterministic', first: again[0]!.slice(0, 240) }
  } catch (e) {
    // a view that failed mid-run still has a redraw queued that throws a moment later; let it fire here, not inside the next spec
    await sleep(60)
    stray.length = 0
    return { status: 'unverifiable', reason: 'oracle-error', first: msg(e) }
  }
  let ours: string
  try {
    stray.length = 0
    // an app hands <Chart> the spec it has; a Vega-Lite spec goes through the registered compiler (normalizeChartSpec is what <Chart> itself calls)
    const vg = g.kind === 'vl' ? (normalizeChartSpec(JSON.parse(JSON.stringify(g.spec)) as never) as Record<string, unknown>) : JSON.parse(JSON.stringify(g.spec)) as Record<string, unknown>
    ours = await chartSvg(vg)
    await checkStray()
  } catch (e) {
    return { status: 'error', reason: 'chart-threw', first: msg(e) }
  }
  try {
    const diffs = diffCanonical(oracle, canonicalizeSvg(ours))
    if (diffs.length === 0) return { status: 'pass' }
    return { status: 'fail', ...summarizeDiffs(diffs) }
  } catch (e) {
    return { status: 'error', reason: 'chart-svg-not-canonicalizable', first: msg(e) }
  }
}
