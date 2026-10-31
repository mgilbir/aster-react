/**
 * GENERATED differential for the arc generator (annular sectors with padding and rounded corners): seeded
 * random parameters, run through the pinned `d3-shape` `arc()` (the generator vega's arc mark uses) and through
 * Aster's `arcInto` / `arcPath` / `boundArcItem` in ONE process and engine, compared on
 *   - the `d` string at 3 digits (what the SVG renderer writes) and at full precision,
 *   - the raw call stream a context receives (moveTo / lineTo / arc / closePath with the exact numbers and the
 *     counter-clockwise flag, -0 and NaN told apart), which is what a canvas draws, and
 *   - the bounds the sector gives its item (vega's `boundItem`), turned by the item's angle and stroked.
 *
 * The parameters are drawn to hit every branch of the sector: radii of zero, below the 1e-12 cut-off, equal,
 * swapped, negative, huge and non-finite; angles reversed, a full turn, more than a turn, a hair under a turn
 * and spans of 1e-13; corner radii larger than the band; pad angles larger than the span; NaN and Infinity in
 * every slot. The pad radius is d3's default (the hypotenuse of the two radii): vega never sets another.
 * The seed is fixed so a failure names a reproducible case.
 */
import { describe, expect, it } from 'vitest'
import * as d3Shape from 'd3-shape'
import * as vega from 'vega'
import { arcInto, arcPath, itemArcPath } from '../../core/src/render.ts'
import { Bounds, boundArcItem } from '../../core/src/bounds.ts'
import { BoundsPen } from '../../core/src/bounds-pen.ts'
import { enc, exact } from './differential-util.mts'

/* eslint-disable @typescript-eslint/no-explicit-any */

// --- inputs --------------------------------------------------------------------------------------

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

interface ArcSpec { inner: number; outer: number; start: number; end: number; corner: number; pad: number }

const TAU = 2 * Math.PI
const RADII = [0, 0, 0, 1e-13, 1e-12, 1.0000001e-12, 1e-11, 1e-6, 0.5, 1, 2, 3, 5, 10, 20, 35, 50, 70, 100, 1e3, 1e8, 1e300, -5, -0, NaN, Infinity, -Infinity]
const SPANS = [0, 0, 1e-13, -1e-13, 1e-12, -1e-12, 2e-12, 1e-9, 1e-6, 0.001, 0.05, 0.3, 0.9, 1.5, Math.PI / 2, Math.PI - 1e-9, Math.PI, Math.PI + 1e-9, 3.5, 5, 6,
  TAU - 1e-9, TAU - 1e-12, TAU - 1e-13, TAU - 5e-13, TAU, TAU + 1e-13, TAU + 1e-12, TAU + 0.5, 3 * Math.PI, 4 * TAU, NaN, Infinity]
const STARTS = [0, 0, 0, -0, Math.PI / 2, Math.PI, 1.5 * Math.PI, TAU, 3 * Math.PI, -Math.PI, -TAU, 1e-13, 1, 2, 4, 1e6, NaN, Infinity]
const CORNERS = [0, 0, 0, 0, 1e-13, 1e-12, 0.5, 1, 2, 3, 5, 10, 25, 1e3, 1e8, -1, NaN, Infinity]
const PADS = [0, 0, 0, 0, 1e-13, 1e-11, 0.001, 0.01, 0.05, 0.1, 0.3, 0.5, 1, 2, Math.PI, TAU, 10, -0.1, NaN, Infinity]

function arcSpec(seed: number): ArcSpec {
  const r = rng(seed)
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!
  const rand = (lo: number, hi: number): number => lo + r() * (hi - lo)
  // most draws are ordinary (a pie / donut slice) so the corner and pad branches run on real geometry
  const ordinary = r() < 0.55
  let outer = ordinary ? rand(1, 120) : r() < 0.5 ? rand(0, 150) : pick(RADII)
  let inner = ordinary ? (r() < 0.3 ? 0 : rand(0, outer)) : r() < 0.35 ? pick(RADII) : r() < 0.5 ? outer : rand(0, 150)
  if (r() < 0.12) [inner, outer] = [outer, inner]
  if (r() < 0.05) inner = outer
  const start = ordinary ? rand(-8, 8) : pick(STARTS)
  const span = ordinary && r() < 0.8 ? rand(-TAU, TAU) : pick(SPANS)
  let end = start + span
  if (r() < 0.08) end = pick(STARTS)
  const corner = ordinary ? (r() < 0.4 ? 0 : r() < 0.7 ? rand(0, 12) : rand(0, 80)) : pick(CORNERS)
  const pad = ordinary ? (r() < 0.45 ? 0 : r() < 0.8 ? rand(0, 0.15) : rand(0, 3)) : pick(PADS)
  return { inner, outer, start, end, corner, pad }
}

