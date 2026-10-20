import * as React from 'react'
import {
  buildA11yTree,
  getChartInfo,
  renderSceneToSvg,
  AsterLimitError,
  type A11yNode,
  type A11yOptions,
  type ChartInfo,
  type SceneRoot,
  type SpecLimits,
  type VgSpec,
} from '@aster/core'
import { isPromiseLike, normalizeChartSpec } from './spec.js'
// The incremental DOM patcher ships as the `@aster/core/dom` addon: a
// string-mode host never bundles it, while <Chart> (which supports the
// `incremental` path) pulls it in explicitly. The canvas renderer is likewise
// opt-in (`@aster/core/canvas`) so SVG-only hosts never bundle it.
import { createChartSession, patchSceneDom, renderSceneToDomElement } from '@aster/core/dom'
import { renderSceneToCanvas } from '@aster/core/canvas'
import { buildHitIndex, type HitIndex } from '@aster/core/hit'
import { bindSceneSignals, stampDatumAttrs, type SignalBinding } from '@aster/core/signals'
import {
  cursorZoom,
  domainOf,
  dragToDataInterval,
  keyboardView,
  normalizeView,
  panDomain,
  selectionToPixels,
  viewToDomainRaw,
  zoomDomain,
  type SelectValue,
  type SelectionInterval,
  type ViewDomain,
} from './interaction.js'

const num = (x: number): string => (Number.isInteger(x) ? String(x) : String(Math.round(x * 1000) / 1000))

/** Scene/encode channel fields that are engine-internal, not datum data. */
const TOOLTIP_INTERNAL_FIELDS = new Set([
  'x', 'y', 'x2', 'y2', 'xc', 'yc', 'width', 'height', 'opacity', 'fill', 'fill-opacity',
  'stroke', 'stroke-width', 'stroke-dasharray', 'strokeOpacity', 'size', 'shape', 'angle',
  'theta', 'radius', 'text', 'align', 'baseline', 'defined', 'startAngle', 'endAngle',
  'innerRadius', 'outerRadius', 'ariaRoleDescription', 'ariaRole', 'ariaLabel', 'aria', 'description', 'path', 'url',
  'limit', 'dir', 'dx', 'dy', 'cursor', 'href', 'tooltip', 'band',
])

export interface ChartProps {
  /** A Vega spec, or a Vega-Lite spec compiled internally, or a promise of either. */
  spec: VgSpec | Promise<VgSpec>
  data?: Record<string, unknown[]>
  /**
   * Per-datum differential update: for each named dataset, the indices (into the
   * new row array, unchanged length/order) whose values changed. The reactive
   * dataflow re-derives only the changed rows and reuses unchanged scene items
   * and DOM subtrees. Combine with an immutable `data` replacement (new array) of
   * the same length/order. When omitted, updates re-encode fully.
   */
  dataChanges?: Record<string, number[]>
  width?: number
  height?: number
  ariaLabel?: string
  /**
   * Incremental DOM updates: instead of re-serializing and re-parsing the whole
   * SVG on every spec/data change, keep the <svg> element and patch only the
   * attributes that changed (vega-scenegraph's SVG update strategy).
   * On by default: it is dramatically cheaper on updates for the common
   * dashboard case (mostly-stable axes/legends) and leaks less heap. Set to
   * false for a single string render when you only need static output.
   * SSR-safe: the first render emits the full string markup (server + hydration
   * match); patching only runs in the browser on subsequent updates.
   */
  incremental?: boolean
  /**
   * Rendering backend: `'svg'` (default, SSR-safe) or `'canvas'`. Both render
   * the same scene through the shared geometry engine. Canvas handles
   * devicePixelRatio and redraws on every scene change; the DOM tooltip and
   * the spec-driven signal event loop are SVG-only (they read the rendered
   * DOM). Selection brushing works in both.
   */
  renderer?: 'svg' | 'canvas'
  className?: string
  style?: React.CSSProperties
  signals?: Record<string, unknown>
  onSelect?: (interval: SelectionInterval | null) => void
  /**
   * Point/click selection: called with the clicked mark's datum (or null for a
   * click on empty space). Resolved through the scene hit index, so it works
   * identically on the SVG and canvas backends.
   */
  onPointSelect?: (datum: Record<string, unknown> | null) => void
  brush?: SelectionInterval | null
  /**
   * Unified declarative selection (R10.2): either an interval or a point value.
   * Controlled when supplied; `onSelectionChange` receives every change.
   */
  selection?: SelectValue | null
  /** Alias for `selection` (the declarative select value). */
  select?: SelectValue | null
  onSelectionChange?: (value: SelectValue | null) => void
  /**
   * Pan/zoom (R10.3): wheel, drag, pinch and keyboard. The in-flight state is
   * uncontrolled unless `view` is supplied. Domains are fed back through the
   * scale layer (`domainRaw`), so marks and every guide recompute on both
   * rendering backends.
   */
  panZoom?: boolean
  /** Enable panning only (alias within `panZoom`). */
  pan?: boolean
  /** Enable zooming only (alias within `panZoom`). */
  zoom?: boolean
  /** Controlled visible domain. Omit for uncontrolled pan/zoom. */
  view?: ViewDomain | null
  onViewChange?: (view: ViewDomain | null) => void
  /** Maximum zoom-in factor relative to the initial domain. Default 1000. */
  maxZoom?: number
  /**
   * Event-driven signals (vega-react's `signalListeners` convention): handlers
   * called when a signal changes, whether driven by the spec's `signal.on`
   * DOM event streams or by the imperative path. The chart re-renders with
   * the updated signal values after each event.
   */
  signalListeners?: Record<string, (name: string, value: unknown) => void>
  /** Internal: shared listeners (the event loop drives these). */
  onSignal?: (name: string, value: unknown) => void
  /** Disable the spec-driven event loop (defaults to on when the spec has signal.on streams). */
  interactive?: boolean
  /**
   * Show a tooltip on hover over a mark: the datum's fields rendered as
   * `key: value` at the cursor. Reads the `data-datum` attribute that
   * stampDatumAttrs stamps onto scene items. Off by default.
   */
  tooltip?: boolean
  /**
   * Custom tooltip content rendered inside the chart's React tree (not a
   * detached overlay). Providing this enables tooltips without `tooltip`.
   */
  renderTooltip?: (datum: Record<string, unknown>) => React.ReactNode
  /** Budgets for untrusted specs (rows, marks, strings, paths, SVG size, time). */
  limits?: SpecLimits
  /** Accessible scene tree (R10.6). Enabled by default; pass `false` to opt out. */
  a11y?: boolean | A11yOptions
  /** Called when compile/evaluate fails (typed `AsterLimitError` for budgets). */
  onError?: (error: Error) => void
}

