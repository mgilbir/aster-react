/**
 * Real-browser interaction gate for <Chart> and <SvgChart interaction={interaction}>.
 *
 * jsdom has no layout and no hit testing, so it cannot tell whether the marks
 * are actually reachable by a real pointer: an overlay swallowing events passes
 * every jsdom test (synthetic events are dispatched straight at the element the
 * test picks). This drives the bundled component in headless Chromium with real
 * mouse input and checks that, with each interaction prop enabled,
 *
 *   - the element under the pointer is the mark (not an overlay),
 *   - tooltips show,
 *   - `signal.on` mark events fire (and the scene hit index sees the same click),
 *   - bound inputs (range / select / checkbox) can be operated and notify listeners,
 *   - brushing, drag-pan, wheel-zoom and their pointer capture still work,
 *   - a11y nodes are positioned over the marks they describe (padding included),
 *   - with `transition`, new data is drawn as real animation frames that settle on the exact svg of a plain chart,
 *   - `<Chart renderer="canvas">` draws image marks from their urls (CORS ones), as vega's canvas does,
 *   - `getPng` (on `<Chart>`, and on `<SvgChart png={png}>`) encodes exactly the pixels the canvas renderer paints, under a
 *     Content-Security-Policy whose `img-src` allows neither `blob:` nor `data:`, and draws a CORS image mark but not one whose
 *     server does not allow CORS (reported instead).
 *
 * Every check runs against both components, each bundled on its own (so the light one is the real light bundle):
 * `<Chart>` from the package entry, and `<SvgChart interaction={interaction}>` from `@aster-charts/react/lite` +
 * `@aster-charts/react/interaction`. A third pass covers `<SvgChart>` WITHOUT interaction: it renders, it works for what
 * needs no hit testing (pan/zoom, brush), and an event-stream spec reports the documented error instead of going
 * silently dead. The light bundles are asserted (esbuild metafile) not to contain the canvas renderer, and the one
 * without `interaction` not to contain the hit index or the signal loop either.
 *
 * Run: pnpm --filter @aster-charts/react test:browser   (after `pnpm build`)
 */
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { build } from 'esbuild'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { chromium, type Page } from 'playwright'
import { compile as compileVl } from '@aster-charts/vl'
import { cli } from '../../../scripts/lib/cli.mjs'

cli({ url: import.meta.url })

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = dirname(HERE)

type VariantName = 'Chart' | 'SvgChart+interaction' | 'SvgChart' | 'SvgChart+png'

/** The bundle for one variant: what its imports pull in is exactly what that variant ships. */
const entryFor = (variant: VariantName): string => {
  const svgCaps = variant === 'SvgChart+interaction'
    ? `import { interaction } from ${JSON.stringify(join(PKG, 'src/interaction-capability.ts'))}\nconst png = undefined`
    : variant === 'SvgChart+png'
      ? `import { png } from ${JSON.stringify(join(PKG, 'src/png-capability.ts'))}\nconst interaction = undefined`
      : 'const interaction = undefined\nconst png = undefined'
  // the variants that carry the canvas renderer anyway also get it on the page, to paint a scene directly (the PNG's reference)
  const painter = variant === 'Chart' || variant === 'SvgChart+png'
    ? `import { renderSceneToCanvas } from '@aster-charts/core/canvas'\nwindow.__paint = (scene, dpr) => { const c = document.createElement('canvas'); c.width = Math.ceil(scene.width * dpr); c.height = Math.ceil(scene.height * dpr); renderSceneToCanvas(scene, c.getContext('2d'), { dpr }); return c }`
    : ''
  const imports = variant === 'Chart'
    ? `import { Chart } from ${JSON.stringify(join(PKG, 'src/index.ts'))}\n${painter}`
    : `import { SvgChart } from ${JSON.stringify(join(PKG, 'src/lite.ts'))}\n${svgCaps}\n${painter}`
  const element = variant === 'Chart'
    ? 'React.createElement(Chart, { ref: window.__ref, spec, ...p })'
    : 'React.createElement(SvgChart, { ref: window.__ref, spec, interaction, png, ...p })'
  const bareElement = variant === 'Chart'
    ? 'React.createElement(Chart, { key: i, spec: it.spec, ...it.props })'
    : 'React.createElement(SvgChart, { key: i, spec: it.spec, interaction, png, ...it.props })'
  return `
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
${imports}

window.__log = []
const rec = (name) => (...args) => { window.__log.push({ name, args: JSON.parse(JSON.stringify(args.map((a) => (a instanceof Error ? a.message : a)))) }) }
window.__mount = (spec, props, record, listen, hostCss) => {
  const host = document.getElementById('root')
  const container = document.createElement('div')
  container.id = 'chart-host'
  container.style.cssText = hostCss ?? 'position:relative;width:520px;height:340px'
  host.replaceChildren(container)
  window.__log = []
  const p = { ...props }
  for (const r of record || []) p[r] = rec(r)
  if (listen && listen.length) p.signalListeners = Object.fromEntries(listen.map((n) => [n, rec('signal:' + n)]))
  window.__ref = React.createRef()
  if (window.__root) window.__root.unmount()
  window.__root = createRoot(container)
  window.__spec = spec
  flushSync(() => window.__root.render(${element}))
}
// Render the mounted chart again with other props (the same root: an update, not a new chart).
window.__set = (props) => {
  const spec = window.__spec
  const p = { ...props }
  flushSync(() => window.__root.render(${element}))
}
// Several charts on one page between two plain buttons (the sequence a keyboard user tabs through); render again to update.
window.__page = (rawItems, mountAgain) => {
  // a prop given as '__fn' is a no-op callback (a function cannot cross from the test to the page)
  const items = rawItems.map((it) => ({ ...it, props: Object.fromEntries(Object.entries(it.props).map(([k, v]) => [k, v === '__fn' ? () => undefined : v])) }))
  const host = document.getElementById('root')
  if (!mountAgain || !window.__pageRoot) {
    if (window.__root) { window.__root.unmount(); window.__root = null }
    if (window.__pageRoot) window.__pageRoot.unmount()
    const container = document.createElement('div')
    container.id = 'chart-host'
    host.replaceChildren(container)
    window.__pageRoot = createRoot(container)
  }
  flushSync(() => window.__pageRoot.render(React.createElement('div', null,
    React.createElement('button', { id: 'before' }, 'before'),
    ...items.map((it, i) => React.createElement('div', { key: i, 'data-slot': i, style: { position: 'relative', width: 420, height: 260 } }, ${bareElement})),
    React.createElement('button', { id: 'after' }, 'after'))))
}
`
}

const baseSpec = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  $schema: 'https://vega.github.io/schema/vega/v6.json',
  width: 400, height: 240, padding: 30, autosize: 'none',
  signals: [
    { name: 'picked', value: null, on: [{ events: 'click', update: 'datum.cat' }] },
    { name: 'size', value: 200, bind: { input: 'range', min: 50, max: 900, step: 10 } },
    { name: 'mode', value: 2, bind: { input: 'select', options: [1, 2, 3] } },
    { name: 'show', value: true, bind: { input: 'checkbox' } },
  ],
  data: [{ name: 't', values: [{ px: 2, py: 2, cat: 'a' }, { px: 5, py: 5, cat: 'b' }, { px: 8, py: 8, cat: 'c' }] }],
  scales: [
    { name: 'xscale', type: 'linear', domain: [0, 10], range: 'width', nice: false },
    { name: 'yscale', type: 'linear', domain: [0, 10], range: 'height', nice: false },
  ],
  axes: [{ scale: 'xscale', orient: 'bottom' }, { scale: 'yscale', orient: 'left' }],
  marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: {
    x: { scale: 'xscale', field: 'px' }, y: { scale: 'yscale', field: 'py' },
    size: { signal: 'size' }, opacity: { signal: 'show ? 1 : 0.2' }, fill: { value: 'steelblue' },
    tooltip: { signal: 'datum' },
  } } }],
  ...extra,
})

/**
 * The spec, with the signals of `extra` in place of the usual ones. The marks read `size` and `show`, which vega's parser requires to be
 * declared: a spec that leaves them out declares them without a value (they stay undefined, as they did when nothing declared them).
 */
const spec = (extra: Record<string, unknown> = {}): Record<string, unknown> => {
  const out = baseSpec(extra)
  const declared = new Set((out.signals as Array<{ name: string }>).map((s) => s.name))
  const missing = ['size', 'show'].filter((name) => !declared.has(name)).map((name) => ({ name }))
  return missing.length ? { ...out, signals: [...(out.signals as unknown[]), ...missing] } : out
}

let failures = 0
const check = (ok: boolean, message: string): void => {
  if (ok) console.log(`  ok   ${message}`)
  else { failures++; console.log(`  FAIL ${message}`) }
}

