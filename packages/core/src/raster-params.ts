/**
 * How the raster transforms read their parameters: the accessor of a `field` parameter and the settings of a density
 * estimate. Shared by `contour` (in the core transforms) and `kde2d` (in the transforms add-on), which read the density
 * settings the same way.
 *
 * Fixed by the observable behaviour: the density settings are read (and refused) in the order size, cell size,
 * bandwidth, with the messages `invalid size`, `invalid cell size` and `invalid bandwidth`.
 */
import { array } from './util.js'
import { fieldOf, type Row } from './transform-agg.js'

type Params = Record<string, unknown>
export type Get = (d: Row) => unknown

/** The accessor of a `field` parameter: a field name, or an `{expr}` evaluated over the tuple. */
export function accessorOf(f: unknown, compile: (expr: string) => Get): Get {
  if (f !== null && typeof f === 'object' && typeof (f as { expr?: unknown }).expr === 'string') return compile((f as { expr: string }).expr)
  return fieldOf(f) as Get
}

/** The settings of a density estimate: the view size, log2 of the cell size, and the bandwidth per axis (negative: estimate). */
export interface DensitySettings {
  size: [number, number]
  k: number
  bandwidth: [number, number]
}

/** Reads and validates them, refusing with `invalid size`, `invalid cell size` or `invalid bandwidth`. */
export function densitySettings(t: Params): DensitySettings {
  let size: [number, number] = [960, 500]
  if (t.size != null) {
    const given = t.size as ArrayLike<unknown>
    size = [+(given[0] as number), +(given[1] as number)]
    if (!(size[0] >= 0 && size[1] >= 0)) throw new Error('invalid size')
  }
  let k = 2
  if (t.cellSize != null) {
    const cell = +(t.cellSize as number)
    if (!(cell >= 1)) throw new Error('invalid cell size')
    k = Math.floor(Math.log(cell) / Math.LN2)
  }
  let bandwidth: [number, number] = [-1, -1]
  if (t.bandwidth != null) {
    const given = array(t.bandwidth)
    if (given.length === 1) bandwidth = [+(given[0] as number), +(given[0] as number)]
    else if (given.length === 2) bandwidth = [+(given[0] as number), +(given[1] as number)]
    else throw new Error('invalid bandwidth')
  }
  return { size, k, bandwidth }
}
