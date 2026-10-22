/**
 * Strict SVG canonicalization for conformance diffing.
 *
 * The canonical form is a list of records, one per painted element, IN
 * DOCUMENT (PAINT) ORDER, each carrying everything that can change a pixel:
 *
 *   - geometry in absolute coordinates under the FULL cumulative transform
 *     (translate, rotate, scale, skew, matrix; the linear part is recorded
 *     whenever it is not the identity because it scales stroke widths, fonts,
 *     radii and rotates text),
 *   - the computed (inherited) paint and text style: fill, stroke and every
 *     stroke-* property, opacity, font-family/size/weight/style, text-anchor...
 *   - ancestor effects: group opacity, display, clip-path (resolved to its
 *     geometry, not its id), masks and filters,
 *   - gradient definitions (resolved to type, coordinates and stops, not ids),
 *   - text content including tspan structure, image href and box,
 *   - ANY attribute not listed as provably non-visual below (unknown attributes
 *     are compared, never dropped).
 *
 * Normalization is limited to representation differences that are provably
 * semantics-preserving. Each one is documented where it is applied and
 * summarised here:
 *
 *   N-attr-order     attribute order and quote style are irrelevant (XML).
 *   N-entities       XML character references are decoded before comparing.
 *   N-numfmt         numbers are compared at a fixed 3-decimal precision
 *                    (4 for the linear part of a transform), "-0" == "0",
 *                    "10px" == "10" for user-unit lengths.
 *   N-transform      every transform form (translate/scale/rotate/skew/matrix,
 *                    any nesting) is composed to one matrix; element geometry is
 *                    mapped through it, so `translate(a,b) x=0` == `x=a y=b`.
 *   N-path           path data is converted to absolute commands with explicit
 *                    repetition; H/V become L.
 *   N-color          colours are compared as the sRGB value they denote
 *                    ("white" == "#fff" == "rgb(255,255,255)").
 *   N-paint-none     a fully transparent fill/stroke paints nothing, like
 *                    `none`.
 *   N-initial        a property equal to its SVG initial value is the same as
 *                    the property being absent (opacity 1, stroke-linecap butt,
 *                    fill black, ...). Only true SVG initial values are used;
 *                    host-dependent defaults (font-family, font-size) are NOT
 *                    defaulted, so omitting them is a difference.
 *   N-dead           a property with no effect on the element is dropped:
 *                    stroke-* when there is no stroke, fill-opacity/fill-rule
 *                    when there is no fill, fill on <line>, font/text props on
 *                    non-text elements.
 *   N-inherit        presentation attributes inherited from ancestor <g>s are
 *                    resolved onto each element (computed style), so
 *                    `<g stroke=red><line/></g>` == `<line stroke=red/>`.
 *   N-id             ids are not compared; references (url(#id), href="#id")
 *                    are resolved to the referenced content. Unreferenced defs
 *                    paint nothing and are ignored.
 *   N-nonvisual      class, role, aria-*, tabindex, pointer-events, xmlns*,
 *                    version, <title>/<desc> carry no pixels. (aria-* is gated
 *                    by the a11y-parity gate instead; pointer-events by the
 *                    interaction tests.)
 *   N-bg             a first-painted, opaque, stroke-less rectangle covering
 *                    the whole canvas IS the canvas background (nothing can be
 *                    painted under it), and an `svg style="background-color"`
 *                    is the same thing, so both become the root `bg=` field.
 *   N-degenerate     a path whose every coordinate coincides, with no stroke or
 *                    a butt stroke cap, paints nothing (zero-length subpaths
 *                    draw only with round/square caps).
 *   N-endpoints      a <line> with no dash pattern is symmetric in its
 *                    endpoints; it is recorded with ordered endpoints.
 *   N-paintless      an element that paints nothing has a free position in
 *                    the paint order (it is still compared as a record).
 *   N-whitespace     text whitespace is collapsed as SVG's default
 *                    xml:space does.
 *
 * Paint order is preserved wherever it can matter. The canonical sequence is
 * the lexicographic normal form of the document order modulo swapping ADJACENT
 * records that provably cannot interact: same ancestor effects and painted
 * extents (conservative bounding boxes, inflated for strokes and text) that do
 * not intersect (see `paintOrderNormalForm`). Anything whose extent is unknown
 * is a barrier nothing may cross.
 */
import { color as d3color } from 'd3-color'
import { parseSvg, type XmlEl } from './svg-parse.js'

const PRECISION = 3
const LIN_PRECISION = 4

export interface CanonicalResult {
  records: string[]
  root: string | null
}

type Mat = [number, number, number, number, number, number]
const IDENT: Mat = [1, 0, 0, 1, 0, 0]

function mul(m: Mat, n: Mat): Mat {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ]
}
function apply(m: Mat, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
}
function isIdentityLinear(m: Mat): boolean {
  return Math.abs(m[0] - 1) < 1e-9 && Math.abs(m[1]) < 1e-9 && Math.abs(m[2]) < 1e-9 && Math.abs(m[3] - 1) < 1e-9
}

/** Compose any SVG transform list into one matrix (N-transform). Throws on junk. */
export function parseTransform(t: string | undefined): Mat {
  if (!t || !t.trim()) return IDENT
  let m: Mat = IDENT
  const re = /\s*([a-zA-Z]+)\s*\(([^)]*)\)\s*,?/y
  let pos = 0
  const s = t.trim()
  while (pos < s.length) {
    re.lastIndex = pos
    const hit = re.exec(s)
    if (!hit) throw new Error(`canonicalizeSvg: unparseable transform "${t}"`)
    pos = re.lastIndex
    const name = hit[1]!
    const a = hit[2]!.trim().split(/[\s,]+/).filter(Boolean).map(Number)
    if (a.some((v) => !Number.isFinite(v))) throw new Error(`canonicalizeSvg: non-finite transform "${t}"`)
    let n: Mat
    if (name === 'translate' && (a.length === 1 || a.length === 2)) n = [1, 0, 0, 1, a[0]!, a[1] ?? 0]
    else if (name === 'scale' && (a.length === 1 || a.length === 2)) n = [a[0]!, 0, 0, a[1] ?? a[0]!, 0, 0]
    else if (name === 'rotate' && (a.length === 1 || a.length === 3)) {
      const r = (a[0]! * Math.PI) / 180
      const c = Math.cos(r)
      const sn = Math.sin(r)
      n = [c, sn, -sn, c, 0, 0]
      if (a.length === 3) n = mul(mul([1, 0, 0, 1, a[1]!, a[2]!], n), [1, 0, 0, 1, -a[1]!, -a[2]!])
    } else if (name === 'skewX' && a.length === 1) n = [1, 0, Math.tan((a[0]! * Math.PI) / 180), 1, 0, 0]
    else if (name === 'skewY' && a.length === 1) n = [1, Math.tan((a[0]! * Math.PI) / 180), 0, 1, 0, 0]
    else if (name === 'matrix' && a.length === 6) n = a as Mat
    else throw new Error(`canonicalizeSvg: unsupported transform "${t}"`)
    m = mul(m, n)
  }
  return m
}

