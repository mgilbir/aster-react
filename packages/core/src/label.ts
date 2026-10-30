/**
 * The `label` transform: each text item is put at the first of a list of places around the mark it labels where it overlaps
 * neither a mark to avoid nor a label already put; the choice is written to the item (`as`: x, y, opacity, align, baseline).
 * Labels of the lines and areas of a group are placed by the end of the line, or inside the area.
 *
 * What a layout decides on is an occupancy grid: a bit for each cell of the view, scaled down so that a big view has at most about a
 * million cells. The marks to avoid are drawn onto the coverage-only canvas of `raster.ts` (`label-draw.ts`), and a cell is
 * occupied where a pixel of it has any alpha, so nothing here depends on a DOM, a canvas or a native module. Text is measured as
 * everywhere in the engine (`text-metrics.ts`).
 *
 * The result is pinned to vega's, label for label, and these parts of the design are forced by that:
 *  - the order labels are placed in (the sort, else the order of the items) and the order places are tried in: a label takes the
 *    first place that fits, and takes the cells it covers from the labels after it;
 *  - the arithmetic of a place (offsets, the diagonal factor, centring on the text width), and `~~` to find a cell, since a label
 *    fits or not by the cells it touches;
 *  - cell (x, y) is bit `y * w + x` of a flat array, with no row padding: a cell outside the grid reads as its neighbour on the next
 *    row, or as free past the end, and the area search can ask for one;
 *  - the cells a label shown inside its mark is tested against are the mark's outline, not the labels placed (see `Field`);
 *  - the grid of cells an area search has visited lives as long as the layout, not the label.
 *
 * Registered by `@aster/core/transforms`. The rest of the engine reaches it through the transform registry.
 */
import { sortData } from './util.js'
import { AlphaCanvas } from './raster.js'
import { drawMark } from './label-draw.js'
import { itemMarkOf, transformRegistry } from './registry.js'
import { compareRows, resolveSizeParam, type Row, type TransformContext } from './transform.js'
import { meterRows } from './limits.js'
import { itemTextWidth } from './text-metrics.js'
import type { SceneGroup, SceneItem, SortSpec } from './types.js'

type Rec = Record<string, unknown>

// --- the grid ----------------------------------------------------------------------------------

/** The bits of a 32-bit word at and above bit `at` of the grid, and the bits at and below it. */
const fromBit = (at: number): number => -1 << (at & 31)
const toBit = (at: number): number => -1 >>> (31 - (at & 31))

/** Occupied cells, a bit each. Cell (x, y) is bit `y * w + x`: the rows follow each other without padding. */
class Grid {
  private readonly bits: Uint32Array

  constructor(readonly w: number, readonly h: number) {
    // w x h come from the spec's size and padding: bound the array before making it
    meterRows((w * h) / 32, 'label bitmap')
    this.bits = new Uint32Array(~~((w * h + 32) / 32))
  }

  has(x: number, y: number): boolean {
    const at = y * this.w + x
    return (this.bits[at >>> 5]! & (1 << (at & 31))) !== 0
  }

  add(x: number, y: number): void {
    const at = y * this.w + x
    this.bits[at >>> 5]! |= 1 << (at & 31)
  }

  /** Whether the box of cells from (x1, y1) to (x2, y2), both included, reaches outside the grid. */
  outside(x1: number, y1: number, x2: number, y2: number): boolean {
    return x1 < 0 || y1 < 0 || y2 >= this.h || x2 >= this.w
  }

  /** Whether any cell of the box is occupied. */
  anyIn(x1: number, y1: number, x2: number, y2: number): boolean {
    const { bits, w } = this
    for (let y = y1; y <= y2; ++y) {
      const first = y * w + x1
      const last = y * w + x2
      const i = first >>> 5
      const j = last >>> 5
      if (i === j) {
        if (bits[i]! & fromBit(first) & toBit(last)) return true
      } else {
        if (bits[i]! & fromBit(first) || bits[j]! & toBit(last)) return true
        for (let k = i + 1; k < j; ++k) if (bits[k]) return true
      }
    }
    return false
  }

