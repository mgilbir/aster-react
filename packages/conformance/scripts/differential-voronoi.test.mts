/**
 * LIVE generated differential for the `voronoi` transform (vega-voronoi on d3-delaunay 6 on delaunator 5 on
 * robust-predicates): random point sets of every shape that stresses a triangulation (scattered, integer lattices,
 * collinear along a diagonal / row / column / slope, all points equal, repeated points, cocircular, near-collinear,
 * near-duplicate, 0 to 3 points, huge and tiny coordinates, mixed magnitudes, points outside and on the boundary of the
 * extent, text and null coordinates), under `size`, `extent` (including empty and inverted ones) and the default
 * extent, go through a real vega View and through Aster's `applyTransforms`. The path of every cell must be the same
 * string, character for character: the cell's vertices come from the same floating point operations in the same order.
 * A rectangle the reference refuses ("invalid bounds") must be refused alike.
 */
import { describe, expect, it, vi } from 'vitest'
import * as vega from 'vega'
import '../../core/src/addon-transforms.ts'
import { applyTransforms } from '../../core/src/transform.ts'
import { quietLogger } from './differential-util.mts'
import { seeded } from './upstream.mts'
import { MODES, hostilePoints, points, type Row } from './voronoi-cases.mts'

// generated differentials are heavy; a loaded machine must not turn them into timeouts
vi.setConfig({ testTimeout: 120_000 })

const runtime: any = { scale: () => undefined, data: () => [], expr: () => { throw new Error('no expressions here') } }

function asterPaths(rows: Row[], transform: Record<string, unknown>): unknown {
  try {
    const out = applyTransforms(structuredClone(rows) as never, [structuredClone(transform)] as never, { runtime, signals: Object.create(null), datasets: () => undefined, hierarchies: new Map() } as never, 'src')
    return out.map((r: Record<string, unknown>) => r[(transform.as as string | undefined) ?? 'path'])
  } catch (e) {
    return 'ERR ' + (e as Error).message
  }
}

async function vegaPaths(rows: Row[], transform: Record<string, unknown>): Promise<unknown> {
  const errors: unknown[][] = []
  const logger = quietLogger(errors) as never
  const view = new vega.View(vega.parse({ data: [{ name: 'src', values: structuredClone(rows), transform: [structuredClone(transform)] }] } as never), { renderer: 'none', logger })
  view.logger(logger)
  await view.runAsync()
  // the dataflow logs an operator's error and goes on; the reference then holds the rows without the field
  const failure = errors.find((e) => e[0] instanceof Error)
  const out = failure ? 'ERR ' + (failure[0] as Error).message : view.data('src').map((r: Record<string, unknown>) => r[(transform.as as string | undefined) ?? 'path'])
  view.finalize()
  return out
}

function transformOf(r: ReturnType<typeof seeded>): Record<string, unknown> {
  const as = r.int(5) === 0 ? { as: 'cell' } : {}
  return r.pick<Record<string, unknown>>([
    { type: 'voronoi', x: 'x', y: 'y', size: [200, 150], ...as },
    { type: 'voronoi', x: 'x', y: 'y', size: [200, 150], ...as },
    { type: 'voronoi', x: 'x', y: 'y', extent: [[-10, -10], [210, 160]], ...as },
    { type: 'voronoi', x: 'x', y: 'y', extent: [[20, 30], [60, 50]], ...as },
    { type: 'voronoi', x: 'x', y: 'y', size: [1, 1], ...as },
    { type: 'voronoi', x: 'x', y: 'y', ...as },
  ])
}

