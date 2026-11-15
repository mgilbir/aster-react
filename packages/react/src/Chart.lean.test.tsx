// @vitest-environment jsdom
/**
 * The shells as a browser build runs them: `@aster-charts/core/lean` under the `browser` export condition, without the parts of the
 * engine most charts never run (the other tests of this package resolve the subpath outside a browser build, where every part is
 * there). The mocks below point the subpaths at the browser variants; the slots are emptied before each test, as a page starts.
 *
 * What must hold: a chart that needs no part renders at once and fetches nothing; one that needs a part suspends until it is loaded
 * and then draws exactly what it draws with every part (no intermediate render of a half-made chart); `renderer="canvas"` waits for
 * the canvas renderer; an interactive chart whose spec declares signals, or whose host listens to them, waits for the signal loop and
 * binds it, and a chart with neither never loads it; new data is drawn as before while the pulse path is fetched for the next change;
 * and a server render made with every part hydrates with no mismatch.
 */
import * as React from 'react'
import { act } from 'react'
import { createRoot, hydrateRoot } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { VgSpec } from '@aster-charts/core'

vi.mock('@aster-charts/core/lean', async () => await import('../../core/dist/lean.js'))
vi.mock('@aster-charts/core/lean/hit', async () => await import('../../core/dist/hit.js'))
// (the same for the signal loop: the browser variant, signals-deferred.ts, loads part-signals.js when a chart first binds it)
vi.mock('@aster-charts/core/lean/signals', async () => ({
  loadSignalsPart: async () => (await import('../../core/dist/part-signals.js')).loadSignalsPart(),
}))
// (outside a browser build `/lean/canvas` IS part-canvas.js, the module the browser variant defers: mocked here by what the deferred
// module does, loading the real one when a chart first asks for a canvas)
vi.mock('@aster-charts/core/lean/canvas', async (importOriginal) => ({
  loadCanvasPart: async () => (await importOriginal<{ loadCanvasPart: () => Promise<void> }>()).loadCanvasPart(),
}))

const { forEachVariant } = await import('./testing/variants')
const { ENGINE_PARTS, loadParts, partLoaded, withdrawParts } = await import('@aster-charts/core/lean')
const { loadCanvasPart } = await vi.importActual<{ loadCanvasPart: () => Promise<void> }>('@aster-charts/core/lean/canvas')
const { loadSignalsPart } = await import('@aster-charts/core/lean/signals')

const CORPUS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'conformance', 'corpus')
const corpus = (name: string): VgSpec => JSON.parse(readFileSync(join(CORPUS, name), 'utf8')) as VgSpec
const PLAIN = corpus('bar-bands.vg.json')
const LEGEND = corpus('bar-color-blues-reversed-legend.vg.json')
const SPEC_PARTS = ENGINE_PARTS.filter((p) => p !== 'canvas' && p !== 'signals')
/** A spec whose signal a click on its view sets, shown by a text mark: what the signal loop drives. */
const CLICKS: VgSpec = {
  width: 120, height: 60, padding: 0, autosize: 'none',
  signals: [{ name: 'clicks', value: 0, on: [{ events: 'click', update: 'clicks + 1' }] }],
  marks: [{ type: 'text', encode: { update: { x: { value: 10 }, y: { value: 20 }, text: { signal: "'clicks ' + clicks" } } } }],
} as VgSpec

/** Let pending imports land and React reveal what they unblocked (it throttles revealing a boundary's content, by up to 300 ms). */
const settle = async (): Promise<void> => {
  for (const p of pending.splice(0)) await p
  for (let i = 0; i < 25; i++) await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
}
const fallback = <i id="fb" />

let roots: Array<{ unmount(): void }> = []
/**
 * Render `el` under a Suspense boundary. The first commit is in the container when this returns; React retries a suspended tree only
 * once the act scope that rendered it is awaited, which `settle` does (the pending scopes are kept for it).
 */
const pending: Array<PromiseLike<void>> = []
function mount(el: React.ReactElement): HTMLDivElement {
  const c = document.createElement('div')
  document.body.appendChild(c)
  const root = createRoot(c)
  roots.push(root)
  pending.push(act(() => { root.render(<React.Suspense fallback={fallback}>{el}</React.Suspense>) }) as unknown as PromiseLike<void>)
  return c
}
/** Every part in its slot: what a chart draws with the whole engine. */
async function full(): Promise<void> { await loadParts(SPEC_PARTS); await loadCanvasPart(); await loadSignalsPart() }
/** What `el` draws with every part, as markup. */
async function drawnWithEveryPart(el: React.ReactElement): Promise<string> {
  await full()
  const c = mount(el)
  await settle()
  const html = c.innerHTML
  expect(html).toContain('<svg')
  return html
}

beforeEach(() => { withdrawParts(ENGINE_PARTS) })
afterEach(async () => {
  for (const p of pending.splice(0)) await p
  act(() => { for (const r of roots) r.unmount() })
  roots = []
  document.body.innerHTML = ''
  await full()
})