  /** Occupy every cell of the box. */
  fill(x1: number, y1: number, x2: number, y2: number): void {
    const { bits, w } = this
    for (let y = y1; y <= y2; ++y) {
      const first = y * w + x1
      const last = y * w + x2
      const i = first >>> 5
      const j = last >>> 5
      if (i === j) {
        bits[i]! |= fromBit(first) & toBit(last)
      } else {
        bits[i]! |= fromBit(first)
        bits[j]! |= toBit(last)
        for (let k = i + 1; k < j; ++k) bits[k] = -1
      }
    }
  }
}

/** The grid of a view of `width` x `height` with `padding` around it, and the maps between its cells and the view's pixels. */
class Cells {
  /** Pixels to a cell: 1 up to a million pixels, more above. */
  private readonly ratio: number
  private readonly cols: number
  private readonly rows: number

  constructor(readonly width: number, readonly height: number, private readonly padding: number) {
    this.ratio = Math.max(1, Math.sqrt((width * height) / 1e6))
    this.cols = ~~((width + 2 * padding + this.ratio) / this.ratio)
    this.rows = ~~((height + 2 * padding + this.ratio) / this.ratio)
  }

  /** The cell a pixel coordinate falls in. */
  at(v: number): number {
    return ~~((v + this.padding) / this.ratio)
  }

  /** The pixel coordinate of a cell's start. */
  pixel(cell: number): number {
    return cell * this.ratio - this.padding
  }

  grid(): Grid {
    return new Grid(this.cols, this.rows)
  }
}

// --- the marks to avoid -------------------------------------------------------------------------

/** A mark as the scene keeps it: its type and its items (the items of a group are the group items, the marks inside them). */
interface Mark { marktype: string; items: Rec[] }

/** The marks inside a group item: the entries among its items that are marks (its own background item is not). */
const marksIn = (group: Rec): Mark[] =>
  ((group.items as Rec[] | undefined) ?? []).filter((c) => typeof c.marktype === 'string' && Array.isArray(c.items)) as unknown as Mark[]

/** Draw a mark. A group draws the marks inside each of its items. With `outlineOnly` an item that paints is drawn as its outline. */
function paintMark(pen: AlphaCanvas, mark: Mark, outlineOnly: boolean): void {
  if (!mark.items.length) return
  if (mark.marktype === 'group') {
    for (const group of mark.items) for (const inner of marksIn(group)) paintMark(pen, inner, outlineOnly)
    return
  }
  drawMark({ ...mark, items: outlineOnly ? mark.items.map(outlined) : mark.items } as unknown as SceneGroup, pen)
}

const outlined = (item: Rec): Rec =>
  (item.stroke && item.strokeOpacity !== 0) || (item.fill && item.fillOpacity !== 0) ? { ...item, strokeOpacity: 1, stroke: '#000', fillOpacity: 0 } : item

/** The mark that a list of items were all read off (the first decides). */
function markOf(items: Rec[]): Mark | undefined {
  const info = itemMarkOf(items[0])
  return info === undefined ? undefined : { ...(info.container as Rec), marktype: info.marktype, items }
}

/**
 * What a label may not cover. `occupied`: the marks to avoid, the base mark's interior (not for an area, whose labels go inside it)
 * and, as they are placed, the labels. `outlines`, only when a label can sit inside its mark: the marks to avoid and the outline of
 * the base mark; that is what a label inside is tested against, so it may overlap the labels placed.
 */
interface Field { cells: Cells; occupied: Grid; outlines: Grid | null }

