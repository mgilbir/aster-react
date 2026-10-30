/** Seeded generator of marks for the bounds differential: arcs, trails, lines, areas (every interpolate), paths and symbols. */
import { rng } from './text-cases.js'

type Spec = Record<string, unknown>
export const INTERPOLATES = ['basis', 'basis-open', 'basis-closed', 'bundle', 'cardinal', 'cardinal-open', 'cardinal-closed', 'catmull-rom', 'catmull-rom-open', 'catmull-rom-closed', 'linear', 'linear-closed', 'natural', 'step', 'step-before', 'step-after']
export const MARK_KINDS = ['arc', 'trail', 'line', 'area', 'path', 'symbol'] as const
export type MarkKind = (typeof MARK_KINDS)[number]

export function markCase(seed: number, kind?: MarkKind): { spec: Spec; kind: MarkKind } {
  const r = rng(seed * 7919 + 13)
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!
  const maybe = (p: number): boolean => r() < p
  const num = (lo: number, hi: number): number => lo + r() * (hi - lo)
  const k: MarkKind = kind ?? pick(MARK_KINDS)
  const n = k === 'arc' || k === 'symbol' || k === 'path' ? 1 + Math.floor(r() * 4) : 3 + Math.floor(r() * 9)
  const values = Array.from({ length: n }, (_, i) => ({
    i, x: Math.round(num(5, 230) * 100) / 100, y: Math.round(num(5, 130) * 100) / 100, s: Math.round(num(1, 14) * 10) / 10, keep: r() > 0.2,
    a0: Math.round(num(0, 3) * 1000) / 1000, a1: Math.round(num(2, 6.6) * 1000) / 1000,
  }))
  const update: Record<string, unknown> = {}
  const v = (x: unknown): { value: unknown } => ({ value: x })
  const set = (key: string, val: unknown): void => { update[key] = v(val) }
  const mark: Record<string, unknown> = { type: k, from: { data: 't' }, encode: { update } }
  if (k === 'arc') {
    update.x = { field: 'x' }; update.y = { field: 'y' }
    update.startAngle = { field: 'a0' }; update.endAngle = { field: 'a1' }
    set('outerRadius', pick([20, 35, 50, 80]))
    if (maybe(0.7)) set('innerRadius', pick([0, 8, 15, 30]))
    if (maybe(0.55)) set('cornerRadius', pick([0, 2, 5, 12, 40]))
    if (maybe(0.55)) set('padAngle', pick([0, 0.02, 0.1, 0.4]))
    if (maybe(0.3)) set('angle', pick([30, -45, 90, 200]))
    if (maybe(0.3)) set('padRadius', pick([0, 10, 40]))
    update.fill = v('steelblue')
  } else if (k === 'trail') {
    update.x = { field: 'x' }; update.y = { field: 'y' }
    update.size = { field: 's' }
    if (maybe(0.5)) update.defined = { field: 'keep' }
    update.fill = v('tomato')
  } else if (k === 'line' || k === 'area') {
    update.x = { field: 'x' }; update.y = { field: 'y' }
    if (k === 'area') { update.y2 = v(pick([0, 140, 70])); if (maybe(0.3)) { delete update.y2; update.x2 = v(pick([0, 100])) ; update.y = { field: 'y' } } }
    set('interpolate', pick(k === 'area' ? INTERPOLATES.filter((i) => i !== 'bundle') : INTERPOLATES))
    if (maybe(0.4)) set('tension', pick([0, 0.3, 0.5, 0.9, 1]))
    if (maybe(0.3) && k === 'area') set('orient', pick(['horizontal', 'vertical']))
    if (maybe(0.4)) update.defined = { field: 'keep' }
    update[k === 'line' ? 'stroke' : 'fill'] = v(pick(['green', '#c60']))
    if (k === 'area' && maybe(0.4)) update.stroke = v('#222')
  } else if (k === 'path') {
    update.x = { field: 'x' }; update.y = { field: 'y' }
    const paths = [null, 'M0,0L20,10L-5,25Z', 'M0,0C10,-30 40,-30 50,0S60,30 70,10', '', 'M0,0Q30,40 60,0T120,0', 'm0,0l20,10h-30v15z', 'M0,0c10,-30 40,-30 50,0s10,30 20,10',
      // arcs: circular, elliptical, rotated, every large/sweep pair, a radius too small for the chord, zero radii, an arc that ends where it starts, relative
      'M0,0A20,20 0 0,1 40,0', 'M0,0A20,20 0 1,1 30,5', 'M0,0A20,10 0 0,1 30,5', 'M0,0A20,10 30 1,1 30,5', 'M0,0A20,10 30 0,0 30,5',
      'M10,10A30,10 45 1,0 50,30', 'M0,0A5,5 0 0,0 60,20', 'M0,0A0,10 0 0,1 30,5L5,5', 'M0,0A10,0 0 1,0 30,5', 'M5,5A10,10 0 0,1 5,5L9,9',
      'M0,0a20,20 0 0,1 40,0a15,8 -20 1,0 -10,25', 'M0,0A12,12 90 1,1 24,0A12,12 0 1,1 0,0Z']
    const d = maybe(0.35) ? null : pick(paths.slice(1))
    update.path = v(d)
    // (the SVG canonicalizer does not take an arc under a stretch)
    if (!d?.match(/[Aa]/) && maybe(0.3)) set('scaleX', pick([0.5, 2, -1]))
    if (!d?.match(/[Aa]/) && maybe(0.3)) set('scaleY', pick([0.5, 2]))
    if (maybe(0.3)) set('angle', pick([20, 90]))
    update.fill = v('purple')
  } else {
    update.x = { field: 'x' }; update.y = { field: 'y' }
    set('size', pick([30, 100, 400, 1500]))
    set('shape', pick(['circle', 'square', 'cross', 'diamond', 'triangle-up', 'triangle-down', 'triangle-left', 'triangle-right', 'stroke', 'arrow', 'wedge', 'M0,0L1,2L-1,2Z']))
    if (maybe(0.3)) set('angle', pick([15, 90, -60]))
    update.fill = v('teal')
  }
  // strokes and caps: bounds grow by the stroke (and the miter, the cap)
  if (k !== 'area' && (k === 'line' || maybe(0.55)) ) {
    update.stroke ??= v(pick(['#111', 'red']))
  }
  if (update.stroke) {
    if (maybe(0.7)) set('strokeWidth', pick([0, 0.5, 1, 3, 8, 15]))
    if (maybe(0.4)) set('strokeCap', pick(['butt', 'round', 'square']))
    if (maybe(0.4)) set('strokeJoin', pick(['miter', 'round', 'bevel']))
    if (maybe(0.3)) set('strokeMiterLimit', pick([1, 2, 10]))
    if (maybe(0.15)) set('opacity', pick([0, 0.5]))
    if (maybe(0.15)) set('strokeOpacity', pick([0, 0.5]))
  }
  // inside a group (with a frame and a stroke of its own) the mark's bounds are the group's to carry
  const inGroup = maybe(0.3)
  const marks = inGroup
    ? [{ type: 'group', encode: { update: { x: v(pick([0, 12])), y: v(pick([0, 9])), width: v(pick([120, 200])), height: v(pick([80, 110])), ...(maybe(0.6) ? { stroke: v('#444'), strokeWidth: v(pick([1, 4])) } : {}), ...(maybe(0.3) ? { clip: v(true) } : {}) } }, marks: [mark] }]
    : [mark]
  return { kind: k, spec: { width: 240, height: 140, padding: 5, autosize: 'pad', data: [{ name: 't', values }], marks } as Spec }
}
