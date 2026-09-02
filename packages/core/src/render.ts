/**
 * Scene -> SVG serializer. Mirrors vega-scenegraph's output structure closely
 * enough that geometry (paths, rects, lines, tick positions) matches the
 * reference renderer; the conformance diff compares normalized geometry.
 */
import type { SceneGroup, SceneItem, SceneRoot } from './types.js'
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
} from 'd3-shape'

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
  return CURVE_MAP[interpolate] ?? null
}

export function renderSceneToSvg(scene: SceneRoot): string {
  const W = scene.width
  const H = scene.height
  const pad = scene.padding ?? { top: 0, right: 0, bottom: 0, left: 0 }

  let out = ''
  out += `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" version="1.1" class="marks" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`
  if (scene.background) out += `<rect width="${W}" height="${H}" fill="${scene.background}"/>`
  out += `<g fill="none" stroke-miterlimit="4" transform="translate(${pad.left},${pad.top})">`
  out += `<g class="mark-group role-frame root" role="graphics-object" aria-roledescription="group mark container"><g transform="translate(0,0)">`
  const plotW = scene.width - pad.left - pad.right
  const plotH = scene.height - pad.top - pad.bottom
  const frameD = scene.frameStroke ? `M0.5,0.5h${plotW}v${plotH}h-${plotW}Z` : `M0,0h${plotW}v${plotH}h-${plotW}Z`
  out += `<path class="background" aria-hidden="true" d="${frameD}"${scene.frameStroke ? ` stroke="${scene.frameStroke}"` : ''}/>`
  out += '<g>'
  // Collect clip refs during rendering
  const clipN = { current: 0, paths: [] as (string | null)[] }
  for (const node of scene.items) {
    out += renderGroup(node, plotW, plotH, clipN)
  }
  out += '</g>'
  out += '<path class="foreground" aria-hidden="true" d="" display="none"/>'
  out += '</g></g></g>'

  // Emit defs at SVG root level (gradients + clip paths)
  if (scene.defs?.length || clipN.current > 0) {
    out += '<defs>'
    for (const def of scene.defs ?? []) {
      const horiz = def.direction === 'horizontal'
      out += horiz ? `<linearGradient id="${def.id}" x1="0" x2="1" y1="0" y2="0">` : `<linearGradient id="${def.id}" x1="0" x2="0" y1="1" y2="0">`
      for (const stop of def.colorStops) {
        out += `<stop offset="${stop.offset}" stop-color="${stop.color}"/>`
      }
      out += '</linearGradient>'
    }
    for (let i = 1; i <= clipN.current; i++) {
      const d = clipN.paths[i - 1]
      if (d) {
        out += `<clipPath id="clip${i}"><path d="${d}"/></clipPath>`
      } else {
        out += `<clipPath id="clip${i}"><rect x="0" y="0" width="${plotW}" height="${plotH}"/></clipPath>`
      }
    }
    out += '</defs>'
  }

  out += '</svg>'
  return out
}

