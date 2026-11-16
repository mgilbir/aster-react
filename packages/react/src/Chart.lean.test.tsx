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

/** A detection miss planted in `specNeeds` (the part it leaves out), for the test that the engine refuses rather than misdraws. */
const planted = vi.hoisted(() => ({ drop: null as string | null }))
vi.mock('@aster-charts/core/lean', async () => {
  const lean = await import('../../core/dist/lean.js')
  const specNeeds: typeof lean.specNeeds = (spec, options) => {
    const needs = lean.specNeeds(spec, options)
    return planted.drop === null ? needs : { ...needs, parts: needs.parts.filter((p) => p !== planted.drop) }
  }
  return { ...lean, specNeeds }
})
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
const { ENGINE_PARTS, loadParts, partLoaded, preloadParts, specNeeds, withdrawParts } = await import('@aster-charts/core/lean')
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

/**
 * A chart that needs the parts most charts never run: a time scale, an aggregate and a window, a monotone curve, a colour ramp on a
 * sequential scale and its legend (`specNeeds` names aggregate, window, time, curves, color, scales, legend and the path reader).
 */
const RARE = (title = 'Rare'): VgSpec => ({
  width: 300, height: 160, padding: 4, title,
  data: [{ name: 't', values: Array.from({ length: 24 }, (_, i) => ({ d: Date.UTC(2021, i % 12, 1 + i), g: ['a', 'b'][i % 2], v: (i * 7) % 13 })), transform: [
    { type: 'aggregate', groupby: ['d', 'g'], fields: ['v'], ops: ['sum'], as: ['v'] },
    { type: 'window', sort: { field: 'd' }, groupby: ['g'], ops: ['sum'], fields: ['v'], as: ['run'] },
  ] }],
  scales: [
    { name: 'x', type: 'time', domain: { data: 't', field: 'd' }, range: 'width' },
    { name: 'y', type: 'linear', domain: { data: 't', field: 'run' }, range: 'height' },
    { name: 'c', type: 'sequential', domain: { data: 't', field: 'run' }, range: { scheme: 'viridis' } },
  ],
  axes: [{ scale: 'x', orient: 'bottom' }, { scale: 'y', orient: 'left' }],
  legends: [{ fill: 'c' }],
  marks: [
    { type: 'line', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'd' }, y: { scale: 'y', field: 'run' }, stroke: { value: '#999' }, interpolate: { value: 'monotone' } } } },
    { type: 'symbol', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'd' }, y: { scale: 'y', field: 'run' }, fill: { scale: 'c', field: 'run' } } } },
  ],
} as VgSpec)
const RARE_PARTS = ['aggregate', 'window', 'time', 'curves', 'color', 'scales', 'legend', 'svgpath']

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

