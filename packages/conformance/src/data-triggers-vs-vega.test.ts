// @vitest-environment jsdom
/**
 * A data set's triggers (`on: [{trigger, insert | remove | toggle | modify, values}]`, C73) against vega: each is the operator
 * `if(trigger, modify(name, ...), 0)`, which runs when anything it reads changes and once when the view is built. Aster is driven
 * as a host drives it (evaluate, render, bind; on a change evaluate again from the store and the edited rows), vega gets the same
 * events; after every event the signals that read the data set agree. They were parsed and never run (0 rows throughout).
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
  const data: Record<string, unknown[]> = {}
  let binding: SignalBinding | null = null
  let scene = evaluateChart(chart)
  let dirty = false
  const render = (): void => {
    binding?.detach()
    scene = evaluateChart(chart, { signals: store, data })
    host.innerHTML = ''
    const svg = renderSceneToDomElement(scene) as SVGSVGElement
    svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 50, height: 50 } as DOMRect)
    host.appendChild(svg)
    dirty = false
    binding = bindSceneSignals(svg, scene, store, { onSignal: () => { dirty = true }, onData: (n, rows) => { data[n] = rows; dirty = true } }, { owner: host, data })
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


const READS = [
  { name: 'n', update: "length(data('t'))" },
  { name: 'first', update: "length(data('t')) ? data('t')[0].v : -1" },
]
const CASES: Array<[string, Spec[], unknown[], string[], Spec[]?]> = [
  ['insert, remove, toggle and modify on events', [
    { name: 'ins', value: null, on: [{ events: 'click', update: '{v: 1}' }] },
    { name: 'shift', value: false, on: [{ events: 'dblclick', update: 'true', force: true }] },
    { name: 'tog', value: null, on: [{ events: 'mousedown', update: '{v: 7}', force: true }] },
    { name: 'mod', value: null, on: [{ events: 'mouseup', update: '{}', force: true }] },
  ], [{ trigger: 'ins', insert: 'ins' }, { trigger: 'shift', remove: true }, { trigger: 'tog', toggle: 'tog' }, { trigger: 'mod', modify: "data('t')[0]", values: '{v: 42}' }],
  ['click', 'click', 'mouseup', 'mousedown', 'mousedown', 'dblclick', 'click', 'mouseup']],
  ['a trigger that is true when the view is built (global-development)', [
    { name: 'active', value: {}, on: [{ events: 'click', update: '{v: 3}' }] },
  ], [{ trigger: 'active', toggle: 'active' }], ['click', 'click', 'click']],
  ['a toggle keyed by a clicked value (interactive-legend)', [
    { name: 'clicked', value: null, on: [{ events: 'click', update: '{v: 5}', force: true }] },
    { name: 'clear', value: true, on: [{ events: 'dblclick', update: 'true', force: true }] },
  ], [{ trigger: 'clicked', toggle: 'clicked' }, { trigger: 'clear', remove: true }], ['click', 'click', 'click', 'dblclick', 'click']],
  ['a remove by predicate and an insert of a list', [
    { name: 'add', value: null, on: [{ events: 'click', update: '[{v: 1}, {v: 2}, {v: 3}]' }] },
    { name: 'drop', value: null, on: [{ events: 'dblclick', update: '{v: 2}', force: true }] },
  ], [{ trigger: 'add', insert: 'add' }, { trigger: 'drop', remove: 'drop' }], ['click', 'dblclick', 'click']],
  ['a trigger that reads an earlier data set an event edits (tracked: it runs again)', [
    { name: 'more', value: null, on: [{ events: 'click', update: '{k: 1}', force: true }] },
  ], [{ trigger: "length(data('a')) > 1", insert: "{v: length(data('a'))}" }], ['click', 'click', 'click'],
  [{ name: 'a', values: [], on: [{ trigger: 'more', insert: 'more' }] }]],
]

describe('data set triggers run as vega runs them (C73)', () => {
  for (const [label, signals, on, events, before = []] of CASES) {
    it(label, async () => {
      const spec: Spec = {
        width: 50, height: 50, padding: 0, autosize: 'none', signals: [...signals, ...READS],
        data: [...before, { name: 't', values: [], on }], marks: [rect],
      }
      const names = ['n', 'first']
      const a = asterHost(spec)
      const v = await vegaHost(spec)
      const snap = (h: { read: (n: string) => unknown }): unknown[] => names.map(h.read)
      expect(snap(a), 'when the view is built').toEqual(snap(v))
      for (const [i, type] of events.entries()) {
        a.fire(type)
        await v.fire(type)
        expect(snap(a), `event ${i}: ${type}`).toEqual(snap(v))
      }
    })
  }
})
