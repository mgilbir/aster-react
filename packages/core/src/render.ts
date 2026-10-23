/**
 * Scene -> SVG serializer. Mirrors vega-scenegraph's output structure closely
 * enough that geometry (paths, rects, lines, tick positions) matches the
 * reference renderer; the conformance diff compares normalized geometry.
 */
import { SYMBOL_DEFAULT_SIZE } from './util.js'
import type { SceneGroup, SceneItem, SceneRoot } from './types.js'
import { baselineOffset, fontSize as vegaFontSize } from './bounds.js'
import { checkPathLength, metering } from './limits.js'
export { baselineOffset }
import { itemTextWidth } from './text-metrics.js'
import { ClipCollector, type ClipDef } from './svg-defs.js'
import { customSymbolPathData } from './svg-path.js'
import { sanitizeHref } from './url-policy.js'
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

/**
 * Resolve a Vega interpolation name to a d3-shape curve.
 * For "monotone" without axis qualifier, vega defaults to monotoneX (vertical).
 */
function resolveCurve(interpolate: string, orient?: string): unknown {
  if (interpolate === 'monotone') {
    return orient === 'horizontal' ? curveMonotoneY : curveMonotoneX
  }
  return Object.hasOwn(CURVE_MAP, interpolate) ? CURVE_MAP[interpolate] ?? null : null
}