/** Imperative handle exposed by `<Chart ref={…}>` (R11.1). */
export interface ChartHandle {
  getScene(): SceneRoot | null
  getSvg(): string | null
  getChartInfo(): ChartInfo | null
  getView(): ViewDomain | null
  setView(view: ViewDomain | null): void
  resetView(): void
  setSignal(name: string, value: unknown): void
  getSignals(): Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Concurrent-safe signal store (R10.4)
// ---------------------------------------------------------------------------

interface SignalStore {
  get: () => Record<string, unknown>
  subscribe: (listener: () => void) => () => void
  set: (next: Record<string, unknown>) => void
  merge: (next: Record<string, unknown>) => void
}

function createSignalStore(): SignalStore {
  let snapshot: Record<string, unknown> = {}
  const listeners = new Set<() => void>()
  const emit = (): void => { for (const l of listeners) l() }
  return {
    get: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    set(next) {
      snapshot = { ...next }
      emit()
    },
    merge(next) {
      snapshot = { ...snapshot, ...next }
      emit()
    },
  }
}

// ---------------------------------------------------------------------------
// Internal view (pan/zoom)
// ---------------------------------------------------------------------------

function datumKey(datum: Record<string, unknown> | null | undefined): string {
  if (datum == null) return ''
  try {
    return JSON.stringify(datum, (k, v) => (k.startsWith('__') ? undefined : v))
  } catch {
    return ''
  }
}

function sameDatum(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (datumKey(a as Record<string, unknown> | null) === datumKey(b as Record<string, unknown> | null)) return true
  if (a == null || b == null || typeof a !== 'object' || typeof b !== 'object') return false
  // A host-held selection may be a projection of the full scene datum (e.g.
  // after a data update, or when the host only kept identifying fields), so a
  // subset match marks the corresponding node as selected.
  const subset = (x: Record<string, unknown>, y: Record<string, unknown>): boolean => {
    for (const [k, v] of Object.entries(x)) {
      if (k.startsWith('__')) continue
      if (y[k] !== v) return false
    }
    return true
  }
  return subset(a as Record<string, unknown>, b as Record<string, unknown>)
    || subset(b as Record<string, unknown>, a as Record<string, unknown>)
}

const isA11yNodeKey = (key: string): boolean =>
  key === 'Enter' || key === ' ' || key === 'Home' || key === 'End' || key === 'Escape'
  || key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowUp' || key === 'ArrowDown'
  || key === '+' || key === '=' || key === '-'

function a11yTreeOptions(a11y: ChartProps['a11y'], label: string | undefined, selection: SelectValue | null | undefined): A11yOptions | null {
  if (a11y === false) return null
  const opts = a11y === true || a11y == null ? {} : a11y
  const selectedDatum = selection?.type === 'point' ? selection.datum : null
  return {
    ...opts,
    label: opts.label ?? label,
    isSelected: opts.isSelected ?? ((node) => selectedDatum != null && node.kind === 'mark' && sameDatum(node.datum, selectedDatum)),
  }
}

export const Chart = React.forwardRef<ChartHandle, ChartProps>(function Chart(props, ref) {
  if (isPromiseLike<VgSpec>(props.spec)) {
    // Let the host's <Suspense> boundary own the fallback: an internal boundary
    // would mask it and always show our placeholder instead.
    return <AsyncChart {...props} spec={props.spec} chartRef={ref} />
  }
  return <ChartView {...props} spec={props.spec} chartRef={ref} />
})

function AsyncChart({ spec, chartRef, ...props }: Omit<ChartProps, 'spec'> & { spec: PromiseLike<VgSpec>; chartRef: React.ForwardedRef<ChartHandle> }) {
  const resolved = React.use(spec as Promise<VgSpec>)
  return <ChartView {...props} spec={resolved} chartRef={chartRef} />
}

function ChartView({
  spec: rawSpec,
  data,
  dataChanges,
  width,
  height,
  ariaLabel,
  className,
  style,
  signals,
  onSelect,
  onPointSelect,
  brush,
  selection,
  select,
  onSelectionChange,
  panZoom = false,
  pan = false,
  zoom = false,
  view: controlledView,
  onViewChange,
  maxZoom = 1000,
  incremental = true,
  renderer = 'svg',
  signalListeners,
  onSignal,
  interactive = true,
  tooltip = false,
  renderTooltip,
  limits,
  a11y = true,
  onError,
  chartRef,
}: Omit<ChartProps, 'spec'> & { spec: VgSpec; chartRef: React.ForwardedRef<ChartHandle> }) {
  const spec = React.useMemo(() => normalizeChartSpec(rawSpec), [rawSpec])
  const tooltipEnabled = tooltip || renderTooltip != null
  const containerRef = React.useRef<HTMLDivElement>(null)
  const [measured, setMeasured] = React.useState<{ width: number; height: number }>({
    width: 600,
    height: 400,
  })
  const overlayRef = React.useRef<HTMLDivElement>(null)

  // Interaction state
  const [isDragging, setIsDragging] = React.useState(false)
  const [dragStartData, setDragStartData] = React.useState<SelectionInterval | null>(null)
  const [dragEndData, setDragEndData] = React.useState<SelectionInterval | null>(null)
  const [dragPixelStart, setDragPixelStart] = React.useState<{ x: number; y: number } | null>(null)
  const [dragPixelEnd, setDragPixelEnd] = React.useState<{ x: number; y: number } | null>(null)
  const [tooltipInfo, setTooltipInfo] = React.useState<{ datum: Record<string, unknown>; x: number; y: number } | null>(null)
  const [internalView, setInternalView] = React.useState<ViewDomain | null>(null)
  const [internalSelection, setInternalSelection] = React.useState<SelectValue | null>(null)
  const renderErrorRef = React.useRef<Error | null>(null)

  const useOverrides = width != null && height != null

  React.useEffect(() => {
    if (useOverrides) return
    const el = containerRef.current
    if (!el) return
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver((entries) => {
        const { width: w, height: h } = entries[0]?.contentRect ?? {}
        if (w && h) {
          setMeasured({ width: w, height: h })
        }
      })
      observer.observe(el)
      return () => observer.disconnect()
    }
  }, [useOverrides])

