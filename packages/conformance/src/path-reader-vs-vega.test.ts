/**
 * The one reader of SVG path text (core path-data.ts) against vega-scenegraph's own `pathParse` / `pathRender` and its canvas
 * drawing of path marks, over generated path text: every command, relative and absolute, every way a number may be written (a
 * sign, a leading or trailing dot, an exponent, numbers run together), packed arc flags, implicit repeats, separators, and
 * text that is malformed in every way the grammar can refuse.
 *
 *  - reading: the same commands, or the same error;
 *  - replay: the same calls with the same numbers, bit for bit, unscaled and scaled, moved and not;
 *  - a path mark on a canvas: the same paths painted, as vega's `Marks.path.draw` paints them, turned and scaled included;
 *  - its outline for the hit index and `intersect()`: vega's replay, flattened;
 *  - a custom symbol shape and a legend's symbols: the same SVG;
 *  - the engine's own path text (what the canvas and the hit index read back): the commands vega reads from it.
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { compileChart, evaluateChart, renderSpec } from '@aster-charts/core'
import { renderSceneToCanvas } from '@aster-charts/core/canvas'
import { drawnPathCommands, parsePathData, renderSvgPath, svgPathCommands, type PathCommand } from '../../core/src/path-data.js'
import { pathMarkPolys, transformPolys } from '../../core/src/geometry-read.js'
import { Flattener } from '../../core/src/path-flatten.js'
import { canonicalizeSvg, diffCanonical } from './normalize.js'

const vegaParse = (vega as unknown as { pathParse(d: string): PathCommand[] }).pathParse
const vegaRender = (vega as unknown as { pathRender(c: unknown, p: PathCommand[], l?: number, t?: number, sx?: number, sy?: number): void }).pathRender

// --- generated path text --------------------------------------------------------------------------------------------------

/** mulberry32: a seeded generator, so a failure names its case. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const ARITY: Record<string, number> = { m: 2, l: 2, h: 1, v: 1, z: 0, c: 6, s: 4, q: 4, t: 2, a: 7 }
const LETTERS = Object.keys(ARITY)

/** A number written one of the ways the grammar allows (and the value it stands for is its own business). */
function number(r: () => number): string {
  const v = (r() - 0.4) * 60
  const pick = r()
  if (pick < 0.3) return String(Math.round(v))
  if (pick < 0.5) return v.toFixed(3)
  if (pick < 0.6) return (v < 0 ? '-' : '+') + Math.abs(v).toFixed(2)
  if (pick < 0.7) return (v < 0 ? '-' : '') + '.' + String(Math.floor(r() * 1000)) // a leading dot
  if (pick < 0.78) return String(Math.round(v)) + '.' // a trailing dot
  if (pick < 0.88) return (v / 100).toExponential(2).replace('e', r() < 0.5 ? 'e' : 'E')
  return String(v)
}

/** Separators between numbers: a comma, spaces, both, or none where the next number's sign or dot ends the last. */
function sep(r: () => number, next: string): string {
  const pick = r()
  if (pick < 0.3) return ','
  if (pick < 0.55) return ' '
  if (pick < 0.7) return ' , '
  if (pick < 0.8) return '\n\t'
  return /^[-+.]/.test(next) ? '' : ' '
}

/** Path text of `n` commands; an arc's flags packed with the numbers after them now and then. */
function pathText(r: () => number, n: number): string {
  let out = (r() < 0.5 ? 'M' : 'm') + number(r) + ',' + number(r)
  for (let i = 0; i < n; i++) {
    const type = LETTERS[Math.floor(r() * LETTERS.length)]!
    const letter = r() < 0.5 ? type.toUpperCase() : type
    const groups = type === 'z' ? 1 : r() < 0.2 ? 2 : 1 // an implicit repeat now and then
    let body = ''
    for (let g = 0; g < groups; g++) {
      for (let k = 0; k < ARITY[type]!; k++) {
        const flag = type === 'a' && (k === 3 || k === 4)
        const v = flag ? (r() < 0.5 ? '0' : '1') : type === 'a' && k < 2 ? String(1 + Math.round(r() * 30)) : number(r)
        // (packed flags: "a5 5 0 1010 0")
        body += (body === '' ? (r() < 0.5 ? ' ' : '') : flag && r() < 0.4 ? '' : sep(r, v)) + v
      }
    }
    out += (r() < 0.3 ? ' ' : '') + letter + body
  }
  return out
}