forEachVariant(['svg'], (Chart, variant) => describe(`${variant.name} on the lean engine`, () => {
  it('a chart that needs no part renders in its first commit and loads nothing', () => {
    const c = mount(<Chart spec={PLAIN} width={300} height={200} />)
    expect(c.querySelector('svg')).not.toBeNull()
    expect(c.querySelector('#fb')).toBeNull()
    expect(ENGINE_PARTS.filter(partLoaded)).toEqual([])
  })

  variant.it(['interaction'], 'a chart whose spec declares signals waits for the signal loop, draws what it draws with every part, and binds it', async () => {
    const expected = await drawnWithEveryPart(<Chart spec={CLICKS} width={120} height={60} />)
    for (const p of pending.splice(0)) await p
    act(() => { for (const r of roots) r.unmount() })
    roots = []
    withdrawParts(ENGINE_PARTS)
    const c = mount(<Chart spec={CLICKS} width={120} height={60} />)
    expect(c.innerHTML).toBe('<i id="fb"></i>')
    await settle()
    expect(ENGINE_PARTS.filter(partLoaded)).toEqual(['signals'])
    expect(c.innerHTML).toBe(expected)
    // bound: a click on the view runs the stream
    act(() => { c.querySelector('svg')!.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 30, clientY: 30 })) })
    await settle()
    expect(c.querySelector('.mark-text text')?.textContent).toBe('clicks 1')
  })

  variant.it(['interaction'], 'a host listening to signals loads the loop for a spec that declares none; a chart that does neither, or is not interactive, never does', async () => {
    const quiet = mount(<Chart spec={PLAIN} width={300} height={200} />)
    const inert = mount(<Chart spec={CLICKS} width={120} height={60} interactive={false} />)
    await settle()
    expect(quiet.querySelector('svg')).not.toBeNull()
    expect(inert.querySelector('svg')).not.toBeNull()
    expect(partLoaded('signals')).toBe(false)
    const heard: string[] = []
    const c = mount(<Chart spec={PLAIN} width={300} height={200} onSignal={(name) => heard.push(name)} />)
    expect(c.innerHTML).toBe('<i id="fb"></i>')
    await settle()
    expect(partLoaded('signals')).toBe(true)
    expect(c.querySelector('svg')).not.toBeNull()
  })

  it('a chart with a legend suspends until the legend builder is there, then draws what it draws with every part', async () => {
    const expected = await drawnWithEveryPart(<Chart spec={LEGEND} width={300} height={200} />)
    for (const p of pending.splice(0)) await p
    act(() => { for (const r of roots) r.unmount() })
    roots = []
    withdrawParts(ENGINE_PARTS)
    const c = mount(<Chart spec={LEGEND} width={300} height={200} />)
    // the first commit is the fallback: no half-made chart, no error
    expect(c.innerHTML).toBe('<i id="fb"></i>')
    await settle()
    expect(partLoaded('legend')).toBe(true)
    expect(partLoaded('canvas')).toBe(false)
    expect(c.innerHTML).toBe(expected)
  })

  variant.it(['canvas'], 'renderer="canvas" waits for the canvas renderer; an svg chart never loads it', async () => {
    const svgChart = mount(<Chart spec={PLAIN} width={300} height={200} />)
    expect(svgChart.querySelector('svg')).not.toBeNull()
    const c = mount(<Chart spec={PLAIN} renderer="canvas" width={300} height={200} />)
    expect(c.innerHTML).toBe('<i id="fb"></i>')
    expect(c.querySelector('#fb')).not.toBeNull()
    expect(partLoaded('canvas')).toBe(false)
    await settle()
    expect(partLoaded('canvas')).toBe(true)
    expect(c.querySelector('canvas')).not.toBeNull()
  })

  it('new data is drawn at once, as with every part, while the pulse path loads for the next change', async () => {
    const rows = (n: number): Array<{ x: string; y: number }> => Array.from({ length: n }, (_, i) => ({ x: `k${i}`, y: (i * 7) % 11 }))
    // (a dataset with steps: a change of its rows is what the pulse path re-derives)
    const spec = (): VgSpec => ({ ...PLAIN, data: [{ name: 'table', transform: [{ type: 'filter', expr: 'datum.y >= 0' }, { type: 'collect', sort: { field: 'x' } }] }] } as VgSpec)
    const draw = async (n: number): Promise<string[]> => {
      const c = document.createElement('div')
      document.body.appendChild(c)
      const root = createRoot(c)
      roots.push(root)
      const s = spec()
      const out: string[] = []
      for (const k of [n, n + 2, n + 3, n + 1]) {
        act(() => { root.render(<Chart spec={s} data={{ table: rows(k) }} width={300} height={200} />) })
        out.push(c.innerHTML)
        await settle()
      }
      return out
    }
    await full()
    const expected = await draw(4)
    withdrawParts(ENGINE_PARTS)
    const got = await draw(4)
    expect(got).toEqual(expected)
    expect(partLoaded('pulse')).toBe(true)
  })

  it('server markup made with every part hydrates on the lean engine with no mismatch', async () => {
    await full()
    const html = renderToString(<Chart spec={LEGEND} width={300} height={200} />)
    expect(html).toContain('<svg')
    withdrawParts(ENGINE_PARTS)
    const c = document.createElement('div')
    c.innerHTML = html
    document.body.appendChild(c)
    const before = c.innerHTML
    const errors: unknown[] = []
    let root!: ReturnType<typeof hydrateRoot>
    act(() => { root = hydrateRoot(c, <Chart spec={LEGEND} width={300} height={200} />, { onRecoverableError: (e) => errors.push(e) }) })
    roots.push(root)
    // while the legend builder loads, the server's markup stays
    expect(c.innerHTML).toBe(before)
    await settle()
    expect(partLoaded('legend')).toBe(true)
    expect(errors).toEqual([])
    expect(c.querySelector('svg')).not.toBeNull()
  })
}))
