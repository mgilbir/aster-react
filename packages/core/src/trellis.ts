/**
 * Exact port of vega-view's trellis/grid layout (ViewLayout transform:
 * gridLayoutGroups, gridLayout, trellisLayout, layoutHeaders, layoutTitle)
 * operating on aster scene groups. All bounds are measured with the exact
 * vega-scenegraph bounds port (bounds.ts) at the time the layout pass reads
 * them, mirroring vega's dataflow order.
 */
import type { SceneGroup, SceneItem, SceneNode } from './types.js'
import { boundAxisGroup, Bounds, boundLeaf, boundsOf, boundsFromPath } from './bounds.js'

const Group = 'group'
const Start = 0
const Middle = 0.5
const End = 1

/** layoutHeaders margin aggregations — exact (floor/ceil matter). */
const min = (a: number, b: number) => Math.floor(Math.min(a, b))
const max = (a: number, b: number) => Math.ceil(Math.max(a, b))

type Views = {
  marks: SceneGroup[]
  rowheaders: SceneGroup[]
  rowfooters: SceneGroup[]
  colheaders: SceneGroup[]
  colfooters: SceneGroup[]
  rowtitle: SceneGroup | null
  coltitle: SceneGroup | null
}

/**
 * gridLayoutGroups — collect role groups. Our scene is flat: each role'd group
 * at the root IS the header/footer/title/cell item vega would keep inside a
 * role'd container mark, so the mark itself is pushed.
 */
export function gridLayoutGroups(group: SceneGroup): Views {
  const groups = (group.items ?? []) as SceneGroup[]
  const views: Views = {
    marks: [],
    rowheaders: [],
    rowfooters: [],
    colheaders: [],
    colfooters: [],
    rowtitle: null,
    coltitle: null,
  }

  for (let i = 0; i < groups.length; ++i) {
    const mark = groups[i]!
    if (mark.marktype !== Group) continue
    switch (mark.role) {
      case 'axis':
      case 'legend':
      case 'title':
        break
      case 'row-header':
        views.rowheaders.push(mark)
        break
      case 'row-footer':
        views.rowfooters.push(mark)
        break
      case 'column-header':
        views.colheaders.push(mark)
        break
      case 'column-footer':
        views.colfooters.push(mark)
        break
      case 'row-title':
        views.rowtitle = mark
        break
      case 'column-title':
        views.coltitle = mark
        break
      default:
        views.marks.push(mark)
    }
  }
  return views
}

type Opt = Record<string, unknown>

function get(opt: unknown, key: string, d?: unknown): any {
  const v = opt && typeof opt === 'object' && !Array.isArray(opt) ? (opt as Opt)[key] : opt
  return v != null ? v : d !== undefined ? d : 0
}

function offsetValue(v: number): number {
  return v < 0 ? Math.ceil(-v) : 0
}

type Box = { x1: number; y1: number; x2: number; y2: number }

function bboxFlush(item: SceneGroup): Bounds {
  return new Bounds().set(0, 0, item.width || 0, item.height || 0)
}

function bboxFull(item: SceneGroup): Bounds {
  const b = measureBounds(item)
  return b.empty() ? b.set(0, 0, 0, 0) : b.translate(-(item.x || 0), -(item.y || 0))
}

/** A grid-only axis (no tick labels/title) — vega measures these as their spine. */
function isGridOnlyAxis(g: SceneGroup): boolean {
  if (g.role !== 'axis') return false
  const items = g.items ?? []
  if (!items.length) return false
  let hasText = false
  const walk = (node: unknown): void => {
    const leaf = node as SceneItem
    if (leaf.text != null) hasText = true
    const kids = (leaf as SceneGroup).items
    if (Array.isArray(kids)) for (const k of kids) walk(k)
  }
  for (const it of items) walk(it)
  return !hasText
}

