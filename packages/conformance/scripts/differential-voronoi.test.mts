/**
 * LIVE generated differential for the `voronoi` transform (vega-voronoi on d3-delaunay 6 on delaunator 5): random point
 * sets of every shape that stresses a triangulation (scattered, integer lattices, collinear along a diagonal / row /
 * column, all points equal, repeated points, cocircular, near-collinear, 0 to 3 points, huge and tiny coordinates,
 * mixed magnitudes, points outside and on the boundary of the extent), under `size`, `extent` and the default
 * extent, go through a real vega View and through Aster's `applyTransforms`. The path of every cell must be the same
 * string, character for character: the cell's vertices come from the same floating point operations in the same order.
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import '../../core/src/addon-transforms.ts'
import { applyTransforms } from '../../core/src/transform.ts'
import { seeded } from './upstream.mts'

type Row = { x: unknown; y: unknown }

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
  try {
    const view = new vega.View(vega.parse({ data: [{ name: 'src', values: structuredClone(rows), transform: [structuredClone(transform)] }] } as never), { renderer: 'none', logLevel: vega.None })
    await view.runAsync()
    const out = view.data('src').map((r: Record<string, unknown>) => r[(transform.as as string | undefined) ?? 'path'])
    view.finalize()
    return out
  } catch (e) {
    return 'ERR ' + (e as Error).message
  }
}

const MODES = ['scattered', 'integers', 'lattice', 'diagonal', 'row', 'column', 'oneLine', 'equal', 'repeated', 'cocircular', 'nearCollinear', 'tiny', 'huge', 'mixed', 'outside', 'boundary', 'strings'] as const
type Mode = (typeof MODES)[number]

function points(r: ReturnType<typeof seeded>, mode: Mode, k: number): Row[] {
  const rows: Row[] = []
  const slope = r.pick([0.5, -2, 3, 1 / 3])
  const cx = r.next() * 100
  const cy = r.next() * 100
  for (let j = 0; j < k; j++) {
    switch (mode) {
      case 'scattered': rows.push({ x: r.next() * 200, y: r.next() * 150 }); break
      case 'integers': rows.push({ x: r.int(8), y: r.int(8) }); break
      case 'lattice': rows.push({ x: (j % 4) * 10, y: Math.floor(j / 4) * 10 }); break
      case 'diagonal': rows.push({ x: j * 5, y: j * 5 }); break
      case 'row': rows.push({ x: j * 7.5, y: 40 }); break
      case 'column': rows.push({ x: 40, y: r.int(2) ? j * 3 : 100 - j * 3 }); break
      case 'oneLine': rows.push({ x: j * 3.3, y: 5 + slope * j * 3.3 }); break
      case 'equal': rows.push({ x: 10, y: 20 }); break
      case 'repeated': rows.push({ x: r.int(3) * 20, y: r.int(3) * 20 }); break
      case 'cocircular': { const a = (j / k) * 2 * Math.PI; rows.push({ x: 100 + 50 * Math.cos(a), y: 80 + 50 * Math.sin(a) }); break }
      case 'nearCollinear': rows.push({ x: j * 10, y: j * 10 + (r.next() - 0.5) * 1e-10 }); break
      case 'tiny': rows.push({ x: r.next() * 1e-9, y: r.next() * 1e-9 }); break
      case 'huge': rows.push({ x: (r.next() - 0.5) * 1e12, y: (r.next() - 0.5) * 1e12 }); break
      case 'mixed': rows.push({ x: r.next() * r.pick([1e-6, 1, 1e6, 1e12]), y: r.next() * r.pick([1e-6, 1, 1e6, 1e12]) }); break
      case 'outside': rows.push({ x: r.next() * 600 - 200, y: r.next() * 500 - 200 }); break
      case 'boundary': rows.push({ x: r.pick([0, 200, 100, r.int(200)]), y: r.pick([0, 150, 75, r.int(150)]) }); break
      case 'strings': rows.push({ x: r.pick(['3', 7, null, '0.5', true, [4]]), y: r.pick([2, '9', null, false, '1e1']) }); break
    }
  }
  return rows
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
      let nulls = 0
      for (let i = 0; i < 120; i++) {
        const k = r.pick([0, 1, 2, 3, 3, 4, 5, 8, 20, 60])
        const rows = points(r, mode, k)
        const transform = transformOf(r)
        const want = await vegaPaths(rows, transform)
        const got = asterPaths(rows, transform)
        expect(got, JSON.stringify({ mode, rows, transform })).toEqual(want)
        if (Array.isArray(want)) for (const p of want) p === null ? nulls++ : withCells++
      }
      // the cases must produce cells (a comparison of all-null paths proves nothing)
      expect(withCells).toBeGreaterThan(60)
      expect(nulls).toBeGreaterThanOrEqual(0)
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

  it('a larger scattered set (2000 points) gives the same cells', async () => {
    const r = seeded(4)
    const rows = points(r, 'scattered', 2000)
    const transform = { type: 'voronoi', x: 'x', y: 'y', size: [200, 150] }
    const want = (await vegaPaths(rows, transform)) as unknown[]
    expect(want.filter((p) => p !== null).length).toBeGreaterThan(1900)
    expect(asterPaths(rows, transform)).toEqual(want)
  })
})
