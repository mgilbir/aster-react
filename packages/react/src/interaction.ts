import type { ChartInfo, VgSpec } from '@aster/core'

export interface SelectionInterval {
  x?: [number, number]
  y?: [number, number]
}

/** A 2-D data-space view: the visible domain of each continuous positional scale. */
export interface ViewDomain {
  x?: [number, number]
  y?: [number, number]
}

/**
 * Unified declarative selection value (R10.2). One shape covers interval
 * brushes (SVG + canvas) and point/click selections, so hosts can keep a single
 * `selection` state and round-trip it through controlled props.
 */
export type SelectValue =
  | { type: 'interval'; interval: SelectionInterval }
  | { type: 'point'; datum: Record<string, unknown> | null }

export interface PixelPoint {
  x: number
  y: number
}

/**
 * Names of the scales that drive the horizontal and vertical positions. The
 * `x`/`y` keys of `ViewDomain`, `SelectionInterval` and the `brush` prop always
 * mean "the horizontal / vertical positional scale", whatever it is called.
 */
export interface PositionalScales {
  x?: string
  y?: string
}

/** Fallback when a spec gives no positional evidence: scales literally named `x`/`y`. */
export const DEFAULT_POSITIONAL_SCALES: PositionalScales = { x: 'x', y: 'y' }

const CONTINUOUS_SCALE_TYPES = new Set(['linear', 'log', 'pow', 'sqrt', 'symlog', 'time', 'utc'])

const X_CHANNELS = ['x', 'x2', 'xc']
const Y_CHANNELS = ['y', 'y2', 'yc']

function scaleNameOf(ref: unknown, out: string[]): void {
  if (Array.isArray(ref)) {
    for (const r of ref) scaleNameOf(r, out)
    return
  }
  if (ref != null && typeof ref === 'object') {
    const scale = (ref as { scale?: unknown }).scale
    if (typeof scale === 'string') out.push(scale)
  }
}

/**
 * Derive the horizontal/vertical positional scales from a Vega spec, so
 * pan/zoom, brushing and the keyboard contract work for any scale names
 * (`xscale`/`yscale` as in the Vega tutorials, VL-compiled `x`/`y`, ...).
 *
 * Rule, applied to the root scope and every nested group scope:
 * 1. candidates for an orientation, in order: scales of axes with orient
 *    `bottom`/`top` (x) or `left`/`right` (y), then scales referenced by the
 *    mark channels `x`/`x2`/`xc` (x) or `y`/`y2`/`yc` (y) in any encode set;
 * 2. the first candidate whose definition is a continuous (invertible) type
 *    (`linear`, `log`, `pow`, `sqrt`, `symlog`, `time`, `utc`) wins;
 *    band/point/ordinal scales have no pannable domain and are skipped;
 * 3. an orientation with no such candidate falls back to a continuous scale
 *    literally named `x` / `y`, else it is left unset (no pan/zoom on it).
 *
 * When one orientation has several continuous scales (dual axes) only the first
 * is driven; `ViewDomain` carries a single domain per orientation. Only scales
 * declared at the root scope are interactive (they are the ones the evaluated
 * scene exposes).
 */