interface Pt { x: number; y: number }
const markCenter = (page: Page, index: number): Promise<Pt> => page.evaluate((i) => {
  const r = document.querySelectorAll('svg .mark-symbol path')[i]!.getBoundingClientRect()
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
}, index)
const log = (page: Page): Promise<Array<{ name: string; args: unknown[] }>> => page.evaluate(() => (window as never as { __log: Array<{ name: string; args: unknown[] }> }).__log)
const mount = async (page: Page, s: Record<string, unknown>, props: Record<string, unknown>, record: string[] = [], listen: string[] = []): Promise<void> => {
  await page.evaluate(([sp, pr, rc, ls]) => (window as never as { __mount: (...a: unknown[]) => void }).__mount(sp, pr, rc, ls), [s, props, record, listen] as const)
  await page.waitForSelector(props.renderer === 'canvas' ? '#chart-host canvas' : 'svg .mark-symbol path')
}


/** Bundle one variant; returns the code and the dist-independent list of source modules it was made of. */
async function bundleVariant(variant: VariantName): Promise<{ code: string; inputs: string[] }> {
  const bundle = await build({
    stdin: { contents: entryFor(variant), resolveDir: HERE, loader: 'tsx', sourcefile: `entry-${variant}.tsx` },
    bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic', metafile: true,
    define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'error',
  })
  return { code: bundle.outputFiles[0]!.text, inputs: Object.keys(bundle.metafile.inputs).map((f) => f.replace(/\\/g, '/')) }
}

/** Where the keyboard focus is: the button, or which chart and what part of it. */
const focusSpot = (page: Page): Promise<string> => page.evaluate(() => {
  const a = document.activeElement as HTMLElement | null
  if (a == null || a === document.body) return 'body'
  if (a.id) return a.id
  const slot = a.closest('[data-slot]')?.getAttribute('data-slot')
  const node = a.closest('[data-a11y-id]')
  return `chart${slot}:${node ? 'node' : a.hasAttribute('data-aster-view') ? 'container' : a.tagName.toLowerCase()}`
})
/** Every element of the page's charts that sits in the sequential focus order (the container, nodes, anything else). */
const tabStopsPerChart = (page: Page): Promise<number[]> => page.evaluate(() => [...document.querySelectorAll('[data-slot]')].map((slot) =>
  [...slot.querySelectorAll('*')].filter((el) => (el as HTMLElement).tabIndex >= 0 && !(el instanceof SVGElement && el.tabIndex < 0)).length))
const press = async (page: Page, key: string, times = 1): Promise<void> => { for (let i = 0; i < times; i++) await page.keyboard.press(key) }

/** A chart is one tab stop: the real Tab key through a page of charts, in every configuration (it used to be two stops per chart). */
async function tabStopSuite(page: Page): Promise<void> {
  const base = { width: 400, height: 240 }
  const items = (): Array<{ spec: Record<string, unknown>; props: Record<string, unknown> }> => [
    { spec: spec({ signals: [] }), props: { ...base } },
    { spec: spec({ signals: [] }), props: { ...base, panZoom: true } },
    { spec: spec({ signals: [] }), props: { ...base, tooltip: true, onSelect: '__fn', ariaLabel: 'selectable' } },
    { spec: spec({ signals: [] }), props: { ...base, pan: true, tooltip: true } },
  ]
  const run = (mountAgain: boolean, its: ReturnType<typeof items>): Promise<void> =>
    page.evaluate(([a, again]) => (window as never as { __page: (...x: unknown[]) => void }).__page(a, again), [its, mountAgain] as const)

  console.log('[tab] a page of four charts: Tab visits exactly one element per chart')
  await run(false, items())
  await page.waitForSelector('svg .mark-symbol path')
  check((await tabStopsPerChart(page)).every((n) => n === 1), `one element per chart is in the tab order (${JSON.stringify(await tabStopsPerChart(page))})`)
  await page.focus('#before')
  const seen: string[] = []
  for (let i = 0; i < 6; i++) { await page.keyboard.press('Tab'); seen.push(await focusSpot(page)) }
  const expected = ['chart0:node', 'chart1:container', 'chart2:node', 'chart3:container', 'after', 'body']
  check(JSON.stringify(seen.slice(0, 5)) === JSON.stringify(expected.slice(0, 5)), `Tab walks chart0 (roving mark) -> chart1 (container) -> chart2 (roving mark) -> chart3 (container) -> after (${JSON.stringify(seen)})`)
  const back: string[] = []
  await page.focus('#after')
  for (let i = 0; i < 4; i++) { await page.keyboard.press('Shift+Tab'); back.push(await focusSpot(page)) }
  check(JSON.stringify(back) === JSON.stringify(['chart3:container', 'chart2:node', 'chart1:container', 'chart0:node']), `Shift+Tab walks back one stop per chart (${JSON.stringify(back)})`)

  console.log('[tab] pan/zoom: the container takes the pan/zoom keys; PageDown enters the nodes, arrows rove, Tab leaves')
  await page.focus('#before')
  await press(page, 'Tab', 2)
  check(await focusSpot(page) === 'chart1:container', `the zoomable chart is focused as a container (${await focusSpot(page)})`)
  const zoomed = (): Promise<string | null> => page.locator('[data-slot="1"] [data-aster-view]').first().getAttribute('data-aster-view')
  await page.keyboard.press('+')
  check(await zoomed() === 'zoomed', 'the container zooms with +')
  await page.keyboard.press('0')
  check(await zoomed() === 'base', 'and resets with 0')
  await page.keyboard.press('PageDown')
  check((await focusSpot(page)).startsWith('chart1:') && await focusSpot(page) !== 'chart1:container', `PageDown moves into the chart's nodes (${await focusSpot(page)})`)
  check((await tabStopsPerChart(page))[1] === 1, 'still one tab stop in the chart while a node has focus')
  await page.keyboard.press('Tab')
  check(await focusSpot(page) === 'chart2:node', `Tab from a node leaves the chart (${await focusSpot(page)})`)

  console.log('[tab] re-render, resize and spec swap keep one stop and never drop focus')
  await page.focus('#before')
  await press(page, 'Tab', 2)
  await page.keyboard.press('PageDown')
  const inChart = (): Promise<boolean> => page.evaluate(() => document.activeElement?.closest('[data-slot="1"]') != null)
  const wide = items().map((it) => ({ ...it, props: { ...it.props, width: 380 } }))
  await run(true, wide)
  check(await inChart(), `focus stays in the chart across a resize (${await focusSpot(page)})`)
  check((await tabStopsPerChart(page)).every((n) => n === 1), `still one stop per chart after the resize (${JSON.stringify(await tabStopsPerChart(page))})`)
  const swapped = wide.map((it) => ({ ...it, spec: spec({ signals: [], width: 300 }) }))
  await run(true, swapped)
  await page.waitForTimeout(30)
  check(await inChart(), `focus stays in the chart across a spec swap (${await focusSpot(page)})`)
  check((await tabStopsPerChart(page)).every((n) => n === 1), `one stop per chart after the swap (${JSON.stringify(await tabStopsPerChart(page))})`)
  await page.keyboard.press('Tab')
  check(await focusSpot(page) === 'chart2:node', `and Tab still goes on to the next chart (${await focusSpot(page)})`)
  // pan/zoom switched off then on while the container is focused
  await run(true, swapped.map((it, i) => i === 1 ? { ...it, props: { ...it.props, panZoom: false } } : it))
  check((await tabStopsPerChart(page)).every((n) => n === 1), `pan/zoom off: roving mark stop, one per chart (${JSON.stringify(await tabStopsPerChart(page))})`)
  await run(true, swapped)
  check((await tabStopsPerChart(page)).every((n) => n === 1), `pan/zoom on again: one per chart (${JSON.stringify(await tabStopsPerChart(page))})`)
  console.log('[tab] a click on the page body is not undone by a re-render')
  await page.focus('#before')
  await press(page, 'Tab', 2)
  await page.mouse.click(690, 5)
  await page.waitForTimeout(20)
  check(await focusSpot(page) === 'body', 'a click on the page body blurs the chart')
  await run(true, wide)
  check(await focusSpot(page) === 'body', `a deliberate click elsewhere keeps focus off the chart (${await focusSpot(page)})`)
}

