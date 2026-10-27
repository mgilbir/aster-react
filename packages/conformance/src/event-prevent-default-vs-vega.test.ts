// @vitest-environment jsdom
/**
 * Which events get `preventDefault()`, against real Vega in the same process (vega-view `events.js`: `prevent`).
 *
 * A vega view prevents the default action of every event of the `view` source that a stream listens to, unless the
 * event config says otherwise: `config.events.defaults` is `{allow: ['wheel']}` by default, a `prevent` / `allow` list or
 * boolean overrides it, and with neither `view.preventDefault()` (default false) decides. `consume` always prevents.
 * Window, selector and timer sources are never prevented by the config. The same spec, config and events go to a
 * vega View (renderer svg, hover) and to the Aster binding; the verdict (`defaultPrevented`) of each must agree.
 */
import { afterEach, describe, expect, it } from 'vitest'
import * as vega from 'vega'
import * as vl from 'vega-lite'
import { compileChart, evaluateChart } from '@aster/core'
import { renderSceneToDomElement } from '@aster/core/dom'
import { bindSceneSignals } from '@aster/core/signals'

type Spec = Record<string, unknown>
type VegaView = {
  initialize(el: Element): VegaView
  hover(): VegaView
  runAsync(): Promise<unknown>
  preventDefault(v?: boolean): unknown
  finalize(): void
}

/** Event types spanning mouse, wheel, touch, pointer, key, drag, context menu: the verdict must not depend on the name. */
const TYPES = ['mousedown', 'mouseup', 'mousemove', 'mouseover', 'click', 'dblclick', 'contextmenu', 'wheel', 'touchstart', 'touchmove', 'touchend', 'pointerdown', 'pointermove', 'dragstart', 'keydown', 'selectstart'] as const

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
const cleanups: Array<() => void> = []
afterEach(() => { while (cleanups.length) cleanups.pop()!() })

const mark = { type: 'rect', encode: { update: { x: { value: 0 }, y: { value: 0 }, width: { value: 200 }, height: { value: 100 }, fill: { value: '#ccc' } } } }

const VARIANTS: Array<[string, (t: string) => unknown]> = [
  ['plain', (t) => ({ type: t })],
  ['view', (t) => ({ source: 'view', type: t })],
  ['consume', (t) => ({ type: t, consume: true })],
  ['filtered', (t) => ({ type: t, filter: 'false' })],
  ['filteredConsume', (t) => ({ type: t, filter: 'false', consume: true })],
  ['window', (t) => ({ source: 'window', type: t })],
  ['windowConsume', (t) => ({ source: 'window', type: t, consume: true })],
  ['selector', (t) => ({ source: '#outside', type: t })],
  ['between', (t) => ({ type: t, between: [{ type: 'click' }, { type: 'dblclick' }] })],
]
const targetOfVariant = (v: string): 'view' | 'window' | 'selector' => (v.startsWith('window') ? 'window' : v === 'selector' ? 'selector' : 'view')

/** One signal per event type, every stream of one variant (streams of different variants would share a listener, and a consume would decide for all). */
function specFor(config: unknown, variant: string): Spec {
  const mk = VARIANTS.find(([v]) => v === variant)![1]
  const signals = TYPES.map((t) => ({ name: `s_${t}`, value: 0, on: [{ events: mk(t), update: 'event.clientX' }] }))
  return { width: 200, height: 100, padding: 0, ...(config === undefined ? {} : { config }), signals, marks: [mark] }
}

/** The verdict of each event type sent where the variant listens. */
type Verdicts = Record<string, boolean>

async function verdicts(svg: Element, spec: Spec, variant: string): Promise<Verdicts> {
  const out: Verdicts = {}
  const target: EventTarget = { view: svg, window, selector: document.getElementById('outside')! }[targetOfVariant(variant)]
  for (const s of spec.signals as Array<{ name: string }>) {
    const type = s.name.slice(2)
    const e = new MouseEvent(type, { bubbles: false, cancelable: true, clientX: 10, clientY: 10 })
    target.dispatchEvent(e)
    await tick()
    out[type] = e.defaultPrevented
  }
  // an event type no stream listens to is never prevented
  const unheard = new MouseEvent('mouseenter', { bubbles: false, cancelable: true })
  svg.dispatchEvent(unheard)
  await tick()
  out.unheard = unheard.defaultPrevented
  return out
}

function freshHost(): HTMLElement {
  document.body.innerHTML = '<div id="outside"></div><div id="host"></div>'
  return document.getElementById('host')!
}

async function oracle(spec: Spec, variant: string, viewPrevent: boolean | undefined): Promise<Verdicts> {
  const host = freshHost()
  const v = new (vega as unknown as { View: new (rt: unknown, o: unknown) => VegaView }).View(vega.parse(structuredClone(spec) as never), { renderer: 'svg' }).initialize(host).hover()
  cleanups.push(() => v.finalize())
  if (viewPrevent !== undefined) v.preventDefault(viewPrevent)
  await v.runAsync()
  return verdicts(host.querySelector('svg')!, spec, variant)
}

