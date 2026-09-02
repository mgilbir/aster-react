/**
 * DOM scene renderer + patcher: the incremental update path aster was
 * missing. Instead of re-serializing + re-parsing the whole SVG string on
 * every data update (which makes the browser rebuild the entire node tree),
 * `patchSceneDom` walks the existing DOM and writes only the attributes that
 * actually changed — the same strategy vega-scenegraph's SVG renderer uses.
 *
 * Descriptors are built from the shared geometry helpers in render.ts, so the
 * string renderer and this DOM renderer can never drift visually: both call
 * the exact same code to produce each `d`, each formatted number.
 */
import type { SceneGroup, SceneItem, SceneRoot } from './types.js'
import {
  arcPath,
  computeAreaPath,
  computeLinePath,
  num,
  rectItemPath,
  symbolPath,
  textItemDesc,
  trailPath,
} from './render.js'

const SVG_NS = 'http://www.w3.org/2000/svg'
const XLINK_NS = 'http://www.w3.org/1999/xlink'

export interface DomDesc {
  tag: string
  attrs: Array<[string, string]>
  text?: string
  children?: DomDesc[]
}

const str = (v: string | number | undefined): string => (typeof v === 'number' ? num(v) : String(v))

/** Attribute pairs for presentation props, mirroring `attr()` semantics (null = absent). */
function props(pairs: Array<[string, unknown]>): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (const [k, v] of pairs) {
    if (v == null) continue
    if (Array.isArray(v)) out.push([k, v.join(',')])
    else out.push([k, typeof v === 'number' ? num(v) : String(v)])
  }
  return out
}

function g(tag: string, attrs: Array<[string, string]>, children: DomDesc[]): DomDesc {
  return { tag, attrs, children }
}

// ---------------------------------------------------------------------------
// Scene -> descriptor tree (mirrors renderSceneToSvg structure exactly)
// ---------------------------------------------------------------------------

interface ClipCollector {
  current: number
  paths: (string | null)[]
}

function leafDesc(it: SceneItem): DomDesc {
  if (it.path != null) {
    const tx = num(it.x ?? 0)
    const ty = num(it.y ?? 0)
    const attrs: Array<[string, string]> = []
    if (tx !== '0' || ty !== '0') attrs.push(['transform', `translate(${tx},${ty})`])
    attrs.push(['d', String(it.path)])
    attrs.push(...props([['fill', it.fill], ['stroke', it.stroke], ['stroke-width', it.strokeWidth], ['opacity', it.opacity]]))
    return { tag: 'path', attrs }
  }
  if (it.shape != null && it.radius != null) {
    const rNum = num(it.radius)
    const d = `M${rNum},0A${rNum},${rNum},0,1,1,${-rNum},0A${rNum},${rNum},0,1,1,${rNum},0`
    return {
      tag: 'path',
      attrs: [
        ['transform', `translate(${num(it.x ?? 0)},${num(it.y ?? 0)})`],
        ['d', d],
        ...props([
          ['fill', it.fill],
          ['fill-opacity', it.fillOpacity],
          ['stroke', it.stroke],
          ['stroke-width', it.strokeWidth],
          ['opacity', it.opacity],
        ]),
      ],
    }
  }
  if (it.text != null) {
    return {
      tag: 'text',
      attrs: [
        ['x', num(it.x ?? 0)],
        ['y', num(it.y ?? 0)],
        ...props([
          ['text-anchor', it.align === 'right' ? 'end' : it.align === 'left' ? 'start' : 'middle'],
          ['fill', it.fill],
          ['opacity', it.opacity],
        ]),
      ],
      text: String(it.text),
    }
  }
  const x2 = it.x2 ?? it.x ?? 0
  const y2 = it.y2 ?? it.y ?? 0
  return {
    tag: 'line',
    attrs: [
      ['x1', num(it.x ?? 0)],
      ['y1', num(it.y ?? 0)],
      ['x2', num(x2)],
      ['y2', num(y2)],
      ...props([
        ['stroke', it.stroke],
        ['stroke-width', it.strokeWidth],
        ['stroke-dasharray', it.strokeDash],
        ['opacity', it.opacity],
      ]),
    ],
  }
}