function measureBounds(item: SceneGroup): Bounds {
  const b = new Bounds()
  for (const it of item.items ?? []) {
    const leaf = it as SceneItem
    const isBgLeaf = (leaf as SceneGroup).marktype === undefined
      && !Array.isArray((leaf as SceneGroup).items)
      && leaf.path != null
      && leaf.stroke != null
      && leaf.strokeWidth == null
    if (isBgLeaf) {
      const bb = new Bounds()
      boundsFromPath(bb, leaf.path!)
      bb.translate(-0.5, -0.5) // undo the baked group stroke offset
      b.union(bb)
    } else if (isGridOnlyAxis(leaf as SceneGroup)) {
      // vega's axisLayout recomputes the axis mark's bounds as the axis spine
      // (ticks/labels excluded for grid-only axes), so grid rules inside facet
      // cells contribute nothing beyond the cell rect.
      continue
    } else if ((leaf as SceneGroup).role === 'axis') {
      b.union(boundAxisGroup(leaf as SceneGroup))
    } else {
      b.union(boundLeaf(new Bounds(), leaf))
    }
  }
  if ((item.width || item.height) && !(item as Record<string, unknown>).noBound) {
    b.add(0, 0).add(item.width || 0, item.height || 0)
  }
  // group stroke expansion (the cell's #ddd stroke, default width 1 → 0.5px)
  for (const leaf of item.items ?? []) {
    if ((leaf as SceneItem).stroke != null && (leaf as SceneItem).strokeWidth == null && (leaf as SceneItem).path != null) {
      b.expand(0.5)
      break
    }
  }
  return b.translate(item.x || 0, item.y || 0)
}

function boundFlush(item: SceneGroup, field: string): number | undefined {
  return field === 'x1' ? item.x || 0
    : field === 'y1' ? item.y || 0
    : field === 'x2' ? (item.x || 0) + (item.width || 0)
    : field === 'y2' ? (item.y || 0) + (item.height || 0)
    : undefined
}

function boundFull(item: SceneGroup, field: string): number | undefined {
  return (measureBounds(item) as unknown as Record<string, number>)[field]
}

/**
 * gridLayout — exact port. Positions `groups` (cell groups) in a grid,
 * updating each group's x/y. Returns the union of the translated boxes.
 */
