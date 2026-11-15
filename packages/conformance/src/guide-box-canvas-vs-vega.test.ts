/**
 * The box of a guide's group item (an axis's, a legend's, a legend entry's, a title's: its `axis` / `legend` / `entries` / `group`
 * encode), painted: vega draws it on a canvas as it draws any group item's background, before what the guide holds, and its stroke
 * with it (or after, with `strokeForeground`). Compared with vega-scenegraph's own canvas drawing of the same scene, every paint as
 * its device-space path and its style (a gradient: its coordinates and stops).
 *
 * `strokeForeground` on every kind of group item, the legend's and the entries' included, is held to vega in
 * stroke-foreground-vs-vega.test.ts (SVG, canvas, pick, bounds); a gradient on every kind of box, and on every other item a canvas
 * paints with one, in gradient-canvas-bounds-vs-vega.test.ts.
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { compileChart, evaluateChart } from '@aster-charts/core'
import { renderSceneToCanvas } from '@aster-charts/core/canvas'

type M = [number, number, number, number, number, number]
interface Painted { op: 'fill' | 'stroke'; style: string; path: string }

/** A recording 2D context: the transform, the current path in device space (to 1e-6), and each paint with the style it used. */
function recorder(): { ctx: never; painted: Painted[] } {
  const painted: Painted[] = []
  let m: M = [1, 0, 0, 1, 0, 0]
  const stack: Array<{ m: M; fillStyle: unknown; strokeStyle: unknown }> = []
  let path: string[] = []
  const state: Record<string, unknown> = { fillStyle: '#000', strokeStyle: '#000' }
  const n = (v: number): string => String(Math.round(v * 1e6) / 1e6)
  const dev = (x: number, y: number): string => `${n(m[0] * x + m[2] * y + m[4])},${n(m[1] * x + m[3] * y + m[5])}`
  const mul = (b: M): void => {
    m = [m[0] * b[0] + m[2] * b[1], m[1] * b[0] + m[3] * b[1], m[0] * b[2] + m[2] * b[3], m[1] * b[2] + m[3] * b[3], m[0] * b[4] + m[2] * b[5] + m[4], m[1] * b[4] + m[3] * b[5] + m[5]]
  }
  // (a gradient as its kind, its coordinates in device space and its stops)
  const gradient = (kind: string) => (...a: number[]): object => {
    const stops: string[] = []
    const at = kind === 'linear' ? `${dev(a[0]!, a[1]!)} ${dev(a[2]!, a[3]!)}` : `${dev(a[0]!, a[1]!)} ${n(a[2]!)} ${dev(a[3]!, a[4]!)} ${n(a[5]!)}`
    return { addColorStop: (o: number, c: string) => { stops.push(`${o}:${c}`) }, toString: () => `${kind}(${at}; ${stops.join(' ')})` }
  }
  const own: Record<string, (...a: number[]) => unknown> = {
    save: () => { stack.push({ m: [...m] as M, fillStyle: state.fillStyle, strokeStyle: state.strokeStyle }) },
    restore: () => { const s = stack.pop(); if (s) { m = s.m; state.fillStyle = s.fillStyle; state.strokeStyle = s.strokeStyle } },
    translate: (x, y) => mul([1, 0, 0, 1, x!, y!]),
    scale: (x, y) => mul([x!, 0, 0, y!, 0, 0]),
    setTransform: (a, b, c, d, e, f) => { m = [a!, b!, c!, d!, e!, f!] },
    beginPath: () => { path = [] },
    closePath: () => { path.push('Z') },
    moveTo: (x, y) => { path.push(`M${dev(x!, y!)}`) },
    lineTo: (x, y) => { path.push(`L${dev(x!, y!)}`) },
    rect: (x, y, w, h) => { path.push(`M${dev(x!, y!)}`, `L${dev(x! + w!, y!)}`, `L${dev(x! + w!, y! + h!)}`, `L${dev(x!, y! + h!)}`, 'Z') },
    createLinearGradient: gradient('linear') as never,
    createRadialGradient: gradient('radial') as never,
    createPattern: () => ({ setTransform: () => undefined, toString: () => 'pattern' }),
    fill: () => { painted.push({ op: 'fill', style: String(state.fillStyle), path: path.join(' ') }) },
    stroke: () => { painted.push({ op: 'stroke', style: String(state.strokeStyle), path: path.join(' ') }) },
  }
  const ctx = new Proxy(state, {
    get: (t, k: string) => (k in own ? own[k] : k in t ? t[k] : () => undefined),
    set: (t, k: string, v) => { t[k] = v; return true },
  })
  return { ctx: ctx as never, painted }
}

