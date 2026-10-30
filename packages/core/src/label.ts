/**
 * The `label` transform: a port of vega-label 2.1.2 (`Label.js`, `LabelLayout.js`, `util/*`). Each text item is placed at one
 * of a list of anchors around the mark it labels so that it overlaps neither the marks to avoid nor a label placed before
 * it; the placement is recorded in `x`, `y`, `opacity`, `align` and `baseline` (`as`).
 *
 * The layout works on bitmaps (typed arrays, one bit per pixel of the scaled layout). vega draws the marks to avoid into an
 * offscreen canvas and reads which pixels have any alpha; the same drawing code the scene renders with draws them into the
 * coverage-only context of `raster.ts`, so nothing here depends on a canvas, a DOM or a native module. Text is measured as
 * everywhere else in the engine (`text-metrics.ts`): the host's provider, the browser's canvas, or vega's headless estimate.
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

// --- util/Bitmap.js ---------------------------------------------------------

const DIV = 5 // bit shift from x, y index to bit vector array index
const MOD = 31 // bit mask for index lookup within a bit vector
const SIZE = 32 // individual bit vector size
const RIGHT0 = new Uint32Array(SIZE + 1) // left-anchored bit vectors, full -> 0
const RIGHT1 = new Uint32Array(SIZE + 1) // right-anchored bit vectors, 0 -> full
RIGHT1[0] = 0
RIGHT0[0] = ~RIGHT1[0]!
for (let i = 1; i <= SIZE; ++i) {
  RIGHT1[i] = (RIGHT1[i - 1]! << 1) | 1
  RIGHT0[i] = ~RIGHT1[i]!
}

export interface Bitmap {
  array: Uint32Array
  get(x: number, y: number): number
  set(x: number, y: number): void
  clear(x: number, y: number): void
  getRange(x: number, y: number, x2: number, y2: number): boolean
  setRange(x: number, y: number, x2: number, y2: number): void
  clearRange(x: number, y: number, x2: number, y2: number): void
  outOfBounds(x: number, y: number, x2: number, y2: number): boolean
}

export function bitmap(w: number, h: number): Bitmap {
  // w x h come from the spec's size and padding: bound the bit array before making it (C9)
  meterRows((w * h) / SIZE, 'label bitmap')
  const array = new Uint32Array(~~((w * h + SIZE) / SIZE))
  return {
    array,
    get: (x, y) => {
      const index = y * w + x
      return array[index >>> DIV]! & (1 << (index & MOD))
    },
    set: (x, y) => {
      const index = y * w + x
      array[index >>> DIV]! |= 1 << (index & MOD)
    },
    clear: (x, y) => {
      const index = y * w + x
      array[index >>> DIV]! &= ~(1 << (index & MOD))
    },
    getRange: (x, y, x2, y2) => {
      for (let r = y2; r >= y; --r) {
        const start = r * w + x
        const end = r * w + x2
        const indexStart = start >>> DIV
        const indexEnd = end >>> DIV
        if (indexStart === indexEnd) {
          if (array[indexStart]! & RIGHT0[start & MOD]! & RIGHT1[(end & MOD) + 1]!) return true
        } else {
          if (array[indexStart]! & RIGHT0[start & MOD]!) return true
          if (array[indexEnd]! & RIGHT1[(end & MOD) + 1]!) return true
          for (let i = indexStart + 1; i < indexEnd; ++i) if (array[i]) return true
        }
      }
      return false
    },
    setRange: (x, y, x2, y2) => {
      for (; y <= y2; ++y) {
        const start = y * w + x
        const end = y * w + x2
        const indexStart = start >>> DIV
        const indexEnd = end >>> DIV
        if (indexStart === indexEnd) {
          array[indexStart]! |= RIGHT0[start & MOD]! & RIGHT1[(end & MOD) + 1]!
        } else {
          array[indexStart]! |= RIGHT0[start & MOD]!
          array[indexEnd]! |= RIGHT1[(end & MOD) + 1]!
          for (let i = indexStart + 1; i < indexEnd; ++i) array[i] = 0xffffffff
        }
      }
    },
    clearRange: (x, y, x2, y2) => {
      for (; y <= y2; ++y) {
        const start = y * w + x
        const end = y * w + x2
        const indexStart = start >>> DIV
        const indexEnd = end >>> DIV
        if (indexStart === indexEnd) {
          array[indexStart]! &= RIGHT1[start & MOD]! | RIGHT0[(end & MOD) + 1]!
        } else {
          array[indexStart]! &= RIGHT1[start & MOD]!
          array[indexEnd]! &= RIGHT0[(end & MOD) + 1]!
          for (let i = indexStart + 1; i < indexEnd; ++i) array[i] = 0
        }
      }
    },
    outOfBounds: (x, y, x2, y2) => x < 0 || y < 0 || y2 >= h || x2 >= w,
  }
}

// --- util/scaler.js ---------------------------------------------------------

export interface Scaler {
  (v: number): number
  invert(v: number): number
  bitmap(): Bitmap
  ratio: number
  padding: number
  width: number
  height: number
}

export function scaler(width: number, height: number, padding: number): Scaler {
  const ratio = Math.max(1, Math.sqrt((width * height) / 1e6))
  const w = ~~((width + 2 * padding + ratio) / ratio)
  const h = ~~((height + 2 * padding + ratio) / ratio)
  const scale = ((v: number) => ~~((v + padding) / ratio)) as Scaler
  scale.invert = (v) => v * ratio - padding
  scale.bitmap = () => bitmap(w, h)
  scale.ratio = ratio
  scale.padding = padding
  scale.width = width
  scale.height = height
  return scale
}

// --- util/markBitmaps.js ----------------------------------------------------

/** A mark container as the scene has it: `marktype` and the items it draws (a group's items are the mark containers inside it). */
interface Container { marktype: string; items: Rec[] }