/** A malformed variant: a number dropped, a stray letter or symbol, a command left bare, junk before the first command. */
function mutate(r: () => number, d: string): string {
  const pick = r()
  const at = Math.floor(r() * d.length)
  if (pick < 0.25) return d.replace(/[-+]?\d+(\.\d*)?(?!.*[-+]?\d)/, '') // the last number dropped
  if (pick < 0.4) return d.slice(0, at) + 'X' + d.slice(at)
  if (pick < 0.5) return d.slice(0, at) + '#' + d.slice(at)
  if (pick < 0.6) return d + (r() < 0.5 ? ' L' : 'c1,2')
  if (pick < 0.7) return '12 3 ' + d
  if (pick < 0.8) return d.slice(0, at) + ',,' + d.slice(at)
  if (pick < 0.9) return d.replace(/a(\S+?)\s+(\S+?)\s+(\S+?)\s+[01]/i, 'a$1 $2 $3 2') // a flag that is not one
  return d.slice(0, at)
}

const CASES: string[] = []
{
  const r = rng(20261115)
  for (let i = 0; i < 1500; i++) {
    const d = pathText(r, 1 + Math.floor(r() * 7))
    CASES.push(d, mutate(r, d))
  }
  CASES.push('', 'z', 'M', 'M0', 'M0,0z5', 'M0,0 0,0', 'M0 0 a5 5 0 1010 0', 'M0,0L+5.,1e1', 'M1e', 'M.5.5', 'M-.5-.5', 'M0,0 A1 1 0 1 1 1 1 1 1')
}

type Outcome = { commands: PathCommand[] } | { error: string }
const outcome = (read: () => PathCommand[]): Outcome => {
  try { return { commands: read() } } catch (e) { return { error: `${(e as Error).name}: ${(e as Error).message}` } }
}

// --- recording sinks ---------------------------------------------------------------------------------------------------------

/** Every call a replay makes, with its numbers as they are (`Object.is` tells 0 from -0). */
function callRecorder(): { sink: Record<string, (...a: number[]) => void>; calls: string[] } {
  const calls: string[] = []
  const rec = (name: string) => (...a: number[]): void => { calls.push(`${name}(${a.map((v) => (Object.is(v, -0) ? '-0' : String(v))).join(',')})`) }
  return { sink: { beginPath: () => undefined, moveTo: rec('M'), lineTo: rec('L'), bezierCurveTo: rec('C'), quadraticCurveTo: rec('Q'), closePath: rec('Z') }, calls }
}

describe('reading path text, as vega reads it', () => {
  it(`${CASES.length} generated texts: the same commands, or the same error`, () => {
    let refused = 0
    const differ: string[] = []
    for (const d of CASES) {
      const want = outcome(() => vegaParse(d))
      if ('error' in want) refused++
      const got = outcome(() => svgPathCommands(d))
      if (JSON.stringify(got) !== JSON.stringify(want)) differ.push(`${JSON.stringify(d)}: vega ${JSON.stringify(want)} aster ${JSON.stringify(got)}`)
    }
    expect(differ.slice(0, 5)).toEqual([])
    // not vacuous: both outcomes are well represented
    expect(refused).toBeGreaterThan(300)
    expect(CASES.length - refused).toBeGreaterThan(1500)
  })

  it('as far as it reads: text vega reads is read the same; text it refuses, up to the command that fails', () => {
    for (const d of CASES) {
      const strict = outcome(() => vegaParse(d))
      if ('commands' in strict) expect(drawnPathCommands(d)).toEqual(strict.commands)
    }
    // (each refused text: the commands before the failing one, and the complete groups of the failing one)
    expect(drawnPathCommands('M0,0 L10')).toEqual([['M', 0, 0]])
    expect(drawnPathCommands('M0,0 L10,10 20')).toEqual([['M', 0, 0], ['L', 10, 10]])
    expect(drawnPathCommands('M0,0 X10,10')).toEqual([['M', 0, 0]])
    expect(drawnPathCommands('M0,0 L5,5 X10,10 L20,20')).toEqual([['M', 0, 0], ['L', 5, 5]])
    expect(drawnPathCommands('M0,0 L5,5 L')).toEqual([['M', 0, 0], ['L', 5, 5]])
    expect(drawnPathCommands('M0,0 a5 5 0 2 0 10 0')).toEqual([['M', 0, 0]])
    expect(drawnPathCommands('M0,0 L5,5 LNaN,1')).toEqual([['M', 0, 0], ['L', 5, 5]])
  })
})