const lin = { gradient: 'linear', stops: [{ offset: 0, color: 'white' }, { offset: 1, color: 'darkred' }] }
const SCALES = [{ name: 'x', type: 'linear', domain: [0, 10], range: 'width' }, { name: 'c', type: 'ordinal', domain: ['a', 'b'], range: ['red', 'blue'] }]
const BOX = { width: { value: 40 }, height: { value: 20 }, strokeWidth: { value: 2 } }
const GUIDES: Array<[string, (enc: Record<string, unknown>) => Record<string, unknown>]> = [
  ['an axis', (update) => ({ axes: [{ orient: 'bottom', scale: 'x', encode: { axis: { update } } }] })],
  ['a legend', (update) => ({ legends: [{ fill: 'c', encode: { legend: { update } } }] })],
  ['a legend\'s entries', (update) => ({ legends: [{ fill: 'c', encode: { entries: { update } } }] })],
  ['a title', (update) => ({ title: { text: 'T', encode: { group: { update } } } })],
]
const COLOUR = { fill: { value: 'gold' }, stroke: { value: 'teal' } }
const CASES: Array<[string, string, Record<string, unknown>]> = [
  ...GUIDES.map(([g]): [string, string, Record<string, unknown>] => [g, 'a colour', COLOUR]),
  ['an axis', 'a colour, stroked in front', { ...COLOUR, strokeForeground: { value: true } }],
  ['a title', 'a colour, stroked in front', { ...COLOUR, strokeForeground: { value: true } }],
  ['a title', 'a gradient', { fill: { value: lin }, stroke: { value: 'teal' } }],
]
const BOX_STYLES = /^(gold|teal|linear\()/

function spec(guide: Record<string, unknown>): Record<string, unknown> {
  // (no padding: vega's renderer, not its group drawing, moves the scene by it)
  return { width: 140, height: 90, padding: 0, autosize: 'none', scales: SCALES, ...guide }
}

async function vegaPainted(s: Record<string, unknown>): Promise<Painted[]> {
  const view = new vega.View(vega.parse(s as never), { renderer: 'none' })
  try {
    await view.runAsync()
    const { ctx, painted } = recorder()
    ;(vega as unknown as { Marks: Record<string, { draw(c: unknown, s: unknown, b: unknown): void }> }).Marks.group!.draw(ctx, (view.scenegraph() as unknown as { root: unknown }).root, null)
    return painted
  } finally { view.finalize() }
}

function asterPainted(s: Record<string, unknown>): Painted[] {
  const { ctx, painted } = recorder()
  renderSceneToCanvas(evaluateChart(compileChart(structuredClone(s) as never), {}), ctx)
  return painted
}

describe('a guide\'s box on a canvas, as vega draws it', () => {
  for (const [name, paintName, paint] of CASES) {
    it(`${name}, painted with ${paintName}`, async () => {
      const s = spec(GUIDES.find(([g]) => g === name)![1]({ ...paint, ...BOX }))
      const want = (await vegaPainted(structuredClone(s))).filter((p) => BOX_STYLES.test(p.style))
      expect(want.length).toBeGreaterThan(0) // not vacuous
      expect(asterPainted(s).filter((p) => BOX_STYLES.test(p.style))).toEqual(want)
    })
  }
})