/**
 * The marks inside a group item (vega's `group.items`). The scene keeps a group's own background item among them: the marks are
 * the entries that are containers.
 */
const childMarks = (group: Rec): Container[] =>
  ((group.items as Rec[] | undefined) ?? []).filter((c) => typeof c.marktype === 'string' && Array.isArray(c.items)) as unknown as Container[]

/** vega's `draw`: a group draws the marks inside each of its items; any other mark draws its items. */
function draw(ctx: AlphaCanvas, c: Container, interior: boolean): void {
  if (!c.items.length) return
  if (c.marktype === 'group') {
    for (const group of c.items) for (const mark of childMarks(group)) draw(ctx, mark, interior)
  } else {
    drawMark({ ...c, items: interior ? (c.items.map(prepare) as unknown as SceneItem[]) : c.items } as unknown as SceneGroup, ctx)
  }
}

/** Prepare an item before drawing it for its border: stroke the outline, paint no interior. */
function prepare(source: Rec): Rec {
  if ((source.stroke && source.strokeOpacity !== 0) || (source.fill && source.fillOpacity !== 0)) {
    return { ...source, strokeOpacity: 1, stroke: '#000', fillOpacity: 0 }
  }
  return source
}

function baseBitmaps($: Scaler, data: Entry[] | false | undefined): [Bitmap, undefined] {
  const bm = $.bitmap()
  // when there is no base mark but data points are to be avoided
  for (const d of data || []) bm.set($(d.boundary[0]!), $(d.boundary[3]!))
  return [bm, undefined]
}

