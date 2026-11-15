// @vitest-environment jsdom
/**
 * A mark value vega cannot measure: path text its reader refuses (or that is no text at all), a custom symbol shape likewise (a
 * legend's too), a line's or an area's `interpolate` that names no curve, a shape mark's literal shape, a mark's clip path. vega's
 * Bound operator throws, the dataflow pass stops there and logs the error once: the marks after it are never made and the view is
 * never laid out. Some of those values its SVG renderers then fail on as well (the string renderer throws, the DOM renderer logs);
 * its canvas draws only what has bounds, so it skips the items never measured.
 *
 * Each case against real vega in the same process, through every way a chart is made: `renderSpec` (the string renderer), a
 * session, a stream, `<Chart>` on SVG (against vega's DOM renderer); and vega's canvas drawing, on a recording context, with the
 * bounds its renderer draws with. What is compared: the errors logged (class and message, how many), what the render throws, the
 * SVG (strict canonical form), and every paint.
 */
import { afterEach, describe, expect, it } from 'vitest'
import * as vega from 'vega'
import * as React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import '@aster-charts/core/geo'
import { compileChart, createChartStream, evaluateChart, renderSceneToSvg, renderSpec } from '@aster-charts/core'
import { createChartSession } from '@aster-charts/core/lean'
import { renderSceneToCanvas } from '@aster-charts/core/canvas'
import { Chart } from '@aster-charts/react'
import { canonicalizeSvg, diffCanonical } from './normalize.js'
import { recorder, type Painted } from './canvas-recorder.js'

type Spec = Record<string, unknown>
const V = (value: unknown): { value: unknown } => ({ value })
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const cleanups: Array<() => void> = []
afterEach(() => { while (cleanups.length) cleanups.pop()!(); document.body.innerHTML = '' })

const ROWS = [{ x: 1 }, { x: 5 }, { x: 3 }]
const big = { type: 'rect', encode: { update: { x: V(0), y: V(0), width: V(300), height: V(220), fill: V('tomato') } } }
const after = { type: 'rect', encode: { update: { x: V(10), y: V(10), width: V(20), height: V(20), fill: V('navy') } } }
const at = (x: number): Spec => ({ x: V(x), y: V(10) })
const symbol = (shape: unknown, extra: Spec = {}): Spec => ({ type: 'symbol', from: { data: 'd' }, encode: { update: { x: { field: 'x', mult: 20 }, y: V(15), size: V(100), fill: V('black'), ...extra, shape: { signal: `datum.x === 5 ? ${JSON.stringify(shape)} : 'square'` } } } })

/**
 * The values vega's bounds cannot measure, as the marks that hold them. A curve vega does not know its renderers fail on too; Aster's
 * renderers draw any scene they are given (a hand-built one included), in the linear curve: those cases (`CURVES`) are held to vega
 * in what the pass does -- what is logged, the view's size, what the canvas paints -- and not in what the SVG renderers then do.
 */
