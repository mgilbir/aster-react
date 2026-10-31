/**
 * Grid layout: cells placed in rows and columns, and the headers, footers and titles of a faceted view placed along them.
 *
 * `placeGrid` is the numeric core and works on boxes alone, so the groups of a facet, the entries of a legend and the legends of
 * a view share it. A layout is one pass per axis: the same arithmetic runs along the columns and along the rows, and only the way a
 * cell is mapped to its track (its column or its row) differs, so the two axes are one function with a flag.
 *
 * What the numbers must be (they decide where every pixel of a faceted chart lands, so the arithmetic is Vega's, operation for
 * operation): extents are whole pixels, rounded up; a box that starts before its origin pushes its track on by the overhang,
 * rounded up; a header margin rounds outward; an anchor and a band position round to the nearest pixel; and only an alignment of
 * `each` or `all` lets a cell be centred in its track.
 */
import type { SceneGroup } from './types.js'
import { Bounds, layoutBounds } from './bounds.js'
import { boundedCount } from './limits.js'

type Opt = Record<string, unknown>

/** A layout option that is one value or one per side: an object picks `key`, anything else is every side's value. */
function option(opt: unknown, key: string, unset: unknown = 0): any {
  const v = opt && typeof opt === 'object' && !Array.isArray(opt) ? (opt as Opt)[key] : opt
  return v != null ? v : unset
}

// --- the numeric core -----------------------------------------------------------------------------------------------------

export interface GridPlan {
  /** Per cell, how far to move it from where it stands. */
  dx: number[]
  dy: number[]
  /** The box around the cells before the grid is anchored. */
  bounds: Bounds
}

/** One axis of the grid: its tracks, and which track a cell is in. */
interface Axis {
  /** Tracks are the columns (cells run along a row) rather than the rows. */
  columns: boolean
  ncols: number
  nrows: number
}

/**
 * How far each cell moves along one axis. The cells of a track share an extent (the widest of them, in whole pixels); a track
 * starts where the one before it ends, plus the padding and the overhang of the cells that stick out before their origin. `align`
 * says whether the offsets of a track are made equal across tracks (`each`: against the track before, `all`: against the widest
 * track), and so whether a cell smaller than its track may be centred in it.
 */
function shiftAlong(axis: Axis, boxes: Bounds[], at: number[], padding: number, align: unknown, center: unknown): number[] {
  const { columns, ncols } = axis
  const tracks = columns ? ncols : axis.nrows
  const n = boxes.length
  const near = columns ? 'x1' : 'y1'
  const far = columns ? 'x2' : 'y2'
  const trackOf = (i: number): number => (columns ? i % ncols : ~~(i / ncols))
  const extent = new Array<number>(tracks).fill(0)
  const lead = new Array<number>(n)
  let total = 0
  for (let i = 0; i < n; ++i) {
    const box = boxes[i]!
    const reach = Math.ceil(box[far])
    const t = trackOf(i)
    total = Math.max(total, reach)
    extent[t] = Math.max(extent[t]!, reach)
    lead[i] = padding + (box[near] < 0 ? Math.ceil(-box[near]) : 0)
  }
  for (let i = 0; i < n; ++i) if (trackOf(i) === 0) lead[i] = 0

  // the cells of track t are first(t), first(t) + step, ... below last(t)
  const first = (t: number): number => (columns ? t : t * ncols)
  const step = columns ? ncols : 1
  const last = (t: number): number => (columns ? n : Math.min(n, (t + 1) * ncols))

  if (align === 'each') {
    for (let t = 1; t < tracks; ++t) {
      let widest = 0
      for (let i = first(t); i < last(t); i += step) if (widest < lead[i]!) widest = lead[i]!
      for (let i = first(t); i < last(t); i += step) lead[i] = widest + extent[t - 1]!
    }
  } else if (align === 'all') {
    let widest = 0
    for (let i = 0; i < n; ++i) if (trackOf(i) > 0 && widest < lead[i]!) widest = lead[i]!
    for (let i = 0; i < n; ++i) if (trackOf(i) > 0) lead[i] = widest + total
  } else {
    for (let t = 1; t < tracks; ++t) for (let i = first(t); i < last(t); i += step) lead[i]! += extent[t - 1]!
  }

  // a cell lies after the leads of the cells before it in its line (its row when the tracks are columns, its column otherwise)
  const shift = new Array<number>(n).fill(0)
  if (columns) {
    let pos = 0
    for (let i = 0; i < n; ++i) {
      pos = lead[i]! + (trackOf(i) ? pos : 0)
      shift[i]! += pos - at[i]!
    }
  } else {
    for (let c = 0; c < ncols; ++c) {
      let pos = 0
      for (let i = c; i < n; i += ncols) {
        pos += lead[i]!
        shift[i]! += pos - at[i]!
      }
    }
  }

  if ((align === 'each' || align === 'all') && center && (columns ? axis.nrows > 1 : ncols !== 1)) {
    for (let i = 0; i < n; ++i) {
      const slack = (align === 'all' ? total : extent[trackOf(i)]!) - boxes[i]![far] - at[i]! - shift[i]!
      if (slack > 0) shift[i]! += slack / 2
    }
  }
  return shift
}