function markBitmaps($: Scaler, baseMark: Rec[] | false, avoidMarks: Container[], labelInside: boolean, isGroupArea: boolean): [Bitmap, Bitmap | false] {
  const width = $.width
  const height = $.height
  const border = labelInside || isGroupArea
  const context = new AlphaCanvas(width, height)
  const baseMarkContext = new AlphaCanvas(width, height)
  const strokeContext = border ? new AlphaCanvas(width, height) : undefined

  // render all marks to be avoided into the canvas
  for (const items of avoidMarks) draw(context, items, false)
  const base = baseMark || []
  const baseContainer = base.length ? containerOf(base) : undefined
  if (baseContainer) {
    draw(baseMarkContext, baseContainer, false)
    if (strokeContext) draw(strokeContext, baseContainer, true)
  }

  const buffer = context.alpha
  const baseMarkBuffer = baseMarkContext.alpha
  const strokeBuffer = strokeContext?.alpha
  const layer1 = $.bitmap()
  const layer2 = border ? $.bitmap() : false

  for (let y = 0; y < height; ++y) {
    for (let x = 0; x < width; ++x) {
      const index = y * width + x
      const alpha = buffer[index]!
      const baseMarkAlpha = baseMarkBuffer[index]!
      const strokeAlpha = strokeBuffer ? strokeBuffer[index]! : 0
      if (alpha || strokeAlpha || baseMarkAlpha) {
        const u = $(x)
        const v = $(y)
        if (!isGroupArea && (alpha || baseMarkAlpha)) layer1.set(u, v) // update interior bitmap
        if (layer2 && (alpha || strokeAlpha)) layer2.set(u, v) // update border bitmap
      }
    }
  }
  return [layer1, layer2]
}

/** The mark container of items that were all read off one mark (vega: `items[0].mark`). */
function containerOf(items: Rec[]): Container | undefined {
  const info = itemMarkOf(items[0])
  return info === undefined ? undefined : { ...(info.container as Rec), marktype: info.marktype, items }
}

// --- util/placeMarkLabel.js -------------------------------------------------

const Aligns = ['right', 'center', 'left']
const Baselines = ['bottom', 'middle', 'top']

interface Entry {
  datum: Rec
  opacity: number
  x: number | undefined
  y: number | undefined
  align: string | undefined
  baseline: string | undefined
  boundary: number[]
  textWidth: number | undefined
}

type Bitmaps = [Bitmap, Bitmap | false | undefined]

function placeMarkLabel($: Scaler, bitmaps: Bitmaps, anchors: Int8Array, offsets: Float64Array): (d: Entry) => boolean {
  const width = $.width
  const height = $.height
  const bm0 = bitmaps[0]
  const bm1 = bitmaps[1]
  const n = offsets.length

  return function (d) {
    const boundary = d.boundary
    const textHeight = d.datum.fontSize as number

    // can not be placed if the mark is not visible in the graph bound
    if (boundary[2]! < 0 || boundary[5]! < 0 || boundary[0]! > width || boundary[3]! > height) return false

    let textWidth = d.textWidth ?? 0

    // for each anchor and offset
    for (let i = 0; i < n; ++i) {
      const dx = (anchors[i]! & 0x3) - 1
      const dy = ((anchors[i]! >>> 0x2) & 0x3) - 1

      const isInside = (dx === 0 && dy === 0) || offsets[i]! < 0
      const sizeFactor = dx && dy ? Math.SQRT1_2 : 1
      const insideFactor = offsets[i]! < 0 ? -1 : 1

      let x1 = boundary[1 + dx]! + offsets[i]! * dx * sizeFactor
      const yc = boundary[4 + dy]! + (insideFactor * textHeight * dy) / 2 + offsets[i]! * dy * sizeFactor
      const y1 = yc - textHeight / 2
      const y2 = yc + textHeight / 2

      let _x1 = $(x1)
      const _y1 = $(y1)
      const _y2 = $(y2)

      if (!textWidth) {
        // to avoid finding width of text label,
        if (!test(_x1, _x1, _y1, _y2, bm0, bm1, isInside)) {
          // skip this anchor/offset option if we fail to place a label with 1px width
          continue
        }
        // Otherwise, find the label width
        textWidth = itemTextWidth(d.datum, d.datum.text as string)
      }

      const xc = x1 + (insideFactor * textWidth * dx) / 2
      x1 = xc - textWidth / 2
      const x2 = xc + textWidth / 2

      _x1 = $(x1)
      const _x2 = $(x2)

      if (test(_x1, _x2, _y1, _y2, bm0, bm1, isInside)) {
        // place label if the position is placeable
        d.x = !dx ? xc : dx * insideFactor < 0 ? x2 : x1
        d.y = !dy ? yc : dy * insideFactor < 0 ? y2 : y1

        d.align = Aligns[dx * insideFactor + 1]
        d.baseline = Baselines[dy * insideFactor + 1]

        bm0.setRange(_x1, _y1, _x2, _y2)
        return true
      }
    }

    return false
  }
}