/** The field of the marks to avoid and of the base mark's items (`base`, empty to leave the base mark out). */
function drawField(cells: Cells, base: Rec[], avoid: Mark[], wantOutlines: boolean, inArea: boolean): Field {
  const { width, height } = cells
  const avoided = new AlphaCanvas(width, height)
  const baseMark = base.length ? markOf(base) : undefined
  const drawnBase = baseMark ? new AlphaCanvas(width, height) : undefined
  const drawnOutline = wantOutlines ? new AlphaCanvas(width, height) : undefined
  for (const mark of avoid) paintMark(avoided, mark, false)
  if (baseMark && drawnBase) {
    paintMark(drawnBase, baseMark, false)
    if (drawnOutline) paintMark(drawnOutline, baseMark, true)
  }
  const occupied = cells.grid()
  const outlines = wantOutlines ? cells.grid() : null

  // (the canvas is read at a stride of `width`, which is not the canvas's own for a view of a fractional size: so is vega's)
  const a = avoided.alpha
  const b = drawnBase?.alpha
  const o = drawnOutline?.alpha
  const column = Int32Array.from({ length: Math.max(0, Math.ceil(width)) }, (_, x) => cells.at(x))
  for (let y = 0; y < height; ++y) {
    const row = cells.at(y)
    const start = y * width
    for (let x = 0; x < width; ++x) {
      const i = start + x
      const hit = a[i] || (b && b[i])
      const edge = a[i] || (o && o[i])
      if (!hit && !edge) continue
      if (hit && !inArea) occupied.add(column[x]!, row)
      if (edge && outlines) outlines.add(column[x]!, row)
    }
  }
  return { cells, occupied, outlines }
}

// --- the labels ---------------------------------------------------------------------------------

/** A label being placed: the text item, what the layout has decided, and where its mark is. */
interface Label {
  item: Rec
  opacity: number
  x: number | undefined
  y: number | undefined
  align: string | undefined
  baseline: string | undefined
  /** The mark's box as x1, x middle, x2, y1, y middle, y2. */
  box: number[]
  /** The text's width when it was measured up front (an unbounded padding needs it), else measured when a label gets that far. */
  width: number | undefined
}

/** Where a label goes relative to its mark's box: a step of -1, 0 or 1 in each direction from its middle. */
const DIRECTION = new Map<string, readonly [number, number]>([
  ['top-left', [-1, -1]], ['top', [0, -1]], ['top-right', [1, -1]],
  ['left', [-1, 0]], ['middle', [0, 0]], ['right', [1, 0]],
  ['bottom-left', [-1, 1]], ['bottom', [0, 1]], ['bottom-right', [1, 1]],
])
const TOP_LEFT: readonly [number, number] = [-1, -1]
const DEFAULT_ANCHORS = ['top-left', 'left', 'bottom-left', 'top', 'bottom', 'top-right', 'right', 'bottom-right']

/** One place to try: a direction and an offset (negative: inside the mark's edge). */
interface Spot { dx: number; dy: number; offset: number; inside: boolean; diagonal: number; side: number }

/**
 * The places to try, in order: the anchors and the offsets go in pairs, the shorter list repeating its last entry (an empty list
 * repeats the top left and a missing offset). An anchor that is not a direction is the top left.
 */
function spotsOf(offsets: unknown[], anchors: string[]): Spot[] {
  const count = Math.max(offsets.length, anchors.length)
  const offset = new Float64Array(count)
  const direction: Array<readonly [number, number]> = []
  for (let i = 0; i < count; ++i) {
    if (i < offsets.length) offset[i] = (offsets[i] as number) || 0
    else offset[i] = offset[offsets.length - 1]!
    direction[i] = i < anchors.length ? DIRECTION.get(anchors[i]!) ?? TOP_LEFT : direction[anchors.length - 1] ?? TOP_LEFT
  }
  return direction.map(([dx, dy], i) => ({
    dx, dy, offset: offset[i]!,
    inside: (dx === 0 && dy === 0) || offset[i]! < 0,
    diagonal: dx && dy ? Math.SQRT1_2 : 1,
    side: offset[i]! < 0 ? -1 : 1,
  }))
}

const ALIGN = ['right', 'center', 'left']
const BASELINE = ['bottom', 'middle', 'top']

