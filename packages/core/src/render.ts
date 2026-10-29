/**
 * Scene -> SVG serializer. Mirrors vega-scenegraph's output structure closely
 * enough that geometry (paths, rects, lines, tick positions) matches the
 * reference renderer; the conformance diff compares normalized geometry.
 */
import { SYMBOL_DEFAULT_SIZE } from './util.js'
import type { SceneDef, SceneGroup, SceneItem, SceneRoot } from './types.js'
import { baselineOffset, fontSize as vegaFontSize } from './bounds.js'
import { checkPathLength, metering } from './limits.js'
export { baselineOffset }
import { itemTextWidth } from './text-metrics.js'
import { ClipCollector, gradientRef, isGradientPaint, type ClipDef } from './svg-defs.js'
import { customSymbolPathData } from './svg-path.js'
import { sanitizeHref } from './url-policy.js'
import { imageBox, imageHref, itemImage } from './image-box.js'
import type { ScaleSnapshots } from './guide-caption.js'
export { ClipCollector, type ClipDef }
import {
  line as d3Line,
  area as d3Area,
  curveLinear,
  curveBasis,
  curveBasisClosed,
  curveBasisOpen,
  curveBundle,
  curveCardinal,
  curveCardinalClosed,
  curveCardinalOpen,
  curveCatmullRom,
  curveCatmullRomClosed,
  curveCatmullRomOpen,
  curveLinearClosed,
  curveMonotoneX,
  curveMonotoneY,
  curveNatural,
  curveStep,
  curveStepAfter,
  curveStepBefore,
  Path,
} from './shape.js'

/**
 * Path data built only from `num`/`num3` output (or d3 `Path`, which coerces
 * every coordinate with unary plus) and constant command letters: it cannot
 * contain markup-significant characters, so `genD` writes it without the
 * escaping scan. Anything not produced by one of the generators below (item
 * `path` fields, clip paths from a scene) is plain `string` and must go through
 * `escAttr`; the brand makes passing it to `genD` a type error.
 */
export type GeneratedPath = string & { readonly __generatedPath: true }
const gen = (s: string): GeneratedPath => s as GeneratedPath
// Every generated `d` (line/area/trail/arc/symbol/...) is written through an
// AttrSink's `g()` (string AND DOM output share the `*Attrs` functions), which
// calls this, so maxPathLength is enforced on the exact string at the one place
// it is produced (C49). With no limits scope active it is one boolean load.
const genD = (d: GeneratedPath): string => { if (metering) checkPathLength(d); return d }

/**
 * Map Vega interpolation names to d3-shape curve constructors.
 * Matches vega-scenegraph/src/path/curves.js.
 */
const CURVE_MAP: Record<string, unknown> = {
  'basis': curveBasis,
  'basis-closed': curveBasisClosed,
  'basis-open': curveBasisOpen,
  'bundle': curveBundle,
  'cardinal': curveCardinal,
  'cardinal-closed': curveCardinalClosed,
  'cardinal-open': curveCardinalOpen,
  'catmull-rom': curveCatmullRom,
  'catmull-rom-closed': curveCatmullRomClosed,
  'catmull-rom-open': curveCatmullRomOpen,
  'linear': curveLinear,
  'linear-closed': curveLinearClosed,
  'monotone-x': curveMonotoneX,
  'monotone-y': curveMonotoneY,
  'natural': curveNatural,
  'step': curveStep,
  'step-after': curveStepAfter,
  'step-before': curveStepBefore,
}

// vega-scenegraph path/shapes.js: the generators are built once; each call sets its curve (and digits) and runs it
const itemX = (d: unknown): number => ((d as SceneItem).x as number) || 0
const itemY = (d: unknown): number => ((d as SceneItem).y as number) || 0
const itemXW = (d: unknown): number => (((d as SceneItem).x as number) || 0) + (((d as SceneItem).width as number) || 0)
const itemYH = (d: unknown): number => (((d as SceneItem).y as number) || 0) + (((d as SceneItem).height as number) || 0)
const itemDefined = (d: unknown): boolean => !((d as SceneItem).defined === false)
const lineShape = d3Line().x(itemX).y(itemY).defined(itemDefined)
const areaVShape = d3Area().x(itemX).y1(itemY).y0(itemYH).defined(itemDefined)
const areaHShape = d3Area().y(itemY).x1(itemX).x0(itemXW).defined(itemDefined)

/**
 * vega-scenegraph path/curves.js: the d3-shape curve named by an `interpolate` value (`monotone` follows the
 * orientation; `bundle` / `cardinal*` / `catmull-rom*` take the tension as beta / tension / alpha). An absent
 * or unknown name is the linear curve.
 */
function vegaCurve(interpolate: string | undefined, orient: string | undefined, tension: number | undefined): unknown {
  const type = interpolate || 'linear'
  let curve: unknown
  if (type === 'monotone') curve = orient === 'horizontal' ? curveMonotoneY : curveMonotoneX
  else if (Object.hasOwn(CURVE_MAP, type)) curve = CURVE_MAP[type]
  else return curveLinear
  if (tension != null) {
    const cf = curve as Record<string, ((v: number) => unknown) | undefined>
    const name = TENSION_PARAM[type]
    if (name !== undefined && typeof cf[name] === 'function') curve = cf[name]!(tension)
  }
  return curve
}
const TENSION_PARAM: Record<string, string> = {
  'bundle': 'beta',
  'cardinal': 'tension', 'cardinal-open': 'tension', 'cardinal-closed': 'tension',
  'catmull-rom': 'alpha', 'catmull-rom-open': 'alpha', 'catmull-rom-closed': 'alpha',
}

/** Vega-scenegraph's rounded-rect path (C = 0.448084975506 bezier circle). */
function roundedFramePath(x: number, y: number, w: number, h: number, r: number): GeneratedPath {
  const c = 0.448084975506
  const kr1 = r * (1 - c)
  const f = (v: number) => String(Math.round(v * 1000) / 1000)
  const x1 = x + r, y1 = y
  const x2 = x + w - r, y2 = y
  const x3 = x + w, y3 = y + r
  const x4 = x + w, y4 = y + h - r
  const x5 = x + w - r, y5 = y + h
  const x6 = x + r, y6 = y + h
  const x7 = x, y7 = y + h - r
  const x8 = x, y8 = y + r
  return gen(`M${f(x1)},${f(y1)}L${f(x2)},${f(y2)}C${f(x2 + kr1)},${f(y2)},${f(x3)},${f(y3 - kr1)},${f(x3)},${f(y3)}`
    + `L${f(x4)},${f(y4)}C${f(x4)},${f(y4 + kr1)},${f(x5 + kr1)},${f(y5)},${f(x5)},${f(y5)}`
    + `L${f(x6)},${f(y6)}C${f(x6 - kr1)},${f(y6)},${f(x7)},${f(y7 + kr1)},${f(x7)},${f(y7)}`
    + `L${f(x8)},${f(y8)}C${f(x8)},${f(y8 - kr1)},${f(x1 - kr1)},${f(y1)},${f(x1)},${f(y1)}Z`)
}

/**
 * The root frame's background path. Shared by the SVG, DOM and canvas painters
 * so the frame's fill, stroke and rounded corners cannot drift between them.
 */
export function frameBackgroundPath(scene: SceneRoot, plotW0: number, plotH0: number): GeneratedPath {
  // vega's rectangle path reads `item.width || 0` / `item.height || 0`: a view size that is NaN draws a zero-size frame
  const plotW = plotW0 || 0
  const plotH = plotH0 || 0
  const frameInset = scene.frameStroke && scene.frameStrokeWidth == null ? 0.5 : 0
  return scene.frameCornerRadius != null && scene.frameCornerRadius > 0
    ? roundedFramePath(frameInset, frameInset, plotW, plotH, Math.min(scene.frameCornerRadius, plotW / 2, plotH / 2))
    : gen(frameInset ? `M0.5,0.5h${num(plotW)}v${num(plotH)}h-${num(plotW)}Z` : `M0,0h${num(plotW)}v${num(plotH)}h-${num(plotW)}Z`)
}

/**
 * The root frame's paint as an item, so the frame's background path goes through
 * the same paint list (`paintAttrs`) as every mark: fill, fill-opacity, stroke,
 * stroke-opacity/width/linecap/linejoin/dasharray/dashoffset/miterlimit, opacity.
 * Shared by the SVG, DOM and canvas painters.
 */
export function frameItem(scene: SceneRoot): SceneItem {
  return {
    fill: scene.frameFill || undefined,
    fillOpacity: scene.frameFillOpacity,
    stroke: scene.frameStroke === 'transparent' ? undefined : scene.frameStroke ?? undefined,
    strokeOpacity: scene.frameStrokeOpacity,
    strokeWidth: scene.frameStrokeWidth,
    strokeCap: scene.frameStrokeCap,
    strokeJoin: scene.frameStrokeJoin,
    strokeDash: scene.frameStrokeDash,
    strokeDashOffset: scene.frameStrokeDashOffset,
    strokeMiterLimit: scene.frameStrokeMiterLimit,
    opacity: scene.frameOpacity,
  } as SceneItem
}

export function renderSceneToSvg(scene: SceneRoot): string {
  const w = new StringAttrSink()

  let out = ''
  svgRootAttrs(scene, w)
  out += `<svg${w.s}>`
  if (scene.background) {
    w.s = ''
    backgroundRectAttrs(scene, w)
    out += `<rect${w.s}/>`
  }
  w.s = ''
  viewGroupAttrs(scene, w)
  out += `<g${w.s}>`
  out += `<g class="mark-group role-frame root" role="graphics-object" aria-roledescription="group mark container"><g transform="translate(${num(scene.frameX ?? 0)},${num(scene.frameY ?? 0)})">`
  const { plotW, plotH } = scenePlotSize(scene)
  w.s = ''
  frameAttrs(scene, w)
  out += `<path${w.s}/>`
  // Clip regions are registered while rendering; ids are content-addressed
  // (see svg-defs.ts) so they are deterministic and cannot collide across charts.
  const clips = new ClipCollector()
  const frameClipId = scene.frameClip ? clips.id({ x: 0, y: 0, w: plotW, h: plotH }) : null
  if (frameClipId) {
    w.s = ''
    clipRefAttrs(frameClipId, w)
    out += `<g${w.s}>`
  } else out += '<g>'
  out += serializeNodes(childNodes(scene.items, plotW, plotH, { snaps: scene.__scales }, clips), clips)
  out += '</g>'
  out += '<path class="foreground" aria-hidden="true" d="" display="none"/>'
  out += '</g></g></g>'

  // Emit defs at SVG root level (gradients + clip paths)
  if (scene.defs?.length || clips.size > 0) {
    out += '<defs>'
    for (const def of scene.defs ?? []) {
      const tag = def.kind === 'radial' ? 'radialGradient' : 'linearGradient'
      if (def.kind === 'radial') {
        // (vega wraps a radial gradient in a pattern: an SVG radial gradient is in bounding-box units, a canvas one is circular)
        w.s = ''
        w.v('id', 'p_' + def.id); w.v('viewBox', '0,0,1,1'); w.v('width', '100%'); w.v('height', '100%'); w.v('preserveAspectRatio', 'xMidYMid slice')
        out += `<pattern${w.s}>`
        w.s = ''
        w.v('width', '1'); w.v('height', '1'); w.v('fill', `url(#${def.id})`)
        out += `<rect${w.s}/></pattern>`
      }
      w.s = ''
      gradientAttrs(def, w)
      out += `<${tag}${w.s}>`
      for (const stop of def.colorStops) {
        w.s = ''
        stopAttrs(stop, w)
        out += `<stop${w.s}/>`
      }
      out += `</${tag}>`
    }
    for (const [id, def] of clips.defs) {
      w.s = ''
      clipIdAttrs(id, w)
      const idAttrs = w.s
      w.s = ''
      const kind = clipShapeAttrs(def, w)
      out += `<clipPath${idAttrs}><${kind}${w.s}/></clipPath>`
    }
    out += '</defs>'
  }

  out += '</svg>'
  return out
}

/**
 * A data mark (rect, symbol, line...): its container `<g>` holding one element per item (or one for the whole mark).
 * `frameW`/`frameH` is the frame of the group that contains the mark: what its `clip` clips to.
 */
function renderMark(group: SceneGroup, frameW: number, frameH: number, clips: ClipCollector): string {
  const type = group.marktype
  if (!type) return ''
  // Vega-Lite rounds bars by wrapping each bar in a clipped scope. Vega's
  // SVG renderer keeps that group structure, so reproduce it here for rect
  // marks carrying per-item corner radii.
  if (type === 'rect' && isClippedRoundedRectGroup(group)) {
    return renderClippedRoundedRects(group, clips)
  }
  const w = new StringAttrSink()
  if (!markContainerAttrs(group, w, markClipId(group, clips, frameW, frameH))) return ''
  return switchMarkup(type, group, `<g${w.s}>`)
}

function switchMarkup(type: string, group: SceneGroup, open: string): string {
  switch (type) {
    case 'line': return renderLine(group, open)
    case 'area': return renderArea(group, open)
    case 'symbol': return renderSymbols(group, open)
    case 'circle': return renderCircles(group, open)
    case 'rect': return renderRects(group, open)
    case 'rule': return renderRules(group, open)
    case 'text': return renderTexts(group, open)
    case 'trail': return renderTrail(group, open)
    case 'path': return renderPaths(group, open)
    case 'shape': return renderPaths(group, open)
    case 'geoshape': return renderPaths(group, open)
    case 'image': return renderImages(group, open)
    case 'arc': return renderArcs(group, open)
    default: return ''
  }
}

function isGroup(item: SceneItem): item is SceneGroup {
  return (item as SceneGroup).marktype !== undefined || Array.isArray((item as SceneGroup).items)
}