/** Vega-scenegraph's rounded-rect path (C = 0.448084975506 bezier circle). */
function roundedFramePath(x: number, y: number, w: number, h: number, r: number): GeneratedPath {
  const c = 0.448084975506
  const kr1 = r * (1 - c)
  const kr2 = r * c
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
    stroke: scene.frameStroke || undefined,
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
  out += `<g class="mark-group role-frame root" role="graphics-object" aria-roledescription="group mark container"><g transform="translate(0,0)">`
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
  for (const node of scene.items) {
    out += renderGroup(node, plotW, plotH, clips, scene.width, scene.height)
  }
  out += '</g>'
  out += '<path class="foreground" aria-hidden="true" d="" display="none"/>'
  out += '</g></g></g>'

  // Emit defs at SVG root level (gradients + clip paths)
  if (scene.defs?.length || clips.size > 0) {
    out += '<defs>'
    for (const def of scene.defs ?? []) {
      w.s = ''
      gradientAttrs(def, w)
      out += `<linearGradient${w.s}>`
      for (const stop of def.colorStops) {
        w.s = ''
        stopAttrs(stop, w)
        out += `<stop${w.s}/>`
      }
      out += '</linearGradient>'
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

function renderGroup(group: SceneGroup, frameW?: number, frameH?: number, clips?: ClipCollector, viewW?: number, viewH?: number): string {
  const type = group.marktype
  const needsClip = clips
    && group.clip === true
    && frameW != null
    && frameH != null

  if (!type || type === 'group') {
    // axis / legend / nested group whose items may be leaf shapes
    // vega clips a group's content to the group's own width/height at (0,0) in
    // its own frame (group.js `content`), or to its explicit clip path.
    const gw = group.width ?? frameW
    const gh = group.height ?? frameH
    const w = new StringAttrSink()
    markGroupAttrs(group, w, needsClip ? clips : undefined, gw!, gh!)
    let out2 = `<g${w.s}>`
    // children are laid out in this group's frame: marks clipped inside it clip to its size
    for (const item of group.items ?? []) {
      if (isGroup(item)) out2 += renderGroup(item, gw, gh, clips, viewW, viewH)
      else out2 += renderLeaf(item, clips)
    }
    out2 += '</g>'
    // a hyperlinked group item sits inside its <a> (SVGStringRenderer `process`)
    const link = linkOpen(group)
    if (link) out2 = link + out2 + linkClose(link)
    // vega's mark-level `clip`: the mark container is clipped to the ENCLOSING group's
    // frame (SVGStringRenderer `clip(renderer, scene, scene.group)`), outside the item's
    // own transform
    if (group.markClip === true && clips && frameW != null && frameH != null) {
      const cw = new StringAttrSink()
      clipRefAttrs(clips.id({ x: 0, y: 0, w: frameW, h: frameH }), cw)
      return `<g${cw.s}>${out2}</g>`
    }
    return out2
  }

  // Vega-Lite rounds bars by wrapping each bar in a clipped scope. Vega's
  // SVG renderer keeps that group structure, so reproduce it here for rect
  // marks carrying per-item corner radii.
  if (type === 'rect' && clips && isClippedRoundedRectGroup(group)) {
    return renderClippedRoundedRects(group, clips)
  }

  // For mark groups, wrap in a clip'd outer <g> if needed. A mark's clip is the
  // size of the group that contains it (vega: `clip(renderer, scene, scene.group)`).
  const inner = switchMarkup(type, group)

  if (needsClip && clips) {
    const w = new StringAttrSink()
    clipRefAttrs(groupClipId(group, clips, frameW!, frameH!), w)
    return `<g${w.s}>${inner}</g>`
  }
  return inner
}

function switchMarkup(type: string, group: SceneGroup): string {
  switch (type) {
    case 'line': return renderLine(group)
    case 'area': return renderArea(group)
    case 'symbol': return renderSymbols(group)
    case 'circle': return renderCircles(group)
    case 'rect': return renderRects(group)
    case 'rule': return renderRules(group)
    case 'text': return renderTexts(group)
    case 'trail': return renderTrail(group)
    case 'path': return renderPaths(group)
    case 'shape': return renderPaths(group)
    case 'geoshape': return renderPaths(group)
    case 'image': return renderImages(group)
    case 'arc': return renderArcs(group)
    default: return ''
  }
}

function isGroup(item: SceneItem): item is SceneGroup {
  return (item as SceneGroup).marktype !== undefined || Array.isArray((item as SceneGroup).items)
}

/** Render an anchor leaf shape (path, symbol, text, line). */
function renderLeaf(it: SceneItem, clips?: ClipCollector): string {
  const w = new StringAttrSink()
  // Path items
  if (it.path != null) {
    // A clipped legend symbol (clipHeight): the clip hangs on a `<g>` around the
    // path, never on the translated `<path>` itself (see leafClipId).
    const clipId = clips ? leafClipId(it, clips) : null
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
  if (it.text != null) return textElement(it)
  const [x1, y1, x2, y2] = leafLineEnds(it)
  itemDatumAttr(it, w)
  lineElementAttrs(x1, y1, x2, y2, it, w)
  return `<line${w.s}/>`
}

function itemsOf(group: SceneGroup): SceneItem[] {
  return group.items ?? []
}

function renderLine(group: SceneGroup): string {
  const items = itemsOf(group)
  let out = markContainerOpen('line')
  const pathInfo = computeLinePath(group)
  if (pathInfo) {
    const w = new StringAttrSink()
    lineMarkAttrs(pathInfo, w)
    // a line is one element for the whole mark: its link is the first item's
    const a = items.length ? linkOpen(items[0]!) : ''
    out += `${a}<path${w.s}/>${linkClose(a)}`
  }
  out += '</g>'
  return out
}

/** Shared line-path geometry for the string renderer and the DOM patcher. */
export function computeLinePath(group: SceneGroup): {
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
  const items = itemsOf(group)
  if (!items.length) return null

  // Check if this line has curve interpolation (Vega's `interpolate` encode)
  const firstItem = items[0] as Record<string, unknown> | undefined
  const interpolate = firstItem?.interpolate as string | undefined
  const orient = firstItem?.orient as string | undefined
  const tension = firstItem?.tension as number | undefined

  let path = ''
  if (interpolate && interpolate !== 'linear') {
    // Use d3-shape for curve interpolation
    const curve = resolveCurve(interpolate, orient)
    if (curve) {
      let curveFn: unknown = curve
      // Apply tension for curves that support it (bundle, cardinal, cardinal-open, cardinal-closed)
      if (tension != null && curveFn) {
        const cf = curveFn as Record<string, ((v: number) => unknown) | undefined>
        if (interpolate === 'bundle' && typeof cf.beta === 'function') {
          curveFn = cf.beta(tension)
        } else if ((interpolate === 'cardinal' || interpolate === 'cardinal-open' || interpolate === 'cardinal-closed') && typeof cf.tension === 'function') {
          curveFn = cf.tension(tension)
        } else if ((interpolate === 'catmull-rom' || interpolate === 'catmull-rom-open' || interpolate === 'catmull-rom-closed') && typeof cf.alpha === 'function') {
          curveFn = cf.alpha(tension)
        }
      }
      type Pt = { x: number; y: number; defined: boolean }
      const lineGen = d3Line()
        .x((d) => (d as Pt).x)
        .y((d) => (d as Pt).y)
        .defined((d) => (d as Pt).defined)
        .curve(curveFn as never)

      // Build contiguous runs of defined points (same as linear path)
      const runs: Array<{ x: number; y: number; defined: boolean }> = items.map((it) => ({
        x: it.x as number,
        y: it.y as number,
        defined: it.defined !== false && it.x != null && it.y != null,
      }))
      // Split into segments at undefined points and generate curve per segment
      const segments: Array<Array<{ x: number; y: number; defined: boolean }>> = []
      let current: Array<{ x: number; y: number; defined: boolean }> = []
      for (const r of runs) {
        if (!r.defined) {
          if (current.length > 1) segments.push(current)
          current = []
        } else {
          current.push(r)
        }
      }
      if (current.length > 1) segments.push(current)

      for (const seg of segments) {
        const d = lineGen(seg)
        if (d) path += d
      }
    }
  }

  // Fallback: linear interpolation (or if curve failed)
  if (!path) {
    const runs: Array<{ x: number; y: number; defined: boolean }> = items.map((it) => ({
      x: it.x as number,
      y: it.y as number,
      defined: it.defined !== false && it.x != null && it.y != null,
    }))
    let penDown = false
    let hasLine = false
    for (let i = 0; i < runs.length; i++) {
      const r = runs[i]!
      if (!r.defined) {
        if (penDown) path += 'Z'
        penDown = false
        continue
      }
      if (!penDown) {
        path += `M${num3(r.x)},${num3(r.y)}`
        penDown = true
      } else {
        path += `L${num3(r.x)},${num3(r.y)}`
        hasLine = true
      }
    }
    // Vega appends Z for degenerate single-point line segments (only M, no L).
    if (penDown && !hasLine) path += 'Z'
  }

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

/** Shared area-path geometry for the string renderer and the DOM patcher. */
export function computeAreaPath(group: SceneGroup): {
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
  const items = itemsOf(group)

  // Check for curve interpolation (Vega's `interpolate` encode)
  const firstItem = items[0] as Record<string, unknown> | undefined
  const interpolate = firstItem?.interpolate as string | undefined
  const orient = firstItem?.orient as string | undefined
  const tension = firstItem?.tension as number | undefined
  const isHorizontal = orient === 'horizontal'

  // For horizontal areas: y is the independent axis, x/x2 are the value axes.
  // For vertical areas (default): x is the independent axis, y/y2 are the value axes.
  // Vega's area shape reads the baseline as y0 = y + height (d3-shape area
  // y0 accessor `yh`), NOT the raw y2 — adjustSpatial folds x2/y2 into
  // width/height, so the baseline follows the (possibly yc-shifted) y.
  const pts: Array<{ pos: number; val: number; val2: number; defined: boolean }> = items.map((it) => ({
    pos: isHorizontal ? (it.y as number) : (it.x as number),
    val: isHorizontal ? (it.x as number) : (it.y as number),
    val2: isHorizontal
      // Horizontal areas use x/x2 (not y2); when neither x2 nor width exists the
      // area degenerates to its value edge, exactly like vega's x0 accessor.
      ? (it.x ?? 0) + ((it.width as number | undefined) ?? (((it.x2 as number) ?? (it.x ?? 0)) - (it.x ?? 0)))
      : (it.y ?? 0) + ((it.height as number | undefined) ?? (((it.y2 as number) ?? (it.y ?? 0)) - (it.y ?? 0))),
    defined: it.defined !== false && it.x != null && it.y != null,
  }))

  let path = ''
  if (interpolate && interpolate !== 'linear') {
    const curve = resolveCurve(interpolate, orient)
    if (curve) {
      let curveFn: unknown = curve
      if (tension != null && curveFn) {
        const cf = curveFn as Record<string, ((v: number) => unknown) | undefined>
        if (interpolate === 'bundle' && typeof cf.beta === 'function') {
          curveFn = cf.beta(tension)
        } else if ((interpolate === 'cardinal' || interpolate === 'cardinal-open' || interpolate === 'cardinal-closed') && typeof cf.tension === 'function') {
          curveFn = cf.tension(tension)
        } else if ((interpolate === 'catmull-rom' || interpolate === 'catmull-rom-open' || interpolate === 'catmull-rom-closed') && typeof cf.alpha === 'function') {
          curveFn = cf.alpha(tension)
        }
      }

      if (isHorizontal) {
        // Horizontal area: d3 area with y as the cross-axis, x0/x1 as value axes
        type AreaPt = { y: number; x0: number; x1: number; defined: boolean }
        const areaGen = d3Area()
          .y((d: unknown) => (d as AreaPt).y)
          .x0((d: unknown) => (d as AreaPt).x0)
          .x1((d: unknown) => (d as AreaPt).x1)
          .defined((d: unknown) => (d as AreaPt).defined)
          .curve(curveFn as never)

        const runs: Array<AreaPt> = pts.map((p) => ({
          y: p.pos,
          x0: p.val2,
          x1: p.val,
          defined: p.defined,
        }))
        const segments: Array<Array<AreaPt>> = []
        let current: Array<AreaPt> = []
        for (const r of runs) {
          if (!r.defined) {
            if (current.length > 1) segments.push(current)
            current = []
          } else {
            current.push(r)
          }
        }
        if (current.length > 1) segments.push(current)

        for (const seg of segments) {
          const d = areaGen(seg)
          if (d) path += d
        }
      } else {
        // Vertical area (default)
        type AreaPt = { x: number; y0: number; y1: number; defined: boolean }
        const areaGen = d3Area()
          .x((d: unknown) => (d as AreaPt).x)
          .y0((d: unknown) => (d as AreaPt).y0)
          .y1((d: unknown) => (d as AreaPt).y1)
          .defined((d: unknown) => (d as AreaPt).defined)
          .curve(curveFn as never)

        const runs: Array<AreaPt> = pts.map((p) => ({
          x: p.pos,
          y0: p.val2,
          y1: p.val,
          defined: p.defined,
        }))
        const segments: Array<Array<AreaPt>> = []
        let current: Array<AreaPt> = []
        for (const r of runs) {
          if (!r.defined) {
            if (current.length > 1) segments.push(current)
            current = []
          } else {
            current.push(r)
          }
        }
        if (current.length > 1) segments.push(current)

        for (const seg of segments) {
          const d = areaGen(seg)
          if (d) path += d
        }
      }
    }
  }

  // Fallback: linear interpolation (or if curve failed)
  if (!path) {
    let penDown = false
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i]!
      if (!p.defined) {
        if (penDown) {
          for (let j = i - 1; j >= 0; j--) {
            const q = pts[j]!
            if (!q.defined) break
            if (isHorizontal) {
              path += `L${num3(q.val2)},${num3(q.pos)}`
            } else {
              path += `L${num3(q.pos)},${num3(q.val2)}`
            }
          }
          path += 'Z'
          penDown = false
        }
        continue
      }
      if (!penDown) {
        if (isHorizontal) {
          path += `M${num3(p.val)},${num3(p.pos)}`
        } else {
          path += `M${num3(p.pos)},${num3(p.val)}`
        }
        penDown = true
      } else {
        if (isHorizontal) {
          path += `L${num3(p.val)},${num3(p.pos)}`
        } else {
          path += `L${num3(p.pos)},${num3(p.val)}`
        }
      }
    }
    if (penDown) {
      for (let j = pts.length - 1; j >= 0; j--) {
        const q = pts[j]!
        if (!q.defined) break
        if (isHorizontal) {
          path += `L${num(q.val2)},${num(q.pos)}`
        } else {
          path += `L${num(q.pos)},${num(q.val2)}`
        }
      }
      path += 'Z'
    }
  }

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

function renderArea(group: SceneGroup): string {
  const info = computeAreaPath(group)
  let out = markContainerOpen('area')
  if (info) {
    const w = new StringAttrSink()
    areaMarkAttrs(info, w)
    const first = itemsOf(group)[0]
    const a = first ? linkOpen(first) : ''
    out += `${a}<path${w.s}/>${linkClose(a)}`
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

function renderSymbols(group: SceneGroup): string {
  const links = group.hasLinks === true
  let out = markContainerOpen('symbol')
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
function renderCircles(group: SceneGroup): string {
  const links = group.hasLinks === true
  let out = markContainerOpen('circle')
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

function renderRects(group: SceneGroup): string {
  const links = group.hasLinks === true
  let out = markContainerOpen('rect')
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

function renderRules(group: SceneGroup): string {
  const links = group.hasLinks === true
  let out = markContainerOpen('rule')
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

function renderTexts(group: SceneGroup): string {
  const links = group.hasLinks === true
  let out = markContainerOpen('text')
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
  if (it.text == null) return null
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

function renderPaths(group: SceneGroup): string {
  const links = group.hasLinks === true
  let out = markContainerOpen('path')
  const w = new StringAttrSink()
  for (const it of itemsOf(group)) {
    if (!it.path) continue
    // Position the path at its item x/y (vega renders path marks with a
    // translate transform; items whose path already encodes absolute
    // coordinates (e.g. geoshape output) have x=y=0 and emit no transform).
    w.s = ''
    pathItemAttrs(it, w)
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
function renderTrail(group: SceneGroup): string {
  const links = group.hasLinks === true
  let out = markContainerOpen('trail')
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
/** Full-precision coordinate formatting: vega's trail 'd' comes from the
 * d3-path buffer, whose stringifier emits JS number strings verbatim (unlike
 * the rounded rect/area emitters). */
const fp = (x: number): string => num(x)

export function trailPath(items: SceneItem[]): GeneratedPath {
  // Exact emulation of vega's trail generator through the d3-path buffer:
  // coordinates emit as JS number strings (full precision), arc endpoints
  // recompute through cos/sin of the segment angle (not the normalized
  // vector), and coincident points suppress the L.
  let out = ''
  let ready = false
  let x1 = 0, y1 = 0, r1 = 0
  // d3-path state: last emitted point (null = path empty)
  let px: number | null = null
  let py: number | null = null
  const EPS = 1e-12
  const moveTo = (x: number, y: number): void => {
    out += `M${fp(x)},${fp(y)}`
    px = x; py = y
  }
  const lineTo = (x: number, y: number): void => {
    if (px === null || py === null) { moveTo(x, y); return }
    if (Math.abs(px - x) > EPS || Math.abs(py - y) > EPS) {
      out += `L${fp(x)},${fp(y)}`
      px = x; py = y
    }
  }
  const arc = (x: number, y: number, r: number, a0: number, a1: number): void => {
    const dx = r * Math.cos(a0)
    const dy = r * Math.sin(a0)
    const x0 = x + dx
    const y0 = y + dy
    lineTo(x0, y0)
    if (!r) return
    let da = a1 - a0
    if (da < 0) da = (da % (2 * Math.PI)) + 2 * Math.PI
    if (da > 2 * Math.PI - EPS) {
      // complete circle: two arcs
      out += `A${fp(r)},${fp(r)},0,1,1,${fp(x - dx)},${fp(y - dy)}`
      out += `A${fp(r)},${fp(r)},0,1,1,${fp(x0)},${fp(y0)}`
      px = x0; py = y0
    } else if (da > EPS) {
      const ex = x + r * Math.cos(a1)
      const ey = y + r * Math.sin(a1)
      out += `A${fp(r)},${fp(r)},0,${da >= Math.PI ? 1 : 0},1,${fp(ex)},${fp(ey)}`
      px = ex; py = ey
    }
  }
  for (const it of items) {
    // vega's trail generator: `size || 1` (a zero size falls back to 1) and
    // `defined === false` breaks the segment (the polygon ends; a new run
    // starts at the next defined point).
    if (it.defined === false) {
      ready = false
      continue
    }
    const x2 = it.x as number
    const y2 = it.y as number
    const r2 = ((it.size as number) || 1) / 2
    if (ready) {
      const ux0 = y1 - y2
      const uy0 = x2 - x1
      if (ux0 || uy0) {
        const ud = Math.hypot(ux0, uy0)
        const ux = ux0 / ud
        const uy = uy0 / ud
        // segment angle; the arc endpoints go through cos/sin of it
        const t = Math.atan2(uy0, ux0)
        moveTo(x1 - ux * r1, y1 - uy * r1)
        lineTo(x2 - ux * r2, y2 - uy * r2)
        arc(x2, y2, r2, t - Math.PI, t)
        lineTo(x1 + ux * r1, y1 + uy * r1)
        arc(x1, y1, r1, t, t + Math.PI)
        out += 'Z'
      } else {
        // Identical consecutive points: a full circle cap around the point.
        arc(x2, y2, r2, 0, 2 * Math.PI)
        out += 'Z'
      }
    } else {
      ready = true
    }
    x1 = x2
    y1 = y2
    r1 = r2
  }
  return gen(out)
}

function renderImages(group: SceneGroup): string {
  const links = group.hasLinks === true
  let out = markContainerOpen('image')
  const w = new StringAttrSink()
  for (const it of itemsOf(group)) {
    if (it.url == null || it.x == null || it.y == null) continue
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
  const w = it.width ?? 0
  const h = it.height ?? 0
  const align = it.align
  const baseline = it.baseline
  return {
    x: (it.x || 0) - (align === 'center' ? w / 2 : align === 'right' ? w : 0),
    y: (it.y || 0) - (baseline === 'middle' ? h / 2 : baseline === 'bottom' ? h : 0),
    w,
    h,
    smooth: (it as Record<string, unknown>).smooth !== false,
  }
}

function renderArcs(group: SceneGroup): string {
  const links = group.hasLinks === true
  let out = markContainerOpen('arc')
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
  if ((v = it.fill) != null) w.a('fill', v)
  if ((v = it.fillOpacity) != null) w.a('fill-opacity', v)
  if ((v = it.stroke) != null) w.a('stroke', v)
  if ((v = it.strokeOpacity) != null) w.a('stroke-opacity', v)
  if ((v = strokeWidth ?? it.strokeWidth) != null) w.a('stroke-width', v)
  if ((v = it.strokeCap) != null) w.a('stroke-linecap', v)
  if ((v = it.strokeJoin) != null) w.a('stroke-linejoin', v)
  if ((v = it.strokeDash) != null) w.a('stroke-dasharray', v)
  if ((v = it.strokeDashOffset) != null) w.a('stroke-dashoffset', v)
  if ((v = it.strokeMiterLimit) != null) w.a('stroke-miterlimit', v)
  if ((v = it.opacity) != null) w.a('opacity', v)
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
  const clip = recOf(it)._clip as { x?: number; y?: number; w: number; h: number } | undefined
  return clip ? clips.id({ x: clip.x ?? 0, y: clip.y ?? 0, w: clip.w, h: clip.h }) : null
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
  w.g('d', info.path)
  paintAttrs(info.first, w, undefined, info.sw)
}

/** An area mark's path: vega styles it from the first item. */
export function areaMarkAttrs(info: NonNullable<ReturnType<typeof computeAreaPath>>, w: AttrSink): void {
  w.g('d', info.path)
  paintAttrs(info.first, w)
}

export function circleAttrs(it: SceneItem, w: AttrSink): void {
  const r = it.radius != null ? it.radius : Math.sqrt((it.size as number) ?? SYMBOL_DEFAULT_SIZE) / 2
  itemDatumAttr(it, w)
  w.n('cx', it.x)
  w.n('cy', it.y)
  w.n('r', r)
  paintAttrs(it, w)
}

/** A rect mark item's path attributes (`datum: false` for the clipped-scope fallback, which never carried it). */
export function rectPathAttrs(it: SceneItem, d: GeneratedPath, w: AttrSink, datum = true): void {
  if (datum) itemDatumAttr(it, w)
  w.g('d', d)
  paintAttrs(it, w)
}

/**
 * vega still emits an unpainted rect path (no fill/stroke attributes); only
 * explicitly-null paint marks (the selection brush frame) are skipped.
 */
export const rectIsPainted = (it: SceneItem): boolean => !(it.fill === null && it.stroke === null)

/** A `path`/`shape`/`geoshape` item: vega path mark attr `[vector-effect] transform d`. */
export function pathItemAttrs(it: SceneItem, w: AttrSink): void {
  if (pathVectorEffect(it)) w.v('vector-effect', 'non-scaling-stroke')
  w.t('transform', transformItemTransform(it))
  itemDatumAttr(it, w)
  w.v('d', it.path)
  paintAttrs(it, w)
}

/** The trail polygon carries the full paint set of the FIRST item (vega). */
export function trailAttrs(d: GeneratedPath, first: SceneItem, w: AttrSink): void {
  w.g('d', d)
  paintAttrs(first, w)
}

export function imageAttrs(it: SceneItem, w: AttrSink): void {
  const d = imageDesc(it)
  itemDatumAttr(it, w)
  w.v('xlink:href', it.url)
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

/**
 * A nested group's header attributes. When `clips` is passed the group is
 * clipped: to its own clip path, else to its own `gw` x `gh` at (0,0).
 */
export function markGroupAttrs(group: SceneGroup, w: AttrSink, clips?: ClipCollector, gw = 0, gh = 0): void {
  w.v('class', 'mark-group')
  if (group.role) w.v('role', group.role)
  if (clips) clipRefAttrs(groupClipId(group, clips, gw, gh), w)
  if (group.x != null || group.y != null) w.t('transform', `translate(${num(group.x ?? 0)},${num(group.y ?? 0)})`)
}

export function stopAttrs(stop: { offset: number; color: string }, w: AttrSink): void {
  w.n('offset', stop.offset)
  w.v('stop-color', stop.color)
}

/**
 * The container `<g>` of a mark type, or null when the type renders nothing.
 * Path-like marks (`shape`, `geoshape`) share the `path` container; arcs carry
 * only a class (vega).
 */
export function markContainerAttrs(type: string, w: AttrSink): boolean {
  let kind: string
  switch (type) {
    case 'arc':
      w.v('class', 'mark-arc role-mark')
      return true
    case 'line': case 'area': case 'trail': case 'symbol': case 'rect': case 'circle': case 'rule': case 'text': case 'image':
      kind = type
      break
    case 'path': case 'shape': case 'geoshape':
      kind = 'path'
      break
    default:
      return false
  }
  w.v('class', `mark-${kind} role-mark`)
  w.v('role', 'graphics-symbol')
  w.v('aria-roledescription', `${kind} mark container`)
  return true
}

function markContainerOpen(type: string): string {
  const w = new StringAttrSink()
  markContainerAttrs(type, w)
  return `<g${w.s}>`
}

/** Gradient definition attributes (direction included). */
export function gradientAttrs(def: { id: string; direction?: string }, w: AttrSink): void {
  w.v('id', def.id)
  if (def.direction === 'horizontal') {
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