describe('replaying commands, as vega replays them', () => {
  const r = rng(7)
  const TRANSFORMS: Array<[number, number, number, number]> = [[0, 0, 1, 1], [3.25, -7.5, 1, 1], [0, 0, 2.5, 2.5], [10.1, 4.3, 3, 0.5], [-2, 9, 0.3, 1.7]]
  it('the same calls, the same numbers: every generated path vega reads, under every move and scale', () => {
    let compared = 0
    for (const d of CASES) {
      const read = outcome(() => vegaParse(d))
      if (!('commands' in read) || read.commands.length === 0) continue
      for (const [l, t, sx, sy] of TRANSFORMS) {
        const want = callRecorder()
        const got = callRecorder()
        const w = outcome(() => { vegaRender(want.sink, vegaParse(d), l, t, sx, sy); return [] })
        const g = outcome(() => { renderSvgPath(got.sink as never, svgPathCommands(d), l, t, sx, sy); return [] })
        expect(g, d).toEqual(w)
        expect(got.calls, `${d} at ${l},${t} x${sx},${sy}`).toEqual(want.calls)
        compared++
      }
    }
    expect(compared).toBeGreaterThan(5000)
    void r
  })

  it('a smooth curve after a straight one, a t after a T, a path that starts with t: what vega draws (and throws)', () => {
    for (const d of ['M0,0 Q5,5 10,0 L20,0 T30,0', 'M0,0 C1,2 3,4 5,6 L7,8 S9,9 10,10', 'M0,0 q5,5 10,0 t10,0 T40,0 t5,5', 't10,10', 'M0,0 L1,1 t5,5', 'M0,0 S5,5 10,0']) {
      for (const [l, t, sx, sy] of TRANSFORMS) {
        const want = callRecorder()
        const got = callRecorder()
        const w = outcome(() => { vegaRender(want.sink, vegaParse(d), l, t, sx, sy); return [] })
        const g = outcome(() => { renderSvgPath(got.sink as never, svgPathCommands(d), l, t, sx, sy); return [] })
        expect(g, d).toEqual(w)
        expect(got.calls, `${d} x${sx},${sy}`).toEqual(want.calls)
      }
    }
  })
})

// --- a path mark on a canvas ------------------------------------------------------------------------------------------------

type M = [number, number, number, number, number, number]
interface Painted { op: string; style: string; path: number[][] }

