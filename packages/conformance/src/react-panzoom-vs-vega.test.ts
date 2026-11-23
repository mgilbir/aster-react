// @vitest-environment jsdom
/**
 * `<Chart panZoom>` / `onSelect` against real Vega running Vega-Lite's own interval selection (C44, C155, C488).
 *
 * The oracle is a Vega-Lite chart with `params: [{ select: 'interval', bind: 'scales' }]` (pan by drag, zoom by wheel) or a
 * plain interval brush, compiled by vega-lite 6.4.3 and run by vega 6.3.1 in this process, fed the same native events. Aster
 * draws the same chart WITHOUT the param, with its own pan / zoom / brush props, fed the same events. After every gesture the
 * visible domain (vega's scale domain, Aster's `onViewChange` view) and the brushed interval must agree, for every continuous
 * scale type, in the space Vega-Lite moves it in (log, pow, symlog in their transformed space; linear, sqrt, time and utc
 * linearly, time and utc in milliseconds), and one line-mode wheel notch zooms as far as sixteen pixel-mode units, with
 * or without a modifier key.
 *
 * Aster bounds the zoom (never past the unzoomed extent, at most `maxZoom`); the gestures here stay inside both bounds.
 */
import { afterEach, describe, expect, it } from 'vitest'
import * as vega from 'vega'
import * as vl from 'vega-lite'
import * as React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import * as vegaUtil from 'vega-util'
import { Chart, cursorZoom, keyboardView, panDomain } from '@aster-charts/react'
import { SvgChart } from '@aster-charts/react/lite'
import { interaction } from '@aster-charts/react/interaction'

type Spec = Record<string, unknown>
type VegaView = {
  initialize(el: Element): VegaView
  runAsync(): Promise<unknown>
  scale(name: string): { domain(): unknown[] }
  signal(name: string): unknown
  finalize(): void
}
type Domain = [number, number]

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const cleanups: Array<() => void> = []
afterEach(() => { while (cleanups.length) cleanups.pop()!(); document.body.innerHTML = '' })
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

const W = 300
const H = 200
const DAY = 86_400_000
const T0 = Date.UTC(2024, 0, 1)

/** One positional field per scale kind: its rows and its Vega-Lite scale. */
interface Kind { name: string; type: 'quantitative' | 'temporal'; values: number[]; scale: Spec }
const KINDS: Kind[] = [
  { name: 'linear', type: 'quantitative', values: [1, 4, 9, 20], scale: { type: 'linear', nice: false } },
  { name: 'log', type: 'quantitative', values: [1, 30, 400, 1000], scale: { type: 'log', nice: false } },
  { name: 'log, negative', type: 'quantitative', values: [-1000, -40, -3, -1], scale: { type: 'log', nice: false } },
  { name: 'log base 2', type: 'quantitative', values: [2, 16, 64, 512], scale: { type: 'log', base: 2, nice: false } },
  { name: 'pow 2', type: 'quantitative', values: [0, 3, 6, 10], scale: { type: 'pow', exponent: 2, nice: false } },
  { name: 'pow 3, signed', type: 'quantitative', values: [-8, -1, 2, 9], scale: { type: 'pow', exponent: 3, nice: false } },
  { name: 'sqrt', type: 'quantitative', values: [0, 9, 49, 100], scale: { type: 'sqrt', nice: false } },
  { name: 'symlog', type: 'quantitative', values: [-100, -2, 5, 300], scale: { type: 'symlog', nice: false } },
  { name: 'symlog, constant 5', type: 'quantitative', values: [-50, 0, 20, 900], scale: { type: 'symlog', constant: 5, nice: false } },
  { name: 'time', type: 'temporal', values: [T0, T0 + 2 * DAY, T0 + 5 * DAY, T0 + 10 * DAY], scale: { type: 'time', nice: false } },
  { name: 'utc', type: 'temporal', values: [T0, T0 + 3 * DAY, T0 + 7 * DAY, T0 + 9 * DAY], scale: { type: 'utc', nice: false } },
]