/** Put a label beside (or inside) its mark: the first spot where it fits, taking the cells it covers. */
function placeBeside(field: Field, spots: Spot[], width: number, height: number): (label: Label) => boolean {
  const { cells, occupied, outlines } = field
  const fits = (c1: number, c2: number, r1: number, r2: number, inside: boolean): boolean =>
    !(occupied.outside(c1, r1, c2, r2) || (inside && outlines ? outlines : occupied).anyIn(c1, r1, c2, r2))

  return (label) => {
    const box = label.box
    const textHeight = label.item.fontSize as number
    // a mark that is outside the view has no label
    if (box[2]! < 0 || box[5]! < 0 || box[0]! > width || box[3]! > height) return false

    let textWidth = label.width ?? 0
    for (const { dx, dy, offset, inside, diagonal, side } of spots) {
      let left = box[1 + dx]! + offset * dx * diagonal
      const middle = box[4 + dy]! + (side * textHeight * dy) / 2 + offset * dy * diagonal
      const top = middle - textHeight / 2
      const bottom = middle + textHeight / 2
      const row1 = cells.at(top)
      const row2 = cells.at(bottom)

      if (!textWidth) {
        // a first look with the width of one cell spares measuring the text where even that does not fit
        const col = cells.at(left)
        if (!fits(col, col, row1, row2, inside)) continue
        textWidth = itemTextWidth(label.item, label.item.text as string)
      }

      const centre = left + (side * textWidth * dx) / 2
      left = centre - textWidth / 2
      const right = centre + textWidth / 2
      const col1 = cells.at(left)
      const col2 = cells.at(right)
      if (!fits(col1, col2, row1, row2, inside)) continue

      label.x = !dx ? centre : dx * side < 0 ? right : left
      label.y = !dy ? middle : dy * side < 0 ? bottom : top
      label.align = ALIGN[dx * side + 1]
      label.baseline = BASELINE[dy * side + 1]
      occupied.fill(col1, row1, col2, row2)
      return true
    }
    return false
  }
}

// --- labels inside the areas of a group ------------------------------------------------------------

/** The box between the two edges of an area at one of its points. */
interface Slice { x1: number; y1: number; x2: number; y2: number }

/** The areas' points of a label's group: the items of the mark `markIndex` inside it. */
const slicesOf = (label: Label, markIndex: number): Slice[] =>
  marksIn(label.item.datum as Rec)[markIndex]!.items.map((p) => {
    const x1 = p.x as number
    const y1 = p.y as number
    return { x1, y1, x2: p.x2 === undefined ? x1 : (p.x2 as number), y2: p.y2 === undefined ? y1 : (p.y2 as number) }
  })

/** Whether a label of this size centred on (x, y) would reach outside the view. */
function overflows(x: number, y: number, textWidth: number, textHeight: number, width: number, height: number): boolean {
  const halfWidth = textWidth / 2
  const halfHeight = textHeight / 2
  return x - halfWidth < 0 || x + halfWidth > width || y - halfHeight < 0 || y + halfHeight > height
}

/** The size of label that fits in an area: a label of the text's proportions, `h` high, centred on a point. */
class Fit {
  constructor(
    private readonly field: Field,
    private readonly textWidth: number,
    private readonly textHeight: number,
    private readonly width: number,
    private readonly height: number,
  ) {}

  /** Whether a label `h` high centred on (x, y) overlaps a label placed, or (`edges`) an outline. */
  blocked(x: number, y: number, h: number, edges: boolean): boolean {
    const { cells, occupied, outlines } = this.field
    const reach = (this.textWidth * h) / (this.textHeight * 2)
    const half = h / 2
    const c1 = cells.at(x - reach)
    const c2 = cells.at(x + reach)
    const r1 = cells.at(y - half)
    const r2 = cells.at(y + half)
    return occupied.outside(c1, r1, c2, r2) || occupied.anyIn(c1, r1, c2, r2) || (edges && outlines !== null && outlines.anyIn(c1, r1, c2, r2))
  }

  /** The height of the biggest label that fits at (x, y) if it is bigger than `floor`, else undefined. */
  grow(x: number, y: number, floor: number): number | undefined {
    if (overflows(x, y, this.textWidth, this.textHeight, this.width, this.height)) return undefined
    if (this.blocked(x, y, floor, true) || this.blocked(x, y, this.textHeight, false)) return undefined
    // bisect between the floor and the height of the view
    let lo = floor
    let hi = this.height
    while (hi - lo >= 1) {
      const mid = (lo + hi) / 2
      if (this.blocked(x, y, mid, true)) hi = mid
      else lo = mid
    }
    return lo > floor ? lo : undefined
  }
}

