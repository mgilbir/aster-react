/**
 * GENERATED differential for the line / area path generators: seeded random point sets, run through the
 * pinned `d3-shape` and through Aster's `shape.ts` in ONE process and engine, and compared on
 *   - the `d` string at 3 digits (what the SVG renderer writes), at full precision (what the canvas
 *     renderer parses) and at 0 digits, and
 *   - the raw command stream a context receives (moveTo / lineTo / bezierCurveTo / closePath with the exact
 *     numbers, -0 and NaN told apart), which is what a canvas draws.
 *
 * The inputs are built to hit the corners of every curve: gaps (`defined` false) at the start, middle and end
 * or everywhere, runs of 0 / 1 / 2 / 3 / 4 points, duplicate and coincident points, collinear, vertical and
 * horizontal runs, huge (1e300) and tiny (1e-300) coordinates, mixed magnitudes, non-finite values. Every
 * family is run with its tension / alpha / beta parameter swept, as a line, and as an area in each of the x0 /
 * x1 / y0 / y1 configurations in both orientations. The seed is fixed so a failure names a reproducible case.
 */
import { describe, expect, it } from 'vitest'
import * as d3Shape from 'd3-shape'
import * as vega from 'vega'
import * as aster from '../../core/src/shape.ts'
import { trailPath } from '../../core/src/render.ts'
import { enc, exact } from './differential-util.mts'

/* eslint-disable @typescript-eslint/no-explicit-any */

// --- inputs --------------------------------------------------------------------------------------

interface Pt { x: number; y: number; x0: number; x1: number; y0: number; y1: number; live: boolean }

/** mulberry32: a small seeded PRNG, so the corpus is the same on every run and every Node version. */
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

const SCALES = [1, 1, 1, 100, 1e4, 1e-3, 1e-7, 1e-300, 1e12, 1e150, 1e300]
const STYLES = ['uniform', 'grid', 'collinear', 'vertical', 'horizontal', 'tiny', 'huge', 'mixed', 'sortedX', 'special', 'dups'] as const
type Style = (typeof STYLES)[number]
const GAPS = ['none', 'none', 'random', 'sparse', 'leading', 'trailing', 'alternate', 'all', 'single'] as const

function pointSet(seed: number): Pt[] {
  const r = rng(seed)
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!
  const sizes = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 12, 20, 33]
  const n = r() < 0.8 ? pick(sizes) : Math.floor(r() * 60)
  const style: Style = pick(STYLES)
  const scale = style === 'tiny' ? pick([1e-7, 1e-300, 1e-12]) : style === 'huge' ? pick([1e12, 1e150, 1e300, 1e307]) : pick(SCALES)
  const slope = (r() - 0.5) * 8
  const icept = (r() - 0.5) * 50
  const num = (): number => (r() - 0.5) * 200 * scale
  const value = (): number => {
    switch (style) {
      case 'grid': return Math.floor(r() * 5) * pick([1, 10, 0.5])
      case 'mixed': return (r() - 0.5) * 200 * pick(SCALES)
      case 'special': {
        const u = r()
        if (u < 0.08) return NaN
        if (u < 0.12) return Infinity
        if (u < 0.16) return -Infinity
        if (u < 0.2) return -0
        return num()
      }
      default: return num()
    }
  }
  const xs: number[] = []
  const ys: number[] = []
  let fixedX = value()
  let fixedY = value()
  for (let i = 0; i < n; i++) {
    let x = value()
    let y = value()
    if (style === 'collinear') { x = style === 'collinear' && r() < 0.5 ? i * scale * 3 : x; y = slope * x + icept * scale }
    if (style === 'vertical') x = fixedX
    if (style === 'horizontal') y = fixedY
    if (style === 'sortedX') x = i * scale * (0.5 + r())
    if ((style === 'dups' || style === 'grid' || r() < 0.12) && i > 0 && r() < 0.45) { x = xs[i - 1]!; y = r() < 0.7 ? ys[i - 1]! : y }
    if (style === 'dups' && i > 1 && r() < 0.15) { x = xs[i - 2]!; y = ys[i - 2]! }
    if (r() < 0.02) fixedX = value(), fixedY = value()
    xs.push(x)
    ys.push(y)
  }
  const gap = pick(GAPS)
  return xs.map((x, i) => {
    let live = true
    switch (gap) {
      case 'random': live = r() < 0.7; break
      case 'sparse': live = r() < 0.9; break
      case 'leading': live = i >= Math.min(n - 1, 2); break
      case 'trailing': live = i < n - 2; break
      case 'alternate': live = i % 2 === 0; break
      case 'all': live = false; break
      case 'single': live = i !== 1; break
    }
    // the four area coordinates are independent draws, with the usual ordering most of the time
    const y = ys[i]!
    const y0 = r() < 0.15 ? y : r() < 0.5 ? y + Math.abs(num()) : (r() - 0.5) * 100 * scale
    const x1 = r() < 0.15 ? x : x + Math.abs(num()) * 0.3
    return { x, y, x0: x, x1, y0, y1: y, live }
  })
}