// Test if a label with the given dimensions can be added without overlap
function test(_x1: number, _x2: number, _y1: number, _y2: number, bm0: Bitmap, bm1: Bitmap | false | undefined, isInside: boolean): boolean {
  return !(bm0.outOfBounds(_x1, _y1, _x2, _y2) || ((isInside && bm1) || bm0).getRange(_x1, _y1, _x2, _y2))
}

// --- util/placeAreaLabel/* --------------------------------------------------

function outOfBounds(x: number, y: number, textWidth: number, textHeight: number, width: number, height: number): boolean {
  let r = textWidth / 2
  return x - r < 0 || x + r > width || y - (r = textHeight / 2) < 0 || y + r > height
}

function collision($: Scaler, x: number, y: number, textHeight: number, textWidth: number, h: number, bm0: Bitmap, bm1: Bitmap | false | undefined): boolean {
  const w = (textWidth * h) / (textHeight * 2)
  const x1 = $(x - w)
  const x2 = $(x + w)
  const y1 = $(y - (h = h / 2))
  const y2 = $(y + h)
  return bm0.outOfBounds(x1, y1, x2, y2) || bm0.getRange(x1, y1, x2, y2) || !!(bm1 && bm1.getRange(x1, y1, x2, y2))
}

/** The sample points of the area mark a label is in: `d.datum.datum.items[markIndex].items`. */
const areaPoints = (d: Entry, markIndex: number): Rec[] => childMarks(d.datum.datum as Rec)[markIndex]!.items as Rec[]

type PlaceArea = ($: Scaler, bitmaps: Bitmaps, avoidBaseMark: boolean, markIndex: number) => (d: Entry) => boolean

const placeAreaLabelNaive: PlaceArea = ($, _bitmaps, _avoidBaseMark, markIndex) => {
  const width = $.width
  const height = $.height

  // try to place a label within an input area mark
  return function (d) {
    const items = areaPoints(d, markIndex)
    const n = items.length
    const textHeight = d.datum.fontSize as number
    const textWidth = itemTextWidth(d.datum, d.datum.text as string)

    let maxAreaWidth = 0
    let x1: number, x2: number, y1: number, y2: number, x: number, y: number

    // for each area sample point
    for (let i = 0; i < n; ++i) {
      x1 = items[i]!.x as number
      y1 = items[i]!.y as number
      x2 = items[i]!.x2 === undefined ? x1 : (items[i]!.x2 as number)
      y2 = items[i]!.y2 === undefined ? y1 : (items[i]!.y2 as number)
      x = (x1 + x2) / 2
      y = (y1 + y2) / 2

      const areaWidth = Math.abs(x2 - x1 + y2 - y1)
      if (areaWidth >= maxAreaWidth) {
        maxAreaWidth = areaWidth
        d.x = x
        d.y = y
      }
    }

    x = textWidth / 2
    y = textHeight / 2
    x1 = d.x! - x
    x2 = d.x! + x
    y1 = d.y! - y
    y2 = d.y! + y

    d.align = 'center'
    if (x1 < 0 && x2 <= width) d.align = 'left'
    else if (0 <= x1 && width < x2) d.align = 'right'

    d.baseline = 'middle'
    if (y1 < 0 && y2 <= height) d.baseline = 'top'
    else if (0 <= y1 && height < y2) d.baseline = 'bottom'

    return true
  }
}