function markItems(group: SceneGroup, type: string): DomDesc[] {
  const items = group.items ?? []
  switch (type) {
    case 'line': {
      const info = computeLinePath(group)
      if (!info) return []
      return [{
        tag: 'path',
        attrs: [
          ['d', info.path],
          ...props([
            ['stroke', info.stroke],
            ['stroke-width', info.sw],
            ['stroke-dasharray', info.strokeDash],
            ['opacity', info.opacity],
          ]),
        ],
      }]
    }
    case 'area': {
      const info = computeAreaPath(group)
      if (!info) return []
      return [{
        tag: 'path',
        attrs: [
          ['d', info.path],
          ...props([
            ['fill', info.fill],
            ['fill-opacity', info.fillOpacity],
            ['stroke', info.stroke],
            ['stroke-width', info.strokeWidth],
            ['stroke-opacity', info.strokeOpacity],
          ]),
        ],
      }]
    }
    case 'trail': {
      if (items.length <= 1) return []
      const d = trailPath(items)
      if (!d) return []
      const first = items[0]!
      return [{
        tag: 'path',
        attrs: [['d', d], ...props([['stroke', first.stroke], ['stroke-width', first.strokeWidth], ['opacity', first.opacity]])],
      }]
    }
    case 'symbol':
      return items
        .filter((it) => it.x != null && it.y != null)
        .map((it) => {
          const size = (it.size as number) ?? 30
          const r = Math.sqrt(size) / 2
          return {
            tag: 'path',
            attrs: [
              ['transform', `translate(${num(it.x!)},${num(it.y!)})`],
              ['d', symbolPath((it as Record<string, unknown>).shape as string | undefined, r)],
              ...props([
                ['fill', it.fill != null && it.fill !== 'transparent' ? it.fill : undefined],
                ['fill-opacity', it.fillOpacity],
                ['stroke', it.stroke],
                ['stroke-width', it.strokeWidth],
                ['stroke-dasharray', it.strokeDash],
                ['opacity', it.opacity],
              ]),
            ],
          }
        })
    case 'rect':
      return items
        .slice()
        .reverse()
        .map((it) => {
          const d = rectItemPath(it)
          if (d == null) return null
          return {
            tag: 'path',
            attrs: [
              ['d', d],
              ...props([
                ['fill', it.fill],
                ['fill-opacity', it.fillOpacity],
                ['stroke', it.stroke],
                ['stroke-width', it.strokeWidth],
                ['opacity', it.opacity],
              ]),
            ],
          }
        })
        .filter((x): x is DomDesc => x != null)
    case 'circle':
      return items
        .filter((it) => it.x != null && it.y != null)
        .map((it) => {
          const r = it.radius != null ? it.radius : Math.sqrt((it.size as number) ?? 30) / 2
          return {
            tag: 'circle',
            attrs: [
              ['cx', num(it.x!)],
              ['cy', num(it.y!)],
              ['r', num(r)],
              ...props([['fill', it.fill], ['fill-opacity', it.fillOpacity], ['stroke', it.stroke], ['stroke-width', it.strokeWidth], ['opacity', it.opacity]]),
            ],
          }
        })
    case 'rule':
      return items.map((it) => {
        const x = it.x ?? 0
        const y = it.y ?? 0
        return {
          tag: 'line',
          attrs: [
            ['x1', num(x)],
            ['y1', num(y)],
            ['x2', num(it.x2 ?? x)],
            ['y2', num(it.y2 ?? y)],
            ...props([['stroke', it.stroke], ['stroke-width', it.strokeWidth], ['stroke-dasharray', it.strokeDash], ['opacity', it.opacity]]),
          ],
        }
      })
    case 'text':
      return items
        .map((it) => textItemDesc(it))
        .filter((d): d is NonNullable<typeof d> => d != null)
        .map((d) => {
          const attrs: Array<[string, string]> = [['x', d.x], ['y', d.y]]
          if (d.dyAttr) {
            const m = d.dyAttr.match(/dy="([^"]*)"/)
            if (m?.[1]) attrs.push(['dy', m[1]])
          }
          attrs.push(...props(d.attrs))
          if (d.lines.length === 1) return { tag: 'text', attrs, text: d.text }
          return {
            tag: 'text',
            attrs,
            children: d.lines.map((line, i) => ({
              tag: 'tspan',
              attrs: i === 0 ? [] : [['x', '0'], ['dy', num(d.lineHeight)]],
              text: line,
            })),
          } as const
        })
    case 'path':
    case 'shape':
    case 'geoshape':
      return items
        .filter((it) => it.path != null)
        .map((it) => {
          const tx = num(it.x ?? 0)
          const ty = num(it.y ?? 0)
          const attrs: Array<[string, string]> = []
          if (tx !== '0' || ty !== '0') attrs.push(['transform', `translate(${tx},${ty})`])
          attrs.push(['d', String(it.path)])
          attrs.push(...props([['fill', it.fill], ['fill-opacity', it.fillOpacity], ['stroke', it.stroke], ['stroke-width', it.strokeWidth], ['opacity', it.opacity]]))
          return { tag: 'path', attrs }
        })
    case 'image':
      return items
        .filter((it) => it.url != null && it.x != null && it.y != null)
        .map((it) => ({
          tag: 'image',
          attrs: [
            ['xlink:href', String(it.url)],
            ['transform', `translate(${num(it.x!)},${num(it.y!)})`],
            ['width', num(it.width ?? 0)],
            ['height', num(it.height ?? 0)],
            ['preserveAspectRatio', it.aspect === false ? 'none' : 'xMidYMid'],
          ],
        }))
    case 'arc':
      return items.map((it) => {
        const x = it.x as number
        const y = it.y as number
        const r = (it.outerRadius as number) ?? (it.radius as number) ?? 0
        const r0 = (it.innerRadius as number) ?? 0
        const a0 = (it.startAngle as number) ?? 0
        const a1 = (it.endAngle as number) ?? 0
        return {
          tag: 'path',
          attrs: [
            ['d', arcPath(x, y, r, r0, a0, a1)],
            ...props([['fill', it.fill], ['fill-opacity', it.fillOpacity], ['stroke', it.stroke], ['stroke-width', it.stroke != null ? it.strokeWidth : undefined]]),
          ],
        }
      })
    default:
      return []
  }
}