// ---------------------------------------------------------------- attributes

/** Attributes that cannot change a pixel (N-nonvisual). */
function isNonVisualAttr(name: string): boolean {
  return name === 'id' || name === 'class' || name === 'role' || name === 'tabindex' || name === 'pointer-events'
    || name === 'version' || name === 'xmlns' || name.startsWith('xmlns:') || name.startsWith('aria-')
}

/** Inherited presentation properties (SVG 1.1 / CSS), in record order. */
const INHERITED = [
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap',
  'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'visibility',
  'paint-order', 'shape-rendering', 'color', 'clip-rule',
  'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant', 'font-stretch', 'text-anchor',
  'text-decoration', 'letter-spacing', 'word-spacing', 'dominant-baseline', 'direction', 'text-rendering',
  'image-rendering', 'cursor',
] as const
const INHERITED_SET = new Set<string>(INHERITED)
const TEXT_ONLY = new Set([
  'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant', 'font-stretch', 'text-anchor',
  'text-decoration', 'letter-spacing', 'word-spacing', 'dominant-baseline', 'direction', 'text-rendering',
])
const STROKE_ONLY = new Set([
  'stroke-width', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit',
  'stroke-dasharray', 'stroke-dashoffset',
])
/** Non-inherited properties that apply to the element and are compared per element / ancestor. */
const OWN = ['opacity', 'display', 'clip-path', 'mask', 'filter', 'mix-blend-mode', 'isolation'] as const
const OWN_SET = new Set<string>(OWN)

/** Parsed presentation state of one element: own attributes plus CSS `style`. */
function attrsOf(el: XmlEl): Record<string, string> {
  const a: Record<string, string> = { ...el.attrs }
  const style = a['style']
  if (style) {
    for (const decl of style.split(';')) {
      const i = decl.indexOf(':')
      if (i < 0) continue
      const k = decl.slice(0, i).trim()
      const v = decl.slice(i + 1).trim()
      if (k) a[k] = v // CSS wins over presentation attributes
    }
  }
  return a
}

function roundIn(s: string): string {
  return s.replace(/-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g, (m) => num(parseFloat(m)))
}

function num(v: number | string, p = PRECISION): string {
  const n = typeof v === 'number' ? v : parseFloat(v)
  if (!Number.isFinite(n)) return String(n)
  const k = 10 ** p
  // Round half away from zero with a 1e-9 nudge: a value that is a rounding
  // tie in one engine (0.0625) and 0.06249999999999999 in the other (different
  // float evaluation order) must land in the same bucket.
  const r = Math.round((n + Math.sign(n) * 1e-9) * k) / k
  return r === 0 ? '0' : String(r)
}

function numAttr(v: string | undefined, what = 'number'): number {
  if (v === undefined) return 0
  // JS-serialized `NaN`/`Infinity` appear in documents rendered from degenerate
  // scales; both engines print them, so they compare as themselves.
  if (/^\s*(NaN|[-+]?Infinity)\s*$/.test(v)) return Number(v.trim())
  const m = /^\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)(px)?\s*$/.exec(v)
  if (!m) throw new Error(`canonicalizeSvg: non-numeric ${what} "${v}"`)
  return parseFloat(m[1]!)
}

/** Length in user units; em resolves against the element's computed font-size. */
function lengthAttr(v: string | undefined, fontSize: number | null, what: string): number {
  if (v === undefined) return 0
  const em = /^\s*([-+]?(?:\d+\.?\d*|\.\d+))em\s*$/.exec(v)
  if (em) {
    if (fontSize == null) throw new Error(`canonicalizeSvg: em length "${v}" (${what}) without a numeric font-size`)
    return parseFloat(em[1]!) * fontSize
  }
  return numAttr(v, what)
}

function canonColor(v: string): string {
  const t = v.trim()
  const c = d3color(t)
  if (!c) return t.replace(/\s+/g, ' ')
  const rgb = c.rgb()
  if (rgb.opacity === 1) return c.formatHex()
  return `rgba(${Math.round(rgb.r)},${Math.round(rgb.g)},${Math.round(rgb.b)},${num(rgb.opacity)})`
}

function isTransparentPaint(v: string): boolean {
  if (v.startsWith('url(')) return false
  const c = d3color(v.trim())
  return c != null && c.rgb().opacity === 0
}

function canonPaint(v: string): string {
  const t = v.trim()
  if (t === 'none') return 'none'
  if (t.startsWith('url(')) return t
  if (isTransparentPaint(t)) return 'none' // N-paint-none
  return canonColor(t)
}

function canonFontWeight(v: string): string {
  const t = v.trim()
  if (t === 'normal') return '400'
  if (t === 'bold') return '700'
  return roundIn(t)
}

function canonFamily(v: string): string {
  return v.trim().replace(/\s*,\s*/g, ',').replace(/'/g, '"')
}

function canonDash(v: string): string {
  const t = v.trim()
  if (t === 'none' || t === '') return ''
  const parts = t.split(/[\s,]+/).filter(Boolean).map((p) => num(numAttr(p, 'stroke-dasharray')))
  if (parts.every((p) => p === '0')) return '' // all-zero dash array disables dashing (SVG spec)
  return parts.join(',')
}

// ------------------------------------------------------------------ context

interface Ctx {
  byId: Map<string, XmlEl>
  rootW: number
  rootH: number
}

function indexIds(el: XmlEl, byId: Map<string, XmlEl>): void {
  const id = el.attrs['id']
  if (id !== undefined) byId.set(id, el)
  for (const c of el.children) if (typeof c !== 'string') indexIds(c, byId)
}

/** Resolve every `url(#id)` / `#id` reference inside a value to canonical content (N-id). */
function resolveRefs(value: string, m: Mat, ctx: Ctx, seen: string[] = []): string {
  // `url(#id)`, or `url(<page url>#id)`: a browser-built DOM writes the document
  // URL in front of a same-document reference (vega-embed's `base`); the fragment
  // is what names the element.
  return value.replace(/url\(\s*['"]?[^)#'"\s]*#([^'")\s]+)['"]?\s*\)/g, (_all, id: string) => {
    const target = ctx.byId.get(id)
    // A reference to an id that does not exist has no paint server / clip
    // (browsers paint none, or leave the element unclipped); which id it names
    // is irrelevant, so two dangling references are equal (N-id).
    if (!target) return 'url(<unresolved>)'
    if (seen.includes(id)) throw new Error(`canonicalizeSvg: reference cycle through "${id}"`)
    return `url(${canonDef(target, m, ctx, [...seen, id])})`
  })
}