export function positionalScales(spec: VgSpec): PositionalScales {
  const defs = new Map<string, string>()
  const rootScales = (spec as { scales?: unknown }).scales
  if (Array.isArray(rootScales)) {
    for (const d of rootScales) {
      if (d && typeof d === 'object' && typeof (d as { name?: unknown }).name === 'string') {
        const t = (d as { type?: unknown }).type
        defs.set((d as { name: string }).name, typeof t === 'string' ? t : 'linear')
      }
    }
  }
  const axisX: string[] = []
  const axisY: string[] = []
  const markX: string[] = []
  const markY: string[] = []
  const seen = new Set<unknown>()
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object' || seen.has(node)) return
    seen.add(node)
    const n = node as { axes?: unknown; marks?: unknown; encode?: unknown }
    if (Array.isArray(n.axes)) {
      for (const a of n.axes) {
        if (!a || typeof a !== 'object') continue
        const { scale, orient } = a as { scale?: unknown; orient?: unknown }
        if (typeof scale !== 'string') continue
        if (orient === 'bottom' || orient === 'top') axisX.push(scale)
        else if (orient === 'left' || orient === 'right') axisY.push(scale)
      }
    }
    if (n.encode && typeof n.encode === 'object') {
      for (const set of Object.values(n.encode as Record<string, unknown>)) {
        if (!set || typeof set !== 'object') continue
        for (const ch of X_CHANNELS) scaleNameOf((set as Record<string, unknown>)[ch], markX)
        for (const ch of Y_CHANNELS) scaleNameOf((set as Record<string, unknown>)[ch], markY)
      }
    }
    if (Array.isArray(n.marks)) for (const m of n.marks) walk(m)
  }
  walk(spec)
  const pick = (candidates: string[], fallback: string): string | undefined => {
    for (const name of candidates) {
      const type = defs.get(name)
      if (type != null && CONTINUOUS_SCALE_TYPES.has(type)) return name
    }
    const type = defs.get(fallback)
    return type != null && CONTINUOUS_SCALE_TYPES.has(type) ? fallback : undefined
  }
  const out: PositionalScales = {}
  const x = pick([...axisX, ...markX], 'x')
  const y = pick([...axisY, ...markY], 'y')
  if (x != null) out.x = x
  if (y != null) out.y = y
  return out
}

/** Convert an SVG-local pixel drag rect into a data-space interval using the chart scales + padding. */
export function dragToDataInterval(
  start: PixelPoint,
  end: PixelPoint,
  info: ChartInfo,
  names: PositionalScales = DEFAULT_POSITIONAL_SCALES,
): SelectionInterval {
  const xScale = names.x != null ? info.scales.get(names.x) : undefined
  const yScale = names.y != null ? info.scales.get(names.y) : undefined
  const out: SelectionInterval = {}
  const xInv = (xScale as { invert?: (v: number) => number } | undefined)?.invert
  const yInv = (yScale as { invert?: (v: number) => number } | undefined)?.invert

  if (xInv) {
    const a = xInv(start.x - info.padding.left)
    const b = xInv(end.x - info.padding.left)
    if (isFiniteNumber(a) && isFiniteNumber(b)) out.x = [Math.min(a, b), Math.max(a, b)]
  }
  if (yInv) {
    const a = yInv(start.y - info.padding.top)
    const b = yInv(end.y - info.padding.top)
    if (isFiniteNumber(a) && isFiniteNumber(b)) out.y = [Math.min(a, b), Math.max(a, b)]
  }
  return out
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/** Convert a data-space selection to pixel coordinates within the SVG. */
export function selectionToPixels(
  selection: SelectionInterval,
  info: ChartInfo,
  names: PositionalScales = DEFAULT_POSITIONAL_SCALES,
): { x: number; y: number; width: number; height: number } {
  const xScale = names.x != null ? info.scales.get(names.x) : undefined
  const yScale = names.y != null ? info.scales.get(names.y) : undefined

  // Helper to call scale(value) for continuous scales
  const scaleVal = (s: unknown, v: number): number => {
    if (s == null) return NaN
    return (s as { (arg: number): number })(v)
  }

  let x = info.padding.left
  let y = info.padding.top
  let width = info.width
  let height = info.height

  if (selection.x && xScale) {
    const [x0, x1] = selection.x
    const px0 = scaleVal(xScale, x0)
    const px1 = scaleVal(xScale, x1)
    x = Math.min(px0, px1) + info.padding.left
    width = Math.abs(px1 - px0)
  }

  if (selection.y && yScale) {
    const [y0, y1] = selection.y
    const py0 = scaleVal(yScale, y0)
    const py1 = scaleVal(yScale, y1)
    y = Math.min(py0, py1) + info.padding.top
    height = Math.abs(py1 - py0)
  }

  return { x, y, width, height }
}

export function selectValueToInterval(value: SelectValue | null | undefined): SelectionInterval | null {
  return value?.type === 'interval' ? value.interval : null
}

export function selectValueToDatum(value: SelectValue | null | undefined): Record<string, unknown> | null {
  return value?.type === 'point' ? value.datum : null
}

/** Read a continuous scale's domain, or null when it has no invertible domain. */
export function domainOf(scale: unknown): [number, number] | null {
  const s = scale as { domain?: () => unknown[]; invert?: (v: number) => unknown } | undefined
  if (!s?.domain || typeof s.invert !== 'function') return null
  const d = s.domain()
  if (!Array.isArray(d) || d.length < 2) return null
  const a = Number(d[0])
  const b = Number(d[d.length - 1])
  return Number.isFinite(a) && Number.isFinite(b) ? [a, b] : null
}

function curve(domain: [number, number]): 'linear' | 'log' {
  return domain[0]! > 0 && domain[1]! > 0 ? 'log' : 'linear'
}

/** Scale a domain around an anchor value; factor > 1 zooms in. */
export function zoomDomain(
  domain: [number, number],
  anchor: number,
  factor: number,
  minSpan?: number,
): [number, number] {
  const [d0, d1] = domain
  if (!Number.isFinite(anchor) || !Number.isFinite(factor) || factor <= 0) return domain
  let span = Math.abs(d1 - d0)
  if (span === 0) return domain
  let nextSpan = span / factor
  if (minSpan != null && nextSpan < minSpan) nextSpan = minSpan
  const ratio = nextSpan / span
  let a = anchor - (anchor - d0) * ratio
  let b = anchor + (d1 - anchor) * ratio
  // Keep the domain orientation (y scales commonly run top→bottom).
  if ((d1 - d0) < 0 && b < a) [a, b] = [b, a]
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === b) return domain
  return [a, b]
}