/** Render an anchor leaf shape (path, symbol, text, line). */
function renderLeaf(it: SceneItem, clips?: ClipCollector, wrapClip = true): string {
  const w = new StringAttrSink()
  // Path items
  if (it.path != null) {
    // A clipped legend symbol (clipHeight): the clip hangs on a `<g>` around the
    // path, never on the translated `<path>` itself (see leafClipId).
    const clipId = clips && wrapClip ? leafClipId(it, clips) : null
    leafPathAttrs(it, w)
    const el = `<path${w.s}/>`
    if (!clipId) return el
    w.s = ''
    clipRefAttrs(clipId, w)
    return `<g${w.s}>${el}</g>`
  }
  // Symbol items (shape path; 'circle' renders the arc form)
  if (it.shape != null && it.radius != null) {
    symbolElementAttrs(it, leafSymbolPath(it), w)
    return `<path${w.s}/>`
  }
  if (it._kind === 'text' || (it._kind === undefined && it.text != null)) return textElement(it)
  const [x1, y1, x2, y2] = leafLineEnds(it)
  itemDatumAttr(it, w)
  lineElementAttrs(x1, y1, x2, y2, it, w)
  return `<line${w.s}/>`
}

function itemsOf(group: SceneGroup): SceneItem[] {
  return group.items ?? []
}

function renderLine(group: SceneGroup, open: string): string {
  const items = itemsOf(group)
  let out = open
  const pathInfo = computeLinePath(group)
  if (pathInfo) {
    const w = new StringAttrSink()
    lineMarkAttrs(pathInfo, w)
    // a line is one element for the whole mark: its link is the first item's
    const a = items.length ? linkOpen(items[0]!) : ''
    out += `${a}<path${w.s}/>${linkClose(a)}`
  } else if (items.length) {
    // no drawable point: vega still emits the mark's one element, without a `d` (its aria-label stays)
    const w = new StringAttrSink()
    pathlessMarkAttrs('line', items[0]!, w)
    out += `<path${w.s}/>`
  }
  out += '</g>'
  return out
}

/**
 * Shared line-path geometry for the string renderer and the DOM patcher.
 * `exact` serializes full-precision coordinates (vega's canvas draws a line
 * from the unrounded numbers; only its SVG `d` is rounded to 3 decimals): the
 * canvas backend passes it, the SVG paths never do.
 */
export function computeLinePath(group: SceneGroup, exact = false): {
  path: GeneratedPath
  stroke?: string
  sw?: number
  strokeDash?: number[]
  opacity?: number
  fillOpacity?: number
  fill?: string
  /** Vega styles a line from `items[0]`: its paint is the path's paint. */
  first: SceneItem
} | null {
  const n3 = exact ? num : num3
  const digits = exact ? null : 3
  const items = itemsOf(group)
  if (!items.length) return null

  // vega-scenegraph path/shapes.js: d3's line generator over the items, `x(item) = item.x || 0`, `y` likewise,
  // `defined(item) = !(item.defined === false)`, the curve named by the first item's `interpolate` (a gap is
  // the curve's own lineEnd / lineStart, not a closed sub-path)
  const firstItem = items[0] as Record<string, unknown> | undefined
  const curve = vegaCurve(firstItem?.interpolate as string | undefined, firstItem?.orient as string | undefined, firstItem?.tension as number | undefined)
  const path = (lineShape.digits(digits).curve(curve as never)(items as never) ?? '') as string

  if (!path) return null
  const stroke = group.items?.[0]?.stroke as string | undefined
  const strokeWidth = group.items?.[0]?.strokeWidth as number | undefined
  const opacity = group.items?.[0]?.opacity as number | undefined
  const strokeDash = group.items?.[0]?.strokeDash as number[] | undefined
  const fillOpacity = group.items?.[0]?.fillOpacity as number | undefined
  // Vega default: line marks have strokeWidth=2
  const sw = strokeWidth ?? (stroke != null ? 2 : undefined)
  return {
    path: gen(path),
    stroke,
    sw,
    strokeDash,
    opacity,
    fillOpacity,
    fill: (items[0] as Record<string, unknown> | undefined)?.fill as string | undefined,
    first: items[0]!,
  }
}

/** Shared area-path geometry for the string renderer and the DOM patcher; `exact` as for {@link computeLinePath}. */
export function computeAreaPath(group: SceneGroup, exact = false): {
  path: GeneratedPath
  fill?: string | { gradient: string }
  fillOpacity?: number
  stroke?: string | { gradient: string }
  strokeWidth?: number
  strokeOpacity?: number
  opacity?: number
  strokeDash?: string
  /** Vega styles an area from `items[0]`: its paint is the path's paint. */
  first: SceneItem
} | null {
  const n3 = exact ? num : num3
  const digits = exact ? null : 3
  const items = itemsOf(group)

  // vega-scenegraph path/shapes.js: d3's area generator, `x(item) = item.x || 0`, the baseline `y + height` (or, for a
  // horizontal area, `x + width`), `defined(item) = !(item.defined === false)`, the curve named by the first item
  const firstItem = items[0] as Record<string, unknown> | undefined
  const curve = vegaCurve(firstItem?.interpolate as string | undefined, firstItem?.orient as string | undefined, firstItem?.tension as number | undefined)
  const shape = firstItem?.orient === 'horizontal' ? areaHShape : areaVShape
  const path = (shape.digits(digits).curve(curve as never)(items as never) ?? '') as string

  if (!path) return null
  return {
    path: gen(path),
    fill: items[0]?.fill as string | { gradient: string } | undefined,
    fillOpacity: items[0]?.fillOpacity as number | undefined,
    stroke: items[0]?.stroke as string | { gradient: string } | undefined,
    strokeWidth: items[0]?.strokeWidth as number | undefined,
    strokeOpacity: items[0]?.strokeOpacity as number | undefined,
    opacity: items[0]?.opacity as number | undefined,
    strokeDash: items[0]?.strokeDash as string | undefined,
    first: items[0]!,
  }
}

function renderArea(group: SceneGroup, open: string): string {
  const info = computeAreaPath(group)
  let out = open
  if (info) {
    const w = new StringAttrSink()
    areaMarkAttrs(info, w)
    const first = itemsOf(group)[0]
    const a = first ? linkOpen(first) : ''
    out += `${a}<path${w.s}/>${linkClose(a)}`
  } else if (itemsOf(group).length) {
    const w = new StringAttrSink()
    pathlessMarkAttrs('area', itemsOf(group)[0]!, w)
    out += `<path${w.s}/>`
  }
  out += '</g>'
  return out
}

/** Generate an SVG path d attribute for a given symbol shape and radius. */
export const symbolPath = ((shape: string | undefined, r: number) => symbolPathImpl(shape, r)) as (shape: string | undefined, r: number) => GeneratedPath

/**
 * The same symbol geometry with full-precision coordinates. vega's Bound pass
 * traces the shape's draw calls exactly (the 3-decimal rounding belongs to the
 * serialized `d` only), so anything that measures a symbol must use this.
 */
export function symbolPathExact(shape: string | undefined, r: number): string {
  return symbolPathImpl(shape, r, String)
}

const HALF_SQRT3 = Math.sqrt(3) / 2 // vega util/constants HalfSqrt3

function symbolPathImpl(shape: string | undefined, r: number, num: (x: number) => string = num3): string {
  // vega symbols serialize through d3-path Path(3) — coordinates round to 3
  // (the bound pass traces the same shape unrounded: see symbolPathExact).
  // vega: `symbols(item.shape || 'circle')`
  switch (shape || 'circle') {
    case 'square':
      return `M${num(-r)},${num(-r)}h${num(2 * r)}v${num(2 * r)}h${num(-2 * r)}Z`
    case 'cross': {
      const s = r / 2.5
      return [
        `M${num(-r)},${num(-s)}`,
        `L${num(-r)},${num(s)}`,
        `L${num(-s)},${num(s)}`,
        `L${num(-s)},${num(r)}`,
        `L${num(s)},${num(r)}`,
        `L${num(s)},${num(s)}`,
        `L${num(r)},${num(s)}`,
        `L${num(r)},${num(-s)}`,
        `L${num(s)},${num(-s)}`,
        `L${num(s)},${num(-r)}`,
        `L${num(-s)},${num(-r)}`,
        `L${num(-s)},${num(-s)}`,
        'Z',
      ].join('')
    }
    case 'diamond':
      return `M${num(-r)},0L0,${num(-r)}L${num(r)},0L0,${num(r)}Z`
    case 'triangle-up': {
      const h = r * HALF_SQRT3
      return `M0,${num(-h)}L${num(-r)},${num(h)}L${num(r)},${num(h)}Z`
    }
    case 'triangle-down': {
      const h = r * HALF_SQRT3
      return `M0,${num(h)}L${num(-r)},${num(-h)}L${num(r)},${num(-h)}Z`
    }
    case 'triangle-right': {
      const h = r * HALF_SQRT3
      return `M${num(h)},0L${num(-h)},${num(-r)}L${num(-h)},${num(r)}Z`
    }
    case 'triangle-left': {
      const h = r * HALF_SQRT3
      return `M${num(-h)},0L${num(h)},${num(-r)}L${num(h)},${num(r)}Z`
    }
    case 'stroke':
      return `M${num(-r)},0L${num(r)},0`
    case 'arrow': {
      const st = r / 7
      const t = r / 2.5
      const v = r / 8
      return [
        `M${num(-st)},${num(r)}`,
        `L${num(st)},${num(r)}`,
        `L${num(st)},${num(-v)}`,
        `L${num(t)},${num(-v)}`,
        'L0,' + num(-r),
        `L${num(-t)},${num(-v)}`,
        `L${num(-st)},${num(-v)}`,
        'Z',
      ].join('')
    }
    case 'wedge': {
      const h = r * Math.sqrt(3) / 2
      const o = h - r * (Math.sqrt(3) / 3)
      const b = r / 4
      return `M0,${num(-h - o)}L${num(-b)},${num(h - o)}L${num(b)},${num(h - o)}Z`
    }
    case 'triangle': {
      const h = r * Math.sqrt(3) / 2
      const o = h - r * (Math.sqrt(3) / 3)
      return `M0,${num(-h - o)}L${num(-r)},${num(h - o)}L${num(r)},${num(h - o)}Z`
    }
    case 'circle':
      // d3-symbol's circle through a canvas arc: the arcs only render for a
      // truthy radius, so with r=0 the path degenerates to its moveTo
      // ('M0,0') and with r=NaN to 'MNaN,0' — matching vega's renderer.
      return r > 0
        ? `M${num(r)},0A${num(r)},${num(r)},0,1,1,${num(-r)},0A${num(r)},${num(r)},0,1,1,${num(r)},0`
        : r === 0 ? 'M0,0' : `M${num(r)},0`
    default:
      // vega `symbols(name)`: any other name is a custom SVG path, parsed and
      // scaled by sqrt(size)/2 (svg-path.ts); the result is built from numbers
      // and command letters only, so no input text reaches the document.
      // An invalid path throws vega's "Invalid SVG path" error, like vega.
      return customSymbolPathData(shape!, r, num)
  }
}

function renderSymbols(group: SceneGroup, open: string): string {
  const links = group.hasLinks === true
  let out = open
  const w = new StringAttrSink()
  for (const it of itemsOf(group)) {
    // A null position (a geopoint the projection refused) renders at the
    // origin: vega emits `translate(null,null)`, which SVG treats as (0,0).
    // Vega-Lite: point marks default fill="transparent", stroke from scale or
    // default; `attr` omits a transparent fill (the SVG default for paths).
    // The strokeWidth default (2px for the point/circle/square styles) is baked
    // into the item at mark-build time; a raw vega symbol mark with a stroke but
    // no style carries no default width. Rotation: vega's symbol attr emits
    // rotateItem(item) — full-precision numbers plus the mark's rotation.
    w.s = ''
    symbolElementAttrs(it, symbolMarkPath(it), w)
    out += links ? withLink(it, `<path${w.s}/>`) : `<path${w.s}/>`
  }
  out += '</g>'
  return out
}

/** The `d` of a symbol mark item (its `size` is an area; `shape` defaults to a circle). */
export function symbolMarkPath(it: SceneItem): GeneratedPath {
  const size = (it.size as number) ?? SYMBOL_DEFAULT_SIZE
  return symbolPath(recOf(it).shape as string | undefined, Math.sqrt(size) / 2)
}

/** Circle mark: renders `<circle cx cy r>` elements (radius from `radius` or size). */
function renderCircles(group: SceneGroup, open: string): string {
  const links = group.hasLinks === true
  let out = open
  const w = new StringAttrSink()
  for (const it of itemsOf(group)) {
    if (it.x == null || it.y == null) continue
    w.s = ''
    circleAttrs(it, w)
    out += links ? withLink(it, `<circle${w.s}/>`) : `<circle${w.s}/>`
  }
  out += '</g>'
  return out
}

export function hasRectCorner(it: SceneItem): boolean {
  const rec = it as Record<string, unknown>
  return rec.cornerRadius !== undefined
    || rec.cornerRadiusTopLeft !== undefined || rec.cornerRadiusTopRight !== undefined
    || rec.cornerRadiusBottomLeft !== undefined || rec.cornerRadiusBottomRight !== undefined
}

/** Split a rect item into its normalized origin and positive width/height. */
export function rectGeometry(it: SceneItem): { x: number; y: number; w: number; h: number } | null {
  let w = it.width
  let h = it.height
  let x = (it.x as number | undefined) ?? 0
  let y = (it.y as number | undefined) ?? 0
  if (w == null && it.x2 != null) { w = Math.abs((it.x2 as number) - x); x = Math.min(x, it.x2 as number) }
  if (h == null && it.y2 != null) { h = Math.abs((it.y2 as number) - y); y = Math.min(y, it.y2 as number) }
  return w == null || h == null ? null : { x, y, w, h }
}

/** True for a rect mark whose rounded bars vega wraps in clipped scopes (see renderClippedRoundedRects). */
export function isClippedRoundedRectGroup(group: SceneGroup): boolean {
  return (group.items ?? []).some((it) => hasRectCorner(it as SceneItem) && (it as unknown as { clip?: boolean }).clip === true)
}