// --- the curves under test ----------------------------------------------------------------------

type ParamKind = 'beta' | 'tension' | 'alpha' | null
interface Family { d3: string; name: string; param: ParamKind }
const FAMILIES: Family[] = [
  { d3: 'curveLinear', name: 'linear', param: null },
  { d3: 'curveLinearClosed', name: 'linear-closed', param: null },
  { d3: 'curveBasis', name: 'basis', param: null },
  { d3: 'curveBasisClosed', name: 'basis-closed', param: null },
  { d3: 'curveBasisOpen', name: 'basis-open', param: null },
  { d3: 'curveBundle', name: 'bundle', param: 'beta' },
  { d3: 'curveCardinal', name: 'cardinal', param: 'tension' },
  { d3: 'curveCardinalClosed', name: 'cardinal-closed', param: 'tension' },
  { d3: 'curveCardinalOpen', name: 'cardinal-open', param: 'tension' },
  { d3: 'curveCatmullRom', name: 'catmull-rom', param: 'alpha' },
  { d3: 'curveCatmullRomClosed', name: 'catmull-rom-closed', param: 'alpha' },
  { d3: 'curveCatmullRomOpen', name: 'catmull-rom-open', param: 'alpha' },
  { d3: 'curveMonotoneX', name: 'monotone-x', param: null },
  { d3: 'curveMonotoneY', name: 'monotone-y', param: null },
  { d3: 'curveNatural', name: 'natural', param: null },
  { d3: 'curveStep', name: 'step', param: null },
  { d3: 'curveStepAfter', name: 'step-after', param: null },
  { d3: 'curveStepBefore', name: 'step-before', param: null },
]
const PARAMS: Record<Exclude<ParamKind, null>, Array<number | undefined>> = {
  beta: [undefined, 0, 0.3, 0.85, 1, 1.7, -0.4],
  tension: [undefined, 0, 0.5, 1, -1, 2.5],
  alpha: [undefined, 0, 0.25, 0.5, 1, 2, -0.5],
}
const VARIANTS = FAMILIES.flatMap((f) => (f.param ? PARAMS[f.param] : [undefined]).map((p) => ({ ...f, p })))

// --- adapters: the same job on d3-shape and on Aster ---------------------------------------------

const d3Api = d3Shape as unknown as Record<string, any>

function d3Curve(v: { d3: string; param: ParamKind; p: number | undefined }): any {
  let c = d3Api[v.d3]
  if (v.p !== undefined && v.param) c = c[v.param](v.p)
  return c
}

type Call = [string, ...number[]]
class Recorder {
  calls: Call[] = []
  moveTo(x: number, y: number): void { this.calls.push(['M', x, y]) }
  lineTo(x: number, y: number): void { this.calls.push(['L', x, y]) }
  bezierCurveTo(a: number, b: number, c: number, d: number, e: number, f: number): void { this.calls.push(['C', a, b, c, d, e, f]) }
  closePath(): void { this.calls.push(['Z']) }
}

/** The four area boundary pairs a configuration draws: `[top x, top y, bottom x, bottom y]` per point. */
const AREA_CONFIGS = ['x/y0/y1', 'y/x0/x1', 'x0/x1/y0/y1', 'x/y1 (y0 = 0)', 'x0/x1/y (x0 = x1)'] as const
type AreaConfig = (typeof AREA_CONFIGS)[number]