/** The chart: `kind` on x, a log y (so both axes are non-linear in some runs) or a linear y. */
function vlChart(kind: Kind, yKind: Kind, params: unknown[] | undefined): Spec {
  const rows = kind.values.map((v, i) => ({ a: v, b: yKind.values[i] }))
  return vl.compile({
    width: W, height: H, padding: 0, autosize: { type: 'none' },
    data: { values: rows },
    ...(params ? { params } : {}),
    mark: 'point',
    encoding: {
      x: { field: 'a', type: kind.type, scale: kind.scale },
      y: { field: 'b', type: yKind.type, scale: yKind.scale },
    },
  } as never).spec as unknown as Spec
}

/** One gesture, as native events. Coordinates are in the plot's pixels (the view has no padding and no offset). */
type Gesture =
  | { kind: 'wheel'; x: number; y: number; deltaY: number; deltaMode: 0 | 1; ctrlKey?: boolean }
  | { kind: 'drag'; from: [number, number]; to: [number, number] }

const GESTURES: Gesture[][] = [
  [{ kind: 'wheel', x: 60, y: 50, deltaY: -120, deltaMode: 0 }],
  [{ kind: 'wheel', x: 90, y: 40, deltaY: -60, deltaMode: 0, ctrlKey: true }, { kind: 'wheel', x: 120, y: 60, deltaY: 20, deltaMode: 0, ctrlKey: true }],
  [{ kind: 'wheel', x: 250, y: 150, deltaY: -3, deltaMode: 1 }, { kind: 'wheel', x: 40, y: 20, deltaY: 40, deltaMode: 0 }],
  [{ kind: 'wheel', x: 150, y: 100, deltaY: -200, deltaMode: 0 }, { kind: 'drag', from: [150, 100], to: [190, 70] }],
  [{ kind: 'wheel', x: 10, y: 190, deltaY: -2, deltaMode: 1 }, { kind: 'drag', from: [100, 50], to: [60, 120] }, { kind: 'wheel', x: 200, y: 30, deltaY: 30, deltaMode: 0 }],
]

const num = (d: unknown[]): Domain => [Number(d[0]), Number(d[d.length - 1])]

/** The view and the element its unit's events come from (the unit group's background: vega resolves the event's item from it). */
async function vegaView(spec: Spec): Promise<{ view: VegaView; svg: Element }> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const view = new (vega as unknown as { View: new (rt: unknown, o: unknown) => VegaView }).View(vega.parse(spec as never), { renderer: 'svg' }).initialize(host)
  cleanups.push(() => view.finalize())
  await view.runAsync()
  return { view, svg: host.querySelector('svg .role-frame.root > g > path.background')! }
}

async function send(target: EventTarget, g: Gesture, drag: { down: EventTarget; move: EventTarget; up: EventTarget }): Promise<void> {
  if (g.kind === 'wheel') {
    await act(async () => { target.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: g.x, clientY: g.y, deltaY: g.deltaY, deltaMode: g.deltaMode, ctrlKey: g.ctrlKey ?? false })) })
    await tick()
    return
  }
  const ev = (type: string, [x, y]: [number, number], buttons: number): PointerEvent =>
    new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons, pointerId: 1, pointerType: 'mouse' })
  await act(async () => { drag.down.dispatchEvent(ev('pointerdown', g.from, 1)) })
  await tick()
  await act(async () => { drag.move.dispatchEvent(ev('pointermove', g.to, 1)) })
  await tick()
  await act(async () => { drag.up.dispatchEvent(ev('pointerup', g.to, 0)) })
  await tick()
}

/** Relative closeness: the two engines run the same formulas, so only the last bits may differ. */
function close(a: Domain, b: Domain): boolean {
  return a.every((v, i) => Math.abs(v - b[i]!) <= 1e-9 * Math.max(1, Math.abs(v), Math.abs(b[i]!)))
}

