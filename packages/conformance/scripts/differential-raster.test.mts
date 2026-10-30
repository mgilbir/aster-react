/**
 * LIVE, generated differential for the raster-grid layer: marching-squares contours, `kde2d`, `isocontour`, `contour`
 * and `heatmap`. Each runs on random inputs through the pinned real library (d3-contour 4.0.2 for the contour module,
 * vega-geo 5.1.2 through vega 6.3.1 for the transforms) and through Aster, in this process, and the results are
 * compared strictly: ring coordinates and orientation, grid values bit for bit (Float32), pixel bytes, thrown errors.
 *
 * The inputs are drawn from a seeded generator so a failure replays. Edge cases are in the draw on purpose: ties and
 * flat fields (saddles), NaN / +-Infinity / null / undefined / string cells, grids shorter than their size, unsorted and
 * invalid thresholds, empty and fractional sizes, flipped and translated scales, per-axis and zero bandwidths.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as vega from 'vega'
import * as d3Contour from 'd3-contour'
import { applyTransforms, compileExpr, type Row } from '../../core/src/index.ts'
import '../../core/src/addon-transforms.ts'
import '../../core/src/addon-geo.ts'
import { contourPolygons } from '../../core/src/contour.ts'
import { enc, exact } from './differential-util.mts'

// ---------------------------------------------------------------------------------------------------- generator

function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
type Rng = () => number
const pick = <T,>(r: Rng, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!
const int = (r: Rng, lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1))
const chance = (r: Rng, p: number): boolean => r() < p

// ------------------------------------------------------------------------------------------------ contour module

type Cell = number | null | undefined | string

/** A grid of w*h cells: a smooth field, a coarse tie-heavy one, or noise; some cells replaced by odd values. */
function randomGrid(r: Rng, w: number, h: number, odd: boolean): { values: Cell[]; pool: number[] } {
  const kind = int(r, 0, 3)
  const values: Cell[] = []
  const bumps = Array.from({ length: int(r, 1, 4) }, () => ({ cx: r() * w, cy: r() * h, s: 0.5 + r() * Math.max(w, h) / 3, a: r() * 2 - 0.5 }))
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v: number
      if (kind === 0) v = bumps.reduce((s, b) => s + b.a * Math.exp(-((x - b.cx) ** 2 + (y - b.cy) ** 2) / (2 * b.s * b.s)), 0)
      else if (kind === 1) v = int(r, 0, 3) // ties and saddles
      else if (kind === 2) v = r() * 4 - 2
      else v = Math.sin(x * 0.9) * Math.cos(y * 0.7) + (y % 3 === 0 ? 0.5 : 0)
      values.push(v)
    }
  }
  if (odd) {
    const odds: Cell[] = [NaN, Infinity, -Infinity, null, undefined, '1', 'x', -0, 0]
    for (let i = 0; i < values.length; i++) if (chance(r, 0.08)) values[i] = pick(r, odds)
    if (chance(r, 0.3)) values.length = Math.max(0, values.length - int(r, 1, Math.max(1, w + 2))) // shorter than the size
  }
  const pool = values.filter((v): v is number => typeof v === 'number' && isFinite(v))
  return { values, pool }
}

function randomThresholds(r: Rng, pool: number[], odd: boolean): unknown[] {
  const n = int(r, 0, 5)
  const out: unknown[] = []
  for (let i = 0; i < n; i++) {
    const base = pool.length ? pick(r, pool) : 0
    out.push(pick(r, [base, base + 0.25, base - 0.25, 0, 1, 0.5, 1.5, 2]))
  }
  if (odd && chance(r, 0.5)) out.push(pick(r, [NaN, null, undefined, '0.5', Infinity, -Infinity]))
  return out
}