const placeAreaLabelReducedSearch: PlaceArea = ($, bitmaps, avoidBaseMark, markIndex) => {
  const width = $.width
  const height = $.height
  const bm0 = bitmaps[0] // where labels have been placed
  const bm1 = bitmaps[1] // area outlines

  function tryLabel(_x: number, _y: number, maxSize: number, textWidth: number, textHeight: number): [number, number, number, boolean] | undefined {
    const x = $.invert(_x)
    const y = $.invert(_y)
    let lo = maxSize
    let hi = height
    if (
      !outOfBounds(x, y, textWidth, textHeight, width, height) &&
      !collision($, x, y, textHeight, textWidth, lo, bm0, bm1) &&
      !collision($, x, y, textHeight, textWidth, textHeight, bm0, undefined)
    ) {
      // if the label fits at the current sample point,
      // perform binary search to find the largest font size that fits
      while (hi - lo >= 1) {
        const mid = (lo + hi) / 2
        if (collision($, x, y, textHeight, textWidth, mid, bm0, bm1)) hi = mid
        else lo = mid
      }
      // place label if current lower bound exceeds prior max font size
      if (lo > maxSize) return [x, y, lo, true]
    }
    return undefined
  }

  // try to place a label within an input area mark
  return function (d) {
    const items = areaPoints(d, markIndex)
    const n = items.length
    const textHeight = d.datum.fontSize as number
    const textWidth = itemTextWidth(d.datum, d.datum.text as string)

    let maxSize = avoidBaseMark ? textHeight : 0
    let labelPlaced = false
    let labelPlaced2 = false
    let maxAreaWidth = 0
    let x1: number, x2: number, y1: number, y2: number, x: number, y: number

    // for each area sample point
    for (let i = 0; i < n; ++i) {
      x1 = items[i]!.x as number
      y1 = items[i]!.y as number
      x2 = items[i]!.x2 === undefined ? x1 : (items[i]!.x2 as number)
      y2 = items[i]!.y2 === undefined ? y1 : (items[i]!.y2 as number)

      if (x1 > x2) { const t = x1; x1 = x2; x2 = t }
      if (y1 > y2) { const t = y1; y1 = y2; y2 = t }

      const _x1 = $(x1)
      const _x2 = $(x2)
      const _xMid = ~~((_x1 + _x2) / 2)
      const _y1 = $(y1)
      const _y2 = $(y2)
      const _yMid = ~~((_y1 + _y2) / 2)

      // search along the line from mid point between the 2 border to lower border
      for (let _x = _xMid; _x >= _x1; --_x) {
        for (let _y = _yMid; _y >= _y1; --_y) {
          const result = tryLabel(_x, _y, maxSize, textWidth, textHeight)
          if (result) [d.x, d.y, maxSize, labelPlaced] = result
        }
      }

      // search along the line from mid point between the 2 border to upper border
      for (let _x = _xMid; _x <= _x2; ++_x) {
        for (let _y = _yMid; _y <= _y2; ++_y) {
          const result = tryLabel(_x, _y, maxSize, textWidth, textHeight)
          if (result) [d.x, d.y, maxSize, labelPlaced] = result
        }
      }

      // place label at slice center if not placed through other means
      // and if we're not avoiding overlap with other areas
      if (!labelPlaced && !avoidBaseMark) {
        // one span is zero, hence we can add
        const areaWidth = Math.abs(x2 - x1 + y2 - y1)
        x = (x1 + x2) / 2
        y = (y1 + y2) / 2

        // place label if it fits and improves the max area width
        if (areaWidth >= maxAreaWidth && !outOfBounds(x, y, textWidth, textHeight, width, height) && !collision($, x, y, textHeight, textWidth, textHeight, bm0, undefined)) {
          maxAreaWidth = areaWidth
          d.x = x
          d.y = y
          labelPlaced2 = true
        }
      }
    }

    // record current label placement information, update label bitmap
    if (labelPlaced || labelPlaced2) {
      x = textWidth / 2
      y = textHeight / 2
      bm0.setRange($(d.x! - x), $(d.y! - y), $(d.x! + x), $(d.y! + y))
      d.align = 'center'
      d.baseline = 'middle'
      return true
    }
    return false
  }
}

// pixel direction offsets for flood fill search
const X_DIR = [-1, -1, 1, 1]
const Y_DIR = [-1, 1, -1, 1]