function renderGroup(group: SceneGroup, plotW?: number, plotH?: number, clipN?: { current: number; paths: (string | null)[] }): string {
  const type = group.marktype
  const needsClip = clipN
    && group.clip === true
    && plotW != null
    && plotH != null

  if (!type || type === 'group') {
    // axis / legend / nested group whose items may be leaf shapes
    let transform = ''
    if (group.x != null || group.y != null) transform = ` transform="translate(${num(group.x ?? 0)},${num(group.y ?? 0)})"`
    let out2 = '<g class="mark-group"'
    if (group.role) out2 += ` role="${group.role}"`
    if (needsClip) {
      const clipId = ++clipN.current
      clipN.paths.push(group.clipPathD ?? null)
      out2 += ` clip-path="url(#clip${clipId})"`
    }
    out2 += `${transform}>`
    for (const item of group.items ?? []) {
      if (isGroup(item)) out2 += renderGroup(item, plotW, plotH, clipN)
      else out2 += renderLeaf(item)
    }
    out2 += '</g>'
    return out2
  }

  // For mark groups, wrap in a clip'd outer <g> if needed
  const inner = switchMarkup(type, group)

  if (needsClip && clipN) {
    const clipId = ++clipN.current
    clipN.paths.push(group.clipPathD ?? null)
    return `<g clip-path="url(#clip${clipId})">${inner}</g>`
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
function renderLeaf(it: SceneItem): string {
  // Path items
  if (it.path != null) {
    // Apply the item's x/y as a translate so legend/entry paths (whose `d`
    // starts at M0,0) land at their intended position, matching vega's
    // nested-scope transforms. Items with x=y=0 emit no transform.
    const tx = num(it.x ?? 0)
    const ty = num(it.y ?? 0)
    const transform = (tx !== '0' || ty !== '0') ? ` transform="translate(${tx},${ty})"` : ''
    return `<path${transform} d="${it.path}"${attr('fill', it.fill)}${attr('stroke', it.stroke)}${attr('stroke-width', it.strokeWidth)}${attr('opacity', it.opacity)}/>`
  }
  // Symbol items (circle arc path)
  if (it.shape != null && it.radius != null) {
    const rNum = num(it.radius)
    const d = `M${rNum},0A${rNum},${rNum},0,1,1,${-rNum},0A${rNum},${rNum},0,1,1,${rNum},0`
    const t = `transform="translate(${num(it.x ?? 0)},${num(it.y ?? 0)})"`
    return `<path ${t} d="${d}"${attr('fill', it.fill)}${attr('fill-opacity', it.fillOpacity)}${attr('stroke', it.stroke)}${attr('stroke-width', it.strokeWidth)}${attr('opacity', it.opacity)}/>`
  }
  if (it.text != null) {
    const fontSize = (it as Record<string, unknown>).fontSize as number | undefined
    return `<text x="${num(it.x ?? 0)}" y="${num(it.y ?? 0)}"${attr('text-anchor', it.align === 'right' ? 'end' : it.align === 'left' ? 'start' : 'middle')}${fontSize != null ? ` font-size="${num(fontSize)}px"` : ''}${attr('fill', it.fill)}${attr('opacity', it.opacity)}>${esc(String(it.text))}</text>`
  }
  const x2 = it.x2 ?? it.x ?? 0
  const y2 = it.y2 ?? it.y ?? 0
  return `<line x1="${num(it.x ?? 0)}" y1="${num(it.y ?? 0)}" x2="${num(x2)}" y2="${num(y2)}"${attr('stroke', it.stroke)}${attr('stroke-width', it.strokeWidth)}${attr('stroke-dasharray', it.strokeDash)}${attr('opacity', it.opacity)}/>`
}

function itemsOf(group: SceneGroup): SceneItem[] {
  return group.items ?? []
}

function renderLine(group: SceneGroup): string {
  const items = itemsOf(group)
  let out = `<g class="mark-line role-mark" role="graphics-symbol" aria-roledescription="line mark container">`
  const pathInfo = computeLinePath(group)
  if (pathInfo) {
    const { path, stroke, sw, strokeDash, opacity } = pathInfo
    out += `<path d="${path}"${stroke ? ` stroke="${stroke}"` : ''}${sw != null ? ` stroke-width="${num(sw)}"` : ''}${attr('stroke-dasharray', strokeDash)}${opacity != null ? ` opacity="${num(opacity)}"` : ''}/>`
  }
  out += '</g>'
  return out
}

/** Shared line-path geometry for the string renderer and the DOM patcher. */
export function computeLinePath(group: SceneGroup): {
  path: string
  stroke?: string
  sw?: number
  strokeDash?: number[]
  opacity?: number
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
      const lineGen = d3Line<Pt>()
        .x((d: Pt) => d.x)
        .y((d: Pt) => d.y)
        .defined((d: Pt) => d.defined)
        .curve(curveFn as Parameters<ReturnType<typeof d3Line<Pt>>['curve']>[0])

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
        path += `M${num(r.x)},${num(r.y)}`
        penDown = true
      } else {
        path += `L${num(r.x)},${num(r.y)}`
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
  // Vega default: line marks have strokeWidth=2
  const sw = strokeWidth ?? (stroke != null ? 2 : undefined)
  return { path, stroke, sw, strokeDash, opacity }
}

/** Shared area-path geometry for the string renderer and the DOM patcher. */
export function computeAreaPath(group: SceneGroup): {
  path: string
  fill?: string | { gradient: string }
  fillOpacity?: number
  stroke?: string | { gradient: string }
  strokeWidth?: number
  strokeOpacity?: number
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
  const pts: Array<{ pos: number; val: number; val2: number; defined: boolean }> = items.map((it) => ({
    pos: isHorizontal ? (it.y as number) : (it.x as number),
    val: isHorizontal ? (it.x as number) : (it.y as number),
    val2: isHorizontal ? ((it.x2 as number) ?? 0) : (it.y2 as number),
    defined: it.defined !== false && it.x != null && it.y != null,
  }))

  // Sort items by position. Vega sorts by the dependent axis value, which
  // produces ascending position for vertical areas (x ascending) and
  // descending position for horizontal areas (y descending in SVG coords,
  // i.e. data y ascending mapped through an inverted y scale).
  if (isHorizontal) {
    pts.sort((a, b) => b.pos - a.pos)
  }

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
        const areaGen = d3Area<AreaPt>()
          .y((d: AreaPt) => d.y)
          .x0((d: AreaPt) => d.x0)
          .x1((d: AreaPt) => d.x1)
          .defined((d: AreaPt) => d.defined)
          .curve(curveFn as Parameters<ReturnType<typeof d3Area<AreaPt>>['curve']>[0])

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
        const areaGen = d3Area<AreaPt>()
          .x((d: AreaPt) => d.x)
          .y0((d: AreaPt) => d.y0)
          .y1((d: AreaPt) => d.y1)
          .defined((d: AreaPt) => d.defined)
          .curve(curveFn as Parameters<ReturnType<typeof d3Area<AreaPt>>['curve']>[0])

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
              path += `L${num(q.val2)},${num(q.pos)}`
            } else {
              path += `L${num(q.pos)},${num(q.val2)}`
            }
          }
          path += 'Z'
          penDown = false
        }
        continue
      }
      if (!penDown) {
        if (isHorizontal) {
          path += `M${num(p.val)},${num(p.pos)}`
        } else {
          path += `M${num(p.pos)},${num(p.val)}`
        }
        penDown = true
      } else {
        if (isHorizontal) {
          path += `L${num(p.val)},${num(p.pos)}`
        } else {
          path += `L${num(p.pos)},${num(p.val)}`
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
    path,
    fill: items[0]?.fill as string | { gradient: string } | undefined,
    fillOpacity: items[0]?.fillOpacity as number | undefined,
    stroke: items[0]?.stroke as string | { gradient: string } | undefined,
    strokeWidth: items[0]?.strokeWidth as number | undefined,
    strokeOpacity: items[0]?.strokeOpacity as number | undefined,
  }
}

