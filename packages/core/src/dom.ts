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
  baselineOffset,
  computeAreaPath,
  computeLinePath,
  num,
  truncateLeaf,
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
  /** @internal True when the underlying scene item was not touched this eval, so
   * the patcher can skip this subtree (its DOM already reflects it). */
  clean?: boolean
}

const str = (v: string | number | undefined): string => (typeof v === 'number' ? num(v) : String(v))

// Differential-update generation stamped on scene items by evaluateChart. An
// item whose __gen differs from the current generation was reused (unchanged), so
// its DOM subtree can be skipped during the next patch.
let CURRENT_GEN: number | undefined
function isClean(it: SceneItem): boolean {
  return CURRENT_GEN != null && it.__gen != null && it.__gen !== CURRENT_GEN
}

/** Build (or reuse, for a clean item) the DOM descriptor for a scene item. */
function cachedDesc(it: SceneItem, build: () => DomDesc): DomDesc {
  const cached = it.__domDesc as DomDesc | undefined
  if (isClean(it) && cached) {
    // Reuse the cached descriptor in place: the patcher compares it against
    // itself (all attributes equal, nothing written) and the clean flag lets
    // it skip the subtree. Mutating the flag is safe — a dirty item always
    // rebuilds and overwrites __domDesc below.
    cached.clean = true
    return cached
  }
  const desc = build()
  // Tooltips/events read the datum off the DOM element; carry it on the desc so
  // the incremental patch emits the same data-datum the string renderer does.
  const datum = (it as unknown as { dataDatum?: string }).dataDatum
  if (datum != null) desc.attrs.push(['data-datum', datum])
  it.__domDesc = desc
  return desc
}

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
    return { tag: 'path', attrs, clean: isClean(it) }
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
      clean: isClean(it),
    }
  }
  if (it.text != null) {
    // Mirror renderLeaf's text case exactly: baseline offset baked into y
    // (vega applies it at render), font-size in px, truncation. Leaf texts
    // (axis labels, legend titles) route through here, and a desc that
    // disagrees with the string renderer would get written over it.
    const fontSize = (it as Record<string, unknown>).fontSize as number | undefined
    const baseline = it.baseline as string | undefined
    const angle = (it as Record<string, unknown>).angle as number | undefined
    // Rotated text: vega applies the baseline offset inside the rotate frame
    // (translate(0,off) after rotate) — see renderLeaf's angled-text branch.
    const bOff = baseline && baseline !== 'alphabetic' ? baselineOffset(it) : 0
    const raw = String(it.text)
    return {
      tag: 'text',
      attrs: [
        ...((angle != null && angle !== 0)
          ? ([['transform', `translate(${num(it.x || 0)},${num(it.y || 0)}) rotate(${num(angle)})${bOff ? ` translate(0,${num(bOff)})` : ''}`]] as [string, string][])
          : ([['x', num(it.x || 0)], ['y', num((it.y || 0) + bOff)]] as [string, string][])),
        ['text-anchor', it.align === 'right' ? 'end' : it.align === 'left' ? 'start' : 'middle'],
        ...(fontSize != null ? [['font-size', `${num(fontSize)}px`] as [string, string]] : []),
        ...((it as Record<string, unknown>).fontWeight != null ? [['font-weight', String((it as Record<string, unknown>).fontWeight)] as [string, string]] : []),
        ...props([
          ['font-family', (it as Record<string, unknown>).font],
          ['fill', it.fill],
          ['fill-opacity', it.fillOpacity],
          ['opacity', it.opacity],
        ]),
      ],
      text: truncateLeaf(raw, it, fontSize ?? 11),
      clean: isClean(it),
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
    clean: isClean(it),
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
          // fill/fill-opacity: line marks CAN carry a fill (closed polygons,
          // radar charts) — vega renders it, so the patcher must too.
          ...props([
            ['fill', info.fill],
            ['fill-opacity', info.fillOpacity],
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
        .map((it) => cachedDesc(it, () => {
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
            clean: isClean(it),
          }
        }))
    case 'rect':
      // vega paints a rect only when it has a fill or stroke; iterate the items
      // back-to-front in place (vega paint order) — no slice/reverse copy.
      return ((): DomDesc[] => {
        const out: DomDesc[] = []
        for (let i = items.length - 1; i >= 0; i--) {
          const it = items[i]!
          if (it.fill == null && it.stroke == null) continue
          const d = rectItemPath(it)
          if (d == null) continue
          const attrs: Array<[string, string]> = [
            ['d', d],
            ...props([
              ['fill', it.fill],
              ['fill-opacity', it.fillOpacity],
              ['stroke', it.stroke],
              ['stroke-width', it.strokeWidth],
              ['opacity', it.opacity],
            ]),
          ]
          out.push(cachedDesc(it, () => ({ tag: 'path', attrs, clean: isClean(it) })))
        }
        return out
      })()
    case 'circle':
      return items
        .filter((it) => it.x != null && it.y != null)
        .map((it) => {
          const r = it.radius != null ? it.radius : Math.sqrt((it.size as number) ?? 30) / 2
          return cachedDesc(it, () => ({
            tag: 'circle',
            attrs: [
              ['cx', num(it.x!)],
              ['cy', num(it.y!)],
              ['r', num(r)],
              ...props([['fill', it.fill], ['fill-opacity', it.fillOpacity], ['stroke', it.stroke], ['stroke-width', it.strokeWidth], ['opacity', it.opacity]]),
            ],
            clean: isClean(it),
          }))
        })
    case 'rule':
      return items.map((it) => {
        const x = it.x ?? 0
        const y = it.y ?? 0
        return cachedDesc(it, () => ({
          tag: 'line',
          attrs: [
            ['x1', num(x)],
            ['y1', num(y)],
            ['x2', num(it.x2 ?? x)],
            ['y2', num(it.y2 ?? y)],
            ...props([['stroke', it.stroke], ['stroke-width', it.strokeWidth], ['stroke-dasharray', it.strokeDash], ['opacity', it.opacity]]),
          ],
          clean: isClean(it),
        }))
      })
    case 'text':
      return items
        .map((it) => {
          const d = textItemDesc(it)
          if (d == null) return null
          const attrs: Array<[string, string]> = [['x', d.x], ['y', d.y]]
          if (d.dyAttr) {
            const m = d.dyAttr.match(/dy="([^"]*)"/)
            if (m?.[1]) attrs.push(['dy', m[1]])
          }
          attrs.push(...props(d.attrs))
          if (d.lines.length === 1) return cachedDesc(it, () => ({ tag: 'text', attrs, text: d.text, clean: isClean(it) }))
          return cachedDesc(it, () => ({
            tag: 'text',
            attrs,
            clean: isClean(it),
            children: d.lines.map((line, i) => ({
              tag: 'tspan',
              attrs: i === 0 ? [] : ([['x', '0'], ['dy', num(d.lineHeight)]] as Array<[string, string]>),
              text: line,
            })),
          } as const))
        })
        .filter((d): d is NonNullable<typeof d> => d != null)
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
          return cachedDesc(it, () => ({ tag: 'path', attrs, clean: isClean(it) }))
        })
    case 'image':
      return items
        .filter((it) => it.url != null && it.x != null && it.y != null)
        .map((it) => cachedDesc(it, () => ({
          tag: 'image',
          attrs: [
            ['xlink:href', String(it.url)],
            ['transform', `translate(${num(it.x!)},${num(it.y!)})`],
            ['width', num(it.width ?? 0)],
            ['height', num(it.height ?? 0)],
            ['preserveAspectRatio', it.aspect === false ? 'none' : 'xMidYMid'],
          ],
          clean: isClean(it),
        })))
    case 'arc':
      return items.map((it) => {
        const x = it.x as number
        const y = it.y as number
        const r = (it.outerRadius as number) ?? (it.radius as number) ?? 0
        const r0 = (it.innerRadius as number) ?? 0
        const a0 = (it.startAngle as number) ?? 0
        const a1 = (it.endAngle as number) ?? 0
        // Mirror renderArcs exactly: the arc path is generated around (0,0)
        // with a per-item translate — baking the center into `d` (or omitting
        // the translate) places the arcs at the svg origin.
        const cr = (it as Record<string, unknown>).cornerRadius as number | undefined ?? 0
        const pa = (it as Record<string, unknown>).padAngle as number | undefined ?? 0
        return cachedDesc(it, () => ({
          tag: 'path',
          attrs: [
            ['transform', `translate(${num(x)},${num(y)})`],
            ['d', arcPath(0, 0, r, r0, a0, a1, cr, pa)],
            ...props([['fill', it.fill], ['fill-opacity', it.fillOpacity], ['opacity', it.opacity], ['stroke', it.stroke], ['stroke-width', it.strokeWidth], ['stroke-dasharray', it.strokeDash]]),
          ],
          clean: isClean(it),
        }))
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
      const d = isGroup ? groupDesc(item as SceneGroup, plotW, plotH, clips) : cachedDesc(item, () => leafDesc(item))
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
  CURRENT_GEN = (scene as unknown as { __itemGen?: number }).__itemGen
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
        { tag: 'path', attrs: [['class', 'background'], ['aria-hidden', 'true'], ['d', frameD], ...(scene.frameFill ? [['fill', String(scene.frameFill)]] as Array<[string, string]> : []), ...(scene.frameStroke ? [['stroke', String(scene.frameStroke)]] as Array<[string, string]> : [])] },
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

  // DOM-subtree skip: a desc node whose scene item was reused (unchanged this
  // eval) is identical to the previous patch, so the element already matches and
  // we can avoid descending into it entirely.
  if (desc.clean && last) return

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
  // Traverse children via sibling links, not index access: HTMLCollection
  // .item(i) is a linear scan in several DOM implementations (jsdom: ~19us per
  // access), which makes an index walk O(n^2) over a mark's children — enough
  // to dominate every large-chart update. Linked traversal is O(1) per step.
  const have = el.childElementCount
  const n = Math.min(have, want.length)
  let cur = el.firstElementChild
  for (let i = 0; i < n && cur != null; i++, cur = cur.nextElementSibling) {
    const w = want[i]!
    if (cur.tagName === w.tag) patchEl(cur, w)
    else el.replaceChild(createEl(w, el.ownerDocument), cur)
  }
  // Removals (have > want) and appends (want > have) — walk the tail via links.
  if (have > want.length) {
    // Position cur at child index `want.length` (start of the tail to remove).
    let tail = el.firstElementChild
    for (let i = 0; i < want.length && tail != null; i++) tail = tail.nextElementSibling
    while (tail != null) {
      const next = tail.nextElementSibling
      el.removeChild(tail)
      tail = next
    }
  }
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