  const renderWidth = useOverrides ? width : measured.width
  const renderHeight = useOverrides ? height : measured.height

  // `pan`/`zoom` are focused aliases for `panZoomEnabled`.
  const panZoomEnabled = panZoom || pan === true || zoom === true

  // Session caches scene across renders whose inputs are unchanged (fresh
  // spec object with identical content costs nothing), mirroring Vega's
  // "skip work when nothing is dirty" behavior.
  const sessionRef = React.useRef<ReturnType<typeof createChartSession> | null>(null)
  if (sessionRef.current == null) sessionRef.current = createChartSession()

  const sceneRef = React.useRef<SceneRoot | null>(null)

  // Base domains (before any pan/zoom) let a controlled view be clamped and
  // reset without another compile pass.
  const baseDomains = React.useMemo<ViewDomain>(() => {
    if (!panZoomEnabled) return {}
    try {
      const info = getChartInfo(spec, { width: renderWidth, height: renderHeight, limits })
      return {
        x: domainOf(info.scales.get('x')) ?? undefined,
        y: domainOf(info.scales.get('y')) ?? undefined,
      }
    } catch {
      return {}
    }
  }, [panZoomEnabled, spec, renderWidth, renderHeight, limits])
  const baseDomainsRef = React.useRef(baseDomains)
  baseDomainsRef.current = baseDomains

  const currentView = controlledView !== undefined ? controlledView : internalView
  const viewRef = React.useRef(currentView)
  viewRef.current = currentView

  const applyView = React.useCallback((next: ViewDomain | null) => {
    const normalized = next == null ? null : normalizeView(next, baseDomainsRef.current)
    if (controlledView === undefined) setInternalView(normalized)
    onViewChange?.(normalized)
  }, [controlledView, onViewChange])
  const applyViewRef = React.useRef(applyView)
  applyViewRef.current = applyView

  const domainRaw = React.useMemo(() => viewToDomainRaw(currentView), [currentView])
  const signalStoreRef = React.useRef<SignalStore | null>(null)
  if (signalStoreRef.current == null) signalStoreRef.current = createSignalStore()
  const signalStore = signalStoreRef.current
  const eventSignals = React.useSyncExternalStore(signalStore.subscribe, signalStore.get, signalStore.get)
  const mergedSignals = React.useMemo(
    () => ({ ...(signals ?? {}), ...eventSignals }),
    [signals, eventSignals],
  )

  const sceneGenRef = React.useRef(0)
  React.useMemo<SceneRoot | null>(() => {
    try {
      const sc = sessionRef.current!.evaluate(spec, { data, dataChanges, width: renderWidth, height: renderHeight, signals: mergedSignals, limits, domainRaw })
      // Tooltips read data-datum off the DOM; stamp the datum onto scene items
      // before the markup/patch so the attribute is rendered.
      if (tooltipEnabled) stampDatumAttrs(sc.items)
      sceneRef.current = sc
      renderErrorRef.current = null
      return sc
    } catch (err) {
      sceneRef.current = null
      renderErrorRef.current = err instanceof Error ? err : new Error(String(err))
      return null
    }
  }, [spec, data, dataChanges, renderWidth, renderHeight, mergedSignals, tooltipEnabled, limits, domainRaw])
  const scene = sceneRef.current
  if (scene != null) sceneGenRef.current++
  const sceneGen = sceneGenRef.current
  const renderError = renderErrorRef.current

  React.useEffect(() => {
    if (renderError) onError?.(renderError)
  }, [scene, renderError, onError])

