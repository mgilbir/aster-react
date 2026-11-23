// @vitest-environment jsdom
/**
 * Hydrating server markup that the client would draw differently (C45). React keeps the server's `dangerouslySetInnerHTML`
 * content where the client's differs, so the chart must bring the adopted `<svg>` to its own scene: after `hydrateRoot` the
 * DOM equals what a client-only mount draws, and what the chart hit-tests and overlays matches the pixels.
 *
 * Two real sources of difference, each made to happen rather than assumed:
 * - the time zone: the server markup is rendered by a CHILD PROCESS in another zone than this one, so a `time` axis has
 *   other ticks and labels there (the same two processes in one zone would not test anything);
 * - text measurement: the server measured with another text measurer (a headless estimate against the browser's canvas),
 *   made here by giving the server render a different `textMetrics` provider than the client.
 */
import * as React from 'react'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRoot, hydrateRoot } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { forEachVariant, type VariantName } from './testing/variants'

const T0 = Date.UTC(2024, 0, 1)
const timeSpec = {
  width: 300, height: 60, padding: 5, autosize: 'none',
  scales: [{ name: 'x', type: 'time', domain: [T0, T0 + 86_400_000], range: 'width', nice: false }],
  axes: [{ scale: 'x', orient: 'bottom', tickCount: 4 }],
  marks: [],
}
const textSpec = {
  width: 200, height: 100,
  data: [{ name: 't', values: [{ k: 'a rather long category label', v: 3 }, { k: 'short', v: 7 }] }],
  scales: [
    { name: 'y', type: 'band', domain: { data: 't', field: 'k' }, range: 'height' },
    { name: 'x', type: 'linear', domain: [0, 10], range: 'width' },
  ],
  axes: [{ scale: 'y', orient: 'left' }, { scale: 'x', orient: 'bottom' }],
  marks: [{ type: 'rect', from: { data: 't' }, encode: { update: { y: { scale: 'y', field: 'k' }, height: { scale: 'y', band: 1 }, x: { scale: 'x', value: 0 }, x2: { scale: 'x', field: 'v' } } } }],
}

/** The server's markup of `spec` drawn by the variant's shell in another process, in the zone `tz`. */
function serverMarkupIn(tz: string, variant: VariantName, spec: unknown): string {
  // (paths from the module's own file path: jsdom's URL is not node's, so no `new URL(..., import.meta.url)` here)
  const src = dirname(fileURLToPath(import.meta.url)) + '/'
  const code = `
    import * as React from 'react'
    import { renderToString } from 'react-dom/server'
    const full = await import(${JSON.stringify(src + 'Chart.tsx')})
    const lite = await import(${JSON.stringify(src + 'SvgChart.tsx')})
    const { interaction } = await import(${JSON.stringify(src + 'interaction-capability.ts')})
    const shells = { Chart: [full.Chart, {}], SvgChart: [lite.SvgChart, {}], 'SvgChart+interaction': [lite.SvgChart, { interaction }] }
    const [shell, extra] = shells[${JSON.stringify(variant)}]
    process.stdout.write(renderToString(React.createElement(shell, { spec: ${JSON.stringify(spec)}, a11y: false, ...extra })))
  `
  const out = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
    cwd: join(src, '..'), env: { ...process.env, TZ: tz }, encoding: 'utf8', timeout: 60_000,
  })
  if (out.status !== 0) throw new Error(`server render failed: ${out.stderr}`)
  return out.stdout
}

/** A zone whose clock differs from this process's by a number of hours that moves 6-hourly ticks. */
function anotherZone(): string {
  const here = Intl.DateTimeFormat().resolvedOptions().timeZone
  return here === 'Pacific/Kiritimati' ? 'America/Los_Angeles' : 'Pacific/Kiritimati'
}

const narrow = { measure: (text: string, _font: string, size: number) => text.length * size * 0.45 }
const wide = { measure: (text: string, _font: string, size: number) => text.length * size * 0.8 }

let cleanups: Array<() => void> = []
afterEach(() => { for (const c of cleanups) c(); cleanups = []; document.body.innerHTML = '' })

function clientOnlySvg(node: React.ReactElement): string {
  const el = document.createElement('div')
  document.body.appendChild(el)
  const root = createRoot(el)
  act(() => { root.render(node) })
  const svg = el.querySelector('svg')!.outerHTML
  act(() => root.unmount())
  el.remove()
  return svg
}

function hydratedSvg(html: string, node: React.ReactElement): { svg: string; el: HTMLElement; root: ReturnType<typeof hydrateRoot> } {
  const el = document.createElement('div')
  el.innerHTML = html
  document.body.appendChild(el)
  let root: ReturnType<typeof hydrateRoot> | undefined
  act(() => { root = hydrateRoot(el, node, { onRecoverableError: () => {} }) })
  cleanups.push(() => act(() => root!.unmount()))
  return { svg: el.querySelector('svg')!.outerHTML, el, root: root! }
}

forEachVariant(['svg'], (Chart, variant) => {
  describe('a hydrated chart draws the client scene, not the server picture', () => {
    const zoned = serverMarkupIn.bind(null, anotherZone(), variant.name, timeSpec)
    let zonedHtml: string | undefined
    for (const incremental of [true, false]) {
      it(`server markup from another time zone (incremental=${incremental})`, () => {
        ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
        const html = (zonedHtml ??= zoned())
        const node = <Chart spec={timeSpec as never} a11y={false} incremental={incremental} />
        const client = clientOnlySvg(node)
        // (the premise: the two zones draw the axis differently)
        expect(html).not.toContain(client)
        const hydrated = hydratedSvg(html, node)
        expect(hydrated.svg).toBe(client)
        // a later re-render by the parent keeps it
        act(() => { hydrated.root.render(<Chart spec={timeSpec as never} a11y={false} incremental={incremental} className="again" />) })
        expect(hydrated.el.querySelector('svg')!.outerHTML).toBe(client)
      })

      it(`server markup measured with another text measurer (incremental=${incremental})`, () => {
        ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
        const html = renderToString(<Chart spec={textSpec as never} textMetrics={narrow} a11y={false} incremental={incremental} />)
        const node = <Chart spec={textSpec as never} textMetrics={wide} a11y={false} incremental={incremental} />
        const client = clientOnlySvg(node)
        expect(html).not.toContain(client)
        const error = vi.spyOn(console, 'error').mockImplementation(() => {})
        cleanups.push(() => error.mockRestore())
        expect(hydratedSvg(html, node).svg).toBe(client)
        // the chart repairs the difference itself: React is not asked to warn about it
        expect(error.mock.calls.map((c) => String(c[0])).filter((m) => /hydrat/i.test(m))).toEqual([])
      })
    }
  })
})
