/**
 * The geometry a symbol is painted with on a canvas, against vega-scenegraph's own canvas drawing of the same scene.
 *
 * vega draws a symbol on a canvas from the unrounded numbers of its shape (`Marks.symbol.draw`); only its SVG `d` string is
 * rounded to 3 decimals. A canvas painted from the rounded string is off by up to 0.0005 px per coordinate - invisible in
 * Chromium, but WebKit's rasteriser turns it into a visible pixel difference (tree-links-paths, nightly WebKit canvas parity).
 *
 * The command streams cannot be compared call for call (vega translates and draws about the origin; Aster may emit absolute
 * coordinates or split a circle in two arcs), so both are reduced to the same thing: the path in device space, every number at
 * full precision, each full circle as one `O` record.
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { compileChart, evaluateChart } from '@aster/core'
import { renderSceneToCanvas } from '@aster/core/canvas'

type M = [number, number, number, number, number, number]
interface Painted { op: 'fill' | 'stroke'; style: string; path: number[][] }

/** A recording 2D context: tracks the transform and the current path in device space; every other call is a no-op. */
function recorder(): { ctx: never; painted: Painted[] } {
  const painted: Painted[] = []
  let m: M = [1, 0, 0, 1, 0, 0]
  const stack: Array<{ m: M; fillStyle: unknown; strokeStyle: unknown }> = []
  let path: number[][] = []
  const state: Record<string, unknown> = { fillStyle: '#000', strokeStyle: '#000' }
  const dev = (x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
  const mul = (b: M): void => {
    m = [m[0] * b[0] + m[2] * b[1], m[1] * b[0] + m[3] * b[1], m[0] * b[2] + m[2] * b[3], m[1] * b[2] + m[3] * b[3], m[0] * b[4] + m[2] * b[5] + m[4], m[1] * b[4] + m[3] * b[5] + m[5]]
  }
  const arcs: { c: [number, number]; r: number; a0: number; a1: number; ccw: boolean }[] = []
  const flushArcs = (): void => {
    // consecutive arcs of one circle: one record when together they close it
    if (arcs.length === 0) return
    const first = arcs[0]!
    const sweep = arcs.reduce((s, a) => s + Math.abs(a.a1 - a.a0), 0)
    if (Math.abs(sweep - 2 * Math.PI) < 1e-9) path.push([100, first.c[0], first.c[1], first.r * Math.hypot(m[0], m[1])])
    else for (const a of arcs) path.push([101, a.c[0], a.c[1], a.r, a.a0, a.a1])
    arcs.length = 0
  }
  const add = (rec: number[]): void => { flushArcs(); path.push(rec) }
  const own: Record<string, (...a: number[]) => void> = {
    save: () => { stack.push({ m: [...m] as M, fillStyle: state.fillStyle, strokeStyle: state.strokeStyle }) },
    restore: () => { const s = stack.pop(); if (s) { m = s.m; state.fillStyle = s.fillStyle; state.strokeStyle = s.strokeStyle } },
    translate: (x, y) => mul([1, 0, 0, 1, x!, y!]),
    scale: (x, y) => mul([x!, 0, 0, y!, 0, 0]),
    rotate: (a) => mul([Math.cos(a!), Math.sin(a!), -Math.sin(a!), Math.cos(a!), 0, 0]),
    beginPath: () => { path = []; arcs.length = 0 },
    closePath: () => add([3]),
    moveTo: (x, y) => add([0, ...dev(x!, y!)]),
    lineTo: (x, y) => add([1, ...dev(x!, y!)]),
    rect: (x, y, w, h) => { add([0, ...dev(x!, y!)]); add([1, ...dev(x! + w!, y!)]); add([1, ...dev(x! + w!, y! + h!)]); add([1, ...dev(x!, y! + h!)]); add([3]) },
    arc: (x, y, r, a0, a1, ccw) => {
      const prev = arcs[arcs.length - 1]
      const c = dev(x!, y!)
      if (prev && (prev.c[0] !== c[0] || prev.c[1] !== c[1] || prev.r !== r)) flushArcs()
      arcs.push({ c, r: r!, a0: a0!, a1: a1!, ccw: !!ccw })
    },
    fill: () => { flushArcs(); painted.push({ op: 'fill', style: String(state.fillStyle), path: path.map((p) => [...p]) }) },
    stroke: () => { flushArcs(); painted.push({ op: 'stroke', style: String(state.strokeStyle), path: path.map((p) => [...p]) }) },
  }
  const ctx = new Proxy(state, {
    get: (t, k: string) => (k in own ? own[k] : k in t ? t[k] : () => undefined),
    set: (t, k: string, v) => { t[k] = v; return true },
  })
  return { ctx: ctx as never, painted }
}

const SHAPES = ['circle', 'square', 'cross', 'diamond', 'triangle-up', 'triangle-down', 'triangle-left', 'triangle-right', 'wedge', 'arrow', 'stroke', 'M0,-1L1,1L-1,1Z']
// fractional positions and sizes whose radius is irrational: the 3-decimal rounding of the SVG string differs from the exact value
const POINTS = [
  { x: 233.33333333333334, y: 34, size: 50 }, { x: 126.66666666666667, y: 58.2, size: 50 }, { x: 17.123456, y: 99.987654, size: 333 },
  { x: 0.1, y: 0.2, size: 7 }, { x: 300.55, y: 12.345, size: 1234.5 }, { x: 40, y: 40, size: 2 },
]

function spec(shape: string, extra: Record<string, unknown>, n: number): Record<string, unknown> {
  const rows = Array.from({ length: n }, (_, i) => POINTS[i % POINTS.length]!).map((p, i) => ({ ...p, x: p.x + (i >= POINTS.length ? i * 0.37 : 0), shape }))
  return {
    width: 400, height: 200, padding: 0, autosize: 'none',
    data: [{ name: 't', values: rows }],
    marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { field: 'x' }, y: { field: 'y' }, size: { field: 'size' }, shape: { field: 'shape' }, fill: { value: 'red' }, ...extra } } }],
  }
}