/** Every interaction check, against whichever component the page was bundled with. */
async function suite(page: Page): Promise<void> {
  // ---- 1. marks stay reachable with every interaction prop --------------------------------
  const variants: Array<[string, Record<string, unknown>, string[]]> = [
    ['onSelect', {}, ['onSelect']],
    ['onPointSelect', {}, ['onPointSelect']],
    ['selection (controlled)', { selection: { type: 'interval', interval: { x: [1, 3] } } }, []],
    ['onSelectionChange', {}, ['onSelectionChange']],
    ['brush', { brush: { x: [1, 3] } }, []],
    ['panZoom', { panZoom: true }, []],
    ['pan', { pan: true }, []],
    ['zoom', { zoom: true }, []],
    ['everything', { panZoom: true }, ['onSelect', 'onPointSelect', 'onSelectionChange', 'onViewChange']],
  ]
  for (const [label, props, record] of variants) {
    console.log(`[reach] ${label}`)
    await mount(page, spec(), { width: 400, height: 240, tooltip: true, ...props }, record)
    const c = await markCenter(page, 1)
    const hit = await page.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y)
      return { inSvg: el?.closest('svg') != null, tag: el?.tagName, overlay: el?.closest('[data-testid="chart-brush-overlay"]') != null }
    }, c)
    check(hit.inSvg && !hit.overlay, `element under the pointer is the mark (got <${hit.tag}>, overlay=${hit.overlay})`)
    await page.mouse.move(c.x, c.y)
    await page.waitForTimeout(30)
    const tip = await page.locator('[data-testid="chart-tooltip"]').textContent({ timeout: 500 }).catch(() => null)
    check(tip != null && tip.includes('cat') && tip.includes('b'), `tooltip shows the hovered datum (${JSON.stringify(tip)})`)
  }

  // ---- 2. signal.on mark events + hit-index click ----------------------------------------
  console.log('[signal.on] click on a mark with onSelect/onPointSelect set')
  await mount(page, spec(), { width: 400, height: 240, panZoom: true }, ['onSelect', 'onPointSelect'], ['picked'])
  const c = await markCenter(page, 2)
  await page.mouse.click(c.x, c.y)
  await page.waitForTimeout(30)
  let entries = await log(page)
  const picked = entries.find((e) => e.name === 'signal:picked')
  check(picked != null && picked.args[1] === 'c', `signal.on click fired with the datum (${JSON.stringify(picked?.args)})`)
  const point = entries.find((e) => e.name === 'onPointSelect')
  check(point != null && (point.args[0] as { cat?: string } | null)?.cat === 'c', `onPointSelect resolved the same mark (${JSON.stringify(point?.args)})`)
  check(!entries.some((e) => e.name === 'onSelect' && e.args[0] !== null), 'a click is not reported as an interval')

  // ---- 2b. mark-scoped selectors resolve through the scene hit index (no tooltip, so no data-datum stamps) ---
  console.log('[signal.on] @name:click, symbol:click, rect:click and click[filter] in <Chart>')
  const scoped = spec({
    signals: [
      { name: 'byName', value: 'none', on: [{ events: '@dots:click', update: 'datum.cat' }] },
      { name: 'byType', value: 'none', on: [{ events: 'symbol:click', update: 'datum.cat + ":" + event.item.mark.name' }] },
      { name: 'byRect', value: 'none', on: [{ events: 'rect:click', update: 'event.item.mark.marktype + ":" + event.item.mark.name' }] },
      { name: 'other', value: 'none', on: [{ events: '@nothing:click', update: '"wrong"' }] },
      { name: 'shifted', value: 0, on: [{ events: 'click[event.shiftKey]', update: 'shifted + 1' }] },
      { name: 'overName', value: 'none', on: [{ events: '@dots:mouseover', update: 'datum.cat' }, { events: '@dots:mouseout', update: '"none"' }] },
    ],
    marks: [
      { type: 'rect', name: 'bars', encode: { update: { x: { value: 0 }, y: { value: 0 }, width: { value: 60 }, height: { value: 30 }, fill: { value: '#9ecae9' } } } },
      { type: 'symbol', name: 'dots', from: { data: 't' }, encode: { update: {
        x: { scale: 'xscale', field: 'px' }, y: { scale: 'yscale', field: 'py' }, size: { value: 300 }, fill: { value: 'steelblue' },
      } } },
    ],
  })
  await mount(page, scoped, { width: 400, height: 240 }, [], ['byName', 'byType', 'byRect', 'other', 'shifted', 'overName'])
  const dot = await markCenter(page, 1)
  await page.mouse.move(dot.x, dot.y)
  await page.waitForTimeout(30)
  await page.mouse.click(dot.x, dot.y)
  await page.waitForTimeout(30)
  const bar = await page.evaluate(() => {
    const r = document.querySelector('svg .mark-rect path')!.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })
  await page.mouse.click(bar.x, bar.y)
  await page.keyboard.down('Shift')
  await page.mouse.click(bar.x, bar.y)
  await page.keyboard.up('Shift')
  await page.waitForTimeout(30)
  entries = await log(page)
  const last = (n: string): unknown => entries.filter((e) => e.name === `signal:${n}`).map((e) => e.args[1]).at(-1)
  check(last('byName') === 'b', `@dots:click fired with the clicked datum (${JSON.stringify(last('byName'))})`)
  check(last('byType') === 'b:dots', `symbol:click sees event.item.mark.name (${JSON.stringify(last('byType'))})`)
  check(last('byRect') === 'rect:bars', `rect:click fired for the rect and carries its mark (${JSON.stringify(last('byRect'))})`)
  check(last('other') === undefined, `@nothing:click never fires (${JSON.stringify(last('other'))})`)
  check(last('shifted') === 1, `click[event.shiftKey] fired once, for the shifted click only (${JSON.stringify(last('shifted'))})`)
  check(entries.filter((e) => e.name === 'signal:overName').map((e) => e.args[1]).includes('b'), '@dots:mouseover fired with the hovered datum')

  // ---- 2c. the pointer maps to view units whatever the host does to the svg ----------------------------------
  // (vega-scenegraph point(): the inverse of the svg's screen CTM; the oracle here is the browser's own DOMMatrix inverse, so
  // agreement is to a thousandth of a pixel; exact agreement with vega is the selections gate's)
  console.log('[pointer] x() / y() in a CSS-scaled, bordered, transformed svg')
  const pointerSpec = spec({ signals: [{ name: 'at', value: null, on: [{ events: 'pointermove', update: '[x(), y()]' }] }] })
  for (const [label, css] of [
    ['unstyled', ''],
    ['max-width (scaled by its viewBox)', '#chart-host svg { max-width: 300px; height: auto }'],
    ['bordered and padded svg', '#chart-host svg { border: 7px solid #888; padding: 11px }'],
    ['under a CSS transform', '#chart-host { transform: scale(0.75); transform-origin: 20px 10px }'],
  ] as const) {
    await mount(page, pointerSpec, { width: 400, height: 240 }, [], ['at'])
    await page.evaluate((c) => { let st = document.getElementById('host-css'); if (!st) { st = document.createElement('style'); st.id = 'host-css'; document.head.appendChild(st) } st.textContent = c }, css)
    const pbox0 = await page.evaluate(() => { const r = document.querySelector('#chart-host svg')!.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height } })
    for (const [fx, fy] of [[0.3, 0.4], [0.8, 0.7]] as const) {
      const cx = pbox0.x + fx * pbox0.w
      const cy = pbox0.y + fy * pbox0.h
      await page.mouse.move(cx, cy)
      await page.waitForTimeout(30)
      const expected = await page.evaluate(({ cx, cy }) => {
        const svg = document.querySelector('#chart-host svg') as unknown as SVGSVGElement
        const p = new DOMPoint(cx, cy).matrixTransform(svg.getScreenCTM()!.inverse())
        return [p.x - 30, p.y - 30]
      }, { cx, cy })
      const got = (await log(page)).filter((e) => e.name === 'signal:at').at(-1)?.args[1] as number[] | undefined
      check(got != null && Math.abs(got[0]! - expected[0]!) < 1e-3 && Math.abs(got[1]! - expected[1]!) < 1e-3, `${label}: x(), y() at (${fx}, ${fy}) of the svg are ${JSON.stringify(expected.map((v) => +v.toFixed(3)))} (got ${JSON.stringify(got?.map((v) => +v.toFixed(3)))})`)
    }
  }

  // ---- 2d. tooltip and pan/zoom in a CSS-scaled / transformed svg ---------------------------------------------
  // (they read the pointer in the chart's own units, not in the container's pixels)
  console.log('[host css] tooltip finds the hovered mark, drag-pan moves by the right amount')
  const setCss = (css: string): Promise<void> => page.evaluate((c) => { let st = document.getElementById('host-css'); if (!st) { st = document.createElement('style'); st.id = 'host-css'; document.head.appendChild(st) } st.textContent = c }, css)
  for (const [label, css] of [
    ['max-width', '#chart-host svg { max-width: 300px; height: auto }'],
    ['CSS transform', '#chart-host { transform: scale(0.7); transform-origin: 30px 20px }'],
  ] as const) {
    // (batched svg marks: >= 512 symbols in one mark, so the tooltip resolves through the scene hit index, queryMark)
    const dense = spec({ signals: [], data: [{ name: 't', values: [{ px: 8, py: 8, cat: 'c' }, ...Array.from({ length: 600 }, (_, i) => ({ px: 0.2 + (i % 5) * 0.05, py: 0.2, cat: 'z' + i }))] }] })
    await mount(page, dense, { width: 400, height: 240, tooltip: true, denseMarks: true }, [])
    await page.waitForSelector('#chart-host svg')
    await setCss(css)
    const at = await page.evaluate(() => {
      const svg = document.querySelector('#chart-host svg') as unknown as SVGSVGElement
      // (x: 8 of [0, 10] over 400 units, y: 8 of [0, 10] over 240 units, upwards; the padding is 30)
      return new DOMPoint(30 + 0.8 * 400, 30 + 0.2 * 240).matrixTransform(svg.getScreenCTM()!)
    })
    await page.mouse.move(at.x, at.y)
    await page.waitForTimeout(40)
    const tip2 = await page.locator('[data-testid="chart-tooltip"]').textContent({ timeout: 500 }).catch(() => null)
    check(tip2 != null && tip2.includes('cat') && tip2.includes('c'), `${label}: the tooltip over a mark shows that mark (${JSON.stringify(tip2)})`)
    await mount(page, spec({ signals: [] }), { width: 400, height: 240, pan: true }, ['onViewChange'])
    await setCss(css)
    const sc = await page.evaluate(() => { const svg = document.querySelector('#chart-host svg') as unknown as SVGSVGElement; return svg.getScreenCTM()!.a })
    const pb = await page.locator('#chart-host').boundingBox()
    await page.mouse.move(pb!.x + 100, pb!.y + 100)
    await page.mouse.down()
    await page.mouse.move(pb!.x + 140, pb!.y + 100, { steps: 4 })
    await page.mouse.up()
    const view = (await log(page)).filter((e) => e.name === 'onViewChange').at(-1)?.args[0] as { x?: number[] } | undefined
    // 40 css px = 40/sc chart units; the plot is 400 units for the domain [0, 10]: the data moves with the pointer
    const shift = view?.x != null ? -view.x[0]! : NaN
    const want = (40 / sc) / 400 * 10
    check(Math.abs(shift - want) < 0.01, `${label}: dragging 40 css px pans the domain by ${want.toFixed(3)} (got ${Number.isNaN(shift) ? shift : shift.toFixed(3)})`)
  }
  await page.evaluate(() => { document.getElementById('host-css')?.remove() })

  // ---- 3. bound inputs ----------------------------------------------------------------------
  console.log('[binds] range / select / checkbox with brush + pan/zoom enabled')
  await mount(page, spec(), { width: 400, height: 240, panZoom: true }, ['onSelect', 'onPointSelect'], ['size', 'mode', 'show'])
  const sizeBefore = await page.evaluate(() => document.querySelector('svg .mark-symbol path')!.getAttribute('d'))
  await page.locator('input[type="range"]').fill('700')
  await page.locator('select').selectOption({ index: 2 })
  await page.locator('input[type="checkbox"]').click()
  await page.waitForTimeout(30)
  entries = await log(page)
  const sig = (n: string) => entries.filter((e) => e.name === `signal:${n}`).map((e) => e.args[1])
  check(sig('size').includes(700), `range input notified listeners (${JSON.stringify(sig('size'))})`)
  check(sig('mode').includes(3), `select keeps the numeric option value (${JSON.stringify(sig('mode'))})`)
  check(sig('show').includes(false), `checkbox notified listeners (${JSON.stringify(sig('show'))})`)
  const sizeAfter = await page.evaluate(() => document.querySelector('svg .mark-symbol path')!.getAttribute('d'))
  check(sizeBefore !== sizeAfter, 'the chart re-rendered with the new signal values')
  check(!entries.some((e) => e.name === 'onSelect' || e.name === 'onPointSelect'), 'operating the inputs did not start a brush/click gesture on the chart')

  // ---- 4. brush ---------------------------------------------------------------------------------
  console.log('[brush] drag selects an interval on xscale/yscale')
  await mount(page, spec({ signals: [] }), { width: 400, height: 240 }, ['onSelect', 'onSelectionChange'])
  const box = await page.locator('#chart-host').boundingBox()
  await page.mouse.move(box!.x + 80, box!.y + 60)
  await page.mouse.down()
  await page.mouse.move(box!.x + 200, box!.y + 140, { steps: 6 })
  const drawing = await page.evaluate(() => {
    const overlay = document.querySelector('[data-testid="chart-brush-overlay"]')!
    return overlay.firstElementChild != null
  })
  check(drawing, 'the live selection rectangle is drawn during the drag')
  await page.mouse.up()
  entries = await log(page)
  const interval = entries.filter((e) => e.name === 'onSelect').at(-1)?.args[0] as { x?: number[]; y?: number[] } | null | undefined
  check(interval != null && interval.x != null && interval.y != null && interval.x[1]! > interval.x[0]!, `onSelect interval on named scales (${JSON.stringify(interval)})`)

  // ---- 5. pan / zoom --------------------------------------------------------------------------
  console.log('[pan/zoom] named scales; pointer capture; no stuck gesture')
  await mount(page, spec({ signals: [] }), { width: 400, height: 240, panZoom: true }, ['onViewChange'])
  const pbox = await page.locator('#chart-host').boundingBox()
  await page.mouse.move(pbox!.x + 150, pbox!.y + 100)
  await page.mouse.wheel(0, -300)
  await page.waitForTimeout(30)
  check((await page.locator('#chart-host > div').first().getAttribute('data-aster-view')) === 'zoomed', 'wheel zooms (view is zoomed)')
  await page.keyboard.press('0')
  await page.mouse.move(pbox!.x + 100, pbox!.y + 100)
  await page.mouse.wheel(0, -300)
  await page.mouse.down()
  await page.mouse.move(pbox!.x + 160, pbox!.y + 100, { steps: 4 })
  // leave the element entirely while dragging: capture must keep the gesture alive
  await page.mouse.move(pbox!.x + 700 > 690 ? 690 : pbox!.x + 700, pbox!.y + 100, { steps: 4 })
  await page.mouse.up()
  entries = await log(page)
  const countAfterDrag = entries.filter((e) => e.name === 'onViewChange').length
  await page.mouse.move(pbox!.x + 200, pbox!.y + 120, { steps: 4 })
  const stuck = (await log(page)).filter((e) => e.name === 'onViewChange').length - countAfterDrag
  check(countAfterDrag >= 3, `drag pans the view (${countAfterDrag} view changes)`)
  check(stuck === 0, 'releasing the button outside the chart does not leave a gesture stuck on')

  // ---- 6. a11y nodes sit on their marks (padding included) ------------------------
  console.log('[a11y] nodes overlay the rendered marks')
  await mount(page, spec({ signals: [] }), { width: 400, height: 240 })
  const offsets = await page.evaluate(() => {
    const marks = [...document.querySelectorAll('svg .mark-symbol path')].map((p) => p.getBoundingClientRect())
    const nodes = [...document.querySelectorAll('[data-a11y-kind="mark"]')].map((n) => n.getBoundingClientRect())
    return marks.map((m, i) => {
      const n = nodes[i]!
      return Math.hypot((m.left + m.width / 2) - (n.left + n.width / 2), (m.top + m.height / 2) - (n.top + n.height / 2))
    })
  })
  check(offsets.length === 3 && offsets.every((d) => d < 4), `a11y mark nodes are centred on their symbols (offsets ${offsets.map((d) => d.toFixed(1)).join(', ')} px)`)
  const stops = await page.evaluate(() => [...document.querySelectorAll('[data-a11y-id]')].filter((n) => (n as HTMLElement).tabIndex >= 0).length)
  check(stops === 1, `exactly one a11y tab stop (${stops})`)

  // ---- 7. a11y roving focus and keyboard selection ---------------------------------------------
  console.log('[a11y] roving tabindex, PageDown/ArrowRight move focus, Enter selects, Escape clears')
  await mount(page, spec({ signals: [] }), { width: 400, height: 240 }, ['onPointSelect', 'onSelectionChange'])
  const firstNode = await page.evaluate(() => {
    const n = [...document.querySelectorAll('[data-a11y-id]')].find((e) => (e as HTMLElement).tabIndex >= 0) as HTMLElement
    n.focus()
    return n.getAttribute('data-a11y-id')
  })
  await page.keyboard.press('PageDown')
  const afterPage = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.getAttribute('data-a11y-id') ?? null)
  check(firstNode != null && afterPage != null && afterPage !== firstNode, `PageDown moves focus to the next a11y node (${firstNode} -> ${afterPage})`)
  const tabStops = await page.evaluate(() => [...document.querySelectorAll('[data-a11y-id]')].filter((n) => (n as HTMLElement).tabIndex >= 0).map((n) => n.getAttribute('data-a11y-id')))
  check(tabStops.length === 1 && tabStops[0] === afterPage, `the tab stop followed the focus (${JSON.stringify(tabStops)})`)
  await page.evaluate(() => (document.querySelector('[data-a11y-kind="mark"]') as HTMLElement).focus())
  await page.keyboard.press('ArrowRight')
  const onMark = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.getAttribute('data-a11y-kind'))
  check(onMark === 'mark', `ArrowRight moves between marks (${onMark})`)
  await page.keyboard.press('Enter')
  entries = await log(page)
  const chosen = entries.filter((e) => e.name === 'onPointSelect').at(-1)?.args[0] as { cat?: string } | null | undefined
  check(chosen != null && chosen.cat === 'b', `Enter selects the focused mark's datum (${JSON.stringify(chosen)})`)
  const pressed = await page.evaluate(() => document.activeElement?.getAttribute('aria-pressed'))
  check(pressed === 'true', `the selected mark is aria-pressed (${pressed})`)
  await page.keyboard.press('Escape')
  entries = await log(page)
  check(entries.filter((e) => e.name === 'onSelectionChange').at(-1)?.args[0] === null, 'Escape clears the selection')

  // ---- 8. selection values -------------------------------------------------------------------
  console.log('[selection] a click reports a point, a drag an interval, both through onSelectionChange')
  await mount(page, spec({ signals: [] }), { width: 400, height: 240 }, ['onSelectionChange'])
  const bx = await page.locator('#chart-host').boundingBox()
  const m0 = await markCenter(page, 0)
  await page.mouse.click(m0.x, m0.y)
  entries = await log(page)
  const sel1 = entries.filter((e) => e.name === 'onSelectionChange').at(-1)?.args[0] as { type?: string; datum?: { cat?: string } } | null | undefined
  check(sel1?.type === 'point' && sel1.datum?.cat === 'a', `click -> point selection of the clicked mark (${JSON.stringify(sel1)})`)
  await page.mouse.move(bx!.x + 80, bx!.y + 60)
  await page.mouse.down()
  await page.mouse.move(bx!.x + 200, bx!.y + 140, { steps: 5 })
  await page.mouse.up()
  entries = await log(page)
  const sel2 = entries.filter((e) => e.name === 'onSelectionChange').at(-1)?.args[0] as { type?: string; interval?: { x?: number[] } } | null | undefined
  check(sel2?.type === 'interval' && sel2.interval?.x != null, `drag -> interval selection (${JSON.stringify(sel2)})`)
  const persisted = await page.evaluate(() => document.querySelector('[data-testid="chart-brush-overlay"]')?.children.length ?? 0)
  check(persisted === 1, 'the interval stays drawn after release')

  // ---- 9. default actions: a drag selects no text, a wheel still scrolls the page ------------------
  // vega's view prevents the default action of the view events a stream listens to (all but `wheel`, config.events.defaults
  // {allow: ['wheel']}). Without it the drag of an interval brush also drags a text selection over the axis labels and the
  // page around the chart, and a mouse wheel over a chart that does not zoom must still scroll the page.
  console.log('[default actions] an interval-selection drag selects no text; a wheel over a non-zoomable chart scrolls the page')
  const brushSpec = compileVl({
    $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
    width: 300, height: 160,
    data: { values: [{ a: 1, b: 2 }, { a: 3, b: 5 }, { a: 6, b: 4 }, { a: 8, b: 9 }] },
    params: [{ name: 'brush', select: 'interval' }],
    mark: 'point',
    encoding: { x: { field: 'a', type: 'quantitative' }, y: { field: 'b', type: 'quantitative' } },
  } as never) as Record<string, unknown>
  const wheelSpec = spec({ signals: [{ name: 'w', value: 0, on: [{ events: 'wheel', update: 'event.deltaY' }] }] })
  await page.evaluate(() => {
    const before = document.createElement('p'); before.id = 'text-before'; before.textContent = 'Selectable text above the chart. '.repeat(6)
    const after = document.createElement('p'); after.id = 'text-after'; after.textContent = 'Selectable text below the chart. '.repeat(12)
    const tall = document.createElement('div'); tall.id = 'tall'; tall.style.height = '1500px'
    const root = document.getElementById('root')!
    root.before(before); root.after(after); after.after(tall)
    window.getSelection()!.removeAllRanges()
  })
  await mount(page, brushSpec, { width: 400, height: 240 }, [], ['brush_x'])
  const hbox = await page.locator('#chart-host').boundingBox()
  const afterBox = await page.locator('#text-after').boundingBox()
  // end points of the drag: over the axis labels to the left of the plot, below the x axis, and out over the text below
  const ends: Array<[string, Pt]> = [
    ['over the y axis labels', { x: hbox!.x + 10, y: hbox!.y + 60 }],
    ['over the x axis labels', { x: hbox!.x + 120, y: hbox!.y + 200 }],
    ['out over the page text', { x: afterBox!.x + 200, y: afterBox!.y + 15 }],
  ]
  // a first drag draws the brush; the next ones start inside it (the brush moves) and outside it (a new brush)
  await page.mouse.move(hbox!.x + 120, hbox!.y + 60)
  await page.mouse.down()
  await page.mouse.move(hbox!.x + 200, hbox!.y + 110, { steps: 5 })
  await page.mouse.up()
  const brush = (await log(page)).filter((e) => e.name === 'signal:brush_x').at(-1)?.args[1] as number[] | undefined
  check(Array.isArray(brush) && brush.length === 2 && brush[1]! > brush[0]!, `the drag brushed an interval (${JSON.stringify(brush)})`)
  const starts: Array<[string, Pt]> = [['starting inside the brush', { x: hbox!.x + 140, y: hbox!.y + 85 }], ['starting outside the brush', { x: hbox!.x + 270, y: hbox!.y + 40 }]]
  for (const [from, start] of starts) {
    for (const [where, end] of ends) {
      await page.evaluate(() => window.getSelection()!.removeAllRanges())
      await page.mouse.move(start.x, start.y)
      await page.mouse.down()
      await page.mouse.move(start.x - 15, start.y + 10, { steps: 3 })
      await page.mouse.move(end.x, end.y, { steps: 8 })
      const selected = await page.evaluate(() => window.getSelection()!.toString())
      await page.mouse.up()
      check(selected === '', `dragging an interval brush ${from} and ${where} selects no text (${JSON.stringify(selected.slice(0, 40))})`)
    }
  }
  await mount(page, wheelSpec, { width: 400, height: 240 }, [], ['w'])
  await page.evaluate(() => {
    const w = window as never as { __wheel: boolean[] }
    w.__wheel = []
    document.addEventListener('wheel', (e) => w.__wheel.push(e.defaultPrevented), { passive: true })
  })
  const wbox = await page.locator('#chart-host').boundingBox()
  await page.mouse.move(wbox!.x + 150, wbox!.y + 100)
  const scrollBefore = await page.evaluate(() => window.scrollY)
  await page.mouse.wheel(0, 200)
  await page.waitForTimeout(100)
  const wheelSeen = await page.evaluate(() => (window as never as { __wheel: boolean[] }).__wheel)
  const wheelLog = (await log(page)).filter((e) => e.name === 'signal:w')
  check(wheelLog.length > 0, 'the wheel stream of the chart handled the wheel event')
  check(wheelSeen.length > 0 && wheelSeen.every((p) => !p), `a wheel event over a chart that listens to it is not prevented (${JSON.stringify(wheelSeen)})`)
  check((await page.evaluate(() => window.scrollY)) > scrollBefore, 'and the page scrolls')
  await page.evaluate(() => { window.scrollTo(0, 0); for (const id of ['text-before', 'text-after', 'tall']) document.getElementById(id)!.remove() })
}