/** Canonical content of a referenced def. clipPath is geometry under the referencing matrix. */
function canonDef(el: XmlEl, m: Mat, ctx: Ctx, seen: string[]): string {
  const a = attrsOf(el)
  if (el.tag === 'clipPath') {
    if ((a['clipPathUnits'] ?? 'userSpaceOnUse') !== 'userSpaceOnUse') {
      throw new Error('canonicalizeSvg: clipPathUnits=objectBoundingBox is not supported')
    }
    const own = mul(m, parseTransform(a['transform']))
    const parts: string[] = []
    for (const c of el.children) {
      if (typeof c === 'string') continue
      parts.push(geometryOf(c, mul(own, parseTransform(attrsOf(c)['transform'])), {}, ctx))
    }
    return `clipPath{${parts.join(';')}}`
  }
  if (el.tag === 'linearGradient' || el.tag === 'radialGradient') {
    const keys = Object.keys(a).filter((k) => !isNonVisualAttr(k)).sort()
    const attrs = keys.map((k) => `${k}=${canonGradAttr(k, a[k]!, ctx, m, seen)}`).join(';')
    const stops: string[] = []
    for (const c of el.children) {
      if (typeof c === 'string') continue
      if (c.tag !== 'stop') throw new Error(`canonicalizeSvg: unsupported <${c.tag}> inside gradient`)
      const sa = attrsOf(c)
      const off = (sa['offset'] ?? '0').trim()
      const offset = off.endsWith('%') ? parseFloat(off) / 100 : parseFloat(off)
      const rest = Object.keys(sa).filter((k) => !isNonVisualAttr(k) && k !== 'offset').sort()
        .map((k) => `${k}=${k === 'stop-color' ? canonColor(sa[k]!) : roundIn(sa[k]!)}`)
      stops.push(`stop(${num(offset)};${rest.join(';')})`)
    }
    return `${el.tag}{${attrs}}[${stops.join(',')}]`
  }
  throw new Error(`canonicalizeSvg: unsupported reference target <${el.tag}>`)
}