function d3Area(cfg: AreaConfig) {
  const a = d3Shape.area<Pt>()
  switch (cfg) {
    case 'x/y0/y1': return a.x((p) => p.x).y0((p) => p.y0).y1((p) => p.y1)
    case 'y/x0/x1': return a.y((p) => p.y).x0((p) => p.x0).x1((p) => p.x1)
    case 'x0/x1/y0/y1': return a.x0((p) => p.x0).x1((p) => p.x1).y0((p) => p.y0).y1((p) => p.y1)
    case 'x/y1 (y0 = 0)': return a.x((p) => p.x).y1((p) => p.y1)
    case 'x0/x1/y (x0 = x1)': return a.x0((p) => p.x0).x1(null).y((p) => p.y)
  }
}
function areaBoundary(cfg: AreaConfig, p: Pt): [number, number, number, number] {
  switch (cfg) {
    case 'x/y0/y1': return [p.x, p.y1, p.x, p.y0]
    case 'y/x0/x1': return [p.x1, p.y, p.x0, p.y]
    case 'x0/x1/y0/y1': return [p.x1, p.y1, p.x0, p.y0]
    case 'x/y1 (y0 = 0)': return [p.x, p.y1, p.x, 0]
    case 'x0/x1/y (x0 = x1)': return [p.x0, p.y, p.x0, p.y]
  }
}

interface Spec { variant: (typeof VARIANTS)[number]; pts: Pt[]; digits: number | null }

const d3LineD = (s: Spec): string =>
  (d3Shape.line<Pt>().x((p) => p.x).y((p) => p.y).defined((p) => p.live).curve(d3Curve(s.variant)).digits(s.digits)(s.pts)) ?? ''
const d3LineCalls = (s: Spec): Call[] => {
  const rec = new Recorder()
  d3Shape.line<Pt>().x((p) => p.x).y((p) => p.y).defined((p) => p.live).curve(d3Curve(s.variant)).context(rec as never)(s.pts)
  return rec.calls
}
/**
 * KNOWN, DELIBERATE divergence: d3's bundle curve (beta != 1) has no `areaStart`, so d3 (and Vega with it) throws
 * `TypeError: output.areaStart is not a function` for an area with `interpolate: bundle` (the Vega sweep counts
 * it as an oracle node-error). Aster draws instead: each of the area's two passes is its own bundle line. The
 * oracle for that case is d3's own bundle curve with the missing hooks added as no-ops; for every other curve
 * the factory is d3's, untouched.
 */
const lacksAreaHooks = (s: Spec): boolean => s.variant.d3 === 'curveBundle' && s.variant.p !== 1
const d3AreaCurve = (s: Spec): any => {
  const base = d3Curve(s.variant)
  if (!lacksAreaHooks(s)) return base
  return (ctx: unknown) => Object.assign(base(ctx), { areaStart() {}, areaEnd() {} })
}
const d3AreaD = (s: Spec, cfg: AreaConfig): string => (d3Area(cfg).defined((p) => p.live).curve(d3AreaCurve(s)).digits(s.digits)(s.pts)) ?? ''
const d3AreaCalls = (s: Spec, cfg: AreaConfig): Call[] => {
  const rec = new Recorder()
  d3Area(cfg).defined((p) => p.live).curve(d3AreaCurve(s)).context(rec as never)(s.pts)
  return rec.calls
}

const asterCurve = (s: Spec) => aster.resolveCurve(s.variant.name, 'vertical', s.variant.p)
const cols = (pts: Pt[], f: (p: Pt) => number): Float64Array => Float64Array.from(pts, f)
const liveOf = (pts: Pt[]): Uint8Array => Uint8Array.from(pts, (p) => (p.live ? 1 : 0))

const asterLineD = (s: Spec): string => aster.linePath(asterCurve(s), cols(s.pts, (p) => p.x), cols(s.pts, (p) => p.y), liveOf(s.pts), s.digits)
const asterLineCalls = (s: Spec): Call[] => {
  const rec = new Recorder()
  aster.traceLine(rec, asterCurve(s), cols(s.pts, (p) => p.x), cols(s.pts, (p) => p.y), liveOf(s.pts))
  return rec.calls
}
const asterAreaArgs = (s: Spec, cfg: AreaConfig) =>
  [asterCurve(s), cols(s.pts, (p) => areaBoundary(cfg, p)[0]), cols(s.pts, (p) => areaBoundary(cfg, p)[1]),
    cols(s.pts, (p) => areaBoundary(cfg, p)[2]), cols(s.pts, (p) => areaBoundary(cfg, p)[3]), liveOf(s.pts)] as const
const asterAreaD = (s: Spec, cfg: AreaConfig): string => aster.areaPath(...asterAreaArgs(s, cfg), s.digits)
const asterAreaCalls = (s: Spec, cfg: AreaConfig): Call[] => {
  const rec = new Recorder()
  aster.traceArea(rec, ...asterAreaArgs(s, cfg))
  return rec.calls
}