// --- the same job on d3-shape and on Aster --------------------------------------------------------

type Call = [string, ...unknown[]]
class Recorder {
  calls: Call[] = []
  moveTo(x: number, y: number): void { this.calls.push(['M', x, y]) }
  lineTo(x: number, y: number): void { this.calls.push(['L', x, y]) }
  arc(x: number, y: number, r: number, a0: number, a1: number, ccw?: boolean): void { this.calls.push(['A', x, y, r, a0, a1, ccw]) }
  closePath(): void { this.calls.push(['Z']) }
}

const d3Arc = (s: ArcSpec) => d3Shape.arc().innerRadius(s.inner).outerRadius(s.outer).startAngle(s.start).endAngle(s.end).cornerRadius(s.corner).padAngle(s.pad)
const d3D = (s: ArcSpec, digits: number | null): string => d3Arc(s).digits(digits)(undefined as never) ?? ''
const d3Calls = (s: ArcSpec): Call[] => {
  const rec = new Recorder()
  d3Arc(s).context(rec as never)(undefined as never)
  return rec.calls
}
const asterD = (s: ArcSpec, digits: number | null): string => arcPath(s.outer, s.inner, s.start, s.end, s.corner, s.pad, digits)
const asterCalls = (s: ArcSpec): Call[] => {
  const rec = new Recorder()
  arcInto(rec, s.outer, s.inner, s.start, s.end, s.corner, s.pad)
  return rec.calls
}

// --- the corpus ----------------------------------------------------------------------------------

const CASES = 12000
const seedOf = (i: number): number => 0xa7c5 + i * 15485863
const cases = Array.from({ length: CASES }, (_, i) => arcSpec(seedOf(i)))

function compare(label: string, i: number, want: () => unknown, got: () => unknown): void {
  const w = exact(want)
  const g = exact(got)
  if (JSON.stringify(w) !== JSON.stringify(g)) {
    expect({ case: label, seed: seedOf(i), spec: enc(cases[i]), got: g }).toEqual({ case: label, seed: seedOf(i), spec: enc(cases[i]), got: w })
  }
}

describe('generated d3-shape arc differential', () => {
  it('the context call stream is d3 arc()\'s, number for number and flag for flag', () => {
    cases.forEach((s, i) => compare('calls', i, () => d3Calls(s).map((c) => c.map(enc)), () => asterCalls(s).map((c) => c.map(enc))))
  })

  it('the path text is what d3 arc() writes, at 3 digits, at 0 and at full precision', () => {
    for (const digits of [3, 0, null]) cases.forEach((s, i) => compare(`d@${digits}`, i, () => d3D(s, digits), () => asterD(s, digits)))
  })

  it('an arc item\'s path is vega\'s: a missing, null, NaN or string field reads as vega\'s `|| 0` accessors do', () => {
    const r = rng(0x17e3)
    const odd = [undefined, null, NaN, '7', 0, '', -0, '0.5']
    cases.forEach((s, i) => {
      const item: Record<string, unknown> = { innerRadius: s.inner, outerRadius: s.outer, startAngle: s.start, endAngle: s.end, cornerRadius: s.corner, padAngle: s.pad }
      for (const k of Object.keys(item)) if (r() < 0.25) item[k] = odd[Math.floor(r() * odd.length)]
      if (r() < 0.1) { item.radius = item.outerRadius; delete item.outerRadius }
      const f = (k: string) => (it: Record<string, unknown>) => (it[k] as number) || 0
      // (the legacy `radius` stands in for a missing outer radius)
      const outer = (it: Record<string, unknown>) => ((it.outerRadius ?? it.radius) as number) || 0
      const want = () => d3Shape.arc<Record<string, unknown>>().startAngle(f('startAngle')).endAngle(f('endAngle')).padAngle(f('padAngle')).innerRadius(f('innerRadius')).outerRadius(outer)
        .cornerRadius(f('cornerRadius')).digits(3)(item) ?? ''
      compare('item d@3', i, want, () => itemArcPath(item as never))
    })
  })

  it('the bounds of an arc item are vega\'s (turned by the angle, stroked, moved to the item)', () => {
    const r = rng(0xb04d)
    for (let i = 0; i < CASES; i++) {
      const s = cases[i]!
      const item: Record<string, unknown> = { x: Math.round(r() * 400) / 4, y: Math.round(r() * 400) / 4, innerRadius: s.inner, outerRadius: s.outer, startAngle: s.start, endAngle: s.end, cornerRadius: s.corner, padAngle: s.pad }
      if (r() < 0.4) item.angle = [0, 30, 90, -45, 180, 400, NaN][Math.floor(r() * 7)]
      if (r() < 0.5) { item.stroke = '#000'; item.strokeWidth = [0, 1, 3, 10][Math.floor(r() * 4)] }
      const box = (b: any): unknown => [b.x1, b.y1, b.x2, b.y2]
      compare('bounds', i, () => box((vega as any).boundItem({ ...item, mark: { marktype: 'arc' } })),
        () => { const b = boundArcItem(new Bounds(), { ...item } as never); return box(b) })
    }
  })
})