export type RoundedRectEntry =
  | { kind: 'plain'; item: SceneItem; d: GeneratedPath }
  | { kind: 'scope'; item: SceneItem; g: { x: number; y: number; w: number; h: number }; round: GeneratedPath; plain: GeneratedPath }

/**
 * vega-scenegraph's clipped rounded-rect scopes for bar corner radii, in item
 * order (vega's scene keeps data order and every renderer paints front to back). A 'scope' entry wraps one bar in its own clipped
 * scope (the consumer registers its clip when it emits it); a 'plain'
 * entry is a bar without corners.
 */
export function clippedRoundedRectEntries(group: SceneGroup): RoundedRectEntry[] {
  const out: RoundedRectEntry[] = []
  for (const it of itemsOf(group)) {
    if (it.fill == null && it.stroke == null) continue
    const g = rectGeometry(it)
    if (!g) continue
    if (!hasRectCorner(it) || (it as unknown as { clip?: boolean }).clip !== true) {
      const d = rectItemPath(it)
      if (d != null) out.push({ kind: 'plain', item: it, d })
      continue
    }
    const round = rectItemPath({ ...it, x: 0, y: 0, width: g.w, height: g.h } as SceneItem)
    if (round == null) continue
    out.push({ kind: 'scope', item: it, g, round, plain: gen(`M0,${num(g.y)}h${num(g.w)}v${num(g.h)}h${num(-g.w)}Z`) })
  }
  return out
}

function renderClippedRoundedRects(group: SceneGroup, clips: ClipCollector): string {
  const links = group.hasLinks === true
  let out = ''
  const w = new StringAttrSink()
  for (const e of clippedRoundedRectEntries(group)) {
    w.s = ''
    if (e.kind === 'plain') {
      rectPathAttrs(e.item, e.d, w, false)
      out += links ? withLink(e.item, `<path${w.s}/>`) : `<path${w.s}/>`
      continue
    }
    const clipId = clips.id({ d: e.round })
    out += `<g transform="translate(${num(e.g.x)},${num(e.g.y)})">`
    out += `<path class="background" aria-hidden="true" d="${genD(e.round)}"/>`
    w.s = ''
    clipRefAttrs(clipId, w)
    out += `<g${w.s}><g class="mark-group role-scope" role="graphics-object" aria-roledescription="group mark container"><g transform="translate(0,${num(-e.g.y)})">`
    out += `<path class="background" aria-hidden="true" d="M0,0h${num(e.g.w)}v0h-${num(e.g.w)}Z"/>`
    w.s = ''
    rectPathAttrs(e.item, e.plain, w)
    const a = group.hasLinks === true ? linkOpen(e.item) : ''
    out += `<g><g class="mark-rect role-mark marks" role="graphics-object" aria-roledescription="rect mark container">${a}<path${w.s}/>${linkClose(a)}</g></g>`
    out += `<path class="foreground" aria-hidden="true" d="" display="none"/></g></g></g>`
    out += `<path class="foreground" aria-hidden="true" d="" display="none"/></g>`
  }
  return out
}

function renderRects(group: SceneGroup, open: string): string {
  const links = group.hasLinks === true
  let out = open
  const w = new StringAttrSink()
  for (const it of itemsOf(group)) {
    if (!rectIsPainted(it)) continue
    const d = rectItemPath(it)
    if (d == null) continue
    w.s = ''
    rectPathAttrs(it, d, w)
    out += links ? withLink(it, `<path${w.s}/>`) : `<path${w.s}/>`
  }
  out += '</g>'
  return out
}

/**
 * Shared rect geometry for the string renderer and the DOM patcher.
 * Vega renders rect marks as path elements (with optional cornerRadius).
 * Never null for a rect item: an unsized one is a zero-size path (vega).
 */
export const rectItemPath = rectItemPathImpl as (it: SceneItem) => GeneratedPath | null

function rectItemPathImpl(it: SceneItem): string | null {
  let w = it.width
  let h = it.height
  // Vega-scenegraph renders rects with undefined positions at (0,0)
  // (`item.x || 0`, `item.y || 0`), so default missing x/y to 0 rather than
  // dropping the rect.
  let x0 = (it.x as number | undefined) || 0
  let y0 = (it.y as number | undefined) || 0
  // When x2/y2 are present, vega normalizes the rect so that x is the min
  // edge and width is positive (same for y). This keeps the path winding
  // consistent (positive h first) regardless of which edge is "x" vs "x2".
  // A non-finite x2/y2 (a NaN scale result) gives a NaN extent and leaves the origin where it is:
  // `Math.min(x0, NaN)` would turn the origin itself into NaN.
  if (w == null && it.x2 != null) { w = Math.abs((it.x2 as number) - x0); if (Number.isFinite(it.x2)) x0 = Math.min(x0, it.x2 as number) }
  if (h == null && it.y2 != null) { h = Math.abs((it.y2 as number) - y0); if (Number.isFinite(it.y2)) y0 = Math.min(y0, it.y2 as number) }
  // vega draws every rect item, an unsized one as a zero-size path at its origin
  // (`item.width || 0`, `item.height || 0`), e.g. a scale that returned nothing for y2
  if (w == null) w = 0
  if (h == null) h = 0
  // Vega's rectangle path builders read `item.width || 0` and `item.height || 0`:
  // a NaN scale result (a degenerate range, e.g. `range: "symbol"` on a band
  // scale) renders a zero-size rect at the origin, not a `NaN` path.
  if (!Number.isFinite(w)) w = 0
  if (!Number.isFinite(h)) h = 0
  // Vega's rounded-rect path builder (vega-scenegraph/path/rectangle.js):
  // per-corner radii clamped to min(w,h)/2, quarter arcs approximated by
  // cubics with C = 0.448084975506.
  const rec = it as Record<string, unknown>
  const cr = rec.cornerRadius
  const s = Math.min(w, h) / 2
  // vega (marks' `tl`..`bl` accessors, then `clamp(+radius, 0, s)`): a corner falls back to
  // `cornerRadius`, a falsy radius is 0, anything else is read with unary plus -- so a non-numeric
  // radius ("round") is NaN, which is NOT "no corner": the path is the rounded one, in NaNs.
  const clampR = (v: unknown) => Math.max(0, Math.min(+(((v ?? cr) as number) || 0), s))
  const tl = clampR(rec.cornerRadiusTopLeft)
  const tr = clampR(rec.cornerRadiusTopRight)
  const br = clampR(rec.cornerRadiusBottomRight)
  const bl = clampR(rec.cornerRadiusBottomLeft)
  if (!(tl <= 0 && tr <= 0 && bl <= 0 && br <= 0)) {
    const C = 0.448084975506
    const x2 = x0 + w
    const y2 = y0 + h
    return `M${num(x0 + tl)},${num(y0)}L${num(x2 - tr)},${num(y0)}`
      + `C${num(x2 - C * tr)},${num(y0)},${num(x2)},${num(y0 + C * tr)},${num(x2)},${num(y0 + tr)}`
      + `L${num(x2)},${num(y2 - br)}`
      + `C${num(x2)},${num(y2 - C * br)},${num(x2 - C * br)},${num(y2)},${num(x2 - br)},${num(y2)}`
      + `L${num(x0 + bl)},${num(y2)}`
      + `C${num(x0 + C * bl)},${num(y2)},${num(x0)},${num(y2 - C * bl)},${num(x0)},${num(y2 - bl)}`
      + `L${num(x0)},${num(y0 + tl)}`
      + `C${num(x0)},${num(y0 + C * tl)},${num(x0 + C * tl)},${num(y0)},${num(x0 + tl)},${num(y0)}Z`
  }
  return `M${num(x0)},${num(y0)}h${num(w)}v${num(h)}h${num(-w)}Z`
}

function renderRules(group: SceneGroup, open: string): string {
  const links = group.hasLinks === true
  let out = open
  const w = new StringAttrSink()
  for (const it of itemsOf(group)) {
    // Vega defaults undefined x/y to 0 (scenegraph item defaults), so even
    // degenerate rules with unresolved fields render as zero-length lines at
    // the origin rather than being skipped.
    const [x, y, x2, y2] = ruleEnds(it)
    w.s = ''
    itemDatumAttr(it, w)
    lineElementAttrs(x, y, x2, y2, it, w)
    out += links ? withLink(it, `<line${w.s}/>`) : `<line${w.s}/>`
  }
  out += '</g>'
  return out
}

function renderTexts(group: SceneGroup, open: string): string {
  const links = group.hasLinks === true
  let out = open
  for (const it of itemsOf(group)) {
    const el = textElement(it)
    if (el === '') continue
    out += links ? withLink(it, el) : el
  }
  out += '</g>'
  return out
}

/**
 * One `<text>` element, exactly vega-scenegraph's text markup: first line as
 * the element content and each following line as `<tspan x="0" dy="lineHeight">`
 * (svg.js `textLines`); a single line is a plain text node. Shared by mark text
 * and guide labels so they cannot drift.
 */
function textElement(it: SceneItem): string {
  const w = new StringAttrSink()
  const d = textAttrs(it, w)
  if (d == null) return ''
  let inner = ''
  if (d.lines.length === 1) {
    inner = escText(d.text)
  } else {
    for (let i = 0; i < d.lines.length; i++) {
      inner += i === 0
        ? `<tspan>${escText(d.lines[i]!)}</tspan>`
        : `<tspan x="0" dy="${num(d.lineHeight)}">${escText(d.lines[i]!)}</tspan>`
    }
  }
  return `<text${w.s}>${inner}</text>`
}

/** Split a text item into lines the way vega-scenegraph's `textLines` does. */
function textLinesOf(it: SceneItem): string[] {
  const raw = it.text as unknown
  const lineBreak = (it as Record<string, unknown>).lineBreak as string | undefined
  if (Array.isArray(raw)) {
    return raw.length > 1 ? raw.map((l) => String(l).trim()) : [String(raw[0] ?? '').trim()]
  }
  const text = raw == null ? '' : String(raw)
  if (lineBreak && text) return text.split(lineBreak).map((l) => l.trim())
  return [text.trim()]
}

/** vega-scenegraph `textAlign`: left/center/right -> start/middle/end; anything else is `start`. */
export function svgTextAnchor(align: unknown): 'start' | 'middle' | 'end' {
  return align === 'center' ? 'middle' : align === 'right' ? 'end' : 'start'
}

/**
 * Shared text geometry for the string renderer, the DOM patcher and the canvas
 * painter, following vega-scenegraph's text mark (`marks/text.js` attr):
 *
 *   unrotated: transform = translate(x + dx, y + dy + baselineOffset)
 *   rotated:   transform = translate(x, y) rotate(angle) [translate(dx, dy + baselineOffset)]
 *
 * plus text-anchor (`start` unless align is center/right) and the always-present
 * font attributes (SVGStringRenderer `style()`: font-family defaults to
 * sans-serif, font-size to 11px). Returns null for items with no text.
 */
export function textItemDesc(it: SceneItem): {
  /** SVG `transform` attribute value (numbers and constants only). */
  transform: GeneratedPath
  /** Resolved font size (vega default 11). */
  fontSize: number
  text: string
  /** Rendered lines after split/truncate; length > 1 means tspans follow. */
  lines: string[]
  lineHeight: number
  /** Canvas placement: translate target, then the in-frame offset (after rotate). */
  px: number
  py: number
  ox: number
  oy: number
  angle: number
} | null {
  const rec = it as Record<string, unknown>
  const fontSize = vegaFontSize(it)
  // vega writes the angle as it is (`rotate(` + angle + `)` whenever it is truthy), so a word is a word in the
  // document; the geometry (canvas, hit testing, bounds) reads the number it coerces to
  const angleRaw = it.angle as unknown
  const angle = +(angleRaw as number) || 0
  const dx = +(rec.dx as number) || 0
  const dy = (+(rec.dy as number) || 0) + baselineOffset(it)
  // vega anchorPoint: polar text offsets the anchor by (radius, theta - pi/2)
  let x = +(it.x as number) || 0
  let y = +(it.y as number) || 0
  const radius = +(rec.radius as number) || 0
  if (radius) {
    const t = ((+(rec.theta as number) || 0)) - Math.PI / 2
    x += radius * Math.cos(t)
    y += radius * Math.sin(t)
  }
  const lines = textLinesOf(it).map((l) => truncateToLimit(it, l, fontSize))
  const lineHeight = rec.lineHeight != null ? (rec.lineHeight as number) : fontSize + 2
  let transform: GeneratedPath
  let px: number, py: number, ox: number, oy: number
  if (angleRaw) {
    transform = gen(`translate(${num(x)},${num(y)}) rotate(${angleText(angleRaw)})${dx || dy ? ` translate(${num(dx)},${num(dy)})` : ''}`)
    px = x; py = y; ox = dx; oy = dy
  } else {
    transform = gen(`translate(${num(x + dx)},${num(y + dy)})`)
    px = x + dx; py = y + dy; ox = 0; oy = 0
  }
  return { transform, fontSize, text: lines[0]!, lines, lineHeight, px, py, ox, oy, angle }
}

/**
 * Vega text `limit`: maximum pixel width, truncated with an ellipsis.
 * Mirrors vega-scenegraph/src/util/text.js `truncate()` — canvas-measured
 * when a canvas exists, the headless estimate otherwise (see text-metrics).
 */
function truncateToLimit(it: SceneItem, text: string, fontSize: number): string {
  const limit = (it as Record<string, unknown>).limit as number | undefined
  if (limit == null || !(limit > 0) || !text.length) return text
  const estimateW = (s: string) => itemTextWidth(it, s)
  if (estimateW(text) < limit) return text
  const ellipsis = ((it as Record<string, unknown>).ellipsis as string | undefined) ?? '\u2026'
  const lim = limit - estimateW(ellipsis)
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = 1 + ((lo + hi) >>> 1)
    if (estimateW(text.slice(0, mid)) < lim) lo = mid
    else hi = mid - 1
  }
  return text.slice(0, lo) + ellipsis
}

