// @vitest-environment jsdom
/**
 * A named mark's `on` triggers (`on: [{trigger, modify, values}]`, C73), against real vega.
 *
 * vega-parser makes each the operator `if(trigger, modify("<mark>", null, null, null, <modify>, <values>), 0)`: when what it reads changes
 * and the trigger holds, it sets each property of `values` on the mark's item `modify` names, and the mark's `update` set runs on the
 * modified item again -- a channel it writes is taken back at once, a channel only `enter` writes keeps what the trigger gave it, and a
 * property no set writes (`fx` and `fy` for a `force`, anything else) stays on the item. Aster is driven as a host drives it (evaluate,
 * render, bind; on a change evaluate again from the store, which holds the writes), vega gets the same events; after every event the
 * items' channels and the extra properties agree. They were parsed and never run. Generated: which sets write which channels, triggers
 * with conditions over a counter, items named by index, by the counter and from a signal, values with one to three properties
 * (channels the mark's `update` owns, channels it does not, properties of no set), one to three triggers, the mark inside a group.
 */
import { afterEach, describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { compileChart, evaluateChart } from '@aster-charts/core'
import { renderSceneToDomElement } from '@aster-charts/core/dom'
import { bindSceneSignals, type SignalBinding } from '@aster-charts/core/signals'
import { canonicalizeSvg, diffCanonical } from './normalize.js'
import { renderSceneToSvg } from '@aster-charts/core'

type Spec = Record<string, unknown>
type Item = Record<string, unknown>
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
const cleanups: Array<() => void> = []
afterEach(() => { while (cleanups.length) cleanups.pop()!(); document.body.innerHTML = '' })

const SHOWN = ['x', 'y', 'size', 'fill', 'stroke', 'opacity', 'fillOpacity', 'foo', 'bar', 'fx', 'fy']
const snap = (items: Item[]): string => JSON.stringify(items.map((it) => SHOWN.map((c) => (it[c] === undefined ? null : it[c]))))

function stream(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function findMark(node: unknown, name: string): Item[] | null {
  const n = node as { marktype?: string; name?: string; items?: unknown[] } | null
  if (!n || typeof n !== 'object') return null
  if (n.marktype !== undefined && n.marktype !== 'group' && n.name === name) return (n.items ?? []) as Item[]
  for (const c of n.items ?? []) {
    const f = findMark(c, name)
    if (f) return f
  }
  return null
}

function asterHost(spec: Spec): { click: () => void; items: () => Item[]; svg: () => string } {
  const chart = compileChart(structuredClone(spec) as never)
  const host = document.createElement('div')
  document.body.appendChild(host)
  let store: Record<string, unknown> = {}
  let binding: SignalBinding | null = null
  let scene = evaluateChart(chart)
  let dirty = false
  const render = (): void => {
    binding?.detach()
    scene = evaluateChart(chart, { signals: store })
    host.innerHTML = ''
    const svg = renderSceneToDomElement(scene) as SVGSVGElement
    svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 300, height: 300, right: 300, bottom: 300, x: 0, y: 0 } as DOMRect)
    host.appendChild(svg)
    dirty = false
    binding = bindSceneSignals(svg, scene, store, { onSignal: () => { dirty = true }, onEncode: (all) => { store = { ...all }; dirty = true } }, { owner: host })
  }
  render()
  cleanups.push(() => binding?.release())
  return {
    click: () => {
      host.querySelector('svg')!.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 5, clientY: 5 }))
      if (dirty) render()
    },
    items: () => findMark(scene, 'pts')!,
    svg: () => renderSceneToSvg(scene),
  }
}

async function vegaHost(spec: Spec): Promise<{ click: () => Promise<void>; items: () => Item[]; svg: () => Promise<string> }> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const view = new vega.View(vega.parse(structuredClone(spec) as never), { renderer: 'svg' }).initialize(host)
  cleanups.push(() => view.finalize())
  await view.runAsync()
  return {
    click: async () => {
      host.querySelector('svg')!.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 5, clientY: 5 }))
      await view.runAsync()
      await tick()
    },
    items: () => findMark((view.scenegraph() as unknown as { root: unknown }).root, 'pts')!,
    svg: () => view.toSVG(),
  }
}