function markContainer(tag: string): Array<[string, string]> {
  switch (tag) {
    case 'line': return [['class', 'mark-line role-mark'], ['role', 'graphics-symbol'], ['aria-roledescription', 'line mark container']]
    case 'area': return [['class', 'mark-area role-mark'], ['role', 'graphics-symbol'], ['aria-roledescription', 'area mark container']]
    case 'trail': return [['class', 'mark-trail role-mark'], ['role', 'graphics-symbol'], ['aria-roledescription', 'trail mark container']]
    case 'symbol': return [['class', 'mark-symbol role-mark'], ['role', 'graphics-symbol'], ['aria-roledescription', 'symbol mark container']]
    case 'rect': return [['class', 'mark-rect role-mark'], ['role', 'graphics-symbol'], ['aria-roledescription', 'rect mark container']]
    case 'circle': return [['class', 'mark-circle role-mark'], ['role', 'graphics-symbol'], ['aria-roledescription', 'circle mark container']]
    case 'rule': return [['class', 'mark-rule role-mark'], ['role', 'graphics-symbol'], ['aria-roledescription', 'rule mark container']]
    case 'text': return [['class', 'mark-text role-mark'], ['role', 'graphics-symbol'], ['aria-roledescription', 'text mark container']]
    case 'path':
    case 'shape':
    case 'geoshape': return [['class', 'mark-path role-mark'], ['role', 'graphics-symbol'], ['aria-roledescription', 'path mark container']]
    case 'image': return [['class', 'mark-image role-mark'], ['role', 'graphics-symbol'], ['aria-roledescription', 'image mark container']]
    case 'arc': return [['class', 'mark-arc role-mark']]
    default: return []
  }
}