// d3-contour and vega-geo's own marching squares agree on a grid of numbers and ascending numeric thresholds, and differ where
// the input is odd: d3-contour sorts the thresholds, throws on a non-numeric one, ranks a null / NaN / undefined cell below every
// level and smooths around infinite cells; vega-geo keeps the order given and compares and interpolates the raw values as
// JavaScript does. Aster follows vega (the oracle of the product), so this d3 comparison draws only what the two share and the
// "contour of a value grid" section further down compares the odd inputs with vega itself.
const CONTOUR_CASES = 1500
describe(`d3-contour 4.0.2 vs Aster contour module (${CONTOUR_CASES} generated cases)`, () => {
  const r = prng(0xc0a7)
  for (let i = 0; i < CONTOUR_CASES; i++) {
    const big = i % 5 === 0
    const odd = false
    const w = big ? int(r, 12, 48) : int(r, 0, 9)
    const h = big ? int(r, 12, 40) : int(r, 0, 9)
    const { values, pool } = randomGrid(r, w, h, odd)
    const thresholds = (randomThresholds(r, pool, odd) as number[]).sort((a, b) => a - b)
    const smooth = chance(r, 0.6)
    const typed = !odd && chance(r, 0.5)
    // a size that need not match the grid: fractional, negative, NaN
    const size: [number, number] = chance(r, 0.04) ? [pick(r, [-1, NaN, Math.max(0, w - 1) + 0.7]), h] : chance(r, 0.15) ? [Math.max(0, w - int(r, 0, 2)), Math.max(0, h - int(r, 0, 2))] : [w + (chance(r, 0.1) ? 0.6 : 0), h]
    it(`#${i} ${w}x${h} size=${size} smooth=${smooth} ${typed ? 'f32' : 'array'} t=${JSON.stringify(thresholds)}`, () => {
      const cells = typed ? new Float32Array(values as number[]) : values
      const want = exact(() => d3Contour.contours().smooth(smooth).size(size).thresholds(thresholds as number[])(structuredClone(cells) as number[]))
      const got = exact(() => contourPolygons(structuredClone(cells) as number[], thresholds as number[], size, smooth))
      expect(got).toEqual(want)
    })
  }
})

// ---------------------------------------------------------------------------------------------- vega transforms

type Params = Record<string, unknown>
const runtime = { scale: () => undefined, data: () => [], expr: (e: string) => compileExpr(e, runtime as never) }

/** A canvas as Node lacks one: vega-canvas finds `document`, vega-geo's heatmap writes its pixels into the buffer. */
type FakeCanvas = { width: number; height: number; pix?: Uint8ClampedArray; getContext(): unknown }
function fakeDocument() {
  return {
    createElement(): FakeCanvas {
      const c: FakeCanvas = {
        width: 0, height: 0,
        getContext() {
          return {
            getImageData: (_x: number, _y: number, w: number, h: number) => (c.pix = new Uint8ClampedArray(4 * w * h), { data: c.pix }),
            putImageData() {},
          }
        },
      }
      return c
    },
  }
}

type Outcome = { rows: unknown[] } | { error: string }

async function viaVega(rows: Row[], transform: Params[]): Promise<Outcome> {
  const errors: string[] = []
  try {
    const view = new vega.View(vega.parse({ data: [{ name: 'src', values: structuredClone(rows), transform: structuredClone(transform) }] } as vega.Spec), { renderer: 'none', logLevel: vega.None })
    view.logger({
      level() { return 1 },
      error(...a: unknown[]) { errors.push(a.map((x) => (x as Error)?.message || String(x)).join(' ')); return this },
      warn() { return this }, info() { return this }, debug() { return this },
    } as unknown as vega.LoggerInterface)
    await view.runAsync()
    if (errors.length) return { error: errors[0]!.replace(/^Error: /, '') }
    return { rows: view.data('src') ?? [] } // (an empty, never-run dataset reads back undefined)
  } catch (e) {
    return { error: (e as Error).message }
  }
}

