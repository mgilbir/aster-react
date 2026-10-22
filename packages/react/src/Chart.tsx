import * as React from 'react'
import {
  buildA11yTree,
  chartInfoFromScene,
  renderSceneToSvg,
  AsterLimitError,
  type A11yNode,
  type A11yOptions,
  type ChartInfo,
  type SceneRoot,
  type SpecLimits,
  type TextMetricsProvider,
  type VgSpec,
} from '@aster/core'
import { isPromiseLike, normalizeChartSpec, useStableContent, useStableSpec } from './spec.js'
import { validateDataChanges } from './dataChanges.js'
import { SCALE_INFO_KEY, scalesFromSerialized, type SerializedScale } from './serialScales.js'
// The incremental DOM patcher ships as the `@aster/core/dom` addon: a
// string-mode host never bundles it, while <Chart> (which supports the
// `incremental` path) pulls it in explicitly. The canvas renderer is likewise
// opt-in (`@aster/core/canvas`) so SVG-only hosts never bundle it.
import { createChartSession, hasDenseSymbolMarks, patchSceneDom, renderSceneToDomElement } from '@aster/core/dom'
import {
  renderSceneToCanvas, renderSceneToCanvasAppend, snapshotCanvasScene,
  type CanvasSceneSnapshot,
} from '@aster/core/canvas'
import { buildHitIndex, type HitIndex } from '@aster/core/hit'
import { bindSceneSignals, stampDatumAttrs, type SignalBinding } from '@aster/core/signals'
import {
  baseDomainsOf,
  filterLegendScene,
  dragToDataInterval,
  keyboardView,
  normalizeView,
  panDomain,
  pixelSpanOf,
  positionalScales,
  selectValueToInterval,
  selectionToPixels,
  viewToDomainRaw,
  zoomDomain,
  type HiddenLegendEntry,
  type SelectValue,
  type SelectionInterval,
  type ViewDomain,
} from './interaction.js'

const num = (x: number): string => (Number.isInteger(x) ? String(x) : String(Math.round(x * 1000) / 1000))

// `getServerSnapshot` runs for SSR *and* for the hydration render on the client,
// so this is `true` exactly while the tree must match server markup. It flips to
// `false` after hydration, which lets dense marks batch a client-only mount
// immediately while keeping SSR/hydration byte-compatible.
const subscribeNothing = (): (() => void) => () => {}
const clientOnly = (): boolean => false
const serverOrHydrating = (): boolean => true

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
  /**
   * Pre-evaluated scene override (streaming): when provided, the chart renders
   * this scene instead of evaluating the spec. `undefined` keeps the normal
   * session path; `null` renders the loading/error state. Used by
   * `<ChartStream>` / `<ChartWorkerStream>` so streamed scenes go through the
   * same DOM patcher, canvas renderer, interaction and a11y tree.
   */
  sceneOverride?: SceneRoot | null
  data?: Record<string, unknown[]>
  /**
   * Per-datum differential update: for each named dataset, the indices (into the
   * new row array, unchanged length/order) whose values changed. The reactive
   * dataflow re-derives only the changed rows and reuses unchanged scene items
   * and DOM subtrees. Combine with an immutable `data` replacement (new array) of
   * the same length/order. When omitted, updates re-encode fully.
   *
   * The indices are validated: an unknown dataset, a non-integer or out-of-range
   * index, or a dataset whose row count changed makes the whole changeset be
   * ignored (the update is diffed in full, so the chart is still correct) and
   * `onError` receives an `Error` describing the problem.
   */
  dataChanges?: Record<string, number[]>
  /**
   * Chart width in px. Without it the chart uses its container's measured
   * width (and the spec's own width until the first measurement, e.g. on the
   * server). Independent of `height`: giving one of them fixes only that one.
   */
  width?: number
  /** Chart height in px; see `width`. */
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
   * devicePixelRatio and redraws on every scene change. The spec-driven signal
   * event loop (`signal.on` DOM event streams) is SVG-only; tooltips (hit
   * index), selection brushing, pan/zoom and `ChartHandle.setSignal` work in both.
   */
  renderer?: 'svg' | 'canvas'
  /**
   * Batch dense symbol marks into chunked `<path>` elements (SVG only):
   * `'auto'` (default) batches large symbol marks when the spec has no
   * `signal.on` event streams, `true` always batches, `false` disables.
   *
   * The DOM stops mirroring Vega's per-item structure (one element per datum),
   * but the pixels are identical — 100k symbols become a few hundred paths,
   * which keeps large SVG scenes inside the frame budget. Tooltips, point
   * selection and a11y resolve through the scene, so they keep working;
   * per-mark `data-datum` attributes and spec `signal.on` mark events do not.
   * Ignored for canvas (already batched). Server rendering always emits the
   * per-item markup so hydration matches; a client-only mount batches directly.
   */
  denseMarks?: boolean | 'auto'
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
   *
   * `view`/`brush`/`selection` axes `x` and `y` mean the horizontal and vertical
   * positional scale, whatever they are named: they are derived from the spec
   * (see `positionalScales`), so `xscale`/`yscale` work like `x`/`y`.
   */
  panZoom?: boolean
  /**
   * Enable panning only: drag and the arrow keys. `panZoom` enables both;
   * `pan` and `zoom` together are equivalent to `panZoom`.
   */
  pan?: boolean
  /** Enable zooming only: wheel, pinch and the `+`/`-` keys. See `pan`. */
  zoom?: boolean
  /** Controlled visible domain (`x`/`y` = the horizontal/vertical positional scale). Omit for uncontrolled pan/zoom. */
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
  /** Internal: shared listeners (the event loop and bound inputs drive these). */
  onSignal?: (name: string, value: unknown) => void
  /**
   * @internal Used by `<ChartStream>`/`<ChartWorkerStream>` (with `sceneOverride`)
   * to receive what this chart derives from props and gestures — the `domainRaw`
   * of the pan/zoom view and the merged signal values — so the stream can
   * re-evaluate with them.
   */
  onStreamInput?: (input: ChartStreamInput) => void
  /** Disable the spec-driven event loop (defaults to on when the spec has signal.on streams). */
  interactive?: boolean
  /**
   * Show a tooltip on hover over a mark: the datum's fields rendered as
   * `key: value` at the cursor. Resolved through the scene on both renderers
   * (the `data-datum` attribute on SVG, the hit index for canvas and batched
   * dense marks). Off by default.
   */
  tooltip?: boolean
  /**
   * Custom tooltip content rendered inside the chart's React tree (not a
   * detached overlay). Providing this enables tooltips without `tooltip`.
   */
  renderTooltip?: (datum: Record<string, unknown>) => React.ReactNode
  /** Budgets for untrusted specs (rows, marks, strings, paths, SVG size, time). */
  limits?: SpecLimits
  /** Host text measurement for custom fonts / non-browser engines. */
  textMetrics?: TextMetricsProvider
  /** Accessible scene tree (R10.6). Enabled by default; pass `false` to opt out. */
  a11y?: boolean | A11yOptions
  /** Called when compile/evaluate fails (typed `AsterLimitError` for budgets). */
  onError?: (error: Error) => void
}