function canonGradAttr(k: string, v: string, ctx: Ctx, m: Mat, seen: string[]): string {
  if (k === 'xlink:href' || k === 'href') {
    const id = v.replace(/^#/, '')
    const target = ctx.byId.get(id)
    if (!target) throw new Error(`canonicalizeSvg: gradient href to missing id "${id}"`)
    return canonDef(target, m, ctx, [...seen, id])
  }
  if (k === 'gradientTransform') return matStr(parseTransform(v))
  return roundIn(v)
}

function matStr(m: Mat): string {
  return `[${num(m[0], LIN_PRECISION)},${num(m[1], LIN_PRECISION)},${num(m[2], LIN_PRECISION)},${num(m[3], LIN_PRECISION)},${num(m[4])},${num(m[5])}]`
}

// ----------------------------------------------------------------- geometry

function pt(m: Mat, x: number, y: number): string {
  const [px, py] = apply(m, x, y)
  return `${num(px)},${num(py)}`
}

function linOf(m: Mat): string {
  return isIdentityLinear(m) ? '' : `|lin=${num(m[0], LIN_PRECISION)},${num(m[1], LIN_PRECISION)},${num(m[2], LIN_PRECISION)},${num(m[3], LIN_PRECISION)}`
}

/** Geometry string (absolute, under m) for a shape element. Style is separate. */
function geometryOf(el: XmlEl, m: Mat, eff: Record<string, string>, ctx: Ctx): string {
  const a = attrsOf(el)
  const fs = fontSizePx(eff)
  switch (el.tag) {
    case 'rect': {
      const x = numAttr(a['x'], 'rect x'), y = numAttr(a['y'], 'rect y')
      const w = numAttr(a['width'], 'rect width'), h = numAttr(a['height'], 'rect height')
      const rx = a['rx'] === undefined ? '' : `|rx=${num(numAttr(a['rx']))}`
      const ry = a['ry'] === undefined ? '' : `|ry=${num(numAttr(a['ry']))}`
      return `rect|${pt(m, x, y)}|${num(w)}|${num(h)}${rx}${ry}${linOf(m)}`
    }
    case 'line': {
      let p1 = apply(m, numAttr(a['x1']), numAttr(a['y1']))
      let p2 = apply(m, numAttr(a['x2']), numAttr(a['y2']))
      const dashed = canonDash(eff['stroke-dasharray'] ?? '') !== ''
      // N-endpoints: an undashed line is symmetric in its endpoints.
      if (!dashed && (p1[0] > p2[0] || (p1[0] === p2[0] && p1[1] > p2[1]))) [p1, p2] = [p2, p1]
      return `line|${num(p1[0])},${num(p1[1])}|${num(p2[0])},${num(p2[1])}${linOf(m)}`
    }
    case 'circle':
      return `circle|${pt(m, numAttr(a['cx']), numAttr(a['cy']))}|${num(numAttr(a['r']))}${linOf(m)}`
    case 'ellipse':
      return `ellipse|${pt(m, numAttr(a['cx']), numAttr(a['cy']))}|${num(numAttr(a['rx']))}|${num(numAttr(a['ry']))}${linOf(m)}`
    case 'path':
      return `path|${canonPath(a['d'] ?? '', m)}${linOf(m)}`
    case 'polygon':
    case 'polyline': {
      const nums = (a['points'] ?? '').trim().split(/[\s,]+/).filter(Boolean).map(Number)
      if (nums.length % 2 || nums.some((n) => !Number.isFinite(n))) throw new Error(`canonicalizeSvg: bad points "${a['points']}"`)
      const pts: string[] = []
      for (let i = 0; i < nums.length; i += 2) pts.push(pt(m, nums[i]!, nums[i + 1]!))
      return `${el.tag}|${pts.join(' ')}${linOf(m)}`
    }
    case 'image': {
      const href = a['href'] ?? a['xlink:href']
      if (href === undefined) throw new Error('canonicalizeSvg: <image> without href')
      const x = numAttr(a['x']), y = numAttr(a['y'])
      return `image|${pt(m, x, y)}|${num(numAttr(a['width']))}|${num(numAttr(a['height']))}|href=${href}${linOf(m)}`
    }
    case 'text': {
      const x = numAttr(a['x'], 'text x') + lengthAttr(a['dx'], fs, 'text dx')
      const y = numAttr(a['y'], 'text y') + lengthAttr(a['dy'], fs, 'text dy')
      return `text|${pt(m, x, y)}|${textContent(el, fs)}${linOf(m)}`
    }
    default:
      throw new Error(`canonicalizeSvg: unsupported shape <${el.tag}>`)
  }
  void ctx
}

function fontSizePx(eff: Record<string, string>): number | null {
  const v = eff['font-size']
  if (v === undefined) return null
  const m = /^\s*([-+]?(?:\d+\.?\d*|\.\d+))(px)?\s*$/.exec(v)
  return m ? parseFloat(m[1]!) : null
}

/** Text content with tspan structure; whitespace collapsed (N-whitespace). */
function textContent(el: XmlEl, fs: number | null): string {
  const out: string[] = []
  const collect = (e: XmlEl) => {
    for (const c of e.children) {
      if (typeof c === 'string') {
        const t = c.replace(/\s+/g, ' ')
        if (t.trim() !== '' || out.length) out.push(t)
      } else if (c.tag === 'tspan') {
        const a = attrsOf(c)
        const extra = Object.keys(a).filter((k) => !isNonVisualAttr(k) && !['x', 'y', 'dx', 'dy'].includes(k)).sort()
          .map((k) => `${k}=${roundIn(a[k]!)}`)
        out.push(`<tspan x=${a['x'] === undefined ? '' : num(numAttr(a['x']))} y=${a['y'] === undefined ? '' : num(numAttr(a['y']))} dx=${num(lengthAttr(a['dx'], fs, 'tspan dx'))} dy=${num(lengthAttr(a['dy'], fs, 'tspan dy'))}${extra.length ? ' ' + extra.join(' ') : ''}>`)
        collect(c)
        out.push('</tspan>')
      } else {
        throw new Error(`canonicalizeSvg: unsupported <${c.tag}> inside <text>`)
      }
    }
  }
  collect(el)
  return out.join('').trim()
}

/** Absolute path with explicit commands under m (N-path). */
function canonPath(d: string, m: Mat): string {
  const toks = tokenizePath(d)
  let out = ''
  let cx = 0, cy = 0, sx = 0, sy = 0
  let i = 0
  let cmd = ''
  const needs: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 }
  const lin = m
  const similarity = Math.abs(lin[0] - lin[3]) < 1e-9 && Math.abs(lin[1] + lin[2]) < 1e-9
  const scale = Math.hypot(lin[0], lin[1])
  const angle = (Math.atan2(lin[1], lin[0]) * 180) / Math.PI
  let first = true
  while (i < toks.length) {
    const t = toks[i]!
    if (typeof t === 'string') {
      cmd = t
      i++
      if (first && cmd.toUpperCase() !== 'M') throw new Error(`canonicalizeSvg: path must begin with M: "${d}"`)
      first = false
      if (cmd === 'Z' || cmd === 'z') {
        out += 'Z'
        cx = sx
        cy = sy
      }
      continue
    }
    if (!cmd) throw new Error(`canonicalizeSvg: path data starts with a number: "${d}"`)
    const U = cmd.toUpperCase()
    const rel = cmd !== U
    const need = needs[U]
    if (need === undefined || need === 0) throw new Error(`canonicalizeSvg: bad path command "${cmd}" in "${d}"`)
    const args = toks.slice(i, i + need)
    if (args.length < need || args.some((v) => typeof v !== 'number')) throw new Error(`canonicalizeSvg: short path command "${cmd}" in "${d}"`)
    i += need
    const v = args as number[]
    const ox = rel ? cx : 0
    const oy = rel ? cy : 0
    switch (U) {
      case 'M': {
        cx = ox + v[0]!; cy = oy + v[1]!; sx = cx; sy = cy
        out += `M${pt(m, cx, cy)}`
        cmd = rel ? 'l' : 'L' // implicit repetition
        break
      }
      case 'L': cx = ox + v[0]!; cy = oy + v[1]!; out += `L${pt(m, cx, cy)}`; break
      case 'H': cx = ox + v[0]!; out += `L${pt(m, cx, cy)}`; break
      case 'V': cy = oy + v[0]!; out += `L${pt(m, cx, cy)}`; break
      case 'C': {
        out += `C${pt(m, ox + v[0]!, oy + v[1]!)},${pt(m, ox + v[2]!, oy + v[3]!)},${pt(m, ox + v[4]!, oy + v[5]!)}`
        cx = ox + v[4]!; cy = oy + v[5]!
        break
      }
      case 'S':
      case 'Q': {
        out += `${U}${pt(m, ox + v[0]!, oy + v[1]!)},${pt(m, ox + v[2]!, oy + v[3]!)}`
        cx = ox + v[2]!; cy = oy + v[3]!
        break
      }
      case 'T': cx = ox + v[0]!; cy = oy + v[1]!; out += `T${pt(m, cx, cy)}`; break
      case 'A': {
        if (!isIdentityLinear(m) && !similarity) {
          throw new Error('canonicalizeSvg: arc under a non-similarity transform is not supported')
        }
        const s = isIdentityLinear(m) ? 1 : scale
        const rot = isIdentityLinear(m) ? 0 : angle
        cx = ox + v[5]!; cy = oy + v[6]!
        out += `A${num(v[0]! * s)},${num(v[1]! * s)},${num(v[2]! + rot)},${v[3]},${v[4]},${pt(m, cx, cy)}`
        break
      }
    }
  }
  return out
}