export function gridLayout(groups: SceneGroup[], opt: Opt): Bounds {
  const dirty = !opt.nodirty
  const bbox: (g: SceneGroup) => Bounds = opt.bounds === 'flush' ? bboxFlush : bboxFull
  const bounds = new Bounds().set(0, 0, 0, 0)
  const alignCol = get(opt.align, 'column')
  const alignRow = get(opt.align, 'row')
  const padCol = get(opt.padding, 'column')
  const padRow = get(opt.padding, 'row')
  const ncols = (opt.columns as number) || groups.length
  const nrows = ncols <= 0 ? 1 : Math.ceil(groups.length / ncols)
  const n = groups.length
  const xOffset = new Array<number>(n).fill(0)
  const xExtent = new Array<number>(ncols).fill(0)
  let xMax = 0
  const yOffset = new Array<number>(n).fill(0)
  const yExtent = new Array<number>(nrows).fill(0)
  let yMax = 0
  const dx = new Array<number>(n).fill(0)
  const dy = new Array<number>(n).fill(0)
  const boxes: Bounds[] = new Array(n)
  const center = opt.center as Opt | undefined

  // determine offsets for each group
  for (let i = 0; i < n; ++i) {
    const g = groups[i]!
    const b = (boxes[i] = bbox(g))
    dx[i] = 0
    g.y = g.y || 0
    dy[i] = 0
    const c = i % ncols
    const r = ~~(i / ncols)
    xMax = Math.max(xMax, Math.ceil(b.x2))
    yMax = Math.max(yMax, Math.ceil(b.y2))
    xExtent[c] = Math.max(xExtent[c]!, Math.ceil(b.x2))
    yExtent[r] = Math.max(yExtent[r]!, Math.ceil(b.y2))
    xOffset[i] = padCol + offsetValue(b.x1)
    yOffset[i] = padRow + offsetValue(b.y1)
    if (dirty) void i // vega dirties the view; no-op here
  }

  // set initial alignment offsets
  for (let i = 0; i < n; ++i) {
    if (i % ncols === 0) xOffset[i] = 0
    if (i < ncols) yOffset[i] = 0
  }

  // enforce column alignment constraints
  if (alignCol === 'each') {
    for (let c = 1; c < ncols; ++c) {
      let offset = 0
      for (let i = c; i < n; i += ncols) {
        if (offset < xOffset[i]!) offset = xOffset[i]!
      }
      for (let i = c; i < n; i += ncols) {
        xOffset[i] = offset + xExtent[c - 1]!
      }
    }
  } else if (alignCol === 'all') {
    let offset = 0
    for (let i = 0; i < n; ++i) {
      if (i % ncols && offset < xOffset[i]!) offset = xOffset[i]!
    }
    for (let i = 0; i < n; ++i) {
      if (i % ncols) xOffset[i] = offset + xMax
    }
  } else {
    for (let c = 1; c < ncols; ++c) {
      for (let i = c; i < n; i += ncols) {
        xOffset[i]! += xExtent[c - 1]!
      }
    }
  }

  // enforce row alignment constraints
  if (alignRow === 'each') {
    for (let r = 1; r < nrows; ++r) {
      let offset = 0
      for (let i = r * ncols, m2 = i + ncols; i < m2; ++i) {
        if (offset < yOffset[i]!) offset = yOffset[i]!
      }
      for (let i = r * ncols, m2 = i + ncols; i < m2; ++i) {
        yOffset[i] = offset + yExtent[r - 1]!
      }
    }
  } else if (alignRow === 'all') {
    let offset = 0
    for (let i = ncols; i < n; ++i) {
      if (offset < yOffset[i]!) offset = yOffset[i]!
    }
    for (let i = ncols; i < n; ++i) {
      yOffset[i] = offset + yMax
    }
  } else {
    for (let r = 1; r < nrows; ++r) {
      for (let i = r * ncols, m2 = i + ncols; i < m2; ++i) {
        yOffset[i]! += yExtent[r - 1]!
      }
    }
  }

  // perform horizontal grid layout
  let x = 0
  for (let i = 0; i < n; ++i) {
    x = xOffset[i]! + (i % ncols ? x : 0)
    dx[i]! += x - (groups[i]!.x || 0)
  }

  // perform vertical grid layout
  for (let c = 0; c < ncols; ++c) {
    let y = 0
    for (let i = c; i < n; i += ncols) {
      y += yOffset[i]!
      dy[i]! += y - (groups[i]!.y || 0)
    }
  }

  // perform horizontal centering
  if (alignCol && get(center ?? {}, 'column') && nrows > 1) {
    for (let i = 0; i < n; ++i) {
      const b = alignCol === 'all' ? xMax : xExtent[i % ncols]!
      const cx = b - boxes[i]!.x2 - (groups[i]!.x || 0) - dx[i]!
      if (cx > 0) dx[i]! += cx / 2
    }
  }

  // perform vertical centering
  if (alignRow && get(center ?? {}, 'row') && ncols !== 1) {
    for (let i = 0; i < n; ++i) {
      const b = alignRow === 'all' ? yMax : yExtent[~~(i / ncols)]!
      const cy = b - boxes[i]!.y2 - (groups[i]!.y || 0) - dy[i]!
      if (cy > 0) dy[i]! += cy / 2
    }
  }

  // position grid relative to anchor
  for (let i = 0; i < n; ++i) {
    bounds.union(boxes[i]!.translate(dx[i]!, dy[i]!))
  }
  const anchor = opt.anchor as Opt | undefined
  let ax = get(anchor ?? {}, 'x')
  let ay = get(anchor ?? {}, 'y')
  switch (get(anchor ?? {}, 'column')) {
    case 'end': ax -= bounds.width(); break
    case 'middle': ax -= bounds.width() / 2; break
  }
  switch (get(anchor ?? {}, 'row')) {
    case 'end': ay -= bounds.height(); break
    case 'middle': ay -= bounds.height() / 2; break
  }
  ax = Math.round(ax)
  ay = Math.round(ay)

  // update mark positions
  for (let i = 0; i < n; ++i) {
    const g = groups[i]!
    g.x += dx[i]! += ax
    g.y += dy[i]! += ay
  }
  return bounds
}

/**
 * layoutHeaders — exact port. Positions header/footer groups along an edge.
 * Returns the layout edge (min/max of the positioned header bounds).
 */