function renderPaths(group: SceneGroup, open: string): string {
  const links = group.hasLinks === true
  let out = open
  const w = new StringAttrSink()
  for (const it of itemsOf(group)) {
    // (an item whose path is empty is still a `<path>`, with no `d`: vega draws one element per item)
    // Position the path at its item x/y (vega renders path marks with a
    // translate transform; items whose path already encodes absolute
    // coordinates (e.g. geoshape output) have x=y=0 and emit no transform).
    w.s = ''
    pathItemAttrs(it, w, group.marktype === 'geoshape' ? 'shape' : group.marktype)
    out += links ? withLink(it, `<path${w.s}/>`) : `<path${w.s}/>`
  }
  out += '</g>'
  return out
}

/**
 * Trail mark: a line whose width varies along its length (per-item `size`).
 * Vega renders the trail as a single tapered polygon path (per pair of
 * consecutive points a closed segment: two perpendicular edge offsets plus
 * semicircular arcs around each endpoint), stroked with the first item's
 * stroke/strokeWidth. This mirrors vega's trail shape algorithm (d3-trail).
 */
function renderTrail(group: SceneGroup, open: string): string {
  const links = group.hasLinks === true
  let out = open
  const items = itemsOf(group)
  if (items.length > 1) {
    const d = trailPath(items)
    if (d) {
      const first = items[0]!
      const w = new StringAttrSink()
      trailAttrs(d, first, w)
      out += links ? withLink(first, `<path${w.s}/>`) : `<path${w.s}/>`
    }
  }
  out += '</g>'
  return out
}

/** Compute the vega/d3-trail polygon path for a run of trail items. */
export function trailPath(items: SceneItem[]): GeneratedPath {
  // vega-scenegraph path/trail.js, through the d3-path buffer (full precision: its stringifier emits JS number
  // strings): x and y are `item.x || 0`, the size `item.size || 1`, an item with `defined === false` ends the run.
  const context = new Path()
  let ready = false
  let x1 = 0, y1 = 0, r1 = 0
  const point = (x2: number, y2: number, w2: number): void => {
    const r2 = w2 / 2
    if (ready) {
      let ux = y1 - y2
      let uy = x2 - x1
      if (ux || uy) {
        // get normal vector
        const ud = Math.hypot(ux, uy)
        const rx = (ux /= ud) * r1
        const ry = (uy /= ud) * r1
        const t = Math.atan2(uy, ux)
        // draw segment
        context.moveTo(x1 - rx, y1 - ry)
        context.lineTo(x2 - ux * r2, y2 - uy * r2)
        context.arc(x2, y2, r2, t - Math.PI, t)
        context.lineTo(x1 + rx, y1 + ry)
        context.arc(x1, y1, r1, t, t + Math.PI)
      } else {
        context.arc(x2, y2, r2, 0, 2 * Math.PI)
      }
      context.closePath()
    } else {
      ready = true
    }
    x1 = x2
    y1 = y2
    r1 = r2
  }
  const n = items.length
  let defined0 = false
  for (let i = 0; i <= n; ++i) {
    const it = items[i]
    if (!(i < n && !(it!.defined === false)) === defined0) {
      if (defined0 = !defined0) ready = false
    }
    if (defined0) point(+((it!.x as number) || 0), +((it!.y as number) || 0), +((it!.size as number) || 1))
  }
  return gen(context + '')
}

function renderImages(group: SceneGroup, open: string): string {
  const links = group.hasLinks === true
  let out = open
  const w = new StringAttrSink()
  for (const it of itemsOf(group)) {
    if ((it.url == null && itemImage(it) == null) || it.x == null || it.y == null) continue
    w.s = ''
    imageAttrs(it, w)
    out += links ? withLink(it, `<image${w.s}/>`) : `<image${w.s}/>`
  }
  out += '</g>'
  return out
}

/**
 * vega image mark geometry (marks/image.js): the box is offset by the item's
 * align (center/right) and baseline (middle/bottom); an absent width/height is
 * 0 (the loaded bitmap's natural size is not known here).
 */
const IMAGE_PIXELATED = ['image-rendering: optimizeSpeed;', 'image-rendering: pixelated;'] as const

export function imageDesc(it: SceneItem): { x: number; y: number; w: number; h: number; smooth: boolean } {
  return { ...imageBox(it), smooth: (it as Record<string, unknown>).smooth !== false }
}

function renderArcs(group: SceneGroup, open: string): string {
  const links = group.hasLinks === true
  let out = open
  const w = new StringAttrSink()
  for (const it of itemsOf(group)) {
    w.s = ''
    arcItemAttrs(it, w)
    out += links ? withLink(it, `<path${w.s}/>`) : `<path${w.s}/>`
  }
  out += '</g>'
  return out
}

/**
 * d3-arc port (d3-shape/src/arc.js): the annular-sector path with padAngle
 * and cornerRadius, emitted around (0,0) — vega translates per item. The
 * emitter mirrors d3-path (moveTo/lineTo/arc with large-arc/sweep flags) so
 * the rounding matches the reference renderer exactly.
 */
const ARC_EPSILON = 1e-12

class PathEmitter {
  private s = ''
  private x1 = 0
  private y1 = 0
  private hasPoint = false
  // d3-path Path(3): coordinates round to 3 decimals on emit.
  moveTo(x: number, y: number): void { this.s += `M${num3(x)},${num3(y)}`; this.x1 = x; this.y1 = y; this.hasPoint = true }
  lineTo(x: number, y: number): void { this.s += `L${num3(x)},${num3(y)}`; this.x1 = x; this.y1 = y; this.hasPoint = true }
  arc(x: number, y: number, r: number, a0: number, a1: number, ccw = false): void {
    const x0 = x + r * Math.cos(a0)
    const y0 = y + r * Math.sin(a0)
    if (!this.hasPoint) this.moveTo(x0, y0)
    else if (Math.abs(this.x1 - x0) > ARC_EPSILON || Math.abs(this.y1 - y0) > ARC_EPSILON) this.lineTo(x0, y0)
    if (!(r > ARC_EPSILON)) return
    // d3-path: da folds the wrap; a complete circle draws two arcs through the
    // antipode; large-arc uses >= PI.
    let da = ccw ? a0 - a1 : a1 - a0
    if (da < 0) da = (da % (2 * Math.PI)) + 2 * Math.PI
    const sweep = ccw ? 0 : 1
    const x2 = x + r * Math.cos(a1)
    const y2 = y + r * Math.sin(a1)
    if (da > 2 * Math.PI - ARC_EPSILON) {
      // complete circle: two half arcs through the antipode
      this.s += `A${num3(r)},${num3(r)},0,1,${sweep},${num3(x - (x0 - x))},${num3(y - (y0 - y))}`
      this.s += `A${num3(r)},${num3(r)},0,1,${sweep},${num3(x0)},${num3(y0)}`
      this.x1 = x0; this.y1 = y0
    } else if (da > ARC_EPSILON) {
      this.s += `A${num3(r)},${num3(r)},0,${da >= Math.PI ? 1 : 0},${sweep},${num3(x2)},${num3(y2)}`
      this.x1 = x2; this.y1 = y2
    }
  }
  closePath(): void { if (this.s) this.s += 'Z' }
  toString(): string { return this.s }
}

function cornerTangents(x0: number, y0: number, x1: number, y1: number, r1: number, rc: number, cw: boolean): { cx: number; cy: number; x01: number; y01: number; x11: number; y11: number } {
  const x01 = x0 - x1
  const y01 = y0 - y1
  const lo = (cw ? rc : -rc) / Math.sqrt(x01 * x01 + y01 * y01)
  const ox = lo * y01
  const oy = -lo * x01
  const x11 = x0 + ox
  const y11 = y0 + oy
  const x10 = x1 + ox
  const y10 = y1 + oy
  const x00 = (x11 + x10) / 2
  const y00 = (y11 + y10) / 2
  const dx = x10 - x11
  const dy = y10 - y11
  const d2 = dx * dx + dy * dy
  const r = r1 - rc
  const D = x11 * y10 - x10 * y11
  const d = (dy < 0 ? -1 : 1) * Math.sqrt(Math.max(0, r * r * d2 - D * D))
  let cx0 = (D * dy - dx * d) / d2
  let cy0 = (-D * dx - dy * d) / d2
  const cx1 = (D * dy + dx * d) / d2
  const cy1 = (-D * dx + dy * d) / d2
  const dx0 = cx0 - x00
  const dy0 = cy0 - y00
  const dx1 = cx1 - x00
  const dy1 = cy1 - y00
  if (dx0 * dx0 + dy0 * dy0 > dx1 * dx1 + dy1 * dy1) { cx0 = cx1; cy0 = cy1 }
  return { cx: cx0, cy: cy0, x01: -ox, y01: -oy, x11: cx0 * (r1 / r - 1), y11: cy0 * (r1 / r - 1) }
}

const arcAbs = Math.abs
const arcAcos = Math.acos
const arcAtan2 = Math.atan2
// d3-shape math.js asin clamps to +/-halfPi (needed for padAngle > span).
const arcAsin = (x: number): number => (x > 1 ? Math.PI / 2 : x < -1 ? -Math.PI / 2 : Math.asin(x))

export const arcPath = arcPathImpl as (cx: number, cy: number, rIn: number, r0In: number, a0in: number, a1in: number, cornerRadius?: number, padAngle?: number) => GeneratedPath

function arcPathImpl(cx: number, cy: number, rIn: number, r0In: number, a0in: number, a1in: number, cornerRadius = 0, padAngle = 0): string {
  const ctx = new PathEmitter()
  arcInto(ctx, cx, cy, rIn, r0In, a0in, a1in, cornerRadius, padAngle)
  return ctx.toString()
}

/** The drawing surface the d3-arc port targets: a d3-path or a canvas 2D context. */
export interface ArcSink {
  moveTo(x: number, y: number): void
  lineTo(x: number, y: number): void
  arc(x: number, y: number, r: number, a0: number, a1: number, ccw?: boolean): void
  closePath(): void
}

/**
 * d3-arc into any sink. The SVG path and the canvas painter share this one
 * port: the canvas draws the exact arcs (like vega's canvas, which hands d3-arc
 * the real context) instead of re-deriving circle centres from a path string
 * rounded to 3 decimals, which is ill-conditioned for near-semicircular arcs.
 */
export function arcInto(ctx: ArcSink, cx: number, cy: number, rIn: number, r0In: number, a0in: number, a1in: number, cornerRadius = 0, padAngle = 0): void {
  let r0 = r0In
  let r1 = rIn
  let a0 = a0in - Math.PI / 2
  let a1 = a1in - Math.PI / 2
  const da0abs = arcAbs(a1 - a0)
  const cw = a1 > a0
  if (r1 < r0) { const t = r1; r1 = r0; r0 = t }
  if (!(r1 > ARC_EPSILON)) {
    // point
    ctx.moveTo(0, 0)
    ctx.closePath()
    return
  }
  if (da0abs > 2 * Math.PI - ARC_EPSILON) {
    // circle or annulus
    ctx.moveTo(r1 * Math.cos(a0), r1 * Math.sin(a0))
    ctx.arc(0, 0, r1, a0, a1, !cw)
    if (r0 > ARC_EPSILON) {
      ctx.moveTo(r0 * Math.cos(a1), r0 * Math.sin(a1))
      ctx.arc(0, 0, r0, a1, a0, cw)
    }
    ctx.closePath()
    return
  }
  let a01 = a0
  let a11 = a1
  let a00 = a0
  let a10 = a1
  let daF = da0abs
  let daS = da0abs
  const ap = padAngle / 2
  const rp = ap > ARC_EPSILON ? Math.sqrt(r0 * r0 + r1 * r1) : 0
  const rcLimit = Math.min(arcAbs(r1 - r0) / 2, cornerRadius)
  let rc = rcLimit
  let rc0 = rc
  let rc1 = rc
  if (rp > ARC_EPSILON) {
    const p0 = arcAsin((rp / r0) * Math.sin(ap))
    const p1 = arcAsin((rp / r1) * Math.sin(ap))
    if ((daF -= p0 * 2) > ARC_EPSILON) { const pp0 = p0 * (cw ? 1 : -1); a00 += pp0; a10 -= pp0 }
    else { daF = 0; a00 = a10 = (a0 + a1) / 2 }
    if ((daS -= p1 * 2) > ARC_EPSILON) { const pp1 = p1 * (cw ? 1 : -1); a01 += pp1; a11 -= pp1 }
    else { daS = 0; a01 = a11 = (a0 + a1) / 2 }
  }
  const x01 = r1 * Math.cos(a01)
  const y01 = r1 * Math.sin(a01)
  const x10 = r0 * Math.cos(a10)
  const y10 = r0 * Math.sin(a10)
  let x11 = 0
  let y11 = 0
  let x00 = 0
  let y00 = 0
  if (rc > ARC_EPSILON) {
    x11 = r1 * Math.cos(a11)
    y11 = r1 * Math.sin(a11)
    x00 = r0 * Math.cos(a00)
    y00 = r0 * Math.sin(a00)
    if (da0abs < Math.PI) {
      const oc = intersectArc(x01, y01, x00, y00, x11, y11, x10, y10)
      if (oc) {
        const ax = x01 - oc[0]
        const ay = y01 - oc[1]
        const bx = x11 - oc[0]
        const by = y11 - oc[1]
        const kc = 1 / Math.sin(arcAcos((ax * bx + ay * by) / (Math.sqrt(ax * ax + ay * ay) * Math.sqrt(bx * bx + by * by))) / 2)
        const lc = Math.sqrt(oc[0] * oc[0] + oc[1] * oc[1])
        rc0 = Math.min(rc, (r0 - lc) / (kc - 1))
        rc1 = Math.min(rc, (r1 - lc) / (kc + 1))
      } else {
        rc0 = rc1 = 0
      }
    }
  }
  if (!(daS > ARC_EPSILON)) ctx.moveTo(x01, y01)
  else if (rc1 > ARC_EPSILON) {
    const t0 = cornerTangents(x00, y00, x01, y01, r1, rc1, cw)
    const t1 = cornerTangents(x11, y11, x10, y10, r1, rc1, cw)
    ctx.moveTo(t0.cx + t0.x01, t0.cy + t0.y01)
    if (rc1 < rc) ctx.arc(t0.cx, t0.cy, rc1, arcAtan2(t0.y01, t0.x01), arcAtan2(t1.y01, t1.x01), !cw)
    else {
      ctx.arc(t0.cx, t0.cy, rc1, arcAtan2(t0.y01, t0.x01), arcAtan2(t0.y11, t0.x11), !cw)
      ctx.arc(0, 0, r1, arcAtan2(t0.cy + t0.y11, t0.cx + t0.x11), arcAtan2(t1.cy + t1.y11, t1.cx + t1.x11), !cw)
      ctx.arc(t1.cx, t1.cy, rc1, arcAtan2(t1.y11, t1.x11), arcAtan2(t1.y01, t1.x01), !cw)
    }
  } else {
    ctx.moveTo(x01, y01)
    ctx.arc(0, 0, r1, a01, a11, !cw)
  }
  if (!(r0 > ARC_EPSILON) || !(daF > ARC_EPSILON)) ctx.lineTo(x10, y10)
  else if (rc0 > ARC_EPSILON) {
    const t0 = cornerTangents(x10, y10, x11, y11, r0, -rc0, cw)
    const t1 = cornerTangents(x01, y01, x00, y00, r0, -rc0, cw)
    ctx.lineTo(t0.cx + t0.x01, t0.cy + t0.y01)
    if (rc0 < rc) ctx.arc(t0.cx, t0.cy, rc0, arcAtan2(t0.y01, t0.x01), arcAtan2(t1.y01, t1.x01), !cw)
    else {
      ctx.arc(t0.cx, t0.cy, rc0, arcAtan2(t0.y01, t0.x01), arcAtan2(t0.y11, t0.x11), !cw)
      ctx.arc(0, 0, r0, arcAtan2(t0.cy + t0.y11, t0.cx + t0.x11), arcAtan2(t1.cy + t1.y11, t1.cx + t1.x11), cw)
      ctx.arc(t1.cx, t1.cy, rc0, arcAtan2(t1.y11, t1.x11), arcAtan2(t1.y01, t1.x01), !cw)
    }
  } else {
    ctx.arc(0, 0, r0, a10, a00, cw)
  }
  ctx.closePath()
  void cx; void cy
}

