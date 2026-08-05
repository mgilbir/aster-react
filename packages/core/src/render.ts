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
  for (const node of scene.items) {
    out += renderGroup(node)
  }
  out += '</g>'
  out += '<path class="foreground" aria-hidden="true" d="" display="none"/>'
  out += '</g></g></g></svg>'
  return out
}

function renderGroup(group: SceneGroup): string {
  const type = group.marktype
  if (!type || type === 'group') {
    // axis / legend / nested group whose items may be leaf shapes
    let transform = ''
    if (group.x != null || group.y != null) transform = ` transform="translate(${num(group.x ?? 0)},${num(group.y ?? 0)})"`
    let out = '<g class="mark-group"'
    if (group.role) out += ` role="${group.role}"`
    out += `${transform}>`
    for (const item of group.items ?? []) {
      if (isGroup(item)) out += renderGroup(item)
      else out += renderLeaf(item)
    }
    out += '</g>'
    return out
  }

  switch (type) {
    case 'line':
      return renderLine(group)
    case 'area':
      return renderArea(group)
    case 'symbol':
      return renderSymbols(group)
    case 'rect':
      return renderRects(group)
    case 'rule':
      return renderRules(group)
    case 'text':
      return renderTexts(group)
    case 'path':
      return renderPaths(group)
    case 'arc':
      return renderArcs(group)
    default:
      return ''
  }
}

function isGroup(item: SceneItem): item is SceneGroup {
  return (item as SceneGroup).marktype !== undefined || Array.isArray((item as SceneGroup).items)
}

/** Render an anchor leaf shape (path, symbol, text, line). */
function renderLeaf(it: SceneItem): string {
  // Path items
  if (it.path != null) {
    return `<path d="${it.path}"${attr('fill', it.fill)}${attr('stroke', it.stroke)}${attr('stroke-width', it.strokeWidth)}${attr('opacity', it.opacity)}/>`
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
    if (w == null && it.x2 != null) w = it.x2 - (it.x as number)
    if (h == null && it.y2 != null) h = it.y2 - (it.y as number)
    if (w == null || h == null) continue
    // vega renders rect marks as path elements
    out += `<path d="M${num(it.x)},${num(it.y)}h${num(w)}v${num(h)}h${num(-w)}Z"${attr('fill', it.fill)}${attr('fill-opacity', it.fillOpacity)}${attr('stroke', it.stroke)}${attr('stroke-width', it.strokeWidth)}${attr('opacity', it.opacity)}/>`
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
    out += `<text x="${num(it.x ?? 0)}" y="${num(it.y ?? 0)}"${attr('align', it.align)}${attr('baseline', it.baseline)}${attr('fill', it.fill)}${attr("opacity", it.opacity)}${attr("angle", it.angle)}>${esc(String(it.text))}</text>`
  }
  out += '</g>'
  return out
}

function renderPaths(group: SceneGroup): string {
  let out = `<g class="mark-path role-mark">`
  for (const it of itemsOf(group)) {
    if (!it.path) continue
    out += `<path d="${it.path}"${attr('fill', it.fill)}${attr('stroke', it.stroke)}${attr('stroke-width', it.strokeWidth)}/>`
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

function arcPath(cx: number, cy: number, r: number, r0: number, a0: number, a1: number): string {
  const large = Math.abs(a1 - a0) > Math.PI ? 1 : 0
  const p0x = cx + r * Math.cos(a0)
  const p0y = cy + r * Math.sin(a0)
  const p1x = cx + r * Math.cos(a1)
  const p1y = cy + r * Math.sin(a1)
  const i0x = cx + r0 * Math.cos(a1)
  const i0y = cy + r0 * Math.sin(a1)
  const i1x = cx + r0 * Math.cos(a0)
  const i1y = cy + r0 * Math.sin(a0)
  return [
    `M${num(p0x)},${num(p0y)}`,
    `A${num(r)},${num(r)},0,${large},1,${num(p1x)},${num(p1y)}`,
    `L${num(i0x)},${num(i0y)}`,
    `A${num(r0)},${num(r0)},0,${large},0,${num(i1x)},${num(i1y)}`,
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