export function layoutHeaders(
  headers: SceneGroup[],
  groups: SceneGroup[],
  ncols: number,
  limit: number,
  offset: number,
  agg: (a: number, b: number) => number,
  isX: number,
  bound: (g: SceneGroup, field: string) => number | undefined,
  bf: string,
  start: number,
  stride: number,
  back: number,
  band: number | null,
): number {
  const n = groups.length
  let init = 0
  let edge = 0

  if (!n) return init

  // compute margin
  for (let i = start; i < n; i += stride) {
    if (groups[i]) init = agg(init, bound(groups[i]!, bf) ?? 0)
  }

  // if no headers, return margin calculation
  if (!headers.length) return init

  // check if number of headers exceeds number of rows or columns
  let hdrs = headers
  if (hdrs.length > limit) hdrs = hdrs.slice(0, limit)

  // apply offset
  init += offset

  // layout each header
  for (let i = start, j = 0, m = hdrs.length; j < m; ++j, i += stride) {
    const h = hdrs[j]!

    // search for nearest group to align to (necessary if table has empty cells)
    let k = i
    let g: SceneGroup | undefined
    for (; k >= 0 && (g = groups[k]) == null; k -= back);

    // assign coordinates and update bounds
    let hx: number
    let hy: number
    if (isX) {
      hx = band == null ? (g ? g.x || 0 : 0) : Math.round((g ? measureBounds(g).x1 : 0) + band * (g ? measureBounds(g).width() : 0))
      hy = init
    } else {
      hx = init
      hy = band == null ? (g ? g.y || 0 : 0) : Math.round((g ? measureBounds(g).y1 : 0) + band * (g ? measureBounds(g).height() : 0))
    }
    const hb = measureBounds(h)
    hb.translate(hx - (h.x || 0), hy - (h.y || 0))
    h.x = hx
    h.y = hy

    // update current edge of layout bounds
    edge = agg(edge, (hb as unknown as Record<string, number>)[bf] ?? 0)
  }
  return edge
}

/** layoutTitle — exact port. Positions a title group. */
export function layoutTitle(
  g: SceneGroup | null,
  offset: number,
  isX: number,
  bounds: Bounds,
  band: number,
): void {
  if (!g) return

  // compute title coordinates
  let x = offset
  let y = offset
  if (isX) x = Math.round(bounds.x1 + band * bounds.width())
  else y = Math.round(bounds.y1 + band * bounds.height())

  // assign coordinates
  g.x = x
  g.y = y
}

/**
 * trellisLayout — exact port. Lays out a facet container group (cells,
 * headers, footers, titles) given the vega layout options.
 */
export function trellisLayout(group: SceneGroup, opt: Opt): void {
  const views = gridLayoutGroups(group)
  const groups = views.marks
  const bound: (g: SceneGroup, field: string) => number | undefined =
    opt.bounds === 'flush' ? boundFlush : boundFull
  const off = (opt.offset as Opt) ?? {}
  const ncols = (opt.columns as number) || groups.length
  const nrows = ncols <= 0 ? 1 : Math.ceil(groups.length / ncols)
  const cells = nrows * ncols
  let x = 0
  let y = 0
  let x2 = 0
  let y2 = 0
  let band: number | null
  let offset: number
  let anchor: unknown

  // -- initial grid layout
  const bounds = gridLayout(groups, opt)
  if (bounds.empty()) bounds.set(0, 0, 0, 0) // empty grid

  // -- layout grid headers and footers --

  if (views.rowheaders.length) {
    band = get(opt.headerBand ?? null, 'row', null)
    x = layoutHeaders(views.rowheaders, groups, ncols, nrows, -get(off, 'rowHeader'), min, 0, bound, 'x1', 0, ncols, 1, band)
  }

  if (views.colheaders.length) {
    band = get(opt.headerBand ?? null, 'column', null)
    y = layoutHeaders(views.colheaders, groups, ncols, ncols, -get(off, 'columnHeader'), min, 1, bound, 'y1', 0, 1, ncols, band)
  }

  if (views.rowfooters.length) {
    band = get(opt.footerBand ?? null, 'row', null)
    x2 = layoutHeaders(views.rowfooters, groups, ncols, nrows, get(off, 'rowFooter'), max, 0, bound, 'x2', ncols - 1, ncols, 1, band)
  }

  if (views.colfooters.length) {
    band = get(opt.footerBand ?? null, 'column', null)
    y2 = layoutHeaders(views.colfooters, groups, ncols, ncols, get(off, 'columnFooter'), max, 1, bound, 'y2', cells - ncols, 1, ncols, band)
  }

  // perform row title layout
  if (views.rowtitle) {
    anchor = get(opt.titleAnchor ?? null, 'row')
    offset = get(off, 'rowTitle')
    offset = anchor === End ? x2 + offset : x - offset
    band = get(opt.titleBand ?? null, 'row', 0.5)
    layoutTitle(views.rowtitle, offset, 0, bounds, band ?? 0.5)
  }

  // perform column title layout
  if (views.coltitle) {
    anchor = get(opt.titleAnchor ?? null, 'column')
    offset = get(off, 'columnTitle')
    offset = anchor === End ? y2 + offset : y - offset
    band = get(opt.titleBand ?? null, 'column', 0.5)
    layoutTitle(views.coltitle, offset, 1, bounds, band ?? 0.5)
  }
}