  // Incremental is the default: we still serialize the full SVG for the first
  // render (so server output and client hydration carry the markup), then the
  // patcher owns the <svg> and we stop re-serializing on later updates.
  const hasPatchedRef = React.useRef(false)
  const markup = React.useMemo<string | null>(() => {
    if (scene == null) return null
    if (renderer === 'canvas') return null
    if (incremental && hasPatchedRef.current) return null
    return renderSceneToSvg(scene)
  }, [incremental, renderer, scene])

  const svgHostRef = React.useRef<HTMLDivElement>(null)
  const canvasRef = React.useRef<HTMLCanvasElement>(null)
  // Canvas-mode hit testing: the tooltip resolves marks through the scene hit
  // index instead of DOM attributes (canvas has none). Rebuilt per scene.
  const hitIndexRef = React.useRef<{ idx: number; index: HitIndex | null }>({ idx: 0, index: null })
  // Signal state lives in an external store consumed with useSyncExternalStore:
  // an event is a normal, synchronous state transition with a stable snapshot,
  // so concurrent renders never observe a half-applied signal set.
  React.useEffect(() => {
    if (signals) signalStore.merge(signals)
  }, [signals, signalStore])
  const signalBindingRef = React.useRef<SignalBinding | null>(null)
  React.useLayoutEffect(() => {
    if (!interactive || !scene || renderer === 'canvas') return
    const host = svgHostRef.current
    const svg = (host?.firstElementChild as SVGSVGElement | null) ?? null
    if (!svg) return
    const signalDefs = (scene as unknown as { compiled?: { signalDefs?: Array<{ on?: unknown[] }> } }).compiled?.signalDefs
    const hasStreams = signalDefs?.some((d) => d.on?.length) ?? false
    // Bind when there is anything to drive/listen to, or when any signal exists
    // so ChartHandle.setSignal works on a purely imperative spec.
    if (!hasStreams && !signalListeners && !onSignal && !signalDefs?.length) return
    signalBindingRef.current?.detach()
    stampDatumAttrs(scene.items)
    signalBindingRef.current = bindSceneSignals(svg, scene, mergedSignals, {
      onSignal: (name, value, all) => {
        signalStore.set(all)
        signalListeners?.[name]?.(name, value)
        onSignal?.(name, value)
      },
    })
    return () => {
      signalBindingRef.current?.detach()
      signalBindingRef.current = null
    }
  })

  // Incremental updates: create the <svg> once, then patch changed attributes
  // in place instead of re-serializing and re-parsing the whole markup every render.
  React.useLayoutEffect(() => {
    if (!incremental || !scene || renderer === 'canvas') return
    const host = svgHostRef.current
    if (!host) return
    const existing = host.firstElementChild
    if (existing && existing.tagName.toLowerCase() === 'svg') {
      patchSceneDom(existing, scene)
    } else {
      host.replaceChildren(renderSceneToDomElement(scene))
    }
    hasPatchedRef.current = true
  }, [incremental, scene])

  // Canvas backend: size the backing store for devicePixelRatio and redraw the
  // whole scene whenever it changes (cheap relative to SVG serialization for
  // dense marks; no listeners to leak — every redraw is a full repaint).
  React.useLayoutEffect(() => {
    if (renderer !== 'canvas' || !scene) return
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = typeof window !== 'undefined' && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1
    const w = Math.max(1, Math.round(scene.width))
    const h = Math.max(1, Math.round(scene.height))
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
    } else {
      const ctx0 = canvas.getContext('2d')
      ctx0?.clearRect(0, 0, canvas.width, canvas.height)
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    // Paint on the next frame so a large scene never blocks React's commit
    // (or the first paint). A newer scene cancels the pending frame; hosts
    // without rAF (SSR/jsdom without a shim) paint synchronously.
    const draw = () => renderSceneToCanvas(scene, ctx, { dpr })
    if (typeof requestAnimationFrame === 'function') {
      const id = requestAnimationFrame(draw)
      return () => cancelAnimationFrame(id)
    }
    draw()
  }, [renderer, scene])

  const hasSelection = onSelect != null || brush != null || onPointSelect != null
    || selection !== undefined || onSelectionChange != null
  const hasInteraction = hasSelection || panZoomEnabled
  const chartInfoRef = React.useRef<ChartInfo | null>(null)
  const chartInfoCacheIdx = React.useRef(0)

  // Recompute chart info when deps change
  const [chartInfoKey, setChartInfoKey] = React.useState<number>(0)
  React.useEffect(() => {
    // Interaction-only: without a selection handler the chart info is unused,
    // and forcing a state update here would re-render (and re-commit the svg)
    // a second time on every spec change.
    if (!hasInteraction && a11y === false) return
    let info: ChartInfo | null = null
    try {
      info = getChartInfo(spec, { width: renderWidth, height: renderHeight, domainRaw, limits })
    } catch { /* ignore */ }
    chartInfoRef.current = info
    chartInfoCacheIdx.current++
    setChartInfoKey(chartInfoCacheIdx.current)
  }, [hasInteraction, a11y, spec, renderWidth, renderHeight, domainRaw, limits])

  // Memoize to avoid recalculating
  const chartInfo = chartInfoRef.current ?? null
  const _chartInfoDepKey = chartInfoKey // force re-read