const CURVES = new Set(['a line\'s unknown interpolate', 'a line\'s monotone-x (no name of vega\'s)', 'an area\'s monotone in an orientation vega does not know'])
const FAILING: Array<[string, Spec[], Spec?]> = [
  ['a path mark\'s text the reader refuses', [{ type: 'path', encode: { update: { ...at(5), path: V('M0,0 L10,10 Lx'), stroke: V('black') } } }]],
  ['a path mark\'s text with too few numbers', [{ type: 'path', encode: { update: { ...at(5), path: V('M0,0 L10'), stroke: V('black') } } }]],
  ['a path mark\'s text starting with `t`', [{ type: 'path', encode: { update: { ...at(5), path: V('t1,2 l3,4'), stroke: V('black') } } }]],
  ['a path mark\'s number', [{ type: 'path', encode: { update: { ...at(5), path: V(42), stroke: V('black') } } }]],
  ['a path mark\'s object (GeoJSON)', [{ type: 'path', encode: { update: { ...at(5), path: V({ type: 'Polygon', coordinates: [[[0, 0], [10, 0], [10, 10], [0, 0]]] }), stroke: V('black') } } }]],
  ['the second of three paths', [{ type: 'path', from: { data: 'd' }, encode: { update: { x: { field: 'x', mult: 20 }, y: V(10), path: { signal: "datum.x === 5 ? 'Mq' : 'M0,0L5,5'" }, stroke: V('black') } } }]],
  ['a path mark in a group mark', [{ type: 'group', encode: { update: { x: V(5), y: V(5), width: V(60), height: V(40), fill: V('gold') } }, marks: [{ type: 'path', encode: { update: { path: V('M0,0 Lx'), stroke: V('black') } } }, after] }]],
  ['a custom symbol shape the reader refuses', [symbol('M0,0 Lx')]],
  ['a symbol shape name vega does not know', [symbol('squre')]],
  ['a symbol shape that is a number', [symbol(7)]],
  ['a custom symbol shape starting with `t`', [symbol('t1,1')]],
  ['a line\'s unknown interpolate', [{ type: 'line', from: { data: 'd' }, encode: { update: { x: { field: 'x', mult: 20 }, y: { field: 'x', mult: 10 }, interpolate: V('curvy'), stroke: V('black') } } }]],
  ['a line\'s monotone-x (no name of vega\'s)', [{ type: 'line', from: { data: 'd' }, encode: { update: { x: { field: 'x', mult: 20 }, y: { field: 'x', mult: 10 }, interpolate: V('monotone-x'), stroke: V('black') } } }]],
  ['an area\'s monotone in an orientation vega does not know', [{ type: 'area', from: { data: 'd' }, encode: { update: { x: { field: 'x', mult: 20 }, y: { field: 'x', mult: 10 }, y2: V(0), orient: V('diagonal'), interpolate: V('monotone'), fill: V('black') } } }]],
  ['a shape mark\'s literal shape', [{ type: 'shape', encode: { update: { shape: V('M0,0L9,9'), stroke: V('black') } } }]],
  ['a mark\'s clip path the reader refuses', [{ type: 'rect', clip: { path: 'M0,0 Lx' }, encode: { update: { x: V(1), y: V(1), width: V(5), height: V(5), fill: V('black') } } }]],
  ['a mark\'s clip shape from a signal', [{ type: 'rect', clip: { signal: "pathShape('M0,0 L5')" }, encode: { update: { x: V(1), y: V(1), width: V(5), height: V(5), fill: V('black') } } }]],
  ['a legend\'s custom symbol type', [], { scales: [{ name: 'c', type: 'ordinal', domain: ['a', 'b', 'c'], range: ['red', 'blue', 'green'] }], legends: [{ fill: 'c', title: 'C', symbolType: 'M0,0 Lx' }] }],
]
/** Values that do not draw but measure (vega goes on): the same checks hold, with nothing logged. */
const MEASURED: Array<[string, Spec[], Spec?]> = [
  ['a path mark\'s null path', [{ type: 'path', encode: { update: { ...at(5), path: V(null), stroke: V('black') } } }]],
  ['a path mark\'s empty text', [{ type: 'path', encode: { update: { ...at(5), path: V(''), stroke: V('black') } } }]],
  ['a valid custom symbol shape', [symbol('M-1,-1L1,-1L0,1Z')]],
  ['a line\'s null interpolate, and monotone vertical', [{ type: 'line', from: { data: 'd' }, encode: { update: { x: { field: 'x', mult: 20 }, y: { field: 'x', mult: 10 }, interpolate: V(null), stroke: V('black') } } }, { type: 'area', from: { data: 'd' }, encode: { update: { x: { field: 'x', mult: 20 }, y: { field: 'x', mult: 10 }, y2: V(0), orient: V('vertical'), interpolate: V('monotone'), fill: V('gray') } } }]],
  ['a line with no items and an unknown interpolate', [{ type: 'line', from: { data: 'none' }, encode: { update: { x: { field: 'x' }, y: { field: 'x' }, interpolate: V('curvy'), stroke: V('black') } } }]],
  ['a negative arc radius', [{ type: 'arc', encode: { update: { x: V(10), y: V(10), outerRadius: V(-5), startAngle: V(0), endAngle: V(1), fill: V('black') } } }]],
]

function chart(marks: Spec[], extra: Spec = {}): Spec {
  return { width: 40, height: 40, padding: 5, autosize: 'pad', data: [{ name: 'd', values: ROWS }, { name: 'none', values: [] }], marks: [big, ...marks, after], ...extra }
}

/** An error as what a user sees of it. */
const shown = (e: unknown): string => (e instanceof Error ? `${e.constructor.name}: ${e.message}` : `thrown ${String(e)}`)

interface Seen { logged: string[]; svg: string | { threw: string } }
const vegaPathParse = (vega as unknown as { pathParse(d: string): unknown }).pathParse
/**
 * The SVG with every path text vega's reader refuses (written as it was given) set aside: the canonical form reads every path, so
 * those are compared as written, in order, and the rest canonically.
 */