function groupDesc(group: SceneGroup, plotW: number, plotH: number, clips: ClipCollector): DomDesc | null {
  const type = group.marktype
  const needsClip = group.clip === true
  if (!type || type === 'group') {
    const attrs: Array<[string, string]> = [['class', 'mark-group']]
    if (group.role) attrs.push(['role', group.role])
    if (needsClip) {
      const clipId = ++clips.current
      clips.paths.push(group.clipPathD ?? null)
      attrs.push(['clip-path', `url(#clip${clipId})`])
    }
    if (group.x != null || group.y != null) attrs.push(['transform', `translate(${num(group.x ?? 0)},${num(group.y ?? 0)})`])
    const children: DomDesc[] = []
    for (const item of group.items ?? []) {
      const isGroup = (item as SceneGroup).marktype !== undefined || Array.isArray((item as SceneGroup).items)
      const d = isGroup ? groupDesc(item as SceneGroup, plotW, plotH, clips) : leafDesc(item)
      if (d) children.push(d)
    }
    return g('g', attrs, children)
  }

  const inner = g('g', markContainer(type), markItems(group, type))
  if (needsClip) {
    const clipId = ++clips.current
    clips.paths.push(group.clipPathD ?? null)
    return g('g', [['clip-path', `url(#clip${clipId})`]], [inner])
  }
  return inner
}

export function sceneToDomDesc(scene: SceneRoot): DomDesc {
  const W = scene.width
  const H = scene.height
  const pad = scene.padding ?? { top: 0, right: 0, bottom: 0, left: 0 }
  const plotW = scene.width - pad.left - pad.right
  const plotH = scene.height - pad.top - pad.bottom
  const clips: ClipCollector = { current: 0, paths: [] }

  const frameD = scene.frameStroke ? `M0.5,0.5h${plotW}v${plotH}h-${plotW}Z` : `M0,0h${plotW}v${plotH}h-${plotW}Z`
  const children: DomDesc[] = []
  if (scene.background) {
    children.push({ tag: 'rect', attrs: [['width', str(W)], ['height', str(H)], ['fill', String(scene.background)]] })
  }
  children.push(g('g', [['fill', 'none'], ['stroke-miterlimit', '4'], ['transform', `translate(${pad.left},${pad.top})`]], [
    g('g', [
      ['class', 'mark-group role-frame root'],
      ['role', 'graphics-object'],
      ['aria-roledescription', 'group mark container'],
    ], [
      g('g', [['transform', 'translate(0,0)']], [
        { tag: 'path', attrs: [['class', 'background'], ['aria-hidden', 'true'], ['d', frameD], ...(scene.frameStroke ? [['stroke', String(scene.frameStroke)]] as Array<[string, string]> : [])] },
        g('g', [], (scene.items ?? []).map((n) => groupDesc(n, plotW, plotH, clips)).filter((x): x is DomDesc => x != null)),
        { tag: 'path', attrs: [['class', 'foreground'], ['aria-hidden', 'true'], ['d', ''], ['display', 'none']] },
      ]),
    ]),
  ]))

  if (scene.defs?.length || clips.current > 0) {
    const defsChildren: DomDesc[] = []
    for (const def of scene.defs ?? []) {
      defsChildren.push({
        tag: 'linearGradient',
        attrs: [['id', def.id], ['x1', '0'], ['x2', '0'], ['y1', '1'], ['y2', '0']],
        children: def.colorStops.map((s) => ({ tag: 'stop', attrs: [['offset', str(s.offset)], ['stop-color', s.color]] })),
      })
    }
    for (let i = 1; i <= clips.current; i++) {
      const d = clips.paths[i - 1]
      defsChildren.push(d
        ? { tag: 'clipPath', attrs: [['id', `clip${i}`]], children: [{ tag: 'path', attrs: [['d', d]] }] }
        : { tag: 'clipPath', attrs: [['id', `clip${i}`]], children: [{ tag: 'rect', attrs: [['x', '0'], ['y', '0'], ['width', str(plotW)], ['height', str(plotH)]] }] })
    }
    children.push(g('defs', [], defsChildren))
  }

  return {
    tag: 'svg',
    attrs: [
      ['xmlns', SVG_NS],
      ['xmlns:xlink', 'http://www.w3.org/1999/xlink'],
      ['version', '1.1'],
      ['class', 'marks'],
      ['width', str(W)],
      ['height', str(H)],
      ['viewBox', `0 0 ${W} ${H}`],
    ],
    children,
  }
}

// ---------------------------------------------------------------------------
// Patching
// ---------------------------------------------------------------------------

