/**
 * Scene -> SVG serializer. Mirrors vega-scenegraph's output structure closely
 * enough that geometry (paths, rects, lines, tick positions) matches the
 * reference renderer; the conformance diff compares normalized geometry.
 */
import type { SceneGroup, SceneItem, SceneRoot } from './types.js'
import { baselineOffset } from './bounds.js'
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
  const plotW = scene.plotWidth ?? scene.width - pad.left - pad.right
  const plotH = scene.plotHeight ?? scene.height - pad.top - pad.bottom
  const frameD = scene.frameStroke ? `M0.5,0.5h${plotW}v${plotH}h-${plotW}Z` : `M0,0h${plotW}v${plotH}h-${plotW}Z`
  out += `<path class="background" aria-hidden="true" d="${frameD}"${scene.frameStroke ? ` stroke="${scene.frameStroke}"` : ''}/>`
  out += '<g>'
  // Collect clip refs during rendering
  const clipN = { current: 0, paths: [] as (string | null)[] }
  for (const node of scene.items) {
    out += renderGroup(node, plotW, plotH, clipN, W, H)
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

function renderGroup(group: SceneGroup, plotW?: number, plotH?: number, clipN?: { current: number; paths: (string | null)[] }, viewW?: number, viewH?: number): string {
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
      if (isGroup(item)) out2 += renderGroup(item, plotW, plotH, clipN, viewW, viewH)
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
function dataDatumAttr(it: SceneItem): string {
  const v = (it as unknown as { dataDatum?: string }).dataDatum
  return v ? ` data-datum="${esc(v)}"` : ''
}

/** Vega text `limit` truncation for bare guide leaves (estimate-width path). */
function truncateLeaf(text: string, it: SceneItem, fontSize: number): string {
  const limit = (it as Record<string, unknown>).limit as number | undefined
  if (limit == null || !(limit > 0) || !text.length) return text
  const estimateW = (str: string) => ~~(0.8 * str.length * fontSize)
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

function renderLeaf(it: SceneItem): string {
  const dd = dataDatumAttr(it)
  // Path items
  if (it.path != null) {
    // Apply the item's x/y as a translate so legend/entry paths (whose `d`
    // starts at M0,0) land at their intended position, matching vega's
    // nested-scope transforms. Items with x=y=0 emit no transform.
    const tx = num(it.x ?? 0)
    const ty = num(it.y ?? 0)
    const transform = (tx !== '0' || ty !== '0') ? ` transform="translate(${tx},${ty})"` : ''
    return `<path${transform}${dd} d="${it.path}"${attr('fill', it.fill)}${attr('stroke', it.stroke)}${attr('stroke-width', it.strokeWidth)}${attr('opacity', it.opacity)}/>`
  }
  // Symbol items (shape path; 'circle' renders the arc form)
  if (it.shape != null && it.radius != null) {
    const d = symbolPath(it.shape as string, it.radius as number)
    const t = `transform="translate(${num(it.x ?? 0)},${num(it.y ?? 0)})"`
    return `<path ${t}${dd} d="${d}"${attr('fill', it.fill)}${attr('fill-opacity', it.fillOpacity)}${attr('stroke', it.stroke)}${attr('stroke-width', it.strokeWidth)}${attr('opacity', it.opacity)}/>`
  }
  if (it.text != null) {
    const fontSize = (it as Record<string, unknown>).fontSize as number | undefined
    const fam = (it as Record<string, unknown>).font as string | undefined
    // Vega's renderer shifts text down by the baseline offset (util/text.js
    // `offset`); guide builders emit vega's raw item y, so the bake happens
    // here, exactly where vega applies it. Rotated text keeps the offset in
    // the rotate frame (vega emits `translate(x,y) rotate(a) translate(0,off)`
    // — the item y stays raw), so no bake when an angle is present.
    const baseline = it.baseline as string | undefined
    const angle = (it as Record<string, unknown>).angle as number | undefined
    const bOff = baseline && baseline !== 'alphabetic' && !(angle != null && angle !== 0)
      ? baselineOffset(it)
      : 0
    const y = num((it.y ?? 0) + bOff)
    const raw = String(it.text)
    const text = truncateLeaf(raw, it, fontSize ?? 11)
    return `<text x="${num(it.x ?? 0)}" y="${y}"${attr('text-anchor', it.align === 'right' ? 'end' : it.align === 'left' ? 'start' : 'middle')}${fontSize != null ? ` font-size="${num(fontSize)}px"` : ''}${attr('font-family', fam)}${attr('fill', it.fill)}${attr('fill-opacity', it.fillOpacity)}${attr('opacity', it.opacity)}>${esc(text)}</text>`
  }
  const x2 = it.x2 ?? it.x ?? 0
  const y2 = it.y2 ?? it.y ?? 0
  return `<line x1="${num(it.x ?? 0)}" y1="${num(it.y ?? 0)}" x2="${num(x2)}" y2="${num(y2)}"${attr('fill-opacity', it.fillOpacity)}${attr('stroke', it.stroke)}${attr('stroke-width', it.strokeWidth)}${attr('stroke-dasharray', it.strokeDash)}${attr('stroke-opacity', it.strokeOpacity)}${attr('opacity', it.opacity)}/>`
}

function itemsOf(group: SceneGroup): SceneItem[] {
  return group.items ?? []
}

function renderLine(group: SceneGroup): string {
  const items = itemsOf(group)
  let out = `<g class="mark-line role-mark" role="graphics-symbol" aria-roledescription="line mark container">`
  const pathInfo = computeLinePath(group)
  if (pathInfo) {
    const { path, stroke, sw, strokeDash, opacity, fillOpacity } = pathInfo
    out += `<path d="${path}"${stroke ? ` stroke="${stroke}"` : ''}${sw != null ? ` stroke-width="${num(sw)}"` : ''}${attr('stroke-dasharray', strokeDash)}${attr('fill-opacity', fillOpacity)}${opacity != null ? ` opacity="${num(opacity)}"` : ''}/>`
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
  fillOpacity?: number
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
  const fillOpacity = group.items?.[0]?.fillOpacity as number | undefined
  // Vega default: line marks have strokeWidth=2
  const sw = strokeWidth ?? (stroke != null ? 2 : undefined)
  return { path, stroke, sw, strokeDash, opacity, fillOpacity }
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
      return `M${num(h)},0L${num(-h)},${num(-r)}L${num(-h)},${num(r)}Z`
    }
    case 'triangle-left': {
      const h = r * 0.866
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
    default:
      return `M${num(r)},0A${num(r)},${num(r)},0,1,1,${num(-r)},0A${num(r)},${num(r)},0,1,1,${num(r)},0`
  }
}

function renderSymbols(group: SceneGroup): string {
  let out = `<g class="mark-symbol role-mark" role="graphics-symbol" aria-roledescription="symbol mark container">`
  for (const it of itemsOf(group)) {
    // A null position (a geopoint the projection refused) renders at the
    // origin: vega emits `translate(null,null)`, which SVG treats as (0,0).
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
    out += `<path transform="translate(${num(it.x ?? 0)},${num(it.y ?? 0)})" d="${d}"${fillAttr}${attr('fill-opacity', it.fillOpacity)}${attr('stroke', it.stroke)}${attr('stroke-width', it.strokeWidth)}${attr('stroke-dasharray', it.strokeDash)}${attr('opacity', it.opacity)}/>`
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
    // vega paints a rect only when it has a fill or stroke; unpainted items
    // (e.g. the selection brush frame with a null stroke) are skipped
    if (it.fill == null && it.stroke == null) continue
    const d = rectItemPath(it)
    if (d == null) continue
    out += `<path${dataDatumAttr(it)} d="${d}"${attr('fill', it.fill)}${attr('fill-opacity', it.fillOpacity)}${attr('stroke', it.stroke)}${attr('stroke-width', it.strokeWidth)}${attr('opacity', it.opacity)}/>`
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
    out += `<line x1="${num(x)}" y1="${num(y)}" x2="${num(x2)}" y2="${num(y2)}"${attr('fill-opacity', it.fillOpacity)}${attr('stroke', it.stroke)}${attr('stroke-width', it.strokeWidth)}${attr('stroke-dasharray', it.strokeDash)}${attr('stroke-opacity', it.strokeOpacity)}${attr('opacity', it.opacity)}/>`
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
  attrs.push(['font-family', (it as Record<string, unknown>).font as string | undefined])
  attrs.push(['fill', it.fill])
  attrs.push(['fill-opacity', (it as Record<string, unknown>).fillOpacity])
  attrs.push(['stroke', it.stroke])
  attrs.push(['stroke-opacity', (it as Record<string, unknown>).strokeOpacity])
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
      // vega's trail path carries the full paint set from the first item.
      out += `<path d="${d}"${attr('fill', first.fill)}${attr('fill-opacity', first.fillOpacity)}${attr('opacity', first.opacity)}${attr('stroke', first.stroke)}${attr('stroke-width', first.strokeWidth)}${attr('stroke-dasharray', first.strokeDash)}/>`
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
    // Vega emits the arc path around (0,0) with a per-item translate; the
    // local coordinates round to 3 decimals independently of the (often
    // fractional) position, which the canonical diff depends on.
    // vega's arc attr emits every defined paint property (stroke-width even
    // without a stroke, opacity, dash arrays).
    const cr = (it as Record<string, unknown>).cornerRadius as number | undefined ?? 0
    const pa = (it as Record<string, unknown>).padAngle as number | undefined ?? 0
    out += `<path transform="translate(${num(x)},${num(y)})" d="${arcPath(0, 0, r, r0, a0, a1, cr, pa)}"${attr('fill', it.fill)}${attr('fill-opacity', it.fillOpacity)}${attr('opacity', it.opacity)}${attr('stroke', it.stroke)}${attr('stroke-width', it.strokeWidth)}${attr('stroke-dasharray', it.strokeDash)}${attr('stroke-linecap', it.strokeLineCap)}${attr('stroke-linejoin', it.strokeLineJoin)}/>`
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
  moveTo(x: number, y: number): void { this.s += `M${num(x)},${num(y)}`; this.x1 = x; this.y1 = y; this.hasPoint = true }
  lineTo(x: number, y: number): void { this.s += `L${num(x)},${num(y)}`; this.x1 = x; this.y1 = y; this.hasPoint = true }
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
      this.s += `A${num(r)},${num(r)},0,1,${sweep},${num(x - (x0 - x))},${num(y - (y0 - y))}`
      this.s += `A${num(r)},${num(r)},0,1,${sweep},${num(x0)},${num(y0)}`
      this.x1 = x0; this.y1 = y0
    } else if (da > ARC_EPSILON) {
      this.s += `A${num(r)},${num(r)},0,${da >= Math.PI ? 1 : 0},${sweep},${num(x2)},${num(y2)}`
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

export function arcPath(cx: number, cy: number, rIn: number, r0In: number, a0in: number, a1in: number, cornerRadius = 0, padAngle = 0): string {
  const ctx = new PathEmitter()
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
    return (ctx as unknown as { toString(): string }).toString()
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
    return (ctx as unknown as { toString(): string }).toString()
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
  return (ctx as unknown as { toString(): string }).toString()
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

function attr(name: string, value: unknown): string {
  if (value == null) return ''
  // Vega's SVG renderer omits a 'transparent' paint value (fill/stroke).
  if (value === 'transparent') return ''
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
