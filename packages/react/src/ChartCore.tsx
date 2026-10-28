import * as React from 'react'
import {
  buildA11yTree,
  chartInfoFromScene,
  renderSceneToSvg,
  AsterLimitError,
  checkSvgLength,
  createPointMapper,
  resolveCursor,
  type A11yNode,
  type A11yOptions,
  type ChartInfo,
  type Logger,
  type SceneRoot,
  type VgSpec,
} from '@aster/core'
import { isPromiseLike, normalizeChartSpec, useStableContent, useStableSpecRows } from './spec.js'
import { useAddons } from './addons.js'
import { validateDataChanges } from './dataChanges.js'
import { SCALE_INFO_KEY, scalesFromSerialized, type SerializedScale } from './serialScales.js'
// The incremental DOM patcher ships as the `@aster/core/dom` addon, which every chart needs. The canvas
// renderer and the hit/signal event loop are NOT imported here: they arrive as the `canvas` and
// `interaction` props (see capabilities.ts), so `<SvgChart>` bundles neither.
import { createChartSession, hasDenseSymbolMarks, patchSceneDom, renderSceneToDomElement } from '@aster/core/dom'
import type { CanvasSceneSnapshot } from '@aster/core/canvas'
import type { HitIndex } from '@aster/core/hit'
import type { CursorTracker, SignalBinding } from '@aster/core/signals'
import type { CanvasCapability, InteractionCapability } from './capabilities.js'
import type { ChartHandle, ChartProps, ChartStreamInput } from './chart-types.js'
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


// ---------------------------------------------------------------------------
// Concurrent-safe signal store (R10.4)
// ---------------------------------------------------------------------------