function viaAster(rows: Row[], transform: Params[]): Outcome {
  try {
    const ctx = { runtime, signals: Object.create(null), datasets: () => undefined, hierarchies: new Map() }
    return { rows: applyTransforms(structuredClone(rows), structuredClone(transform) as never, ctx as never, 'src') }
  } catch (e) {
    return { error: (e as Error).message }
  }
}

/** Heatmap images become their bytes on both sides. */
function flatten(rows: unknown[]): unknown[] {
  return rows.map((row) => {
    const o: Record<string, unknown> = { ...(row as object) }
    for (const k of Object.keys(o)) {
      const v = o[k] as { width?: number; height?: number; pix?: Uint8ClampedArray; pixels?: Uint8ClampedArray } | undefined
      if (v && typeof v === 'object' && (v.pix || v.pixels)) o[k] = { image: [v.width, v.height], bytes: Array.from((v.pix ?? v.pixels)!) }
    }
    return o
  })
}

async function same(label: string, rows: Row[], transform: Params[]): Promise<void> {
  const want = await viaVega(rows, transform)
  const got = viaAster(rows, transform)
  if ('error' in want) {
    expect('error' in got ? got.error : 'no error', label).toContain(want.error)
    return
  }
  expect('error' in got ? got.error : null, label).toBeNull()
  const a = enc(flatten((got as { rows: unknown[] }).rows))
  const b = enc(flatten(want.rows))
  const d = firstDifference(a, b)
  if (d) expect.fail(`${label}: Aster differs from Vega at ${d}`)
}

/** The path of the first difference between two `enc` images (the full toEqual diff of a grid is unreadable). */
function firstDifference(a: unknown, b: unknown, path = '$'): string | null {
  if (Object.is(a, b)) return null
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${path}.length ${a.length} vs ${b.length}`
    for (let i = 0; i < a.length; i++) { const d = firstDifference(a[i], b[i], `${path}[${i}]`); if (d) return d }
    return null
  }
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const ka = Object.keys(a).sort()
    const kb = Object.keys(b).sort()
    if (ka.join() !== kb.join()) return `${path} keys [${ka}] vs [${kb}]`
    for (const k of ka) { const d = firstDifference((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`); if (d) return d }
    return null
  }
  return `${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`
}

function randomPoints(r: Rng, w: number, h: number, groups: boolean): Row[] {
  const n = pick(r, [0, 1, 2, 5, 20, 60, 150])
  const rows: Row[] = []
  for (let i = 0; i < n; i++) {
    const row: Row = { x: r() * (w + 20) - 10, y: r() * (h + 20) - 10, w: r() * 3, g: pick(r, ['a', 'b', 'c']) }
    if (chance(r, 0.04)) row.x = pick(r, [NaN, 'q'])
    if (chance(r, 0.04)) row.w = pick(r, [-1, 0, null])
    if (!groups) delete row.g
    rows.push(row)
  }
  return rows
}

function kdeParams(r: Rng): { t: Params; w: number; h: number; groups: boolean } {
  const w = int(r, 1, 70)
  const h = int(r, 1, 50)
  const groups = chance(r, 0.4)
  const t: Params = { type: 'kde2d', size: [w, h], x: chance(r, 0.7) ? 'x' : { expr: 'datum.x' }, y: chance(r, 0.7) ? 'y' : { expr: 'datum.y' } }
  const cell = pick(r, [undefined, 1, 2, 4, 8, 3])
  if (cell !== undefined) t.cellSize = cell
  const bw = pick(r, [undefined, [-1, -1], [0, 0], [1, 1], [3, 3], [7, 7], [12, 12], [2, 5], [0, 4], [6, 0], [-1, 3]])
  if (bw !== undefined) t.bandwidth = bw
  if (chance(r, 0.5)) t.counts = true
  if (chance(r, 0.4)) t.weight = chance(r, 0.5) ? 'w' : { expr: 'datum.w * 2' }
  if (groups) t.groupby = ['g']
  if (chance(r, 0.15)) t.as = 'dens'
  return { t, w, h, groups }
}