const placeAreaLabelFloodFill: PlaceArea = ($, bitmaps, avoidBaseMark, markIndex) => {
  const width = $.width
  const height = $.height
  const bm0 = bitmaps[0] // where labels have been placed
  const bm1 = bitmaps[1] // area outlines
  const bm2 = $.bitmap() // flood-fill visitations

  // try to place a label within an input area mark
  return function (d) {
    const items = areaPoints(d, markIndex)
    const n = items.length
    const textHeight = d.datum.fontSize as number
    const textWidth = itemTextWidth(d.datum, d.datum.text as string)
    const stack: Array<[number, number]> = [] // flood fill stack

    let maxSize = avoidBaseMark ? textHeight : 0
    let labelPlaced = false
    let labelPlaced2 = false
    let maxAreaWidth = 0
    let x1: number, x2: number, y1: number, y2: number, x: number, y: number

    // for each area sample point
    for (let i = 0; i < n; ++i) {
      x1 = items[i]!.x as number
      y1 = items[i]!.y as number
      x2 = items[i]!.x2 === undefined ? x1 : (items[i]!.x2 as number)
      y2 = items[i]!.y2 === undefined ? y1 : (items[i]!.y2 as number)

      // add scaled center point to stack
      stack.push([$((x1 + x2) / 2), $((y1 + y2) / 2)])

      // perform flood fill, visit points
      while (stack.length) {
        const [_x, _y] = stack.pop()!

        // exit if point already marked
        if (bm0.get(_x, _y) || (bm1 && bm1.get(_x, _y)) || bm2.get(_x, _y)) continue

        // mark point in flood fill bitmap
        // add search points for all (in bound) directions
        bm2.set(_x, _y)
        for (let j = 0; j < 4; ++j) {
          x = _x + X_DIR[j]!
          y = _y + Y_DIR[j]!
          if (!bm2.outOfBounds(x, y, x, y)) stack.push([x, y])
        }

        // unscale point back to x, y space
        x = $.invert(_x)
        y = $.invert(_y)
        let lo = maxSize
        let hi = height // TODO: make this bound smaller

        if (
          !outOfBounds(x, y, textWidth, textHeight, width, height) &&
          !collision($, x, y, textHeight, textWidth, lo, bm0, bm1) &&
          !collision($, x, y, textHeight, textWidth, textHeight, bm0, undefined)
        ) {
          // if the label fits at the current sample point,
          // perform binary search to find the largest font size that fits
          while (hi - lo >= 1) {
            const mid = (lo + hi) / 2
            if (collision($, x, y, textHeight, textWidth, mid, bm0, bm1)) hi = mid
            else lo = mid
          }
          // place label if current lower bound exceeds prior max font size
          if (lo > maxSize) {
            d.x = x
            d.y = y
            maxSize = lo
            labelPlaced = true
          }
        }
      }

      // place label at slice center if not placed through other means
      // and if we're not avoiding overlap with other areas
      if (!labelPlaced && !avoidBaseMark) {
        // one span is zero, hence we can add
        const areaWidth = Math.abs(x2 - x1 + y2 - y1)
        x = (x1 + x2) / 2
        y = (y1 + y2) / 2

        // place label if it fits and improves the max area width
        if (areaWidth >= maxAreaWidth && !outOfBounds(x, y, textWidth, textHeight, width, height) && !collision($, x, y, textHeight, textWidth, textHeight, bm0, undefined)) {
          maxAreaWidth = areaWidth
          d.x = x
          d.y = y
          labelPlaced2 = true
        }
      }
    }

    // record current label placement information, update label bitmap
    if (labelPlaced || labelPlaced2) {
      x = textWidth / 2
      y = textHeight / 2
      bm0.setRange($(d.x! - x), $(d.y! - y), $(d.x! + x), $(d.y! + y))
      d.align = 'center'
      d.baseline = 'middle'
      return true
    }
    return false
  }
}

const placeAreaLabel: Record<string, PlaceArea> = {
  naive: placeAreaLabelNaive,
  'reduced-search': placeAreaLabelReducedSearch,
  floodfill: placeAreaLabelFloodFill,
}

// --- LabelLayout.js ---------------------------------------------------------

// 8-bit representation of anchors
const TOP = 0x0
const MIDDLE = 0x4
const BOTTOM = 0x8
const LEFT = 0x0
const CENTER = 0x1
const RIGHT = 0x2

