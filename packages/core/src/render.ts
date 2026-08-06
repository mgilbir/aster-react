/**
 * Scene -> SVG serializer. Mirrors vega-scenegraph's output structure closely
 * enough that geometry (paths, rects, lines, tick positions) matches the
 * reference renderer; the conformance diff compares normalized geometry.
 */
import type { SceneGroup, SceneItem, SceneRoot } from './types.js'

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
  const clipN = { current: 0 }
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
      out += `<linearGradient id="${def.id}" x1="0" x2="0" y1="1" y2="0">`
      for (const stop of def.colorStops) {
        out += `<stop offset="${stop.offset}" stop-color="${stop.color}"/>`
      }
      out += '</linearGradient>'
    }
    for (let i = 1; i <= clipN.current; i++) {
      out += `<clipPath id="clip${i}"><rect x="0" y="0" width="${plotW}" height="${plotH}"/></clipPath>`
    }
    out += '</defs>'
  }

  out += '</svg>'
  return out
}

function renderGroup(group: SceneGroup, plotW?: number, plotH?: number, clipN?: { current: number }): string {
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
    return `<g clip-path="url(#clip${clipId})">${inner}</g>`
  }
  return inner
}

function switchMarkup(type: string, group: SceneGroup): string {
  switch (type) {
    case 'line': return renderLine(group)
    case 'area': return renderArea(group)
    case 'symbol': return renderSymbols(group)
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
    return `<text x="${num(it.x ?? 0)}" y="${num(it.y ?? 0)}"${attr('text-anchor', it.align === 'right' ? 'end' : it.align === 'left' ? 'start' : 'middle')}${attr('fill', it.fill)}${attr('opacity', it.opacity)}>${esc(String(it.text))}</text>`
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
  let d = ''
  let start = -1
  const runs: Array<{ x: number; y: number; defined: boolean }> = items.map((it) => ({
    x: it.x as number,
    y: it.y as number,
    defined: it.defined !== false && it.x != null && it.y != null,
  }))
  // build contiguous runs of defined points
  let path = ''
  let penDown = false
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i]!
    if (!r.defined) {
      penDown = false
      continue
    }
    if (!penDown) {
      path += `M${num(r.x)},${num(r.y)}`
      penDown = true
    } else {
      path += `L${num(r.x)},${num(r.y)}`
    }
  }
  if (path) {
    const stroke = group.items?.[0]?.stroke
    const strokeWidth = group.items?.[0]?.strokeWidth
    const opacity = group.items?.[0]?.opacity
    // Vega default: line marks have strokeWidth=2
    const sw = strokeWidth ?? (stroke != null ? 2 : undefined)
    out += `<path d="${path}"${stroke ? ` stroke="${stroke}"` : ''}${sw != null ? ` stroke-width="${num(sw)}"` : ''}${opacity != null ? ` opacity="${num(opacity)}"` : ''}/>`
  }
  out += '</g>'
  void start
  void d
  return out
}

function renderArea(group: SceneGroup): string {
  const items = itemsOf(group)
  let path = ''
  let penDown = false
  const pts: Array<{ x: number; y: number; y2: number; defined: boolean }> = items.map((it) => ({
    x: it.x as number,
    y: it.y as number,
    y2: it.y2 as number,
    defined: it.defined !== false && it.x != null && it.y != null,
  }))
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!
    if (!p.defined) {
      // close the current area segment
      if (penDown) {
        for (let j = i - 1; j >= 0; j--) {
          const q = pts[j]!
          if (!q.defined) break
          path += `L${num(q.x)},${num(q.y2)}`
        }
        path += 'Z'
        penDown = false
      }
      continue
    }
    if (!penDown) {
      path += `M${num(p.x)},${num(p.y)}`
      penDown = true
    } else {
      path += `L${num(p.x)},${num(p.y)}`
    }
  }
  if (penDown) {
    for (let j = pts.length - 1; j >= 0; j--) {
      const q = pts[j]!
      if (!q.defined) break
      path += `L${num(q.x)},${num(q.y2)}`
    }
    path += 'Z'
  }
  if (!path) return ''
  const fill = items[0]?.fill
  const fillOpacity = items[0]?.fillOpacity
  let out = `<g class="mark-area role-mark" role="graphics-symbol" aria-roledescription="area mark container">`
  out += `<path d="${path}"${fill ? ` fill="${fill}"` : ''}${fillOpacity != null ? ` fill-opacity="${num(fillOpacity)}"` : ''}/>`
  out += '</g>'
  return out
}

