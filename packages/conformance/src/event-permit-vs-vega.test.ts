// @vitest-environment jsdom
/**
 * `config.events` decides which listeners are bound, as vega-view's `permit` decides it (C78), and `setSignal` is
 * `view.signal` (C270): the same spec, config and events go to a vega View (renderer svg) and to the Aster binding, with an
 * Aster host that allows every window and selector source (`eventSources`), so the config alone decides on both sides. After
 * every event the signals must agree, and so must the listeners each side reported blocked.
 */
import { afterEach, describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { compileChart, evaluateChart } from '@aster-charts/core'
import { renderSceneToDomElement } from '@aster-charts/core/dom'
import { bindSceneSignals } from '@aster-charts/core/signals'

type Spec = Record<string, unknown>
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
const cleanups: Array<() => void> = []
afterEach(() => { while (cleanups.length) cleanups.pop()!() })

const SIGNALS = [
  { name: 'v', value: 0, on: [{ events: 'click', update: 'v + 1' }] },
  { name: 'vd', value: 0, on: [{ events: 'mousedown', update: 'vd + 1' }] },
  { name: 'w', value: 0, on: [{ events: 'window:keydown', update: 'w + 1' }] },
  { name: 'wm', value: 0, on: [{ events: 'window:mousemove', update: 'wm + 1' }] },
  { name: 's', value: 0, on: [{ events: { source: '#outside', type: 'mousedown' }, update: 's + 1' }] },
  { name: 'su', value: 0, on: [{ events: { source: '#outside', type: 'mouseup' }, update: 'su + 1' }] },
]
const NAMES = SIGNALS.map((s) => s.name)
const specFor = (events: unknown): Spec => ({
  width: 200, height: 100, padding: 0, autosize: 'none', ...(events === undefined ? {} : { config: { events } }), signals: SIGNALS,
  marks: [{ type: 'rect', encode: { update: { x: { value: 0 }, y: { value: 0 }, width: { value: 200 }, height: { value: 100 }, fill: { value: '#ccc' } } } }],
})

function freshHost(): HTMLElement {
  document.body.innerHTML = '<div id="outside"></div><div id="host"></div>'
  return document.getElementById('host')!
}

/** Fire each event at its target; the signal values after each. */
async function drive(svg: Element, read: (n: string) => unknown, after: () => Promise<void>): Promise<unknown[][]> {
  const out: unknown[][] = []
  const outside = document.getElementById('outside')!
  const steps: Array<[EventTarget, Event]> = [
    [svg, new MouseEvent('click', { bubbles: true, clientX: 10, clientY: 10 })],
    [svg, new MouseEvent('mousedown', { bubbles: true, clientX: 10, clientY: 10 })],
    [window, new KeyboardEvent('keydown', { key: 'a' })],
    [window, new MouseEvent('mousemove', { clientX: 5, clientY: 5 })],
    [outside, new MouseEvent('mousedown', { bubbles: true })],
    [outside, new MouseEvent('mouseup', { bubbles: true })],
  ]
  for (const [target, e] of steps) {
    target.dispatchEvent(e)
    await after()
    out.push(NAMES.map(read))
  }
  return out
}

async function oracle(spec: Spec): Promise<{ values: unknown[][]; blocked: string[] }> {
  const host = freshHost()
  const warnings: string[] = []
  // (vega permits its listeners while the View is built: its logger is an option of the constructor)
  const logger = { warn: (m: unknown) => { warnings.push(String(m)) }, error() {}, info() {}, debug() {}, level() { return logger } }
  const view = new vega.View(vega.parse(structuredClone(spec) as never), { renderer: 'svg', logger } as never)
  view.initialize(host)
  cleanups.push(() => view.finalize())
  await view.runAsync()
  const values = await drive(host.querySelector('svg')!, (n) => view.signal(n), async () => { await view.runAsync(); await tick() })
  // (vega's view also binds a pointermove listener of its own, for the cursor: Aster's cursor tracker is a separate piece,
  // cursor.ts, which honours the same rule; only the listeners the spec declares are compared)
  const declared = /^Blocked \w+ (click|mousedown|keydown|mousemove|mouseup) event listener\.$/
  return { values, blocked: warnings.filter((w) => declared.test(w)).sort() }
}

async function aster(spec: Spec): Promise<{ values: unknown[][]; blocked: string[] }> {
  const host = freshHost()
  const chart = compileChart(structuredClone(spec) as never)
  const scene = evaluateChart(chart)
  const svg = renderSceneToDomElement(scene) as SVGSVGElement
  host.appendChild(svg)
  svg.getBoundingClientRect = () => ({ left: 0, top: 0, right: 200, bottom: 100, width: 200, height: 100 } as DOMRect)
  const store: Record<string, unknown> = {}
  const warnings: string[] = []
  const b = bindSceneSignals(svg, scene, store, { logger: { warn: (m) => { warnings.push(String(m)) }, error() {} } }, { eventSources: { window: true, selector: true } })
  cleanups.push(() => b.release())
  const values = await drive(svg, (n) => (Object.hasOwn(store, n) ? store[n] : 0), tick)
  return { values, blocked: warnings.filter((w) => w.startsWith('Blocked')).sort() }
}

const CONFIGS: Array<[string, unknown]> = [
  ['no events config', undefined],
  ['view, window and selector false', { view: false, window: false, selector: false }],
  ['window lists keydown, selector empty', { window: ['keydown'], selector: [] }],
  ['view lists mousedown', { view: ['mousedown'] }],
  ['selector lists mouseup, window lists mousemove', { selector: ['mouseup'], window: ['mousemove'] }],
  ['an object rule: view {click: true}', { view: { click: true } }],
  ['true rules', { view: true, window: true, selector: true }],
  ['defaults only', { defaults: { prevent: false } }],
]

describe('config.events permits listeners as vega does (C78)', () => {
  for (const [label, events] of CONFIGS) {
    it(label, async () => {
      const spec = specFor(events)
      const want = await oracle(spec)
      const got = await aster(spec)
      expect(got.values).toEqual(want.values)
      expect(got.blocked).toEqual(want.blocked)
    })
  }
})

describe('setSignal is view.signal (C270)', () => {
  const spec: Spec = {
    width: 50, height: 50, signals: [{ name: 'a', value: 1 }, { name: 'n', value: 0, on: [{ events: { signal: 'a' }, update: 'n + 1' }] }, { name: 'd', update: 'a * 2' }],
  }
  it('the current value changes nothing, another one runs the dependents, and an undeclared name throws', async () => {
    const view = new vega.View(vega.parse(structuredClone(spec) as never), { renderer: 'none' })
    cleanups.push(() => view.finalize())
    await view.runAsync()
    const chart = compileChart(structuredClone(spec) as never)
    const scene = evaluateChart(chart)
    const svg = renderSceneToDomElement(scene)
    freshHost().appendChild(svg)
    const store: Record<string, unknown> = {}
    const b = bindSceneSignals(svg, scene, store)
    cleanups.push(() => b.release())
    const read = (n: string): unknown => (Object.hasOwn(store, n) ? store[n] : (scene as unknown as { signalParams: Record<string, unknown> }).signalParams[n])
    for (const value of [1, 1, 2, 2, 3]) {
      view.signal('a', value)
      await view.runAsync()
      b.setSignal('a', value)
      expect(['a', 'n', 'd'].map(read)).toEqual(['a', 'n', 'd'].map((n) => view.signal(n)))
    }
    expect(() => view.signal('nope', 5)).toThrow('Unrecognized signal name: "nope"')
    expect(() => b.setSignal('nope', 5)).toThrow('Unrecognized signal name: "nope"')
  })
})