/** Tokens are command letters or numbers; arc flags may be unseparated. */
function tokenizePath(d: string): Array<string | number> {
  const out: Array<string | number> = []
  const numRe = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?|[-+]?NaN|[-+]?Infinity/y
  let i = 0
  let cmd = ''
  let argIdx = 0
  while (i < d.length) {
    const ch = d[i]!
    if (/[\s,]/.test(ch)) { i++; continue }
    // `NaN` / `Infinity` are number tokens (JS-serialized path data), not commands
    if (/[A-Za-z]/.test(ch) && !/^(?:NaN|Infinity)/.test(d.slice(i))) { cmd = ch; argIdx = 0; out.push(ch); i++; continue }
    if (cmd.toUpperCase() === 'A' && (argIdx % 7 === 3 || argIdx % 7 === 4)) {
      if (ch !== '0' && ch !== '1') throw new Error(`canonicalizeSvg: bad arc flag in "${d}"`)
      out.push(Number(ch)); i++; argIdx++; continue
    }
    numRe.lastIndex = i
    const hit = numRe.exec(d)
    if (!hit) throw new Error(`canonicalizeSvg: bad path data "${d}" at ${i}`)
    out.push(hit[0].endsWith('NaN') ? NaN : hit[0].endsWith('Infinity') ? (hit[0].startsWith('-') ? -Infinity : Infinity) : parseFloat(hit[0]))
    i += hit[0].length
    argIdx++
  }
  return out
}

// ------------------------------------------------------------------- style

/** Computed style fields of a painted element, in fixed order. */
function styleOf(tag: string, eff: Record<string, string>, ctx: Ctx, m: Mat): string[] {
  const parts: string[] = []
  const strokeRaw = eff['stroke']
  const stroke = strokeRaw === undefined ? 'none' : canonPaint(resolveRefs(strokeRaw, m, ctx))
  const fillRaw = eff['fill']
  const fill = fillRaw === undefined ? '#000000' : canonPaint(resolveRefs(fillRaw, m, ctx))
  const isText = tag === 'text'
  const push = (k: string, v: string) => parts.push(`${k}=${v}`)

  // fill: N-initial (black), N-dead (<line> has no fill area)
  if (tag !== 'line') {
    push('fill', fill)
    if (fill !== 'none') {
      const fo = eff['fill-opacity']
      if (fo !== undefined && num(numAttr(fo)) !== '1') push('fill-opacity', num(numAttr(fo)))
      const fr = eff['fill-rule']
      if (fr !== undefined && fr !== 'nonzero') push('fill-rule', fr)
    }
  }
  if (stroke !== 'none') {
    push('stroke', stroke)
    const sw = eff['stroke-width']
    push('stroke-width', sw === undefined ? '1' : roundIn(sw.replace(/px$/, '')))
    const so = eff['stroke-opacity']
    if (so !== undefined && num(numAttr(so)) !== '1') push('stroke-opacity', num(numAttr(so)))
    const cap = eff['stroke-linecap']
    if (cap !== undefined && cap !== 'butt') push('stroke-linecap', cap)
    const join = eff['stroke-linejoin']
    if (join !== undefined && join !== 'miter') push('stroke-linejoin', join)
    const ml = eff['stroke-miterlimit']
    if (ml !== undefined && num(numAttr(ml)) !== '4') push('stroke-miterlimit', num(numAttr(ml)))
    const dash = canonDash(eff['stroke-dasharray'] ?? '')
    if (dash) {
      push('stroke-dasharray', dash)
      const off = eff['stroke-dashoffset']
      if (off !== undefined && num(numAttr(off)) !== '0') push('stroke-dashoffset', num(numAttr(off)))
    }
  }
  if (isText) {
    for (const k of ['font-family', 'font-size', 'font-weight', 'font-style', 'font-variant', 'font-stretch', 'text-anchor',
      'text-decoration', 'letter-spacing', 'word-spacing', 'dominant-baseline', 'direction', 'text-rendering']) {
      const v = eff[k]
      if (v === undefined) continue
      let c: string
      if (k === 'font-family') c = canonFamily(v)
      else if (k === 'font-weight') c = canonFontWeight(v)
      else if (k === 'font-size') c = roundIn(v.replace(/px$/, ''))
      else c = roundIn(v.trim())
      if (k === 'font-style' && c === 'normal') continue
      if (k === 'text-anchor' && c === 'start') continue
      if (k === 'font-variant' && c === 'normal') continue
      if (k === 'font-stretch' && c === 'normal') continue
      if (k === 'text-decoration' && c === 'none') continue
      if ((k === 'letter-spacing' || k === 'word-spacing') && c === 'normal') continue
      if (k === 'direction' && c === 'ltr') continue
      push(k, c)
    }
  }
  if (eff['visibility'] !== undefined && eff['visibility'] !== 'visible') push('visibility', eff['visibility'])
  for (const k of ['paint-order', 'shape-rendering', 'image-rendering', 'color', 'cursor'] as const) {
    if (eff[k] !== undefined) push(k, k === 'color' ? canonColor(eff[k]!) : eff[k]!)
  }
  return parts
}

/**
 * Non-inherited effects of one element (opacity, display, clip, mask...) plus
 * every attribute that is neither geometry (`legal`), inherited style, nor
 * provably non-visual: unknown attributes are compared, never dropped.
 */
function ownEffects(a: Record<string, string>, legal: ReadonlySet<string>, m: Mat, ctx: Ctx): string[] {
  const out: string[] = []
  for (const k of OWN) {
    const v = a[k]
    if (v === undefined) continue
    if (k === 'opacity') {
      if (num(numAttr(v)) === '1') continue // N-initial
      out.push(`opacity=${num(numAttr(v))}`)
    } else if (k === 'display') {
      if (v === 'inline') continue // N-initial
      out.push(`display=${v}`)
    } else out.push(`${k}=${roundIn(resolveRefs(v, m, ctx))}`)
  }
  const extras = Object.keys(a)
    .filter((k) => !isNonVisualAttr(k) && !INHERITED_SET.has(k) && !OWN_SET.has(k) && k !== 'transform' && k !== 'style' && !legal.has(k))
    .sort()
  // xlink:href and href are the same attribute
  for (const k of extras) out.push(`@${k === 'xlink:href' ? 'href' : k}=${k === 'xlink:href' || k === 'href' ? a[k]! : roundIn(a[k]!)}`)
  return out
}

