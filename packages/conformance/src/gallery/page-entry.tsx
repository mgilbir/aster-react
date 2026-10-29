/**
 * The browser page of the gallery gate (bundled by react.ts). One function, `window.__runGallery(spec)`, which for ONE gallery spec
 *
 *   - renders it with real vega (vega-lite compiles first for Vega-Lite) in this Chromium: the oracle, with live canvas text metrics;
 *   - mounts <Chart> from @aster/react the way an app would: the Vega-Lite compiler registered through `@aster/react/vl`,
 *     NO add-on imported (geo, transforms and the data readers are loaded by <Chart>/`loadSpecData` themselves, on demand, and the
 *     page checks that each spec loaded exactly what it needs), URL data supplied through `loadSpecData`, NO size props unless the
 *     (compiled) spec has numeric top-level width/height (then those exact numbers), in a 600 x 400 host;
 *   - compares the two canonical SVGs exactly.
 */
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import * as vega from 'vega'
import * as vl from 'vega-lite'
import '@aster/react/vl'
import { Chart, loadSpecData, normalizeChartSpec } from '@aster/react'
import { addonsNeeded, isAddonLoaded, type AddonName } from '@aster/core/addons'
import { summarizeDiffs } from './diffs.js'
import { canonicalizeSvg, diffCanonical } from '../normalize.js'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false

const BASE = 'https://gallery.invalid/'
/** The policy of a host that loads its own trusted specs (what `TRUSTED_LOAD_OPTIONS` of `@aster/core/load` says, which a page that imports no add-on does not import). */
const TRUSTED = { protocols: ['http:', 'https:', 'data:'], allow: () => true, allowPrivateNetwork: true }
/** What the host gives <Chart> for vega's loader `baseURL`: relative image urls resolve against it (the oracle's loader has the same base). */
const URL_POLICY = { baseURL: BASE }
const ADDONS: readonly AddonName[] = ['transforms', 'geo', 'load']
const HOST_W = 600
const HOST_H = 400
/** How long a timer-driven oracle is left running to see whether its document changes with time (longer than a clock's second). */
const TIMER_LIVE_MS = 1300

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

/** `liveMs`: let the view run (its timers tick) for that long before the frame is taken; 0 is the first frame. */
async function oracleSvg(vg: Record<string, unknown>, liveMs = 0): Promise<string> {
  const host = makeHost()
  const loader = vega.loader({ baseURL: BASE })
  const view = new vega.View(vega.parse(vg as never), { renderer: 'svg', loader })
  try {
    view.initialize(host)
    await view.runAsync()
    if (liveMs > 0) { await sleep(liveMs); await view.runAsync() }
    view.finalize()
    return await view.toSVG()
  } finally {
    view.finalize()
    host.remove()
  }
}

/** Wait until the svg exists and its markup stops changing (the container is measured after the first paint). */
async function settleMarkup(host: HTMLElement, failure: () => Error | null, onStable?: (html: string) => void): Promise<string> {
  let last = ''
  let stable = 0
  const t0 = performance.now()
  while (performance.now() - t0 < 8000) {
    await sleep(40)
    const e = failure()
    if (e) throw e
    const svg = host.querySelector('svg')
    const html = svg ? svg.outerHTML : ''
    if (html && html === last) {
      if (++stable >= 5) {
        onStable?.(html)
        return html
      }
    } else { stable = 0; last = html }
  }
  throw failure() ?? new Error('no stable <svg> within 8 s')
}

const sizeProps = (vg: Record<string, unknown>): Record<string, unknown> => {
  const props: Record<string, unknown> = {}
  if (typeof vg.width === 'number') props.width = vg.width
  if (typeof vg.height === 'number') props.height = vg.height
  return props
}

async function chartSvg(vg: Record<string, unknown>): Promise<string> {
  const host = makeHost()
  const root = createRoot(host)
  let error: Error | null = null
  try {
    const loaded = (await loadSpecData(JSON.parse(JSON.stringify(vg)) as never, { ...TRUSTED, baseURL: BASE })) as Record<string, unknown>
    // what <Chart> imports on its own: the add-ons loaded now (an earlier spec's, or the data step's) are not its doing
    const before = new Set(ADDONS.filter(isAddonLoaded))
    root.render(React.createElement(Chart, { spec: loaded as never, onError: (e: Error) => { error = e }, urlPolicy: URL_POLICY, ...sizeProps(vg) }))
    return await settleMarkup(host, () => error, () => {
      // <Chart> imported exactly the add-ons `addonsNeeded` names for this spec that the page did not have yet: a plain spec
      // imported nothing, and nothing was imported for nothing. (That `addonsNeeded` is exact is addons-needed.test.ts's
      // differential; this checks the shell loaded what the detector said, over all 720 specs.)
      const needed = addonsNeeded(loaded as never)
      const after = ADDONS.filter(isAddonLoaded)
      const extra = after.filter((a) => !before.has(a) && !needed.includes(a))
      const missing = needed.filter((a) => !after.includes(a))
      if (extra.length || missing.length) throw new Error(`add-on auto-load: needs [${needed}], page had [${[...before]}], now has [${after}]: imported for nothing [${extra}], not imported [${missing}]`)
    })
  } finally {
    root.unmount()
    host.remove()
  }
}

/**
 * ONE mounted <Chart> whose `spec` prop changes: A, then B (what a playground does). The markup after B settles is what a fresh
 * mount of B must also produce. A may be time-driven (its timers must be released by the change), so A is only given a moment.
 */