/**
 * Place boxes in a grid. `at` is where each box's group stands now (the shifts are relative to it). `opt` is a Vega layout:
 * `columns` (none or 0: one row), `align`, `padding` and `center` (each one value or `{row, column}`), and `anchor`, the point the
 * whole grid hangs from and which of its edges that point is (`{x, y, column: 'end' | 'middle', row: 'end' | 'middle'}`).
 */
export function placeGrid(boxes: Bounds[], at: ReadonlyArray<{ x: number; y: number }>, opt: Opt): GridPlan {
  const n = boxes.length
  const ncols = (opt.columns as number) || n
  // `columns` comes from the spec: bound the per-column arrays before allocating them
  if (ncols > 0) boundedCount(ncols, 'facet columns')
  const nrows = ncols <= 0 ? 1 : Math.ceil(n / ncols)
  const dx = shiftAlong({ columns: true, ncols, nrows }, boxes, at.map((a) => a.x || 0), option(opt.padding, 'column'), option(opt.align, 'column'), option(opt.center, 'column'))
  const dy = shiftAlong({ columns: false, ncols, nrows }, boxes, at.map((a) => a.y || 0), option(opt.padding, 'row'), option(opt.align, 'row'), option(opt.center, 'row'))

  const bounds = new Bounds().set(0, 0, 0, 0)
  for (let i = 0; i < n; ++i) bounds.union(boxes[i]!.translate(dx[i]!, dy[i]!))
  let x = option(opt.anchor, 'x')
  let y = option(opt.anchor, 'y')
  const column = option(opt.anchor, 'column')
  const row = option(opt.anchor, 'row')
  if (column === 'end') x -= bounds.width()
  else if (column === 'middle') x -= bounds.width() / 2
  if (row === 'end') y -= bounds.height()
  else if (row === 'middle') y -= bounds.height() / 2
  x = Math.round(x)
  y = Math.round(y)
  for (let i = 0; i < n; ++i) {
    dx[i]! += x
    dy[i]! += y
  }
  return { dx, dy, bounds }
}

/** The box a cell group occupies relative to its own position: its frame (`flush`) or everything it draws (`full`). */
function cellBox(g: SceneGroup, flush: boolean): Bounds {
  if (flush) return new Bounds().set(0, 0, g.width || 0, g.height || 0)
  const b = layoutBounds(g)
  return b.empty() ? b.set(0, 0, 0, 0) : b.translate(-(g.x || 0), -(g.y || 0))
}

/**
 * Lay groups out in a grid, moving each. `measure` gives their boxes when the caller has them; otherwise they are read off the
 * groups. Returns the box around the groups at their new places.
 */
export function gridLayout(groups: SceneGroup[], opt: Opt, measure?: (g: SceneGroup) => Bounds): Bounds {
  for (const g of groups) g.y = g.y || 0
  const boxes = groups.map(measure ?? ((g) => cellBox(g, opt.bounds === 'flush')))
  const { dx, dy } = placeGrid(boxes, groups.map((g) => ({ x: g.x || 0, y: g.y || 0 })), opt)
  const bounds = new Bounds()
  groups.forEach((g, i) => {
    g.x = (g.x as number) + dx[i]!
    g.y = (g.y as number) + dy[i]!
    bounds.union(layoutBounds(g))
  })
  return bounds
}

// --- a facet: its cells, headers, footers and titles ----------------------------------------------------------------------

type Role = 'row-header' | 'row-footer' | 'column-header' | 'column-footer'

/** The groups of a faceted view by what they are for; the view's guides and its own title are laid out apart from them. */
function sortByRole(view: SceneGroup): { cells: SceneGroup[]; strips: Record<Role, SceneGroup[]>; titles: Partial<Record<'row-title' | 'column-title', SceneGroup>> } {
  const cells: SceneGroup[] = []
  const strips: Record<Role, SceneGroup[]> = { 'row-header': [], 'row-footer': [], 'column-header': [], 'column-footer': [] }
  const titles: Partial<Record<'row-title' | 'column-title', SceneGroup>> = {}
  for (const mark of (view.items ?? []) as SceneGroup[]) {
    if (mark.marktype !== 'group') continue
    const role = mark.role ?? ''
    if (role === 'axis' || role === 'legend' || role === 'title') continue
    if (role in strips) strips[role as Role].push(mark)
    else if (role === 'row-title' || role === 'column-title') titles[role] = mark
    else cells.push(mark)
  }
  return { cells, strips, titles }
}

type Edge = 'x1' | 'y1' | 'x2' | 'y2'