// --- the corpus ----------------------------------------------------------------------------------

const SETS = 140
const SETS_PER_AREA_CONFIG = 28
const sets = Array.from({ length: SETS }, (_, i) => pointSet(0x5eed + i * 7919))

function compare(label: string, seed: number, want: () => unknown, got: () => unknown): void {
  const w = exact(want)
  const g = exact(got)
  if (JSON.stringify(w) !== JSON.stringify(g)) {
    // a readable, reproducible report instead of a 10 kB diff of the whole path
    expect({ case: label, seed, got: g }).toEqual({ case: label, seed, got: w })
  }
}

describe('generated d3-shape differential (line)', () => {
  for (const v of VARIANTS) {
    const name = `${v.d3}${v.p === undefined ? '' : `(${v.param}=${v.p})`}`
    it(`line ${name}: d at 3 digits, 0 digits, full precision; and the context calls`, () => {
      sets.forEach((pts, i) => {
        const seed = 0x5eed + i * 7919
        for (const digits of [3, null, 0]) {
          const s: Spec = { variant: v, pts, digits }
          compare(`line ${name} digits=${digits} set#${i}`, seed, () => d3LineD(s), () => asterLineD(s))
        }
        const s: Spec = { variant: v, pts, digits: null }
        compare(`line ${name} calls set#${i}`, seed, () => d3LineCalls(s).map((c) => c.map(enc)), () => asterLineCalls(s).map((c) => c.map(enc)))
      })
    })
  }
})

describe('generated d3-shape differential (area)', () => {
  for (const v of VARIANTS) {
    const name = `${v.d3}${v.p === undefined ? '' : `(${v.param}=${v.p})`}`
    it(`area ${name}: every x0/x1/y0/y1 configuration, d and context calls`, () => {
      AREA_CONFIGS.forEach((cfg, c) => {
        for (let k = 0; k < SETS_PER_AREA_CONFIG; k++) {
          const i = (c * SETS_PER_AREA_CONFIG + k) % SETS
          const pts = sets[i]!
          const seed = 0x5eed + i * 7919
          for (const digits of [3, null]) {
            const s: Spec = { variant: v, pts, digits }
            compare(`area ${name} [${cfg}] digits=${digits} set#${i}`, seed, () => d3AreaD(s, cfg), () => asterAreaD(s, cfg))
          }
          const s: Spec = { variant: v, pts, digits: null }
          compare(`area ${name} [${cfg}] calls set#${i}`, seed, () => d3AreaCalls(s, cfg).map((x) => x.map(enc)), () => asterAreaCalls(s, cfg).map((x) => x.map(enc)))
        }
      })
    })
  }
})

// --- trails: the path writer's arcs, against vega's trail through the real d3-path ----------------------

interface TrailItem { x?: number; y?: number; size?: number; defined?: boolean }

function trailItems(seed: number): TrailItem[] {
  const r = rng(seed)
  const n = r() < 0.2 ? Math.floor(r() * 4) : Math.floor(r() * 30)
  const scale = [1, 1, 10, 1e-6, 1e6, 1e150][Math.floor(r() * 6)]!
  const out: TrailItem[] = []
  for (let i = 0; i < n; i++) {
    const it: TrailItem = { x: (r() - 0.5) * 300 * scale, y: (r() - 0.5) * 300 * scale, size: r() < 0.1 ? undefined : r() * 20 * (r() < 0.1 ? 1e-9 : 1) }
    const prev = out[i - 1]
    if (prev && r() < 0.25) { it.x = prev.x; it.y = prev.y } // a repeated point: a full circle
    if (prev && r() < 0.1) { it.x = prev.x; it.y = (prev.y ?? 0) + 1e-9 } // a segment of vanishing length
    if (r() < 0.12) it.defined = false
    const u = r()
    if (u < 0.02) it.size = 0
    else if (u < 0.03) it.size = NaN
    else if (u < 0.04) it.size = -2 // a negative radius: both refuse alike
    else if (u < 0.05) it.x = NaN
    else if (u < 0.06) it.y = Infinity
    else if (u < 0.07) it.size = Infinity
    else if (u < 0.08) it.size = 5e-324 // a radius that underflows to 0
    out.push(it)
  }
  return out
}