const KDE_CASES = 160
const ISO_CASES = 160
const CONTOUR_TX_CASES = 160
const HEAT_CASES = 120

describe('vega-geo 5.1.2 (vega 6.3.1) vs Aster raster transforms (generated, live)', { timeout: 120_000 }, () => {
  describe('kde2d', () => {
    const r = prng(0x2dde)
    for (let i = 0; i < KDE_CASES; i++) {
      const { t, w, h, groups } = kdeParams(r)
      const rows = randomPoints(r, w, h, groups)
      it(`#${i} ${JSON.stringify(t)} n=${rows.length}`, async () => {
        await same('kde2d', rows, [t])
      })
    }
  })

  describe('kde2d -> isocontour', () => {
    const r = prng(0x150c)
    for (let i = 0; i < ISO_CASES; i++) {
      const { t, w, h, groups } = kdeParams(r)
      const as = (t.as as string | undefined) ?? 'grid'
      const iso: Params = { type: 'isocontour', field: as }
      if (chance(r, 0.6)) iso.levels = int(r, 1, 12)
      if (chance(r, 0.3)) iso.nice = true
      if (chance(r, 0.3)) iso.zero = chance(r, 0.5)
      if (chance(r, 0.3)) iso.resolve = 'shared'
      if (chance(r, 0.3)) iso.smooth = false
      if (chance(r, 0.25)) iso.thresholds = [0.0005, 0.002, chance(r, 0.5) ? 0.001 : 0.01].sort((a, b) => a - b).slice(0, int(r, 0, 3))
      if (chance(r, 0.4)) iso.scale = pick(r, [2, -1, [1, -1], [3, 2], [-2, 2]])
      if (chance(r, 0.4)) iso.translate = pick(r, [[5, 7], [-3, 0], [0, 0]])
      if (chance(r, 0.2)) iso.as = pick(r, ['c', null])
      const rows = randomPoints(r, w, h, groups)
      it(`#${i} ${JSON.stringify([t, iso])} n=${rows.length}`, async () => {
        await same('isocontour', rows, [t, iso])
      })
    }
  })

  describe('contour', () => {
    const r = prng(0xc07)
    for (let i = 0; i < CONTOUR_TX_CASES; i++) {
      const w = int(r, 1, 70)
      const h = int(r, 1, 50)
      const t: Params = { type: 'contour', size: [w, h] }
      let rows: Row[]
      if (chance(r, 0.2)) {
        const gw = int(r, 1, 12)
        const gh = int(r, 1, 12)
        t.size = [gw, gh]
        t.values = randomGrid(r, gw, gh, false).values
        t.thresholds = [-1, 0, 0.5, 1, 2].slice(0, int(r, 1, 5))
        rows = [{ a: 1 }]
      } else {
        t.x = 'x'
        t.y = 'y'
        rows = randomPoints(r, w, h, false)
        const cell = pick(r, [undefined, 1, 2, 4, 8])
        if (cell !== undefined) t.cellSize = cell
        const bw = pick(r, [undefined, [-1, -1], [0, 0], [2, 2], [5, 5], [9, 9], [2, 5], [0, 4], [6, 0]])
        if (bw !== undefined) t.bandwidth = bw
        if (chance(r, 0.4)) t.weight = 'w'
      }
      if (chance(r, 0.5)) t.count = int(r, 1, 12)
      if (chance(r, 0.3)) t.nice = true
      if (chance(r, 0.3)) t.smooth = false
      if (!t.values && chance(r, 0.25)) t.thresholds = [0.0005, 0.002, 0.01, 1].slice(0, int(r, 0, 4))
      it(`#${i} ${JSON.stringify(t)} n=${rows.length}`, async () => {
        await same('contour', rows, [t])
      })
    }
  })

  describe('kde2d -> heatmap', () => {
    const globals = globalThis as unknown as { document?: unknown }
    beforeAll(() => { globals.document = fakeDocument() })
    afterAll(() => { delete globals.document })
    const r = prng(0x4ea7)
    for (let i = 0; i < HEAT_CASES; i++) {
      const { t, w, h, groups } = kdeParams(r)
      const heat: Params = { type: 'heatmap', field: (t.as as string | undefined) ?? 'grid' }
      const color = pick(r, [undefined, '#e0aa10', 'steelblue', { expr: "rgb(255 * datum.$value / datum.$max, datum.$x * 4, 120)" }, { expr: "datum.g == 'a' ? '#f00' : '#00f'" }, { expr: "hsl(200, 1, datum.$y / 100)" }])
      if (color !== undefined) heat.color = color
      const opacity = pick(r, [undefined, 0.5, 1, 0, { expr: 'datum.$value / datum.$max * 0.8' }, { expr: '0.25' }, { expr: 'datum.$x > 5 ? 1 : 0.1' }])
      if (opacity !== undefined) heat.opacity = opacity
      if (chance(r, 0.4)) heat.resolve = 'shared'
      if (chance(r, 0.2)) heat.as = 'img'
      const rows = randomPoints(r, w, h, groups)
      it(`#${i} ${JSON.stringify([t, heat])} n=${rows.length}`, async () => {
        await same('heatmap', rows, [t, heat])
      })
    }
  })
})