function renderArea(group: SceneGroup): string {
  const info = computeAreaPath(group)
  let out = `<g class="mark-area role-mark" role="graphics-symbol" aria-roledescription="area mark container">`
  if (info) {
    const { path, fill, fillOpacity, stroke, strokeWidth, strokeOpacity } = info
    out += `<path d="${path}"${fill ? ` fill="${fill}"` : ''}${fillOpacity != null ? ` fill-opacity="${num(fillOpacity)}"` : ''}${attr('stroke', stroke)}${attr('stroke-width', strokeWidth)}${attr('stroke-opacity', strokeOpacity)}/>`
  }
  out += '</g>'
  return out
}

/** Generate an SVG path d attribute for a given symbol shape and radius. */
export function symbolPath(shape: string | undefined, r: number): string {
  switch (shape) {
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
      const h = r * 0.866
      return `M0,${num(-h)}L${num(-r)},${num(h)}L${num(r)},${num(h)}Z`
    }
    case 'triangle-down': {
      const h = r * 0.866
      return `M0,${num(h)}L${num(-r)},${num(-h)}L${num(r)},${num(-h)}Z`
    }
    case 'triangle-right': {
      const h = r * 0.866
      return `M${num(-h)},0L${num(h)},${num(-r)}L${num(h)},${num(r)}Z`
    }
    case 'triangle-left': {
      const h = r * 0.866
      return `M${num(h)},0L${num(-h)},${num(-r)}L${num(-h)},${num(r)}Z`
    }
    case 'stroke':
      return `M${num(-r)},0L${num(r)},0`
    default:
      return `M${num(r)},0A${num(r)},${num(r)},0,1,1,${num(-r)},0A${num(r)},${num(r)},0,1,1,${num(r)},0`
  }
}

