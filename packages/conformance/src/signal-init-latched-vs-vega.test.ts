// @vitest-environment jsdom
/**
 * A signal's `init` is evaluated once, when vega builds the view, whatever it read changes later (C143). Aster is driven as a host
 * drives it (evaluate, render, bind; on a change evaluate again from the store, render, bind again); vega gets the same events. After
 * every event the signals agree. Before the fix every render after a change evaluated the `init` again (`i = s * 2` followed `s`).
 */
import { afterEach, describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { compileChart, evaluateChart } from '@aster-charts/core'
import { renderSceneToDomElement } from '@aster-charts/core/dom'
import { bindSceneSignals, type SignalBinding } from '@aster-charts/core/signals'

type Spec = Record<string, unknown>
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
const cleanups: Array<() => void> = []
afterEach(() => { while (cleanups.length) cleanups.pop()!(); document.body.innerHTML = '' })

const rect = { type: 'rect', encode: { update: { x: { value: 0 }, y: { value: 0 }, width: { value: 50 }, height: { value: 50 }, fill: { value: 'red' } } } }

function asterHost(spec: Spec): { fire: (type: string) => void; read: (name: string) => unknown } {
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
    svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 50, height: 50 } as DOMRect)
    host.appendChild(svg)
    dirty = false
    binding = bindSceneSignals(svg, scene, store, { onSignal: () => { dirty = true } }, { owner: host })
  }
  render()
  cleanups.push(() => binding?.release())
  return {
    fire: (type) => {
      host.querySelector('svg')!.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: 10, clientY: 10 }))
      if (dirty) render()
    },
    read: (name) => (Object.hasOwn(store, name) ? store[name] : (scene as unknown as { signalParams: Record<string, unknown> }).signalParams[name]),
  }
}

async function vegaHost(spec: Spec): Promise<{ fire: (type: string) => Promise<void>; read: (name: string) => unknown }> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const view = new vega.View(vega.parse(structuredClone(spec) as never), { renderer: 'svg' }).initialize(host)
  cleanups.push(() => view.finalize())
  await view.runAsync()
  return {
    fire: async (type) => {
      host.querySelector('svg')!.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: 10, clientY: 10 }))
      await view.runAsync()
      await tick()
    },
    read: (name) => view.signal(name),
  }
}

const CASES: Array<[string, Spec[], string[]]> = [
  ['an init that reads a signal an event changes', [
    { name: 's', value: 1, on: [{ events: 'click', update: 's + 1' }] },
    { name: 'i', init: 's * 2' },
  ], ['s', 'i']],
  ['an init with a handler of its own', [
    { name: 's', value: 1, on: [{ events: 'click', update: 's + 1' }] },
    { name: 'iu', init: 's * 3', on: [{ events: 'dblclick', update: '100' }] },
  ], ['s', 'iu']],
  ['a derived signal reading an init', [
    { name: 's', value: 1, on: [{ events: 'click', update: 's + 1' }] },
    { name: 'i', init: 's * 2' },
    { name: 'd', update: 'i + s' },
  ], ['s', 'i', 'd']],
  ['an init over data', [
    { name: 's', value: 1, on: [{ events: 'click', update: 's + 1' }] },
    { name: 'n', init: "length(data('t')) + s" },
  ], ['s', 'n']],
]

describe('an init is evaluated once, as vega evaluates it (C143)', () => {
  for (const [label, signals, names] of CASES) {
    it(label, async () => {
      const spec: Spec = { width: 50, height: 50, padding: 0, autosize: 'none', signals, data: [{ name: 't', values: [{ v: 1 }, { v: 2 }] }], marks: [rect] }
      const a = asterHost(spec)
      const v = await vegaHost(spec)
      const snap = (h: { read: (n: string) => unknown }): unknown[] => names.map(h.read)
      expect(snap(a)).toEqual(snap(v))
      for (const type of ['click', 'click', 'dblclick', 'click']) {
        a.fire(type)
        await v.fire(type)
        expect(snap(a), type).toEqual(snap(v))
      }
    })
  }
})