// ------------------------------------------------------------------------------- the parameter space, generated
//
// Everything above draws "sensible" parameters with a few odd cells. The sections below draw from the whole space a spec
// author can reach -- scalar and short and long bandwidths, `scale: 0`, unsorted and repeated and non-numeric thresholds,
// null / NaN / string / missing cells and coordinates, `zero` with and without explicit thresholds -- and compare the
// outcome with vega's: the rows when it produces them, the message when it refuses.

const ODD_CELLS: Cell[] = [NaN, null, undefined, Infinity, -Infinity, '1', '2.5', 'x', '', -0, 0]
// (no `undefined` here: vega leaves a hole in its output for an undefined entry of a list parameter, which no JSON spec can write)
const ODD_LEVELS: unknown[] = [NaN, null, '0.5', '2', Infinity, -Infinity, 0, true]

/** A hand-made grid as the isocontour transform reads one: cells, size and the window/scale a density grid carries. */
function handGrid(r: Rng, odd: boolean): Record<string, unknown> {
  const width = int(r, 1, 8)
  const height = int(r, 1, 8)
  const { values } = randomGrid(r, width, height, false)
  const cells: Cell[] = values.slice()
  if (odd) for (let i = 0; i < cells.length; i++) if (chance(r, 0.15)) cells[i] = pick(r, ODD_CELLS)
  const grid: Record<string, unknown> = { width, height, values: !odd && chance(r, 0.4) ? new Float32Array(cells as number[]) : cells }
  if (chance(r, 0.6)) Object.assign(grid, { scale: pick(r, [1, 2, 4, 0, -1]), x1: int(r, 0, 2), y1: int(r, 0, 2) })
  if (chance(r, 0.4)) grid.translate = pick(r, [[1, 2], [0, 0], [-3, 4]])
  if (chance(r, 0.15)) { grid.x2 = width; grid.y2 = height }
  return grid
}

function pointsWith(r: Rng, n: number, odd: boolean): Row[] {
  const rows: Row[] = []
  for (let i = 0; i < n; i++) {
    const row: Row = { x: 5 + r() * 40, y: 5 + r() * 30, w: 0.5 + r() * 2, g: pick(r, ['a', 'b', null]) }
    if (odd) {
      for (const f of ['x', 'y', 'w']) if (chance(r, 0.12)) row[f] = pick(r, [null, undefined, NaN, '', '7', 'q', -3, Infinity])
      if (chance(r, 0.05)) delete row.x
    }
    rows.push(row)
  }
  return rows
}