function readable(svg: string): { svg: string; unread: string[] } {
  const unread: string[] = []
  const out = svg.replace(/(\sd=")([^"]*)"/g, (all, head: string, d: string) => {
    try { vegaPathParse(d); if (d === '' || /^\s*[Mm]/.test(d)) return all } catch { /* unread */ }
    unread.push(d)
    return `${head}M0,0"`
  })
  return { svg: out, unread }
}
const sameSvg = (want: Seen['svg'], got: Seen['svg']): unknown => {
  if (typeof want !== 'string' || typeof got !== 'string') return { want, got }
  const a = readable(want), b = readable(got)
  return [...diffCanonical(canonicalizeSvg(a.svg), canonicalizeSvg(b.svg)), ...(JSON.stringify(a.unread) === JSON.stringify(b.unread) ? [] : [`unread ${JSON.stringify(a.unread)} != ${JSON.stringify(b.unread)}`])]
}

type View = { runAsync(): Promise<void>; toSVG(): Promise<string>; finalize(): void; scenegraph(): { root: unknown }; initialize(el: Element): View }
function vegaView(spec: Spec, renderer: string, logged: string[]): View {
  const logger = { level() { return 0 }, error(e: unknown) { logged.push(shown(e)); return this }, warn() { return this }, info() { return this }, debug() { return this } }
  return new (vega as unknown as { View: new (rt: unknown, o: unknown) => View }).View(vega.parse(structuredClone(spec) as never), { renderer, logger })
}

async function vegaString(spec: Spec): Promise<Seen> {
  const logged: string[] = []
  const view = vegaView(spec, 'none', logged)
  try {
    await view.runAsync()
    let svg: Seen['svg']
    try { svg = await view.toSVG() } catch (e) { svg = { threw: shown(e) } }
    return { logged, svg }
  } finally { view.finalize() }
}

const asterLogger = (logged: string[]): { error(e: unknown): void; warn(): void } => ({ error: (e) => { logged.push(shown(e)) }, warn: () => {} })

function asterString(spec: Spec): Seen {
  const logged: string[] = []
  let svg: Seen['svg']
  try { svg = renderSpec(structuredClone(spec) as never, { logger: asterLogger(logged) } as never) } catch (e) { svg = { threw: shown(e) } }
  return { logged, svg }
}

function asterSession(spec: Spec): Seen {
  const logged: string[] = []
  const session = createChartSession()
  const scene = session.evaluate(structuredClone(spec) as never, { logger: asterLogger(logged) } as never)
  let svg: Seen['svg']
  try { svg = renderSceneToSvg(scene) } catch (e) { svg = { threw: shown(e) } }
  return { logged, svg }
}

function asterStream(spec: Spec): Seen {
  const logged: string[] = []
  const stream = createChartStream(structuredClone(spec) as never, { initial: { logger: asterLogger(logged) } } as never)
  try {
    stream.push({ data: { d: ROWS } })
    const flushed = stream.flush()
    let svg: Seen['svg']
    try { svg = renderSceneToSvg(flushed!.scene) } catch (e) { svg = { threw: shown(e) } }
    return { logged, svg }
  } finally { stream.close() }
}

/** vega's DOM renderer (what an embedded view shows), and `<Chart>` on SVG: the errors logged, and the size of the view. */
async function vegaDom(spec: Spec): Promise<{ logged: string[]; size: string }> {
  const logged: string[] = []
  const host = document.createElement('div')
  document.body.append(host)
  const view = vegaView(spec, 'svg', logged).initialize(host)
  cleanups.push(() => view.finalize())
  await view.runAsync()
  const svg = host.querySelector('svg')!
  return { logged, size: `${svg.getAttribute('width')} x ${svg.getAttribute('height')}` }
}

function asterChart(spec: Spec): { logged: string[]; size: string } {
  const logged: string[] = []
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  cleanups.push(() => act(() => root.unmount()))
  act(() => { root.render(React.createElement(Chart as never, { spec: structuredClone(spec), renderer: 'svg', logger: asterLogger(logged) })) })
  const svg = host.querySelector('svg')
  return { logged, size: svg ? `${svg.getAttribute('width')} x ${svg.getAttribute('height')}` : 'no svg' }
}

