/** Point sets for the Voronoi differentials: the shapes that stress a triangulation, built from a seeded generator. */
import { seeded } from './upstream.mts'

export type Row = { x: unknown; y: unknown }

export const MODES = ['scattered', 'integers', 'lattice', 'diagonal', 'row', 'column', 'oneLine', 'equal', 'repeated', 'cocircular', 'nearCollinear', 'nearDuplicate', 'tiny', 'huge', 'mixed', 'outside', 'boundary', 'strings'] as const
export type Mode = (typeof MODES)[number]

export function points(r: ReturnType<typeof seeded>, mode: Mode, k: number): Row[] {
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
      case 'nearDuplicate': rows.push(j && r.int(2) ? { x: (rows[r.int(j)]!.x as number) + (r.next() - 0.5) * r.pick([1e-13, 1e-15, 1e-17]), y: (rows[r.int(j)]!.y as number) + (r.next() - 0.5) * 1e-14 } : { x: r.next() * 100, y: r.next() * 100 }); break
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


/**
 * Points with coordinates that are not numbers (missing, NaN, text, infinite, beyond 1e308). The reference loops forever on
 * some such inputs, so they are only used to check that Aster ends and answers once per row.
 */
export function hostilePoints(r: ReturnType<typeof seeded>, k: number): Row[] {
  const bad = [NaN, 'a', undefined, null, Infinity, -Infinity, 1e308, -1e308, 1e300]
  return Array.from({ length: k }, () => ({
    x: r.int(3) === 0 ? r.pick(bad) : r.next() * 50,
    y: r.int(3) === 0 ? r.pick(bad) : r.next() * 50,
  }))
}
