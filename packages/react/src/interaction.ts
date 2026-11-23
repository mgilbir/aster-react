import type { ChartInfo, VgSpec } from '@aster-charts/core'

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
 * Unified declarative selection value. One shape covers interval
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
  // (a value that is not a spec object -- a chart in its error state -- has no positional scales)
  if (spec == null || typeof spec !== 'object') return {}
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

/**
 * Convert a container-local pixel drag (start/end) into a data-space interval
 * using the positional scales and the scene padding. An axis whose scale has no
 * numeric inverse (band/point) is omitted from the result. A time or utc scale's
 * inverse (a `Date`) is its number of milliseconds.
 */
export function dragToDataInterval(
  start: PixelPoint,
  end: PixelPoint,
  info: ChartInfo,
  names: PositionalScales = DEFAULT_POSITIONAL_SCALES,
): SelectionInterval {
  const out: SelectionInterval = {}
  const x = invertSpan(names.x != null ? info.scales.get(names.x) : undefined, start.x - info.padding.left, end.x - info.padding.left)
  const y = invertSpan(names.y != null ? info.scales.get(names.y) : undefined, start.y - info.padding.top, end.y - info.padding.top)
  if (x) out.x = x
  if (y) out.y = y
  return out
}

/** The data values two pixels invert to, as an ascending pair of numbers; null when the scale cannot invert them. */
function invertSpan(scale: unknown, p0: number, p1: number): [number, number] | null {
  const invert = (scale as { invert?: (v: number) => unknown } | undefined)?.invert
  if (typeof invert !== 'function') return null
  const a = Number(invert(p0))
  const b = Number(invert(p1))
  return Number.isFinite(a) && Number.isFinite(b) ? [Math.min(a, b), Math.max(a, b)] : null
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

// ---------------------------------------------------------------------------
// Pan and zoom in a scale's own space
// ---------------------------------------------------------------------------

/**
 * The space a continuous scale draws its domain in, where pixels are linear: `lift` takes a domain value there, `ground` brings
 * it back. Pan and zoom move and stretch the domain in this space, so the data under the pointer stays under it on every scale
 * type, as Vega-Lite's `bind: "scales"` does with vega's `panLog` / `zoomPow` / `panSymlog`... A log scale is its natural
 * logarithm (whatever its base: the ratio of two logarithms does not depend on it), mirrored for a negative domain; a power
 * scale (`pow`, and `sqrt`, the power 0.5) its signed power; a symlog scale its signed `log1p(|x| / constant)`; linear, time and
 * utc scales are linear in their numbers (milliseconds).
 */
interface ScaleSpace {
  lift(v: number): number
  ground(v: number): number
}

const LINEAR_SPACE: ScaleSpace = { lift: (v) => v, ground: (v) => v }

const signedPow = (e: number) => (x: number): number => (x < 0 ? -Math.pow(-x, e) : Math.pow(x, e))

/** The space `scale` draws `domain` in (see `ScaleSpace`). An unknown or absent scale is linear. */
function spaceOf(scale: unknown, domain: readonly number[]): ScaleSpace {
  const s = scale as { type?: unknown; exponent?: () => unknown; constant?: () => unknown } | undefined
  switch (s?.type) {
    case 'log': {
      const sign = Math.sign(domain[0]!)
      return { lift: (x) => Math.log(sign * x), ground: (x) => sign * Math.exp(x) }
    }
    case 'pow':
    case 'sqrt': {
      const e = s.type === 'sqrt' ? 0.5 : numberOr(s.exponent?.(), 1)
      return { lift: signedPow(e), ground: signedPow(1 / e) }
    }
    case 'symlog': {
      const c = numberOr(s.constant?.(), 1)
      return {
        lift: (x) => Math.sign(x) * Math.log1p(Math.abs(x / c)),
        ground: (x) => Math.sign(x) * Math.expm1(Math.abs(x)) * c,
      }
    }
    default:
      return LINEAR_SPACE
  }
}

const numberOr = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) && v !== 0 ? v : fallback)

/** The domain moved by `delta` of its own span, against it (vega's `pan`): `delta > 0` shows lower values. */
function panIn(space: ScaleSpace, domain: readonly [number, number], delta: number): [number, number] {
  const d0 = space.lift(domain[0])
  const d1 = space.lift(domain[1])
  const dd = (d1 - d0) * delta
  return [space.ground(d0 - dd), space.ground(d1 - dd)]
}