function intersectArc(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, x3: number, y3: number): [number, number] | undefined {
  const x10 = x1 - x0
  const y10 = y1 - y0
  const x32 = x3 - x2
  const y32 = y3 - y2
  const t = y32 * x10 - x32 * y10
  if (t * t < ARC_EPSILON) return undefined
  const tt = (x32 * (y0 - y2) - y32 * (x0 - x2)) / t
  return [x0 + tt * x10, y0 + tt * y10]
}

// --- the one SVG attribute/text writer --------------------------------------
//
// Every value the string renderer writes into the document goes through the
// functions below (audit C2): `num`/`num3` for numbers (anything that is not a
// number is coerced with `Number`, so a string can never survive into a
// coordinate), `escAttr` for attribute values (including path data) and
// `escText` for text content. Nothing else may interpolate a non-constant into
// markup; `svg-escaping.test.ts` enforces that over every mark and channel.

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\t': '&#x9;', '\n': '&#xA;', '\r': '&#xD;' }
// Alternatives, in order: markup characters (attributes add the whitespace
// controls: vega-scenegraph's `attrText` set); characters XML 1.0 cannot carry
// at all; a valid surrogate pair (matched so it is left alone); a lone surrogate.
const TEXT_RE = /[&<>"]|[\0-\b\v\f\x0E-\x1F\uFFFE\uFFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g
const ATTR_RE = /[&<>"\t\n\r]|[\0-\b\v\f\x0E-\x1F\uFFFE\uFFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g

/**
 * Escape for a text node or, with `attribute`, an attribute value. Characters
 * XML 1.0 cannot represent, and lone surrogates, become U+FFFD. One regex pass,
 * no lookbehind (older Safari).
 */
function escapeXml(s: string, attribute: boolean): string {
  return s.replace(attribute ? ATTR_RE : TEXT_RE, (c) => ESCAPES[c] ?? (c.length > 1 ? c : '\uFFFD'))
}

/**
 * True when `s` has anything `escapeXml` would rewrite. A plain charCode scan:
 * for the short strings a chart writes (colours, numbers) it is several times
 * cheaper than running the replace regex on every attribute of every item.
 */
function needsEscape(s: string, attribute: boolean): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c > 62) {
      if (c >= 0xD800 && (c <= 0xDFFF || c >= 0xFFFE)) return true
    } else if (c < 32) {
      if (attribute || (c !== 9 && c !== 10 && c !== 13)) return true
    } else if (c === 34 || c === 38 || c === 60 || c === 62) return true
  }
  return false
}

/** Text-node escaping. */
const escText = (s: string): string => (needsEscape(s, false) ? escapeXml(s, false) : s)

/** Attribute-value escaping; accepts any value and stringifies it first. */
function escAttr(value: unknown): string {
  const s = String(value)
  return needsEscape(s, true) ? escapeXml(s, true) : s
}

/** ` name="a,b,c"`: numbers formatted, anything else escaped. */
function attrList(name: string, values: readonly unknown[]): string {
  const list = values.map((v) => (typeof v === 'number' ? num(v) : String(v))).join(',')
  return ` ${name}="${escAttr(list)}"`
}

/** Paint/presentation attribute with vega's SVG-renderer conventions. */
function attr(name: string, value: unknown): string {
  if (value == null) return ''
  // Vega's SVG renderer omits a 'transparent' paint value (fill/stroke).
  if (value === 'transparent') return ''
  if (Array.isArray(value)) return attrList(name, value)
  // a number is written as is, a paint's too (`fill="0.43"`): vega's SVG renderer does not reinterpret it
  if (typeof value === 'number') return ` ${name}="${num(value)}"`
  return ` ${name}="${escAttr(value)}"`
}


// --- per-element attribute lists: the single source (audit C43, T2) ----------
//
// The string renderer and the DOM descriptor builder (dom.ts) both obtain every
// element's attributes from the functions below, each writing into an
// `AttrSink`. The string renderer supplies a sink that appends escaped
// ` name="value"` text; the DOM builder supplies one that collects
// `[name, value]` pairs. There is one list per element, so the two renderers
// cannot drift, and the value rules (`attr`'s conventions, number formatting,
// escaping on the string side) live in the sinks, not at each call site.
//
// The paint of EVERY element goes through `paintAttrs` below: vega-scenegraph's
// `stylesAttr` list, written once, in vega's order. A paint property therefore
// cannot be dropped by one mark kind or one renderer only (C38/C48).

export interface AttrSink {
  /** Paint/presentation attribute with vega's SVG-renderer conventions (see `attr`). */
  a(name: string, value: unknown): void
  /** Any non-nullish value, stringified verbatim (the string sink escapes it). */
  v(name: string, value: unknown): void
  /**
   * A string the caller assembled from `num()` output and constant text only
   * (transforms, ids, class lists): it cannot contain markup-significant
   * characters, so the string sink writes it without the escaping scan.
   */
  t(name: string, value: string): void
  /** A number, formatted with `num`; nullish is skipped. */
  n(name: string, value: number | null | undefined): void
  /** Generated path data (see `GeneratedPath`): written without the escaping scan. */
  g(name: string, value: GeneratedPath): void
}

/** Sink producing the serialized attribute text of the string renderer. */
export class StringAttrSink implements AttrSink {
  s = ''
  a(name: string, value: unknown): void { if (value != null) this.s += attr(name, value) }
  v(name: string, value: unknown): void { if (value != null) this.s += ` ${name}="${escAttr(value)}"` }
  t(name: string, value: string): void { this.s += ` ${name}="${value}"` }
  n(name: string, value: number | null | undefined): void { if (value != null) this.s += ` ${name}="${num(value)}"` }
  g(name: string, value: GeneratedPath): void { this.s += ` ${name}="${genD(value)}"` }
}

/** The value `attr(name, value)` would write, or null when it writes nothing. */
function attrValue(name: string, value: unknown): string | null {
  if (value == null || value === 'transparent') return null
  if (Array.isArray(value)) return value.map((x) => (typeof x === 'number' ? num(x) : String(x))).join(',')
  if (typeof value === 'number') return num(value)
  return String(value)
}

/** Sink collecting `[name, value]` pairs for the DOM descriptor builder. */
export class PairAttrSink implements AttrSink {
  out: Array<[string, string]> = []
  a(name: string, value: unknown): void { const x = attrValue(name, value); if (x !== null) this.out.push([name, x]) }
  v(name: string, value: unknown): void { if (value != null) this.out.push([name, String(value)]) }
  t(name: string, value: string): void { this.out.push([name, value]) }
  n(name: string, value: number | null | undefined): void { if (value != null) this.out.push([name, num(value)]) }
  g(name: string, value: GeneratedPath): void { this.out.push([name, genD(value)]) }
}

const recOf = (it: SceneItem): Record<string, unknown> => it as Record<string, unknown>

/**
 * The link a mark item sits in (vega-scenegraph SVGStringRenderer `href` /
 * `process`: an item with a truthy `href` is wrapped in `<a xlink:href>`), or
 * null. The value is sanitized here, in the one place both renderers read it.
 */
export function itemHref(it: SceneItem): string | null {
  const h = recOf(it).href
  return h ? sanitizeHref(h) : null
}

/** The `<a>` element's attributes. */
export function linkAttrs(href: string, w: AttrSink): void {
  w.v('xlink:href', href)
}

/** `<a xlink:href="...">` for a hyperlinked item, else ''. Pair with {@link linkClose}. */
function linkOpen(it: SceneItem): string {
  const href = itemHref(it)
  if (href == null) return ''
  const w = new StringAttrSink()
  linkAttrs(href, w)
  return `<a${w.s}>`
}
const linkClose = (open: string): string => (open ? '</a>' : '')
/** `el` inside the item's link when it has one (the common, linkless case adds nothing but a property read). */
function withLink(it: SceneItem, el: string): string {
  if (!recOf(it).href) return el
  const open = linkOpen(it)
  return open ? open + el + '</a>' : el
}

/** `data-datum`, stamped by `stampDatumAttrs` so events can recover the datum. */
export function itemDatumAttr(it: SceneItem, w: AttrSink): void {
  const v = (it as unknown as { dataDatum?: string }).dataDatum
  if (v) w.v('data-datum', v)
}

/** An angle as vega concatenates it into `rotate(...)`: a number as its digits, anything else as its (escaped) string. */
function angleText(a: unknown): string {
  return typeof a === 'number' ? num(a) : escAttr(String(a))
}

/**
 * vega-scenegraph util/svg/transform.js: `rotateItem` = translate(x||0, y||0)
 * [rotate(angle)]; `transformItem` adds scale(scaleX||1, scaleY||1) when either
 * scale is truthy. Every mark kind uses the one of these its vega mark uses.
 */
export function rotateItemTransform(it: SceneItem): GeneratedPath {
  const a = it.angle
  // numbers (through `num`) and escaped words only: safe to write without the escaping scan
  return gen(`translate(${num(it.x || 0)},${num(it.y || 0)})${a ? ` rotate(${angleText(a)})` : ''}`)
}
export function transformItemTransform(it: SceneItem): GeneratedPath {
  const rec = recOf(it)
  return gen(rotateItemTransform(it) + (rec.scaleX || rec.scaleY ? ` scale(${num((rec.scaleX as number) || 1)},${num((rec.scaleY as number) || 1)})` : ''))
}
/** vega path mark: a non-unit scale keeps the stroke width (`vector-effect`). */
export function pathVectorEffect(it: SceneItem): boolean {
  const rec = recOf(it)
  return ((rec.scaleX as number) || 1) !== 1 || ((rec.scaleY as number) || 1) !== 1
}

/** A fill or stroke as it is written: a gradient object is the reference to its definition. */
const paintOf = (v: unknown): unknown => (typeof v === 'object' && isGradientPaint(v) ? gradientRef(v) : v)

/**
 * vega-scenegraph's `stylesAttr` (util/svg/styles.js): the item property ->
 * presentation attribute list that EVERY mark's SVG output goes through
 * (SVGStringRenderer `style()`), in vega's order: fill, fillOpacity,
 * stroke, strokeOpacity, strokeWidth, strokeCap (stroke-linecap), strokeJoin
 * (stroke-linejoin), strokeDash (stroke-dasharray), strokeDashOffset,
 * strokeMiterLimit, opacity, then the blend style.
 *
 * The reads are written out one by one on purpose: a loop over a table reads
 * `item[prop]` with a computed key, a megamorphic load that cost the string
 * renderer ~2x at 10k symbols; named reads stay monomorphic.
 *
 * `styles` are extra CSS declarations that precede the blend (an image mark's
 * `image-rendering`); `strokeWidth` replaces the item's own (a line's default 2).
 */
export function paintAttrs(it: SceneItem, w: AttrSink, styles?: readonly string[], strokeWidth?: number): void {
  // `!= null` before each call: most properties of most items are absent, and the
  // string renderer is dominated by exactly these checks at 10k+ marks.
  let v: unknown
  if ((v = it.fill) != null) w.a('fill', paintOf(v))
  if ((v = it.fillOpacity) != null) w.a('fill-opacity', v)
  if ((v = it.stroke) != null) w.a('stroke', paintOf(v))
  if ((v = it.strokeOpacity) != null) w.a('stroke-opacity', v)
  if ((v = strokeWidth ?? it.strokeWidth) != null) w.a('stroke-width', v)
  if ((v = it.strokeCap) != null) w.a('stroke-linecap', v)
  if ((v = it.strokeJoin) != null) w.a('stroke-linejoin', v)
  if ((v = it.strokeDash) != null) w.a('stroke-dasharray', v)
  if ((v = it.strokeDashOffset) != null) w.a('stroke-dashoffset', v)
  if ((v = it.strokeMiterLimit) != null) w.a('stroke-miterlimit', v)
  if ((v = it.opacity) != null) w.a('opacity', v)
  // a transparent fill that has to take the pointer (an interactive mark; see runtime.ts `_hit`)
  if (recOf(it)._hit === true) w.v('pointer-events', 'visible')
  // vega: stylesCss.blend -> style="mix-blend-mode: <blend>;" (after any mark styles)
  const blend = it.blend
  if (styles !== undefined) w.v('style', styles.join(' ') + (blend != null ? ` mix-blend-mode: ${String(blend)};` : ''))
  else if (blend != null) w.v('style', `mix-blend-mode: ${String(blend)};`)
}