/** The label found so far for an area: where, how big, and whether a search (and not only the centre of a slice) found it. */
interface Find { label: Label; size: number; searched: boolean }

/** Look at the cells around a slice, from its middle to each side. */
function scanSlice(fit: Fit, cells: Cells, find: Find, s: Slice): void {
  const c1 = cells.at(s.x1)
  const c2 = cells.at(s.x2)
  const midCol = ~~((c1 + c2) / 2)
  const r1 = cells.at(s.y1)
  const r2 = cells.at(s.y2)
  const midRow = ~~((r1 + r2) / 2)
  const look = (col: number, row: number): void => {
    const x = cells.pixel(col)
    const y = cells.pixel(row)
    const size = fit.grow(x, y, find.size)
    if (size !== undefined) {
      find.label.x = x
      find.label.y = y
      find.size = size
      find.searched = true
    }
  }
  for (let col = midCol; col >= c1; --col) for (let row = midRow; row >= r1; --row) look(col, row)
  for (let col = midCol; col <= c2; ++col) for (let row = midRow; row <= r2; ++row) look(col, row)
}

/**
 * Flood from the middle of a slice over the cells not visited, occupied or on an outline, a diagonal step at a time, looking at each.
 * `visited` is kept across slices and labels.
 */
function floodSlice(fit: Fit, field: Field, visited: Grid, find: Find, s: Slice): void {
  const { cells, occupied, outlines } = field
  // the cells to visit as x, y pairs; the last pushed is the first visited
  const todo: number[] = [cells.at((s.x1 + s.x2) / 2), cells.at((s.y1 + s.y2) / 2)]
  while (todo.length) {
    const row = todo.pop()!
    const col = todo.pop()!
    if (occupied.has(col, row) || (outlines && outlines.has(col, row)) || visited.has(col, row)) continue
    visited.add(col, row)
    for (let j = 0; j < 4; ++j) {
      const x = col + (j < 2 ? -1 : 1)
      const y = row + (j & 1 ? 1 : -1)
      if (!visited.outside(x, y, x, y)) todo.push(x, y)
    }
    const x = cells.pixel(col)
    const y = cells.pixel(row)
    const size = fit.grow(x, y, find.size)
    if (size !== undefined) {
      find.label.x = x
      find.label.y = y
      find.size = size
      find.searched = true
    }
  }
}

/**
 * Put a label in the area of its group, at the widest point of the area; it does not look at what is there, so it needs no field.
 * The label is aligned to keep it inside the view.
 */
function placeAtWidest(markIndex: number, width: number, height: number): (label: Label) => boolean {
  return (label) => {
    const textHeight = label.item.fontSize as number
    const textWidth = itemTextWidth(label.item, label.item.text as string)
    let widest = 0
    for (const { x1, y1, x2, y2 } of slicesOf(label, markIndex)) {
      const span = Math.abs(x2 - x1 + y2 - y1)
      if (span >= widest) {
        widest = span
        label.x = (x1 + x2) / 2
        label.y = (y1 + y2) / 2
      }
    }
    const left = label.x! - textWidth / 2
    const right = label.x! + textWidth / 2
    const top = label.y! - textHeight / 2
    const bottom = label.y! + textHeight / 2
    label.align = left < 0 && right <= width ? 'left' : 0 <= left && width < right ? 'right' : 'center'
    label.baseline = top < 0 && bottom <= height ? 'top' : 0 <= top && height < bottom ? 'bottom' : 'middle'
    return true
  }
}

/** A slice with its sides low to high. */
const ordered = (s: Slice): Slice => ({ x1: Math.min(s.x1, s.x2), x2: Math.max(s.x1, s.x2), y1: Math.min(s.y1, s.y2), y2: Math.max(s.y1, s.y2) })

/**
 * Put a label in the area of its group where the biggest label of its proportions fits among the points of the area: by looking at
 * the cells around each point (`scan`) or at those a flood from it reaches (`flood`). When the base mark may be covered and nothing
 * fit, the label goes to the centre of the widest slice, if it fits there.
 */