describe('vega-geo contour/isocontour/kde2d over the whole parameter space (generated, live)', { timeout: 300_000 }, () => {
  describe('contour of a value grid: thresholds, cells, smoothing', () => {
    const r = prng(0x7a11)
    for (let i = 0; i < 400; i++) {
      const w = int(r, 0, 9)
      const h = int(r, 0, 9)
      const { values, pool } = randomGrid(r, w, h, chance(r, 0.6))
      if (chance(r, 0.4)) for (let c = 0; c < values.length; c++) if (chance(r, 0.1)) values[c] = pick(r, ODD_CELLS)
      const t: Params = { type: 'contour', size: pick(r, [[w, h], [w, h], [w + 0.7, h], [w + 1, h - 1], [-1, h], [NaN, 2]]), values }
      if (chance(r, 0.8)) {
        const n = int(r, 0, 5)
        const base = pool.length ? pool : [0.5]
        t.thresholds = Array.from({ length: n }, () => (chance(r, 0.12) ? pick(r, ODD_LEVELS) : pick(r, base) + pick(r, [0, 0.25, -0.25, 1])))
        if (chance(r, 0.3)) (t.thresholds as unknown[]).push(...(t.thresholds as unknown[]).slice(0, 2)) // repeats, in no particular order
      } else {
        if (chance(r, 0.6)) t.count = int(r, 0, 9)
        if (chance(r, 0.3)) t.nice = true
      }
      if (chance(r, 0.3)) t.smooth = false
      if (chance(r, 0.05)) delete t.size // required
      const rows: Row[] = [{ a: 1 }]
      it(`#${i} ${JSON.stringify(enc(t))}`, async () => { await same('contour values', rows, [t]) })
    }
  })

  describe('contour of points: bandwidth, cell size, coordinates', () => {
    const r = prng(0x7a12)
    const BW: unknown[] = [undefined, 3, 0, -1, '4', 'x', null, [], [3], [0], [-1], [2, 5], [0, 4], [null, 3], [NaN, 3], ['3', 3], [1, 2, 3], [undefined]]
    for (let i = 0; i < 300; i++) {
      const t: Params = { type: 'contour', size: [int(r, 10, 60), int(r, 10, 50)], x: 'x', y: 'y' }
      const bw = pick(r, BW)
      if (bw !== undefined) t.bandwidth = bw
      const cell = pick(r, [undefined, 1, 2, 4, 3, 0.5, 0, '2', -2, NaN])
      if (cell !== undefined) t.cellSize = cell
      if (chance(r, 0.4)) t.weight = 'w'
      if (chance(r, 0.5)) t.count = int(r, 1, 9)
      if (chance(r, 0.3)) t.nice = true
      if (chance(r, 0.25)) t.thresholds = [0.0005, 0.002, 0.00001, 0.002].slice(0, int(r, 0, 4))
      const rows = pointsWith(r, pick(r, [0, 1, 3, 12, 60]), chance(r, 0.6))
      it(`#${i} ${JSON.stringify(enc(t))} n=${rows.length}`, async () => { await same('contour points', rows, [t]) })
    }
  })

  describe('kde2d: bandwidth forms, size, cell size, null / NaN / string coordinates', () => {
    const r = prng(0x7a13)
    const BW: unknown[] = [undefined, 3, 0, -1, '4', null, [], [3], [0], [-1], [2, 5], [0, 4], [null, 3], [NaN, 3], ['3', 3], [1, 2, 3], [-1, -1], [undefined, 2]]
    for (let i = 0; i < 400; i++) {
      const t: Params = { type: 'kde2d', size: pick(r, [[40, 30], [40, 30], ['40', 30], [0, 0], [-1, 5], [NaN, 5], [7.5, 9.2]]), x: pick(r, ['x', { expr: 'datum.x' }]), y: pick(r, ['y', { expr: 'datum.y' }]) }
      const bw = pick(r, BW)
      if (bw !== undefined) t.bandwidth = bw
      const cell = pick(r, [undefined, 1, 2, 4, 3, 0.5, 0, '2', -2])
      if (cell !== undefined) t.cellSize = cell
      if (chance(r, 0.4)) t.weight = pick(r, ['w', { expr: 'datum.w * 2' }])
      if (chance(r, 0.5)) t.counts = chance(r, 0.5)
      if (chance(r, 0.4)) t.groupby = pick(r, [['g'], ['g', 'g']])
      if (chance(r, 0.08)) delete t[pick(r, ['size', 'x', 'y'])] // a required parameter left out
      const rows = pointsWith(r, pick(r, [0, 1, 2, 5, 40]), chance(r, 0.7))
      it(`#${i} ${JSON.stringify(enc(t))} n=${rows.length}`, async () => { await same('kde2d', rows, [t]) })
    }
  })

  describe('isocontour of hand-made grids: scale, translate, levels, zero, thresholds, cells', () => {
    const r = prng(0x7a14)
    for (let i = 0; i < 500; i++) {
      const rows: Row[] = Array.from({ length: int(r, 0, 3) }, () => ({ id: int(r, 0, 9), grid: handGrid(r, chance(r, 0.5)) }))
      const t: Params = { type: 'isocontour', field: 'grid' }
      if (chance(r, 0.7)) t.levels = pick(r, [1, 2, 3, 5, 0, '4', null, 2.5])
      if (chance(r, 0.4)) t.nice = chance(r, 0.7)
      if (chance(r, 0.5)) t.zero = pick(r, [true, false, 0, null])
      if (chance(r, 0.4)) t.resolve = pick(r, ['shared', 'independent', 'other'])
      if (chance(r, 0.2)) t.smooth = pick(r, [false, 0, null])
      if (chance(r, 0.35)) t.thresholds = pick(r, [[1, 2], [2, 1], [3, 1, 2], [2, 2, 1], [], [0.5, NaN, 1], [1, null], 2, ['1', '2'], [0, 1, 0]])
      if (chance(r, 0.6)) t.scale = pick(r, [0, 1, 2, -1, [0, 0], [1, -1], [0, 2], [2, 0], [3, 2], null, '2', { expr: 'datum.id + 1' }, { expr: '0' }])
      if (chance(r, 0.5)) t.translate = pick(r, [0, null, false, { signal: '0' }, { signal: 'null' }, { signal: '[2, 3]' }, { signal: '5' }, [0, 0], [5, 7], [-3, 0], [null, 4], { expr: '[datum.id, 1]' }])
      if (chance(r, 0.15)) t.as = pick(r, ['c', null, ''])
      it(`#${i} ${JSON.stringify(enc([t, rows.map((x) => (x.grid as { scale?: number }).scale)]))}`, async () => { await same('isocontour', rows, [t]) })
    }
  })

  describe('kde2d -> isocontour: the density grid carries its own scale and window', () => {
    const r = prng(0x7a15)
    for (let i = 0; i < 200; i++) {
      const t: Params = { type: 'kde2d', size: [int(r, 10, 60), int(r, 10, 50)], x: 'x', y: 'y', groupby: ['g'], cellSize: pick(r, [1, 2, 4]) }
      const bw = pick(r, [undefined, [3, 3], [0, 4], [-1, -1]])
      if (bw !== undefined) t.bandwidth = bw
      const iso: Params = { type: 'isocontour', field: 'grid' }
      if (chance(r, 0.7)) iso.scale = pick(r, [0, 1, 2, -1, [0, 3], [3, 0], null])
      if (chance(r, 0.5)) iso.translate = pick(r, [0, [4, 5], [null, 1]])
      if (chance(r, 0.5)) iso.levels = int(r, 1, 6)
      if (chance(r, 0.3)) iso.zero = false
      if (chance(r, 0.3)) iso.resolve = 'shared'
      if (chance(r, 0.3)) iso.thresholds = pick(r, [[0.002, 0.0005], [0.001, 0.001, 0.0001]])
      const rows = pointsWith(r, pick(r, [0, 5, 30, 80]), chance(r, 0.5))
      it(`#${i} ${JSON.stringify(enc([t, iso]))} n=${rows.length}`, async () => { await same('kde2d->isocontour', rows, [t, iso]) })
    }
  })
})

