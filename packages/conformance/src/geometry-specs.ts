/**
 * Generated Vega specs and hand-built items for the geometry differentials against real vega (`geometry-vs-vega.test.ts`, and the
 * pick gate `scripts/browser-geometry.mts`): every mark type (rect, symbol, arc, area, line, trail, rule, text, path, image) and
 * group marks nested two deep, each channel a per-row list of values in which, at a rate drawn per spec, the classes no scale writes
 * turn up -- NaN, the infinities, -0, null, a missing field, a numeric string ("30"), a non-numeric one ("30px"), huge (1e308) and
 * negative numbers, a tiny one --, with every kind of paint (filled, stroked, both, `transparent`, neither, a NaN stroke width),
 * caps, joins and miter limits, rounded corners, every curve, custom symbol shapes, path data that goes on after a close without a
 * move, H / V / A / S / T after a close, arcs too small for their chord, elliptical arcs, relative curves, mark `clip`, group item
 * `clip`, `strokeForeground`, marks that are not interactive. A row's values are read through an expression (`[...][datum.i]`), so
 * vega and Aster both encode exactly the value written, as their encoders pass it on.
 *
 * Each mark has a unique name (`m3`, `g4`): an item is the same item on both sides by its place, the names of the marks and the
 * indices of the group items above it and its own index (`/g0[1]/m2[3]`), never by the order it is first seen in.
 */

type Spec = Record<string, unknown>

/** A seeded generator (the same sequence on every platform). */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x9e3779b9) >>> 0
    let t = a ^ (a >>> 16)
    t = Math.imul(t, 0x21f0aaad)
    t ^= t >>> 15
    t = Math.imul(t, 0x735a2d97)
    t ^= t >>> 15
    return (t >>> 0) / 4294967296
  }
}

export const CURVES = ['linear', 'linear-closed', 'basis', 'basis-closed', 'basis-open', 'cardinal', 'cardinal-closed', 'cardinal-open', 'catmull-rom',
  'catmull-rom-closed', 'catmull-rom-open', 'monotone', 'natural', 'step', 'step-after', 'step-before']
/** A curve a line can take and an area cannot (vega throws drawing an area with it). */
export const LINE_ONLY_CURVES = ['bundle']
export const SHAPES = ['circle', 'square', 'cross', 'diamond', 'triangle-up', 'triangle-down', 'triangle-right', 'triangle-left', 'stroke', 'arrow', 'wedge',
  'triangle', 'M0,0L1,1L-1,1Z', 'M-1,-1h2v2h-2z', 'M -1 0 A 1 1 0 1 1 1 0 A 1 1 0 1 1 -1 0 Z', 'M0,-1C1,-1 1,1 0,1S-1,-1 0,-1Z', 'M-1,0Q0,-2 1,0T-1,0z',
  'm0 0 l .5 .5 l -1 0 z']
export const PATHS = ['M0,0L10,10L0,20Z', 'M5,5h10v10h-10z', 'M0,0 A 10 10 0 0 1 20 0 L 20 20 Z', 'M0,0C5,-10 15,-10 20,0S35,10 40,0', 'M0 0 Q10 10 20 0 T40 0',
  'm1,1 l5,0 0,5 -5,0 z', '', 'M0,0',
  // a subpath that goes on after Z without a moveto; H / V / A / S / T after Z; arcs whose radii are too small for their chord;
  // elliptical and turned arcs; relative curves
  'M10,10L40,10L40,40ZL0,40L0,10Z', 'M0,0L20,0L20,20ZH10V10Z', 'M0,0L20,0L20,20ZA5,5,0,0,1,10,10Z', 'M0,0A5,5,0,0,1,40,0Z', 'M0,0A30,15,0,0,1,40,0L20,20Z',
  'M0,0A20,10,30,1,0,30,20Z', 'M0,0c5,-10 15,-10 20,0s15,10 20,0', 'M0,0q10,10 20,0t20,0', 'M0,0a10,5,0,1,1,20,0z', 'M0,0L30,0L30,30ZS40,40 50,30',
  'M0,0L30,0L30,30ZT50,30']