// Mapping from text anchor to number representation
const anchorCode: Record<string, number> = {
  'top-left': TOP + LEFT,
  top: TOP + CENTER,
  'top-right': TOP + RIGHT,
  left: MIDDLE + LEFT,
  middle: MIDDLE + CENTER,
  right: MIDDLE + RIGHT,
  'bottom-left': BOTTOM + LEFT,
  bottom: BOTTOM + CENTER,
  'bottom-right': BOTTOM + RIGHT,
}

const Anchors = ['top-left', 'left', 'bottom-left', 'top', 'bottom', 'top-right', 'right', 'bottom-right']
const Output = ['x', 'y', 'opacity', 'align', 'baseline']

/** What vega reads off the item a label is for: `item.mark.marktype`, `item.bounds`, `item.items`. */
const markType = (item: Rec | undefined): string | undefined => itemMarkOf(item)?.marktype

function getOffsets(_: number[], count: number): Float64Array {
  const offsets = new Float64Array(count)
  const n = _.length
  for (let i = 0; i < n; ++i) offsets[i] = _[i] || 0
  for (let i = n; i < count; ++i) offsets[i] = offsets[n - 1]!
  return offsets
}

function getAnchors(_: string[], count: number): Int8Array {
  const anchors = new Int8Array(count)
  const n = _.length
  for (let i = 0; i < n; ++i) anchors[i]! |= anchorCode[_[i]!]!
  for (let i = n; i < count; ++i) anchors[i] = anchors[n - 1]!
  return anchors
}

/**
 * The base mark boundary, depending on mark and group type. When the mark type is undefined, line or area the boundary is
 * the coordinate of each data point. When the base mark is a grouped line it is the start or end of the line depending on
 * `lineAnchor`. Otherwise it is the bounds of the base mark.
 */
function markBoundary(marktype: string | undefined, grouptype: string | false | undefined, lineAnchor: string, markIndex: number): (d: Rec) => number[] {
  const xy = (d: Rec): number[] => [d.x as number, d.x as number, d.x as number, d.y as number, d.y as number, d.y as number]

  if (!marktype) return xy // no reactive geometry
  if (marktype === 'line' || marktype === 'area') return (d) => xy(d.datum as Rec)
  if (grouptype === 'line') {
    return (d) => {
      const items = childMarks(d.datum as Rec)[markIndex]!.items as Rec[]
      return xy(items.length ? items[lineAnchor === 'start' ? 0 : items.length - 1]! : { x: NaN, y: NaN })
    }
  }
  return (d) => {
    const b = itemMarkOf(d.datum)!.bounds()
    return [b.x1, (b.x1 + b.x2) / 2, b.x2, b.y1, (b.y1 + b.y2) / 2, b.y2]
  }
}

export interface LabelParams {
  size: [number, number]
  sort?: SortSpec
  offset: number[]
  anchor: string[]
  avoidMarks: Container[]
  avoidBaseMark: boolean
  lineAnchor: string
  markIndex: number
  padding: number | null
  method: string
}