describe('vega-geo heatmap over hand-made grids (generated, live)', { timeout: 300_000 }, () => {
  const globals = globalThis as unknown as { document?: unknown }
  beforeAll(() => { globals.document = fakeDocument() })
  afterAll(() => { delete globals.document })
  const r = prng(0x7a16)
  for (let i = 0; i < 250; i++) {
    const rows: Row[] = Array.from({ length: int(r, 0, 3) }, () => {
      const grid = handGrid(r, chance(r, 0.6))
      if (chance(r, 0.15)) delete grid.values // no cells: every value reads 0
      return { id: int(r, 0, 9), grid }
    })
    const t: Params = { type: 'heatmap', field: 'grid' }
    if (chance(r, 0.5)) t.color = pick(r, ['#e0aa10', 'steelblue', { expr: 'rgb(255 * datum.$value / datum.$max, datum.$x * 20, 120)' }, { expr: 'datum.id > 4 ? "#f00" : "#00f"' }])
    if (chance(r, 0.5)) t.opacity = pick(r, [0.5, 1, 0, null, { expr: 'datum.$value / datum.$max * 0.8' }, { expr: 'datum.$x > 2 ? 1 : 0.1' }])
    if (chance(r, 0.4)) t.resolve = pick(r, ['shared', 'independent'])
    it(`#${i} ${JSON.stringify(enc([t, rows.map((x) => Object.keys(x.grid as object))]))}`, async () => { await same('heatmap grids', rows, [t]) })
  }
})