function placeBySearch(flood: boolean, field: Field, avoidBaseMark: boolean, markIndex: number, width: number, height: number): (label: Label) => boolean {
  const { cells, occupied } = field
  const visited = flood ? cells.grid() : undefined
  return (label) => {
    const textHeight = label.item.fontSize as number
    const textWidth = itemTextWidth(label.item, label.item.text as string)
    const fit = new Fit(field, textWidth, textHeight, width, height)
    const find: Find = { label, size: avoidBaseMark ? textHeight : 0, searched: false }
    let centred = false
    let widest = 0

    for (const slice of slicesOf(label, markIndex)) {
      // (the scan goes from the middle of a slice to each side, so it takes the slice low to high)
      const box = visited ? slice : ordered(slice)
      if (visited) floodSlice(fit, field, visited, find, box)
      else scanSlice(fit, cells, find, box)
      if (find.searched || avoidBaseMark) continue
      const span = Math.abs(box.x2 - box.x1 + box.y2 - box.y1)
      const x = (box.x1 + box.x2) / 2
      const y = (box.y1 + box.y2) / 2
      if (span >= widest && !overflows(x, y, textWidth, textHeight, width, height) && !fit.blocked(x, y, textHeight, false)) {
        widest = span
        label.x = x
        label.y = y
        centred = true
      }
    }

    if (!find.searched && !centred) return false
    occupied.fill(cells.at(label.x! - textWidth / 2), cells.at(label.y! - textHeight / 2), cells.at(label.x! + textWidth / 2), cells.at(label.y! + textHeight / 2))
    label.align = 'center'
    label.baseline = 'middle'
    return true
  }
}

// --- the layout --------------------------------------------------------------------------------

interface Params {
  size: [number, number]
  sort: SortSpec | undefined
  offset: unknown[]
  anchor: string[]
  avoidMarks: Mark[]
  avoidBaseMark: boolean
  lineAnchor: string
  markIndex: number
  padding: number | null
  method: string
}

const pointBox = (p: Rec): number[] => [p.x as number, p.x as number, p.x as number, p.y as number, p.y as number, p.y as number]

/** How the box of a label's mark is read, by the kind of mark the first label belongs to. */
function boxReader(marktype: string | undefined, groupMark: string | false | undefined, lineAnchor: string, markIndex: number): (item: Rec) => number[] {
  // no mark behind the labels, or a mark drawn as one path (each item is a point of it): the item's own x, y
  if (!marktype) return pointBox
  if (marktype === 'line' || marktype === 'area') return (item) => pointBox(item.datum as Rec)
  // a group of lines: the end of the line
  if (groupMark === 'line') {
    return (item) => {
      const points = marksIn(item.datum as Rec)[markIndex]!.items
      return pointBox(points.length ? points[lineAnchor === 'start' ? 0 : points.length - 1]! : { x: NaN, y: NaN })
    }
  }
  return (item) => {
    const b = itemMarkOf(item.datum)!.bounds()
    return [b.x1, (b.x1 + b.x2) / 2, b.x2, b.y1, (b.y1 + b.y2) / 2, b.y2]
  }
}

const greatest = (values: readonly number[]): number => {
  let m = -Infinity
  for (const v of values) if (v > m) m = v
  return m
}