function renderSymbols(group: SceneGroup): string {
  let out = `<g class="mark-symbol role-mark" role="graphics-symbol" aria-roledescription="symbol mark container">`
  for (const it of itemsOf(group)) {
    if (it.x == null || it.y == null) continue
    const size = (it.size as number) ?? 30
    const r = Math.sqrt(size) / 2
    const shape = (it as Record<string, unknown>).shape as string | undefined
    const d = symbolPath(shape, r)
    // Vega-Lite: point marks default fill="transparent", stroke from scale or default.
    // The strokeWidth default (2px for the point/circle/square styles) is baked
    // into the item at mark-build time; a raw vega symbol mark with a stroke but
    // no style carries no default width.
    // Only output fill if it's explicitly set to a non-default value (transparent is SVG default for paths)
    const fillAttr = it.fill != null && it.fill !== 'transparent' ? ` fill="${it.fill}"` : ''
    out += `<path transform="translate(${num(it.x)},${num(it.y)})" d="${d}"${fillAttr}${attr('fill-opacity', it.fillOpacity)}${attr('stroke', it.stroke)}${attr('stroke-width', it.strokeWidth)}${attr('stroke-dasharray', it.strokeDash)}${attr('opacity', it.opacity)}/>`
  }
  out += '</g>'
  return out
}

/** Circle mark: renders `<circle cx cy r>` elements (radius from `radius` or size). */
function renderCircles(group: SceneGroup): string {
  let out = `<g class="mark-circle role-mark" role="graphics-symbol" aria-roledescription="circle mark container">`
  for (const it of itemsOf(group)) {
    if (it.x == null || it.y == null) continue
    const r = it.radius != null
      ? it.radius
      : Math.sqrt((it.size as number) ?? 30) / 2
    out += `<circle cx="${num(it.x)}" cy="${num(it.y)}" r="${num(r)}"${attr('fill', it.fill)}${attr('fill-opacity', it.fillOpacity)}${attr('stroke', it.stroke)}${attr('stroke-width', it.strokeWidth)}${attr('opacity', it.opacity)}/>`
  }
  out += '</g>'
  return out
}

function renderRects(group: SceneGroup): string {
  let out = `<g class="mark-rect role-mark" role="graphics-symbol" aria-roledescription="rect mark container">`
  for (const it of itemsOf(group).slice().reverse()) {
    const d = rectItemPath(it)
    if (d == null) continue
    out += `<path d="${d}"${attr('fill', it.fill)}${attr('fill-opacity', it.fillOpacity)}${attr('stroke', it.stroke)}${attr('stroke-width', it.strokeWidth)}${attr('opacity', it.opacity)}/>`
  }
  out += '</g>'
  return out
}

/**
 * Shared rect geometry for the string renderer and the DOM patcher.
 * Vega renders rect marks as path elements (with optional cornerRadius).
 * Returns null when the item has no resolvable width/height.
 */