/** Translate a domain by a fraction of its span (positive = data moves right/down). */
export function panDomain(domain: [number, number], fraction: number): [number, number] {
  const span = domain[1] - domain[0]
  const shift = span * fraction
  return [domain[0] + shift, domain[1] + shift]
}

/** Normalize a controlled view against the chart's base domains. */
export function normalizeView(view: ViewDomain | null | undefined, base: ViewDomain): ViewDomain | null {
  if (view == null) return null
  const out: ViewDomain = {}
  if (view.x && isFiniteNumber(view.x[0]) && isFiniteNumber(view.x[1]) && view.x[0] !== view.x[1]) out.x = view.x
  if (view.y && isFiniteNumber(view.y[0]) && isFiniteNumber(view.y[1]) && view.y[0] !== view.y[1]) out.y = view.y
  if (out.x == null && out.y == null) return null
  // A view equal to the base domain is the "not zoomed" state.
  if (out.x && base.x && out.x[0] === base.x[0] && out.x[1] === base.x[1]) delete out.x
  if (out.y && base.y && out.y[0] === base.y[0] && out.y[1] === base.y[1]) delete out.y
  return out.x || out.y ? out : null
}

/**
 * Convert a view to the scale-domain overrides consumed by
 * `RuntimeInput.domainRaw`, keyed by the positional scale names.
 */
export function viewToDomainRaw(
  view: ViewDomain | null | undefined,
  names: PositionalScales = DEFAULT_POSITIONAL_SCALES,
): Record<string, unknown[]> | undefined {
  if (view == null) return undefined
  const out: Record<string, unknown[]> = {}
  if (view.x && names.x != null) out[names.x] = [view.x[0], view.x[1]]
  if (view.y && names.y != null) out[names.y] = [view.y[0], view.y[1]]
  return Object.keys(out).length ? out : undefined
}

const KEY_PAN = 0.08
const KEY_PAN_FAST = 0.25