  const selectionValue: SelectValue | null = select !== undefined
    ? select
    : selection !== undefined
      ? selection
      : internalSelection
  const selectionRef = React.useRef(selectionValue)
  selectionRef.current = selectionValue
  const emitSelection = React.useCallback((value: SelectValue | null) => {
    if (selection === undefined && select === undefined) setInternalSelection(value)
    onSelectionChange?.(value)
  }, [selection, select, onSelectionChange])
  const emitSelectionRef = React.useRef(emitSelection)
  emitSelectionRef.current = emitSelection

  // --- pan/zoom gestures ---------------------------------------------------
  const gestureRef = React.useRef<'select' | 'pan' | null>(null)
  const panLastRef = React.useRef<{ x: number; y: number } | null>(null)
  const pointersRef = React.useRef<Map<number, { x: number; y: number }>>(new Map())
  const pinchRef = React.useRef<{ dist: number; cx: number; cy: number } | null>(null)

  const zoomAxes = React.useCallback((axes: Array<'x' | 'y'>, px: number, py: number, factor: number) => {
    const info = chartInfoRef.current
    if (!info) return
    const base = baseDomainsRef.current
    let next: ViewDomain = { ...(viewRef.current ?? {}) }
    let changed = false
    for (const axis of axes) {
      const scale = info.scales.get(axis) as { invert?: (v: number) => number } | undefined
      if (typeof scale?.invert !== 'function') continue
      const local = axis === 'x' ? px - info.padding.left : py - info.padding.top
      const anchor = scale.invert(local)
      if (!Number.isFinite(anchor)) continue
      // Compose both axes into one update: a controlled host receives one view
      // value per gesture, not x from one call and y from a stale snapshot.
      const current = next[axis] ?? base[axis]
      if (!current) continue
      const zoomed = zoomDomain(current, anchor, factor, base[axis] ? Math.abs(base[axis]![1] - base[axis]![0]) / Math.max(1, maxZoom) : undefined)
      const b = base[axis]
      if (b && Math.abs(zoomed[1] - zoomed[0]) > Math.abs(b[1] - b[0])) continue
      next[axis] = zoomed
      changed = true
    }
    if (changed) applyViewRef.current(next)
  }, [maxZoom])

