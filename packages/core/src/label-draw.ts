/**
 * The marks a `label` layout keeps its labels off, drawn onto the coverage-only canvas of `raster.ts`: after this, a pixel with
 * any alpha is a pixel a label may not cover. Only what decides that is drawn: the path of each item, whether it is filled and /
 * or stroked, the stroke's width, cap, join and dash, and the alpha of the paint (the item's opacity, its fill or stroke opacity
 * and the colour's own). A gradient or a pattern paints opaque. An image is not drawn: a layout never waits for one to load.
 *
 * The geometry is the one the scene's canvas renderer (`canvas.ts`) draws. That renderer is not imported here: a lite chart's bundle
 * must not hold it, and this module is reached through the lazily loaded transforms add-on.
 */
import type { AlphaCanvas } from './raster.js'
import { parsePathData, tracePath } from './path-data.js'
import { arcInto, computeAreaPath, computeLinePath, rectItemPath, symbolPath, textItemDesc, trailPath } from './render.js'
import { fontString } from './text-metrics.js'
import type { SceneGroup, SceneItem } from './types.js'
import { SYMBOL_DEFAULT_SIZE } from './util.js'

/** An item as the painters read it: the scene's fields and the two scale factors of a path. */
type Drawn = SceneItem & { scaleX?: number; scaleY?: number }

const isPainted = (paint: unknown): boolean => paint != null && paint !== false && paint !== 'transparent' && paint !== ''
/** The colour a canvas is given for a paint: the paint itself, or opaque black for a gradient or a pattern. */
const colourOf = (paint: unknown): string => (typeof paint === 'string' && !paint.startsWith('url(') ? paint : '#000')

/** The alpha an item fills and strokes with (0: not at all) and the width it strokes with. */
function inkOf(item: Drawn, width = item.strokeWidth ?? 1): { fill: number; stroke: number; width: number } {
  const opacity = item.opacity ?? 1
  return {
    fill: isPainted(item.fill) ? opacity * (item.fillOpacity ?? 1) : 0,
    stroke: isPainted(item.stroke) && width > 0 ? opacity * (item.strokeOpacity ?? 1) : 0,
    width,
  }
}

/** Fill, then stroke, the path last traced on `pen`. */
function ink(pen: AlphaCanvas, item: Drawn, opts: { fill?: boolean; width?: number } = {}): void {
  const { fill, stroke, width } = inkOf(item, opts.width)
  if (opts.fill !== false && fill > 0) {
    pen.globalAlpha = fill
    pen.fillStyle = colourOf(item.fill)
    pen.fill()
  }
  if (stroke > 0) {
    pen.globalAlpha = stroke
    pen.strokeStyle = colourOf(item.stroke)
    pen.lineWidth = width
    pen.lineCap = item.strokeCap || 'butt'
    pen.lineJoin = item.strokeJoin || 'miter'
    pen.miterLimit = item.strokeMiterLimit ?? 4
    pen.setLineDash(item.strokeDash ?? [])
    pen.lineDashOffset = item.strokeDashOffset || 0
    pen.stroke()
    pen.setLineDash([])
  }
  pen.globalAlpha = 1
}

/** Trace a path inside a frame (translated, then rotated, then scaled), as a canvas does for an item with an angle. */
function inFrame(pen: AlphaCanvas, x: number, y: number, degrees: number, sx: number, sy: number, trace: () => void): void {
  pen.save()
  pen.translate(x, y)
  if (degrees) pen.rotate((degrees * Math.PI) / 180)
  if (sx !== 1 || sy !== 1) pen.scale(sx, sy)
  pen.beginPath()
  trace()
  pen.restore()
}

/** A mark painter: draws the `items` of `group` (a mark's container). */
type Painter = (pen: AlphaCanvas, items: Drawn[], group: SceneGroup) => void

/** A path string as a path on the pen, and the item painted over it. */
function inkPath(pen: AlphaCanvas, d: string, item: Drawn, opts?: { fill?: boolean; width?: number }): void {
  pen.beginPath()
  tracePath(pen, parsePathData(d))
  ink(pen, item, opts)
}