/**
 * The cursor of the hovered item (vega-view cursor.js): a Vega-Lite selection bound to the legend gives its symbols, labels and
 * entries `cursor: pointer`, so the container shows the pointer while the mouse is over the legend, as in vega, and
 * is back to the default off it. Real mouse input in real Chromium, on the SVG renderer and (where there is one) on canvas.
 */
async function cursorSuite(page: Page, renderers: Array<'svg' | 'canvas'>): Promise<void> {
  const legendSpec = compileVl({
    $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
    width: 300, height: 160,
    data: { values: [{ a: 1, b: 2, c: 'p' }, { a: 3, b: 5, c: 'q' }, { a: 6, b: 4, c: 'r' }] },
    params: [{ name: 'pick', select: { type: 'point', fields: ['c'] }, bind: 'legend' }],
    mark: 'point',
    encoding: {
      x: { field: 'a', type: 'quantitative' }, y: { field: 'b', type: 'quantitative' },
      color: { field: 'c', type: 'nominal' },
      opacity: { condition: { param: 'pick', value: 1 }, value: 0.2 },
    },
  } as never) as Record<string, unknown>
  const cursorOf = (): Promise<string> => page.evaluate(() => getComputedStyle(document.querySelector('#chart-host > div')!).cursor)
  // where the legend's parts are, measured on the SVG rendition (the canvas has no elements to measure)
  await mount(page, legendSpec, { width: 520, height: 240 })
  // (no named inner functions: the page function is serialized, and a bundler's name helper would not exist there)
  const parts = await page.evaluate(() => {
    const symbol = document.querySelectorAll('svg .role-legend-symbol path')[1]!.getBoundingClientRect()
    const label = document.querySelectorAll('svg .role-legend-label text')[2]!.getBoundingClientRect()
    const entry = document.querySelectorAll('svg .role-legend-entry .role-scope path.background')[0]!.getBoundingClientRect()
    const host = document.querySelector('#chart-host')!.getBoundingClientRect()
    return {
      symbol: { x: symbol.left + symbol.width / 2, y: symbol.top + symbol.height / 2 },
      label: { x: label.left + label.width / 2, y: label.top + label.height / 2 },
      entry: { x: entry.left + 2, y: entry.top + 2 },
      plain: { x: host.left + 8, y: host.top + 8 },
    }
  })
  for (const renderer of renderers) {
    console.log(`[cursor] a legend-bound selection shows the pointer over the legend and not off it (${renderer})`)
    await mount(page, legendSpec, { width: 520, height: 240, renderer })
    await page.mouse.move(parts.plain.x, parts.plain.y)
    check((await cursorOf()) === 'default', `${renderer}: off the legend the cursor is the default (${await cursorOf()})`)
    for (const [what, pt] of [['symbol', parts.symbol], ['label', parts.label], ['entry', parts.entry]] as const) {
      await page.mouse.move(pt.x, pt.y)
      check((await cursorOf()) === 'pointer', `${renderer}: over a legend ${what} the cursor is the pointer (${await cursorOf()})`)
      await page.mouse.move(parts.plain.x, parts.plain.y)
      check((await cursorOf()) === 'default', `${renderer}: back off the legend the cursor resets (${await cursorOf()})`)
    }
    // a click on the legend re-renders the chart (the selection changes) while the pointer stays on it: the cursor stays
    await page.mouse.move(parts.symbol.x, parts.symbol.y)
    await page.mouse.click(parts.symbol.x, parts.symbol.y)
    await page.waitForTimeout(30)
    check((await cursorOf()) === 'pointer', `${renderer}: the cursor stays the pointer through the re-render a click causes (${await cursorOf()})`)
  }

  // The container's rect is cached between moves; the point must stay exact where the page is scrolled and where an ancestor
  // is CSS-transformed (vega-scenegraph point(): client position minus the element's bounding rect).
  const layouts: Array<[string, string]> = [
    ['a scrolled page', 'document.getElementById("pad").style.height="400px"; window.scrollTo(0, 170)'],
    ['a scaled, translated ancestor', 'document.getElementById("pad").style.height="0"; window.scrollTo(0, 0); document.getElementById("root").style.cssText="transform-origin:0 0;transform:translate(37px,23px) scale(0.8)"'],
  ]
  await page.evaluate(() => { const pad = document.createElement('div'); pad.id = 'pad'; document.getElementById('root')!.before(pad) })
  for (const [name, setup] of layouts) {
    await page.evaluate(setup)
    for (const renderer of renderers) {
      await mount(page, legendSpec, { width: 520, height: 240 })
      const at = await page.evaluate(() => {
        const sym = document.querySelectorAll('svg .role-legend-symbol path')[1]!.getBoundingClientRect()
        const host = document.querySelector('#chart-host')!.getBoundingClientRect()
        return { sx: sym.left + sym.width / 2, sy: sym.top + sym.height / 2, hx: host.left + 8, hy: host.top + 8 }
      })
      await mount(page, legendSpec, { width: 520, height: 240, renderer })
      await page.mouse.move(at.hx, at.hy)
      check((await cursorOf()) === 'default', `${renderer}, ${name}: off the legend the cursor is the default (${await cursorOf()})`)
      await page.mouse.move(at.sx, at.sy)
      check((await cursorOf()) === 'pointer', `${renderer}, ${name}: over the legend symbol the cursor is the pointer (${await cursorOf()})`)
      await page.mouse.move(at.sx - 40, at.sy)
      check((await cursorOf()) === 'default', `${renderer}, ${name}: 40px left of the symbol it is the default (${await cursorOf()})`)
    }
  }
  await page.evaluate(() => { document.getElementById('pad')!.remove(); document.getElementById('root')!.style.cssText = ''; window.scrollTo(0, 0) })
}