/** True when two items paint identically (every `paintAttrs` property, and blend). */
export function samePaint(a: SceneItem, b: SceneItem): boolean {
  return same(a.fill, b.fill) && same(a.fillOpacity, b.fillOpacity) && same(a.stroke, b.stroke)
    && same(a.strokeOpacity, b.strokeOpacity) && same(a.strokeWidth, b.strokeWidth) && same(a.strokeCap, b.strokeCap)
    && same(a.strokeJoin, b.strokeJoin) && same(a.strokeDash, b.strokeDash) && same(a.strokeDashOffset, b.strokeDashOffset)
    && same(a.strokeMiterLimit, b.strokeMiterLimit) && same(a.opacity, b.opacity) && a.blend === b.blend
    && recOf(a)._hit === recOf(b)._hit
}

function same(x: unknown, y: unknown): boolean {
  if (x === y) return true
  return Array.isArray(x) && Array.isArray(y) && x.length === y.length && x.every((v, i) => v === y[i])
}

// --- clips -------------------------------------------------------------------
// Ids are content-addressed by `ClipCollector` (`clip` + base-36 hash, optionally
// `_n`): only [a-z0-9_], so they are written without the escaping scan.

const clipUrl = (id: string): string => `url(#${id})`

/** `clip-path="url(#id)"`. */
export function clipRefAttrs(id: string, w: AttrSink): void {
  w.t('clip-path', clipUrl(id))
}

/** `id="..."` of a `<clipPath>`. */
export function clipIdAttrs(id: string, w: AttrSink): void {
  w.t('id', id)
}

/**
 * The clip a mark group registers: its own clip path, else the size of the group
 * that contains it at (0,0) (vega: `clip(renderer, scene, scene.group)`).
 */
export function groupClipId(group: SceneGroup, clips: ClipCollector, frameW: number, frameH: number): string {
  return clips.id(group.clipPathD ? { d: group.clipPathD } : { x: 0, y: 0, w: frameW, h: frameH })
}

/**
 * The clip of a clipped legend symbol (clipHeight), or null. Vega's
 * SVGStringRenderer hangs it on the symbol's mark group (a `<g>` around the
 * symbol, in the frame of the legend scope) and defs a rect over the containing
 * entry's laid-out box. It must NOT sit on the translated `<path>` itself: a
 * clip-path lives in the user space of the element it is on, including that
 * element's own transform, which would shift the rect by the symbol position.
 */
export function leafClipId(it: SceneItem, clips: ClipCollector): string | null {
  if (it.path == null) return null
  const clip = recOf(it)._clip as { x?: number; y?: number; w: number; h: number; d?: string } | undefined
  return clip ? clips.id(clip.d ? { d: clip.d } : { x: clip.x ?? 0, y: clip.y ?? 0, w: clip.w, h: clip.h }) : null
}

/** The shape inside a `<clipPath>`: a path, or a rect in the clipped element's frame. */
export function clipShapeAttrs(def: ClipDef, w: AttrSink): 'path' | 'rect' {
  if ('d' in def) {
    w.v('d', def.d)
    return 'path'
  }
  w.n('x', def.x)
  w.n('y', def.y)
  w.n('width', def.w)
  w.n('height', def.h)
  return 'rect'
}

// --- elements ----------------------------------------------------------------

/** A guide leaf path (legend entry, axis path). The clip, if any, wraps it (see `leafClipId`). */
export function leafPathAttrs(it: SceneItem, w: AttrSink): void {
  // The item's x/y as a translate so legend/entry paths (whose `d` starts at
  // M0,0) land at their intended position, matching vega's nested-scope
  // transforms. Items with x=y=0 emit no transform.
  const tx = num(it.x || 0)
  const ty = num(it.y || 0)
  const angle = recOf(it).angle as number | undefined
  const rot = angle ? ` rotate(${num(angle)})` : ''
  if (tx !== '0' || ty !== '0' || rot) w.t('transform', `translate(${tx},${ty})${rot}`)
  itemDatumAttr(it, w)
  // a legend's symbols and gradient / band rectangles are marks of their own: the item's aria channels
  const part = it._part
  if (part === 'symbol') ariaItemAttrs(it, w, 'symbol')
  else if (part === 'gradient' || part === 'band') ariaItemAttrs(it, w, 'rect')
  w.v('d', it.path)
  paintAttrs(it, w)
}

/** The `d` of a guide leaf symbol (`shape` + `radius`). */
export function leafSymbolPath(it: SceneItem): GeneratedPath {
  return symbolPath(it.shape as string, it.radius as number)
}

/** A path with a symbol's position/rotation: guide leaf symbols and symbol marks. */
export function symbolElementAttrs(it: SceneItem, d: GeneratedPath, w: AttrSink): void {
  w.t('transform', rotateItemTransform(it))
  itemDatumAttr(it, w)
  ariaItemAttrs(it, w, 'symbol')
  w.g('d', d)
  paintAttrs(it, w)
}

/**
 * A text element (text mark item or guide label): vega-scenegraph's text attr
 * (`marks/text.js`), geometry from `textItemDesc`. Returns that description
 * (lines, line height), or null when there is nothing to draw.
 */
export function textAttrs(it: SceneItem, w: AttrSink): ReturnType<typeof textItemDesc> {
  const d = textItemDesc(it)
  if (d == null) return null
  const rec = recOf(it)
  itemDatumAttr(it, w)
  ariaItemAttrs(it, w, 'text')
  w.t('transform', d.transform)
  w.a('text-anchor', svgTextAnchor(it.align))
  w.a('font-family', rec.font || 'sans-serif')
  w.t('font-size', `${num(d.fontSize)}px`)
  w.a('font-style', rec.fontStyle)
  w.a('font-variant', rec.fontVariant)
  w.a('font-weight', rec.fontWeight)
  paintAttrs(it, w)
  return d
}

/** A straight line: guide leaf lines and rules (callers resolve the endpoints). */
export function lineElementAttrs(x1: number, y1: number, x2: number, y2: number, it: SceneItem, w: AttrSink): void {
  ariaItemAttrs(it, w, 'rule')
  w.n('x1', x1)
  w.n('y1', y1)
  w.n('x2', x2)
  w.n('y2', y2)
  paintAttrs(it, w)
}

/** Endpoints of a guide leaf line. */
export function leafLineEnds(it: SceneItem): [number, number, number, number] {
  return [it.x || 0, it.y || 0, it.x2 ?? it.x ?? 0, it.y2 ?? it.y ?? 0]
}

/** Endpoints of a rule: vega defaults NaN/undefined to 0, x2/y2 to x/y. */
export function ruleEnds(it: SceneItem): [number, number, number, number] {
  // vega-scenegraph's rule/line shapes read `item.x || 0`, so NaN scale
  // outputs collapse to the origin — but x2/y2 legitimately resolve to 0
  // (a rule spanning back to the axis origin), so only NaN falls back.
  const clean = (v: number | undefined, fallback = 0): number => (v == null || Number.isNaN(v) ? fallback : v)
  const x = clean(it.x)
  const y = clean(it.y)
  return [x, y, clean(it.x2, x), clean(it.y2, y)]
}

/** A line mark's path: vega styles it from the first item; a stroked line defaults to width 2. */
export function lineMarkAttrs(info: NonNullable<ReturnType<typeof computeLinePath>>, w: AttrSink): void {
  ariaItemAttrs(info.first, w, 'line')
  w.g('d', info.path)
  paintAttrs(info.first, w, undefined, info.sw)
}

/**
 * The element of a line / area mark none of whose points can be drawn: vega emits it without a `d`, styled from the first
 * item like the path would be, so its aria-label is still there.
 */
export function pathlessMarkAttrs(kind: 'line' | 'area', first: SceneItem, w: AttrSink): void {
  ariaItemAttrs(first, w, kind)
  paintAttrs(first, w, undefined, kind === 'line' ? (first.strokeWidth ?? (first.stroke != null ? 2 : undefined)) : undefined)
}

/** An area mark's path: vega styles it from the first item. */
export function areaMarkAttrs(info: NonNullable<ReturnType<typeof computeAreaPath>>, w: AttrSink): void {
  ariaItemAttrs(info.first, w, 'area')
  w.g('d', info.path)
  paintAttrs(info.first, w)
}

export function circleAttrs(it: SceneItem, w: AttrSink): void {
  const r = it.radius != null ? it.radius : Math.sqrt((it.size as number) ?? SYMBOL_DEFAULT_SIZE) / 2
  itemDatumAttr(it, w)
  ariaItemAttrs(it, w, 'circle')
  w.n('cx', it.x)
  w.n('cy', it.y)
  w.n('r', r)
  paintAttrs(it, w)
}

/** A rect mark item's path attributes (`datum: false` for the clipped-scope fallback, which never carried it). */
export function rectPathAttrs(it: SceneItem, d: GeneratedPath, w: AttrSink, datum = true): void {
  if (datum) itemDatumAttr(it, w)
  ariaItemAttrs(it, w, 'rect')
  w.g('d', d)
  paintAttrs(it, w)
}

/**
 * vega still emits an unpainted rect path (no fill/stroke attributes); only
 * explicitly-null paint marks (the selection brush frame) are skipped.
 */
export const rectIsPainted = (it: SceneItem): boolean => !(it.fill === null && it.stroke === null)

/** A `path`/`shape`/`geoshape` item: vega path mark attr `[vector-effect] transform d`. */
export function pathItemAttrs(it: SceneItem, w: AttrSink, marktype = 'path'): void {
  if (pathVectorEffect(it)) w.v('vector-effect', 'non-scaling-stroke')
  w.t('transform', transformItemTransform(it))
  itemDatumAttr(it, w)
  ariaItemAttrs(it, w, marktype)
  w.v('d', it.path)
  paintAttrs(it, w)
}

/** The trail polygon carries the full paint set of the FIRST item (vega). */
export function trailAttrs(d: GeneratedPath, first: SceneItem, w: AttrSink): void {
  ariaItemAttrs(first, w, 'trail')
  w.g('d', d)
  paintAttrs(first, w)
}

export function imageAttrs(it: SceneItem, w: AttrSink): void {
  const d = imageDesc(it)
  itemDatumAttr(it, w)
  ariaItemAttrs(it, w, 'image')
  const image = itemImage(it)
  w.v('xlink:href', image ? imageHref(image) : it.url)
  w.t('transform', `translate(${num(d.x)},${num(d.y)})`)
  w.n('width', d.w)
  w.n('height', d.h)
  w.v('preserveAspectRatio', it.aspect === false ? 'none' : 'xMidYMid')
  paintAttrs(it, w, d.smooth ? undefined : IMAGE_PIXELATED)
}

export function arcItemAttrs(it: SceneItem, w: AttrSink): void {
  const r = (it.outerRadius as number) ?? (it.radius as number) ?? 0
  const r0 = (it.innerRadius as number) ?? 0
  const a0 = (it.startAngle as number) ?? 0
  const a1 = (it.endAngle as number) ?? 0
  // Vega emits the arc path around (0,0) with a per-item translate; the local
  // coordinates round to 3 decimals independently of the (often fractional)
  // position, which the canonical diff depends on. vega's arc attr emits every
  // defined paint property (stroke-width even without a stroke, opacity, dashes).
  const cr = recOf(it).cornerRadius as number | undefined ?? 0
  const pa = recOf(it).padAngle as number | undefined ?? 0
  w.t('transform', rotateItemTransform(it))
  itemDatumAttr(it, w)
  ariaItemAttrs(it, w, 'arc')
  w.g('d', arcPath(0, 0, r, r0, a0, a1, cr, pa))
  paintAttrs(it, w)
}

/** Plot-area size: the scene's resolved plot box, else the view minus padding. */
export function scenePlotSize(scene: SceneRoot): { plotW: number; plotH: number } {
  const pad = scene.padding ?? { top: 0, right: 0, bottom: 0, left: 0 }
  return {
    plotW: scene.plotWidth ?? scene.width - pad.left - pad.right,
    plotH: scene.plotHeight ?? scene.height - pad.top - pad.bottom,
  }
}

// Keep fractional document sizes: vega's toSVG emits the resolved view size
// verbatim (the browser may rasterize onto an integer backing store).
export function svgRootAttrs(scene: SceneRoot, w: AttrSink): void {
  w.v('xmlns', 'http://www.w3.org/2000/svg')
  w.v('xmlns:xlink', 'http://www.w3.org/1999/xlink')
  w.v('version', '1.1')
  w.v('class', 'marks')
  w.n('width', scene.width)
  w.n('height', scene.height)
  w.t('viewBox', `0 0 ${num(scene.width)} ${num(scene.height)}`)
}

export function backgroundRectAttrs(scene: SceneRoot, w: AttrSink): void {
  w.n('width', scene.width)
  w.n('height', scene.height)
  w.v('fill', scene.background)
}

export function viewGroupAttrs(scene: SceneRoot, w: AttrSink): void {
  const pad = scene.padding ?? { top: 0, right: 0, bottom: 0, left: 0 }
  w.v('fill', 'none')
  w.v('stroke-miterlimit', '4')
  w.t('transform', `translate(${num(pad.left)},${num(pad.top)})`)
}