describe('generated trail differential (the path writer\'s arcs)', () => {
  it('trailPath is vega\'s trail path, flag for flag, over random runs, gaps, repeats and bad sizes', () => {
    // a fresh generator per set: vega's keeps its buffer after a throw (a negative radius) and would draw into it
    const oracleOf = () => (vega as unknown as { pathTrail: () => any }).pathTrail()
      .x((d: TrailItem) => d.x || 0).y((d: TrailItem) => d.y || 0).size((d: TrailItem) => d.size || 1).defined((d: TrailItem) => d.defined !== false)
    let drawn = 0
    for (let i = 0; i < 1500; i++) {
      const seed = 0x7a11 + i * 104729
      const items = trailItems(seed)
      const want = exact(() => oracleOf()(items) ?? '')
      if (typeof want === 'string' && want.includes('A')) drawn++
      compare(`trail set#${i}`, seed, () => want, () => trailPath(items as never))
    }
    expect(drawn).toBeGreaterThan(300)
  })
})

describe('resolveCurve is vega\'s curve choice', () => {
  const pts = [[0, 0], [10, 14], [20, 3], [30, 3], [40, 20], [55, 8]].map(([x, y]) => ({ x: x!, y: y!, x0: x!, x1: x!, y0: 0, y1: y!, live: true }))
  const names: unknown[] = [undefined, '', 'linear', 'monotone', 'monotone-x', 'bundle', 'cardinal', 'cardinal-open', 'catmull-rom', 'catmull-rom-closed', 'step-after', 'natural', 'basis-open',
    'nonsense', 'constructor', '__proto__', 'toString', 5]
  const orients = [undefined, 'vertical', 'horizontal']
  const tensions: unknown[] = [undefined, null, 0, 0.3, 1, '0.7', NaN]
  // (where vega's lookup finds nothing it would crash on a null curve; Aster draws the linear curve instead)
  it('every interpolate x orient x tension draws what vega\'s pathCurves draws', () => {
    // Aster also takes `monotone-x` / `monotone-y` (the old engine did; vega's table has only `monotone`)
    const aliases: Record<string, unknown> = { 'monotone-x': d3Shape.curveMonotoneX, 'monotone-y': d3Shape.curveMonotoneY }
    const pathCurves = (vega as unknown as { pathCurves: (t: unknown, o: unknown, k: unknown) => any }).pathCurves
    for (const name of names) for (const orient of orients) for (const tension of tensions) {
      const want = exact(() => d3Shape.line<Pt>().x((p) => p.x).y((p) => p.y).curve(pathCurves(name || 'linear', orient, tension) ?? (Object.hasOwn(aliases, name as string) ? aliases[name as string] : undefined) ?? d3Shape.curveLinear).digits(null)(pts))
      const got = exact(() => aster.linePath(aster.resolveCurve(name as never, orient, tension as never), cols(pts, (p) => p.x), cols(pts, (p) => p.y), null, null))
      expect({ name, orient, tension, got }).toEqual({ name, orient, tension, got: want })
    }
  })
})

describe('the one known area divergence', () => {
  it('d3 throws for an area with a bundle curve (beta != 1), which is why the area oracle above adds no-op hooks', () => {
    const pts = sets.find((p) => p.filter((q) => q.live).length >= 2)!
    const s: Spec = { variant: { d3: 'curveBundle', name: 'bundle', param: 'beta', p: 0.5 }, pts, digits: 3 }
    expect(() => d3Area('x/y0/y1').defined((p) => p.live).curve(d3Curve(s.variant))(pts)).toThrow(/areaStart is not a function/)
    expect(typeof asterAreaD(s, 'x/y0/y1')).toBe('string')
  })
})

describe('generated corpus coverage', () => {
  it('actually contains the corner cases it claims', () => {
    const sizes = new Set(sets.map((p) => p.length))
    for (const n of [0, 1, 2, 3, 4]) expect(sizes.has(n)).toBe(true)
    expect(sets.some((p) => p.some((q) => !q.live) && p.some((q) => q.live))).toBe(true)
    expect(sets.some((p) => p.some((q, i) => i > 0 && q.x === p[i - 1]!.x && q.y === p[i - 1]!.y))).toBe(true)
    expect(sets.some((p) => p.some((q) => Math.abs(q.x) > 1e100))).toBe(true)
    expect(sets.some((p) => p.some((q) => q.x !== 0 && Math.abs(q.x) < 1e-100))).toBe(true)
    expect(sets.some((p) => p.some((q) => Number.isNaN(q.x) || !Number.isFinite(q.y)))).toBe(true)
  })
})