beforeEach(() => { planted.drop = null; withdrawParts(ENGINE_PARTS) })
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
    // (a dataset with steps: a change of its rows is what the pulse path re-derives; row-local steps, which need no part of their own)
    const spec = (): VgSpec => ({ ...PLAIN, data: [{ name: 'table', transform: [{ type: 'filter', expr: 'datum.y >= 0' }, { type: 'formula', expr: 'datum.y * 2', as: 'y2' }] }] } as VgSpec)
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

  it('a chart that needs the parts most charts never run suspends until exactly those are there, then draws what it draws with every part', async () => {
    expect(specNeeds(RARE()).parts).toEqual(RARE_PARTS)
    const expected = await drawnWithEveryPart(<Chart spec={RARE()} width={300} height={160} />)
    for (const p of pending.splice(0)) await p
    act(() => { for (const r of roots) r.unmount() })
    roots = []
    withdrawParts(ENGINE_PARTS)
    const c = mount(<Chart spec={RARE()} width={300} height={160} />)
    expect(c.innerHTML).toBe('<i id="fb"></i>')
    await settle()
    expect(ENGINE_PARTS.filter(partLoaded)).toEqual(RARE_PARTS)
    expect(c.innerHTML).toBe(expected)
  })

  it('a spec swap that needs new parts suspends once, and a swap to another chart of those parts does not', async () => {
    const expected = await drawnWithEveryPart(<Chart spec={RARE('Second')} width={300} height={160} />)
    for (const p of pending.splice(0)) await p
    act(() => { for (const r of roots) r.unmount() })
    roots = []
    withdrawParts(ENGINE_PARTS)
    let shown = 0
    const Fallback = (): React.ReactElement => { React.useEffect(() => { shown++ }, []); return <i id="fb" /> }
    const c = document.createElement('div')
    document.body.appendChild(c)
    const root = createRoot(c)
    roots.push(root)
    const render = (spec: VgSpec): void => { pending.push(act(() => { root.render(<React.Suspense fallback={<Fallback />}><Chart spec={spec} width={300} height={160} /></React.Suspense>) }) as unknown as PromiseLike<void>) }
    render(PLAIN)
    await settle()
    expect(c.querySelector('svg')).not.toBeNull()
    expect(shown).toBe(0)
    render(RARE())
    await settle()
    expect(shown).toBe(1)
    expect(ENGINE_PARTS.filter(partLoaded)).toEqual(RARE_PARTS)
    render(RARE('Second'))
    await settle()
    expect(shown).toBe(1)
    expect(c.innerHTML).toBe(expected)
  })

  it('server markup of a chart that needs parts, made with every part, hydrates on the lean engine with no mismatch', async () => {
    await full()
    const html = renderToString(<Chart spec={RARE()} width={300} height={160} />)
    expect(html).toContain('<svg')
    withdrawParts(ENGINE_PARTS)
    const c = document.createElement('div')
    c.innerHTML = html
    document.body.appendChild(c)
    const before = c.innerHTML
    const errors: unknown[] = []
    let root!: ReturnType<typeof hydrateRoot>
    act(() => { root = hydrateRoot(c, <Chart spec={RARE()} width={300} height={160} />, { onRecoverableError: (e) => errors.push(e) }) })
    roots.push(root)
    // while the parts load, the server's markup stays; once they are there it is still what the server drew
    expect(c.innerHTML).toBe(before)
    await settle()
    expect(ENGINE_PARTS.filter(partLoaded)).toEqual(expect.arrayContaining(RARE_PARTS))
    expect(errors).toEqual([])
    expect(c.querySelector('svg')!.outerHTML).toBe(new DOMParser().parseFromString(before, 'text/html').querySelector('svg')!.outerHTML)
  })

  it('a part the detector misses is refused, naming the part: the chart reports an error and draws nothing in its place', async () => {
    for (const drop of ['time', 'aggregate', 'color', 'curves']) {
      withdrawParts(ENGINE_PARTS)
      planted.drop = drop
      const errors: Error[] = []
      const c = mount(<Chart spec={RARE()} width={300} height={160} onError={(e) => errors.push(e)} />)
      await settle()
      expect(partLoaded(drop as never), drop).toBe(false)
      expect(errors.map((e) => e.message).join('\n'), drop).toMatch(new RegExp(`the "${drop}" part of the engine is not loaded`))
      expect(c.querySelector('.mark-symbol, .mark-line'), drop).toBeNull()
    }
  })

  it('preloadParts loads the named parts ahead of time, after which a chart that needs only those does not suspend', async () => {
    await preloadParts(['time', 'curves'])
    expect(ENGINE_PARTS.filter(partLoaded)).toEqual(['time', 'curves'])
    const spec = { ...PLAIN, scales: [...(PLAIN.scales as object[]), { name: 'when', type: 'utc', domain: [0, 1e10], range: 'width' }], axes: [...((PLAIN.axes as object[]) ?? []), { scale: 'when', orient: 'top' }] } as VgSpec
    expect(specNeeds(spec).parts).toEqual(['time'])
    const c = mount(<Chart spec={spec} width={300} height={200} />)
    expect(c.querySelector('#fb')).toBeNull()
    expect(c.querySelector('svg')).not.toBeNull()
    await expect(preloadParts(['time', 'nope' as never])).rejects.toThrow(/not a part of the engine: "nope"/)
    await preloadParts()
    expect(ENGINE_PARTS.filter(partLoaded)).toEqual(ENGINE_PARTS)
  })
}))