/** A recording 2D context: the transform, the current path in device space, and each paint. */
function canvasRecorder(): { ctx: never; painted: Painted[] } {
  const painted: Painted[] = []
  let m: M = [1, 0, 0, 1, 0, 0]
  const stack: M[] = []
  let path: number[][] = []
  const state: Record<string, unknown> = { fillStyle: '#000', strokeStyle: '#000' }
  const dev = (x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
  const mul = (b: M): void => {
    m = [m[0] * b[0] + m[2] * b[1], m[1] * b[0] + m[3] * b[1], m[0] * b[2] + m[2] * b[3], m[1] * b[2] + m[3] * b[3], m[0] * b[4] + m[2] * b[5] + m[4], m[1] * b[4] + m[3] * b[5] + m[5]]
  }
  const own: Record<string, (...a: number[]) => void> = {
    save: () => { stack.push([...m] as M) },
    restore: () => { m = stack.pop() ?? m },
    translate: (x, y) => mul([1, 0, 0, 1, x!, y!]),
    scale: (x, y) => mul([x!, 0, 0, y!, 0, 0]),
    rotate: (a) => mul([Math.cos(a!), Math.sin(a!), -Math.sin(a!), Math.cos(a!), 0, 0]),
    setTransform: (a, b, c, d, e, f) => { m = [a!, b!, c!, d!, e!, f!] },
    beginPath: () => { path = [] },
    closePath: () => { path.push([3]) },
    moveTo: (x, y) => { path.push([0, ...dev(x!, y!)]) },
    lineTo: (x, y) => { path.push([1, ...dev(x!, y!)]) },
    bezierCurveTo: (a, b, c, d, x, y) => { path.push([2, ...dev(a!, b!), ...dev(c!, d!), ...dev(x!, y!)]) },
    quadraticCurveTo: (a, b, x, y) => { path.push([4, ...dev(a!, b!), ...dev(x!, y!)]) },
    fill: () => { painted.push({ op: 'fill', style: String(state.fillStyle), path: path.map((p) => [...p]) }) },
    stroke: () => { painted.push({ op: 'stroke', style: String(state.strokeStyle), path: path.map((p) => [...p]) }) },
  }
  const ctx = new Proxy(state, {
    get: (t, k: string) => (k in own ? own[k] : k in t ? t[k] : () => undefined),
    set: (t, k: string, v) => { t[k] = v; return true },
  })
  return { ctx: ctx as never, painted }
}

/** The differences between two paint records: each number to 1e-9 (a turn's matrix may differ in its last bit). */
function paintDiff(want: Painted[], got: Painted[]): string[] {
  if (want.length !== got.length) return [`${want.length} paints in vega, ${got.length} in aster`]
  const out: string[] = []
  want.forEach((w, i) => {
    const g = got[i]!
    if (w.op !== g.op || w.style !== g.style) out.push(`#${i}: ${w.op} ${w.style} vs ${g.op} ${g.style}`)
    if (w.path.length !== g.path.length) { out.push(`#${i}: ${w.path.length} path ops vs ${g.path.length}`); return }
    w.path.forEach((rw, j) => {
      const rg = g.path[j]!
      if (rw.length !== rg.length || rw.some((v, k) => !(Math.abs(v - rg[k]!) <= 1e-9 * Math.max(1, Math.abs(v))) && !(Number.isNaN(v) && Number.isNaN(rg[k]!)))) out.push(`#${i} op ${j}: ${JSON.stringify(rw)} vs ${JSON.stringify(rg)}`)
    })
  })
  return out
}

const PLACEMENTS: Array<Record<string, unknown>> = [
  {},
  { x: { value: 31.7 }, y: { value: 12.25 } },
  { x: { value: 40 }, y: { value: 30 }, angle: { value: 33 } },
  { x: { value: 20 }, y: { value: 50 }, scaleX: { value: 2.5 }, scaleY: { value: 0.6 } },
  { x: { value: 60 }, y: { value: 40 }, angle: { value: -71 }, scaleX: { value: 0.7 }, scaleY: { value: 1.9 } },
]

function pathMarkSpec(paths: string[], placement: Record<string, unknown>): Record<string, unknown> {
  return {
    width: 200, height: 150, padding: 0, autosize: 'none',
    data: [{ name: 't', values: paths.map((p) => ({ p })) }],
    marks: [{ type: 'path', from: { data: 't' }, encode: { update: { path: { field: 'p' }, fill: { value: 'red' }, stroke: { value: 'blue' }, ...placement } } }],
  }
}

async function vegaPainted(spec: Record<string, unknown>): Promise<Painted[]> {
  const view = new vega.View(vega.parse(spec as never), { renderer: 'none', logLevel: vega.None })
  try {
    await view.runAsync()
    const { ctx, painted } = canvasRecorder()
    const mark = (view.scenegraph() as unknown as { root: { items: Array<{ items: Array<{ marktype: string }> }> } }).root.items[0]!.items.find((g) => g.marktype === 'path')!
    ;(vega as unknown as { Marks: Record<string, { draw(c: unknown, s: unknown, b: unknown): void }> }).Marks.path!.draw(ctx, mark, null)
    return painted
  } finally { view.finalize() }
}

function asterPainted(spec: Record<string, unknown>): Painted[] {
  const { ctx, painted } = canvasRecorder()
  renderSceneToCanvas(evaluateChart(compileChart(structuredClone(spec) as never), {}), ctx)
  return painted.filter((p) => p.style === 'red' || p.style === 'blue')
}

/** The generated texts vega reads (a text it refuses throws out of its canvas drawing, which has nothing to compare). */
const READABLE = CASES.filter((d) => 'commands' in outcome(() => vegaParse(d)) && d.trim() !== '')

describe('a path mark on a canvas, as vega draws it', () => {
  for (const [i, placement] of PLACEMENTS.entries()) {
    it(`placement ${i} (${Object.keys(placement).join(', ') || 'none'}): every generated path vega reads`, async () => {
      // (in batches: a mark of many items, as a chart has them)
      for (let k = 0; k < READABLE.length; k += 250) {
        const spec = pathMarkSpec(READABLE.slice(k, k + 250), placement)
        const want = await vegaPainted(structuredClone(spec))
        expect(want.length).toBeGreaterThan(0)
        expect(paintDiff(want, asterPainted(spec)).slice(0, 5)).toEqual([])
      }
    }, 60_000)
  }
})

describe('a path mark\'s outline for the hit index and intersect(), as vega draws it', () => {
  it('every generated path vega reads, unscaled and scaled: vega\'s replay, flattened', () => {
    let compared = 0
    for (const d of READABLE) {
      for (const [x, y, sx, sy] of [[0, 0, 1, 1], [0, 0, 2.5, 0.4], [12.5, -3, 1, 1], [5, 5, 2.5, 0.4]] as const) {
        const f = new Flattener((px, py) => [px, py])
        vegaRender(f, vegaParse(d), x, y, sx, sy)
        const got = transformPolys(pathMarkPolys(d, sx, sy), (px, py) => [x + px, y + py])
        expect(got.length, d).toBe(f.polys.length)
        got.forEach((p, k) => {
          const w = f.polys[k]!
          expect(p.closed, d).toBe(w.closed)
          expect(p.pts.length, d).toBe(w.pts.length)
          // (vega computes an arc from the moved points; the index flattens the path once at the item's origin and moves the
          // polygon. The arc's centre is an ill-conditioned solve: sqrt(1/d - 1/4) near a half turn turns the last bit of the moved
          // endpoints into ~1e-5 px of a 400 px arc. That is far inside the flattening tolerance, FLATTEN_TOLERANCE = 0.01 px.
          // Unmoved, they are the same numbers: see the bit-for-bit replay above)
          const tol = x === 0 && y === 0 ? 0 : 1e-4
          p.pts.forEach((v, j) => { if (!(Math.abs(v - w.pts[j]!) <= tol) && !(Number.isNaN(v) && Number.isNaN(w.pts[j]!))) throw new Error(`${d}: point ${j} ${v} vs ${w.pts[j]}`) })
        })
        compared++
      }
    }
    expect(compared).toBeGreaterThan(5000)
  })
})

// --- custom symbol shapes and legends -----------------------------------------------------------------------------------------

async function vegaSvg(spec: Record<string, unknown>): Promise<string> {
  const view = new vega.View(vega.parse(spec as never), { renderer: 'none', logLevel: vega.None })
  try { await view.runAsync(); return await view.toSVG() } finally { view.finalize() }
}

describe('a custom symbol shape, as vega writes it', () => {
  // (a shape is drawn at a size: its numbers scaled by sqrt(size) / 2, written to 3 decimals)
  const shapes = READABLE.filter((d) => /^\s*[Mm]/.test(d)).slice(0, 600)
  it(`${shapes.length} generated shapes on symbols`, async () => {
    for (let k = 0; k < shapes.length; k += 100) {
      const batch = shapes.slice(k, k + 100)
      const spec = {
        width: 300, height: 200, padding: 5, autosize: 'none',
        data: [{ name: 't', values: batch.map((s, i) => ({ s, i })) }],
        marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { signal: '20 + (datum.i % 10) * 25' }, y: { signal: '20 + floor(datum.i / 10) * 18' }, size: { signal: '10 + datum.i * 7' }, shape: { field: 's' }, fill: { value: 'teal' }, stroke: { value: '#333' } } } }],
      }
      const want = await vegaSvg(structuredClone(spec))
      expect(want.match(/<path/g)!.length).toBeGreaterThan(100) // not vacuous
      expect(diffCanonical(canonicalizeSvg(want), canonicalizeSvg(renderSpec(structuredClone(spec) as never))).slice(0, 5)).toEqual([])
    }
  }, 60_000)

  it('a legend whose symbols are custom shapes: arcs, relative commands, smooth curves after straight ones', async () => {
    const legendShapes = ['M-1,-1L1,-1L0,1Z', 'm-1 0a1 1 0 1 1 2 0a1 1 0 1 1-2 0z', 'M-1,0 Q0,-1.5 1,0 T0,1 Z', 'M-1-1 h2 v.5 S0,1 -1,1z', 'M0,-1 L1,0 L0,1 t-1,-1 z', 'M-.8,.8 A1.2 .6 30 10.5 -.5']
    const spec = {
      width: 200, height: 100, padding: 5,
      scales: [{ name: 'shape', type: 'ordinal', domain: legendShapes.map((_, i) => `s${i}`), range: legendShapes }],
      legends: [{ shape: 'shape', title: 'shapes', symbolSize: 150 }, { shape: 'shape', direction: 'horizontal', orient: 'bottom', symbolStrokeWidth: 2, symbolFillColor: 'gold' }],
    }
    const want = await vegaSvg(structuredClone(spec))
    expect(want.match(/role-legend-symbol/g)!.length).toBeGreaterThan(1) // not vacuous
    expect(diffCanonical(canonicalizeSvg(want), canonicalizeSvg(renderSpec(structuredClone(spec) as never)))).toEqual([])
  })
})