/**
 * `transition`: new data is drawn as real frames (requestAnimationFrame in Chromium), and the last one is exactly the svg a
 * chart without `transition` draws for that data.
 */
async function transitionSuite(page: Page): Promise<void> {
  console.log('[transition] a change of data animates over real frames and settles on the exact final svg')
  const bars = {
    $schema: 'https://vega.github.io/schema/vega/v6.json',
    width: 400, height: 240, padding: 30, autosize: 'none', data: [{ name: 't' }],
    scales: [{ name: 'y', type: 'linear', domain: [0, 10], range: 'height' }],
    axes: [{ scale: 'y', orient: 'left' }],
    marks: [{ type: 'rect', from: { data: 't' }, key: 'k', encode: { update: {
      x: { signal: "datum.k === 'a' ? 20 : 220" }, width: { value: 100 }, y: { scale: 'y', field: 'v' }, y2: { scale: 'y', value: 0 },
      fill: { field: 'c' },
    } } }],
  }
  const rows = (va: number, ca: string) => ({ t: [{ k: 'a', v: va, c: ca }, { k: 'b', v: 5, c: 'steelblue' }] })
  const transition = { duration: 400, easing: 'linear' }
  await mount2(page, bars, { width: 460, height: 300, data: rows(2, '#ff0000'), transition })
  await page.waitForTimeout(100) // the interpolation module the prop asked for (it is in this bundle: an import, no fetch)
  // sample the first bar on every frame from the update until the transition is over (a string: the page function must not be
  // transpiled, whose name helper would not exist in the page)
  const next = { width: 460, height: 300, data: rows(8, '#0000ff'), transition }
  const seen = await page.evaluate(`new Promise((resolve) => {
    const out = { d: [], fill: [] }
    window.__set(${JSON.stringify(next)})
    const t0 = performance.now()
    const sample = () => {
      const bar = document.querySelector('svg .mark-rect path')
      out.d.push(bar.getAttribute('d'))
      out.fill.push(bar.getAttribute('fill'))
      if (performance.now() - t0 < 700) requestAnimationFrame(sample)
      else resolve(out)
    }
    sample()
  })`) as { d: string[]; fill: string[] }
  const heights = seen.d.map((d) => Number(/v([-\d.e]+)/.exec(d)?.[1]))
  const distinct = new Set(seen.d)
  check(distinct.size >= 6, `the bar is drawn at ${distinct.size} distinct heights over the frames (at least 6)`)
  const first = heights[0]!
  const last = heights.at(-1)!
  check(first < last && heights.some((h) => h > first + 1 && h < last - 1), `it grows through intermediate heights (${first} .. ${last})`)
  check(heights.every((h, i) => i === 0 || h >= heights[i - 1]! - 1e-9), 'monotonically (a linear transition in one direction)')
  check(seen.fill.some((f) => /^rgb\(/.test(f)) && seen.fill[0] === '#ff0000' && seen.fill.at(-1) === '#0000ff', `its colour is mixed in between (${seen.fill[0]} .. ${seen.fill.at(-1)})`)
  const settled = await page.evaluate(() => document.querySelector('#chart-host svg')!.outerHTML)
  await mount2(page, bars, { width: 460, height: 300, data: rows(8, '#0000ff') })
  const fresh = await page.evaluate(() => document.querySelector('#chart-host svg')!.outerHTML)
  check(settled === fresh, 'the settled svg is exactly the one a chart without `transition` draws')
}

const mount2 = async (page: Page, s: Record<string, unknown>, props: Record<string, unknown>): Promise<void> => {
  await page.evaluate(([sp, pr]) => (window as never as { __mount: (...a: unknown[]) => void }).__mount(sp, pr, [], []), [s, props] as const)
  await page.waitForSelector('svg .mark-rect path')
}

/** `<SvgChart>` without `interaction`: renders, keeps what needs no hit testing, reports the rest. */
async function plainSuite(page: Page): Promise<void> {
  console.log('[SvgChart without interaction] renders, brushes and zooms; reports what it cannot do')
  await mount(page, spec({ signals: [] }), { width: 400, height: 240, panZoom: true }, ['onSelect', 'onViewChange'])
  const c = await markCenter(page, 1)
  const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('svg') != null, c)
  check(hit, 'the marks are reachable')
  const pbox = await page.locator('#chart-host').boundingBox()
  await page.mouse.move(pbox!.x + 150, pbox!.y + 100)
  await page.mouse.wheel(0, -300)
  await page.waitForTimeout(30)
  check((await page.locator('#chart-host > div').first().getAttribute('data-aster-view')) === 'zoomed', 'wheel zoom works without interaction')
  await page.keyboard.press('0')
  await page.mouse.move(pbox!.x + 80, pbox!.y + 60)
  await page.mouse.down()
  await page.mouse.move(pbox!.x + 200, pbox!.y + 140, { steps: 6 })
  await page.mouse.up()
  let entries = await log(page)
  const interval = entries.filter((e) => e.name === 'onSelect').at(-1)?.args[0] as { x?: number[] } | null | undefined
  check(interval != null && interval.x != null, `interval brush (onSelect) works without interaction (${JSON.stringify(interval)})`)

  const streams = spec({ signals: [{ name: 'picked', value: null, on: [{ events: 'click', update: 'datum.cat' }] }] })
  await mount(page, streams, { width: 400, height: 240 }, ['onError'])
  const rendered = await page.evaluate(() => document.querySelectorAll('svg .mark-symbol path').length)
  check(rendered === 3, 'an event-stream spec still renders its marks')
  entries = await log(page)
  const errs = entries.filter((e) => e.name === 'onError').map((e) => String(e.args[0]))
  check(errs.length === 1 && /event streams \(signal\.on\)/.test(errs[0]!) && /@aster-charts\/react\/interaction/.test(errs[0]!), `an event-stream spec reports the documented error (${JSON.stringify(errs)})`)
  const stamped = await page.evaluate(() => document.querySelectorAll('[data-datum]').length)
  check(stamped === 0, 'and no data-datum is stamped (nothing reads it)')
}