const ROOT_ATTRS: ReadonlySet<string> = new Set(['width', 'height', 'viewBox', 'preserveAspectRatio', 'background', 'background-color'])
const NO_ATTRS: ReadonlySet<string> = new Set()
const LINK_ATTRS: ReadonlySet<string> = new Set()
const CONTAINERS = new Set(['g', 'svg', 'a'])
const NONRENDERING = new Set(['defs', 'title', 'desc', 'metadata', 'clipPath', 'linearGradient', 'radialGradient'])
const SHAPES = new Set(['rect', 'line', 'circle', 'ellipse', 'path', 'polygon', 'polyline', 'image', 'text'])

/** Attributes legal on each shape (others are compared as extras). */
const SHAPE_ATTRS: Record<string, string[]> = {
  rect: ['x', 'y', 'width', 'height', 'rx', 'ry'],
  line: ['x1', 'y1', 'x2', 'y2'],
  circle: ['cx', 'cy', 'r'],
  ellipse: ['cx', 'cy', 'rx', 'ry'],
  path: ['d'],
  polygon: ['points'],
  polyline: ['points'],
  image: ['x', 'y', 'width', 'height', 'href', 'xlink:href'],
  text: ['x', 'y', 'dx', 'dy'],
}

// -------------------------------------------------------------------- main

export function canonicalizeSvg(svg: string): CanonicalResult {
  const doc = parseSvg(svg)
  const rootEl = doc.children.find((c): c is XmlEl => typeof c !== 'string' && c.tag === 'svg')
  if (!rootEl) throw new Error('canonicalizeSvg: no <svg> root')
  const byId = new Map<string, XmlEl>()
  indexIds(rootEl, byId)
  const ra = attrsOf(rootEl)
  const rootW = numAttr(ra['width'], 'svg width')
  const rootH = numAttr(ra['height'], 'svg height')
  const ctx: Ctx = { byId, rootW, rootH }

  interface Rec { text: string; isRect: boolean; bgFill?: string; box: Box | null; ctx: string; paintless: boolean }
  const recs: Rec[] = []
  let bg = ''
  const styleBg = (/(?:^|;)\s*background(?:-color)?\s*:\s*([^;]+)/.exec(ra['style'] ?? ''))?.[1]
  if (styleBg !== undefined) bg = canonPaint(styleBg)

  const walk = (el: XmlEl, parentM: Mat, parentEff: Record<string, string>, anc: string[]) => {
    const a = attrsOf(el)
    const m = mul(parentM, parseTransform(a['transform']))
    const eff = { ...parentEff }
    for (const k of INHERITED) if (a[k] !== undefined) eff[k] = a[k]!
    if (CONTAINERS.has(el.tag)) {
      if (el.tag === 'svg' && el !== rootEl) throw new Error('canonicalizeSvg: nested <svg> is not supported')
      // An <a> is a hyperlink wrapper around its content: it paints nothing, but
      // which URL it points at is observable, so its href stays an ancestor effect
      // (xlink:href and href are the same attribute: N-attr).
      const legal = el === rootEl ? ROOT_ATTRS : el.tag === 'a' ? LINK_ATTRS : NO_ATTRS
      const effects = ownEffects(a, legal, m, ctx)
      const nextAnc = effects.length ? [...anc, `{${effects.join(';')}}`] : anc
      for (const c of el.children) if (typeof c !== 'string') walk(c, m, eff, nextAnc)
      return
    }
    if (NONRENDERING.has(el.tag)) return
    if (!SHAPES.has(el.tag)) throw new Error(`canonicalizeSvg: unsupported element <${el.tag}>`)

    const geom = geometryOf(el, m, eff, ctx)
    if (el.tag === 'path' && isDegenerate(a['d'] ?? '', eff)) return // N-degenerate
    const style = styleOf(el.tag, eff, ctx, m)
    const effects = ownEffects(a, new Set(SHAPE_ATTRS[el.tag]), m, ctx)
    const text = [geom, style.join(';'), effects.join(';'), anc.join('>')].join('|')
    const strokeNone = !style.some((s) => s.startsWith('stroke='))
    const fillStr = style.find((s) => s.startsWith('fill='))
    const isBgCandidate = el.tag === 'rect' && anc.length === 0 && effects.length === 0 && strokeNone
      && fillStr !== undefined && fillStr !== 'fill=none' && !style.some((s) => s.startsWith('fill-opacity='))
      && geom === `rect|${num(0)},${num(0)}|${num(rootW)}|${num(rootH)}`
    const box = paintedBox(el, a, m, eff, style, effects, geom)
    // N-paintless: an element that paints nothing (no fill and no stroke,
    // opacity 0, display none, visibility hidden) cannot interact with any
    // other element, so its place in the sequence is irrelevant. It is still a
    // record (its presence and geometry are compared); only its order is free.
    const hasFill = fillStr !== undefined && fillStr !== 'fill=none'
    const paintless = (el.tag !== 'image' && el.tag !== 'text' && !hasFill && strokeNone)
      || (el.tag === 'text' && !hasFill && strokeNone)
      || effects.some((e) => e === 'opacity=0' || e === 'display=none')
      || anc.some((c) => /(^|[{;])(opacity=0|display=none)([;}]|$)/.test(c))
      || style.some((st) => st === 'visibility=hidden' || st === 'visibility=collapse')
    recs.push({ text, isRect: isBgCandidate, bgFill: fillStr?.slice(5), box, ctx: anc.join('>'), paintless })
  }

  const rootEff: Record<string, string> = {}
  walk(rootEl, IDENT, rootEff, [])

  // N-bg: the first painted record, if it is an opaque full-canvas rect, is the background.
  if (recs.length && recs[0]!.isRect && !/^rgba\(/.test(recs[0]!.bgFill ?? '')) {
    const f = recs[0]!.bgFill!
    if (bg !== '' && bg !== f) {
      // both a style background and a covering rect: the rect paints over the style
    }
    bg = f
    recs.shift()
  }

  const root = `svg|${num(rootW)}|${num(rootH)}|${(ra['viewBox'] ?? '').trim().split(/[\s,]+/).map((v) => num(Number(v))).join(' ')}|bg=${bg}`
  return { records: paintOrderNormalForm(recs), root }
}

/** N-degenerate: path whose points all coincide and whose stroke cannot draw a zero-length subpath. */
function isDegenerate(d: string, eff: Record<string, string>): boolean {
  if (!d.trim()) return true // empty path draws nothing
  if (d.includes('NaN') || /[Aa]/.test(d)) return false
  const abs = canonPath(d, IDENT)
  const pts = (abs.match(/-?[\d.]+(?:e[-+]?\d+)?,-?[\d.]+(?:e[-+]?\d+)?/g) ?? [])
  if (pts.length === 0 || pts.some((p) => p !== pts[0])) return false
  const stroke = eff['stroke']
  const strokeOn = stroke !== undefined && canonPaint(stroke) !== 'none'
  return !strokeOn || (eff['stroke-linecap'] ?? 'butt') === 'butt'
}

export function diffCanonical(a: CanonicalResult, b: CanonicalResult): string[] {
  const diffs: string[] = []
  if (a.root !== b.root) diffs.push(`root: ${a.root} vs ${b.root}`)
  if (a.records.length === b.records.length && a.records.every((r, i) => r === b.records[i])) return diffs
  // Multiset difference first: a missing/extra record would otherwise shift every index.
  const counts = new Map<string, number>()
  for (const r of a.records) counts.set(r, (counts.get(r) ?? 0) + 1)
  const onlyB: string[] = []
  for (const r of b.records) {
    const c = counts.get(r) ?? 0
    if (c > 0) counts.set(r, c - 1)
    else onlyB.push(r)
  }
  const onlyA: string[] = []
  for (const [r, c] of counts) for (let i = 0; i < c; i++) onlyA.push(r)
  const LIMIT = 20
  for (const r of onlyA.slice(0, LIMIT)) diffs.push(`only-oracle: ${r}`)
  for (const r of onlyB.slice(0, LIMIT)) diffs.push(`only-aster: ${r}`)
  if (onlyA.length > LIMIT || onlyB.length > LIMIT) diffs.push(`... ${onlyA.length} oracle-only and ${onlyB.length} aster-only records in total`)
  if (onlyA.length === 0 && onlyB.length === 0) {
    const i = a.records.findIndex((r, k) => r !== b.records[k])
    diffs.push(`paint-order: same records, different order; first divergence at record ${i}: ${a.records[i]}  |  ${b.records[i]}`)
  }
  return diffs
}


// -------------------------------------------------------- paint-order form

type Box = [number, number, number, number]

function boxOfPoints(pts: Array<[number, number]>): Box | null {
  if (pts.length === 0) return null
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity
  for (const [x, y] of pts) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null
    if (x < x1) x1 = x
    if (y < y1) y1 = y
    if (x > x2) x2 = x
    if (y > y2) y2 = y
  }
  return [x1, y1, x2, y2]
}