describe('voronoi vs vega-voronoi (generated)', () => {
  for (const [m, mode] of MODES.entries()) {
    it(`${mode} point sets give the same cells`, async () => {
      const r = seeded(777 + m * 101)
      let withCells = 0
      for (let i = 0; i < 120; i++) {
        const k = r.pick([0, 1, 2, 3, 3, 4, 5, 8, 20, 60])
        const rows = points(r, mode, k)
        const transform = transformOf(r)
        const want = await vegaPaths(rows, transform)
        const got = asterPaths(rows, transform)
        expect(got, JSON.stringify({ mode, rows, transform })).toEqual(want)
        if (Array.isArray(want)) for (const p of want) if (p !== null) withCells++
      }
      // the cases must produce cells (a comparison of all-null paths proves nothing)
      expect(withCells).toBeGreaterThan(60)
    })
  }

  it('every size of point set from 0 to 40, in several shapes', async () => {
    const r = seeded(31)
    for (let k = 0; k <= 40; k++) {
      for (const mode of ['scattered', 'integers', 'cocircular', 'diagonal', 'repeated'] as const) {
        const rows = points(r, mode, k)
        const transform = { type: 'voronoi', x: 'x', y: 'y', size: [200, 150] }
        expect(asterPaths(rows, transform), `${mode} ${k}`).toEqual(await vegaPaths(rows, transform))
      }
    }
  })

  it('extents: empty, thin, inverted, not numbers, infinite', async () => {
    const r = seeded(8)
    const extents: Array<Record<string, unknown>> = [
      { size: [0, 0] }, { size: [0, 150] }, { size: [100, 0] }, { extent: [[5, 5], [5, 5]] }, { extent: [[5, 0], [5, 100]] },
      { extent: [[10, 0], [0, 10]] }, { extent: [[0, 10], [10, 0]] }, { extent: [[0, 0], [NaN, 10]] }, { extent: [[0, 0], [Infinity, 150]] },
      { extent: [[-Infinity, -Infinity], [Infinity, Infinity]] }, { extent: [[0, 0], [1e-9, 1e-9]] }, { extent: [[-1e12, -1e12], [1e12, 1e12]] },
    ]
    let refused = 0
    for (const extent of extents) {
      for (const mode of ['scattered', 'integers', 'diagonal', 'equal', 'boundary'] as const) {
        for (const k of [1, 2, 3, 7, 20]) {
          const rows = points(r, mode, k)
          const transform = { type: 'voronoi', x: 'x', y: 'y', ...extent }
          const want = await vegaPaths(rows, transform)
          expect(asterPaths(rows, transform), JSON.stringify({ mode, rows, extent })).toEqual(want)
          if (typeof want === 'string') refused++
        }
      }
    }
    expect(refused).toBeGreaterThan(50)
  })

  it('a few points with missing or non-numeric coordinates give the same cells (sets that end in the reference)', async () => {
    // the reference loops forever on some such inputs, so only small fixed sets, which it finishes, are compared
    const r = seeded(555)
    let garbage = 0
    for (let i = 0; i < 400; i++) {
      const rows: Row[] = Array.from({ length: 1 + r.int(4) }, () => ({
        x: r.int(3) === 0 ? r.pick([NaN, 'a', undefined]) : r.next() * 50,
        y: r.int(4) === 0 ? r.pick([NaN, undefined]) : r.next() * 50,
      }))
      const transform = { type: 'voronoi', x: 'x', y: 'y', size: [100, 100] }
      const want = await vegaPaths(rows, transform)
      expect(asterPaths(rows, transform), JSON.stringify(rows)).toEqual(want)
      if (Array.isArray(want) && want.some((p) => typeof p === 'string' && /NaN|^M,/.test(p))) garbage++
    }
    expect(garbage).toBeGreaterThan(50)
  })

  it('coordinates that are not numbers, or are beyond 1e150, still end, with one result per row', () => {
    // vega loops forever on some of these, and past about 1e150 its orientation test overflows and answers arbitrarily
    // (Aster's is exact, see orient.ts), so only the shape of the result can be compared
    const r = seeded(99)
    for (let i = 0; i < 600; i++) {
      const rows = hostilePoints(r, r.pick([1, 2, 3, 5, 8, 20, 60]))
      const out = asterPaths(rows, transformOf(r)) as unknown[]
      expect(out, JSON.stringify(rows)).toHaveLength(rows.length)
    }
  })

  it('a larger scattered set (2000 points) gives the same cells', async () => {
    const r = seeded(4)
    const rows = points(r, 'scattered', 2000)
    const transform = { type: 'voronoi', x: 'x', y: 'y', size: [200, 150] }
    const want = (await vegaPaths(rows, transform)) as unknown[]
    expect(want.filter((p) => p !== null).length).toBeGreaterThan(1900)
    expect(asterPaths(rows, transform)).toEqual(want)
  })
})