async function vegaPainted(s: Record<string, unknown>): Promise<Painted[]> {
  const view = new vega.View(vega.parse(s as never), { renderer: 'none' })
  try {
    await view.runAsync()
    const { ctx, painted } = recorder()
    const mark = (view.scenegraph() as unknown as { root: { items: Array<{ items: Array<{ marktype: string; items: unknown[] }> }> } }).root.items[0]!.items.find((g) => g.marktype === 'symbol')!
    ;(vega.Marks as unknown as Record<string, { draw(c: unknown, s: unknown, b: unknown): void }>).symbol!.draw(ctx, mark, null)
    return painted
  } finally { view.finalize() }
}

function asterPainted(s: Record<string, unknown>, batchSymbols: boolean): Painted[] {
  const { ctx, painted } = recorder()
  renderSceneToCanvas(evaluateChart(compileChart(structuredClone(s) as never), {}), ctx, { batchSymbols })
  return painted.filter((p) => p.style === 'red' || p.style === 'blue')
}

/** every number to 1e-9, so a 0.0005 rounding fails and floating-point order of operations does not */
function same(a: Painted[], b: Painted[]): string[] {
  const out: string[] = []
  if (a.length !== b.length) return [`${a.length} painted paths in vega, ${b.length} in aster`]
  a.forEach((pa, i) => {
    const pb = b[i]!
    if (pa.op !== pb.op || pa.style !== pb.style) out.push(`#${i}: ${pa.op} ${pa.style} vs ${pb.op} ${pb.style}`)
    if (pa.path.length !== pb.path.length) { out.push(`#${i}: ${pa.path.length} path ops vs ${pb.path.length}`); return }
    pa.path.forEach((ra, j) => {
      const rb = pb.path[j]!
      if (ra.length !== rb.length || ra.some((v, k) => !(Math.abs(v - rb[k]!) <= 1e-9))) out.push(`#${i} op ${j}: ${JSON.stringify(ra)} vs ${JSON.stringify(rb)}`)
    })
  })
  return out
}

describe('a symbol on a canvas is drawn from unrounded numbers, as vega draws it', () => {
  for (const shape of SHAPES) {
    it(`${shape}: per item`, async () => {
      const s = spec(shape, {}, POINTS.length)
      const want = await vegaPainted(structuredClone(s))
      expect(want.length).toBe(POINTS.length) // not vacuous
      expect(same(want, asterPainted(s, false))).toEqual([])
    })
    it(`${shape}: stroked and rotated`, async () => {
      const s = spec(shape, { stroke: { value: 'blue' }, strokeWidth: { value: 2 }, angle: { value: 33 } }, POINTS.length)
      const want = await vegaPainted(structuredClone(s))
      expect(want.length).toBe(2 * POINTS.length)
      expect(same(want, asterPainted(s, false))).toEqual([])
    })
  }
  it('circles and squares in a batched run (256 or more items of one paint) are vega\'s, in order', async () => {
    for (const shape of ['circle', 'square', 'diamond']) {
      const s = spec(shape, { size: { value: 50 } }, 300)
      const want = await vegaPainted(structuredClone(s))
      const got = asterPainted(s, true)
      expect(want.length).toBe(300)
      expect(got.length).toBe(1) // a run is one path
      expect(same([{ ...want[0]!, path: want.flatMap((p) => p.path) }], got)).toEqual([])
    }
  })
})