/** What a stream-fed chart asks its stream to apply (see `ChartProps.onStreamInput`). */
export interface ChartStreamInput {
  /** Scale-name -> domain overrides for the current pan/zoom view (absent = no view). */
  domainRaw?: Record<string, unknown[]>
  /** Merged signal values (props + events). */
  signals: Record<string, unknown>
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

/** True when the spec has `signal.on` event streams (they resolve marks from `data-datum`). */
function hasEventStreams(scene: SceneRoot | null): boolean {
  const defs = (scene as { compiled?: { signalDefs?: Array<{ on?: unknown[] }> } } | null)?.compiled?.signalDefs
  return defs?.some((d) => (d.on?.length ?? 0) > 0) ?? false
}

const isA11yNodeKey = (key: string): boolean =>
  key === 'Enter' || key === ' ' || key === 'Home' || key === 'End' || key === 'Escape'
  || key === 'PageUp' || key === 'PageDown'
  || key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowUp' || key === 'ArrowDown'
  || key === '+' || key === '=' || key === '-'

interface SignalBindDef {
  name?: unknown
  value?: unknown
  bind?: unknown
}

function SignalBinds({ signals, values, onChange }: {
  signals: SignalBindDef[]
  values: Record<string, unknown>
  onChange: (name: string, value: unknown) => void
}): React.ReactElement | null {
  const defs = signals.filter((s) => typeof s.name === 'string' && s.bind != null)
  if (!defs.length) return null
  const control = (def: SignalBindDef): React.ReactNode => {
    const name = String(def.name)
    const bind = typeof def.bind === 'object' && def.bind != null
      ? def.bind as Record<string, unknown>
      : { input: String(def.bind) }
    const input = typeof bind.input === 'string' ? bind.input : 'range'
    const value = values[name] ?? def.value ?? bind.value
    const label = typeof bind.name === 'string' ? bind.name : name
    const options: Array<{ value: unknown; label: string }> = Array.isArray(bind.options)
      ? (bind.options as unknown[]).map((o) => {
          if (o != null && typeof o === 'object') {
            const rec = o as Record<string, unknown>
            return { value: rec.value, label: String(rec.label ?? rec.value) }
          }
          return { value: o, label: String(o) }
        })
      : []
    const set = (v: unknown): void => onChange(name, v)
    if (input === 'range') {
      const min = typeof bind.min === 'number' ? bind.min : undefined
      const max = typeof bind.max === 'number' ? bind.max : undefined
      const step = typeof bind.step === 'number' ? bind.step : undefined
      return (
        <label key={name} data-signal={name} style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
          <span>{label}</span>
          <input
            type="range"
            aria-label={label}
            min={min} max={max} step={step}
            value={Number(value ?? min ?? 0)}
            onChange={(e) => set(Number(e.currentTarget.value))}
          />
          <span>{String(value ?? '')}</span>
        </label>
      )
    }
    if (input === 'select') {
      // Options are addressed by index so a number/boolean/null option value
      // round-trips with its type instead of being stringified by the DOM.
      const selected = options.findIndex((o) => Object.is(o.value, value) || String(o.value) === String(value))
      return (
        <label key={name} data-signal={name} style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          <span>{label}</span>
          <select
            aria-label={label}
            value={selected >= 0 ? String(selected) : ''}
            onChange={(e) => {
              const option = options[Number(e.currentTarget.value)]
              if (option) set(option.value)
            }}
          >
            {selected < 0 && <option value="" disabled hidden />}
            {options.map((o, i) => <option key={i} value={String(i)}>{o.label}</option>)}
          </select>
        </label>
      )
    }
    if (input === 'checkbox') {
      return (
        <label key={name} data-signal={name} style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          <input type="checkbox" aria-label={label} checked={Boolean(value)} onChange={(e) => set(e.currentTarget.checked)} />
          <span>{label}</span>
        </label>
      )
    }
    if (input === 'radio') {
      return (
        <span key={name} data-signal={name} style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
          <span>{label}</span>
          {options.map((o) => (
            <label key={String(o.value)} style={{ display: 'inline-flex', gap: 3, alignItems: 'center' }}>
              <input type="radio" name={name} aria-label={`${label} ${o.label}`} checked={value === o.value} onChange={() => set(o.value)} />
              <span>{o.label}</span>
            </label>
          ))}
        </span>
      )
    }
    if (input === 'color') {
      return (
        <label key={name} data-signal={name} style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          <span>{label}</span>
          <input type="color" aria-label={label} value={String(value ?? '#000000')} onChange={(e) => set(e.currentTarget.value)} />
        </label>
      )
    }
    return (
      <label key={name} data-signal={name} style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
        <span>{label}</span>
        <input
          type={input === 'number' ? 'number' : 'text'}
          aria-label={label}
          value={String(value ?? '')}
          onChange={(e) => set(input === 'number' ? Number(e.currentTarget.value) : e.currentTarget.value)}
        />
      </label>
    )
  }
  return (
    <div
      data-testid="chart-binds"
      data-aster-binds=""
      style={{
        position: 'relative', zIndex: 2, display: 'flex', flexWrap: 'wrap', gap: 12,
        alignItems: 'center', padding: '6px 8px', fontSize: 12,
      }}
    >
      {defs.map(control)}
    </div>
  )
}

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
  sceneOverride,
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
  denseMarks = 'auto',
  signalListeners,
  onSignal,
  onStreamInput,
  interactive = true,
  tooltip = false,
  renderTooltip,
  limits,
  textMetrics,
  a11y = true,
  onError,
  chartRef,
}: Omit<ChartProps, 'spec'> & { spec: VgSpec; chartRef: React.ForwardedRef<ChartHandle> }) {
  // Content-stable: a parent that rebuilds an inline spec literal every render
  // neither recompiles (Vega-Lite) nor re-evaluates.
  const stableSpec = useStableSpec(rawSpec)
  const spec = React.useMemo(() => normalizeChartSpec(stableSpec), [stableSpec])
  const stableLimits = useStableContent(limits)
  // Which scales `view`/`brush`/`selection`'s `x`/`y` refer to.
  const positional = React.useMemo(() => positionalScales(spec), [spec])
  const tooltipEnabled = tooltip || renderTooltip != null
  const containerRef = React.useRef<HTMLDivElement>(null)
  // `null` until measured: the spec's own size renders meanwhile (and on the server).
  const [measured, setMeasured] = React.useState<{ width: number; height: number } | null>(null)

  // Interaction state
  const [dragRect, setDragRect] = React.useState<{ x: number; y: number; width: number; height: number } | null>(null)
  const [tooltipInfo, setTooltipInfo] = React.useState<{ datum: Record<string, unknown>; x: number; y: number } | null>(null)
  const [internalView, setInternalView] = React.useState<ViewDomain | null>(null)
  const [internalSelection, setInternalSelection] = React.useState<SelectValue | null>(null)
  const [hiddenLegend, setHiddenLegend] = React.useState<Map<string, HiddenLegendEntry>>(() => new Map())
  const [activeA11yId, setActiveA11yId] = React.useState<string | null>(null)

  // Props that only fire from callbacks are read through refs, so the handlers
  // that use them keep a stable identity.
  const onErrorRef = React.useRef(onError)
  onErrorRef.current = onError
  const signalListenersRef = React.useRef(signalListeners)
  signalListenersRef.current = signalListeners
  const onSignalRef = React.useRef(onSignal)
  onSignalRef.current = onSignal
  const onStreamInputRef = React.useRef(onStreamInput)
  onStreamInputRef.current = onStreamInput

  const needsMeasure = width == null || height == null
  React.useEffect(() => {
    if (!needsMeasure) return
    const el = containerRef.current
    if (!el) return
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver((entries) => {
        const { width: w, height: h } = entries[0]?.contentRect ?? {}
        if (w && h) setMeasured((prev) => (prev && prev.width === w && prev.height === h ? prev : { width: w, height: h }))
      })
      observer.observe(el)
      return () => observer.disconnect()
    }
  }, [needsMeasure])

  const renderWidth = width ?? measured?.width
  const renderHeight = height ?? measured?.height

  // `panZoom` enables both; `pan`/`zoom` enable one gesture family each.
  const panEnabled = panZoom || pan
  const zoomEnabled = panZoom || zoom
  const panZoomEnabled = panEnabled || zoomEnabled

  // Session caches scene across renders whose inputs are unchanged (fresh
  // spec object with identical content costs nothing), mirroring Vega's
  // "skip work when nothing is dirty" behavior.
  const sessionRef = React.useRef<ReturnType<typeof createChartSession> | null>(null)
  if (sessionRef.current == null) sessionRef.current = createChartSession()
  const sceneRef = React.useRef<SceneRoot | null>(null)

  const currentView = controlledView !== undefined ? controlledView : internalView
  const viewRef = React.useRef(currentView)
  viewRef.current = currentView
  const domainRaw = React.useMemo(() => viewToDomainRaw(currentView, positional), [currentView, positional])

  const signalStoreRef = React.useRef<SignalStore | null>(null)
  if (signalStoreRef.current == null) signalStoreRef.current = createSignalStore()
  const signalStore = signalStoreRef.current
  const eventSignals = React.useSyncExternalStore(signalStore.subscribe, signalStore.get, signalStore.get)
  const mergedSignals = React.useMemo(
    () => ({ ...(signals ?? {}), ...eventSignals }),
    [signals, eventSignals],
  )
  const bindDefs = React.useMemo(
    () => ((spec.signals as SignalBindDef[] | undefined) ?? []).filter((s) => s && s.bind != null),
    [spec],
  )

  // Row counts of the previously evaluated `data`, to validate `dataChanges`.
  const prevLengthsRef = React.useRef<Map<string, number>>(new Map())
  const evaluation = React.useMemo<{ scene: SceneRoot | null; error: Error | null; problems: string[] }>(() => {
    // Datum attributes must be on the scene items BEFORE the DOM is built:
    // tooltips and the `signal.on` event loop both read `data-datum` off the
    // rendered elements, and stamping afterwards (as the bind effect used to)
    // leaves the first render without them, so mark events never saw a datum.
    const wantsDatumAttrs = (sc: SceneRoot): boolean => tooltipEnabled || (interactive && renderer !== 'canvas' && hasEventStreams(sc))
    if (sceneOverride !== undefined) {
      if (sceneOverride != null && wantsDatumAttrs(sceneOverride)) stampDatumAttrs(sceneOverride.items)
      return { scene: sceneOverride, error: null, problems: [] }
    }
    try {
      const { changes, problems } = validateDataChanges(dataChanges, data, prevLengthsRef.current)
      prevLengthsRef.current = new Map(Object.entries(data ?? {}).map(([name, rows]) => [name, rows.length]))
      const sc = sessionRef.current!.evaluate(spec, {
        data, dataChanges: changes, width: renderWidth, height: renderHeight,
        signals: mergedSignals, limits: stableLimits, domainRaw, textMetrics,
      })
      if (wantsDatumAttrs(sc)) stampDatumAttrs(sc.items)
      return { scene: sc, error: null, problems }
    } catch (err) {
      return { scene: null, error: err instanceof Error ? err : new Error(String(err)), problems: [] }
    }
  }, [sceneOverride, spec, data, dataChanges, renderWidth, renderHeight, mergedSignals, tooltipEnabled, interactive, renderer, stableLimits, domainRaw, textMetrics])
  const scene = evaluation.scene
  sceneRef.current = scene
  const renderError = evaluation.error

  const displayScene = React.useMemo(
    () => scene ? filterLegendScene(scene, hiddenLegend.values()) : null,
    [scene, hiddenLegend],
  )
  // Dense SVG marks: batched `<path>` chunks instead of one element per datum.
  // `'auto'` stays out of the way when the spec binds mark events (`signal.on`),
  // because those resolve their datum from per-item DOM nodes.
  const denseRequested = denseMarks === true || denseMarks === 'auto'
  const denseAllowed = React.useMemo(() => {
    if (!denseRequested) return false
    if (denseMarks === true) return true
    const signalDefs = (scene as { compiled?: { signalDefs?: Array<{ on?: unknown[] }> } } | null)?.compiled?.signalDefs
    return !signalDefs?.some((d) => (d.on?.length ?? 0) > 0)
  }, [denseRequested, denseMarks, scene])
  const denseSvg = denseAllowed && renderer === 'svg' && (scene != null ? hasDenseSymbolMarks(scene) : false)
  const hydrating = React.useSyncExternalStore(subscribeNothing, clientOnly, serverOrHydrating)

  // One report per evaluation, however often the component re-renders while
  // the same error persists (an inline `onError` must not refire).
  React.useEffect(() => {
    if (evaluation.error) onErrorRef.current?.(evaluation.error)
    for (const problem of evaluation.problems) onErrorRef.current?.(new Error(`[aster] ${problem}`))
  }, [evaluation])

  // Chart metadata comes straight from the evaluated scene. Doing a second
  // compile+evaluate per render was the whole cost of an identical-content
  // re-render; scene-derived info is free when the session returns its cached
  // scene. A scene that crossed a structured clone (worker stream) has no live
  // scales: the worker attached invertible descriptions of the continuous ones.
  const chartInfo = React.useMemo<ChartInfo | null>(() => {
    if (scene == null) return null
    const info = chartInfoFromScene(scene)
    if (info.scales.size > 0) return info
    const serialized = (scene as unknown as Record<string, unknown>)[SCALE_INFO_KEY]
    return Array.isArray(serialized) ? { ...info, scales: scalesFromSerialized(serialized as SerializedScale[]) } : info
  }, [scene])
  const chartInfoRef = React.useRef<ChartInfo | null>(null)
  chartInfoRef.current = chartInfo

  // Base domains (before any pan/zoom) let a controlled view be clamped and
  // reset. Without a view the evaluated scene IS the base. While zoomed, the
  // unzoomed domains come from a second evaluation of the same inputs minus the
  // override (cached by its own session, so only data/size changes re-run it).
  // A stream-fed scene cannot be re-evaluated here (its rows live in the
  // stream), so it keeps the domains of the last unzoomed scene.
  const baseSessionRef = React.useRef<ReturnType<typeof createChartSession> | null>(null)
  const lastBaseRef = React.useRef<ViewDomain>({})
  const baseDomains = React.useMemo<ViewDomain>(() => {
    if (!panZoomEnabled || chartInfo == null) return {}
    if (domainRaw == null) return baseDomainsOf(chartInfo, positional)
    if (sceneOverride !== undefined) return { ...baseDomainsOf(chartInfo, positional), ...lastBaseRef.current }
    try {
      if (baseSessionRef.current == null) baseSessionRef.current = createChartSession()
      const baseScene = baseSessionRef.current.evaluate(spec, {
        data, width: renderWidth, height: renderHeight, signals: mergedSignals, limits: stableLimits, textMetrics,
      })
      return baseDomainsOf(chartInfoFromScene(baseScene), positional)
    } catch {
      return lastBaseRef.current
    }
  }, [panZoomEnabled, chartInfo, domainRaw, sceneOverride, positional, spec, data, renderWidth, renderHeight, mergedSignals, stableLimits, textMetrics])
  const baseDomainsRef = React.useRef(baseDomains)
  baseDomainsRef.current = baseDomains
  if (domainRaw == null) lastBaseRef.current = baseDomains

  const applyView = React.useCallback((next: ViewDomain | null) => {
    const normalized = next == null ? null : normalizeView(next, baseDomainsRef.current)
    if (controlledView === undefined) setInternalView(normalized)
    onViewChange?.(normalized)
  }, [controlledView, onViewChange])
  const applyViewRef = React.useRef(applyView)
  applyViewRef.current = applyView

  // A stream-fed chart hands its view/signals to the stream, which re-evaluates.
  const streamInput = sceneOverride !== undefined
  React.useEffect(() => {
    if (streamInput) onStreamInputRef.current?.({ ...(domainRaw ? { domainRaw } : {}), signals: mergedSignals })
  }, [streamInput, domainRaw, mergedSignals])

  // Incremental is the default: we still serialize the full SVG for the first
  // render (so server output and client hydration carry the markup), then the
  // patcher owns the <svg> and we stop re-serializing on later updates.
  const hasPatchedRef = React.useRef(false)
  // The markup travels as one `{ __html }` object whose IDENTITY is what React
  // compares (it re-parses on a new object even for an equal string, and CLEARS
  // the element's children when the prop disappears). So after the first commit
  // the same object keeps being passed (see `htmlProp`) instead of dropping the
  // prop, which would wipe the <svg> the patcher owns and force a rebuild.
  const markupBox = React.useMemo<{ __html: string } | null>(() => {
    if (displayScene == null) return null
    if (renderer === 'canvas') return null
    // Streaming scenes are client-owned once mounted: create the DOM once in the
    // layout effect and patch it afterwards, so a changed markup string never
    // replaces the patched <svg> on a streamed frame. While rendering for the
    // server (or hydrating that server output) the full markup is emitted like
    // any other chart (ADR 0003), so a stream's first frame is in the HTML.
    if (sceneOverride !== undefined && !hydrating) return null
    if (denseSvg && !hydrating) return null
    if (incremental && hasPatchedRef.current) return null
    return { __html: renderSceneToSvg(displayScene) }
  }, [incremental, renderer, displayScene, sceneOverride, denseSvg, hydrating])
  const lastBoxRef = React.useRef<{ __html: string } | null>(null)
  if (markupBox != null) lastBoxRef.current = markupBox
  // After the first commit the patcher owns the DOM. `domMarkup` is non-null
  // only for a commit that parsed fresh markup from the current scene.
  const domMarkup = incremental && hasPatchedRef.current ? null : (markupBox?.__html ?? null)
  const htmlProp = markupBox ?? (incremental && hasPatchedRef.current ? lastBoxRef.current : null)

  // Scene whose DOM we know is current (rendered as markup or patched here).
  const domSceneRef = React.useRef<SceneRoot | null>(null)
  // Whether that DOM is batched (dense) — a mode switch needs a patch even when
  // the scene object itself did not change.
  const domDenseRef = React.useRef(false)
  const svgHostRef = React.useRef<HTMLDivElement>(null)
  const canvasRef = React.useRef<HTMLCanvasElement>(null)
  // Last canvas frame: append-only scenes paint only the new mark items.
  const canvasSnapshotRef = React.useRef<CanvasSceneSnapshot | null>(null)
  // Scene whose pixels are on the canvas (skip repaints for identical scenes).
  const canvasSceneRef = React.useRef<SceneRoot | null>(null)
  // The canvas element those two describe: a remounted element is blank.
  const canvasElRef = React.useRef<HTMLCanvasElement | null>(null)
  // Hit testing (canvas, batched dense marks, clicks) resolves marks through the
  // scene hit index, rebuilt only when the displayed scene object changes.
  const hitIndexRef = React.useRef<{ scene: SceneRoot | null; index: HitIndex | null }>({ scene: null, index: null })
  const hitIndexFor = React.useCallback((target: SceneRoot | null): HitIndex | null => {
    if (target == null) return null
    if (hitIndexRef.current.scene !== target) hitIndexRef.current = { scene: target, index: buildHitIndex(target) }
    return hitIndexRef.current.index
  }, [])
  // Signal state lives in an external store consumed with useSyncExternalStore:
  // an event is a normal, synchronous state transition with a stable snapshot,
  // so concurrent renders never observe a half-applied signal set.
  React.useEffect(() => {
    if (signals) signalStore.merge(signals)
  }, [signals, signalStore])
  // Incremental updates: create the <svg> once, then patch changed attributes
  // in place instead of re-serializing and re-parsing the whole markup every render.
  // `renderer` is a dependency: switching back from canvas mounts a fresh, empty
  // host element that must be filled even though the scene did not change.
  React.useLayoutEffect(() => {
    if (!displayScene || renderer === 'canvas') return
    // A sceneOverride still needs its DOM created: stream markup is client-owned
    // (no dangerouslySetInnerHTML), so the first frame builds the element here.
    if (!incremental && sceneOverride === undefined) return
    const host = svgHostRef.current
    if (!host) return
    // This commit rendered the full SVG from this exact scene and the browser
    // just parsed it, so the tree already matches. Re-walking it with the
    // patcher would be pure cost — and it is O(all items), the worst place to
    // pay it (mount is where a large scene hurts most).
    if (domMarkup != null) {
      hasPatchedRef.current = true
      domSceneRef.current = displayScene
      domDenseRef.current = false // string markup is always per-item
      // React has committed the string; never keep a large copy alive (and a
      // later remount of the host starts empty and is filled below).
      if (markupBox != null && incremental) markupBox.__html = ''
      return
    }
    const existing = host.firstElementChild
    if (incremental && existing && existing.tagName.toLowerCase() === 'svg') {
      // Patch when the scene changed, or when the render mode flipped (e.g. a
      // client-only dense mount, or hydration handing over to batched marks).
      if (domSceneRef.current !== displayScene || domDenseRef.current !== denseSvg) {
        patchSceneDom(existing, displayScene, { denseMarks: denseSvg })
        domDenseRef.current = denseSvg
      }
    } else {
      host.replaceChildren(renderSceneToDomElement(displayScene, document, { denseMarks: denseSvg }))
      domDenseRef.current = denseSvg
    }
    domSceneRef.current = displayScene
    hasPatchedRef.current = true
  }, [incremental, renderer, displayScene, sceneOverride, domMarkup, denseSvg])

  // Spec-driven signal event loop (SVG only). Rebinds when the DOM, the scene
  // or the signal values change — not on unrelated renders.
  const signalBindingRef = React.useRef<SignalBinding | null>(null)
  const hasSignalListeners = signalListeners != null || onSignal != null
  React.useLayoutEffect(() => {
    if (!interactive || !scene || renderer === 'canvas') return
    const host = svgHostRef.current
    const svg = (host?.firstElementChild as SVGSVGElement | null) ?? null
    if (!svg) return
    const signalDefs = (scene as unknown as { compiled?: { signalDefs?: Array<{ on?: unknown[] }> } }).compiled?.signalDefs
    const hasStreams = signalDefs?.some((d) => d.on?.length) ?? false
    // Bind when there is anything to drive/listen to, or when any signal exists
    // so ChartHandle.setSignal works on a purely imperative spec.
    if (!hasStreams && !hasSignalListeners && !signalDefs?.length) return
    // The binding mutates the signal object it is given: hand it a copy.
    const binding = bindSceneSignals(svg, scene, { ...mergedSignals }, {
      onSignal: (name, value, all) => {
        signalStore.set(all)
        signalListenersRef.current?.[name]?.(name, value)
        onSignalRef.current?.(name, value)
      },
    })
    signalBindingRef.current = binding
    return () => {
      binding.detach()
      if (signalBindingRef.current === binding) signalBindingRef.current = null
    }
  }, [interactive, scene, displayScene, renderer, domMarkup, denseSvg, hasSignalListeners, mergedSignals, signalStore])

  // Canvas backend: size the backing store for devicePixelRatio and redraw the
  // whole scene whenever it changes (cheap relative to SVG serialization for
  // dense marks; no listeners to leak — every redraw is a full repaint).
  React.useLayoutEffect(() => {
    if (renderer !== 'canvas' || !displayScene) return
    const canvas = canvasRef.current
    if (!canvas) return
    if (canvasElRef.current !== canvas) {
      // A new <canvas> (first mount, or back from the SVG renderer) is blank.
      canvasElRef.current = canvas
      canvasSnapshotRef.current = null
      canvasSceneRef.current = null
    }
    const dpr = typeof window !== 'undefined' && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1
    const w = Math.max(1, Math.round(displayScene.width))
    const h = Math.max(1, Math.round(displayScene.height))
    let resized = false
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
      resized = true
    }
    // Identical scene: the canvas already shows it. Re-encoding/painting would
    // be a full repaint for zero visual change (the common no-op re-render).
    if (!resized && canvasSceneRef.current === displayScene) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    // Append-only frames draw immediately: a handful of new items is cheaper
    // than a frame of latency, and drawing synchronously prevents a later
    // stream mutation from racing a coalesced rAF repaint. Full repaints still
    // go through rAF so they never block React's commit.
    const prev = resized ? null : canvasSnapshotRef.current
    if (prev != null && renderSceneToCanvasAppend(prev, displayScene, ctx, { dpr })) {
      canvasSnapshotRef.current = snapshotCanvasScene(displayScene)
      canvasSceneRef.current = displayScene
      return
    }
    const draw = (): void => {
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      renderSceneToCanvas(displayScene, ctx, { dpr })
      canvasSnapshotRef.current = snapshotCanvasScene(displayScene)
      canvasSceneRef.current = displayScene
    }
    if (typeof requestAnimationFrame === 'function') {
      const id = requestAnimationFrame(draw)
      return () => cancelAnimationFrame(id)
    }
    draw()
  }, [renderer, displayScene])

  const hasSelection = onSelect != null || brush != null || onPointSelect != null
    || selection !== undefined || onSelectionChange != null
  const hasInteraction = hasSelection || panZoomEnabled

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

  // Latest gesture inputs, read by the stable pointer handlers below.
  const gestureInputs = {
    hasInteraction, hasSelection, panEnabled, zoomEnabled, displayScene, positional, maxZoom,
    onSelect, onPointSelect, onSelectionChange,
  }
  const gestureInputsRef = React.useRef(gestureInputs)
  gestureInputsRef.current = gestureInputs

  // --- pan/zoom gestures ---------------------------------------------------
  const gestureRef = React.useRef<'select' | 'pan' | null>(null)
  const gestureStartRef = React.useRef<{ x: number; y: number } | null>(null)
  const dragRef = React.useRef<{ start: { x: number; y: number }; end: { x: number; y: number } } | null>(null)
  const capturedRef = React.useRef<number | null>(null)
  const panLastRef = React.useRef<{ x: number; y: number } | null>(null)
  const pointersRef = React.useRef<Map<number, { x: number; y: number }>>(new Map())
  const pinchRef = React.useRef<{ dist: number; cx: number; cy: number } | null>(null)

  const zoomAxes = React.useCallback((axes: Array<'x' | 'y'>, px: number, py: number, factor: number) => {
    const info = chartInfoRef.current
    if (!info) return
    const base = baseDomainsRef.current
    const names = gestureInputsRef.current.positional
    const max = gestureInputsRef.current.maxZoom
    const next: ViewDomain = { ...(viewRef.current ?? {}) }
    let changed = false
    for (const axis of axes) {
      const name = names[axis]
      const scale = (name != null ? info.scales.get(name) : undefined) as { invert?: (v: number) => number } | undefined
      if (typeof scale?.invert !== 'function') continue
      const local = axis === 'x' ? px - info.padding.left : py - info.padding.top
      const anchor = scale.invert(local)
      if (!Number.isFinite(anchor)) continue
      // Compose both axes into one update: a controlled host receives one view
      // value per gesture, not x from one call and y from a stale snapshot.
      const current = next[axis] ?? base[axis]
      if (!current) continue
      const zoomed = zoomDomain(current, anchor, factor, base[axis] ? Math.abs(base[axis]![1] - base[axis]![0]) / Math.max(1, max) : undefined)
      const b = base[axis]
      if (b && Math.abs(zoomed[1] - zoomed[0]) > Math.abs(b[1] - b[0])) continue
      next[axis] = zoomed
      changed = true
    }
    if (changed) applyViewRef.current(next)
  }, [])

  React.useEffect(() => {
    if (!zoomEnabled) return
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
  }, [zoomEnabled, zoomAxes])

  // Pointer gestures live on the container, so the marks underneath keep
  // receiving their own events (tooltips, `signal.on`, bound inputs). Pointer
  // capture is taken only once a drag actually starts, so a plain click still
  // targets the mark.
  const endGesture = React.useCallback((e: React.PointerEvent): void => {
    pointersRef.current.delete(e.pointerId)
    if (pointersRef.current.size < 2) pinchRef.current = null
    gestureRef.current = null
    gestureStartRef.current = null
    panLastRef.current = null
    dragRef.current = null
    setDragRect(null)
    if (capturedRef.current != null) {
      try { containerRef.current?.releasePointerCapture?.(capturedRef.current) } catch { /* already released */ }
      capturedRef.current = null
    }
  }, [])

  const handlePointerDown = React.useCallback((e: React.PointerEvent) => {
    const g = gestureInputsRef.current
    if (!g.hasInteraction) return
    // Bound inputs and other form controls own their pointer input.
    if ((e.target as Element | null)?.closest?.('[data-aster-binds], input, select, textarea, button, a')) return
    if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 1) return
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    pointersRef.current.set(e.pointerId, { x, y })
    if (pointersRef.current.size === 2) {
      if (g.zoomEnabled) {
        const [a, b] = [...pointersRef.current.values()]
        pinchRef.current = { dist: Math.hypot(a!.x - b!.x, a!.y - b!.y), cx: (a!.x + b!.x) / 2, cy: (a!.y + b!.y) / 2 }
      }
      gestureRef.current = null
      dragRef.current = null
      setDragRect(null)
      return
    }
    // Shift/middle-button pans; a plain drag brushes when a selection handler exists.
    const wantsPan = g.panEnabled && (!g.hasSelection || e.shiftKey || e.button === 1)
    gestureRef.current = wantsPan ? 'pan' : g.hasSelection ? 'select' : g.panEnabled ? 'pan' : null
    gestureStartRef.current = { x, y }
    if (gestureRef.current === 'pan') {
      panLastRef.current = { x, y }
    } else if (gestureRef.current === 'select') {
      dragRef.current = { start: { x, y }, end: { x, y } }
      setDragRect({ x, y, width: 0, height: 0 })
    }
  }, [])

  const handlePointerMove = React.useCallback((e: React.PointerEvent) => {
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    const g = gestureInputsRef.current
    if (pointersRef.current.has(e.pointerId)) pointersRef.current.set(e.pointerId, { x, y })
    if (pinchRef.current && pointersRef.current.size === 2) {
      const [a, b] = [...pointersRef.current.values()]
      const dist = Math.hypot(a!.x - b!.x, a!.y - b!.y)
      const cx = (a!.x + b!.x) / 2
      const cy = (a!.y + b!.y) / 2
      const prev = pinchRef.current
      if (prev.dist > 0 && dist > 0) zoomAxes(['x', 'y'], cx, cy, dist / prev.dist)
      pinchRef.current = { dist, cx, cy }
      return
    }
    const gesture = gestureRef.current
    if (gesture == null || !g.hasInteraction) return
    // The button was released where we could not see it (outside the
    // container, before capture): abandon the gesture instead of sticking to it.
    if (e.pointerType === 'mouse' && e.buttons === 0) {
      endGesture(e)
      return
    }
    const start = gestureStartRef.current
    if (capturedRef.current == null && start && Math.hypot(x - start.x, y - start.y) >= 3) {
      try {
        containerRef.current?.setPointerCapture?.(e.pointerId)
        capturedRef.current = e.pointerId
      } catch { /* synthetic pointer */ }
    }
    if (gesture === 'pan') {
      const last = panLastRef.current
      const info = chartInfoRef.current
      if (!last || !info) return
      const base = baseDomainsRef.current
      const current = viewRef.current
      const next: ViewDomain = { ...(current ?? {}) }
      // Move the data with the pointer: the domain shifts against the drag along
      // the scale's own orientation (a y scale running bottom-to-top inverts it).
      const shift = (axis: 'x' | 'y', delta: number, plot: number): void => {
        const baseDomain = base[axis]
        if (!baseDomain || delta === 0) return
        const d = (current?.[axis] ?? baseDomain) as [number, number]
        const name = g.positional[axis]
        const span = pixelSpanOf(name != null ? info.scales.get(name) : undefined, d) ?? plot
        next[axis] = panDomain(d, -delta / span)
      }
      shift('x', x - last.x, Math.max(1, info.width))
      shift('y', y - last.y, Math.max(1, info.height))
      panLastRef.current = { x, y }
      applyViewRef.current(next)
      return
    }
    const drag = dragRef.current
    if (gesture === 'select' && drag != null) {
      drag.end = { x, y }
      setDragRect({
        x: Math.min(drag.start.x, x), y: Math.min(drag.start.y, y),
        width: Math.abs(x - drag.start.x), height: Math.abs(y - drag.start.y),
      })
    }
  }, [zoomAxes, endGesture])

  const handlePointerUp = React.useCallback((e: React.PointerEvent) => {
    const g = gestureInputsRef.current
    const gesture = gestureRef.current
    const drag = dragRef.current
    const rect = containerRef.current?.getBoundingClientRect()
    if (gesture === 'select' && drag != null && rect) {
      const x = e.clientX - rect.left
      const y = e.clientY - rect.top
      const dx = x - drag.start.x
      const dy = y - drag.start.y
      if (Math.abs(dx) < 3 && Math.abs(dy) < 3) {
        // Tiny drag -> a click: resolve the mark under the pointer and clear
        // any interval selection.
        let datum: Record<string, unknown> | null = null
        if (g.onPointSelect || g.onSelectionChange != null) {
          const target = hitIndexFor(g.displayScene)?.queryMark(x, y)
          const raw = target?.item.datum
          datum = raw != null && typeof raw === 'object' ? raw as Record<string, unknown> : null
          g.onPointSelect?.(datum)
        }
        g.onSelect?.(null)
        if (g.onPointSelect || g.onSelectionChange != null) emitSelectionRef.current({ type: 'point', datum })
      } else {
        const ci = chartInfoRef.current
        if (ci) {
          const interval = dragToDataInterval(drag.start, { x, y }, ci, g.positional)
          g.onSelect?.(interval)
          emitSelectionRef.current({ type: 'interval', interval })
        }
      }
    }
    endGesture(e)
  }, [endGesture, hitIndexFor])

  // --- accessibility -------------------------------------------------------
  const a11yOpts = React.useMemo(
    () => {
      const base = a11yTreeOptions(a11y, ariaLabel, selectionValue)
      if (base == null) return null
      return { ...base, isLegendEntryHidden: (key: string) => hiddenLegend.has(key) }
    },
    [a11y, ariaLabel, selectionValue, hiddenLegend],
  )
  const a11yTree = React.useMemo(() => {
    if (!displayScene || a11yOpts == null) return null
    // Live scales when the scene has them; otherwise the serialized snapshots
    // on the scene (worker clones) are used by buildA11yTree itself.
    const live = (displayScene as { __scaleMap?: unknown }).__scaleMap !== undefined
    const scales = (live ? chartInfo?.scales : undefined) ?? new Map()
    return buildA11yTree(displayScene, scales as Map<string, unknown>, a11yOpts)
  }, [displayScene, a11yOpts, chartInfo])
  const a11yNodesRef = React.useRef<A11yNode[]>([])
  a11yNodesRef.current = a11yTree?.nodes ?? []
  // Roving tabindex: exactly one node is a tab stop (the last focused one, else
  // the first); arrows / PageUp / PageDown move between nodes.
  const a11yNodes = a11yTree?.nodes
  const tabStopId = a11yNodes?.some((n) => n.id === activeA11yId) ? activeA11yId : (a11yNodes?.[0]?.id ?? null)

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
    setActiveA11yId(next.id)
    const el = host.querySelector<HTMLElement>(`[data-a11y-id="${next.id}"]`)
    el?.focus()
  }, [])

  const handleA11yKeyDown = React.useCallback((node: A11yNode, e: React.KeyboardEvent) => {
    if (!isA11yNodeKey(e.key)) return
    const g = gestureInputsRef.current
    const base = baseDomainsRef.current
    const swallow = (): void => { e.preventDefault(); e.stopPropagation() }
    // Every node: PageUp/PageDown move along the tree (arrows are taken by the
    // axis sliders for panning, so they cannot be the only way out of one).
    if (e.key === 'PageDown') { swallow(); moveA11yFocus(node, 1); return }
    if (e.key === 'PageUp') { swallow(); moveA11yFocus(node, -1); return }
    if (node.kind === 'legend-entry' && node.legendKey) {
      if (e.key === 'Enter' || e.key === ' ') {
        swallow()
        const key = node.legendKey
        setHiddenLegend((prev) => {
          const next = new Map(prev)
          if (next.has(key)) next.delete(key)
          else next.set(key, { key, ...(node.legendColor ? { color: node.legendColor } : {}), ...(node.legendShape ? { shape: node.legendShape } : {}) })
          return next
        })
        return
      }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { swallow(); moveA11yFocus(node, -1); return }
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { swallow(); moveA11yFocus(node, 1); return }
      return
    }
    if (node.kind === 'mark') {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { swallow(); moveA11yFocus(node, -1); return }
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { swallow(); moveA11yFocus(node, 1); return }
      if (e.key === 'Home') { swallow(); moveA11yFocus(node, 'first'); return }
      if (e.key === 'End') { swallow(); moveA11yFocus(node, 'last'); return }
      if (e.key === 'Enter' || e.key === ' ') {
        swallow()
        const datum = (node.datum != null && typeof node.datum === 'object') ? node.datum as Record<string, unknown> : null
        g.onPointSelect?.(datum)
        g.onSelect?.(null)
        emitSelectionRef.current({ type: 'point', datum })
      }
      return
    }
    if (node.kind === 'axis' && node.scale && node.domain) {
      // The slider drives the horizontal or vertical positional scale it shows.
      const axis: 'x' | 'y' | null = node.scale === g.positional.y ? 'y' : node.scale === g.positional.x ? 'x' : null
      if (axis == null || !g.panEnabled && !g.zoomEnabled) return
      const result = keyboardView(e.key, viewRef.current, base, { axis, fast: e.shiftKey, pan: g.panEnabled, zoom: g.zoomEnabled })
      if (result.handled) {
        swallow()
        applyViewRef.current(result.view ?? null)
      }
      return
    }
    if (node.kind === 'legend' || node.kind === 'title') {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { swallow(); moveA11yFocus(node, -1) }
      else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { swallow(); moveA11yFocus(node, 1) }
    }
  }, [moveA11yFocus])

  const handleChartKeyDown = React.useCallback((e: React.KeyboardEvent) => {
    if (e.defaultPrevented) return
    const g = gestureInputsRef.current
    if (e.key === 'Escape') {
      emitSelectionRef.current(null)
      g.onSelect?.(null)
      g.onPointSelect?.(null)
      return
    }
    if (!g.panEnabled && !g.zoomEnabled) return
    const result = keyboardView(e.key, viewRef.current, baseDomainsRef.current, { fast: e.shiftKey, pan: g.panEnabled, zoom: g.zoomEnabled })
    if (result.handled) {
      e.preventDefault()
      applyViewRef.current(result.view ?? null)
    }
  }, [])

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
      if (renderer === 'canvas' || denseSvg) {
        // Canvas backend (and batched SVG marks): resolve through the scene hit index.
        const target = hitIndexFor(displayScene)?.queryMark(e.clientX - rect.left, e.clientY - rect.top)
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
    [tooltipEnabled, renderer, denseSvg, displayScene, hitIndexFor],
  )

  const handleTooltipLeave = React.useCallback(() => {
    if (tooltipEnabled) setTooltipInfo(null)
  }, [tooltipEnabled])

  // Persisted selection rectangle: the legacy `brush` prop, else the interval
  // of the (controlled or internal) selection value.
  const persistedInterval = brush ?? selectValueToInterval(selectionValue)
  const brushPixelRect = React.useMemo(() => {
    if (!persistedInterval || chartInfo == null) return null
    return selectionToPixels(persistedInterval, chartInfo, positional)
  }, [persistedInterval, chartInfo, positional])

  // --- imperative handle (R11.1) ------------------------------------------
  React.useImperativeHandle(chartRef, () => ({
    getScene: () => sceneRef.current,
    getSvg: () => (sceneRef.current ? renderSceneToSvg(sceneRef.current) : null),
    getChartInfo: () => chartInfoRef.current,
    getView: () => viewRef.current ?? null,
    setView: (next) => applyViewRef.current(next),
    resetView: () => applyViewRef.current(null),
    // Portable: with the SVG event loop bound it runs the spec's dependent
    // signal updates; otherwise (canvas, `interactive={false}`) the value is
    // applied as a signal override. Listeners are notified either way.
    setSignal: (name, value) => {
      const binding = signalBindingRef.current
      if (binding) {
        binding.setSignal(name, value)
        return
      }
      signalStoreRef.current?.merge({ [name]: value })
      signalListenersRef.current?.[name]?.(name, value)
      onSignalRef.current?.(name, value)
    },
    getSignals: () => signalStoreRef.current?.get() ?? {},
  }), [])

  const setBoundSignal = React.useCallback((name: string, value: unknown): void => {
    const binding = signalBindingRef.current
    if (binding) {
      binding.setSignal(name, value)
      return
    }
    signalStore.merge({ [name]: value })
    signalListenersRef.current?.[name]?.(name, value)
    onSignalRef.current?.(name, value)
  }, [signalStore])

  if (scene === null) {
    const message = renderError instanceof AsterLimitError
      ? renderError.message
      : 'Chart render failed'
    return <div role="alert" style={style} title={renderError?.message}>{message}</div>
  }

  // Absolute-positioned children (tooltip, brush overlays, a11y nodes) need a
  // positioned ancestor even on a non-interactive chart. Without this the
  // tooltip positions against <body> and lands off-screen after scrolling.
  const needsPositioning = hasInteraction || tooltipEnabled || a11yTree != null
  const outerStyle: React.CSSProperties = needsPositioning
    ? { ...style, position: 'relative', width: '100%', height: '100%', ...(panZoomEnabled ? { touchAction: 'none' } : {}) }
    : { width: '100%', height: '100%', ...style }

  const role = a11yTree ? (ariaLabel ? 'group' : undefined) : ariaLabel ? 'img' : undefined
  // The rendered SVG sits inside the scene padding; guide/mark boxes from the
  // a11y tree are relative to the padded origin.
  const pad = displayScene?.padding ?? { top: 0, right: 0, bottom: 0, left: 0 }

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
      onPointerDown={hasInteraction ? handlePointerDown : undefined}
      onPointerMove={hasInteraction ? handlePointerMove : undefined}
      onPointerUp={hasInteraction ? handlePointerUp : undefined}
      onPointerCancel={hasInteraction ? endGesture : undefined}
      data-aster-view={currentView ? 'zoomed' : 'base'}
    >
      {hasInteraction && (
        // Draw-only layer: it never takes pointer events (the gestures are
        // handled on the container), so marks, tooltips, `signal.on` events
        // and bound inputs underneath stay reachable.
        <div data-testid="chart-brush-overlay"
          style={{ position: 'absolute', inset: 0, zIndex: 10, pointerEvents: 'none' }}
        >
          {/* Live drag overlay */}
          {dragRect != null && (
            <div
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
          {/* Persisted selection overlay */}
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
          aria-hidden={a11yTree != null ? true : undefined}
          style={{ position: 'relative', zIndex: 1, width: scene.width, height: scene.height, display: 'block' }}
        />
      ) : (
        <div
          ref={svgHostRef}
          aria-hidden={a11yTree != null ? true : undefined}
          style={{ position: 'relative', zIndex: 1 }}
          {...(htmlProp != null ? { dangerouslySetInnerHTML: htmlProp } : {})}
        />
      )}
      {bindDefs.length > 0 && (
        <SignalBinds
          signals={bindDefs}
          values={mergedSignals}
          onChange={setBoundSignal}
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
          {a11yTree.nodes.map((node) => {
            const slider = node.role === 'slider'
            const domRole = node.kind === 'title' ? 'heading'
              : slider ? 'slider'
                : node.kind === 'mark' || node.kind === 'legend-entry' ? 'button'
                  : 'img'
            return (
              <div
                key={node.id}
                data-a11y-id={node.id}
                data-a11y-kind={node.kind}
                role={domRole}
                aria-level={node.kind === 'title' ? 2 : undefined}
                aria-roledescription={node.roleDescription}
                aria-label={node.label}
                aria-pressed={node.kind === 'legend-entry' ? !!node.pressed
                  : node.kind === 'mark' && node.selected != null ? node.selected : undefined}
                aria-valuemin={slider ? node.domain?.[0] : undefined}
                aria-valuemax={slider ? node.domain?.[1] : undefined}
                aria-valuenow={slider && node.domain ? (node.domain[0] + node.domain[1]) / 2 : undefined}
                tabIndex={node.id === tabStopId ? 0 : -1}
                onKeyDown={(e) => handleA11yKeyDown(node, e)}
                style={{
                  position: 'absolute',
                  left: Math.max(0, pad.left + node.x),
                  top: Math.max(0, pad.top + node.y),
                  width: Math.max(1, node.width),
                  height: Math.max(1, node.height),
                  opacity: 0,
                  // Focusable by Tab/keyboard, but never steals pointer input from
                  // the marks underneath (selection, pan, tooltips).
                  pointerEvents: 'none',
                  borderRadius: 2,
                  outline: 'none',
                }}
                onFocus={(e) => { setActiveA11yId(node.id); e.currentTarget.style.opacity = '0.001' }}
                onBlur={(e) => { e.currentTarget.style.opacity = '0' }}
              />
            )
          })}
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