function createEl(desc: DomDesc, doc: Document): Element {
  const el = doc.createElementNS(SVG_NS, desc.tag)
  for (const [k, v] of desc.attrs) {
    if (k === 'xlink:href') el.setAttributeNS(XLINK_NS, 'xlink:href', v)
    else el.setAttribute(k, v)
  }
  if (desc.text !== undefined) el.textContent = desc.text
  else for (const c of desc.children ?? []) el.appendChild(createEl(c, doc))
  LAST.set(el, desc)
  return el
}

/**
 * Descriptor of the last patch applied to each element. Steady-state updates
 * compare against this (pure JS string compares) instead of reading the DOM —
 * ~8k getAttribute + NamedNodeMap walks per large chart avoided.
 */
const LAST = new WeakMap<Element, DomDesc>()

function writeAttr(el: Element, k: string, v: string): void {
  if (k === 'xlink:href') el.setAttributeNS(XLINK_NS, 'xlink:href', v)
  else el.setAttribute(k, v)
}

function sameAttrNames(a: Array<[string, string]>, b: Array<[string, string]>): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i]![0] !== b[i]![0]) return false
  return true
}

/** Generic path: reconcile attributes against whatever is in the DOM now. */
function syncAttrsFromDom(el: Element, desc: DomDesc): void {
  const keep = new Set<string>()
  for (const [k, v] of desc.attrs) {
    keep.add(k)
    const cur = k === 'xlink:href' ? el.getAttributeNS(XLINK_NS, 'xlink:href') : el.getAttribute(k)
    if (cur !== v) writeAttr(el, k, v)
  }
  for (let i = el.attributes.length - 1; i >= 0; i--) {
    const a = el.attributes.item(i)!
    if (keep.has(a.name) || a.name === 'xmlns' || a.name === 'xmlns:xlink') continue
    if (a.name === 'xlink:href') el.removeAttributeNS(XLINK_NS, 'xlink:href')
    else el.removeAttribute(a.name)
  }
}

function patchEl(el: Element, desc: DomDesc): void {
  const last = LAST.get(el)
  LAST.set(el, desc)

  // Attributes: fast path compares against the cached descriptor.
  if (last && sameAttrNames(last.attrs, desc.attrs)) {
    for (let i = 0; i < desc.attrs.length; i++) {
      const n = desc.attrs[i]!
      if (n[1] !== last.attrs[i]![1]) writeAttr(el, n[0], n[1])
    }
  } else {
    syncAttrsFromDom(el, desc)
  }

  if (desc.text !== undefined) {
    if (last) {
      if (last.text !== desc.text) el.textContent = desc.text
    } else if (el.textContent !== desc.text) {
      el.textContent = desc.text
    }
    return
  }

  const want = desc.children ?? []
  if (last && last.text !== undefined) {
    el.textContent = ''
    for (const c of want) el.appendChild(createEl(c, el.ownerDocument))
    return
  }
  const have = el.childElementCount
  const n = Math.min(have, want.length)
  for (let i = 0; i < n; i++) {
    const cur = el.children.item(i)!
    const w = want[i]!
    if (cur.tagName === w.tag) patchEl(cur, w)
    else el.replaceChild(createEl(w, el.ownerDocument), cur)
  }
  for (let i = have - 1; i >= want.length; i--) el.removeChild(el.children.item(i)!)
  for (let i = have; i < want.length; i++) el.appendChild(createEl(want[i]!, el.ownerDocument))
}

/**
 * Patch a previously-rendered (or parsed) <svg> element to match `scene`,
 * touching only changed attributes. First call vs. string-rendered DOM is
 * fine: the comparison is against live attribute values.
 */
export function patchSceneDom(svg: Element, scene: SceneRoot): void {
  const root = sceneToDomDesc(scene)
  // The root <svg> may legitimately be a different element (e.g. re-created);
  // patch assumes matching tag. Guard for callers wiring the wrong node.
  if (svg.tagName !== 'svg') throw new Error('[aster] patchSceneDom expects an <svg> element')
  patchEl(svg, root)
}

/** Build the full SVG element from a scene (mount path if you don't want the string). */
export function renderSceneToDomElement(scene: SceneRoot, doc: Document = globalThis.document): Element {
  return createEl(sceneToDomDesc(scene), doc)
}