const SHELLS: Array<[string, (p: Record<string, unknown>) => React.ReactElement]> = [
  ['<Chart>', (p) => React.createElement(Chart as never, p)],
  ['<SvgChart interaction>', (p) => React.createElement(SvgChart as never, { ...p, interaction })],
]

function mountAster(shell: (p: Record<string, unknown>) => React.ReactElement, props: Record<string, unknown>): HTMLElement {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  cleanups.push(() => act(() => root.unmount()))
  act(() => { root.render(shell({ ...props, a11y: false })) })
  const el = host.firstElementChild as HTMLElement
  for (const e of [el, el.querySelector('svg')!]) {
    e.getBoundingClientRect = () => ({ left: 0, top: 0, right: W, bottom: H, width: W, height: H, x: 0, y: 0, toJSON() {} }) as DOMRect
  }
  return el
}

describe('pan and wheel zoom in every continuous scale type, as Vega-Lite bind: "scales" does', () => {
  for (const kind of KINDS) {
    for (const yKind of [KINDS[0]!, KINDS[1]!]) {
      it(`x ${kind.name}, y ${yKind.name}`, async () => {
        for (const [shellName, shell] of SHELLS) {
          for (const gestures of GESTURES) {
            const { view, svg } = await vegaView(vlChart(kind, yKind, [{ name: 'grid', select: 'interval', bind: 'scales' }]))
            const views: Array<{ x?: Domain; y?: Domain } | null> = []
            const el = mountAster(shell, { spec: vlChart(kind, yKind, undefined), panZoom: true, onViewChange: (v: never) => views.push(v) })
            for (const [i, g] of gestures.entries()) {
              await send(svg, g, { down: svg, move: window, up: window })
              await send(el, g, { down: el, move: el, up: el })
              const where = `${shellName}: gesture ${i} of ${JSON.stringify(gestures)}`
              const got = views.at(-1)
              expect(got, where).toBeTruthy()
              const want = { x: num(view.scale('x').domain()), y: num(view.scale('y').domain()) }
              expect(close(got!.x!, want.x), `${where}: x ${JSON.stringify(got!.x)} vs vega ${JSON.stringify(want.x)}`).toBe(true)
              expect(close(got!.y!, want.y), `${where}: y ${JSON.stringify(got!.y)} vs vega ${JSON.stringify(want.y)}`).toBe(true)
            }
          }
        }
      })
    }
  }
})

describe('an interval brush reports the data interval Vega-Lite selects, for every continuous scale type', () => {
  const DRAGS: Array<[[number, number], [number, number]]> = [[[20, 30], [140, 160]], [[280, 190], [90, 10]], [[150, 100], [151, 180]]]
  for (const kind of KINDS) {
    it(`x ${kind.name}`, async () => {
      for (const [shellName, shell] of SHELLS) {
        for (const [from, to] of DRAGS) {
          const { view, svg } = await vegaView(vlChart(kind, KINDS[1]!, [{ name: 'brush', select: 'interval' }]))
          const selected: unknown[] = []
          const el = mountAster(shell, { spec: vlChart(kind, KINDS[1]!, undefined), onSelect: (v: unknown) => selected.push(v) })
          await send(svg, { kind: 'drag', from, to }, { down: svg, move: window, up: window })
          await send(el, { kind: 'drag', from, to }, { down: el, move: el, up: el })
          const brush = view.signal('brush') as Record<string, unknown[]>
          const got = selected.at(-1) as { x?: Domain; y?: Domain }
          const where = `${shellName}: ${JSON.stringify([from, to])}`
          const sorted = (d: unknown[]): Domain => { const [a, b] = num(d); return [Math.min(a, b), Math.max(a, b)] }
          expect(got?.x, `${where}: no x`).toBeTruthy()
          expect(close(got.x!, sorted(brush.a!)), `${where}: x ${JSON.stringify(got.x)} vs vega ${JSON.stringify(sorted(brush.a!))}`).toBe(true)
          expect(close(got.y!, sorted(brush.b!)), `${where}: y ${JSON.stringify(got.y)} vs vega ${JSON.stringify(sorted(brush.b!))}`).toBe(true)
        }
      }
    })
  }
})

