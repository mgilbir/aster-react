// @vitest-environment jsdom
/**
 * `encode.hover`, as vega's view runs it (vega-view hover.js, which vega-embed turns on for a Vega spec; C76).
 *
 * A pointer that enters an item of a mark with a `hover` set encodes the item with that set; leaving it encodes it with the mark's
 * `update` set: the channels `update` writes go back, a channel only `hover` writes stays as hover left it, and a channel only
 * `enter` writes is not run again. A mark without a hover set is left alone, and so is everything else. Aster is driven as a host
 * drives it (evaluate, render, bind with the scene's hit index and its default hover; on a change evaluate again from the store),
 * vega gets the same events on the same items with `hover()` on; after every event the items' channels, and the order the SVG
 * draws them in (a hover that raises `zindex`), agree. Generated: which channels each set writes, zindex in hover, other marks
 * beside it with and without a hover set, the mark inside a group, and event sequences over the items.
 */
import { afterEach, describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { compileChart, evaluateChart } from '@aster-charts/core'
import { renderSceneToDomElement } from '@aster-charts/core/dom'
import { buildHitIndex } from '@aster-charts/core/hit'
import { bindSceneSignals, type SignalBinding } from '@aster-charts/core/signals'
import { renderSceneToSvg } from '@aster-charts/core'
import { canonicalizeSvg, diffCanonical } from './normalize.js'

type Spec = Record<string, unknown>
type Item = Record<string, unknown>
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
const cleanups: Array<() => void> = []
afterEach(() => { while (cleanups.length) cleanups.pop()!(); document.body.innerHTML = '' })

interface Step { type: 'pointerover' | 'pointerout'; at: number }
const CHANNELS = ['fill', 'stroke', 'size', 'opacity', 'zindex', 'x', 'y']
const snap = (items: Item[]): unknown[] => items.map((it) => CHANNELS.map((c) => it[c] ?? null))

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

/** The order the SVG draws the items of `pts` in (their fill-opacity holds the item's index). */
const drawn = (root: Element): string => [...root.querySelectorAll('.mark-symbol.pts path')].map((p) => p.getAttribute('fill-opacity')).join(',')

function asterHost(spec: Spec): { fire: (s: Step) => void; items: () => Item[]; order: () => string } {
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
    const hit = buildHitIndex(scene)
    binding = bindSceneSignals(svg, scene, store, { onSignal: () => { dirty = true }, onEncode: (all) => { store = { ...all }; dirty = true } }, { owner: host, pick: (x, y) => hit.pick(x, y) })
  }
  render()
  cleanups.push(() => binding?.release())
  const items = (): Item[] => findMark(scene, 'pts')!
  return {
    fire: ({ type, at }) => {
      const it = items()[at]!
      host.querySelector('svg')!.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: (it.x as number) + 5, clientY: (it.y as number) + 5 }))
      if (dirty) render()
    },
    items,
    order: () => drawn(host),
  }
}

async function vegaHost(spec: Spec): Promise<{ fire: (s: Step) => Promise<void>; items: () => Item[]; order: () => string }> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const view = new vega.View(vega.parse(structuredClone(spec) as never), { renderer: 'svg', hover: true }).initialize(host)
  cleanups.push(() => view.finalize())
  await view.runAsync()
  const items = (): Item[] => findMark((view.scenegraph() as unknown as { root: unknown }).root, 'pts')!
  return {
    fire: async ({ type, at }) => {
      // (the element of item `at`, wherever the SVG draws it: its fill-opacity holds its index)
      const target = [...host.querySelectorAll('.mark-symbol.pts path')].find((p) => p.getAttribute('fill-opacity') === String(0.5 + at / 100))!
      target.dispatchEvent(new MouseEvent(type, { bubbles: true }))
      await view.runAsync()
      await tick()
    },
    items,
    order: () => drawn(host),
  }
}