/** Largest scale the linear part applies (Frobenius norm bounds the spectral norm). */
function linScale(m: Mat): number {
  return Math.sqrt(m[0] * m[0] + m[1] * m[1] + m[2] * m[2] + m[3] * m[3])
}

/**
 * A conservative bound of everything the element can paint (fill, stroke with
 * joins/caps, antialiasing fringe), in absolute coordinates, or null when it
 * cannot be bounded (then the record is a paint-order barrier).
 */
function paintedBox(el: XmlEl, a: Record<string, string>, m: Mat, eff: Record<string, string>, style: string[], effects: string[], geom: string): Box | null {
  // Filters, masks, blend modes and extra attributes can paint outside any box.
  if (effects.some((e) => !e.startsWith('opacity=') && !e.startsWith('display=') && !e.startsWith('clip-path='))) return null
  const corner = (x: number, y: number): [number, number] => apply(m, x, y)
  let box: Box | null
  switch (el.tag) {
    case 'rect': {
      const x = numAttr(a['x']), y = numAttr(a['y']), w = numAttr(a['width']), h = numAttr(a['height'])
      box = boxOfPoints([corner(x, y), corner(x + w, y), corner(x, y + h), corner(x + w, y + h)])
      break
    }
    case 'image': {
      const x = numAttr(a['x']), y = numAttr(a['y']), w = numAttr(a['width']), h = numAttr(a['height'])
      box = boxOfPoints([corner(x, y), corner(x + w, y), corner(x, y + h), corner(x + w, y + h)])
      break
    }
    case 'line':
      box = boxOfPoints([corner(numAttr(a['x1']), numAttr(a['y1'])), corner(numAttr(a['x2']), numAttr(a['y2']))])
      break
    case 'circle': {
      const r = numAttr(a['r']) * linScale(m)
      const [cx, cy] = corner(numAttr(a['cx']), numAttr(a['cy']))
      box = boxOfPoints([[cx - r, cy - r], [cx + r, cy + r]])
      break
    }
    case 'ellipse': {
      const r = Math.max(numAttr(a['rx']), numAttr(a['ry'])) * linScale(m)
      const [cx, cy] = corner(numAttr(a['cx']), numAttr(a['cy']))
      box = boxOfPoints([[cx - r, cy - r], [cx + r, cy + r]])
      break
    }
    case 'polygon':
    case 'polyline': {
      const nums = (a['points'] ?? '').trim().split(/[\s,]+/).filter(Boolean).map(Number)
      const pts: Array<[number, number]> = []
      for (let i = 0; i + 1 < nums.length; i += 2) pts.push(corner(nums[i]!, nums[i + 1]!))
      box = boxOfPoints(pts)
      break
    }
    case 'path': {
      // geom is `path|<absolute commands>[|lin=..]`: every coordinate is already absolute.
      const d = geom.slice(5).split('|')[0]!
      const pts: Array<[number, number]> = []
      const segRe = /([MLCSQTAZ])([^MLCSQTAZ]*)/g
      let hit: RegExpExecArray | null
      while ((hit = segRe.exec(d))) {
        const nums = hit[2]!.split(',').filter((v) => v !== '').map(Number)
        if (hit[1] === 'A') {
          if (nums.length < 7) return null
          const r = Math.max(Math.abs(nums[0]!), Math.abs(nums[1]!))
          pts.push([nums[5]! - r, nums[6]! - r], [nums[5]! + r, nums[6]! + r])
        } else {
          for (let i = 0; i + 1 < nums.length; i += 2) pts.push([nums[i]!, nums[i + 1]!])
        }
      }
      box = boxOfPoints(pts)
      break
    }
    case 'text': {
      const fs = fontSizePx(eff)
      if (fs == null || eff['dominant-baseline'] !== undefined || eff['letter-spacing'] !== undefined || eff['word-spacing'] !== undefined) return null
      const content = textContent(el, fs)
      const lines = content.split(/<\/?tspan[^>]*>/).filter((l) => l.trim() !== '')
      const chars = Math.max(1, ...lines.map((l) => l.length))
      // Glyph extents of any font stay inside 1.5 em per character horizontally
      // and [-1.3, 0.5] em (+ 1.6 em per extra line) vertically of the baseline.
      const w = chars * fs * 1.5
      const anchor = eff['text-anchor'] ?? 'start'
      const x0 = anchor === 'middle' ? -w / 2 : anchor === 'end' ? -w : 0
      const x = numAttr(a['x']) + lengthAttr(a['dx'], fs, 'dx')
      const y = numAttr(a['y']) + lengthAttr(a['dy'], fs, 'dy')
      const top = y - 1.3 * fs
      const bottom = y + 0.5 * fs + Math.max(0, lines.length - 1) * 1.6 * fs
      box = boxOfPoints([corner(x + x0, top), corner(x + x0 + w, top), corner(x + x0, bottom), corner(x + x0 + w, bottom)])
      break
    }
    default:
      return null
  }
  if (!box) return null
  let inflate = 1 // antialiasing fringe
  const stroke = style.find((st) => st.startsWith('stroke='))
  if (stroke) {
    const sw = Number((style.find((st) => st.startsWith('stroke-width=')) ?? 'stroke-width=1').slice(13))
    const ml = Number((style.find((st) => st.startsWith('stroke-miterlimit=')) ?? 'stroke-miterlimit=4').slice(18))
    const cap = style.find((st) => st.startsWith('stroke-linecap='))
    const join = style.find((st) => st.startsWith('stroke-linejoin='))
    let k = join === undefined || join === 'stroke-linejoin=miter' ? Math.max(1, ml) : 1
    if (cap === 'stroke-linecap=square') k = Math.max(k, Math.SQRT2)
    if (!Number.isFinite(sw) || !Number.isFinite(k)) return null
    inflate += (sw * linScale(m) * k) / 2
  }
  return [box[0] - inflate, box[1] - inflate, box[2] + inflate, box[3] + inflate]
}

