/**
 * What vega-label draws into its offscreen canvases: the items of a mark, the way vega-scenegraph's canvas renderer draws them
 * (`Marks[type].draw(context, {items})`), reduced to what decides whether a pixel has any alpha: where the path is, whether
 * it is filled and / or stroked, with what width, cap, join and dash, and the alpha of the paint (opacity x fill / stroke
 * opacity x the colour's own). Gradients and patterns paint opaque. This is the same geometry as `canvas.ts` (the scene's
 * canvas renderer, which this add-on cannot import: a lite chart's bundle must not hold the canvas renderer, and it reaches
 * this module through the lazily loaded transforms add-on) -- the label tests draw the same marks through vega's own draw.
 */
import { SYMBOL_DEFAULT_SIZE } from './util.js'
import type { SceneGroup, SceneItem } from './types.js'
import { parsePathData, tracePath } from './path-data.js'
import { arcInto, computeAreaPath, computeLinePath, rectItemPath, symbolPath, textItemDesc, trailPath } from './render.js'
import { fontString } from './text-metrics.js'
import type { AlphaCanvas } from './raster.js'

type Rec = Record<string, unknown>

const present = (paint: unknown): boolean => paint != null && paint !== false && paint !== 'transparent' && paint !== ''
const colour = (paint: unknown): string => (typeof paint === 'string' && !paint.startsWith('url(') ? paint : '#000')

/** vega-scenegraph `fill` then `stroke` of an item over the path just traced on the context. */
function paint(ctx: AlphaCanvas, it: SceneItem, op: 'auto' | 'stroke' = 'auto'): void {
  const opacity = it.opacity == null ? 1 : (it.opacity as number)
  if (opacity === 0) return
  const rec = it as unknown as Rec
  if (op === 'auto' && present(it.fill)) {
    const a = opacity * (it.fillOpacity == null ? 1 : (it.fillOpacity as number))
    if (a > 0) {
      ctx.globalAlpha = a
      ctx.fillStyle = colour(it.fill)
      ctx.fill()
    }
  }
  if (present(it.stroke)) {
    const lw = it.strokeWidth != null ? (it.strokeWidth as number) : 1
    const a = opacity * (it.strokeOpacity == null ? 1 : (it.strokeOpacity as number))
    if (lw > 0 && a > 0) {
      ctx.globalAlpha = a
      ctx.strokeStyle = colour(it.stroke)
      ctx.lineWidth = lw
      ctx.lineCap = (rec.strokeCap as string | undefined) || 'butt'
      ctx.lineJoin = (rec.strokeJoin as string | undefined) || 'miter'
      ctx.miterLimit = rec.strokeMiterLimit != null ? (rec.strokeMiterLimit as number) : 4
      ctx.setLineDash((rec.strokeDash as number[] | undefined) ?? [])
      ctx.lineDashOffset = (rec.strokeDashOffset as number | undefined) || 0
      ctx.stroke()
      ctx.setLineDash([])
    }
  }
  ctx.globalAlpha = 1
}

/** Trace a frame (translate, rotate, scale) around a path, as the canvas does for items with an angle. */
function inFrame(ctx: AlphaCanvas, x: number, y: number, angle: number, sx: number, sy: number, build: () => void): void {
  ctx.save()
  ctx.translate(x, y)
  if (angle) ctx.rotate((angle * Math.PI) / 180)
  if (sx !== 1 || sy !== 1) ctx.scale(sx, sy)
  ctx.beginPath()
  build()
  ctx.restore()
}