const byType: Record<string, Painter> = {
  // one path for the whole mark, painted as its first item is
  line: (pen, items, group) => {
    const line = computeLinePath(group, true)
    // (a line with a stroke and no width strokes 2 wide)
    if (line) inkPath(pen, line.path, items[0]!, { width: line.sw ?? items[0]!.strokeWidth })
  },
  area: (pen, items, group) => {
    const area = computeAreaPath(group, true)
    if (area) inkPath(pen, area.path, items[0]!)
  },
  trail: (pen, items) => {
    const d = items.length > 1 ? trailPath(items) : ''
    if (d) inkPath(pen, d, items[0]!)
  },

  symbol: (pen, items) => {
    for (const it of items) {
      const half = Math.sqrt(it.size ?? SYMBOL_DEFAULT_SIZE) / 2
      const segs = parsePathData(symbolPath(it.shape, half))
      const x = it.x || 0
      const y = it.y || 0
      if (it.angle) inFrame(pen, x, y, it.angle, 1, 1, () => tracePath(pen, segs))
      else {
        pen.beginPath()
        tracePath(pen, segs, x, y)
      }
      ink(pen, it)
    }
  },
  circle: (pen, items) => {
    for (const it of items) {
      if (it.x == null || it.y == null) continue
      pen.beginPath()
      pen.arc(it.x, it.y, it.radius ?? Math.sqrt(it.size ?? SYMBOL_DEFAULT_SIZE) / 2, 0, 2 * Math.PI, false)
      ink(pen, it)
    }
  },
  rect: (pen, items) => {
    for (const it of items) {
      if (it.fill == null && it.stroke == null) continue
      const d = rectItemPath(it)
      if (d != null) inkPath(pen, d, it)
    }
  },
  rule: (pen, items) => {
    for (const it of items) {
      if (it.stroke == null) continue
      const x = it.x ?? 0
      const y = it.y ?? 0
      pen.beginPath()
      pen.moveTo(x, y)
      pen.lineTo(it.x2 ?? x, it.y2 ?? y)
      ink(pen, it, { fill: false })
    }
  },
  arc: (pen, items) => {
    for (const it of items) {
      const x = it.x || 0
      const y = it.y || 0
      const degrees = it.angle || 0
      pen.translate(x, y)
      if (degrees) pen.rotate((degrees * Math.PI) / 180)
      pen.beginPath()
      arcInto(pen, 0, 0, it.outerRadius ?? it.radius ?? 0, it.innerRadius ?? 0, it.startAngle ?? 0, it.endAngle ?? 0, it.cornerRadius ?? 0, it.padAngle ?? 0)
      if (degrees) pen.rotate((-degrees * Math.PI) / 180)
      pen.translate(-x, -y)
      ink(pen, it)
    }
  },
  text: (pen, items) => {
    for (const it of items) inkText(pen, it)
  },
}

/** A path mark's arcs are cubic beziers, as a canvas draws them; the path of a shape or a geoshape goes to the canvas as it is. */
const pathPainter = (arcs: 'bezier' | 'exact'): Painter => (pen, items) => {
  for (const it of items) {
    if (!it.path) continue
    const segs = parsePathData(it.path)
    inFrame(pen, it.x || 0, it.y || 0, it.angle || 0, it.scaleX || 1, it.scaleY || 1, () => tracePath(pen, segs, 0, 0, arcs))
    ink(pen, it)
  }
}
byType.path = pathPainter('bezier')
byType.shape = byType.geoshape = pathPainter('exact')
const painters = new Map(Object.entries(byType))

/** A text item: the box of each of its lines (glyph coverage is not modelled, see `AlphaCanvas.fillText`). */
function inkText(pen: AlphaCanvas, it: Drawn): void {
  const { fill, stroke } = inkOf(it)
  if (it.opacity === 0 || (it.fontSize as number) <= 0) return
  const desc = textItemDesc(it)
  if (desc == null || it.text == null || it.text === '') return
  pen.save()
  pen.font = fontString(it as never)
  pen.textAlign = it.align || 'left'
  pen.textBaseline = 'alphabetic'
  let x = desc.px
  let y = desc.py
  if (desc.angle) {
    pen.translate(desc.px, desc.py)
    pen.rotate((desc.angle * Math.PI) / 180)
    x = desc.ox
    y = desc.oy
  }
  desc.lines.forEach((line, i) => {
    const baseline = i === 0 ? y : y + i * desc.lineHeight
    if (fill > 0) {
      pen.globalAlpha = fill
      pen.fillStyle = colourOf(it.fill)
      pen.fillText(line, x, baseline)
    }
    if (stroke > 0) {
      pen.globalAlpha = stroke
      pen.strokeStyle = colourOf(it.stroke)
      pen.strokeText(line, x, baseline)
    }
  })
  pen.restore()
}

/** Draw the items of one mark (`group.items` of kind `group.marktype`) onto the coverage canvas. */
export function drawMark(group: SceneGroup, pen: AlphaCanvas): void {
  painters.get(group.marktype as string)?.(pen, (group.items ?? []) as Drawn[], group)
}