// --- the engine's own text -----------------------------------------------------------------------------------------------------

describe('the engine\'s own path text, read back', () => {
  it('every path a scene of every mark type carries reads as vega reads it', () => {
    const spec = {
      width: 300, height: 200, padding: 5,
      data: [{ name: 't', values: Array.from({ length: 12 }, (_, i) => ({ x: i, y: Math.sin(i) * 10 + 0.123456 * i, c: i % 3 })) }],
      scales: [
        { name: 'x', type: 'linear', domain: { data: 't', field: 'x' }, range: 'width' },
        { name: 'y', type: 'linear', domain: { data: 't', field: 'y' }, range: 'height' },
        { name: 'c', type: 'ordinal', domain: { data: 't', field: 'c' }, range: 'category' },
      ],
      axes: [{ orient: 'bottom', scale: 'x', grid: true }, { orient: 'left', scale: 'y' }],
      legends: [{ fill: 'c', symbolType: 'triangle-up' }, { stroke: 'c', symbolType: 'circle' }],
      marks: [
        { type: 'group', encode: { update: { x: { value: 5 }, y: { value: 5 }, width: { value: 80 }, height: { value: 40 }, fill: { value: '#eee' }, cornerRadius: { value: 4 }, clip: { value: true } } } },
        { type: 'rect', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'x' }, width: { value: 7.3 }, y: { scale: 'y', field: 'y' }, y2: { scale: 'y', value: 0 }, cornerRadius: { value: 2 }, fill: { scale: 'c', field: 'c' } } } },
        { type: 'arc', from: { data: 't' }, encode: { update: { x: { value: 150 }, y: { value: 100 }, startAngle: { signal: 'datum.x * 0.5' }, endAngle: { signal: 'datum.x * 0.5 + 0.4' }, innerRadius: { value: 10 }, outerRadius: { value: 40 }, padAngle: { value: 0.01 }, cornerRadius: { value: 2 } } } },
        { type: 'area', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'y' }, y2: { scale: 'y', value: 0 }, interpolate: { value: 'monotone' } } } },
        { type: 'line', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'y' }, interpolate: { value: 'cardinal' } } } },
        { type: 'trail', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'y' }, size: { signal: '1 + datum.x' } } } },
        { type: 'symbol', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'y' }, size: { signal: '20 + datum.x * 9' }, shape: { signal: "['circle','square','cross','diamond','triangle-up','wedge','arrow','stroke'][datum.x % 8]" } } } },
      ],
    }
    // (the text the engine writes for every mark: what its SVG holds, and what a canvas or the hit index reads back)
    const svg = renderSpec(spec as never)
    const texts = new Set([...svg.matchAll(/ d="([^"]*)"/g)].map((m) => m[1]!))
    expect(texts.size).toBeGreaterThan(30)
    for (const d of texts) expect(outcome(() => svgPathCommands(d)), d).toEqual(outcome(() => vegaParse(d)))
  })

  it('a number that is not finite is NaN where it stands (a canvas ignores the call, as it ignores vega\'s)', () => {
    expect(parsePathData('MNaN,0')).toEqual([{ cmd: 'M', x: NaN, y: 0 }])
    expect(parsePathData('M0,0LInfinity,5L-Infinity,1Z')).toEqual([{ cmd: 'M', x: 0, y: 0 }, { cmd: 'L', x: NaN, y: 5 }, { cmd: 'L', x: NaN, y: 1 }, { cmd: 'Z' }])
    // (the word last in its command reads as NaN where it stands: vega refuses the text, the reader reads as far as vega's canvas would)
    expect(parsePathData('M0,0L5,NaNL10,10')).toEqual([{ cmd: 'M', x: 0, y: 0 }, { cmd: 'L', x: 5, y: NaN }, { cmd: 'L', x: 10, y: 10 }])
    expect(parsePathData('M219.5,InfinityL3,4')).toEqual([{ cmd: 'M', x: 219.5, y: NaN }, { cmd: 'L', x: 3, y: 4 }])
  })
})