export function rectItemPath(it: SceneItem): string | null {
  let w = it.width
  let h = it.height
  // Vega-scenegraph renders rects with undefined positions at (0,0)
  // (`item.x || 0`, `item.y || 0`), so default missing x/y to 0 rather than
  // dropping the rect.
  let x0 = it.x as number | undefined ?? 0
  let y0 = it.y as number | undefined ?? 0
  // When x2/y2 are present, vega normalizes the rect so that x is the min
  // edge and width is positive (same for y). This keeps the path winding
  // consistent (positive h first) regardless of which edge is "x" vs "x2".
  if (w == null && it.x2 != null) { w = Math.abs((it.x2 as number) - x0); x0 = Math.min(x0, it.x2 as number) }
  if (h == null && it.y2 != null) { h = Math.abs((it.y2 as number) - y0); y0 = Math.min(y0, it.y2 as number) }
  if (w == null || h == null) return null
  // Vega's rounded-rect path builder (vega-scenegraph/path/rectangle.js):
  // per-corner radii clamped to min(w,h)/2, quarter arcs approximated by
  // cubics with C = 0.448084975506.
  const rec = it as Record<string, unknown>
  const cr = (rec.cornerRadius as number | undefined) ?? 0
  const s = Math.min(w, h) / 2
  const clampR = (v: unknown) => Math.max(0, Math.min(typeof v === 'number' ? v : cr, s))
  const tl = clampR(rec.cornerRadiusTopLeft)
  const tr = clampR(rec.cornerRadiusTopRight)
  const br = clampR(rec.cornerRadiusBottomRight)
  const bl = clampR(rec.cornerRadiusBottomLeft)
  if (tl > 0 || tr > 0 || bl > 0 || br > 0) {
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
  let out = `<g class="mark-rule role-mark" role="graphics-symbol" aria-roledescription="rule mark container">`
  for (const it of itemsOf(group)) {
    // Vega defaults undefined x/y to 0 (scenegraph item defaults), so even
    // degenerate rules with unresolved fields render as zero-length lines at
    // the origin rather than being skipped.
    const x = it.x ?? 0
    const y = it.y ?? 0
    const x2 = it.x2 ?? x
    const y2 = it.y2 ?? y
    out += `<line x1="${num(x)}" y1="${num(y)}" x2="${num(x2)}" y2="${num(y2)}"${attr('stroke', it.stroke)}${attr('stroke-width', it.strokeWidth)}${attr('stroke-dasharray', it.strokeDash)}${attr('opacity', it.opacity)}/>`
  }
  out += '</g>'
  return out
}

function renderTexts(group: SceneGroup): string {
  let out = `<g class="mark-text role-mark" role="graphics-symbol" aria-roledescription="text mark container">`
  for (const it of itemsOf(group)) {
    const d = textItemDesc(it)
    if (d == null) continue
    // Vega's SVG text renderer emits the first line as the text element's
    // content and each following line as `<tspan x="0" dy="lineHeight">`
    // (vega-scenegraph svg.js `textLines`).
    // Single-line text renders as a plain text node (vega `m.text`); only
    // genuinely multi-line items use tspans.
    let inner = ''
    if (d.lines.length === 1) {
      inner = esc(d.text)
    } else {
      for (let i = 0; i < d.lines.length; i++) {
        inner += i === 0
          ? `<tspan>${esc(d.lines[i]!)}</tspan>`
          : `<tspan x="0" dy="${num(d.lineHeight)}">${esc(d.lines[i]!)}</tspan>`
      }
    }
    out += `<text x="${d.x}" y="${d.y}"${d.dyAttr}${d.attrs.map(([k, v]) => attr(k, v)).join('')}>${inner}</text>`
  }
  out += '</g>'
  return out
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

/**
 * Shared text-mark geometry for the string renderer and the DOM patcher.
 * Returns null for items with no text content. `x`/`y` are pre-formatted;
 * `attrs` is the ordered presentation-attribute list (fill, anchor, ...).
 */
export function textItemDesc(it: SceneItem): {
  x: string
  y: string
  dyAttr: string
  attrs: Array<[string, unknown]>
  text: string
  /** Rendered lines after split/truncate; length > 1 means tspans follow. */
  lines: string[]
  lineHeight: number
} | null {
  if (it.text == null) return null
  // Vega's text renderer adds a baseline offset (rounded to whole px, vega
  // util/text.js `offset`):
  //   top → round(0.79 * fontSize), middle → round(0.30 * fontSize),
  //   bottom → round(-0.21 * fontSize), default fontSize is 11.
  const fontSize = (it as Record<string, unknown>).fontSize as number | undefined ?? 11
  const fontWeight = (it as Record<string, unknown>).fontWeight as string | number | undefined
  const baseline = it.baseline ?? 'alphabetic'
  const baseX = it.x ?? 0
  const baseY = it.y ?? 0
  const angle = it.angle
  // Apply dx/dy offsets from encode (data-driven positioning).
  const dx = (it as Record<string, unknown>).dx as number | undefined ?? 0
  const dy = (it as Record<string, unknown>).dy as number | undefined ?? 0
  const lines = textLinesOf(it).map((l) => truncateToLimit(it, l, fontSize))
  const lineHeight = (it as Record<string, unknown>).lineHeight as number | undefined ?? fontSize + 2
  const text = lines[0]!
  // When text is rotated, Vega renders with dy for baseline offset rather
  // than baking it into y; for non-rotated text the offset goes into y.
  const isRotated = angle != null && angle !== 0
  let bsOffset = 0
  if (baseline === 'top') bsOffset = Math.round(0.79 * fontSize)
  else if (baseline === 'middle') bsOffset = Math.round(0.30 * fontSize)
  else if (baseline === 'bottom') bsOffset = Math.round(-0.21 * fontSize)
  // alphabetic / default → 0 (no offset)
  const x = num(baseX + dx)
  const y = isRotated ? num(baseY + dy) : num(baseY + dy + bsOffset)
  const textAnchor = it.align === 'right' ? 'end' : it.align === 'left' ? 'start' : 'middle'
  const attrs: Array<[string, unknown]> = []
  if (textAnchor != null) attrs.push(['text-anchor', textAnchor])
  attrs.push(['font-size', fontSize !== 11 ? fontSize : undefined])
  attrs.push(['font-weight', fontWeight])
  attrs.push(['fill', it.fill])
  attrs.push(['opacity', it.opacity])
  attrs.push(['angle', it.angle])
  return { x, y, dyAttr: isRotated && bsOffset ? ` dy="${num(bsOffset)}"` : '', attrs, text, lines, lineHeight }
}

/**
 * Vega text `limit`: maximum pixel width, truncated with an ellipsis.
 * Mirrors vega-scenegraph/src/util/text.js `truncate()` using the estimate
 * width fn: ~~(0.8 * str.length * fontSize).
 */
function truncateToLimit(it: SceneItem, text: string, fontSize: number): string {
  const limit = (it as Record<string, unknown>).limit as number | undefined
  if (limit == null || !(limit > 0) || !text.length) return text
  const estimateW = (s: string) => ~~(0.8 * s.length * fontSize)
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
  let out = `<g class="mark-path role-mark" role="graphics-symbol" aria-roledescription="path mark container">`
  for (const it of itemsOf(group)) {
    if (!it.path) continue
    // Position the path at its item x/y (vega renders path marks with a
    // translate transform; items whose path already encodes absolute
    // coordinates (e.g. geoshape output) have x=y=0 and emit no transform).
    const tx = num(it.x ?? 0)
    const ty = num(it.y ?? 0)
    const transform = (tx !== '0' || ty !== '0') ? ` transform="translate(${tx},${ty})"` : ''
    out += `<path${transform} d="${it.path}"${attr('fill', it.fill)}${attr('fill-opacity', it.fillOpacity)}${attr('stroke', it.stroke)}${attr('stroke-width', it.strokeWidth)}${attr('opacity', it.opacity)}/>`
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
  let out = `<g class="mark-trail role-mark" role="graphics-symbol" aria-roledescription="trail mark container">`
  const items = itemsOf(group)
  if (items.length > 1) {
    const d = trailPath(items)
    if (d) {
      const first = items[0]!
      out += `<path d="${d}"${attr('stroke', first.stroke)}${attr('stroke-width', first.strokeWidth)}${attr('opacity', first.opacity)}/>`
    }
  }
  out += '</g>'
  return out
}

/** Compute the vega/d3-trail polygon path for a run of trail items. */
export function trailPath(items: SceneItem[]): string {
  let out = ''
  let ready = false
  let x1 = 0, y1 = 0, r1 = 0
  for (const it of items) {
    const x2 = it.x as number
    const y2 = it.y as number
    const r2 = ((it.size as number) ?? 1) / 2
    if (ready) {
      const ux0 = y1 - y2
      const uy0 = x2 - x1
      if (ux0 || uy0) {
        const ud = Math.hypot(ux0, uy0)
        const ux = ux0 / ud
        const uy = uy0 / ud
        const rx = ux * r1
        const ry = uy * r1
        // Tapered segment: two perpendicular edge offsets and semicircular
        // end caps (SVG arcs with large-arc=1, sweep=1, matching d3-path).
        out += `M${num(x1 - rx)},${num(y1 - ry)}`
        out += `L${num(x2 - ux * r2)},${num(y2 - uy * r2)}`
        out += `A${num(r2)},${num(r2)},0,1,1,${num(x2 + r2 * ux)},${num(y2 + r2 * uy)}`
        out += `L${num(x1 + rx)},${num(y1 + ry)}`
        out += `A${num(r1)},${num(r1)},0,1,1,${num(x1 - r1 * ux)},${num(y1 - r1 * uy)}`
        out += 'Z'
      } else {
        // Identical consecutive points: a full circle cap around the point.
        out += `L${num(x2 + r2)},${num(y2)}A${num(r2)},${num(r2)},0,1,1,${num(x2 - r2)},${num(y2)}A${num(r2)},${num(r2)},0,1,1,${num(x2 + r2)},${num(y2)}Z`
      }
    } else {
      ready = true
    }
    x1 = x2
    y1 = y2
    r1 = r2
  }
  return out
}

function renderImages(group: SceneGroup): string {
  let out = `<g class="mark-image role-mark" role="graphics-symbol" aria-roledescription="image mark container">`
  for (const it of itemsOf(group)) {
    if (it.url == null || it.x == null || it.y == null) continue
    const w = it.width ?? 0
    const h = it.height ?? 0
    out += `<image xlink:href="${esc(String(it.url))}" transform="translate(${num(it.x)},${num(it.y)})" width="${num(w)}" height="${num(h)}" preserveAspectRatio="${it.aspect === false ? 'none' : 'xMidYMid'}"/>`
  }
  out += '</g>'
  return out
}

function renderArcs(group: SceneGroup): string {
  let out = `<g class="mark-arc role-mark">`
  for (const it of itemsOf(group)) {
    const x = it.x as number
    const y = it.y as number
    const r = (it.outerRadius as number) ?? (it.radius as number) ?? 0
    const r0 = (it.innerRadius as number) ?? 0
    const a0 = (it.startAngle as number) ?? 0
    const a1 = (it.endAngle as number) ?? 0
    out += `<path d="${arcPath(x, y, r, r0, a0, a1)}"${attr('fill', it.fill)}${attr('fill-opacity', it.fillOpacity)}${attr('stroke', it.stroke)}${it.stroke != null ? attr('stroke-width', it.strokeWidth) : ''}/>`
  }
  out += '</g>'
  return out
}

export function arcPath(cx: number, cy: number, r: number, r0: number, a0in: number, a1in: number): string {
  // d3-arc measures angles from the +x axis and rotates by -π/2 so that
  // angle 0 points up (12 o'clock). Match that reference frame here.
  const a0 = a0in - Math.PI / 2
  const a1 = a1in - Math.PI / 2
  // d3-arc draws the outer arc clockwise when a1 > a0, counterclockwise
  // otherwise; the SVG sweep flag mirrors that (1 = clockwise in SVG's
  // y-down coordinate system).
  const cw = a1 > a0
  const sweep = cw ? 1 : 0
  // da is the positive sweep magnitude; the large-arc flag is set when the
  // arc spans at least half a turn (d3-path uses `da >= π`).
  let da = Math.abs(a1 - a0)
  if (da >= 2 * Math.PI) da = da % (2 * Math.PI)
  const large = da >= Math.PI ? 1 : 0
  const p0x = cx + r * Math.cos(a0)
  const p0y = cy + r * Math.sin(a0)
  const p1x = cx + r * Math.cos(a1)
  const p1y = cy + r * Math.sin(a1)
  // When r0 === 0, omit inner arc and line-to-center (d3-arc produces simpler path)
  if (r0 === 0) {
    return [
      `M${num(p0x)},${num(p0y)}`,
      `A${num(r)},${num(r)},0,${large},${sweep},${num(p1x)},${num(p1y)}`,
      `L${cx},${cy}`,
      'Z',
    ].join('')
  }
  const i0x = cx + r0 * Math.cos(a1)
  const i0y = cy + r0 * Math.sin(a1)
  const i1x = cx + r0 * Math.cos(a0)
  const i1y = cy + r0 * Math.sin(a0)
  return [
    `M${num(p0x)},${num(p0y)}`,
    `A${num(r)},${num(r)},0,${large},${sweep},${num(p1x)},${num(p1y)}`,
    `L${num(i0x)},${num(i0y)}`,
    `A${num(r0)},${num(r0)},0,${large},${sweep ? 0 : 1},${num(i1x)},${num(i1y)}`,
    'Z',
  ].join('')
}

function attr(name: string, value: unknown): string {
  if (value == null) return ''
  if (Array.isArray(value)) return ` ${name}="${value.join(',')}"`
  if (typeof value === 'number') return ` ${name}="${num(value)}"`
  return ` ${name}="${esc(String(value))}"`
}

const ESC_CACHE = new Map<string, string>()

function esc(s: string): string {
  const cached = ESC_CACHE.get(s)
  if (cached !== undefined) return cached
  const out = s.includes('&') || s.includes('<') || s.includes('>') || s.includes('"')
    ? s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    : s
  if (ESC_CACHE.size < 2048) ESC_CACHE.set(s, out)
  return out
}

export function num(x: number): string {
  if (!Number.isFinite(x)) return String(x)
  if (Number.isInteger(x)) return String(x)
  return String(Math.round(x * 1000) / 1000)
}