/** The domain stretched by `k` around `anchor` (the middle of the space when null) (vega's `zoom`): `k < 1` zooms in. */
function zoomIn(space: ScaleSpace, domain: readonly [number, number], anchor: number | null, k: number): [number, number] {
  const d0 = space.lift(domain[0])
  const d1 = space.lift(domain[1])
  const da = anchor != null ? space.lift(anchor) : (d0 + d1) / 2
  return [space.ground(da + (d0 - da) * k), space.ground(da + (d1 - da) * k)]
}

/** The domain's length in its scale's space (see `ScaleSpace`). */
function spanIn(space: ScaleSpace, domain: readonly [number, number]): number {
  return Math.abs(space.lift(domain[1]) - space.lift(domain[0]))
}

const finitePair = (d: readonly [number, number]): boolean => Number.isFinite(d[0]) && Number.isFinite(d[1]) && d[0] !== d[1]

/**
 * Scale a domain around an anchor value; factor > 1 zooms in. The domain is stretched in `scale`'s own space (a log scale's
 * logarithm, a power scale's power: see `ScaleSpace`; linear without a scale), so the anchor stays where it is drawn, and it
 * keeps its orientation. `minSpan` is the narrowest the domain may become, measured in that space (data units for a linear,
 * time or utc scale). A result that is not a finite, non-empty domain leaves the domain as it was.
 */
export function zoomDomain(
  domain: [number, number],
  anchor: number,
  factor: number,
  minSpan?: number,
  scale?: unknown,
): [number, number] {
  if (!Number.isFinite(anchor) || !Number.isFinite(factor) || factor <= 0) return domain
  const space = spaceOf(scale, domain)
  const span = spanIn(space, domain)
  if (!(span > 0)) return domain
  let k = 1 / factor
  if (minSpan != null && span * k < minSpan) k = minSpan / span
  const next = zoomIn(space, domain, anchor, k)
  return finitePair(next) ? next : domain
}

/**
 * Translate a domain by a fraction of its span, in `scale`'s own space (see `zoomDomain`). A positive fraction moves the
 * visible window toward HIGHER values, so the data appears to move the other way (left on an ascending x scale).
 */
export function panDomain(domain: [number, number], fraction: number, scale?: unknown): [number, number] {
  const next = panIn(spaceOf(scale, domain), domain, -fraction)
  return finitePair(next) ? next : domain
}

/** Normalize a controlled view against the chart's base domains. */
export function normalizeView(view: ViewDomain | null | undefined, base: ViewDomain): ViewDomain | null {
  if (view == null) return null
  const out: ViewDomain = {}
  if (isDomainPair(view.x)) out.x = view.x
  if (isDomainPair(view.y)) out.y = view.y
  if (out.x == null && out.y == null) return null
  // A view equal to the base domain is the "not zoomed" state.
  if (out.x && base.x && out.x[0] === base.x[0] && out.x[1] === base.x[1]) delete out.x
  if (out.y && base.y && out.y[0] === base.y[0] && out.y[1] === base.y[1]) delete out.y
  return out.x || out.y ? out : null
}