/** Draw the items of one mark (`group.items`, `group.marktype`) onto the coverage context. */
export function drawMark(group: SceneGroup, ctx: AlphaCanvas): void {
  const items = (group.items ?? []) as SceneItem[]
  switch (group.marktype) {
    case 'line': {
      const info = computeLinePath(group, true)
      if (!info) return
      ctx.beginPath()
      tracePath(ctx, parsePathData(info.path))
      // vega draws a line mark from its first item, the stroke width defaulting to 2 with a stroke
      paint(ctx, { ...items[0]!, strokeWidth: info.sw ?? items[0]!.strokeWidth } as SceneItem)
      return
    }
    case 'area': {
      const info = computeAreaPath(group, true)
      if (!info) return
      ctx.beginPath()
      tracePath(ctx, parsePathData(info.path))
      paint(ctx, items[0]!)
      return
    }
    case 'symbol':
      for (const it of items) {
        const rec = it as unknown as Rec
        const x = it.x || 0
        const y = it.y || 0
        const r = Math.sqrt((it.size as number) ?? SYMBOL_DEFAULT_SIZE) / 2
        const segs = parsePathData(symbolPath(rec.shape as string | undefined, r))
        const angle = (rec.angle as number) || 0
        if (angle) inFrame(ctx, x, y, angle, 1, 1, () => tracePath(ctx, segs))
        else { ctx.beginPath(); tracePath(ctx, segs, x, y) }
        paint(ctx, it)
      }
      return
    case 'circle':
      for (const it of items) {
        if (it.x == null || it.y == null) continue
        const r = it.radius != null ? it.radius : Math.sqrt((it.size as number) ?? SYMBOL_DEFAULT_SIZE) / 2
        ctx.beginPath()
        ctx.arc(it.x, it.y, r, 0, 2 * Math.PI, false)
        paint(ctx, it)
      }
      return
    case 'rect':
      // vega paints rects in item order and skips unpainted items
      for (const it of items) {
        if (it.fill == null && it.stroke == null) continue
        const d = rectItemPath(it)
        if (d == null) continue
        ctx.beginPath()
        tracePath(ctx, parsePathData(d))
        paint(ctx, it)
      }
      return
    case 'rule':
      for (const it of items) {
        if (it.stroke == null) continue
        const x = it.x ?? 0
        const y = it.y ?? 0
        ctx.beginPath()
        ctx.moveTo(x, y)
        ctx.lineTo(it.x2 ?? x, it.y2 ?? y)
        paint(ctx, it, 'stroke')
      }
      return
    case 'trail': {
      if (items.length <= 1) return
      const d = trailPath(items)
      if (!d) return
      ctx.beginPath()
      tracePath(ctx, parsePathData(d))
      paint(ctx, items[0]!)
      return
    }
    case 'path':
    case 'shape':
    case 'geoshape': {
      // (only a path mark parses a path string: vega draws its arcs as beziers; a shape's geo path goes to the context directly)
      const arcs = group.marktype === 'path' ? 'bezier' : 'exact'
      for (const it of items) {
        if (!it.path) continue
        const rec = it as unknown as Rec
        const segs = parsePathData(it.path)
        inFrame(ctx, it.x || 0, it.y || 0, (rec.angle as number) || 0, (rec.scaleX as number) || 1, (rec.scaleY as number) || 1, () => tracePath(ctx, segs, 0, 0, arcs))
        paint(ctx, it)
      }
      return
    }
    case 'arc':
      for (const it of items) {
        const rec = it as unknown as Rec
        const ax = it.x || 0
        const ay = it.y || 0
        const angle = (rec.angle as number | undefined) || 0
        ctx.translate(ax, ay)
        if (angle) ctx.rotate((angle * Math.PI) / 180)
        ctx.beginPath()
        arcInto(ctx, 0, 0, (it.outerRadius as number) ?? (it.radius as number) ?? 0, (it.innerRadius as number) ?? 0, (it.startAngle as number) ?? 0, (it.endAngle as number) ?? 0, (rec.cornerRadius as number | undefined) ?? 0, (rec.padAngle as number | undefined) ?? 0)
        if (angle) ctx.rotate((-angle * Math.PI) / 180)
        ctx.translate(-ax, -ay)
        paint(ctx, it)
      }
      return
    case 'text':
      for (const it of items) text(ctx, it)
      return
    default:
      // (an image paints once its bitmap is loaded, which a layout never waits for)
      return
  }
}

/** vega-scenegraph's canvas text draw: the box of each line (glyph coverage is not modelled, see `AlphaCanvas.fillText`). */
function text(ctx: AlphaCanvas, it: SceneItem): void {
  const opacity = it.opacity == null ? 1 : (it.opacity as number)
  if (opacity === 0 || (it as unknown as Rec).fontSize as number <= 0) return
  const d = textItemDesc(it)
  if (d == null || it.text == null || (typeof it.text === 'string' && it.text.length === 0)) return
  ctx.save()
  ctx.font = fontString(it as never)
  ctx.textAlign = it.align || 'left'
  ctx.textBaseline = 'alphabetic'
  let x = d.px
  let y = d.py
  if (d.angle) {
    ctx.translate(d.px, d.py)
    ctx.rotate((d.angle * Math.PI) / 180)
    x = d.ox
    y = d.oy
  }
  for (let i = 0; i < d.lines.length; i++) {
    const ly = i === 0 ? y : y + i * d.lineHeight
    if (present(it.fill)) {
      const a = opacity * (it.fillOpacity == null ? 1 : (it.fillOpacity as number))
      if (a > 0) {
        ctx.globalAlpha = a
        ctx.fillStyle = colour(it.fill)
        ctx.fillText(d.lines[i]!, x, ly)
      }
    }
    if (present(it.stroke)) {
      const lw = it.strokeWidth != null ? (it.strokeWidth as number) : 1
      const a = opacity * (it.strokeOpacity == null ? 1 : (it.strokeOpacity as number))
      if (lw > 0 && a > 0) {
        ctx.globalAlpha = a
        ctx.strokeStyle = colour(it.stroke)
        ctx.strokeText(d.lines[i]!, x, ly)
      }
    }
  }
  ctx.restore()
}