export function labelLayout(texts: Rec[], p: LabelParams): Entry[] {
  // early exit for empty data
  if (!texts.length) return []

  const { size, offset, anchor, avoidMarks, avoidBaseMark, lineAnchor, markIndex, method } = p
  let padding = p.padding

  const positions = Math.max(offset.length, anchor.length)
  const offsets = getOffsets(offset, positions)
  const anchors = getAnchors(anchor, positions)
  const marktype = markType(texts[0]!.datum as Rec | undefined)
  const grouptype = marktype === 'group' && childMarks(texts[0]!.datum as Rec)[markIndex]!.marktype
  const isGroupArea = grouptype === 'area'
  const boundary = markBoundary(marktype, grouptype, lineAnchor, markIndex)
  const infPadding = padding === null || padding === Infinity
  const isNaiveGroupArea = isGroupArea && method === 'naive'

  let maxTextWidth = -1
  let maxTextHeight = -1

  // prepare text mark data for placing
  const data: Entry[] = texts.map((d) => {
    const textWidth = infPadding ? itemTextWidth(d, d.text as string) : undefined
    maxTextWidth = Math.max(maxTextWidth, textWidth as number)
    maxTextHeight = Math.max(maxTextHeight, d.fontSize as number)
    return { datum: d, opacity: 0, x: undefined, y: undefined, align: undefined, baseline: undefined, boundary: boundary(d), textWidth }
  })

  padding = padding === null || padding === Infinity ? Math.max(maxTextWidth, maxTextHeight) + maxOf(offset) : padding
  const $ = scaler(size[0], size[1], padding)

  let bitmaps: Bitmaps | undefined
  if (!isNaiveGroupArea) {
    // sort labels in priority order, if comparator is provided
    if (p.sort) {
      const sort = p.sort
      sortData(data, (a, b) => compareRows(a.datum as Row, b.datum as Row, sort))
    }

    // flag indicating if label can be placed inside its base mark
    let labelInside = false
    for (let i = 0; i < anchors.length && !labelInside; ++i) {
      // label inside if anchor is at center
      // label inside if offset to be inside the mark bound
      labelInside = anchors[i] === 0x5 || offsets[i]! < 0
    }

    // extract data information from base mark when base mark is to be avoided
    // base mark is implicitly avoided if it is a group area
    const baseMark = ((marktype && avoidBaseMark) || isGroupArea) && texts.map((d) => d.datum as Rec)

    // generate bitmaps for layout calculation
    bitmaps = avoidMarks.length || baseMark ? markBitmaps($, baseMark || [], avoidMarks, labelInside, isGroupArea) : baseBitmaps($, avoidBaseMark && data)
  }

  // generate label placement function
  const place = isGroupArea ? placeAreaLabel[method]!($, bitmaps!, avoidBaseMark, markIndex) : placeMarkLabel($, bitmaps!, anchors, offsets)

  // place all labels
  for (const d of data) d.opacity = +place(d)

  return data
}

// --- Label.js ---------------------------------------------------------------

const maxOf = (values: readonly number[]): number => {
  let m = -Infinity
  for (const v of values) if (v > m) m = v
  return m
}

const array = <T>(v: T | T[]): T[] => (Array.isArray(v) ? v : [v])

/**
 * The `label` transform over the text items (a text mark's items, or a dataset's tuples): writes `as` on each. The mark
 * containers it avoids come from the transform context (`marks`).
 */
function labelRows(rows: Row[], t: Rec, ctx: TransformContext): Row[] {
  const size = resolveSizeParam(t.size, ctx)
  if (!size || size.length !== 2) throw new Error('Size parameter should be specified as a [width, height] array.')
  if (!rows.length) return rows

  const as = (t.as as string[] | undefined) ?? Output
  const avoidNames = array((t.avoidMarks as string[] | undefined) ?? [])
  const avoidMarks: Container[] = []
  for (const name of avoidNames) {
    const c = ctx.marks?.(name) as Container | undefined
    if (c !== undefined) avoidMarks.push(c)
  }

  const entries = labelLayout(rows, {
    size,
    ...(t.sort ? { sort: t.sort as SortSpec } : {}),
    offset: array(t.offset == null ? 1 : (t.offset as number | number[])),
    anchor: array((t.anchor as string[] | undefined) ?? Anchors),
    avoidMarks,
    avoidBaseMark: t.avoidBaseMark !== false,
    lineAnchor: (t.lineAnchor as string | undefined) || 'end',
    markIndex: (t.markIndex as number | undefined) || 0,
    padding: t.padding === undefined ? 0 : (t.padding as number | null),
    method: (t.method as string | undefined) || 'naive',
  })

  // write the layout to the tuples (a mark's items are written in place: they are vega's tuples)
  const out = ctx.inPlace ? rows : rows.map((r) => ({ ...r }))
  const at = ctx.inPlace ? null : new Map<Rec, Row>(rows.map((r, i) => [r, out[i]!]))
  for (const l of entries) {
    const target = at === null ? l.datum : at.get(l.datum)!
    target[as[0]!] = l.x
    target[as[1]!] = l.y
    target[as[2]!] = l.opacity
    target[as[3]!] = l.align
    target[as[4]!] = l.baseline
  }
  return out
}

transformRegistry.set('label', labelRows)