// ------------------------------------------------------------------------ several wrong parameters at once
//
// vega reports the first problem in the transform's definition order, so the order itself is observable: it only shows when
// two parameters are wrong together (one missing, or a list written as a plain value) and the messages differ. A null list
// reads differently from a number, which is what tells apart two lists that are both wrong.
describe('vega-geo parameter refusals with several problems at once (generated, live)', { timeout: 120_000 }, () => {
  const WRONG: unknown[] = [null, 5, 'abc', { a: 1 }, true]
  const withProblems = (r: Rng, base: Params, required: string[], lists: Record<string, unknown>): Params => {
    const t = { ...base }
    for (const [name, ok] of Object.entries(lists)) {
      const roll = r()
      if (roll < 0.45) t[name] = pick(r, WRONG)
      else if (roll < 0.6) delete t[name]
      else t[name] = ok
    }
    for (const name of required) if (chance(r, 0.5)) delete t[name]
    return t
  }
  const rows: Row[] = [{ x: 3, y: 4, g: 'a', grid: { width: 2, height: 2, values: [0, 1, 2, 3] } }]
  const kinds: Array<[string, (r: Rng) => Params]> = [
    ['kde2d', (r) => withProblems(r, { type: 'kde2d', size: [10, 10], x: 'x', y: 'y' }, ['size', 'x', 'y'], { bandwidth: [2, 2], groupby: ['g'] })],
    ['contour', (r) => withProblems(r, { type: 'contour', size: [2, 2], values: [0, 1, 2, 3] }, ['size'], { size: [2, 2], values: [0, 1, 2, 3], thresholds: [1] })],
    ['isocontour', (r) => withProblems(r, { type: 'isocontour', field: 'grid' }, [], { thresholds: [1], translate: [1, 1] })],
  ]
  for (const [kind, make] of kinds) {
    const r = prng(0x7a17 + kind.length)
    for (let i = 0; i < (kind === 'contour' ? 400 : 150); i++) {
      const t = make(r)
      it(`${kind} #${i} ${JSON.stringify(enc(t))}`, async () => { await same(`${kind} problems`, rows, [t]) })
    }
  }
})