async function aster(spec: Spec, variant: string, viewPrevent: boolean | undefined): Promise<Verdicts> {
  const host = freshHost()
  const chart = compileChart(structuredClone(spec) as never)
  const scene = evaluateChart(chart)
  const svg = renderSceneToDomElement(scene) as SVGSVGElement
  host.appendChild(svg)
  svg.getBoundingClientRect = () => ({ left: 0, top: 0, right: 200, bottom: 100, width: 200, height: 100 } as DOMRect)
  const b = bindSceneSignals(svg, scene, { ...chart.signals }, viewPrevent === undefined ? {} : { preventDefault: viewPrevent })
  cleanups.push(() => b.detach())
  return verdicts(svg, spec, variant)
}

const CONFIGS: Array<[string, unknown]> = [
  ['no config (vega default: allow wheel)', undefined],
  ['defaults: allow []', { events: { defaults: { allow: [] } } }],
  ['defaults: allow [click, mousemove]', { events: { defaults: { allow: ['click', 'mousemove'] } } }],
  ['defaults: allow true', { events: { defaults: { allow: true } } }],
  ['defaults: allow false', { events: { defaults: { allow: false } } }],
  ['defaults: prevent [mousedown, wheel, touchstart]', { events: { defaults: { prevent: ['mousedown', 'wheel', 'touchstart'] } } }],
  ['defaults: prevent []', { events: { defaults: { prevent: [] } } }],
  ['defaults: prevent true', { events: { defaults: { prevent: true } } }],
  ['defaults: prevent false', { events: { defaults: { prevent: false } } }],
  ['defaults: prevent false, allow true', { events: { defaults: { prevent: false, allow: true } } }],
  ['defaults: prevent [click], allow [click]', { events: { defaults: { prevent: ['click'], allow: ['mousedown'] } } }],
  ['defaults: {} (neither: view.preventDefault())', { events: { defaults: {} } }],
  ['events: {} (defaults inherited from the default config)', { events: {} }],
]

describe('preventDefault on view events, as vega decides it', () => {
  for (const [label, config] of CONFIGS) {
    for (const viewPrevent of [undefined, true, false]) {
      it(`${label}; view.preventDefault(${viewPrevent})`, async () => {
        for (const [variant] of VARIANTS) {
          const spec = specFor(config, variant)
          const expected = await oracle(spec, variant, viewPrevent)
          expect({ variant, got: await aster(spec, variant, viewPrevent) }).toEqual({ variant, got: expected })
        }
      })
    }
  }

  it('the oracle prevents view events except wheel by default, consumed ones always, other sources never', async () => {
    const v = async (variant: string): Promise<Verdicts> => oracle(specFor(undefined, variant), variant, undefined)
    const plain = await v('plain')
    expect(plain.pointerdown).toBe(true)
    expect(plain.mousedown).toBe(true)
    expect(plain.wheel).toBe(false)
    expect(plain.unheard).toBe(false)
    expect((await v('filtered')).mousedown).toBe(true)
    expect((await v('consume')).wheel).toBe(true)
    expect((await v('window')).mousedown).toBe(false)
    expect((await v('windowConsume')).mousedown).toBe(true)
    expect((await v('selector')).mousedown).toBe(false)
  })
})

describe('an interval brush (vega-lite) prevents the drag it listens to', () => {
  const vlSpec = {
    $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
    width: 200, height: 100,
    data: { values: [{ a: 1, b: 2 }, { a: 3, b: 4 }] },
    params: [{ name: 'brush', select: 'interval' }],
    mark: 'point',
    encoding: { x: { field: 'a', type: 'quantitative' }, y: { field: 'b', type: 'quantitative' } },
  }
  it('pointerdown and dblclick are prevented as vega prevents them, wheel is not', async () => {
    const spec = vl.compile(vlSpec as never).spec as unknown as Spec
    const heard = new Set<string>()
    const walk = (x: unknown): void => {
      if (Array.isArray(x)) x.forEach(walk)
      else if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) { if (k === 'events' || k === 'type') { if (typeof v === 'string') heard.add(v) } walk(v) }
    }
    walk((spec.signals as unknown[]))
    const host = freshHost()
    const v = new (vega as unknown as { View: new (rt: unknown, o: unknown) => VegaView }).View(vega.parse(structuredClone(spec) as never), { renderer: 'svg' }).initialize(host).hover()
    cleanups.push(() => v.finalize())
    await v.runAsync()
    const oracleSvg = host.querySelector('svg')!
    const want: Record<string, boolean> = {}
    for (const t of ['pointerdown', 'pointermove', 'pointerup', 'dblclick', 'wheel', 'keydown']) {
      const e = new MouseEvent(t, { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })
      oracleSvg.dispatchEvent(e); await tick(); want[t] = e.defaultPrevented
    }
    expect(want.pointerdown).toBe(true)
    expect(want.wheel).toBe(false)
    const host2 = freshHost()
    const chart = compileChart(structuredClone(spec) as never)
    const scene = evaluateChart(chart)
    const svg = renderSceneToDomElement(scene) as SVGSVGElement
    host2.appendChild(svg)
    svg.getBoundingClientRect = () => ({ left: 0, top: 0, right: 200, bottom: 100, width: 200, height: 100 } as DOMRect)
    const b = bindSceneSignals(svg, scene, { ...chart.signals }, {})
    cleanups.push(() => b.detach())
    const got: Record<string, boolean> = {}
    for (const t of Object.keys(want)) {
      const e = new MouseEvent(t, { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })
      svg.dispatchEvent(e); await tick(); got[t] = e.defaultPrevented
    }
    expect(got).toEqual(want)
    expect(heard.size).toBeGreaterThan(0)
  })
})