const ALIGN = ['left', 'center', 'right', undefined]
const BASELINE = ['top', 'middle', 'bottom', 'alphabetic', 'line-top', 'line-bottom', undefined]
/** A 1x1 image (its own size never decides a box: every image here is sized, or measures 0 before it loads, on both sides). */
export const IMAGE_URL = 'data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw=='
export const MARK_TYPES = ['rect', 'symbol', 'arc', 'area', 'line', 'trail', 'rule', 'text', 'path', 'image'] as const

export interface GeometrySpec {
  spec: Spec
  /** Every mark's name, in the order the spec declares them (depth first). */
  names: string[]
}

/** A random spec (see the module comment). */
export function genGeometrySpec(seed: number): GeometrySpec {
  const R = rng(seed)
  const int = (n: number): number => Math.floor(R() * n)
  const pick = <T,>(xs: readonly T[]): T => xs[int(xs.length)]!
  const chance = (p: number): boolean => R() < p
  const num = (a: number, b: number): number => a + (b - a) * R()
  const wildRate = pick([0, 0.05, 0.15, 0.4])
  /** One row's value as expression text: mostly an ordinary number, now and then one of the classes no scale writes. */
  const wild = (lo: number, hi: number): string => {
    if (!chance(wildRate)) return String(Math.round(num(lo, hi) * 100) / 100)
    return pick(['NaN', '1/0', '-1/0', '-0', 'null', 'datum.missing', `'${Math.round(num(lo, hi))}'`, `'${Math.round(num(lo, hi))}px'`, '1e308', '-1e15',
      String(-Math.abs(num(lo, hi))), '1e-7', '0'])
  }
  const lit = (v: unknown): string => (v === undefined ? 'datum.missing' : JSON.stringify(v))
  const names: string[] = []
  let markNo = 0
  const rows = (n: number): Spec[] => Array.from({ length: n }, (_, i) => ({ i, id: `r${i}` }))
  /** One channel: a constant, or a list read by the row's index. */
  const chan = (vals: string[]): Spec => (vals.every((v) => v === vals[0]) && chance(0.5) ? { signal: vals[0]! } : { signal: `[${vals.join(',')}][datum.i]` })
  const perRow = (n: number, f: () => string): Spec => chan(Array.from({ length: Math.max(1, n) }, f))
  const paint = (n: number, e: Spec): void => {
    if (chance(0.8)) e.fill = perRow(n, () => lit(pick(['#4c78a8', 'red', 'rgba(0,0,0,0.5)', 'transparent', null, ''])))
    if (chance(0.6)) e.stroke = perRow(n, () => lit(pick(['#000', 'orange', 'transparent', null])))
    if (chance(0.5)) e.strokeWidth = perRow(n, () => pick(['0', '0.5', '1', '2', '5', '12', wild(0, 6)]))
    if (chance(0.2)) e.opacity = perRow(n, () => pick(['0', '0.5', '1']))
    if (chance(0.15)) e.strokeOpacity = perRow(n, () => pick(['0', '0.5', '1']))
    if (chance(0.15)) e.fillOpacity = perRow(n, () => pick(['0', '0.5', '1']))
    if (chance(0.15)) e.strokeCap = { value: pick(['butt', 'round', 'square']) }
    if (chance(0.15)) e.strokeJoin = { value: pick(['miter', 'round', 'bevel']) }
    if (chance(0.1)) e.strokeMiterLimit = { value: pick([1, 2, 10]) }
    if (chance(0.1)) e.strokeDash = { value: [4, 2] }
  }
  const data: Spec[] = []
  const W = 300
  const H = 200
  const leaf = (type: string): Spec => {
    const name = `m${markNo++}`
    names.push(name)
    const n = type === 'symbol' && chance(0.1) ? 60 + int(200) : int(12) + (chance(0.9) ? 1 : 0)
    const e: Spec = {}
    switch (type) {
      case 'rect':
        e.x = perRow(n, () => wild(-20, W))
        e.y = perRow(n, () => wild(-20, H))
        if (chance(0.7)) { e.width = perRow(n, () => wild(-10, 80)); e.height = perRow(n, () => wild(-10, 80)) } else { e.x2 = perRow(n, () => wild(-20, W)); e.y2 = perRow(n, () => wild(-20, H)) }
        if (chance(0.25)) e.cornerRadius = perRow(n, () => wild(0, 15))
        if (chance(0.1)) e.cornerRadiusTopLeft = perRow(n, () => wild(0, 15))
        if (chance(0.1)) e.cornerRadiusBottomRight = perRow(n, () => wild(0, 15))
        break
      case 'symbol':
        e.x = perRow(n, () => wild(-20, W))
        e.y = perRow(n, () => wild(-20, H))
        if (chance(0.8)) e.size = perRow(n, () => pick([wild(0, 600), '64', '0', '-4']))
        if (chance(0.7)) e.shape = perRow(n, () => lit(pick(SHAPES)))
        if (chance(0.2)) e.angle = perRow(n, () => wild(-90, 90))
        break
      case 'arc':
        e.x = perRow(n, () => wild(0, W))
        e.y = perRow(n, () => wild(0, H))
        if (chance(0.9)) e.outerRadius = perRow(n, () => wild(0, 70))
        if (chance(0.6)) e.innerRadius = perRow(n, () => wild(0, 40))
        if (chance(0.9)) e.startAngle = perRow(n, () => wild(-1, 7))
        if (chance(0.9)) e.endAngle = perRow(n, () => wild(-1, 7))
        if (chance(0.3)) e.cornerRadius = perRow(n, () => wild(0, 12))
        if (chance(0.3)) e.padAngle = perRow(n, () => wild(0, 0.2))
        if (chance(0.15)) e.padRadius = perRow(n, () => wild(0, 60))
        // (channels other marks read: an arc's own bounds and drawing do not)
        if (chance(0.1)) e.angle = perRow(n, () => wild(-90, 90))
        if (chance(0.1)) e.text = perRow(n, () => lit('t'))
        if (chance(0.05)) e.radius = perRow(n, () => wild(0, 50))
        break
      case 'area':
      case 'line':
      case 'trail': {
        const horizontal = type === 'area' && chance(0.3)
        e.x = perRow(n, () => (chance(0.9) ? String(Math.round(num(0, W))) : wild(0, W)))
        e.y = perRow(n, () => wild(0, H))
        if (type === 'area') {
          if (horizontal) { e.x2 = perRow(n, () => wild(0, W)); e.orient = { value: 'horizontal' } } else e.y2 = perRow(n, () => wild(0, H))
        }
        if (type === 'trail') e.size = perRow(n, () => wild(0, 14))
        if (type !== 'trail') {
          if (chance(0.7)) e.interpolate = { value: pick(type === 'line' ? [...CURVES, ...LINE_ONLY_CURVES] : CURVES) }
          if (chance(0.2)) e.tension = { value: pick([0, 0.3, 0.8]) }
        }
        if (chance(0.2)) e.defined = perRow(n, () => (chance(0.15) ? 'false' : 'true'))
        break
      }
      case 'rule':
        e.x = perRow(n, () => wild(0, W))
        e.y = perRow(n, () => wild(0, H))
        if (chance(0.85)) e.x2 = perRow(n, () => wild(0, W))
        if (chance(0.85)) e.y2 = perRow(n, () => wild(0, H))
        break
      case 'text': {
        e.x = perRow(n, () => wild(0, W))
        e.y = perRow(n, () => wild(0, H))
        const lineBreak = chance(0.1)
        // (vega splits a text by `lineBreak` with String's own method: a number there throws in vega, an oracle crash not reproduced)
        e.text = perRow(n, () => lit(pick(lineBreak ? ['a', 'hello', 'two\nlines'] : ['a', 'hello', 'Wide label', '', 42, null, 'two\nlines'])))
        if (chance(0.3)) e.angle = perRow(n, () => wild(-90, 90))
        if (chance(0.4)) e.align = { value: pick(ALIGN) }
        if (chance(0.4)) e.baseline = { value: pick(BASELINE) }
        if (chance(0.2)) e.dx = perRow(n, () => wild(-10, 10))
        if (chance(0.2)) e.dy = perRow(n, () => wild(-10, 10))
        if (chance(0.3)) e.fontSize = perRow(n, () => wild(4, 24))
        if (chance(0.15)) { e.radius = perRow(n, () => wild(0, 40)); e.theta = perRow(n, () => wild(0, 6)) }
        if (chance(0.1)) e.limit = perRow(n, () => wild(0, 60))
        if (lineBreak) e.lineBreak = { value: '\n' }
        break
      }
      case 'path':
        e.x = perRow(n, () => wild(-20, W))
        e.y = perRow(n, () => wild(-20, H))
        e.path = perRow(n, () => lit(pick(PATHS)))
        if (chance(0.2)) e.scaleX = perRow(n, () => wild(-2, 3))
        if (chance(0.2)) e.scaleY = perRow(n, () => wild(-2, 3))
        if (chance(0.2)) e.angle = perRow(n, () => wild(-90, 90))
        break
      case 'image':
        e.x = perRow(n, () => wild(0, W))
        e.y = perRow(n, () => wild(0, H))
        e.url = { value: IMAGE_URL }
        if (chance(0.8)) e.width = perRow(n, () => wild(-5, 60))
        if (chance(0.8)) e.height = perRow(n, () => wild(-5, 60))
        if (chance(0.2)) e.aspect = { value: false }
        if (chance(0.3)) e.align = { value: pick(ALIGN) }
        if (chance(0.3)) e.baseline = { value: pick(['top', 'middle', 'bottom']) }
        break
    }
    if (type !== 'image') paint(n, e)
    else if (chance(0.2)) e.stroke = { value: 'red' }
    const mark: Spec = { type, name, from: { data: `d_${name}` }, encode: { update: e } }
    if (chance(0.15)) mark.clip = true
    if (chance(0.1)) mark.interactive = false
    data.push({ name: `d_${name}`, values: rows(n) })
    return mark
  }
  const marks = (count: number, depth: number): Spec[] => {
    const out: Spec[] = []
    for (let k = 0; k < count; k++) {
      if (depth < 2 && chance(0.25)) {
        const name = `g${markNo++}`
        names.push(name)
        const n = 1 + int(3)
        data.push({ name: `d_${name}`, values: rows(n) })
        const e: Spec = {
          x: perRow(n, () => wild(-30, 150)),
          y: perRow(n, () => wild(-30, 100)),
          width: perRow(n, () => pick(['0', '60', '120', wild(0, 150)])),
          height: perRow(n, () => pick(['0', '50', '90', wild(0, 120)])),
        }
        if (chance(0.5)) e.fill = { value: pick(['#eee', 'transparent', null]) }
        if (chance(0.4)) e.stroke = { value: '#888' }
        if (chance(0.3)) e.strokeWidth = perRow(n, () => wild(0, 6))
        if (chance(0.25)) e.clip = perRow(n, () => pick(['true', 'false']))
        if (chance(0.15)) e.cornerRadius = { value: 5 }
        if (chance(0.15)) e.strokeForeground = { value: true }
        const g: Spec = { type: 'group', name, from: { data: `d_${name}` }, encode: { update: e }, marks: marks(1 + int(2), depth + 1) }
        if (chance(0.1)) g.clip = true
        if (chance(0.08)) g.interactive = false
        out.push(g)
      } else out.push(leaf(pick(MARK_TYPES)))
    }
    return out
  }
  const top = marks(1 + int(4), 0)
  const spec: Spec = {
    width: W, height: H, padding: pick([0, 5, { left: 7, top: 3, right: 4, bottom: 9 }]),
    autosize: pick(['pad', 'none', 'pad']),
    data, marks: top,
  }
  return { spec, names }
}