/** The root frame's background path: geometry from `frameBackgroundPath`, paint from `frameItem`. */
export function frameAttrs(scene: SceneRoot, w: AttrSink): void {
  const { plotW, plotH } = scenePlotSize(scene)
  w.v('class', 'background')
  w.v('aria-hidden', 'true')
  w.g('d', frameBackgroundPath(scene, plotW, plotH))
  paintAttrs(frameItem(scene), w)
}

export function stopAttrs(stop: { offset: number; color: string }, w: AttrSink): void {
  w.n('offset', stop.offset)
  w.v('stop-color', stop.color)
}

// --- accessibility and structure: vega-scenegraph's group, guide and title markup -----------------------------------
//
// vega-scenegraph draws every mark as a container `<g class="mark-<type> role-<role> <name>">` holding one element per
// item; a group item is `<g transform>` + its background path + a content `<g>` (the child marks) + its foreground
// path. Axes, legends and titles are group marks whose children are the marks of the guide (`role-axis-tick`,
// `role-legend-entry`, ...), and the SVG says what they are to a screen reader through `role`, `aria-roledescription`
// and `aria-label` (util/aria.js). Both renderers get that structure from `childNodes` below and every attribute from the
// functions here, so the string and DOM outputs cannot differ.

/** vega-scenegraph util/aria.js AriaIgnore: these roles are covered by their parent guide. */
const ARIA_IGNORE: ReadonlySet<string> = new Set([
  'axis-domain', 'axis-grid', 'axis-label', 'axis-tick', 'axis-title',
  'legend-band', 'legend-entry', 'legend-gradient', 'legend-label', 'legend-title', 'legend-symbol', 'title',
])

/**
 * vega-scenegraph `ariaItemAttributes`: `aria-hidden` for an item with `aria: false`; else, for an item with a
 * `description`, its aria-label, role (`ariaRole`, else graphics-object for a group and graphics-symbol for any other
 * mark) and aria-roledescription (`ariaRoleDescription`, else `<mark type> mark`).
 */
export function ariaItemAttrs(it: Pick<SceneItem, 'description' | 'aria' | 'ariaRole' | 'ariaRoleDescription'>, w: AttrSink, marktype: string): void {
  const d = it.description
  if (d == null) {
    if (it.aria === false) w.v('aria-hidden', 'true')
    return
  }
  if (it.aria === false) { w.v('aria-hidden', 'true'); return }
  w.v('aria-label', d)
  w.v('role', it.ariaRole || (marktype === 'group' ? 'graphics-object' : 'graphics-symbol'))
  w.v('aria-roledescription', it.ariaRoleDescription || `${marktype} mark`)
}

/** The scales a guide's caption reads: the snapshots of the nearest enclosing scope that has any (a11y.ts does the same). */
export interface GuideScope {
  snaps: ScaleSnapshots | undefined
  map?: Map<string, unknown>
}
/**
 * The caption implementation. guide-caption.ts installs it when it is loaded (the SVG and DOM renderers and the accessible
 * tree load it; the canvas and hit-test entries never do, and must not pay for its number and time formatting). Without it a
 * guide gets no caption, and so no ARIA role, like a guide whose caption vega could not build.
 */
export interface GuideCaptions {
  axis(group: SceneGroup, scales: Map<string, unknown>): string
  legend(group: SceneGroup, scales: Map<string, unknown>): string
  titleText(group: SceneGroup): string | undefined
  scales(snaps: ScaleSnapshots): Map<string, unknown>
}
let captions: GuideCaptions | null = null
export function installGuideCaptions(c: GuideCaptions): void { captions = c }

const scopeScales = (scope: GuideScope): Map<string, unknown> => (scope.map ??= captions ? captions.scales(scope.snaps ?? []) : new Map())

/** vega-scenegraph titleCaption: the text of the title item, lines joined by a space. */
function titleText(group: SceneGroup): string {
  const first = (group.items?.[0] ?? {}) as SceneItem
  const t = first.text
  return Array.isArray(t) ? t.join(' ') : t == null ? '' : String(t)
}

/** The caption of a guide group's container (`aria-label`): the guide's own `description`, else vega's caption. */
function guideCaption(group: SceneGroup, scope: GuideScope): string | undefined {
  if (group.description) return group.description
  // vega-scenegraph ariaGuide: `mark.description || item.description || caption(item)` -- the item of an axis or a legend is
  // its group item, that of a title text its text item
  const itemDescription = group.role === 'title-text' || group.role === 'title-subtitle' ? (group.items?.[0] as SceneItem | undefined)?.description : group.itemAria?.description
  if (itemDescription) return itemDescription
  switch (group.role) {
    // (a guide whose scale is unknown has no caption: vega's ariaGuide catches the failure and writes no ARIA at all)
    case 'axis': return captions && scopeScales(scope).has(group.scale ?? '') ? captions.axis({ ...group, title: captions.titleText(group) }, scopeScales(scope)) : undefined
    case 'legend': return captions && scopeScales(scope).has(group.legendScale ?? '') ? captions.legend({ ...group, title: captions.titleText(group) }, scopeScales(scope)) : undefined
    case 'title-text': return `Title text '${titleText(group)}'`
    case 'title-subtitle': return `Subtitle text '${titleText(group)}'`
    default: return undefined
  }
}

/** vega-scenegraph `ariaMarkAttributes` for a mark container (the group or data mark `group` is). */
function ariaMarkAttrs(group: SceneGroup, w: AttrSink, marktype: string, scope: GuideScope): void {
  if (group.aria === false) { w.v('aria-hidden', 'true'); return }
  const role = group.role
  if (role !== undefined && ARIA_IGNORE.has(role)) return
  if (role === 'axis' || role === 'legend' || role === 'title-text' || role === 'title-subtitle') {
    // (an axis that draws nothing has no caption in vega either: its ariaGuide finds no mark to read)
    if (role === 'axis' && unwrapAxis(group).parts.length === 0) return
    const label = guideCaption(group, scope)
    if (label === undefined) return
    w.v('role', 'graphics-symbol')
    w.v('aria-roledescription', role === 'title-text' ? 'title' : role === 'title-subtitle' ? 'subtitle' : role)
    w.v('aria-label', label)
    return
  }
  // an ordinary mark: an object when it is a group or text mark or any item describes itself, else a symbol
  let recurse = marktype === 'group' || marktype === 'text'
  if (!recurse && group.describes === true) recurse = (group.items ?? []).some((it) => (it as SceneItem).description != null && (it as SceneItem).aria !== false)
  w.v('role', recurse ? 'graphics-object' : 'graphics-symbol')
  w.v('aria-roledescription', `${marktype} mark container`)
  w.v('aria-label', group.description)
}

/** vega-scenegraph cssClass: `mark-<type> role-<role> <name>`; the role and name are the spec's. */
function cssClassOf(kind: string, group: SceneGroup): string {
  const role = group.role === 'mark' ? (group.markRole ?? 'mark') : group.role
  return `mark-${kind}${role ? ` role-${role}` : ''}${group.cssName ? ` ${group.cssName}` : ''}`
}

/** The clip a data mark's container carries (vega: `clip-path` on the container), or null. */
function markClipId(group: SceneGroup, clips: ClipCollector, frameW: number, frameH: number): string | null {
  return group.clip === true ? groupClipId(group, clips, frameW, frameH) : null
}

/** A mark that is not interactive: its container (and a group item's background / foreground) say `pointer-events="none"`. */
export const isInert = (group: SceneGroup): boolean => group.interactive === false || ((group.role === 'title-text' || group.role === 'title-subtitle') && group.interactive !== true)

/**
 * The container `<g>` of a data mark, or false when the type renders nothing. `scope` is only read for a guide's own
 * text marks (the title); data marks need none.
 */
export function markContainerAttrs(group: SceneGroup, w: AttrSink, clipId: string | null = null, scope: GuideScope = { snaps: undefined }): boolean {
  const type = group.marktype
  let kind: string
  switch (type) {
    case 'line': case 'area': case 'trail': case 'symbol': case 'rect': case 'circle': case 'rule': case 'text': case 'image':
    case 'arc': case 'path': case 'shape':
      kind = type
      break
    case 'geoshape':
      kind = 'shape'
      break
    default:
      return false
  }
  w.v('class', cssClassOf(kind, group))
  if (clipId) clipRefAttrs(clipId, w)
  ariaMarkAttrs(group, w, kind, scope)
  if (isInert(group)) w.v('pointer-events', 'none')
  return true
}

/** The container `<g>` of a group mark (all the group items of one mark share it). */
export function groupContainerAttrs(first: SceneGroup, w: AttrSink, clipId: string | null, scope: GuideScope): void {
  w.v('class', cssClassOf('group', first))
  if (clipId) clipRefAttrs(clipId, w)
  ariaMarkAttrs(first, w, 'group', scope)
}

/**
 * A group item's `<g>`: the item's own aria channels (vega-scenegraph `ariaItemAttributes`, which comes first), then its
 * `translate(x,y)`. (A group MARK's `description` and `aria` are the container's: see ariaMarkAttrs.)
 */
export function groupItemAttrs(dx: number, dy: number, w: AttrSink, aria?: SceneGroup['itemAria']): void {
  if (aria !== undefined) ariaItemAttrs(aria, w, 'group')
  // (vega's translateItem: `item.x || 0`, a NaN position is the origin)
  w.t('transform', `translate(${num(dx || 0)},${num(dy || 0)})`)
}

/** The background path of a group item: the item's own box and paint (`bg`), else an unpainted box of `d`. */
export function groupBackgroundAttrs(bg: SceneItem | null, d: GeneratedPath, inert: boolean, w: AttrSink): void {
  w.v('class', 'background')
  w.v('aria-hidden', 'true')
  if (bg) leafPathAttrs(bg, w)
  else w.g('d', d)
  if (inert) w.v('pointer-events', 'none')
}

/** The foreground path of a group item: the stroke drawn over the content (`fg`), else the empty hidden path. */
export function groupForegroundAttrs(fg: SceneItem | null, inert: boolean, w: AttrSink): void {
  w.v('class', 'foreground')
  w.v('aria-hidden', 'true')
  if (fg) {
    leafPathAttrs(fg, w)
    if (inert) w.v('pointer-events', 'none')
    return
  }
  w.v('d', '')
  if (inert) w.v('pointer-events', 'none')
  w.v('display', 'none')
}

/** What a part of a guide is drawn as: the container class of vega-parser's guide marks. */
const GUIDE_PARTS: Record<string, string> = {
  // axis
  grid: 'mark-rule role-axis-grid',
  tick: 'mark-rule role-axis-tick',
  label: 'mark-text role-axis-label',
  domain: 'mark-rule role-axis-domain',
  title: 'mark-text role-axis-title',
  // legend (the axis names `label` and `title` are the legend's too, with the legend role)
  symbol: 'mark-symbol role-legend-symbol',
  gradient: 'mark-rect role-legend-gradient',
  band: 'mark-rect role-legend-band',
}
const LEGEND_PART_CLASS: Record<string, string> = {
  label: 'mark-text role-legend-label',
  title: 'mark-text role-legend-title',
}

/** The container of one guide mark: not interactive, so `pointer-events="none"`. */
export function guidePartAttrs(guide: 'axis' | 'legend', part: string, clipId: string | null, w: AttrSink, meta?: SceneGroup['partMeta']): void {
  const name = meta?.[part]?.name
  w.v('class', ((guide === 'legend' ? LEGEND_PART_CLASS[part] : undefined) ?? GUIDE_PARTS[part]!) + (name ? ` ${name}` : ''))
  if (clipId) clipRefAttrs(clipId, w)
  if (!meta?.[part]?.interactive) w.v('pointer-events', 'none')
}


// --- the structure tree: what both renderers draw for groups and guides --------------------------------------------

/** An element of the structure tree. `path` elements have no children; `link` wraps the element in its `<a>`. */
export interface SvgEl {
  tag: 'g' | 'path'
  attrs: (w: AttrSink) => void
  children?: SvgNode[]
  link?: SceneItem
}
/** A leaf item of a guide (or of a group's content), drawn by the leaf renderers. */
export interface SvgLeaf {
  leaf: SceneItem
  /** A clipped legend symbol hangs its clip on a `<g>` around the path, unless its container carries it (`leafClipId`). */
  wrapClip: boolean
}
/** A data mark, drawn by the mark renderers. `frameW`/`frameH` is the frame of the group that contains it. */
export interface SvgMark {
  mark: SceneGroup
  frameW: number
  frameH: number
  scope: GuideScope
}
export type SvgNode = SvgEl | SvgLeaf | SvgMark

const el = (tag: 'g' | 'path', attrs: (w: AttrSink) => void, children?: SvgNode[], link?: SceneItem): SvgEl =>
  (children === undefined ? (link === undefined ? { tag, attrs } : { tag, attrs, link }) : link === undefined ? { tag, attrs, children } : { tag, attrs, children, link })
const noAttrs = (_w: AttrSink): void => {}
const EMPTY_BOX = gen('M0,0h0v0h0Z')
const boxPath = (w: number, h: number): GeneratedPath => gen(`M0,0h${num(w)}v${num(h)}h-${num(w)}Z`)
const isGroupNode = (it: SceneItem): it is SceneGroup => isGroup(it) && (it.marktype === undefined || it.marktype === 'group')
const flag = (it: SceneItem, key: string): boolean => (it as Record<string, unknown>)[key] === true

/**
 * The elements a list of scene children draws to, in order. Group items of one mark (consecutive, same `markIndex`)
 * share one container `<g>`; a data mark is its own container; a bare leaf is a leaf. `frameW`/`frameH` is the frame
 * of the group that holds them.
 */