/** A generated chart: the mark `pts` with sets, and its triggers. */
function triggerCase(seed: number): { spec: Spec; clicks: number } {
  const r = stream(seed * 7717 + 3)
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!
  const n = 3 + Math.floor(r() * 3)
  const rows = Array.from({ length: n }, (_, i) => ({ i, u: 20 + i * 50, v: 20 + i * 40 }))
  const enter: Spec = { fill: { value: 'steelblue' }, ...(r() < 0.5 ? { stroke: { value: 'gray' } } : {}), ...(r() < 0.4 ? { opacity: { value: 0.8 } } : {}) }
  const update: Spec = { x: { field: 'u' }, y: { field: 'v' }, size: { value: 200 }, ...(r() < 0.5 ? { fill: { value: 'tomato' } } : {}), ...(r() < 0.3 ? { fillOpacity: { signal: '0.5 + datum.i / 10' } } : {}) }
  const hasUpdate = r() < 0.85
  const values = (): string => {
    const props = [pick(["fill: 'red'", "fill: 'gold'"]), pick(['size: 777', 'size: go * 100']), pick(['foo: go', "foo: 'a' + go", 'foo: [go, go]']), pick(['bar: 7', 'bar: null']), pick(['x: 3', 'y: go']), pick(['fx: go * 2', 'fx: null']), pick(['opacity: 0.2', 'stroke: "black"'])]
    const k = 1 + Math.floor(r() * 3)
    const chosen: string[] = []
    while (chosen.length < k) { const p = pick(props); if (!chosen.includes(p)) chosen.push(p) }
    return `{${chosen.join(', ')}}`
  }
  // (the item a trigger names is held by a signal, as the gallery's force-directed-layout holds its `node`: a trigger that read
  // `data('pts')` itself would pulse the mark it reads, and run again, without end)
  const picks = ['go % ' + n, '0', String(n - 1), 'go - 1', '1'].slice(0, 5)
  const nested = r() < 0.35
  // (a mark inside a group is in the group's scope: its items are `data('pts')` there, and the signal that holds one is the group's)
  const holders = Array.from({ length: 2 }, (_, k) => ({ name: 'p' + k, value: null, on: [{ events: nested ? 'view:click' : 'click', update: `data('pts')[${pick(picks)}]` }] }))
  const triggers = Array.from({ length: 1 + Math.floor(r() * 3) }, () => ({
    trigger: pick(['go', 'go > 1', 'go % 2', 'go === 2', '!go', 'go > 0 && go < 3']),
    modify: pick(['p0', 'p1']),
    values: values(),
  }))
  const pts: Spec = { type: 'symbol', name: 'pts', from: { data: 't' }, on: triggers, encode: { enter: hasUpdate ? enter : { ...enter, ...update }, ...(hasUpdate ? { update } : {}) } }
  const signals: Spec[] = [{ name: 'go', value: 0, on: [{ events: 'click', update: 'go + 1' }] }, ...(nested ? [] : holders)]
  const marks = nested ? [{ type: 'group', signals: holders, encode: { update: { width: { value: 300 }, height: { value: 300 } } }, marks: [pts] }] : [pts]
  return { spec: { width: 300, height: 300, padding: 0, autosize: 'none', signals, data: [{ name: 't', values: rows }], marks }, clicks: 1 + Math.floor(r() * 4) }
}

describe('a mark\'s `on` triggers run as vega runs them (C73)', () => {
  it('generated charts and click sequences: the same items and the same document after every event', async () => {
    const bad: string[] = []
    let changed = 0
    let extra = 0
    for (let seed = 0; seed < 80; seed++) {
      const c = triggerCase(seed)
      const a = asterHost(c.spec)
      const v = await vegaHost(c.spec)
      const first = snap(v.items())
      for (let k = 0; k < c.clicks; k++) {
        a.click()
        await v.click()
        const want = snap(v.items())
        const got = snap(a.items())
        if (want !== got) { bad.push(`seed ${seed} click ${k}: vega ${want} aster ${got}`); break }
        const d = diffCanonical(canonicalizeSvg(await v.svg()), canonicalizeSvg(a.svg()))
        if (d.length) { bad.push(`seed ${seed} click ${k}: ${d[0]}`); break }
        if (want !== first) changed++
        if (v.items().some((it) => it.foo !== undefined || it.fx !== undefined || it.bar !== undefined)) extra++
      }
      while (cleanups.length) cleanups.pop()!()
      document.body.innerHTML = ''
    }
    expect(bad).toEqual([])
    // (not vacuous: the triggers change what vega shows, and write properties no set owns)
    expect(changed).toBeGreaterThan(40)
    expect(extra).toBeGreaterThan(40)
  }, 240_000)
})