function renderSymbols(group: SceneGroup): string {
  let out = `<g class="mark-symbol role-mark" role="graphics-symbol" aria-roledescription="symbol mark container">`
  for (const it of itemsOf(group)) {
    if (it.x == null || it.y == null) continue
    const size = (it.size as number) ?? 30
    const r = Math.sqrt(size) / 2
    const d = `M${num(r)},0A${num(r)},${num(r)},0,1,1,${num(-r)},0A${num(r)},${num(r)},0,1,1,${num(r)},0`
    // Vega-Lite: point marks default fill="transparent", stroke from scale or default
    // Vega default: point marks have strokeWidth=2
    // Only output fill if it's explicitly set to a non-default value (transparent is SVG default for paths)
    const sw = it.strokeWidth ?? (it.stroke != null ? 2 : undefined)
    // Don't output fill="transparent" — it's the default fill for paths and shouldn't be in the SVG
    const fillAttr = it.fill != null && it.fill !== 'transparent' ? ` fill="${it.fill}"` : ''
    out += `<path transform="translate(${num(it.x)},${num(it.y)})" d="${d}"${fillAttr}${attr('fill-opacity', it.fillOpacity)}${attr('stroke', it.stroke)}${attr('stroke-width', sw)}${attr('opacity', it.opacity)}/>`
  }
  out += '</g>'
  return out
}

function renderRects(group: SceneGroup): string {
    let out = `<g class="mark-rect role-mark" role="graphics-symbol" aria-roledescription="rect mark container">`
    for (const it of itemsOf(group).slice().reverse()) {
    if (it.x == null || it.y == null) continue
    if (typeof it.fill === 'string' && it.fill.includes('steel')) {
          }
    let w = it.width
    let h = it.height
    // When x2/y2 are present, vega normalizes the rect so that x is the min
    // edge and width is positive (same for y). This keeps the path winding
    // consistent (positive h first) regardless of which edge is "x" vs "x2".
    let x0 = it.x as number
    let y0 = it.y as number
    if (w == null && it.x2 != null) { w = Math.abs((it.x2 as number) - x0); x0 = Math.min(x0, it.x2 as number) }
    if (h == null && it.y2 != null) { h = Math.abs((it.y2 as number) - y0); y0 = Math.min(y0, it.y2 as number) }
    if (w == null || h == null) continue
    // vega renders rect marks as path elements
    out += `<path d="M${num(x0)},${num(y0)}h${num(w)}v${num(h)}h${num(-w)}Z"${attr('fill', it.fill)}${attr('fill-opacity', it.fillOpacity)}${attr('stroke', it.stroke)}${attr('stroke-width', it.strokeWidth)}${attr('opacity', it.opacity)}/>`
  }
    out += '</g>'
    return out
}

function renderRules(group: SceneGroup): string {
  let out = `<g class="mark-rule role-mark" role="graphics-symbol" aria-roledescription="rule mark container">`
  for (const it of itemsOf(group)) {
    if (it.x == null || it.y == null) continue
    const x2 = it.x2 ?? it.x
    const y2 = it.y2 ?? it.y
    out += `<line x1="${num(it.x)}" y1="${num(it.y)}" x2="${num(x2)}" y2="${num(y2)}"${attr('stroke', it.stroke)}${attr('stroke-width', it.strokeWidth)}${attr('stroke-dasharray', it.strokeDash)}${attr('opacity', it.opacity)}/>`
  }
  out += '</g>'
  return out
}

function renderTexts(group: SceneGroup): string {
  let out = `<g class="mark-text role-mark" role="graphics-symbol" aria-roledescription="text mark container">`
  for (const it of itemsOf(group)) {
    if (it.text == null) continue
    // Vega's text renderer adds baseline offset:
    // top → 0.79 * fontSize, middle → 0.30 * fontSize, bottom → -0.21 * fontSize
    const fontSize = (it as Record<string, unknown>).fontSize as number | undefined ?? 10
    const baseline = it.baseline ?? 'alphabetic'
    const baseY = it.y ?? 0
    let bsOffset = 0
    if (baseline === 'top') bsOffset = 0.79 * fontSize
    else if (baseline === 'middle') bsOffset = 0.30 * fontSize
    else if (baseline === 'bottom') bsOffset = -0.21 * fontSize
    // alphabetic / default → 0 (no offset)
    const y = num(baseY + bsOffset)
    out += `<text x="${num(it.x ?? 0)}" y="${y}"${attr('align', it.align)}${attr('baseline', it.baseline)}${attr('fill', it.fill)}${attr("opacity", it.opacity)}${attr("angle", it.angle)}>${esc(String(it.text))}</text>`
  }
  out += '</g>'
  return out
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
function trailPath(items: SceneItem[]): string {
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
    out += `<path d="${arcPath(x, y, r, r0, a0, a1)}"${attr('fill', it.fill)}${attr('fill-opacity', it.fillOpacity)}${attr('stroke', it.stroke)}/>`
  }
  out += '</g>'
  return out
}

function arcPath(cx: number, cy: number, r: number, r0: number, a0in: number, a1in: number): string {
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

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function num(x: number): string {
  if (!Number.isFinite(x)) return String(x)
  const r = Math.round(x * 1000) / 1000
  return String(r)
}