const MODULES: Record<VariantName, Array<[RegExp, boolean, string]>> = {
  Chart: [[/core\/dist\/canvas\.js$/, true, 'the canvas renderer'], [/core\/dist\/hit\.js$/, true, 'the hit index'], [/core\/dist\/signals\.js$/, true, 'the signal loop']],
  'SvgChart+interaction': [[/core\/dist\/canvas\.js$/, false, 'the canvas renderer'], [/src\/canvas-capability\.ts$/, false, 'the canvas capability'], [/core\/dist\/hit\.js$/, true, 'the hit index'], [/core\/dist\/signals\.js$/, true, 'the signal loop']],
  SvgChart: [[/core\/dist\/canvas\.js$/, false, 'the canvas renderer'], [/src\/canvas-capability\.ts$/, false, 'the canvas capability'], [/core\/dist\/hit\.js$/, false, 'the hit index'], [/core\/dist\/signals\.js$/, false, 'the signal loop'], [/src\/interaction-capability\.ts$/, false, 'the interaction capability'], [/core\/dist\/png\.js$/, false, 'the PNG painter']],
  // asked for: the PNG painter and the canvas renderer it paints with (a bundler that splits code fetches them on the first export)
  'SvgChart+png': [[/core\/dist\/png\.js$/, true, 'the PNG painter'], [/core\/dist\/canvas\.js$/, true, 'the canvas renderer'], [/src\/canvas-capability\.ts$/, false, 'the canvas capability'], [/core\/dist\/hit\.js$/, false, 'the hit index'], [/core\/dist\/signals\.js$/, false, 'the signal loop']],
}