async function chartSwapSvg(a: Record<string, unknown>, b: Record<string, unknown>): Promise<string> {
  const host = makeHost()
  const root = createRoot(host)
  let error: Error | null = null
  try {
    const loadedA = (await loadSpecData(JSON.parse(JSON.stringify(a)) as never, { ...TRUSTED, baseURL: BASE })) as Record<string, unknown>
    const loadedB = (await loadSpecData(JSON.parse(JSON.stringify(b)) as never, { ...TRUSTED, baseURL: BASE })) as Record<string, unknown>
    const onError = (e: Error): void => { error = e }
    root.render(React.createElement(Chart, { spec: loadedA as never, onError, urlPolicy: URL_POLICY, ...sizeProps(a) }))
    // A is drawn and has been live for a moment (its timers tick, its signals are bound); an A that errors is simply an A that left nothing behind
    for (let i = 0; i < 40 && !host.querySelector('svg') && !error; i++) await sleep(25)
    await sleep(120)
    // an interaction in flight: the pointer moves over A, presses, drags and releases (its selection / hover / drag state is A's)
    const svg = host.querySelector('svg')
    if (svg) {
      const r = svg.getBoundingClientRect()
      const at = (fx: number, fy: number): Record<string, number> => ({ clientX: r.left + r.width * fx, clientY: r.top + r.height * fy })
      const fire = (type: string, fx: number, fy: number): void => {
        svg.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, buttons: type === 'mouseup' ? 0 : 1, ...at(fx, fy) }))
      }
      fire('mousemove', 0.4, 0.4); fire('mousedown', 0.4, 0.4); fire('mousemove', 0.6, 0.6); fire('mouseup', 0.6, 0.6)
      await sleep(40)
    }
    error = null
    // the same element type at the same position: React updates the mounted <Chart>
    root.render(React.createElement(Chart, { spec: loadedB as never, onError, urlPolicy: URL_POLICY, ...sizeProps(b) }))
    return await settleMarkup(host, () => error)
  } finally {
    root.unmount()
    host.remove()
  }
}

/** The oracle for one gallery spec, or why there is none (`unverifiable`). */
async function oracleOf(g: In): Promise<{ oracle: ReturnType<typeof canonicalizeSvg> } | Out> {
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
    // A timer-driven view (a `timer` stream, `now()`) is mounted LIVE by <Chart>: its timers keep ticking, so what is on screen when
    // the markup stops changing, if it ever does (`watch` redraws every 10 ms), is not the first frame the oracle's two fresh
    // renders agree on. Whether the oracle itself has a stable frame is measured, not assumed: the same view, left to run for
    // TIMER_LIVE_MS, either draws the same document (then <Chart> is compared as for any spec) or it does not (then there is no
    // frame to compare against, and the spec is reported as unverifiable instead of hanging the settle loop).
    if (/\btimer\b|\bnow\(\)/.test(JSON.stringify(vgOracle))) {
      const live = diffCanonical(oracle, canonicalizeSvg(await oracleSvg(vgOracle, TIMER_LIVE_MS)))
      await checkStray()
      if (live.length) return { status: 'unverifiable', reason: 'oracle-time-dependent', first: live[0]!.slice(0, 240) }
    }
  } catch (e) {
    // a view that failed mid-run still has a redraw queued that throws a moment later; let it fire here, not inside the next spec
    await sleep(60)
    stray.length = 0
    return { status: 'unverifiable', reason: 'oracle-error', first: msg(e) }
  }
  return { oracle }
}

;(window as unknown as { __runGallery: (g: In) => Promise<Out> }).__runGallery = async (g: In): Promise<Out> => {
  const o = await oracleOf(g)
  if (!('oracle' in o)) return o
  const oracle = o.oracle
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

interface SwapIn { a: In; b: In }
interface SwapOut extends Out { /** the swapped chart also equals vega's B (it always does when the fresh mount does) */ vsOracle?: boolean }

const vegaOf = (g: In): Record<string, unknown> => g.kind === 'vl' ? (normalizeChartSpec(JSON.parse(JSON.stringify(g.spec)) as never) as Record<string, unknown>) : JSON.parse(JSON.stringify(g.spec)) as Record<string, unknown>

;(window as unknown as { __runSwap: (p: SwapIn) => Promise<SwapOut> }).__runSwap = async ({ a, b }: SwapIn): Promise<SwapOut> => {
  const o = await oracleOf(b)
  if (!('oracle' in o)) return o
  let fresh: string
  let swapped: string
  let specA: Record<string, unknown>
  try {
    specA = vegaOf(a)
  } catch (e) {
    return { status: 'unverifiable', reason: 'a-not-renderable', first: msg(e) }
  }
  try {
    stray.length = 0
    fresh = await chartSvg(vegaOf(b))
    await checkStray()
  } catch (e) {
    // B does not even mount fresh: the gallery gate reports that; there is no fresh frame to hold the swap to
    return { status: 'unverifiable', reason: 'fresh-mount-failed', first: msg(e) }
  }
  try {
    stray.length = 0
    swapped = await chartSwapSvg(specA, vegaOf(b))
    await checkStray()
  } catch (e) {
    return { status: 'error', reason: 'swap-threw', first: msg(e) }
  }
  try {
    const cf = canonicalizeSvg(fresh)
    const cs = canonicalizeSvg(swapped)
    const diffs = diffCanonical(cf, cs)
    const vsOracle = diffCanonical(o.oracle, cs).length === 0
    if (diffs.length === 0) return { status: 'pass', vsOracle }
    return { status: 'fail', vsOracle, ...summarizeDiffs(diffs) }
  } catch (e) {
    return { status: 'error', reason: 'chart-svg-not-canonicalizable', first: msg(e) }
  }
}