  React.useEffect(() => {
    if (!panZoomEnabled) return
    const el = containerRef.current
    if (!el) return
    const onWheel = (evt: WheelEvent): void => {
      if (Math.abs(evt.deltaX) < 0.01 && Math.abs(evt.deltaY) < 0.01) return
      evt.preventDefault()
      const rect = el.getBoundingClientRect()
      const px = evt.clientX - rect.left
      const py = evt.clientY - rect.top
      const factor = Math.exp(-evt.deltaY * (evt.ctrlKey ? 0.01 : 0.0015))
      const axes: Array<'x' | 'y'> = Math.abs(evt.deltaX) > Math.abs(evt.deltaY) ? ['x'] : ['x', 'y']
      zoomAxes(axes, px, py, factor)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [panZoomEnabled, zoomAxes])

  const handlePointerDown = React.useCallback(
    (e: React.PointerEvent) => {
      if (!hasInteraction) return
      const rect = containerRef.current?.getBoundingClientRect()
      if (!rect) return
      const x = e.clientX - rect.left
      const y = e.clientY - rect.top
      pointersRef.current.set(e.pointerId, { x, y })
      if (pointersRef.current.size === 2) {
        const [a, b] = [...pointersRef.current.values()]
        pinchRef.current = { dist: Math.hypot(a!.x - b!.x, a!.y - b!.y), cx: (a!.x + b!.x) / 2, cy: (a!.y + b!.y) / 2 }
        gestureRef.current = null
        setIsDragging(false)
        return
      }
      // Shift/middle-button pans; a plain drag brushes when a selection handler exists.
      const wantsPan = panZoomEnabled && (!hasSelection || e.shiftKey || e.button === 1)
      gestureRef.current = wantsPan ? 'pan' : hasSelection ? 'select' : panZoomEnabled ? 'pan' : null
      if (gestureRef.current === 'pan') {
        panLastRef.current = { x, y }
        setIsDragging(true)
      } else if (gestureRef.current === 'select') {
        setDragPixelStart({ x, y })
        setDragPixelEnd({ x, y })
        setIsDragging(true)
      }
      const target = e.target as HTMLElement
      target.setPointerCapture?.(e.pointerId)
    },
    [hasInteraction, hasSelection, panZoomEnabled],
  )

  const handlePointerMove = React.useCallback(
    (e: React.PointerEvent) => {
      const rect = containerRef.current?.getBoundingClientRect()
      if (!rect) return
      const x = e.clientX - rect.left
      const y = e.clientY - rect.top
      if (pointersRef.current.has(e.pointerId)) pointersRef.current.set(e.pointerId, { x, y })
      if (pinchRef.current && pointersRef.current.size === 2) {
        const [a, b] = [...pointersRef.current.values()]
        const dist = Math.hypot(a!.x - b!.x, a!.y - b!.y)
        const cx = (a!.x + b!.x) / 2
        const cy = (a!.y + b!.y) / 2
        const prev = pinchRef.current
        if (prev.dist > 0 && dist > 0) {
          const factor = dist / prev.dist
          zoomAxes(['x', 'y'], cx, cy, factor)
        }
        pinchRef.current = { dist, cx, cy }
        return
      }
      if (!isDragging || !hasInteraction) return
      if (gestureRef.current === 'pan') {
        const last = panLastRef.current
        if (!last) return
        const info = chartInfoRef.current
        const base = baseDomainsRef.current
        if (!info) return
        const plotW = Math.max(1, info.width)
        const plotH = Math.max(1, info.height)
        const current = viewRef.current
        const next: ViewDomain = { ...(current ?? {}) }
        if (base.x) {
          const d = (current?.x ?? base.x) as [number, number]
          next.x = panDomain(d, -(x - last.x) / plotW)
        }
        if (base.y) {
          const d = (current?.y ?? base.y) as [number, number]
          next.y = panDomain(d, -(y - last.y) / plotH)
        }
        panLastRef.current = { x, y }
        applyViewRef.current(next)
        return
      }
      if (gestureRef.current === 'select' && dragPixelStart != null) {
        setDragPixelEnd({ x, y })
        const ci = chartInfoRef.current
        if (ci) {
          const interval = dragToDataInterval(dragPixelStart, { x, y }, ci)
          setDragEndData(interval)
        }
      }
    },
    [isDragging, dragPixelStart, hasInteraction, zoomAxes],
  )

  const handlePointerUp = React.useCallback(
    (e: React.PointerEvent) => {
      pointersRef.current.delete(e.pointerId)
      if (pointersRef.current.size < 2) pinchRef.current = null
      const gesture = gestureRef.current
      gestureRef.current = null
      panLastRef.current = null
      if (!isDragging && !hasInteraction) {
        setIsDragging(false)
        return
      }
      const rect = containerRef.current?.getBoundingClientRect()
      if (!rect) {
        setIsDragging(false)
        return
      }
      const x = e.clientX - rect.left
      const y = e.clientY - rect.top

      if (gesture === 'select' && dragPixelStart != null) {
        const dx = x - dragPixelStart.x
        const dy = y - dragPixelStart.y
        if (Math.abs(dx) < 3 && Math.abs(dy) < 3) {
          // Tiny drag -> a click: resolve the mark under the pointer and clear
          // any interval selection.
          setDragStartData(null)
          setDragEndData(null)
          let datum: Record<string, unknown> | null = null
          if (onPointSelect || onSelectionChange != null) {
            if (hitIndexRef.current.index == null || hitIndexRef.current.idx !== sceneGen) {
              hitIndexRef.current = scene ? { idx: sceneGen, index: buildHitIndex(scene) } : { idx: 0, index: null }
            }
            const target = hitIndexRef.current.index?.queryMark(x, y)
            const raw = target?.item.datum
            datum = raw != null && typeof raw === 'object' ? raw as Record<string, unknown> : null
            onPointSelect?.(datum)
          }
          if (onSelect) onSelect(null)
          if (onPointSelect || onSelectionChange != null) emitSelectionRef.current({ type: 'point', datum })
        } else {
          const ci = chartInfoRef.current
          if (ci) {
            const interval = dragToDataInterval(dragPixelStart, { x, y }, ci)
            setDragStartData(interval)
            setDragEndData(interval)
            onSelect?.(interval)
            emitSelectionRef.current({ type: 'interval', interval })
          }
        }
      }
      setIsDragging(false)
      setDragPixelStart(null)
      setDragPixelEnd(null)
    },
    [isDragging, hasInteraction, dragPixelStart, onSelect, onPointSelect, onSelectionChange, scene, sceneGen],
  )

  const cancelPointer = React.useCallback((e: React.PointerEvent) => {
    pointersRef.current.delete(e.pointerId)
    if (pointersRef.current.size < 2) pinchRef.current = null
    gestureRef.current = null
    panLastRef.current = null
    setIsDragging(false)
    setDragPixelStart(null)
    setDragPixelEnd(null)
  }, [])

  // --- accessibility -------------------------------------------------------
  const a11yOpts = React.useMemo(
    () => a11yTreeOptions(a11y, ariaLabel, selectionValue),
    [a11y, ariaLabel, selectionValue],
  )
  const a11yTree = React.useMemo(() => {
    if (!scene || a11yOpts == null) return null
    const scales = (chartInfoRef.current?.scales ?? new Map()) as Map<string, unknown>
    return buildA11yTree(scene, scales, a11yOpts)
  }, [scene, a11yOpts, chartInfoKey])
  const a11yNodesRef = React.useRef<A11yNode[]>([])
  a11yNodesRef.current = a11yTree?.nodes ?? []

  const moveA11yFocus = React.useCallback((current: A11yNode, delta: number | 'first' | 'last') => {
    const host = containerRef.current
    if (!host) return
    const nodes = a11yNodesRef.current
    if (!nodes.length) return
    let idx = nodes.findIndex((n) => n.id === current.id)
    if (idx < 0) idx = 0
    const nextIdx = delta === 'first' ? 0 : delta === 'last' ? nodes.length - 1 : (idx + delta + nodes.length) % nodes.length
    const next = nodes[nextIdx]
    if (!next) return
    const el = host.querySelector<HTMLElement>(`[data-a11y-id="${next.id}"]`)
    el?.focus()
  }, [])

  const handleA11yKeyDown = React.useCallback((node: A11yNode, e: React.KeyboardEvent) => {
    if (!isA11yNodeKey(e.key)) return
    const base = baseDomainsRef.current
    if (node.kind === 'mark') {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); moveA11yFocus(node, -1); return }
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); moveA11yFocus(node, 1); return }
      if (e.key === 'Home') { e.preventDefault(); e.stopPropagation(); moveA11yFocus(node, 'first'); return }
      if (e.key === 'End') { e.preventDefault(); e.stopPropagation(); moveA11yFocus(node, 'last'); return }
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault(); e.stopPropagation()
        const datum = (node.datum != null && typeof node.datum === 'object') ? node.datum as Record<string, unknown> : null
        onPointSelect?.(datum)
        onSelect?.(null)
        emitSelectionRef.current({ type: 'point', datum })
      }
      return
    }
    if (node.kind === 'axis' && node.scale && node.domain) {
      const axis = node.scale === 'y' ? 'y' : 'x'
      const result = keyboardView(e.key, viewRef.current, base, { axis, fast: e.shiftKey })
      if (result.handled) {
        e.preventDefault(); e.stopPropagation()
        applyViewRef.current(result.view ?? null)
      }
      return
    }
    if (node.kind === 'legend' || node.kind === 'title') {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); moveA11yFocus(node, -1) }
      else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); moveA11yFocus(node, 1) }
    }
  }, [moveA11yFocus, onPointSelect, onSelect])

  const handleChartKeyDown = React.useCallback((e: React.KeyboardEvent) => {
    if (e.defaultPrevented) return
    if (e.key === 'Escape') {
      emitSelectionRef.current(null)
      onSelect?.(null)
      onPointSelect?.(null)
      return
    }
    if (!panZoomEnabled) return
    const result = keyboardView(e.key, viewRef.current, baseDomainsRef.current, { fast: e.shiftKey })
    if (result.handled) {
      e.preventDefault()
      applyViewRef.current(result.view ?? null)
    }
  }, [panZoomEnabled, onSelect, onPointSelect])

  /**
   * Tooltip fields: the datum row is the ORIGINAL data plus the encoded
   * channel values resolveEncodeSet appends (x/y/width/fill/...). The tooltip
   * is for reading the datum — hide the internal/positional channels and
   * engine fields, keep the source data.
   */
  const tooltipFields = React.useMemo(() => {
    if (!tooltipInfo) return [] as Array<[string, string]>
    const fmt = ([k, v]: [string, unknown]): [string, string] => [k, typeof v === 'number' ? num(v) : String(v)]
    const visible = Object.entries(tooltipInfo.datum).filter(
      ([k, v]) => !k.startsWith('__') && !TOOLTIP_INTERNAL_FIELDS.has(k) && v != null && typeof v !== 'object',
    )
    // Specs whose source fields are themselves named like channels (x/y/...)
    // would filter to nothing — vega-style fallback: show every field.
    return (visible.length ? visible : Object.entries(tooltipInfo.datum).filter(([k, v]) => !k.startsWith('__') && v != null && typeof v !== 'object')).map(fmt)
  }, [tooltipInfo])

  const handleTooltipMove = React.useCallback(
    (e: React.MouseEvent) => {
    if (!tooltipEnabled) return
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return
    if (renderer === 'canvas') {
      // Canvas backend: resolve through the scene hit index.
      if (hitIndexRef.current.index == null || hitIndexRef.current.idx !== sceneGen) {
        hitIndexRef.current = scene ? { idx: sceneGen, index: buildHitIndex(scene) } : { idx: 0, index: null }
      }
      const target = hitIndexRef.current.index?.queryMark(e.clientX - rect.left, e.clientY - rect.top)
      const datum = target?.item.datum as Record<string, unknown> | undefined
      setTooltipInfo(datum != null && typeof datum === 'object' ? { datum, x: e.clientX - rect.left, y: e.clientY - rect.top } : null)
      return
    }
    // The hovered element may be a parent/child of the mark (e.g. a tspan or an
    // axis line above it); walk up to the nearest element carrying data-datum.
    const el = (e.target as HTMLElement).closest?.('[data-datum]') as HTMLElement | null
    const raw = el?.dataset?.datum
    if (!raw) { setTooltipInfo(null); return }
    try {
      const datum = JSON.parse(raw) as Record<string, unknown>
      setTooltipInfo({ datum, x: e.clientX - rect.left, y: e.clientY - rect.top })
    } catch { setTooltipInfo(null) }
    },
    [tooltipEnabled, renderer],
  )

  const handleTooltipLeave = React.useCallback(() => {
    if (tooltipEnabled) setTooltipInfo(null)
  }, [tooltipEnabled])

  // Brush pixel rect from persisted brush prop
  const brushPixelRect = React.useMemo(() => {
    if (!brush || chartInfo == null) return null
    return selectionToPixels(brush, chartInfo)
  }, [brush, chartInfo])

  // Drag overlay pixel rect
  const dragRect = React.useMemo(() => {
    if (!dragPixelStart || !dragPixelEnd) return null
    return {
      x: Math.min(dragPixelStart.x, dragPixelEnd.x),
      y: Math.min(dragPixelStart.y, dragPixelEnd.y),
      width: Math.abs(dragPixelEnd.x - dragPixelStart.x),
      height: Math.abs(dragPixelEnd.y - dragPixelStart.y),
    }
  }, [dragPixelStart, dragPixelEnd])

  // --- imperative handle (R11.1) ------------------------------------------
  React.useImperativeHandle(chartRef, () => ({
    getScene: () => sceneRef.current,
    getSvg: () => (sceneRef.current ? renderSceneToSvg(sceneRef.current) : null),
    getChartInfo: () => chartInfoRef.current,
    getView: () => viewRef.current ?? null,
    setView: (next) => applyViewRef.current(next),
    resetView: () => applyViewRef.current(null),
    setSignal: (name, value) => signalBindingRef.current?.setSignal(name, value),
    getSignals: () => signalStoreRef.current?.get() ?? {},
  }), [])

  if (scene === null) {
    const message = renderError instanceof AsterLimitError
      ? renderError.message
      : 'Chart render failed'
    return <div role="alert" style={style} title={renderError?.message}>{message}</div>
  }

  const outerStyle: React.CSSProperties = hasInteraction
    ? { ...style, position: 'relative', width: '100%', height: '100%' }
    : { width: '100%', height: '100%', ...style }

  const role = a11yTree ? (ariaLabel ? 'group' : undefined) : ariaLabel ? 'img' : undefined

  return (
    <div
      ref={containerRef}
      role={role}
      aria-label={ariaLabel}
      tabIndex={panZoomEnabled ? 0 : undefined}
      onKeyDown={handleChartKeyDown}
      onDoubleClick={panZoomEnabled ? () => applyViewRef.current(null) : undefined}
      className={className}
      style={outerStyle}
      onMouseMove={handleTooltipMove}
      onMouseLeave={handleTooltipLeave}
      data-aster-view={currentView ? 'zoomed' : 'base'}
    >
      {hasInteraction && (
        <div data-testid="chart-brush-overlay"
          style={{ position: 'absolute', inset: 0, zIndex: 10, touchAction: panZoomEnabled ? 'none' : undefined }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={cancelPointer}
        >
          {/* Live drag overlay */}
          {dragRect != null && (
            <div
              ref={overlayRef}
              style={{
                position: 'absolute',
                left: dragRect.x,
                top: dragRect.y,
                width: dragRect.width,
                height: dragRect.height,
                background: 'rgba(37,99,235,0.15)',
                border: '1px solid rgba(37,99,235,0.6)',
                pointerEvents: 'none',
                boxSizing: 'border-box',
              }}
            />
          )}
          {/* Persisted brush overlay */}
          {brushPixelRect != null && (
            <div
              style={{
                position: 'absolute',
                left: brushPixelRect.x,
                top: brushPixelRect.y,
                width: brushPixelRect.width,
                height: brushPixelRect.height,
                background: 'rgba(37,99,235,0.15)',
                border: '1px solid rgba(37,99,235,0.6)',
                pointerEvents: 'none',
                boxSizing: 'border-box',
              }}
            />
          )}
        </div>
      )}
      {renderer === 'canvas' ? (
        <canvas
          ref={canvasRef}
          data-testid="chart-canvas"
          style={{ position: 'relative', zIndex: 1, width: scene.width, height: scene.height, display: 'block' }}
        />
      ) : (
        <div
          ref={svgHostRef}
          style={{ position: 'relative', zIndex: 1 }}
          {...(markup != null ? { dangerouslySetInnerHTML: { __html: markup } } : {})}
        />
      )}
      {a11yTree != null && (
        <div
          className="aster-a11y"
          data-testid="chart-a11y"
          role="group"
          aria-label={a11yTree.label}
          style={{ position: 'absolute', inset: 0, zIndex: 30, pointerEvents: 'none' }}
        >
          {a11yTree.summary != null && <span className="sr-only" style={srOnly}>{a11yTree.summary}</span>}
          {a11yTree.nodes.map((node) => (
            <div
              key={node.id}
              data-a11y-id={node.id}
              data-a11y-kind={node.kind}
              role={node.kind === 'title' ? 'heading' : node.role}
              aria-level={node.kind === 'title' ? 2 : undefined}
              aria-roledescription={node.roleDescription}
              aria-label={node.label}
              aria-selected={node.selected == null ? undefined : node.selected}
              aria-valuemin={node.role === 'slider' ? node.domain?.[0] : undefined}
              aria-valuemax={node.role === 'slider' ? node.domain?.[1] : undefined}
              aria-valuenow={node.role === 'slider' && node.domain ? (node.domain[0] + node.domain[1]) / 2 : undefined}
              tabIndex={0}
              onKeyDown={(e) => handleA11yKeyDown(node, e)}
              style={{
                position: 'absolute',
                left: Math.max(0, node.x),
                top: Math.max(0, node.y),
                width: Math.max(1, node.width),
                height: Math.max(1, node.height),
                opacity: 0,
                // Focusable by Tab/keyboard, but never steals pointer input from
                // the marks underneath (selection, pan, tooltips).
                pointerEvents: 'none',
                borderRadius: 2,
                outline: 'none',
              }}
              onFocus={(e) => { e.currentTarget.style.opacity = '0.001' }}
              onBlur={(e) => { e.currentTarget.style.opacity = '0' }}
            />
          ))}
        </div>
      )}
      {tooltipInfo != null && (
        <div
          data-testid="chart-tooltip"
          style={{
            position: 'absolute',
            left: tooltipInfo.x + 12,
            top: tooltipInfo.y + 12,
            zIndex: 40,
            pointerEvents: 'none',
            background: 'rgba(0,0,0,0.85)',
            color: '#fff',
            padding: '4px 8px',
            borderRadius: 4,
            fontSize: 12,
            fontFamily: 'system-ui, sans-serif',
            maxWidth: 240,
            whiteSpace: 'nowrap',
          }}
        >
          {renderTooltip != null
            ? renderTooltip(tooltipInfo.datum)
            : tooltipFields.map(([k, v]) => (
                <div key={k}><strong>{k}:</strong> {v}</div>
              ))}
        </div>
      )}
    </div>
  )
}

const srOnly: React.CSSProperties = {
  position: 'absolute', width: 1, height: 1, padding: 0, margin: -1,
  overflow: 'hidden', clip: 'rect(0,0,0,0)', whiteSpace: 'nowrap', border: 0,
}
