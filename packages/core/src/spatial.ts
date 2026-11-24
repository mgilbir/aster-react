/**
 * vega-runtime's `adjustSpatial`: what an encode set derives from the edges it defines -- `x2` / `xc` / `y2` / `yc` become `x` / `y` /
 * `width` / `height` -- run once per encode SET, on the channels that set defines (not on whether their values came out finite).
 *
 * vega encodes an item with its `enter` set (the mark's own `enter`, and the defaults its config and styles give, which land there),
 * then its `update` set, each followed by its own adjustment over the channels it holds. Aster evaluates one merged set (`update`
 * over `enter`); for a dimension whose edges the two sets split between them -- a style's `x2` in `enter` and the mark's `x` in
 * `update`, a config `x` in `enter` and an `x2` in `update` -- one adjustment over the merged channels is not what vega's two make,
 * and the compiler gives the merged set a program (`setSpatialProgram`): the channels of each set, in each dimension, and a copy of
 * every enter channel the update set overrides (under `ENTER_COPY`), evaluated with the others, so the two adjustments run in order
 * on the item. The copies leave the item once used. Every other mark is adjusted once, as before.
 *
 * Rule marks are never adjusted (their x2 / y2 are line ends); rect, group and image swap so that x / y is the lesser edge. The
 * arithmetic is JS's, so a NaN or missing operand gives NaN, which the renderers read as 0 (`item.width || 0`) as vega's do.
 */

/** The channels of one dimension each set defines. */
export interface DimensionSets { readonly enter: readonly string[]; readonly update: readonly string[] }
export interface SpatialProgram { readonly x?: DimensionSets; readonly y?: DimensionSets }

/** The key of the copy of an `enter` channel that the `update` set overrides (no channel name starts with it). */
export const ENTER_COPY = '\u0000enter:'

const PROGRAMS = new WeakMap<object, SpatialProgram>()

export function setSpatialProgram(encode: object, program: SpatialProgram): void {
  PROGRAMS.set(encode, program)
}

const DIMENSIONS = {
  x: { pos: 'x', end: 'x2', center: 'xc', size: 'width' },
  y: { pos: 'y', end: 'y2', center: 'yc', size: 'height' },
} as const
type Dimension = (typeof DIMENSIONS)[keyof typeof DIMENSIONS]

/** The channels of a dimension, by name. */
export const SPATIAL_CHANNELS = { x: ['x', 'x2', 'xc', 'width'], y: ['y', 'y2', 'yc', 'height'] } as const

/**
 * Which dimensions of a mark need the two adjustments in order: those where one adjustment over the merged channels differs from
 * vega's two -- the enter set defines an edge (`x2` / `xc`) and the update set defines any channel of the dimension, or the update
 * set defines `x2` without `x` while the enter set defines `x` (the merged set would make a width of them).
 */
export function spatialProgramOf(marktype: string, enter: ReadonlySet<string>, update: ReadonlySet<string>): SpatialProgram | undefined {
  if (marktype === 'rule') return undefined
  let program: { x?: DimensionSets; y?: DimensionSets } | undefined
  for (const dim of ['x', 'y'] as const) {
    const d = DIMENSIONS[dim]
    const e = SPATIAL_CHANNELS[dim].filter((k) => enter.has(k))
    const u = SPATIAL_CHANNELS[dim].filter((k) => update.has(k))
    const split = ((e.includes(d.end) || e.includes(d.center)) && u.length > 0) || (u.includes(d.end) && !u.includes(d.pos) && e.includes(d.pos))
    if (split) (program ??= {})[dim] = { enter: e, update: u }
  }
  return program
}

/** One adjustment of a dimension over the channels `has` says the set defines. */
function adjust(o: Record<string, unknown>, has: (k: string) => boolean, d: Dimension, canSwap: boolean): void {
  const n = (k: string): number => o[k] as number
  if (has(d.end)) {
    if (has(d.pos)) {
      if (canSwap && n(d.pos) > n(d.end)) { const t = o[d.pos]; o[d.pos] = o[d.end]; o[d.end] = t }
      o[d.size] = n(d.end) - n(d.pos)
    } else {
      o[d.pos] = n(d.end) - (n(d.size) || 0)
    }
  }
  if (has(d.center)) o[d.pos] = n(d.center) - (n(d.size) || 0) / 2
}

/** Adjust an encoded item (`rec`) for the set `encode` it was encoded from. */
export function adjustSpatial(rec: Record<string, unknown>, encode: Record<string, unknown>, marktype: string): void {
  if (marktype === 'rule') return
  const canSwap = marktype === 'rect' || marktype === 'group' || marktype === 'image'
  const program = PROGRAMS.get(encode)
  const merged = (k: string): boolean => encode[k] != null
  for (const dim of ['x', 'y'] as const) {
    const sets = program?.[dim]
    if (sets === undefined) { adjust(rec, merged, DIMENSIONS[dim], canSwap); continue }
    // the enter set, with the values it gave the channels the update set overrides; then the update set over it
    const o: Record<string, unknown> = {}
    for (const k of sets.enter) o[k] = sets.update.includes(k) ? rec[ENTER_COPY + k] : rec[k]
    adjust(o, (k) => sets.enter.includes(k), DIMENSIONS[dim], canSwap)
    for (const k of sets.update) o[k] = rec[k]
    adjust(o, (k) => sets.update.includes(k), DIMENSIONS[dim], canSwap)
    for (const k of SPATIAL_CHANNELS[dim]) {
      if (Object.hasOwn(o, k)) rec[k] = o[k]
      delete rec[ENTER_COPY + k]
    }
  }
}