/** vega's canvas drawing as its renderer draws (only what meets the view's bounds), and Aster's: every paint in order. */
async function canvasPaints(spec: Spec): Promise<{ vega: Painted[] | string; aster: Painted[] | string }> {
  const logged: string[] = []
  const view = vegaView(spec, 'none', logged)
  let want: Painted[] | string
  try {
    await view.runAsync()
    const svg = await view.toSVG().catch(() => '')
    const size = /<svg[^>]*?\swidth="([^"]+)"[^>]*?\sheight="([^"]+)"/.exec(svg)
    const origin = /<g[^>]*transform="translate\(([^,]+),([^)]+)\)"/.exec(svg)
    const { ctx, painted } = recorder()
    const Marks = (vega as unknown as { Marks: Record<string, { draw(this: unknown, c: unknown, s: unknown, b: unknown): void }> }).Marks
    const B = (vega as unknown as { Bounds: new () => { set(a: number, b: number, c: number, d: number): { translate(x: number, y: number): { expand(d: number): unknown } } } }).Bounds
    const [ox, oy] = origin ? [+origin[1]!, +origin[2]!] : [5, 5]
    const bounds = new B().set(0, 0, size ? +size[1]! : 50, size ? +size[2]! : 50).translate(-ox, -oy).expand(1)
    ;(ctx as unknown as { translate(x: number, y: number): void }).translate(ox, oy)
    const renderer = { draw(c: unknown, s: { marktype: string }, b: unknown): void { Marks[s.marktype]!.draw.call(renderer, c, s, b) } }
    try { renderer.draw(ctx, (view.scenegraph() as unknown as { root: { marktype: string } }).root, bounds); want = painted } catch (e) { want = shown(e) }
  } finally { view.finalize() }
  let got: Painted[] | string
  const { ctx, painted } = recorder()
  try { renderSceneToCanvas(evaluateChart(compileChart(structuredClone(spec) as never), { logger: asterLogger([]) } as never), ctx); got = painted } catch (e) { got = shown(e) }
  // (what is painted, and with what: the root's own box and the marks; a text's path is its text)
  const paints = (p: Painted[] | string): Painted[] | string => (typeof p === 'string' ? p : p.map((q) => ({ ...q })))
  return { vega: paints(want), aster: paints(got) }
}

describe('a mark value vega cannot measure fails the pass, as in vega', () => {
  for (const [name, marks, extra] of [...FAILING, ...MEASURED]) {
    const spec = chart(marks, extra)
    const fails = FAILING.some(([n]) => n === name)
    it(`${name}: renderSpec, a session and a stream`, async () => {
      const want = await vegaString(spec)
      // (not vacuous: a failing value is logged, once; a measured one is not)
      expect(want.logged.length).toBe(fails ? 1 : 0)
      for (const [how, got] of [['renderSpec', asterString(spec)], ['session', asterSession(spec)], ['stream', asterStream(spec)]] as const) {
        expect(got.logged, how).toEqual(want.logged)
        if (CURVES.has(name)) {
          // (vega's string renderer fails on the curve; Aster's draws it, at the size of the view the pass left: vega's)
          expect(want.svg).toEqual({ threw: 'TypeError: curve is not a function' })
          expect(typeof got.svg === 'string' ? /width="(\d+)"/.exec(got.svg)?.[1] : got.svg, how).toBe('50')
        } else {
          expect(sameSvg(want.svg, got.svg), how).toEqual(typeof want.svg === 'string' ? [] : { want: want.svg, got: want.svg })
        }
      }
    })
    it(`${name}: <Chart> on SVG, as vega's DOM renderer`, async () => {
      const want = await vegaDom(spec)
      const got = asterChart(spec)
      // (vega's DOM renderer fails on a curve it does not know, and its view logs that a second time; Aster's draws it)
      expect(got.logged).toEqual(CURVES.has(name) ? want.logged.slice(0, 1) : want.logged)
      if (CURVES.has(name)) expect(want.logged).toEqual([...want.logged.slice(0, 1), 'TypeError: curve is not a function'])
      // (a value vega's SVG renderers fail on too leaves the part of vega's view drawn before it; <Chart> shows none of it)
      if (typeof (await vegaString(spec)).svg === 'string') expect(got.size).toBe(want.size)
    })
    it(`${name}: what the canvas paints`, async () => {
      const { vega: want, aster: got } = await canvasPaints(spec)
      expect(typeof want === 'string' ? want : want.length).not.toBe(0)
      expect(got).toEqual(want)
    })
  }
})
