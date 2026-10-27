// @vitest-environment jsdom
import { afterEach, describe, it, expect } from 'vitest'
import { compileChart, evaluateChart, renderSceneToSvg } from './index.js'
import { bindSceneSignals as bindRaw, type SignalBinding } from './signals.js'
import type { VgSpec } from './types.js'

// `modify(name, insert, remove, toggle, modify, values)` (vega-functions): a handler queues a change to a dataset (a
// selection's store); the loop applies it after the run and tells the host (`onData`), which hands the rows back.
const opened: SignalBinding[] = []
const bind: typeof bindRaw = (...args) => {
  const b = bindRaw(...args)
  opened.push(b)
  return b
}
afterEach(() => {
  for (const b of opened.splice(0)) b.release()
  document.body.innerHTML = ''
})

function mount(signals: unknown[], data: unknown[] = [{ name: 'store' }]): { svg: SVGSVGElement; scene: ReturnType<typeof evaluateChart> } {
  const spec = { width: 100, height: 60, signals, data: [...data, { name: 't', values: [{ x: 1 }] }], marks: [] } as unknown as VgSpec
  const host = document.createElement('div')
  document.body.appendChild(host)
  const scene = evaluateChart(compileChart(spec))
  host.innerHTML = renderSceneToSvg(scene)
  return { svg: host.querySelector('svg') as SVGSVGElement, scene }
}

const click = (svg: SVGSVGElement): void => { svg.dispatchEvent(new MouseEvent('click', { bubbles: true })) }
const on = (update: string, name = 'go') => ({ name, value: 0, on: [{ events: 'click', update }] })

function run(updates: string[]): { calls: Array<[string, unknown[]]>; store: Record<string, unknown[]>; returns: unknown } {
  const { svg, scene } = mount(updates.map((u, i) => on(u, `s${i}`)))
  const calls: Array<[string, unknown[]]> = []
  let store: Record<string, unknown[]> = {}
  const b = bind(svg, scene, {}, { onData: (name, rows) => { calls.push([name, rows]); store = { ...store, [name]: rows } } })
  click(svg)
  b.detach()
  return { calls, store, returns: undefined }
}

describe('modify in the signal event loop', () => {
  it('inserts a tuple and reports the dataset once', () => {
    const { calls, store } = run(['modify("store", {"unit": "u", "values": [1]})'])
    expect(calls).toEqual([['store', [{ unit: 'u', values: [1] }]]])
    expect(store.store).toEqual([{ unit: 'u', values: [1] }])
  })

  it('remove: true clears the store before the insert (an animation frame replaces the last)', () => {
    const { svg, scene } = mount([on('modify("store", {"v": n}, true)', 's0'), { name: 'n', value: 0, on: [{ events: 'click', update: 'n + 1' }] }])
    const seen: unknown[][] = []
    const b = bind(svg, scene, {}, { onData: (_n, rows) => seen.push(rows) })
    click(svg)
    b.detach()
    const b2 = bind(svg, scene, { n: 1 }, { onData: (_n, rows) => seen.push(rows) }, { data: { store: seen[0]! } })
    click(svg)
    expect(seen).toEqual([[{ v: 0 }], [{ v: 1 }]]) // n reads the value from before the click's own update
    b2.detach()
  })

  it('toggle inserts a tuple that is absent and removes one that is present', () => {
    const { svg, scene } = mount([on('modify("store", null, null, {"a": 1})')])
    let rows: unknown[] = []
    let b = bind(svg, scene, {}, { onData: (_n, r) => { rows = r } })
    click(svg)
    b.detach()
    expect(rows).toEqual([{ a: 1 }])
    b = bind(svg, scene, {}, { onData: (_n, r) => { rows = r } }, { data: { store: rows } })
    click(svg)
    expect(rows).toEqual([])
    b.detach()
  })

  it('remove takes an object of properties to match, or true', () => {
    const { svg, scene } = mount([on('modify("store", null, {"a": 1})')])
    let rows: unknown[] = []
    const b = bind(svg, scene, {}, { onData: (_n, r) => { rows = r } }, { data: { store: [{ a: 1, b: 1 }, { a: 2, b: 2 }, { a: 1, b: 3 }] } })
    click(svg)
    expect(rows).toEqual([{ a: 2, b: 2 }])
    b.detach()
  })

  it('modify updates a field of a tuple of the dataset', () => {
    const t = { a: 1, b: 1 }
    const { svg, scene } = mount([on('modify("store", null, null, null, datum, {"b": 9})')], [{ name: 'store' }])
    let rows: unknown[] = []
    const b = bind(svg, scene, {}, { onData: (_n, r) => { rows = r } }, { data: { store: [t] } })
    // (datum is undefined for a click on the view: nothing to modify, the dataset is only rewritten)
    click(svg)
    expect(rows).toEqual([t])
    b.detach()
  })

  it('several modify calls in one run are one change (one onData), applied after the run', () => {
    const { calls } = run(['modify("store", {"a": 1})', 'modify("store", {"a": 2})', 'length(data("store"))'])
    expect(calls).toHaveLength(1)
    expect(calls[0]![1]).toEqual([{ a: 1 }, { a: 2 }])
  })

  it('does nothing (and says nothing) when there is nothing to do', () => {
    const { calls } = run(['modify("store", null, true)'])
    expect(calls).toEqual([])
  })

  it('a binding that was handed the host rows continues from them; the scene rows are the start otherwise', () => {
    const { svg, scene } = mount([on('modify("store", {"c": 3})')], [{ name: 'store', values: [{ c: 0 }] }])
    let rows: unknown[] = []
    const b = bind(svg, scene, {}, { onData: (_n, r) => { rows = r } })
    click(svg)
    expect(rows).toEqual([{ c: 0 }, { c: 3 }])
    b.detach()
    const b2 = bind(svg, scene, {}, { onData: (_n, r) => { rows = r } }, { data: { store: [{ c: 7 }] } })
    click(svg)
    expect(rows).toEqual([{ c: 7 }, { c: 3 }])
    b2.detach()
  })

  it('outside the event loop modify is inert (a dataset transform cannot write a store)', () => {
    const spec = { width: 10, height: 10, signals: [{ name: 'r', update: 'modify("store", {"a": 1})' }], data: [{ name: 'store' }], marks: [] } as unknown as VgSpec
    const scene = evaluateChart(compileChart(spec)) as unknown as { signalParams: Record<string, unknown> }
    expect(scene.signalParams.r).toBe(0)
  })
})