function boxesOverlap(a: Box, b: Box): boolean {
  return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3]
}

/**
 * Lexicographic normal form of the record sequence under the independence
 * relation "adjacent records with the same ancestor effects and disjoint
 * painted boxes may swap" (a trace monoid: two sequences are equivalent iff
 * their normal forms are equal). Sound: swapping two elements whose painted
 * regions cannot intersect never changes a pixel.
 *
 * Records with unknown extent, and records whose ancestor effects differ, are
 * barriers: nothing moves across them, so the sequence splits into independent
 * segments that are normalized separately.
 */
function paintOrderNormalForm(all: Array<{ text: string; box: Box | null; ctx: string; paintless: boolean }>): string[] {
  const out: string[] = []
  const recs = all.filter((r) => !r.paintless)
  const free = all.filter((r) => r.paintless).map((r) => r.text).sort()
  let i = 0
  while (i < recs.length) {
    const r = recs[i]!
    if (r.box === null) { out.push(r.text); i++; continue }
    let j = i + 1
    while (j < recs.length && recs[j]!.box !== null && recs[j]!.ctx === r.ctx) j++
    for (const seg of normalizeSegment(recs.slice(i, j) as Array<{ text: string; box: Box }>)) out.push(seg)
    i = j
  }
  return [...out, ...free]
}

const MAX_OVERLAP_PAIRS = 4_000_000

function normalizeSegment(seg: Array<{ text: string; box: Box }>): string[] {
  const n = seg.length
  if (n < 2) return seg.map((r) => r.text)
  // predecessors: earlier records with an overlapping box (grid-bucketed)
  const CELL = 64
  const cells = new Map<number, number[]>()
  const preds: number[][] = Array.from({ length: n }, () => [])
  const succ: number[][] = Array.from({ length: n }, () => [])
  let pairs = 0
  for (let k = 0; k < n; k++) {
    const b = seg[k]!.box
    const cx1 = Math.floor(b[0] / CELL), cx2 = Math.floor(b[2] / CELL)
    const cy1 = Math.floor(b[1] / CELL), cy2 = Math.floor(b[3] / CELL)
    if ((cx2 - cx1 + 1) * (cy2 - cy1 + 1) > 4096) return seg.map((r) => r.text) // huge box: keep document order (stricter, still sound)
    const seen = new Set<number>()
    for (let cx = cx1; cx <= cx2; cx++) {
      for (let cy = cy1; cy <= cy2; cy++) {
        const key = cx * 1_000_003 + cy
        const bucket = cells.get(key)
        if (bucket) {
          for (const j of bucket) {
            if (!seen.has(j) && boxesOverlap(seg[j]!.box, b)) {
              seen.add(j)
              preds[k]!.push(j)
              succ[j]!.push(k)
              if (++pairs > MAX_OVERLAP_PAIRS) return seg.map((r) => r.text)
            }
          }
          bucket.push(k)
        } else cells.set(key, [k])
      }
    }
  }
  // Kahn's algorithm, always taking the smallest ready record.
  const indeg = preds.map((p) => p.length)
  const heap: number[] = []
  const less = (x: number, y: number): boolean => seg[x]!.text < seg[y]!.text || (seg[x]!.text === seg[y]!.text && x < y)
  const push = (v: number): void => {
    heap.push(v)
    let c = heap.length - 1
    while (c > 0) {
      const p = (c - 1) >> 1
      if (!less(heap[c]!, heap[p]!)) break
      ;[heap[c], heap[p]] = [heap[p]!, heap[c]!]
      c = p
    }
  }
  const pop = (): number => {
    const top = heap[0]!
    const last = heap.pop()!
    if (heap.length) {
      heap[0] = last
      let p = 0
      for (;;) {
        const l = 2 * p + 1, r = l + 1
        let m = p
        if (l < heap.length && less(heap[l]!, heap[m]!)) m = l
        if (r < heap.length && less(heap[r]!, heap[m]!)) m = r
        if (m === p) break
        ;[heap[p], heap[m]] = [heap[m]!, heap[p]!]
        p = m
      }
    }
    return top
  }
  for (let k = 0; k < n; k++) if (indeg[k] === 0) push(k)
  const res: string[] = []
  while (heap.length) {
    const k = pop()
    res.push(seg[k]!.text)
    for (const s of succ[k]!) if (--indeg[s]! === 0) push(s)
  }
  return res
}