/**
 * Pure keyboard contract shared by the chart container and the accessible
 * axis sliders: arrows pan, +/- zoom, 0/Home resets. (Escape clearing the
 * selection is handled by `<Chart>` itself.) Returns a new view (or `null` for
 * reset) plus whether the key was handled.
 */
export function keyboardView(
  key: string,
  current: ViewDomain | null,
  base: ViewDomain,
  opts: { fast?: boolean; axis?: 'x' | 'y'; anchor?: number; pan?: boolean; zoom?: boolean } = {},
): { handled: boolean; view?: ViewDomain | null } {
  // `pan: false` disables the arrow keys, `zoom: false` the +/- keys; reset
  // (0/Home) is always available. Both default to enabled.
  const canPan = opts.pan !== false
  const canZoom = opts.zoom !== false
  const isPanKey = key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowUp' || key === 'ArrowDown'
  const isZoomKey = key === '+' || key === '=' || key === '-' || key === '_'
  if ((isPanKey && !canPan) || (isZoomKey && !canZoom)) return { handled: false }
  const axis = opts.axis
  const step = opts.fast ? KEY_PAN_FAST : KEY_PAN
  const get = (a: 'x' | 'y'): [number, number] | undefined =>
    (current?.[a] ?? base[a]) as [number, number] | undefined
  const set = (a: 'x' | 'y', d: [number, number] | undefined): ViewDomain => {
    const out: ViewDomain = { ...(current ?? {}) }
    if (d && base[a]) out[a] = d
    else delete out[a]
    return out
  }
  switch (key) {
    case 'ArrowLeft': {
      if (axis === 'y') return { handled: false }
      const d = get('x')
      return d ? { handled: true, view: set('x', panDomain(d, -step)) } : { handled: false }
    }
    case 'ArrowRight': {
      if (axis === 'y') return { handled: false }
      const d = get('x')
      return d ? { handled: true, view: set('x', panDomain(d, step)) } : { handled: false }
    }
    case 'ArrowUp': {
      if (axis === 'x') return { handled: false }
      const d = get('y')
      return d ? { handled: true, view: set('y', panDomain(d, -step)) } : { handled: false }
    }
    case 'ArrowDown': {
      if (axis === 'x') return { handled: false }
      const d = get('y')
      return d ? { handled: true, view: set('y', panDomain(d, step)) } : { handled: false }
    }
    case '+':
    case '=': {
      const axes: Array<'x' | 'y'> = axis ? [axis] : ['x', 'y']
      let next: ViewDomain = { ...(current ?? {}) }
      for (const a of axes) {
        const d = get(a)
        if (!d) continue
        const anchor = opts.anchor != null && Number.isFinite(opts.anchor) ? opts.anchor : (d[0] + d[1]) / 2
        next = setFor(next, base, a, zoomDomain(d, anchor, 1.5))
      }
      return { handled: true, view: next }
    }
    case '-':
    case '_': {
      const axes: Array<'x' | 'y'> = axis ? [axis] : ['x', 'y']
      let next: ViewDomain = { ...(current ?? {}) }
      for (const a of axes) {
        const d = get(a)
        if (!d) continue
        const anchor = opts.anchor != null && Number.isFinite(opts.anchor) ? opts.anchor : (d[0] + d[1]) / 2
        next = setFor(next, base, a, zoomDomain(d, anchor, 1 / 1.5))
      }
      return { handled: true, view: next }
    }
    case '0':
    case 'Home':
      return { handled: true, view: null }
    default:
      return { handled: false }
  }
}

function setFor(view: ViewDomain, base: ViewDomain, axis: 'x' | 'y', d: [number, number]): ViewDomain {
  const out: ViewDomain = { ...view }
  if (base[axis]) out[axis] = d
  return out
}