describe("the exported helpers pan and zoom as vega-util's pan* / zoom* functions, bit for bit", () => {
  // the live scale's shape the helpers read (its type, and its exponent or constant)
  const SCALES: Array<[string, unknown, (d: number[], delta: number) => number[], (d: number[], a: number | null, k: number) => number[], () => number[]]> = []
  const rnd = (() => { let a = 7; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } })()
  const between = (lo: number, hi: number): number => lo + (hi - lo) * rnd()
  const u = vegaUtil as unknown as Record<string, (...a: unknown[]) => number[]>
  SCALES.push(['linear', { type: 'linear' }, (d, x) => u.panLinear!(d, x), (d, a, k) => u.zoomLinear!(d, a, k), () => { const a = between(-1e3, 1e3); return [a, a + between(1, 1e3)] }])
  SCALES.push(['time', { type: 'time' }, (d, x) => u.panLinear!(d, x), (d, a, k) => u.zoomLinear!(d, a, k), () => { const a = T0 + between(-1e10, 1e10); return [a, a + between(1e3, 1e10)] }])
  SCALES.push(['log', { type: 'log' }, (d, x) => u.panLog!(d, x), (d, a, k) => u.zoomLog!(d, a, k), () => { const a = between(1e-3, 1e3); return [a, a * between(1.5, 1e4)] }])
  SCALES.push(['log, negative', { type: 'log' }, (d, x) => u.panLog!(d, x), (d, a, k) => u.zoomLog!(d, a, k), () => { const a = -between(1e-3, 1e3); return [a * between(1.5, 1e4), a] }])
  for (const e of [0.3, 2, 3]) {
    SCALES.push([`pow ${e}`, { type: 'pow', exponent: () => e }, (d, x) => u.panPow!(d, x, e), (d, a, k) => u.zoomPow!(d, a, k, e), () => { const a = between(-50, 50); return [a, a + between(1, 100)] }])
  }
  // (Vega-Lite moves a sqrt scale with panLinear / zoomLinear)
  SCALES.push(['sqrt', { type: 'sqrt', exponent: () => 0.5 }, (d, x) => u.panLinear!(d, x), (d, a, k) => u.zoomLinear!(d, a, k), () => { const a = between(0, 50); return [a, a + between(1, 100)] }])
  for (const c of [1, 0.5, 20]) {
    SCALES.push([`symlog ${c}`, { type: 'symlog', constant: () => c }, (d, x) => u.panSymlog!(d, x, c), (d, a, k) => u.zoomSymlog!(d, a, k, c), () => { const a = between(-500, 500); return [a, a + between(1, 1000)] }])
  }
  for (const [name, scale, pan, zoom, domain] of SCALES) {
    it(name, () => {
      for (let i = 0; i < 300; i++) {
        const d = domain() as [number, number]
        const f = between(-0.6, 0.6)
        expect(panDomain(d, f, scale), `panDomain(${d}, ${f})`).toEqual(pan(d, -f))
        // the keyboard's arrows pan by 8% (25% with shift) of the view in the scale's space
        const right = keyboardView('ArrowRight', { x: d }, { x: d }, { scales: { x: scale } }).view!.x
        expect(right, `ArrowRight on ${d}`).toEqual(pan(d, -0.08))
        const anchor = (pan(d, between(-0.5, 0.5)) as number[])[0]!
        const k = between(0.5, 0.99)
        // a wheel's stretch k (< 1 zooms in) inside the bounds is vega's zoom exactly
        const wide = zoom(d, null, 4) as [number, number]
        expect(cursorZoom({ x: d }, { x: wide }, 'x', anchor, 1 / k, scale, 1e9).x, `cursorZoom(${d}, ${anchor}, ${k})`).toEqual(zoom(d, anchor, 1 / (1 / k)))
      }
    })
  }
})
