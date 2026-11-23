// @vitest-environment jsdom
/**
 * A signal handler's `encode: <set>` (vega-parser: the update `encode(item(), <set>)`): the event's item is encoded again with the
 * named set of its mark, and keeps what it wrote until the mark's `update` runs on it again (a parameter of its encode sets, or
 * its datum, changed), where `update` takes back the channels it writes and leaves the others. Aster is driven as a host drives
 * it (evaluate, render, bind with the scene's hit index; on a change evaluate again from the store), vega gets the same events on
 * the same items; after every event the items' channels agree. The handlers were refused when the spec was compiled (C629),
 * which DECISIONS Q6 rules out: zoomable-scatter-plot and zoomable-binned-plot of the gallery use them.
 */
import { afterEach, describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { compileChart, evaluateChart } from '@aster-charts/core'
import { renderSceneToDomElement } from '@aster-charts/core/dom'
import { buildHitIndex } from '@aster-charts/core/hit'
import { bindSceneSignals, type SignalBinding } from '@aster-charts/core/signals'

type Spec = Record<string, unknown>
type Item = Record<string, unknown>
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
const cleanups: Array<() => void> = []
afterEach(() => { while (cleanups.length) cleanups.pop()!(); document.body.innerHTML = '' })

/** An event on item `at` of the mark `pts`, or on the view's background (`at` null). */
interface Step { type: string; at: number | null }
const CHANNELS = ['fill', 'size', 'stroke', 'x', 'y']
const snap = (items: Item[]): unknown[] => items.map((it) => CHANNELS.map((c) => it[c] ?? null))

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

function asterHost(spec: Spec): { fire: (s: Step) => void; items: () => Item[] } {
  const chart = compileChart(structuredClone(spec) as never)
  const host = document.createElement('div')
  document.body.appendChild(host)
  const store: Record<string, unknown> = {}
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
    binding = bindSceneSignals(svg, scene, store, { onSignal: () => { dirty = true } }, { owner: host, pick: (x, y) => hit.pick(x, y) })
  }
  render()
  cleanups.push(() => binding?.release())
  const items = (): Item[] => findMark(scene, 'pts')!
  return {
    fire: ({ type, at }) => {
      const it = at === null ? { x: 290, y: 290 } : items()[at]!
      host.querySelector('svg')!.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: it.x as number, clientY: it.y as number }))
      if (dirty) render()
    },
    items,
  }
}

async function vegaHost(spec: Spec): Promise<{ fire: (s: Step) => Promise<void>; items: () => Item[] }> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const view = new vega.View(vega.parse(structuredClone(spec) as never), { renderer: 'svg', hover: false }).initialize(host)
  cleanups.push(() => view.finalize())
  await view.runAsync()
  const items = (): Item[] => findMark((view.scenegraph() as unknown as { root: unknown }).root, 'pts')!
  return {
    fire: async ({ type, at }) => {
      const svg = host.querySelector('svg')!
      const target = at === null ? svg : svg.querySelectorAll('.mark-symbol.pts path')[at]!
      target.dispatchEvent(new MouseEvent(type, { bubbles: true }))
      await view.runAsync()
      await tick()
    },
    items,
  }
}