interface SignalStore {
  get: () => Record<string, unknown>
  subscribe: (listener: () => void) => () => void
  set: (next: Record<string, unknown>) => void
  merge: (next: Record<string, unknown>) => void
  /** Empty the store without notifying (for a state derived from a render input). */
  reset: () => void
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
    reset() {
      if (Object.keys(snapshot).length) snapshot = {}
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

/** True when the spec has `signal.on` event streams. */
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

/**
 * Everything a chart is, with its optional capabilities injected as props. `<Chart>` and
 * `<SvgChart>` are one-line shells over this component (the anti-drift rule: there is no
 * second implementation to fall out of step; see `Chart.shells.test.ts`).
 */
export interface ChartCoreProps extends ChartProps {
  /** The canvas renderer. Absent: `renderer="canvas"` is reported and the chart renders as SVG. */
  canvas?: CanvasCapability
  /**
   * Hit testing and the signal event loop. Absent: tooltips, point selection, `signal.on`
   * event streams and `preventDefault` are unavailable and each use is reported (never silent).
   */
  interaction?: InteractionCapability
}

export const ChartCore = React.forwardRef<ChartHandle, ChartCoreProps>(function ChartCore(props, ref) {
  if (isPromiseLike<VgSpec>(props.spec)) {
    // Let the host's <Suspense> boundary own the fallback: an internal boundary
    // would mask it and always show our placeholder instead.
    return <AsyncChart {...props} spec={props.spec} chartRef={ref} />
  }
  return <ChartView {...props} spec={props.spec} chartRef={ref} />
})

function AsyncChart({ spec, chartRef, ...props }: Omit<ChartCoreProps, 'spec'> & { spec: PromiseLike<VgSpec>; chartRef: React.ForwardedRef<ChartHandle> }) {
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
  renderer: requestedRenderer = 'svg',
  denseMarks = 'auto',
  signalListeners,
  onSignal,
  onStreamInput,
  interactive = true,
  tooltip = false,
  renderTooltip,
  limits,
  urlPolicy,
  logger,
  preventDefault,
  textMetrics,
  a11y = true,
  onError,
  canvas: canvasCap,
  interaction,
  chartRef,
}: Omit<ChartCoreProps, 'spec'> & { spec: VgSpec; chartRef: React.ForwardedRef<ChartHandle> }) {
  // Content-stable: a parent that rebuilds an inline spec literal every render
  // neither recompiles (Vega-Lite) nor re-evaluates.
  const stableSpec = useStableSpecRows(rawSpec)
  const spec = React.useMemo(() => normalizeChartSpec(stableSpec), [stableSpec])
  // The opt-in add-ons the spec needs (transforms, geo, load) arrive before the first evaluation: this suspends while
  // they load, so there is no render of the half-ready chart and no error to flash. A failed import is a chart error.
  const addonError = useAddons(sceneOverride !== undefined ? null : spec)
  const stableLimits = useStableContent(limits)
  // Which scales `view`/`brush`/`selection`'s `x`/`y` refer to.
  const positional = React.useMemo(() => positionalScales(spec), [spec])
  // Without the interaction capability there is no hit index, so a tooltip
  // cannot resolve its datum: it stays off (and a JS caller that asked for one is told, below).
  const tooltipEnabled = interaction != null && (tooltip || renderTooltip != null)
  // Without the canvas capability the chart renders as SVG (and a JS caller that asked for canvas is told).
  const renderer = requestedRenderer === 'canvas' && canvasCap == null ? 'svg' : requestedRenderer
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

  // The size props FIX the view; the measured container only sizes a spec that does not drive its own `width` /
  // `height` signals (a bound slider, a handler, vega-lite's `"container"` keep doing so, as in Vega where
  // `view.width(w)` is a signal write and the later write wins). The container the spec is sized to
  // (`containerSize()`) is the props where given and the measured element for the rest.
  const sizedWidth = width ?? measured?.width
  const sizedHeight = height ?? measured?.height
  const containerSize = React.useMemo(
    () => (sizedWidth != null && sizedHeight != null ? { width: sizedWidth, height: sizedHeight } : undefined),
    [sizedWidth, sizedHeight],
  )
  const sizeInput = React.useMemo(
    () => ({
      ...(width != null ? { width } : {}), ...(height != null ? { height } : {}),
      ...(containerSize ? { containerSize } : {}), ...(measured ? { measuredSize: measured } : {}),
    }),
    [width, height, containerSize, measured],
  )
  // `containerSize()` in a handler (a `window:resize` one) reads the element as it is when the event fires, like
  // vega's `view.container().clientWidth`, not the size of the last render.
  const liveSizeRef = React.useRef<() => [number | undefined, number | undefined]>(() => [undefined, undefined])
  liveSizeRef.current = () => {
    const el = containerRef.current
    return [width ?? (el?.clientWidth || measured?.width), height ?? (el?.clientHeight || measured?.height)]
  }
  const liveContainerSize = React.useCallback(() => liveSizeRef.current(), [])

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
  // Datasets the spec's event handlers edit with `modify(...)` (a Vega-Lite selection's `<param>_store`): the
  // event loop reports their rows, which are kept here and handed back as inputs, so a store is a dataset like any
  // other and the evaluation after an edit is the one a fresh chart with those rows computes. They belong to the
  // spec they were edited under.
  const dataStoreRef = React.useRef<SignalStore | null>(null)
  if (dataStoreRef.current == null) dataStoreRef.current = createSignalStore()
  const dataStore = dataStoreRef.current
  const editedData = React.useSyncExternalStore(dataStore.subscribe, dataStore.get, dataStore.get) as Record<string, unknown[]>
  const inputData = React.useMemo(
    () => (Object.keys(editedData).length ? { ...(data ?? {}), ...editedData } : data),
    [data, editedData],
  )
  // The logger object may change every render; evaluation and the event loop see one stable proxy that
  // always calls the latest (a changing identity must not re-evaluate the chart).
  const loggerRef = React.useRef(logger)
  loggerRef.current = logger
  const hasLogger = logger != null
  const stableLogger = React.useMemo<Logger | undefined>(
    () => (hasLogger ? { error: (...a) => loggerRef.current?.error(...a), warn: (...a) => loggerRef.current?.warn(...a) } : undefined),
    [hasLogger],
  )
  const bindDefs = React.useMemo(
    () => ((spec.signals as SignalBindDef[] | undefined) ?? []).filter((s) => s && s.bind != null),
    [spec],
  )

  // Row counts of the previously evaluated `data`, to validate `dataChanges`.
  const prevLengthsRef = React.useRef<Map<string, number>>(new Map())
  const evaluation = React.useMemo<{ scene: SceneRoot | null; error: Error | null; problems: string[] }>(() => {
    if (sceneOverride !== undefined) {
      return { scene: sceneOverride, error: null, problems: [] }
    }
    if (addonError) return { scene: null, error: addonError, problems: [] }
    try {
      const { changes, problems } = validateDataChanges(dataChanges, inputData, prevLengthsRef.current)
      prevLengthsRef.current = new Map(Object.entries(inputData ?? {}).map(([name, rows]) => [name, rows.length]))
      const sc = sessionRef.current!.evaluate(spec, {
        data: inputData, dataChanges: changes, ...sizeInput,
        signals: mergedSignals, limits: stableLimits, urlPolicy, domainRaw, textMetrics, logger: stableLogger,
      })
      // `maxSvgLength` bounds the serialized output. The DOM patcher never
      // builds that string, so the budget is enforced by measuring one — only
      // when the host asked for it (it costs a serialization per evaluation).
      if (stableLimits?.maxSvgLength != null && renderer !== 'canvas') checkSvgLength(renderSceneToSvg(sc), stableLimits)
      return { scene: sc, error: null, problems }
    } catch (err) {
      return { scene: null, error: err instanceof Error ? err : new Error(String(err)), problems: [] }
    }
  }, [sceneOverride, addonError, spec, inputData, dataChanges, sizeInput, mergedSignals, stableLimits, urlPolicy, domainRaw, textMetrics, stableLogger])
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

  // A capability the caller needs but did not inject (plain `<SvgChart>`): the chart still renders what it can,
  // and every unavailable feature is REPORTED, like a rejected `dataChanges` changeset, never silently dead.
  // Types make the props a compile error; this is the net for JS callers and for specs whose event streams
  // are only known after evaluation. Reported through `onError`, else the logger, else the console.
  const eventStreamsUnbound = interaction == null && interactive && renderer !== 'canvas' && scene != null && hasEventStreams(scene)
  const interactionPropsUsed = interaction == null
    ? Object.entries({ tooltip: tooltip === true, renderTooltip, onPointSelect, selection, select, onSelectionChange, preventDefault: preventDefault === true })
      .filter(([, v]) => v !== undefined && v !== false).map(([k]) => k).join(', ')
    : ''
  const canvasUnavailable = requestedRenderer === 'canvas' && canvasCap == null
  const capabilityKey = `${canvasUnavailable ? 'c' : ''}|${interactionPropsUsed}|${eventStreamsUnbound ? 'e' : ''}`
  React.useEffect(() => {
    const fix = "pass interaction={interaction} from '@aster/react/interaction'"
    const problems = [
      canvasUnavailable && 'renderer="canvas" needs <Chart>: <SvgChart> has no canvas renderer, so it renders SVG',
      interactionPropsUsed && `${interactionPropsUsed} need hit testing and the signal event loop and are ignored: ${fix}`,
      eventStreamsUnbound && `this spec has event streams (signal.on) but no event loop is bound: ${fix}`,
    ]
    for (const problem of problems) {
      if (!problem) continue
      const message = `[aster] ${problem}`
      if (onErrorRef.current) onErrorRef.current(new Error(message))
      else (loggerRef.current ?? console).warn(message)
    }
    // Keyed on exactly what is reported: a new callback or an equal re-render does not re-report.
  }, [capabilityKey])

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
  const zoomed = domainRaw != null
  const fromStream = sceneOverride !== undefined
  // Only data/size/signal changes re-run the second evaluation, not every
  // pan/zoom frame (the view itself is not an input here).
  const unzoomedDomains = React.useMemo<ViewDomain | null>(() => {
    if (!panZoomEnabled || !zoomed || fromStream) return null
    try {
      if (baseSessionRef.current == null) baseSessionRef.current = createChartSession()
      const baseScene = baseSessionRef.current.evaluate(spec, {
        data: inputData, ...sizeInput, signals: mergedSignals, limits: stableLimits, urlPolicy, textMetrics, logger: stableLogger,
      })
      return baseDomainsOf(chartInfoFromScene(baseScene), positional)
    } catch {
      return null
    }
  }, [panZoomEnabled, zoomed, fromStream, positional, spec, inputData, sizeInput, mergedSignals, stableLimits, urlPolicy, textMetrics, stableLogger])
  const baseDomains = React.useMemo<ViewDomain>(() => {
    if (!panZoomEnabled || chartInfo == null) return {}
    if (!zoomed) return baseDomainsOf(chartInfo, positional)
    if (fromStream) return { ...baseDomainsOf(chartInfo, positional), ...lastBaseRef.current }
    return unzoomedDomains ?? lastBaseRef.current
  }, [panZoomEnabled, chartInfo, zoomed, fromStream, positional, unzoomedDomains])
  const baseDomainsRef = React.useRef(baseDomains)
  baseDomainsRef.current = baseDomains
  if (!zoomed) lastBaseRef.current = baseDomains

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
    if (interaction == null) return null
    if (hitIndexRef.current.scene !== target) hitIndexRef.current = { scene: target, index: interaction.buildHitIndex(target) }
    return hitIndexRef.current.index
  }, [interaction])
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

  // The edited rows belong to the chart (compiled spec) they were made under: another one starts from its own. (The
  // compiled chart is the same object while only data changes, so appending rows or re-rendering an equal spec keeps them.)
  const storeOwnerRef = React.useRef<unknown>(undefined)
  React.useEffect(() => {
    const compiled = (scene as unknown as { compiled?: unknown } | null)?.compiled
    if (compiled === undefined) return
    if (storeOwnerRef.current !== undefined && storeOwnerRef.current !== compiled && Object.keys(dataStore.get()).length) dataStore.set({})
    storeOwnerRef.current = compiled
  }, [scene, dataStore])
  // Spec-driven signal event loop (SVG only). Rebinds when the DOM, the scene
  // or the signal values change — not on unrelated renders.
  const signalBindingRef = React.useRef<SignalBinding | null>(null)
  /** The most recent binding and the host element whose timers it keeps: they outlive a re-bind and end at unmount (or a new host). */
  const lastBindingRef = React.useRef<{ host: Element | null; release: () => void } | null>(null)
  const hasSignalListeners = signalListeners != null || onSignal != null
  React.useEffect(() => () => {
    lastBindingRef.current?.release()
    lastBindingRef.current = null
  }, [])
  React.useLayoutEffect(() => {
    if (!interactive || !scene || renderer === 'canvas' || interaction == null) return
    const host = svgHostRef.current
    const svg = (host?.firstElementChild as SVGSVGElement | null) ?? null
    if (!svg) return
    const signalDefs = (scene as unknown as { compiled?: { signalDefs?: Array<{ on?: unknown[] }> } }).compiled?.signalDefs
    const hasStreams = signalDefs?.some((d) => d.on?.length) ?? false
    // Bind when there is anything to drive/listen to, or when any signal exists
    // so ChartHandle.setSignal works on a purely imperative spec.
    if (!hasStreams && !hasSignalListeners && !signalDefs?.length) return
    // The binding mutates the signal object it is given: hand it a copy.
    // `event.item` (mark type / name / role / datum / enclosing group) comes from the scene hit index, the
    // same one that serves tooltips and clicks, so `@name:click` and `symbol:click` work without tooltips.
    const binding = interaction.bindSceneSignals(svg, scene, { ...mergedSignals }, {
      onSignal: (name, value, all) => {
        signalStore.set(all)
        signalListenersRef.current?.[name]?.(name, value)
        onSignalRef.current?.(name, value)
      },
      onData: (name, rows) => dataStore.merge({ [name]: rows }),
      ...(stableLogger ? { logger: stableLogger } : {}),
      ...(preventDefault != null ? { preventDefault } : {}),
    }, { pick: (x, y) => hitIndexFor(displayScene ?? scene)?.pick(x, y) ?? null, containerSize: liveContainerSize, ...(inputData ? { data: inputData } : {}), ...(host ? { owner: host } : {}) })
    signalBindingRef.current = binding
    // a binding on a different host than the last one: the old host's timer streams are done
    const prev = lastBindingRef.current
    if (prev && prev.host !== host) prev.release()
    lastBindingRef.current = { host, release: binding.release }
    return () => {
      binding.detach()
      if (signalBindingRef.current === binding) signalBindingRef.current = null
    }
  }, [interactive, scene, displayScene, renderer, interaction, domMarkup, denseSvg, hasSignalListeners, mergedSignals, signalStore, dataStore, inputData, stableLogger, preventDefault, hitIndexFor, liveContainerSize])

  // Canvas backend: size the backing store for devicePixelRatio and redraw the
  // whole scene whenever it changes (cheap relative to SVG serialization for
  // dense marks; no listeners to leak — every redraw is a full repaint).
  React.useLayoutEffect(() => {
    if (renderer !== 'canvas' || !displayScene || canvasCap == null) return
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
    if (prev != null && canvasCap.renderSceneToCanvasAppend(prev, displayScene, ctx, { dpr })) {
      canvasSnapshotRef.current = canvasCap.snapshotCanvasScene(displayScene)
      canvasSceneRef.current = displayScene
      return
    }
    const draw = (): void => {
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      canvasCap.renderSceneToCanvas(displayScene, ctx, { dpr })
      canvasSnapshotRef.current = canvasCap.snapshotCanvasScene(displayScene)
      canvasSceneRef.current = displayScene
    }
    if (typeof requestAnimationFrame === 'function') {
      const id = requestAnimationFrame(draw)
      return () => cancelAnimationFrame(id)
    }
    draw()
  }, [renderer, displayScene, canvasCap])

  const hasSelection = onSelect != null || brush != null || onPointSelect != null
    || selection !== undefined || onSelectionChange != null
  const hasInteraction = hasSelection || panZoomEnabled

  const selectionValue: SelectValue | null = select !== undefined
    ? select
    : selection !== undefined
      ? selection
      : internalSelection
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
  const cssStartRef = React.useRef<{ x: number; y: number }>({ x: 0, y: 0 })
  const panLastRef = React.useRef<{ x: number; y: number } | null>(null)
  const pointersRef = React.useRef<Map<number, { x: number; y: number }>>(new Map())
  const pinchRef = React.useRef<{ dist: number; cx: number; cy: number } | null>(null)

  // The pointer in the chart's own coordinates (the svg's user space; vega-scenegraph point()), read through the svg's screen
  // CTM so a CSS-scaled, bordered or transformed chart maps right. Measured once and reused (no layout read per move); forgotten
  // by `invalidatePointer` on anything that can change it.
  const pointerMapper = React.useMemo(
    () => createPointMapper(() => svgHostRef.current?.querySelector('svg, canvas') ?? containerRef.current),
    [],
  )

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
      const [px, py] = pointerMapper.map(evt.clientX, evt.clientY)
      const factor = Math.exp(-evt.deltaY * (evt.ctrlKey ? 0.01 : 0.0015))
      const axes: Array<'x' | 'y'> = Math.abs(evt.deltaX) > Math.abs(evt.deltaY) ? ['x'] : ['x', 'y']
      zoomAxes(axes, px, py, factor)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [zoomEnabled, zoomAxes, pointerMapper])

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
    const [x, y] = pointerMapper.map(e.clientX, e.clientY)
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
      // (the live rectangle is drawn in the container's own pixels)
      cssStartRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top }
      setDragRect({ x: cssStartRef.current.x, y: cssStartRef.current.y, width: 0, height: 0 })
    }
  }, [pointerMapper])

  const handlePointerMove = React.useCallback((e: React.PointerEvent) => {
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return
    const [x, y] = pointerMapper.map(e.clientX, e.clientY)
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
      const cx = e.clientX - rect.left
      const cy = e.clientY - rect.top
      const c0 = cssStartRef.current
      setDragRect({ x: Math.min(c0.x, cx), y: Math.min(c0.y, cy), width: Math.abs(cx - c0.x), height: Math.abs(cy - c0.y) })
    }
  }, [zoomAxes, endGesture, pointerMapper])

  const handlePointerUp = React.useCallback((e: React.PointerEvent) => {
    const g = gestureInputsRef.current
    const gesture = gestureRef.current
    const drag = dragRef.current
    if (gesture === 'select' && drag != null) {
      const [x, y] = pointerMapper.map(e.clientX, e.clientY)
      const dx = x - drag.start.x
      const dy = y - drag.start.y
      if (Math.abs(dx) < 3 && Math.abs(dy) < 3) {
        // Tiny drag -> a click: resolve the mark under the pointer and clear
        // any interval selection.
        let datum: Record<string, unknown> | null = null
        // Point selection resolves the mark through the hit index: without the interaction capability there is
        // nothing to resolve (the props are a type error then), so no point is reported rather than a false `null`.
        const pointSelect = interaction != null && (g.onPointSelect || g.onSelectionChange != null)
        if (pointSelect) {
          const target = hitIndexFor(g.displayScene)?.queryMark(x, y)
          const raw = target?.item.datum
          datum = raw != null && typeof raw === 'object' ? raw as Record<string, unknown> : null
          g.onPointSelect?.(datum)
        }
        g.onSelect?.(null)
        if (pointSelect) emitSelectionRef.current({ type: 'point', datum })
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
  }, [endGesture, hitIndexFor, interaction, pointerMapper])

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
   * Tooltip fields: the datum is the pure source row (encoded channel values are
   * never written back into it), so every primitive field is shown as-is.
   * Fields starting with `__` are engine bookkeeping and stay hidden.
   */
  const tooltipFields = React.useMemo(() => {
    if (!tooltipInfo) return [] as Array<[string, string]>
    return Object.entries(tooltipInfo.datum)
      .filter(([k, v]) => !k.startsWith('__') && v != null && typeof v !== 'object')
      .map(([k, v]): [string, string] => [k, typeof v === 'number' ? num(v) : String(v)])
  }, [tooltipInfo])

  const handleTooltipMove = React.useCallback(
    (e: React.MouseEvent) => {
      if (!tooltipEnabled) return
      const rect = containerRef.current?.getBoundingClientRect()
      if (!rect) return
      // The mark under the pointer, from the scene hit index, whatever the renderer: the SVG carries no per-item
      // attribute for it (vega's does not either), so SVG, canvas and batched marks all resolve the same way.
      const [sx, sy] = pointerMapper.map(e.clientX, e.clientY)
      const target = hitIndexFor(displayScene)?.queryMark(sx, sy)
      const datum = target?.item.datum as Record<string, unknown> | undefined
      setTooltipInfo(datum != null && typeof datum === 'object' ? { datum, x: e.clientX - rect.left, y: e.clientY - rect.top } : null)
    },
    [tooltipEnabled, displayScene, hitIndexFor, pointerMapper],
  )

  const handleTooltipLeave = React.useCallback(() => {
    if (tooltipEnabled) setTooltipInfo(null)
  }, [tooltipEnabled])

  // --- the cursor (vega-view cursor.js) -------------------------------------
  // The cursor the container shows is state, rendered through its `style` like any other style: the hovered item's `cursor`
  // channel (read at each pointermove, so moving off the items resets it), or the spec's `cursor` signal, which wins
  // unless it is 'default' (`resolveCursor`). The state is set only when the cursor changes, so pointermoves over the
  // same item cost no render, and a re-render keeps it (the tracker, with the item it holds, outlives renders).
  const userCursor = Object.hasOwn(mergedSignals, 'cursor')
    ? mergedSignals.cursor
    : (scene as { signalParams?: Record<string, unknown> } | null)?.signalParams?.cursor
  const [cursor, setCursor] = React.useState<string | null>(() => resolveCursor(userCursor, null))
  const cursorLiveRef = React.useRef({ user: userCursor, displayScene, hitIndexFor, interaction, eventConfig: undefined as unknown })
  cursorLiveRef.current = {
    user: userCursor, displayScene, hitIndexFor, interaction,
    eventConfig: (scene as { compiled?: { eventConfig?: unknown } } | null)?.compiled?.eventConfig,
  }
  const cursorTrackerRef = React.useRef<CursorTracker | null>(null)
  const handleCursorMove = React.useCallback((e: { clientX: number; clientY: number }) => {
    const live = cursorLiveRef.current
    const cap = live.interaction
    if (cap == null) return
    if (cursorTrackerRef.current == null) {
      cursorTrackerRef.current = cap.createCursorTracker({
        // the point is the pointer's client position; the container is measured only if an item of the scene has a cursor
        // to look for (otherwise the hit index is not even built, and a pointermove costs no layout read)
        pick: (clientX, clientY) => {
          const l = cursorLiveRef.current
          if (l.displayScene == null || l.interaction == null || !l.interaction.sceneHasCursor(l.displayScene)) return null
          // the same map as the signal loop's, read once (a layout read per move is the cost of the cursor on a chart with
          // item cursors; see `pointerMapper`)
          const [px, py] = pointerMapper.map(clientX, clientY)
          return l.hitIndexFor(l.displayScene)?.pick(px, py) ?? null
        },
        user: () => cursorLiveRef.current.user,
        onCursor: setCursor,
        get eventConfig() { return cursorLiveRef.current.eventConfig as never },
      })
    }
    cursorTrackerRef.current.move(e.clientX, e.clientY)
  }, [pointerMapper])
  // Only a chart with something to show listens: an item of the scene has a cursor, or a `cursor` signal exists. A native
  // listener (the pointer moves hundreds of times a second; a synthetic event for each is not needed to read a point).
  const watchCursor = interaction != null && displayScene != null && (interaction.sceneHasCursor(displayScene) || userCursor !== undefined)
  // The map is measured at the first use after anything that can change it: a commit, a resize, a scroll of the window or of
  // any ancestor, the pointer entering the container. Only a chart that reads the pointer listens.
  React.useLayoutEffect(() => { pointerMapper.invalidate() })
  const readsPointer = watchCursor || hasInteraction || tooltipEnabled || zoomEnabled
  React.useEffect(() => {
    const el = containerRef.current
    if (!readsPointer || !el) return
    const forget = (): void => pointerMapper.invalidate()
    el.addEventListener('pointerenter', forget, { passive: true })
    window.addEventListener('scroll', forget, { capture: true, passive: true })
    window.addEventListener('resize', forget, { passive: true })
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(forget) : null
    ro?.observe(el)
    return () => {
      el.removeEventListener('pointerenter', forget)
      window.removeEventListener('scroll', forget, { capture: true })
      window.removeEventListener('resize', forget)
      ro?.disconnect()
    }
  }, [readsPointer, pointerMapper, scene === null])
  React.useEffect(() => {
    const el = containerRef.current
    if (!watchCursor || !el) return
    el.addEventListener('pointermove', handleCursorMove, { passive: true })
    return () => el.removeEventListener('pointermove', handleCursorMove)
  }, [watchCursor, handleCursorMove, scene === null])
  // the spec's `cursor` signal changed (vega: its operator re-runs)
  React.useLayoutEffect(() => {
    if (cursorTrackerRef.current) cursorTrackerRef.current.refresh()
    else setCursor(resolveCursor(userCursor, null))
  }, [userCursor])

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
  const baseStyle: React.CSSProperties = needsPositioning
    ? { ...style, position: 'relative', width: '100%', height: '100%', ...(panZoomEnabled ? { touchAction: 'none' } : {}) }
    : { width: '100%', height: '100%', ...style }
  // vega shows 'default' where no item and no spec signal says otherwise; a host's own `style.cursor` takes that place, but
  // not the cursor of an item or of the spec's `cursor` signal, which is the chart saying what is under the pointer
  const outerStyle: React.CSSProperties = cursor === null ? baseStyle
    : cursor === 'default' ? { cursor, ...baseStyle }
    : { ...baseStyle, cursor }

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
