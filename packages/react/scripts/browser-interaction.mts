/**
 * Real-browser interaction gate for <Chart> (audit C28 and friends).
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
 * Run: pnpm --filter @aster/react test:browser   (after `pnpm build`)
 */
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { build } from 'esbuild'
import { chromium, type Page } from 'playwright'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = dirname(HERE)

const entry = `
import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { Chart } from ${JSON.stringify(join(PKG, 'src/index.ts'))}

window.__log = []
const rec = (name) => (...args) => { window.__log.push({ name, args: JSON.parse(JSON.stringify(args)) }) }
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
  flushSync(() => window.__root.render(React.createElement(Chart, { ref: window.__ref, spec, ...p })))
}
`

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
  await page.waitForSelector('svg .mark-symbol path')
}

const browser = await chromium.launch()
try {
  const bundle = await build({
    stdin: { contents: entry, resolveDir: HERE, loader: 'tsx', sourcefile: 'entry.tsx' },
    bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'error',
  })
  const code = bundle.outputFiles[0]!.text
  const page = await browser.newPage({ viewport: { width: 700, height: 500 } })
  page.on('pageerror', (e) => { failures++; console.log(`  FAIL page error: ${e.message}`) })
  await page.setContent('<!doctype html><html><body style="margin:0;font:12px sans-serif"><div id="root"></div></body></html>')
  await page.addScriptTag({ content: code })

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
} finally {
  await browser.close()
}

if (failures > 0) {
  console.error(`\n[browser-interaction] ${failures} check(s) failed`)
  process.exit(1)
}
console.log('\n[browser-interaction] all checks passed')