/** One value of a channel for a hand-built item: mostly an ordinary number, at `rate` one of the classes no scale writes. */
export function wildValue(R: () => number, lo: number, hi: number, rate = 0.3): unknown {
  const v = lo + (hi - lo) * R()
  if (R() >= rate) return Math.round(v * 100) / 100
  const classes = [NaN, Infinity, -Infinity, -0, null, undefined, String(Math.round(v)), `${Math.round(v)}px`, 1e308, -1e15, -Math.abs(v), 1e-7, 0, true, '']
  return classes[Math.floor(R() * classes.length)]
}

/**
 * A hand-built item of a mark of `type`, every channel (its own type's and some another type reads) from the wild value classes,
 * missing now and then: what reaches the bounds without an encoder in front of it.
 */
export function genItem(R: () => number, type: string): Record<string, unknown> {
  const w = (lo: number, hi: number): unknown => wildValue(R, lo, hi)
  const maybe = (p: number, f: () => unknown): unknown => (R() < p ? f() : undefined)
  const oneOf = <T,>(xs: readonly T[]): T => xs[Math.floor(R() * xs.length)]!
  const it: Record<string, unknown> = {}
  const set = (k: string, v: unknown): void => { if (v !== undefined || R() < 0.3) it[k] = v }
  set('x', w(-20, 300))
  set('y', w(-20, 200))
  set('stroke', maybe(0.6, () => oneOf(['#000', 'transparent', null, ''])))
  set('strokeWidth', maybe(0.5, () => w(0, 8)))
  set('opacity', maybe(0.1, () => oneOf([0, 0.5, 1, '0'])))
  set('strokeOpacity', maybe(0.1, () => oneOf([0, 0.5, 1])))
  set('strokeCap', maybe(0.2, () => oneOf(['butt', 'round', 'square'])))
  set('strokeJoin', maybe(0.2, () => oneOf(['miter', 'round', 'bevel'])))
  set('strokeMiterLimit', maybe(0.1, () => w(0, 10)))
  switch (type) {
    case 'rect':
      set('width', maybe(0.9, () => w(-10, 80))); set('height', maybe(0.9, () => w(-10, 80)))
      set('x2', maybe(0.1, () => w(0, 300))); set('y2', maybe(0.1, () => w(0, 300))); set('cornerRadius', maybe(0.2, () => w(0, 10)))
      break
    case 'symbol':
      set('size', maybe(0.8, () => w(-10, 600))); set('shape', maybe(0.8, () => oneOf([...SHAPES, undefined, null, '']))); set('angle', maybe(0.2, () => w(-90, 90)))
      break
    case 'arc':
      set('outerRadius', maybe(0.9, () => w(0, 70))); set('innerRadius', maybe(0.6, () => w(0, 40))); set('startAngle', maybe(0.9, () => w(-1, 7)))
      set('endAngle', maybe(0.9, () => w(-1, 7))); set('cornerRadius', maybe(0.3, () => w(0, 12))); set('padAngle', maybe(0.3, () => w(0, 0.2)))
      set('padRadius', maybe(0.1, () => w(0, 60))); set('angle', maybe(0.1, () => w(-90, 90))); set('text', maybe(0.1, () => 't')); set('radius', maybe(0.05, () => w(0, 50)))
      break
    case 'rule':
      set('x2', maybe(0.85, () => w(0, 300))); set('y2', maybe(0.85, () => w(0, 200))); set('text', maybe(0.05, () => 't')); set('width', maybe(0.05, () => w(0, 50)))
      break
    case 'text':
      set('text', maybe(0.95, () => oneOf(['a', 'hello', 'Wide label', '', 42, null, ['two', 'lines'], 0]))); set('angle', maybe(0.3, () => w(-90, 90)))
      set('align', maybe(0.4, () => oneOf(['left', 'center', 'right', 'nonsense']))); set('baseline', maybe(0.4, () => oneOf(['top', 'middle', 'bottom', 'alphabetic', 'line-top', 'line-bottom'])))
      set('dx', maybe(0.2, () => w(-10, 10))); set('dy', maybe(0.2, () => w(-10, 10))); set('fontSize', maybe(0.3, () => w(-4, 24)))
      set('radius', maybe(0.15, () => w(-10, 40))); set('theta', maybe(0.15, () => w(0, 6))); set('lineHeight', maybe(0.1, () => w(0, 20)))
      set('limit', maybe(0.1, () => w(0, 60))); set('outerRadius', maybe(0.05, () => w(0, 50)))
      break
    case 'path':
      set('path', maybe(0.95, () => oneOf([...PATHS, undefined, null]))); set('scaleX', maybe(0.2, () => w(-2, 3))); set('scaleY', maybe(0.2, () => w(-2, 3)))
      set('angle', maybe(0.2, () => w(-90, 90)))
      break
    case 'image':
      set('width', maybe(0.8, () => w(-5, 60))); set('height', maybe(0.8, () => w(-5, 60))); set('aspect', maybe(0.2, () => false))
      set('align', maybe(0.3, () => oneOf(['left', 'center', 'right']))); set('baseline', maybe(0.3, () => oneOf(['top', 'middle', 'bottom'])))
      it.url = 'x.png'
      break
  }
  return it
}