/**
 * Issue #128: a chart without size props fills its container with its whole box (padding, guides and the bound inputs
 * under it included), so a container whose height is the chart's own (a block <div>) keeps it instead of growing on
 * every measurement, and a container of fixed size is filled exactly.
 */
async function sizingSuite(page: Page): Promise<void> {
  const heights = async (frames: number): Promise<number[]> => {
    const out: number[] = []
    for (let i = 0; i < frames; i++) {
      out.push(await page.evaluate(() => new Promise<number>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(document.getElementById('chart-host')!.getBoundingClientRect().height))))))
    }
    return out
  }
  const pad = spec({ autosize: 'pad' })
  const unsized = { ariaLabel: 'unsized' }
  // a block container with no height: its height is the chart's
  await page.evaluate(([sp, pr]) => (window as never as { __mount: (...a: unknown[]) => void }).__mount(sp, pr, [], [], 'width:520px'), [pad, unsized] as const)
  await page.waitForSelector('svg .mark-symbol path')
  const block = await heights(12)
  check(block[0]! > 0 && block.every((h) => h === block[0]), `a block container with no height keeps the chart's height (${JSON.stringify(block)})`)
  // a spec that sizes its height from the container (vega-lite's height: "container"), in the same block container
  // (as vega-lite compiles it: no top-level height, a `height` signal that reads the container)
  const fromContainer = spec({
    height: undefined,
    autosize: { type: 'fit-y', contains: 'padding' },
    signals: [...(pad.signals as unknown[]), { name: 'height', init: 'isFinite(containerSize()[1]) ? containerSize()[1] : 300' }],
  })
  await page.evaluate(([sp, pr]) => (window as never as { __mount: (...a: unknown[]) => void }).__mount(sp, pr, [], [], 'width:520px'), [fromContainer, unsized] as const)
  await page.waitForSelector('svg .mark-symbol path')
  const fit = await heights(12)
  check(fit[0]! > 0 && fit.every((h) => h === fit[0]), `a container-sized height in a block container does not creep (${JSON.stringify(fit)})`)
  // a container of fixed size: the chart's box is the container's, less the bound inputs under it
  await page.evaluate(([sp, pr]) => (window as never as { __mount: (...a: unknown[]) => void }).__mount(sp, pr, [], [], 'position:relative;width:520px;height:340px'), [pad, unsized] as const)
  await page.waitForSelector('svg .mark-symbol path')
  await heights(4)
  const box = await page.evaluate(() => {
    const svg = document.querySelector('#chart-host svg')!.getBoundingClientRect()
    const binds = document.querySelector('#chart-host [data-aster-binds]')?.getBoundingClientRect().height ?? 0
    return { w: svg.width, h: svg.height, binds }
  })
  check(box.w === 520 && Math.abs(box.h + box.binds - 340) < 1, `a 520x340 container is filled exactly: svg ${box.w}x${box.h} + bound inputs ${box.binds}`)
}

/**
 * `getPng` (#144) in a real browser. On a page whose Content-Security-Policy allows no `blob:` and no `data:` image (checked: the
 * usual recipe, the svg loaded into an `<img>` from a `blob:` url, fails on it), the PNG decodes to exactly the pixels
 * `renderSceneToCanvas` paints for the chart's scene at that scale. An image mark served with CORS is in the PNG; one whose server
 * does not send CORS headers is left out (vega's canvas loads images as `crossOrigin = "anonymous"` too) and reported.
 */