describe('the bounds pen\'s arc is vega\'s boundContext arc', () => {
  it('measures the same box for random arcs, either way round, turned or not, in or out of one turn', () => {
    const r = rng(0xb0b0)
    const angles = [0, -0, Math.PI / 2, Math.PI, 1.5 * Math.PI, TAU, -Math.PI / 2, -TAU, 3 * Math.PI, 4 * TAU, 1e-13, TAU - 1e-9, 1e6, -1e6, NaN, Infinity]
    const angle = (): number => (r() < 0.25 ? angles[Math.floor(r() * angles.length)]! : (r() - 0.4) * (r() < 0.8 ? 14 : 400))
    const box = (b: any): unknown => [b.x1, b.y1, b.x2, b.y2]
    let walked = 0
    for (let i = 0; i < 20000; i++) {
      const cx = r() < 0.3 ? 0 : (r() - 0.5) * 300
      const cy = r() < 0.3 ? 0 : (r() - 0.5) * 300
      const rad = r() < 0.05 ? [0, -3, NaN][Math.floor(r() * 3)]! : r() * 120
      const a0 = angle()
      const a1 = r() < 0.2 ? a0 + (r() - 0.5) * 1e-9 : r() < 0.5 ? a0 + (r() - 0.5) * 7 : angle()
      const ccw = r() < 0.5
      const turn = r() < 0.5 ? 0 : [30, 90, -45, 180, 400, 1e-9][Math.floor(r() * 6)]!
      if (Math.abs(a1 - a0) < TAU - 1e-8) walked++
      compare('pen', 0, () => { const b = new (vega as any).Bounds(); (vega as any).boundContext(b, turn).arc(cx, cy, rad, a0, a1, ccw); return box(b) },
        () => { const b = new Bounds(); new BoundsPen(b, turn).arc(cx, cy, rad, a0, a1, ccw); return box(b) })
    }
    expect(walked).toBeGreaterThan(10000)
  })
})

describe('generated arc corpus coverage', () => {
  it('actually contains the cases it claims', () => {
    const streams = cases.map(d3Calls)
    const has = (f: (c: Call[], s: ArcSpec) => boolean): number => streams.filter((c, i) => f(c, cases[i]!)).length
    const arcs = (c: Call[]): number => c.filter((x) => x[0] === 'A').length
    expect(has((c) => c.length === 2 && c[0]![0] === 'M' && c[1]![0] === 'Z' && c[0]![1] === 0 && c[0]![2] === 0)).toBeGreaterThan(300) // a point
    expect(has((c, s) => arcs(c) === 2 && c.filter((x) => x[0] === 'M').length === 2 && s.inner !== s.outer)).toBeGreaterThan(100) // an annulus
    expect(has((c) => c.filter((x) => x[0] === 'M').length === 1 && arcs(c) === 1 && c.some((x) => x[0] === 'L'))).toBeGreaterThan(300) // a wedge
    expect(has((c) => arcs(c) >= 4)).toBeGreaterThan(1000) // rounded corners on the arc
    expect(has((c) => arcs(c) >= 6)).toBeGreaterThan(300) // rounded on both radii
    expect(has((c, s) => s.pad > 0.001 && s.pad < 3 && arcs(c) >= 2)).toBeGreaterThan(1000) // padded
    expect(has((c, s) => s.corner > 0 && s.corner > Math.abs(s.outer - s.inner) && arcs(c) >= 2)).toBeGreaterThan(80) // corner larger than the band
    expect(has((c, s) => s.end < s.start)).toBeGreaterThan(1500) // reversed
    expect(has((c, s) => Math.abs(s.end - s.start) > TAU && Number.isFinite(s.end))).toBeGreaterThan(500) // more than a turn
    expect(has((c, s) => Math.abs(s.end - s.start) < 1e-11)).toBeGreaterThan(200) // a tiny span
    expect(has((c) => c.some((x) => x.some((v) => typeof v === 'number' && !Number.isFinite(v))))).toBeGreaterThan(300) // non-finite output
  })
})