/** Interpolate a zoom around a cursor, clamped to the base domain's span. */
export function cursorZoom(
  current: ViewDomain | null,
  base: ViewDomain,
  axis: 'x' | 'y',
  anchorValue: number,
  factor: number,
): ViewDomain {
  const d = (current?.[axis] ?? base[axis]) as [number, number] | undefined
  const out: ViewDomain = { ...(current ?? {}) }
  if (!d) return out
  // Never zoom out past the original extent.
  const baseSpan = Math.abs(base[axis]![1] - base[axis]![0])
  const currentSpan = Math.abs(d[1] - d[0])
  const capped = factor > 1 && currentSpan <= baseSpan / 1e-9 ? factor : factor
  const next = zoomDomain(d, anchorValue, capped, baseSpan / 1000)
  const span = Math.abs(next[1] - next[0])
  out[axis] = span > baseSpan ? base[axis] : next
  return out
}

/** The axis whose scale supports pan/zoom, in priority order. */
export function continuousAxes(
  info: ChartInfo,
  names: PositionalScales = DEFAULT_POSITIONAL_SCALES,
): Array<'x' | 'y'> {
  const out: Array<'x' | 'y'> = []
  if (names.x != null && domainOf(info.scales.get(names.x))) out.push('x')
  if (names.y != null && domainOf(info.scales.get(names.y))) out.push('y')
  return out
}

/** Base (pre-pan/zoom) domain of each positional scale, read from live scales. */
export function baseDomainsOf(info: ChartInfo, names: PositionalScales): ViewDomain {
  const out: ViewDomain = {}
  const x = names.x != null ? domainOf(info.scales.get(names.x)) : null
  const y = names.y != null ? domainOf(info.scales.get(names.y)) : null
  if (x) out.x = x
  if (y) out.y = y
  return out
}

export { curve as domainCurve }

export interface HiddenLegendEntry {
  key: string
  color?: string
  shape?: string
}

/**
 * Remove mark items matched by an off legend entry. Only shape/paint legends
 * are filtered (line/area/trail series need a compiled group-level filter);
 * the scene is cloned lazily so the session's cached scene stays untouched.
 */
export function filterLegendScene(
  scene: import('@aster/core').SceneRoot,
  hidden: Iterable<HiddenLegendEntry>,
): import('@aster/core').SceneRoot {
  const entries = [...hidden]
  if (!entries.length) return scene
  const hideable = new Set(['rect', 'symbol', 'circle', 'arc', 'text', 'path', 'shape', 'geoshape', 'image'])
  const matches = (item: Record<string, unknown>): boolean => entries.some((e) =>
    (e.color != null && (item.fill === e.color || item.stroke === e.color))
    || (e.shape != null && item.shape === e.shape),
  )
  const cloneNode = (node: import('@aster/core').SceneNode): import('@aster/core').SceneNode => {
    const group = node as import('@aster/core').SceneGroup
    if (!Array.isArray(group.items)) return node
    if (group.role === 'mark' && group.marktype && hideable.has(group.marktype)) {
      const kept = group.items.filter((it) => !matches(it as Record<string, unknown>))
      return kept.length === group.items.length ? node : { ...group, items: kept }
    }
    let changed = false
    const items = group.items.map((it) => {
      const next = cloneNode(it)
      if (next !== it) changed = true
      return next
    })
    return changed ? { ...group, items } : node
  }
  let changed = false
  const items = scene.items.map((it) => {
    const next = cloneNode(it)
    if (next !== it) changed = true
    return next
  })
  return changed ? { ...scene, items } : scene
}

/**
 * Signed pixel length of `domain` on `scale` (`scale(d1) - scale(d0)`): its sign
 * tells whether data increases along or against the pixel axis (a y scale with
 * range `[height, 0]` is negative), which a drag-to-pan needs to move the right
 * way. Null when the scale cannot be evaluated.
 */
export function pixelSpanOf(scale: unknown, domain: [number, number]): number | null {
  if (typeof scale !== 'function') return null
  const f = scale as (v: number) => unknown
  const a = Number(f(domain[0]))
  const b = Number(f(domain[1]))
  return Number.isFinite(a) && Number.isFinite(b) && a !== b ? b - a : null
}