function layOut(items: Rec[], p: Params): Label[] {
  if (!items.length) return []
  const { size, offset, anchor, avoidMarks, avoidBaseMark, lineAnchor, markIndex, method } = p

  const spots = spotsOf(offset, anchor)
  const marktype = itemMarkOf(items[0]!.datum)?.marktype
  const groupMark = marktype === 'group' && marksIn(items[0]!.datum as Rec)[markIndex]!.marktype
  const inArea = groupMark === 'area'
  const readBox = boxReader(marktype, groupMark, lineAnchor, markIndex)

  // an unbounded padding is as much as the biggest label (and offset) can reach
  const unbounded = p.padding === null || p.padding === Infinity
  let widest = -1
  let tallest = -1
  const labels: Label[] = items.map((item) => {
    const width = unbounded ? itemTextWidth(item, item.text as string) : undefined
    if (unbounded) {
      widest = Math.max(widest, width!)
      tallest = Math.max(tallest, item.fontSize as number)
    }
    return { item, opacity: 0, x: undefined, y: undefined, align: undefined, baseline: undefined, box: readBox(item), width }
  })
  const padding = unbounded ? Math.max(widest, tallest) + greatest(offset as number[]) : p.padding!
  const cells = new Cells(size[0], size[1], padding)

  let field: Field | undefined
  if (!(inArea && method === 'naive')) {
    if (p.sort) {
      const sort = p.sort
      sortData(labels, (a, b) => compareRows(a.item as Row, b.item as Row, sort))
    }
    // a label may go inside its mark: it is tested against the outline of the mark, not the interior
    const inside = spots.some((s) => s.inside)
    // the base mark is avoided when asked to be, and an area's always (its labels go on the cells inside it)
    const base = ((marktype && avoidBaseMark) || inArea) && items.map((item) => item.datum as Rec)
    if (avoidMarks.length || base) field = drawField(cells, base || [], avoidMarks, inside || inArea, inArea)
    else {
      // no mark to draw: the base items are points, and the cell each is on is taken
      const occupied = cells.grid()
      if (avoidBaseMark) for (const label of labels) occupied.add(cells.at(label.box[0]!), cells.at(label.box[3]!))
      field = { cells, occupied, outlines: null }
    }
  }

  const place = inArea ? areaPlacer(method, field, avoidBaseMark, markIndex, size) : placeBeside(field!, spots, size[0], size[1])
  for (const label of labels) label.opacity = +place(label)
  return labels
}

function areaPlacer(method: string, field: Field | undefined, avoidBaseMark: boolean, markIndex: number, [width, height]: [number, number]): (label: Label) => boolean {
  if (method === 'naive') return placeAtWidest(markIndex, width, height)
  if (method !== 'reduced-search' && method !== 'floodfill') throw new Error(`The label method "${method}" is not naive, reduced-search or floodfill.`)
  return placeBySearch(method === 'floodfill', field!, avoidBaseMark, markIndex, width, height)
}

// --- the transform -----------------------------------------------------------------------------

const OUTPUT = ['x', 'y', 'opacity', 'align', 'baseline']
const toArray = <T>(v: T | T[]): T[] => (Array.isArray(v) ? v : [v])

/**
 * The `label` transform over the text items (a text mark's items, or a dataset's tuples): writes `as` on each. The marks it avoids
 * come from the transform context (`marks`).
 */
function labelRows(rows: Row[], t: Rec, ctx: TransformContext): Row[] {
  const size = resolveSizeParam(t.size, ctx)
  if (!size) throw new Error('Size parameter should be specified as a [width, height] array.')
  if (!rows.length) return rows

  const as = (t.as as string[] | undefined) ?? OUTPUT
  const avoidMarks: Mark[] = []
  for (const name of toArray((t.avoidMarks as string[] | undefined) ?? [])) {
    const mark = ctx.marks?.(name) as Mark | undefined
    if (mark !== undefined) avoidMarks.push(mark)
  }

  const labels = layOut(rows, {
    size,
    sort: t.sort ? (t.sort as SortSpec) : undefined,
    offset: toArray(t.offset == null ? 1 : (t.offset as number | number[])),
    anchor: toArray((t.anchor as string[] | undefined) ?? DEFAULT_ANCHORS),
    avoidMarks,
    avoidBaseMark: t.avoidBaseMark !== false,
    lineAnchor: (t.lineAnchor as string | undefined) || 'end',
    markIndex: (t.markIndex as number | undefined) || 0,
    padding: t.padding === undefined ? 0 : (t.padding as number | null),
    method: (t.method as string | undefined) || 'naive',
  })

  // a mark's items are written in place (they are the tuples); a dataset's rows are copied
  const out = ctx.inPlace ? rows : rows.map((r) => ({ ...r }))
  const copyOf = ctx.inPlace ? null : new Map<Rec, Row>(rows.map((r, i) => [r, out[i]!]))
  for (const label of labels) {
    const target = copyOf === null ? label.item : copyOf.get(label.item)!
    target[as[0]!] = label.x
    target[as[1]!] = label.y
    target[as[2]!] = label.opacity
    target[as[3]!] = label.align
    target[as[4]!] = label.baseline
  }
  return out
}

transformRegistry.set('label', labelRows)