/** A domain a view or an interval can hold: two finite, different numbers. */
export function isDomainPair(v: unknown): v is [number, number] {
  return Array.isArray(v) && v.length === 2 && isFiniteNumber(v[0]) && isFiniteNumber(v[1]) && v[0] !== v[1]
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
const KEY_ZOOM = 1.5

/**
 * Pure keyboard contract shared by the chart container and the accessible
 * axis sliders: arrows pan, +/- zoom, 0/Home resets. (Escape clearing the
 * selection is handled by `<Chart>` itself.) Returns a new view (or `null` for
 * reset) plus whether the key was handled. `scales` are the live positional scales
 * (`ChartInfo.scales` under the `positionalScales` names): each axis pans and zooms in its
 * scale's own space (see `zoomDomain`); without them, linearly.
 */
export function keyboardView(
  key: string,
  current: ViewDomain | null,
  base: ViewDomain,
  opts: { fast?: boolean; axis?: 'x' | 'y'; anchor?: number; pan?: boolean; zoom?: boolean; scales?: { x?: unknown; y?: unknown } } = {},
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
  const pan = (a: 'x' | 'y', fraction: number): { handled: boolean; view?: ViewDomain | null } => {
    if (axis != null && axis !== a) return { handled: false }
    const d = get(a)
    return d ? { handled: true, view: set(a, panDomain(d, fraction, opts.scales?.[a])) } : { handled: false }
  }
  const zoom = (factor: number): { handled: boolean; view: ViewDomain } => {
    const axes: Array<'x' | 'y'> = axis ? [axis] : ['x', 'y']
    let next: ViewDomain = { ...(current ?? {}) }
    for (const a of axes) {
      const d = get(a)
      if (!d || !base[a]) continue
      const scale = opts.scales?.[a]
      // (the anchor given, else the middle of the domain in its scale's own space)
      const anchor = opts.anchor != null && Number.isFinite(opts.anchor) ? opts.anchor : null
      const zoomed = anchor != null ? zoomDomain(d, anchor, factor, undefined, scale) : zoomIn(spaceOf(scale, d), d, null, 1 / factor)
      next = { ...next, [a]: finitePair(zoomed) ? zoomed : d }
    }
    return { handled: true, view: next }
  }
  switch (key) {
    case 'ArrowLeft': return pan('x', -step)
    case 'ArrowRight': return pan('x', step)
    case 'ArrowUp': return pan('y', -step)
    case 'ArrowDown': return pan('y', step)
    case '+':
    case '=': return zoom(KEY_ZOOM)
    case '-':
    case '_': return zoom(1 / KEY_ZOOM)
    case '0':
    case 'Home':
      return { handled: true, view: null }
    default:
      return { handled: false }
  }
}

/**
 * Zoom one axis of a view around a cursor value, by `factor` (> 1 zooms in), in `scale`'s own space (see `zoomDomain`).
 * Zooming in stops at `1 / maxZoom` of the base span (default 1000), and zooming out past the base domain returns the base
 * domain. This is the zoom `<Chart>`'s wheel and pinch apply.
 */
export function cursorZoom(
  current: ViewDomain | null,
  base: ViewDomain,
  axis: 'x' | 'y',
  anchorValue: number,
  factor: number,
  scale?: unknown,
  maxZoom = 1000,
): ViewDomain {
  return zoomAxisBy(current, base, axis, anchorValue, 1 / factor, scale, maxZoom)
}

/**
 * `cursorZoom` with the zoom given as vega's stretch `k` (< 1 zooms in: Vega-Lite's wheel stretch is `1.001 ^ deltaY`), so a
 * gesture computes exactly what vega computes for it. The bounds are measured in the scale's own space.
 * @internal
 */
export function zoomAxisBy(
  current: ViewDomain | null,
  base: ViewDomain,
  axis: 'x' | 'y',
  anchorValue: number,
  k: number,
  scale: unknown,
  maxZoom: number,
): ViewDomain {
  const d = (current?.[axis] ?? base[axis]) as [number, number] | undefined
  const out: ViewDomain = { ...(current ?? {}) }
  const b = base[axis]
  if (!d || !b || !Number.isFinite(anchorValue) || !Number.isFinite(k) || k <= 0) return out
  const space = spaceOf(scale, d)
  const span = spanIn(space, d)
  const baseSpan = spanIn(space, b)
  if (!(span > 0)) return out
  // never narrower than the base span over maxZoom, never wider than the base domain
  const minSpan = baseSpan / Math.max(1, maxZoom)
  const stretch = span * k < minSpan ? minSpan / span : k
  if (span * stretch > baseSpan) {
    out[axis] = b
    return out
  }
  const next = zoomIn(space, d, anchorValue, stretch)
  if (finitePair(next)) out[axis] = next
  return out
}

/**
 * Pan one axis of a drag: the domain it started at, moved so that the data that was under `fromPx` is under `toPx`, in its
 * scale's own space (vega-lite `bind: "scales"`: `panLog(extent, delta / width)` and its siblings). `pixelSpan` is the signed
 * pixel length of `domain` when the drag started (`pixelSpanOf`).
 * @internal
 */
export function dragPan(domain: [number, number], fromPx: number, toPx: number, pixelSpan: number, scale: unknown): [number, number] {
  if (!(Math.abs(pixelSpan) > 0)) return domain
  const next = panIn(spaceOf(scale, domain), domain, (toPx - fromPx) / pixelSpan)
  return finitePair(next) ? next : domain
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
  scene: import('@aster-charts/core').SceneRoot,
  hidden: Iterable<HiddenLegendEntry>,
): import('@aster-charts/core').SceneRoot {
  const entries = [...hidden]
  if (!entries.length) return scene
  const hideable = new Set(['rect', 'symbol', 'circle', 'arc', 'text', 'path', 'shape', 'geoshape', 'image'])
  const matches = (item: Record<string, unknown>): boolean => entries.some((e) =>
    (e.color != null && (item.fill === e.color || item.stroke === e.color))
    || (e.shape != null && item.shape === e.shape),
  )
  const cloneNode = (node: import('@aster-charts/core').SceneNode): import('@aster-charts/core').SceneNode => {
    const group = node as import('@aster-charts/core').SceneGroup
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