async function pngSuite(browser: Awaited<ReturnType<typeof chromium.launch>>, variant: VariantName, code: string): Promise<void> {
  console.log(`[getPng] ${variant}: the PNG is the canvas renderer's pixels, under a strict img-src, with CORS image marks`)
  const page = await browser.newPage({ viewport: { width: 700, height: 500 } })
  page.on('pageerror', (e) => { failures++; console.log(`  FAIL page error: ${e.message}`) })
  // a red and a blue 8x8 PNG, made by this browser on a page of its own
  const maker = await browser.newPage()
  const pngOf = async (color: string): Promise<Buffer> => Buffer.from(await maker.evaluate(async (c) => {
    const k = document.createElement('canvas'); k.width = 8; k.height = 8
    const g = k.getContext('2d')!; g.fillStyle = c; g.fillRect(0, 0, 8, 8)
    const blob = await new Promise<Blob>((r) => k.toBlob((b) => r(b!), 'image/png'))
    return [...new Uint8Array(await blob.arrayBuffer())]
  }, color))
  const red = await pngOf('#ff0000')
  const blue = await pngOf('#0000ff')
  await maker.close()
  // The images come from a real server on another origin than the page, so the browser applies CORS itself (a response a route
  // fulfils is not held to it). The page is served by the same server on a second port: two origins, no interception.
  const served: string[] = []
  const server = createServer((req, res) => {
    served.push(req.url ?? '')
    if (req.url === '/cors.png') res.writeHead(200, { 'content-type': 'image/png', 'access-control-allow-origin': '*' }).end(red)
    else if (req.url === '/nocors.png') res.writeHead(200, { 'content-type': 'image/png' }).end(blue)
    else res.writeHead(404).end()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const imgOrigin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const pageServer = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' }).end(
      `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="img-src ${imgOrigin}"></head><body style="margin:0;font:12px sans-serif"><div id="root"></div></body></html>`,
    )
  })
  await new Promise<void>((r) => pageServer.listen(0, '127.0.0.1', r))
  const close = (): Promise<void> => Promise.all([server, pageServer].map((sv) => new Promise<void>((r) => { sv.closeAllConnections(); sv.close(() => r()) }))).then(() => undefined)
  try {
  await page.goto(`http://localhost:${(pageServer.address() as AddressInfo).port}/`)
  await page.addScriptTag({ content: code })

  // the CSP is in force: the usual recipe (the svg as a blob: url in an <img>) cannot load here
  const usual = await page.evaluate(() => new Promise<string>((done) => {
    const img = new Image()
    img.onload = () => done('loaded')
    img.onerror = () => done('blocked')
    img.src = URL.createObjectURL(new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>'], { type: 'image/svg+xml' }))
  }))
  check(usual === 'blocked', `${variant}: under img-src ${imgOrigin} a blob: svg in an <img> is blocked (${usual})`)

  const bars = {
    $schema: 'https://vega.github.io/schema/vega/v6.json',
    width: 300, height: 160, padding: 12, autosize: 'none', background: 'white',
    data: [{ name: 't', values: [{ k: 'a', v: 3 }, { k: 'b', v: 7 }, { k: 'c', v: 5 }] }],
    scales: [
      { name: 'x', type: 'band', domain: { data: 't', field: 'k' }, range: 'width', padding: 0.2 },
      { name: 'y', type: 'linear', domain: [0, 8], range: 'height' },
    ],
    axes: [{ scale: 'x', orient: 'bottom' }, { scale: 'y', orient: 'left', title: 'value' }],
    marks: [{ type: 'rect', from: { data: 't' }, encode: { update: {
      x: { scale: 'x', field: 'k' }, width: { scale: 'x', band: 1 }, y: { scale: 'y', field: 'v' }, y2: { scale: 'y', value: 0 },
      fill: { value: { gradient: 'linear', stops: [{ offset: 0, color: 'orange' }, { offset: 1, color: 'purple' }] } }, cornerRadius: { value: 3 },
    } } }],
  }
  await mount2(page, bars, { width: 324, height: 184 })
  for (const scale of [1, 2, 1.5]) {
    const r = await page.evaluate(async (s) => {
      const w = window as never as { __ref: { current: { getPng(o: unknown): Promise<Blob | null>; getScene(): { width: number; height: number } } }; __paint(scene: unknown, dpr: number): HTMLCanvasElement }
      const blob = await w.__ref.current.getPng({ scale: s })
      if (!blob) return { error: 'no blob' }
      const bmp = await createImageBitmap(blob)
      const got = document.createElement('canvas'); got.width = bmp.width; got.height = bmp.height
      got.getContext('2d')!.drawImage(bmp, 0, 0)
      const want = w.__paint(w.__ref.current.getScene(), s)
      const a = got.getContext('2d')!.getImageData(0, 0, got.width, got.height).data
      const b = want.getContext('2d')!.getImageData(0, 0, want.width, want.height).data
      let diff = 0
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++
      const scene = w.__ref.current.getScene()
      return { type: blob.type, w: bmp.width, h: bmp.height, ww: Math.ceil(scene.width * s), wh: Math.ceil(scene.height * s), same: a.length === b.length, diff, coloured: new Set(Array.from({ length: a.length / 4 }, (_, i) => `${a[i * 4]},${a[i * 4 + 1]},${a[i * 4 + 2]}`)).size }
    }, scale)
    if ('error' in r) { check(false, `${variant}: getPng({ scale: ${scale} }) returned a blob (${r.error})`); continue }
    check(r.type === 'image/png' && r.w === r.ww && r.h === r.wh, `${variant}: scale ${scale}: an image/png of ${r.w} x ${r.h} (the scene's size x ${scale}, rounded up)`)
    check(r.same && r.diff === 0, `${variant}: scale ${scale}: its pixels are exactly the canvas renderer's (${r.diff} channel values differ)`)
    check(r.coloured > 20, `${variant}: scale ${scale}: and it is a picture, not a blank (${r.coloured} colours)`)
  }

  const images = {
    $schema: 'https://vega.github.io/schema/vega/v6.json',
    width: 120, height: 40, padding: 0, autosize: 'none', background: 'white',
    marks: [
      { type: 'symbol', encode: { update: { x: { value: 100 }, y: { value: 20 }, size: { value: 200 }, fill: { value: 'black' } } } },
      { type: 'image', encode: { update: { url: { value: `${imgOrigin}/cors.png` }, x: { value: 0 }, y: { value: 0 }, width: { value: 40 }, height: { value: 40 } } } },
      { type: 'image', encode: { update: { url: { value: `${imgOrigin}/nocors.png` }, x: { value: 50 }, y: { value: 0 }, width: { value: 40 }, height: { value: 40 } } } },
    ],
  }
  await page.evaluate(([sp, pr]) => (window as never as { __mount: (...a: unknown[]) => void }).__mount(sp, pr, [], []), [images, { width: 120, height: 40 }] as const)
  await page.waitForSelector('svg .mark-image image')
  // (a string: the page function must not be transpiled, whose name helper would not exist in the page)
  const shot = await page.evaluate(`(async () => {
    const failed = []
    const blob = await window.__ref.current.getPng({ onImageError: function (url) { failed.push(url) } })
    const bmp = await createImageBitmap(blob)
    const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height
    const g = c.getContext('2d'); g.drawImage(bmp, 0, 0)
    const at = [[20, 20], [70, 20], [100, 20]].map(function (p) { return Array.from(g.getImageData(p[0], p[1], 1, 1).data.slice(0, 3)).join(',') })
    return { failed, cors: at[0], nocors: at[1], symbol: at[2] }
  })()`) as { failed: string[]; cors: string; nocors: string; symbol: string }
  check(shot.cors === '255,0,0', `${variant}: the image served with CORS is in the PNG (${shot.cors})`)
  check(shot.nocors === '255,255,255', `${variant}: the one served without CORS is left out, the background shows (${shot.nocors})`)
  check(shot.symbol === '0,0,0', `${variant}: and the rest of the chart is drawn (${shot.symbol})`)
  check(JSON.stringify(shot.failed) === JSON.stringify([`${imgOrigin}/nocors.png`]), `${variant}: the left-out image is reported (${JSON.stringify(shot.failed)})`)
  // the svg on screen draws both (it needs no CORS): the PNG differs from it only where the browser forbids reading pixels back
  const onScreen = await page.evaluate(() => [...document.querySelectorAll('svg .mark-image image')].map((i) => i.getAttribute('href') ?? i.getAttributeNS('http://www.w3.org/1999/xlink', 'href')))
  check(JSON.stringify(onScreen) === JSON.stringify([`${imgOrigin}/cors.png`, `${imgOrigin}/nocors.png`]), `${variant}: the svg draws both images (${JSON.stringify(onScreen)})`)
  check(served.includes('/cors.png') && served.includes('/nocors.png'), `${variant}: both images were really requested from the other origin (${JSON.stringify(served)})`)
  if (variant === 'Chart') {
    // the on-screen canvas renderer draws them too, as vega's canvas does: the CORS image, not the other (which would taint it)
    await page.evaluate(([sp, pr]) => (window as never as { __mount: (...a: unknown[]) => void }).__mount(sp, pr, [], []), [images, { width: 120, height: 40, renderer: 'canvas' }] as const)
    await page.waitForSelector('#chart-host canvas')
    const onCanvas = await page.evaluate(`new Promise((resolve) => {
      const t0 = performance.now()
      const look = () => {
        const c = document.querySelector('#chart-host canvas')
        const g = c.getContext('2d')
        const k = c.width / 120
        const at = [[20, 20], [70, 20], [100, 20]].map(function (p) { return Array.from(g.getImageData(Math.floor(p[0] * k), Math.floor(p[1] * k), 1, 1).data.slice(0, 3)).join(',') })
        if (at[0] === '255,0,0' || performance.now() - t0 > 3000) resolve({ cors: at[0], nocors: at[1], symbol: at[2] })
        else setTimeout(look, 20)
      }
      look()
    })`) as { cors: string; nocors: string; symbol: string }
    check(onCanvas.cors === '255,0,0', `${variant}: renderer="canvas" draws the CORS image on screen (${onCanvas.cors})`)
    check(onCanvas.nocors === '255,255,255' && onCanvas.symbol === '0,0,0', `${variant}: and leaves out the other, the rest drawn (${onCanvas.nocors}, ${onCanvas.symbol})`)
  }
  } finally {
    await page.close()
    await close()
  }
}

const browser = await chromium.launch()
try {
  {
    // <SvgChart png={png}>: the export, asked for; the rest of the light chart is unchanged (its own suites run above for SvgChart)
    const variant = 'SvgChart+png' as const
    console.log(`\n=== ${variant} ===`)
    const { code, inputs } = await bundleVariant(variant)
    for (const [re, wanted, what] of MODULES[variant]) {
      check(inputs.some((f) => re.test(f)) === wanted, `the ${variant} bundle ${wanted ? 'contains' : 'does not contain'} ${what}`)
    }
    await pngSuite(browser, variant, code)
  }
  for (const variant of ['Chart', 'SvgChart+interaction', 'SvgChart'] as const) {
    console.log(`\n=== ${variant} ===`)
    const { code, inputs } = await bundleVariant(variant)
    for (const [re, wanted, what] of MODULES[variant]) {
      check(inputs.some((f) => re.test(f)) === wanted, `the ${variant} bundle ${wanted ? 'contains' : 'does not contain'} ${what}`)
    }
    const page = await browser.newPage({ viewport: { width: 700, height: 500 } })
    page.on('pageerror', (e) => { failures++; console.log(`  FAIL page error: ${e.message}`) })
    await page.setContent('<!doctype html><html><body style="margin:0;font:12px sans-serif"><div id="root"></div></body></html>')
    await page.addScriptTag({ content: code })
    await sizingSuite(page)
    if (variant === 'SvgChart') await plainSuite(page)
    else { await suite(page); await tabStopSuite(page); await cursorSuite(page, variant === 'Chart' ? ['svg', 'canvas'] : ['svg']) }
    await transitionSuite(page)
    if (variant === 'Chart') await pngSuite(browser, variant, code)
    await page.close()
  }
} finally {
  await browser.close()
}

if (failures > 0) {
  console.error(`\n[browser-interaction] ${failures} check(s) failed`)
  process.exit(1)
}
console.log('\n[browser-interaction] all checks passed')
