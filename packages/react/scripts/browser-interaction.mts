/**
 * Real-browser interaction gate for <Chart> and <SvgChart interaction={interaction}> (audit C28 and friends).
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
 *   - a11y nodes are positioned over the marks they describe (padding included).
 *
 * Every check runs against both components, each bundled on its own (so the light one is the real light bundle):
 * `<Chart>` from the package entry, and `<SvgChart interaction={interaction}>` from `@aster/react/lite` +
 * `@aster/react/interaction`. A third pass covers `<SvgChart>` WITHOUT interaction: it renders, it works for what
 * needs no hit testing (pan/zoom, brush), and an event-stream spec reports the documented error instead of going
 * silently dead. The light bundles are asserted (esbuild metafile) not to contain the canvas renderer, and the one
 * without `interaction` not to contain the hit index or the signal loop either.
 *
 * Run: pnpm --filter @aster/react test:browser   (after `pnpm build`)
 */
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { build } from 'esbuild'
import { chromium, type Page } from 'playwright'
import { compile as compileVl } from '@aster/vl'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = dirname(HERE)

type VariantName = 'Chart' | 'SvgChart+interaction' | 'SvgChart'

/** The bundle for one variant: what its imports pull in is exactly what that variant ships. */
const entryFor = (variant: VariantName): string => {
  const imports = variant === 'Chart'
    ? `import { Chart } from ${JSON.stringify(join(PKG, 'src/index.ts'))}`
    : `import { SvgChart } from ${JSON.stringify(join(PKG, 'src/lite.ts'))}\n${variant === 'SvgChart+interaction' ? `import { interaction } from ${JSON.stringify(join(PKG, 'src/interaction-capability.ts'))}` : 'const interaction = undefined'}`
  const element = variant === 'Chart'
    ? 'React.createElement(Chart, { ref: window.__ref, spec, ...p })'
    : 'React.createElement(SvgChart, { ref: window.__ref, spec, interaction, ...p })'
  return `
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
${imports}

window.__log = []
const rec = (name) => (...args) => { window.__log.push({ name, args: JSON.parse(JSON.stringify(args.map((a) => (a instanceof Error ? a.message : a)))) }) }
window.__mount = (spec, props, record, listen) => {
  const host = document.getElementById('root')
  const container = document.createElement('div')
  container.id = 'chart-host'
  container.style.cssText = 'position:relative;width:520px;height:340px'
  host.replaceChildren(container)
  window.__log = []
  const p = { ...props }
  for (const r of record || []) p[r] = rec(r)
  if (listen && listen.length) p.signalListeners = Object.fromEntries(listen.map((n) => [n, rec('signal:' + n)]))
  window.__ref = React.createRef()
  if (window.__root) window.__root.unmount()
  window.__root = createRoot(container)
  flushSync(() => window.__root.render(${element}))
}
`
}

const spec = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
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
  } } }],
  ...extra,
})

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
  check(errs.length === 1 && /event streams \(signal\.on\)/.test(errs[0]!) && /@aster\/react\/interaction/.test(errs[0]!), `an event-stream spec reports the documented error (${JSON.stringify(errs)})`)
  const stamped = await page.evaluate(() => document.querySelectorAll('[data-datum]').length)
  check(stamped === 0, 'and no data-datum is stamped (nothing reads it)')
}

const MODULES: Record<VariantName, Array<[RegExp, boolean, string]>> = {
  Chart: [[/core\/dist\/canvas\.js$/, true, 'the canvas renderer'], [/core\/dist\/hit\.js$/, true, 'the hit index'], [/core\/dist\/signals\.js$/, true, 'the signal loop']],
  'SvgChart+interaction': [[/core\/dist\/canvas\.js$/, false, 'the canvas renderer'], [/src\/canvas-capability\.ts$/, false, 'the canvas capability'], [/core\/dist\/hit\.js$/, true, 'the hit index'], [/core\/dist\/signals\.js$/, true, 'the signal loop']],
  SvgChart: [[/core\/dist\/canvas\.js$/, false, 'the canvas renderer'], [/src\/canvas-capability\.ts$/, false, 'the canvas capability'], [/core\/dist\/hit\.js$/, false, 'the hit index'], [/core\/dist\/signals\.js$/, false, 'the signal loop'], [/src\/interaction-capability\.ts$/, false, 'the interaction capability']],
}

const browser = await chromium.launch()
try {
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
    if (variant === 'SvgChart') await plainSuite(page)
    else { await suite(page); await cursorSuite(page, variant === 'Chart' ? ['svg', 'canvas'] : ['svg']) }
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