export function childNodes(items: readonly SceneItem[] | undefined, frameW: number, frameH: number, scope: GuideScope, clips: ClipCollector): SvgNode[] {
  const out: SvgNode[] = []
  if (!items) return out
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!
    if (!isGroup(it)) { out.push({ leaf: it, wrapClip: true }); continue }
    if (!isGroupNode(it)) { out.push({ mark: it, frameW, frameH, scope }); continue }
    let j = i + 1
    const id = it.markIndex
    if (id !== undefined) {
      while (j < items.length) {
        const next = items[j]!
        if (!isGroup(next) || !isGroupNode(next) || next.markIndex !== id) break
        j++
      }
    }
    out.push(groupContainer(items.slice(i, j) as SceneGroup[], frameW, frameH, scope, clips))
    i = j - 1
  }
  return out
}

function groupContainer(run: SceneGroup[], frameW: number, frameH: number, scope: GuideScope, clips: ClipCollector): SvgEl {
  const first = run[0]!
  // vega's mark-level `clip`: the container is clipped to the frame of the enclosing group
  const attrs = (w: AttrSink): void => groupContainerAttrs(first, w, first.markClip === true ? clips.id({ x: 0, y: 0, w: frameW, h: frameH }) : null, scope)
  return el('g', attrs, run.filter((g) => !flag(g, 'emptyMark')).map((g) => groupItem(g, frameW, frameH, scope, clips)))
}

function groupItem(g: SceneGroup, frameW: number, frameH: number, scope: GuideScope, clips: ClipCollector): SvgEl {
  if (!flag(g, '_scope')) {
    if (g.role === 'axis') return axisItem(g)
    if (g.role === 'legend') return legendItem(g, clips)
    if (g.role === 'title') return titleItem(g, frameW, frameH, scope)
  }
  const gw = g.width ?? frameW
  const gh = g.height ?? frameH
  // (a group's own scales; the ones of the scopes around it stay in reach, as a nested axis may read them)
  const inner: GuideScope = g.__scales ? { snaps: [...(scope.snaps ?? []), ...g.__scales] } : scope
  const items = (g.items ?? []) as SceneItem[]
  // group items hold [background, content..., foreground?]: the boxes the runtime drew (`_bg`)
  const bg = items.length > 0 && flag(items[0]!, '_bg') ? items[0]! : null
  const fg = items.length > 1 && flag(items[items.length - 1]!, '_bg') ? items[items.length - 1]! : null
  let body = items.slice(bg ? 1 : 0, fg ? items.length - 1 : items.length)
  let contentAttrs: (w: AttrSink) => void = noAttrs
  let cw = gw
  let ch = gh
  const scopeNode = body.length === 1 && isGroup(body[0]!) && flag(body[0]!, 'contentClip') ? (body[0] as SceneGroup) : null
  if (scopeNode) {
    // the item's `clip` (encode): the content `<g>` is clipped to the item's own box or rounded-rect path
    cw = scopeNode.width ?? gw
    ch = scopeNode.height ?? gh
    contentAttrs = (w) => clipRefAttrs(groupClipId(scopeNode, clips, cw, ch), w)
    body = (scopeNode.items ?? []) as SceneItem[]
  }
  const inert = g.interactive === false
  return el('g', (w) => groupItemAttrs(g.x ?? 0, g.y ?? 0, w, g.itemAria), [
    el('path', (w) => groupBackgroundAttrs(bg, boxPath(gw, gh), inert, w)),
    el('g', contentAttrs, childNodes(body, cw, ch, inner, clips)),
    el('path', (w) => groupForegroundAttrs(fg, inert, w)),
  ], g)
}

/** The item `<g>` of a guide: its position, an unpainted box, the guide's marks, an empty foreground. */
function guideItem(x: number, y: number, bg: SceneItem | null, marks: SvgEl[], box: GeneratedPath = EMPTY_BOX, loose: readonly SceneItem[] = [], inert = true, aria?: SceneGroup['itemAria'], link?: SceneItem, fg: SceneItem | null = null): SvgEl {
  return el('g', (w) => groupItemAttrs(x, y, w, aria), [
    el('path', (w) => groupBackgroundAttrs(bg, box, inert, w)),
    el('g', noAttrs, loose.length ? [...marks, ...loose.map((leaf): SvgLeaf => ({ leaf, wrapClip: true }))] : marks),
    el('path', (w) => groupForegroundAttrs(fg, inert, w)),
  ], link)
}

/**
 * An axis as its parts: raw-guide mode wraps the axis in a group that only carries the half-pixel shift, so the
 * shift adds up and the parts are the inner group's.
 */
function unwrapAxis(outer: SceneGroup): { g: SceneGroup; dx: number; dy: number; leaves: SceneItem[]; parts: string[] } {
  let g = outer
  let dx = outer.x ?? 0
  let dy = outer.y ?? 0
  while (g.parts === undefined && g.items?.length === 1 && isGroup(g.items[0]!) && (g.items[0] as SceneGroup).role === 'axis') {
    g = g.items[0] as SceneGroup
    dx += g.x ?? 0
    dy += g.y ?? 0
  }
  const leaves = (g.items ?? []) as SceneItem[]
  const parts = g.parts ?? [...new Set(leaves.map((l) => l._part).filter((p): p is string => p !== undefined))]
  return { g, dx, dy, leaves, parts }
}

function axisItem(outer: SceneGroup): SvgEl {
  const { g, dx, dy, leaves, parts } = unwrapAxis(outer)
  const marks = parts.map((part) => el('g', (w) => guidePartAttrs('axis', part, null, w, outer.partMeta ?? g.partMeta), leaves.filter((l) => l._part === part).map((leaf) => ({ leaf, wrapClip: true }))))
  // (leaves of a hand-built scene carry no part: they are drawn all the same, in the item's content)
  const loose = leaves.filter((l) => l._part === undefined || !parts.includes(l._part))
  return guideItem(dx, dy, outer.box ?? g.box ?? null, marks, EMPTY_BOX, loose, !(outer.partMeta ?? g.partMeta)?.axis?.interactive, outer.itemAria ?? g.itemAria, outer.href !== undefined || g.href !== undefined ? (outer.href !== undefined ? outer : g) : undefined, outer.boxFg ?? g.boxFg ?? null)
}

function legendItem(g: SceneGroup, clips: ClipCollector): SvgEl {
  const leaves = (g.items ?? []) as SceneItem[]
  const meta = g.partMeta
  const leaf = (it: SceneItem, wrapClip = true): SvgLeaf => ({ leaf: it, wrapClip })
  let bg: SceneItem | null = null
  const entries: Array<{ box: SceneItem | null; symbols: SceneItem[]; labels: SceneItem[] }> = []
  const gradients: SceneItem[] = []
  const bands: SceneItem[] = []
  const labels: SceneItem[] = []
  const titles: SceneItem[] = []
  const loose: SceneItem[] = []
  // symbols or gradient/bands: what the builder drew (an entry or a symbol leaf), else what it says it drew
  const symbolStyle = leaves.some((l) => l._part === 'entry' || l._part === 'symbol')
    || (!leaves.some((l) => l._part === 'gradient' || l._part === 'band') && g.legendType !== 'gradient' && g.legendType !== 'discrete')
  let cur: (typeof entries)[number] | null = null
  for (const it of leaves) {
    switch (it._part) {
      case 'bg': bg ??= it; break
      case 'entry': entries.push((cur = { box: it, symbols: [], labels: [] })); break
      case 'symbol': (cur ??= entries[entries.push({ box: null, symbols: [], labels: [] }) - 1]!).symbols.push(it); break
      case 'label': if (symbolStyle) (cur ??= entries[entries.push({ box: null, symbols: [], labels: [] }) - 1]!).labels.push(it); else labels.push(it); break
      case 'gradient': gradients.push(it); break
      case 'band': bands.push(it); break
      case 'title': titles.push(it); break
      default: loose.push(it)
    }
  }
  // the names the spec gave the legend's parts (encode.<part>.name)
  const col = (inside: SvgEl[]): SvgEl => el('g', (w) => w.v('class', 'mark-group role-legend-entry'), [guideItem(0, 0, null, inside)])
  const entriesName = meta?.entries?.name
  let entryMarks: SvgEl[]
  if (symbolStyle) {
    const inert = !meta?.entries?.interactive
    const items = entries.map((e) => el('g', (w) => groupItemAttrs(0, 0, w, recOf(e.box ?? {}).itemAria as SceneGroup['itemAria']), [
      el('path', (w) => groupBackgroundAttrs(e.box, EMPTY_BOX, inert, w)),
      el('g', noAttrs, [
        el('g', (w) => guidePartAttrs('legend', 'symbol', e.symbols.length ? leafClipId(e.symbols[0]!, clips) : null, w, meta), e.symbols.map((s) => leaf(s, false))),
        el('g', (w) => guidePartAttrs('legend', 'label', null, w, meta), e.labels.map((l) => leaf(l))),
      ]),
      el('path', (w) => groupForegroundAttrs(null, inert, w)),
    ], e.box && recOf(e.box).href !== undefined ? e.box : undefined))
    // (a legend whose entries failed to build has no entry scope at all: vega's subflow never ran)
    entryMarks = entries.length === 0 && bg === null ? [] : [el('g', (w) => { w.v('class', 'mark-group role-scope' + (entriesName ? ` ${entriesName}` : '')); w.v('role', 'graphics-object'); w.v('aria-roledescription', 'group mark container') }, items)]
  } else {
    const banded = g.legendType === 'discrete' || bands.length > 0
    entryMarks = [el('g', (w) => guidePartAttrs('legend', banded ? 'band' : 'gradient', null, w, meta), (banded ? bands : gradients).map((l) => leaf(l)))]
    // (the labels come from the legend's entries: a legend whose entries failed to build has none, not even the container)
    if (labels.length || gradients.some((gr) => recOf(gr)._bare !== true) || bands.length || bg !== null) entryMarks.push(el('g', (w) => guidePartAttrs('legend', 'label', null, w, meta), labels.map((l) => leaf(l))))
  }
  const marks: SvgEl[] = [col(entryMarks)]
  if (titles.length) marks.push(el('g', (w) => guidePartAttrs('legend', 'title', null, w, meta), titles.map((t) => leaf(t))))
  return guideItem(g.x ?? 0, g.y ?? 0, bg, marks, boxPath(g.width ?? 0, g.height ?? 0), loose, !meta?.legend?.interactive, g.itemAria, g.href !== undefined ? g : undefined)
}

function titleItem(g: SceneGroup, frameW: number, frameH: number, scope: GuideScope): SvgEl {
  const marks = ((g.items ?? []) as SceneItem[]).map((m): SvgNode => (isGroup(m) ? { mark: m, frameW, frameH, scope } : { leaf: m, wrapClip: true }))
  const inert = g.interactive !== true
  return el('g', (w) => groupItemAttrs(g.x ?? 0, g.y ?? 0, w, g.itemAria), [
    el('path', (w) => groupBackgroundAttrs(g.box ?? null, EMPTY_BOX, inert, w)),
    el('g', noAttrs, marks as SvgNode[]),
    el('path', (w) => groupForegroundAttrs(g.boxFg ?? null, inert, w)),
  ], g.href !== undefined ? g : undefined)
}

/** Serialize the structure tree. The attribute writers run in document order (clip ids are registered as they go). */
export function serializeNodes(nodes: readonly SvgNode[], clips: ClipCollector): string {
  let out = ''
  for (const n of nodes) {
    if ('leaf' in n) { out += withLink(n.leaf, renderLeaf(n.leaf, clips, n.wrapClip)); continue }
    if ('mark' in n) { out += renderMark(n.mark, n.frameW, n.frameH, clips); continue }
    const w = new StringAttrSink()
    n.attrs(w)
    let el = n.children === undefined ? `<${n.tag}${w.s}/>` : `<${n.tag}${w.s}>${serializeNodes(n.children, clips)}</${n.tag}>`
    if (n.link) {
      const open = linkOpen(n.link)
      if (open) el = open + el + '</a>'
    }
    out += el
  }
  return out
}

/** Gradient definition attributes: the coordinates it carries, else the legend gradient's direction. */
export function gradientAttrs(def: SceneDef, w: AttrSink): void {
  w.v('id', def.id)
  if (def.kind === 'radial') {
    // vega-scenegraph: the inner circle is the focal point (fx, fy, fr), the outer one the gradient's (cx, cy, r)
    for (const [attr, v] of [['fx', def.x1], ['fy', def.y1], ['fr', def.r1], ['cx', def.x2], ['cy', def.y2], ['r', def.r2]] as const) {
      if (v != null) w.v(attr, String(v))
    }
  } else if (def.x1 != null || def.y1 != null || def.x2 != null || def.y2 != null) {
    for (const [attr, v] of [['x1', def.x1], ['x2', def.x2], ['y1', def.y1], ['y2', def.y2]] as const) {
      if (v != null) w.v(attr, String(v))
    }
  } else if (def.direction === 'horizontal') {
    w.v('x1', '0'); w.v('x2', '1'); w.v('y1', '0'); w.v('y2', '0')
  } else {
    w.v('x1', '0'); w.v('x2', '0'); w.v('y1', '1'); w.v('y2', '0')
  }
}

/**
 * Format a coordinate/length. The argument is typed `number` but comes from
 * spec and data, so it is coerced with `Number`: a string, object or array can
 * never reach the output as itself (`Number('abc')` is `NaN`).
 *
 * Full precision, matching vega-scenegraph: its SVG renderers serialize raw
 * doubles (String(number)). Rounding here (e.g. to 3 decimals) shifts
 * relative-delta endpoint sums by ~1e-3 after recombination — enough to trip
 * the conformance canonicalizer. Canonical comparison rounds anyway.
 */
export const num = (x: number): string => String(Number(x))

/**
 * d3-path rounding with `digits = 3` (d3-shape's `withPath` default).
 * Vega routes d3-shape-based mark shapes (symbol, arc, line, area) through a
 * d3-path buffer constructed with digits=3, so every path coordinate in those
 * marks is serialized rounded to 3 decimals. Vega's own rect/frame builders
 * (path/rectangle.js, trail.js via a digits-less d3-path) emit raw doubles.
 */
function num3(x: number): string {
  // `x * 1000` coerces like Number(x), so a non-number cannot survive as itself
  return String(Math.round(x * 1000) / 1000)
}