/** A generated chart: the mark `pts` (items far apart, so each event is about the item it names) and its sets, maybe in a group. */
function hoverCase(seed: number): { spec: Spec; steps: Step[] } {
  const r = stream(seed * 7717 + 1)
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!
  const n = 3 + Math.floor(r() * 3)
  const rows = Array.from({ length: n }, (_, i) => ({ i, u: 20 + i * 50, v: 20 + i * 40 }))
  const writes = (): Spec => {
    const out: Spec = {}
    if (r() < 0.6) out.fill = { value: pick(['firebrick', 'gold', 'teal']) }
    if (r() < 0.4) out.stroke = { value: pick(['black', 'purple']) }
    if (r() < 0.4) out.size = { value: pick([400, 900]) }
    if (r() < 0.4) out.zindex = { value: pick([1, 2]) }
    return out
  }
  const enter: Spec = { fill: { value: 'steelblue' }, fillOpacity: { signal: '0.5 + datum.i / 100' }, ...(r() < 0.5 ? { stroke: { value: 'gray' } } : {}) }
  const update: Spec = { x: { field: 'u' }, y: { field: 'v' }, size: { value: 200 }, ...writes() }
  const hover = writes()
  if (Object.keys(hover).length === 0) hover.fill = { value: 'red' }
  const pts: Spec = { type: 'symbol', name: 'pts', from: { data: 't' }, encode: { enter, update, hover } }
  const other: Spec = { type: 'rect', from: { data: 't' }, encode: { update: { x: { field: 'u' }, y: { signal: 'datum.v + 200' }, width: { value: 9 }, height: { value: 9 }, fill: { value: '#ccc' } }, ...(r() < 0.5 ? { hover: { fill: { value: 'black' } } } : {}) } }
  const marks = r() < 0.3 ? [{ type: 'group', encode: { update: { width: { value: 300 }, height: { value: 300 } } }, marks: [other, pts] }] : [other, pts]
  const steps: Step[] = []
  let over = -1
  for (let k = 0; k < 8; k++) {
    if (over >= 0 && r() < 0.6) { steps.push({ type: 'pointerout', at: over }); over = -1 } else { over = Math.floor(r() * n); steps.push({ type: 'pointerover', at: over }) }
  }
  return { spec: { width: 300, height: 300, padding: 0, autosize: 'none', data: [{ name: 't', values: rows }], marks }, steps }
}

describe('encode.hover, as vega view.hover() runs it (C76)', () => {
  it('generated charts and pointer sequences: the same channels and the same paint order after every event', async () => {
    const bad: string[] = []
    let changed = 0
    for (let seed = 0; seed < 40; seed++) {
      const c = hoverCase(seed)
      const a = asterHost(c.spec)
      const v = await vegaHost(c.spec)
      const first = JSON.stringify(snap(v.items()))
      for (const [k, step] of c.steps.entries()) {
        a.fire(step)
        await v.fire(step)
        const want = JSON.stringify(snap(v.items()))
        const got = JSON.stringify(snap(a.items()))
        if (want !== got) { bad.push(`seed ${seed} step ${k} ${step.type}@${step.at}: vega ${want} aster ${got}`); break }
        if (v.order() !== a.order()) { bad.push(`seed ${seed} step ${k}: drawn vega ${v.order()} aster ${a.order()}`); break }
        if (want !== first) changed++
      }
      while (cleanups.length) cleanups.pop()!()
      document.body.innerHTML = ''
    }
    expect(bad).toEqual([])
    // (not vacuous: the hover sets change what vega shows)
    expect(changed).toBeGreaterThan(100)
  }, 120_000)

  it('`hover: false` leaves every item as it was', async () => {
    const c = hoverCase(3)
    const chart = compileChart(structuredClone(c.spec) as never)
    const scene = evaluateChart(chart)
    const svg = renderSceneToDomElement(scene) as SVGSVGElement
    document.body.appendChild(svg)
    let told = 0
    const hit = buildHitIndex(scene)
    const binding = bindSceneSignals(svg, scene, {}, { onSignal: () => { told++ }, onEncode: () => { told++ } }, { pick: (x, y) => hit.pick(x, y), hover: false })
    cleanups.push(() => binding.release())
    const it = findMark(scene, 'pts')![0]!
    svg.dispatchEvent(new MouseEvent('pointerover', { bubbles: true, clientX: (it.x as number) + 5, clientY: (it.y as number) + 5 }))
    expect(told).toBe(0)
  })

  it('an `exit` set: the items whose rows go are encoded with it and leave the scene, as in vega (nothing of them is drawn)', async () => {
    const bad: string[] = []
    for (let seed = 0; seed < 12; seed++) {
      const c = hoverCase(seed)
      const marks = c.spec.marks as Spec[]
      const pts = (marks.find((m) => m.name === 'pts') ?? (marks[0]!.marks as Spec[]).find((m) => m.name === 'pts'))!
      ;(pts.encode as Spec).exit = { fill: { value: 'black' }, size: { value: 5000 }, x: { value: 0 } }
      const rows = ((c.spec.data as Array<{ values: Item[] }>)[0]!.values)
      const kept = rows.filter((_, i) => i % 2 === 0)
      const view = new vega.View(vega.parse(structuredClone(c.spec) as never), { renderer: 'none' })
      await view.runAsync()
      view.data('t', structuredClone(kept))
      await view.runAsync()
      const want = await view.toSVG()
      view.finalize()
      const chart = compileChart(structuredClone(c.spec) as never)
      evaluateChart(chart)
      const got = renderSceneToSvg(evaluateChart(chart, { data: { t: structuredClone(kept) } }))
      const d = diffCanonical(canonicalizeSvg(want), canonicalizeSvg(got))
      if (d.length) bad.push(`seed ${seed}: ${d[0]}`)
      if (/fill="black"/.test(want)) bad.push(`seed ${seed}: vega drew an exiting item`)
    }
    expect(bad).toEqual([])
  })
})