/** Where one side of a cell lies: its frame (`flush`) or the extent of everything in it (`full`). */
function sideOf(cell: SceneGroup, edge: Edge, flush: boolean): number {
  if (!flush) return layoutBounds(cell)[edge]
  const x = cell.x || 0
  const y = cell.y || 0
  return edge === 'x1' ? x : edge === 'y1' ? y : edge === 'x2' ? x + (cell.width || 0) : y + (cell.height || 0)
}

/** One side of the grid that carries headers or footers. */
interface Side {
  /** The strips sit above or below the cells and line up with their columns, rather than beside them and line up with their rows. */
  overColumns: boolean
  /** A header sits before the cells (above, left) and rounds its margin down; a footer sits after them and rounds up. */
  leading: boolean
}

/**
 * Put a side's headers (or footers) beyond the cells. Each lines up with the cell of its column (or row), or with the nearest
 * cell before it when the table has holes; `band` says where along that cell. Returns how far out the headers reach, which a
 * title on that side clears; with no header it is still how far the cells themselves reach.
 */
function placeStrips(strips: SceneGroup[], cells: SceneGroup[], ncols: number, nrows: number, side: Side, gap: number, band: number | null, flush: boolean): number {
  const n = cells.length
  if (!n) return 0
  const { overColumns, leading } = side
  const edge: Edge = overColumns ? (leading ? 'y1' : 'y2') : (leading ? 'x1' : 'x2')
  const outward = leading ? (a: number, b: number) => Math.floor(Math.min(a, b)) : (a: number, b: number) => Math.ceil(Math.max(a, b))
  // the first cell on the side, and how the cells that line up with successive strips follow one another
  const start = leading ? 0 : overColumns ? nrows * ncols - ncols : ncols - 1
  const stride = overColumns ? 1 : ncols
  const back = overColumns ? ncols : 1

  let margin = 0
  for (let i = start; i < n; i += stride) if (cells[i]) margin = outward(margin, sideOf(cells[i]!, edge, flush))
  if (!strips.length) return margin

  // more strips than the grid has columns (rows) are left where they are
  const limit = overColumns ? ncols : nrows
  const placed = strips.length > limit ? strips.slice(0, limit) : strips
  margin += gap
  let reach = 0
  for (let j = 0, i = start; j < placed.length; ++j, i += stride) {
    const strip = placed[j]!
    let k = i
    let cell: SceneGroup | undefined
    for (; k >= 0 && (cell = cells[k]) == null; k -= back);
    let x: number
    let y: number
    if (overColumns) {
      x = band == null ? (cell ? cell.x || 0 : 0) : Math.round((cell ? layoutBounds(cell).x1 : 0) + band * (cell ? layoutBounds(cell).width() : 0))
      y = margin
    } else {
      x = margin
      y = band == null ? (cell ? cell.y || 0 : 0) : Math.round((cell ? layoutBounds(cell).y1 : 0) + band * (cell ? layoutBounds(cell).height() : 0))
    }
    const box = layoutBounds(strip).translate(x - (strip.x || 0), y - (strip.y || 0))
    strip.x = x
    strip.y = y
    reach = outward(reach, box[edge] ?? 0)
  }
  return reach
}

/** Lay out a faceted group: its cells, then the headers and footers along them, then its row and column titles beside those. */
export function trellisLayout(view: SceneGroup, opt: Opt): void {
  const { cells, strips, titles } = sortByRole(view)
  const flush = opt.bounds === 'flush'
  const ncols = (opt.columns as number) || cells.length
  if (ncols > 0) boundedCount(ncols, 'facet columns')
  const nrows = ncols <= 0 ? 1 : Math.ceil(cells.length / ncols)

  const grid = gridLayout(cells, opt)
  if (grid.empty()) grid.set(0, 0, 0, 0)

  const reachOf = (role: Role): number => {
    const overColumns = role.startsWith('column')
    const leading = role.endsWith('header')
    const distance = option(opt.offset, (overColumns ? 'column' : 'row') + (leading ? 'Header' : 'Footer')) as number
    const bands = leading ? opt.headerBand : opt.footerBand
    return placeStrips(strips[role], cells, ncols, nrows, { overColumns, leading }, leading ? -distance : distance, option(bands, overColumns ? 'column' : 'row', null), flush)
  }
  const left = reachOf('row-header')
  const above = reachOf('column-header')
  const right = reachOf('row-footer')
  const below = reachOf('column-footer')

  const titleOf = (role: 'row-title' | 'column-title', before: number, after: number): void => {
    const title = titles[role]
    if (!title) return
    const overColumns = role === 'column-title'
    const axis = overColumns ? 'column' : 'row'
    const distance = option(opt.offset, axis + 'Title') as number
    const across = option(opt.titleAnchor, axis) === 'end' ? after + distance : before - distance
    const band = option(opt.titleBand, axis, 0.5) as number
    if (overColumns) {
      title.x = Math.round(grid.x1 + band * grid.width())
      title.y = across
    } else {
      title.x = across
      title.y = Math.round(grid.y1 + band * grid.height())
    }
  }
  titleOf('row-title', left, right)
  titleOf('column-title', above, below)
}