const base = (signals: Spec[], sets: Spec, update: Spec = {}): Spec => ({
  width: 300, height: 300, padding: 0, autosize: 'none',
  signals: [
    { name: 'size', value: 100, on: [{ events: 'dblclick', update: 'size * 2' }] },
    { name: 'k', value: 1, on: [{ events: 'click', update: 'k + 1' }] },
    { name: 'tint', value: 'orange', on: [{ events: 'keydown', update: "'purple'" }] },
    ...signals,
  ],
  data: [{ name: 't', values: [{ u: 1, v: 1 }, { u: 3, v: 2 }, { u: 5, v: 3 }] }],
  scales: [
    { name: 'x', type: 'linear', domain: { signal: '[0, 10 * k]' }, range: [0, 200], zero: false, nice: false },
    { name: 'y', type: 'linear', domain: [0, 4], range: [200, 0], zero: false, nice: false },
  ],
  marks: [{
    type: 'symbol', name: 'pts', from: { data: 't' },
    encode: {
      enter: { fill: { value: 'steelblue' }, stroke: { value: 'black' } },
      update: { x: { scale: 'x', field: 'u' }, y: { scale: 'y', field: 'v' }, size: { signal: 'size' }, ...update },
      ...sets,
    },
  }],
})
const ZOOMABLE = { hover: { fill: { value: 'firebrick' } }, leave: { fill: { value: 'steelblue' } }, select: { size: { signal: 'size', mult: 5 } }, release: { size: { signal: 'size' } } }
const HANDLERS = [{ name: 'point', value: null, on: [
  { events: '*:pointerover', encode: 'hover' }, { events: '*:pointerout', encode: 'leave' },
  { events: '*:pointerdown', encode: 'select' }, { events: '*:pointerup', encode: 'release' },
] }]

const CASES: Array<[string, Spec, Step[]]> = [
  ['hover, leave, select and release (zoomable-scatter-plot)', base(HANDLERS, ZOOMABLE), [
    { type: 'pointerover', at: 0 }, { type: 'pointerdown', at: 0 }, { type: 'pointerup', at: 0 },
    { type: 'pointerover', at: 1 }, { type: 'pointerout', at: 1 }, { type: 'pointerover', at: 1 },
  ]],
  ['a run of update takes back what it writes, not the rest', base(HANDLERS, ZOOMABLE), [
    { type: 'pointerover', at: 0 }, { type: 'pointerdown', at: 2 },
    // (a scale of the encode changes: update runs on every item; the select's size goes, the hover's fill stays)
    { type: 'click', at: null },
    { type: 'pointerdown', at: 1 },
    // (a signal update reads changes)
    { type: 'dblclick', at: null }, { type: 'pointerover', at: 2 },
  ]],
  ['a signal only a named set reads also re-runs update', base(HANDLERS, { ...ZOOMABLE, hover: { fill: { signal: 'tint' }, stroke: { signal: 'tint' } } }, { stroke: { value: 'gray' } }), [
    { type: 'pointerover', at: 0 }, { type: 'keydown', at: null }, { type: 'pointerover', at: 1 },
  ]],
  ['a set the mark does not have changes nothing', base([{ name: 'p', value: null, on: [{ events: '*:pointerover', encode: 'nosuch' }] }], ZOOMABLE), [
    { type: 'pointerover', at: 0 }, { type: 'pointerover', at: 2 },
  ]],
  ['an event on the background (no item) changes nothing', base(HANDLERS, ZOOMABLE), [
    { type: 'pointerover', at: null }, { type: 'pointerdown', at: null }, { type: 'pointerover', at: 1 },
  ]],
]

describe('a handler\'s `encode: <set>` re-encodes the event\'s item as vega does (C629, DECISIONS Q6)', () => {
  for (const [label, spec, steps] of CASES) {
    it(label, async () => {
      const a = asterHost(spec)
      const v = await vegaHost(spec)
      expect(snap(a.items())).toEqual(snap(v.items()))
      let moved = false
      const initial = JSON.stringify(snap(v.items()))
      for (const [i, s] of steps.entries()) {
        a.fire(s)
        await v.fire(s)
        expect(snap(a.items()), `after ${i}: ${s.type} on ${s.at ?? 'the background'}`).toEqual(snap(v.items()))
        if (JSON.stringify(snap(v.items())) !== initial) moved = true
      }
      // (not vacuous: vega's items changed, except where the case says nothing does)
      if (!label.includes('changes nothing')) expect(moved).toBe(true)
    })
  }
  it('the refusal is gone, and encode with update is vega\'s error', () => {
    expect(() => compileChart(base(HANDLERS, ZOOMABLE) as never)).not.toThrow()
    expect(() => compileChart(base([{ name: 'p', on: [{ events: 'click', encode: 'hover', update: '1' }] }], ZOOMABLE) as never)).toThrow('Signal encode and update are mutually exclusive.')
  })
})
