import * as React from 'react'
import { createPortal } from 'react-dom'
import type { A11yNode, A11yOptions, ChartInfo, Logger, SceneItem, SceneRoot, VgSpec } from '@aster-charts/core'
// The engine as the shells use it: without the parts most charts never run, which `useAddons` loads for a spec that needs them
// (see `@aster-charts/core/internal`).
import {
  buildA11yTree,
  chartInfoFromScene,
  renderSceneToSvg,
  AsterLimitError,
  checkSvgLength,
  createPointMapper,
  resolveCursor,
  consoleLogger,
  checkChartRows, shareRowWatch, sceneScaleMap,
} from '@aster-charts/core/internal'
import { isPromiseLike, normalizeSpecResult, useChartEpoch, useStableContent, useStableSpecRows } from './spec.js'
import { useAddons } from './addons.js'
import { useUrlData } from './urlData.js'
import { validateDataChanges } from './dataChanges.js'
import { SCALE_INFO_KEY, scalesFromSerialized, type SerializedScale } from './serialScales.js'
import { SignalBinds, type SignalBindDef } from './binds.js'
import {
  checkSizeProp, createEventSignalStore, useControlledSignals, useDataInput, useStableLogger, useStablePolicy, type EventSignalStore,
} from './inputs.js'
// The incremental DOM patcher ships as the `@aster-charts/core/dom` addon, which every chart needs. The canvas
// renderer and the hit/signal event loop are NOT imported here: they arrive as the `canvas` and
// `interaction` props (see capabilities.ts), so `<SvgChart>` bundles neither.
import { createChartSession, hasDenseSymbolMarks, patchSceneDom, renderSceneToDomElement } from '@aster-charts/core/internal'
import type { CanvasEvents, CanvasSceneSnapshot, ItemImage } from '@aster-charts/core/canvas'
import type { HitIndex } from '@aster-charts/core/hit'
import type { CursorTracker, SignalBinding } from '@aster-charts/core/signals'
import type { CanvasCapability, InteractionCapability, PngCapability } from './capabilities.js'
import type { ChartHandle, ChartProps } from './chart-types.js'
import { createSceneAnimator, loadTransitions, resolveTransition, type SceneAnimator } from './transition.js'
import {
  baseDomainsOf,
  filterLegendScene,
  dragToDataInterval,
  keyboardView,
  normalizeView,
  dragPan,
  pixelSpanOf,
  positionalScales,
  selectValueToInterval,
  checkAxes,
  checkSelectValue,
  clippedSelectionRect,
  viewToDomainRaw,
  zoomAxisBy,
  type HiddenLegendEntry,
  type SelectValue,
  type ViewDomain,
} from './interaction.js'

/** The build's environment, as bundlers write it in (`process.env.NODE_ENV`); `process` may not exist at all (an unbundled import). */
declare const process: { env: { NODE_ENV?: string } }



// `getServerSnapshot` runs for SSR *and* for the hydration render on the client,
// so this is `true` exactly while the tree must match server markup. It flips to
// `false` after hydration, which lets dense marks batch a client-only mount
// immediately while keeping SSR/hydration byte-compatible.
const subscribeNothing = (): (() => void) => () => {}
const clientOnly = (): boolean => false
const serverOrHydrating = (): boolean => true
/** The device pixel ratio (1 on the server and while hydrating, so the markup matches). */
const devicePixelRatio = (): number => (typeof window !== 'undefined' && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1)
const serverPixelRatio = (): number => 1
/**
 * Told when `devicePixelRatio` changes (a browser zoom, the window moved to another screen): the media query of the current
 * ratio stops matching, and the listener moves to the new ratio's query (vega-view's watchPixelRatio, C505).
 */
const subscribePixelRatio = (onChange: () => void): (() => void) => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {}
  let stop = (): void => {}
  const changed = (): void => {
    watch()
    onChange()
  }
  const watch = (): void => {
    stop()
    const media = window.matchMedia(`(resolution: ${devicePixelRatio()}dppx)`)
    // (`addListener` is the older form of the same subscription; a MediaQueryList with neither is not watched)
    if (typeof media?.addEventListener === 'function') {
      media.addEventListener('change', changed)
      stop = () => media.removeEventListener('change', changed)
    } else if (typeof media?.addListener === 'function') {
      media.addListener(changed)
      stop = () => media.removeListener(changed)
    } else {
      stop = () => {}
    }
  }
  watch()
  return () => stop()
}

// ---------------------------------------------------------------------------
// Event-written datasets
// ---------------------------------------------------------------------------

/** The datasets the spec's event handlers edited (`modify(...)`): only events write here. */
interface DataStore {
  get: () => Record<string, unknown>
  subscribe: (listener: () => void) => () => void
  set: (next: Record<string, unknown>) => void
  /** `tag` sees the new snapshot before the listeners are told of it. */
  merge: (next: Record<string, unknown>, tag?: (snapshot: Record<string, unknown>) => void) => void
}

function createDataStore(): DataStore {
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
    merge(next, tag) {
      snapshot = { ...snapshot, ...next }
      tag?.(snapshot)
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

/**
 * Whether `data` holds other rows than `prev`: a dataset added, removed, or given another rows array (`dataChanges` comes
 * with a new array). A `data` object made anew on every render with the same arrays is the same data.
 */
function datasetsChanged(data: Record<string, unknown[]> | undefined, prev: Record<string, unknown[]> | undefined): boolean {
  if (data === prev) return false
  const a = data ?? {}
  const b = prev ?? {}
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return true
  return keys.some((k) => !Object.hasOwn(b, k) || a[k] !== b[k])
}

/** Two row lists with the same content (a store's few tuples, compared when a timer rewrote it). */
function sameRows(a: unknown[] | undefined, b: unknown[]): boolean {
  if (a === undefined || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && datumKey(a[i] as Record<string, unknown>) !== datumKey(b[i] as Record<string, unknown>)) return false
  return true
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

/** How long the canvas renderer waits for the url images of a scene, all together, before it leaves the rest undrawn. */
const CANVAS_IMAGE_TIMEOUT_MS = 10_000

/** What `getPng` rejects with on a chart that was not given the PNG capability (`<SvgChart>` without `png`). */
export const PNG_NEEDS_CAPABILITY =
  '[aster] getPng needs the png capability: <SvgChart> leaves out the canvas renderer it paints with; import { png } from "@aster-charts/react/png" and pass png={png}'

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
  /** PNG export (`getPng`). Absent: `getPng` rejects with the error that names `@aster-charts/react/png`. */
  png?: PngCapability
}


/**
 * A scene the renderer cannot draw -- an item vega's renderers fail on too (see core bound-failure.ts) -- is logged, as vega's view
 * logs an error of its renderer; the chart shows what it could draw.
 */
function reportRenderError(logger: Logger | undefined, e: unknown): void {
  (logger ?? console).error(e)
}

export const ChartCore = React.forwardRef<ChartHandle, ChartCoreProps>(function ChartCore(props, ref) {
  if (isPromiseLike<VgSpec>(props.spec)) {
    // Let the host's <Suspense> boundary own the fallback: an internal boundary
    // would mask it and always show our placeholder instead.
    return <AsyncChart {...props} spec={props.spec} chartRef={ref} />
  }
  return <SpecChart {...props} spec={props.spec} chartRef={ref} />
})

/** A spec promise, settled: its value, or the reason it was rejected. */
type SettledSpec = { value: unknown; error?: undefined } | { error: Error }
/** One settled promise per spec promise: `React.use` asks for the same one again when it replays a suspended render. */
const settledSpecs = new WeakMap<object, Promise<SettledSpec>>()
function settledSpec(promise: PromiseLike<unknown>): Promise<SettledSpec> {
  let settled = settledSpecs.get(promise)
  if (settled === undefined) {
    settled = Promise.resolve(promise).then(
      (value): SettledSpec => ({ value }),
      (e: unknown): SettledSpec => ({ error: e instanceof Error ? e : new Error(String(e)) }),
    )
    settledSpecs.set(promise, settled)
  }
  return settled
}

/**
 * A `spec` promise: the host's <Suspense> shows its fallback while it is pending. A rejected promise is a chart error like any
 * other (the error state and one `onError` call), not a throw to the nearest error boundary.
 */
function AsyncChart({ spec, chartRef, ...props }: Omit<ChartCoreProps, 'spec'> & { spec: PromiseLike<VgSpec>; chartRef: React.ForwardedRef<ChartHandle> }) {
  const settled = React.use(settledSpec(spec))
  return settled.error !== undefined
    ? <SpecChart {...props} spec={null} loadError={settled.error} chartRef={chartRef} />
    : <SpecChart {...props} spec={settled.value} chartRef={chartRef} />
}

/** What a chart shows while its spec cannot be evaluated (see `SpecChart`): no data, no marks, no signals. */
const NO_SPEC: VgSpec = Object.freeze({}) as VgSpec

/**
 * The chart of ONE spec. A chart owns state that belongs to the spec it was made under (the DOM its patcher keeps, the
 * timers and event streams of its bindings, signal values, an edited store, a selection, a zoom, hidden legend entries, a
 * drag in flight), so a `spec` that changes to another chart is a new chart: it is keyed by the spec's identity and starts as
 * a fresh mount does, whatever the old one was doing. A change of only the rows of its inline datasets, and every change of
 * `data`, signals or size, keeps the chart and its incremental path (see `useChartEpoch`).
 *
 * The spec is normalized (a Vega-Lite spec compiled) here, inside the guard: a value that is not a spec, a missing Vega-Lite
 * compiler, a compile error and a rejected spec promise (`loadError`) all reach the chart's error state and `onError` once,
 * as an evaluation error does.
 */
function SpecChart({ spec: rawSpec, loadError, chartRef, ...props }: Omit<ChartCoreProps, 'spec'> & { spec: unknown; loadError?: Error; chartRef: React.ForwardedRef<ChartHandle> }) {
  // Content-stable: a parent that rebuilds an inline spec literal every render
  // neither recompiles (Vega-Lite) nor re-evaluates.
  const stableSpec = useStableSpecRows(rawSpec as VgSpec)
  const normalized = React.useMemo(
    () => (loadError !== undefined ? { spec: null, error: loadError } : normalizeSpecResult(stableSpec)),
    [stableSpec, loadError],
  )
  const spec = normalized.spec ?? NO_SPEC
  // Focus inside the chart when its spec changes to another chart: the old chart's DOM goes, the new one takes the focus.
  const focusHandoff = React.useRef<FocusSpot | null>(null)
  return <ChartView key={useChartEpoch(spec)} {...props} spec={spec} specError={normalized.error} chartRef={chartRef} focusHandoff={focusHandoff} />
}

/**
 * A write by the host (the handle's `setSignal`, a bound input) through the event loop. The loop is vega's `view.signal(name, value)`:
 * a value equal to the signal's own changes nothing and reports nothing (core's `setSignal`), but it is still a write by an event, and
 * the latest writer wins: it is recorded in the store, so a key the `signals` prop later releases keeps this value (Q19).
 */
function setThroughLoop(binding: { setSignal: (name: string, value: unknown) => void }, store: EventSignalStore | null | undefined, name: string, value: unknown): void {
  const before = store?.get().written[name]
  binding.setSignal(name, value)
  if (store != null && store.get().written[name] === before) store.write({ [name]: value })
}

function ChartView({
  spec: specProp,
  sceneOverride,
  data: dataProp,
  dataChanges,
  width,
  height,
  ariaLabel,
  className,
  style,
  signals,
  onSelect,
  onPointSelect,
  brush: brushProp,
  selection: selectionProp,
  select: selectProp,
  onSelectionChange,
  panZoom = false,
  pan = false,
  zoom = false,
  view: viewProp,
  onViewChange,
  maxZoom = 1000,
  incremental = true,
  renderer: requestedRenderer = 'svg',
  denseMarks = 'auto',
  transition,
  signalListeners,
  onSignal,
  onStreamInput,
  interactive = true,
  tooltip = false,
  renderTooltip,
  tooltipContainer,
  limits,
  urlPolicy: urlPolicyProp,
  urlData,
  urlLoad,
  random,
  logger,
  preventDefault,
  eventSources: eventSourcesProp,
  textMetrics,
  a11y: a11yProp = true,
  onError,
  canvas: canvasCap,
  interaction,
  png: pngCap,
  chartRef,
  focusHandoff,
  specError,
}: Omit<ChartCoreProps, 'spec'> & {
  spec: VgSpec
  /** Why the spec could not be normalized (see `SpecChart`): the chart shows its error state. */
  specError: Error | null
  chartRef: React.ForwardedRef<ChartHandle>
  focusHandoff: React.MutableRefObject<FocusSpot | null>
}) {
  // The opt-in add-ons the spec needs (transforms, geo, load) arrive before the first evaluation: this suspends while
  // they load, so there is no render of the half-ready chart and no error to flash. A failed import is a chart error.
  // With `urlData="refuse"` a spec with a url dataset is refused here, before any add-on is imported.
  // (and the parts of the engine it needs: the legend builder, the canvas renderer for renderer="canvas"... see `useAddons`)
  // (and the signal event loop of an interactive chart that binds it: see the binding below, and `useAddons`)
  const loadLoop = interactive && interaction?.loadSignals !== undefined ? interaction.loadSignals : undefined
  const addonError = useAddons(sceneOverride !== undefined || specError !== null ? null : specProp, urlData, {
    limits: limits != null, random: random != null, signals, canvas: requestedRenderer === 'canvas' ? canvasCap : undefined,
    eventLoop: loadLoop !== undefined ? { load: loadLoop, listeners: signalListeners != null || onSignal != null, always: sceneOverride !== undefined } : undefined,
  })
  const stableLimits = useStableContent(limits)
  // The identity rule (see inputs.ts): JSON-shaped props by content, `data` by its datasets' row arrays, the functions of
  // `urlPolicy` through a latest-ref. A parent that rebuilds them as literals on every render changes nothing.
  const dataInput = useDataInput(dataProp)
  const data = dataInput.data
  const urlPolicy = useStablePolicy(urlPolicyProp)
  // Controlled pan/zoom and selection values are checked at the boundary: an axis that is not a pair of finite, different
  // numbers is reported through `onError` (once per value) and left out, never handed to the scales (C243, C490).
  const stableView = useStableContent(viewProp)
  const stableBrush = useStableContent(brushProp)
  const stableSelection = useStableContent(selectionProp)
  const eventSources = useStableContent(eventSourcesProp)
  const stableSelect = useStableContent(selectProp)
  const checkedView = React.useMemo(() => checkAxes('view', stableView), [stableView])
  const checkedBrush = React.useMemo(() => checkAxes('brush', stableBrush), [stableBrush])
  const checkedSelection = React.useMemo(() => checkSelectValue('selection', stableSelection), [stableSelection])
  const checkedSelect = React.useMemo(() => checkSelectValue('select', stableSelect), [stableSelect])
  const controlledView = checkedView.value
  const brush = checkedBrush.value
  const selection = checkedSelection.value
  const select = checkedSelect.value
  const propProblems = [...checkedView.problems, ...checkedBrush.problems, ...checkedSelection.problems, ...checkedSelect.problems]
  const a11y = useStableContent(a11yProp)
  // Which scales `view`/`brush`/`selection`'s `x`/`y` refer to.
  const positional = React.useMemo(() => positionalScales(specProp), [specProp])
  // Without the interaction capability there is no hit index, so a tooltip
  // cannot resolve its datum: it stays off (and a JS caller that asked for one is told, below).
  const tooltipEnabled = interaction != null && (tooltip || renderTooltip != null)
  // Without the canvas capability the chart renders as SVG (and a JS caller that asked for canvas is told), as it does for a name that
  // is no renderer of ours (`"webgl"`).
  const renderer = requestedRenderer === 'canvas' && canvasCap != null ? 'canvas' : 'svg'
  const containerRef = React.useRef<HTMLDivElement>(null)
  // `null` until measured: the spec's own size renders meanwhile (and on the server).
  const [measured, setMeasured] = React.useState<{ width: number; height: number } | null>(null)

  // Interaction state
  const [dragRect, setDragRect] = React.useState<{ x: number; y: number; width: number; height: number } | null>(null)
  // The tooltip under the pointer: a store of its own, read by <ChartTooltip>, so a pointer move that only moves the tooltip renders
  // the tooltip and not the chart.
  const tooltipStoreRef = React.useRef<TooltipStore | null>(null)
  tooltipStoreRef.current ??= createTooltipStore()
  const tooltipStore = tooltipStoreRef.current
  const [internalView, setInternalView] = React.useState<ViewDomain | null>(null)
  const [internalSelection, setInternalSelection] = React.useState<SelectValue | null>(null)
  const [hiddenLegend, setHiddenLegend] = React.useState<Map<string, HiddenLegendEntry>>(() => new Map())
  const [activeA11yId, setActiveA11yId] = React.useState<string | null>(null)

  // Whether the chart is mounted: a handle the host keeps past unmount is inert (C489): it notifies no listener and returns
  // no scene. (A layout effect, so it is set before the handle is attached and before a parent's layout effect can use it.)
  const mountedRef = React.useRef(false)
  // The chart's id on the page (the server's, kept through hydration): it names the chart's radio groups.
  const chartId = React.useId()
  React.useLayoutEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

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

  // A number fixes that dimension of the view; `'container'` fills the element's measured size there; nothing leaves it to
  // the spec (its own `width` / `height`, autosize and signals), as Vega does: a literal size draws at that size in any
  // element (DECISIONS Q11). The element is measured whenever a dimension is not fixed: `containerSize()` reads it (vega-lite's
  // `width: "container"` does), whether or not the view fills it.
  const fixedWidth = typeof width === 'number' ? width : undefined
  const fixedHeight = typeof height === 'number' ? height : undefined
  const fillWidth = width === 'container'
  const fillHeight = height === 'container'
  const needsMeasure = fixedWidth == null || fixedHeight == null
  const hasBinds = ((specProp.signals as SignalBindDef[] | undefined) ?? []).some((s) => s && s.bind != null)
  React.useEffect(() => {
    if (!needsMeasure) return undefined
    const el = containerRef.current
    if (!el) return undefined
    if (typeof ResizeObserver !== 'undefined') {
      // The chart's share of the element: its content box less the bound inputs under the chart, which are inside the
      // element but not the chart, so a container the chart fills does not count them again on every measurement.
      let box = { width: 0, height: 0 }
      const observer = new ResizeObserver((entries) => {
        for (const e of entries) if (e.target === el) box = e.contentRect
        const w = box.width
        const h = Math.max(0, box.height - bindsHeight(el))
        // (a dimension measured 0 -- a block parent with no height -- is not one the chart can fill; the other one still is)
        if (w > 0 || h > 0) setMeasured((prev) => (prev && prev.width === w && prev.height === h ? prev : { width: w, height: h }))
      })
      observer.observe(el)
      // (bound inputs that wrap to another line change the chart's share without resizing a container of fixed size)
      const binds = bindsOf(el)
      if (binds) observer.observe(binds)
      return () => observer.disconnect()
    }
    return undefined
  }, [needsMeasure, hasBinds])

  // The size props FIX the view. The container the spec is sized to (`containerSize()`) is the props where given and the
  // measured element for the rest; the view FILLS it only in a dimension given as `'container'` (a spec that drives its own
  // `width` / `height` signals keeps doing so, as in Vega where `view.width(w)` is a signal write and the later write wins).
  const sizedWidth = fixedWidth ?? measured?.width
  const sizedHeight = fixedHeight ?? measured?.height
  const containerSize = React.useMemo(
    () => (sizedWidth != null && sizedHeight != null ? { width: sizedWidth, height: sizedHeight } : undefined),
    [sizedWidth, sizedHeight],
  )
  const fillW = fillWidth && measured != null && measured.width > 0 ? measured.width : undefined
  const fillH = fillHeight && measured != null && measured.height > 0 ? measured.height : undefined
  const filled = React.useMemo(
    () => (fillW != null || fillH != null ? { ...(fillW != null ? { width: fillW } : {}), ...(fillH != null ? { height: fillH } : {}) } : undefined),
    [fillW, fillH],
  )
  const sizeInput = React.useMemo(
    () => ({
      ...(fixedWidth != null ? { width: fixedWidth } : {}), ...(fixedHeight != null ? { height: fixedHeight } : {}),
      ...(containerSize ? { containerSize } : {}), ...(filled ? { measuredSize: filled } : {}),
    }),
    [fixedWidth, fixedHeight, containerSize, filled],
  )
  // `containerSize()` in a handler (a `window:resize` one) reads the element as it is when the event fires, like
  // vega's `view.container().clientWidth`, not the size of the last render.
  const liveSizeRef = React.useRef<() => [number | undefined, number | undefined]>(() => [undefined, undefined])
  liveSizeRef.current = () => {
    const el = containerRef.current
    return [fixedWidth ?? (el?.clientWidth || measured?.width), fixedHeight ?? ((el ? el.clientHeight - bindsHeight(el) : 0) || measured?.height)]
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
  if (sessionRef.current == null) sessionRef.current = createChartSession({ runningView: true })
  const sceneRef = React.useRef<SceneRoot | null>(null)

  const currentView = controlledView !== undefined ? controlledView : internalView
  const viewRef = React.useRef(currentView)
  viewRef.current = currentView
  const domainRaw = React.useMemo(() => viewToDomainRaw(currentView, positional), [currentView, positional])

  // The signal values events wrote, merged with the controlled `signals` prop when read (see `useControlledSignals`).
  const signalStoreRef = React.useRef<EventSignalStore | null>(null)
  if (signalStoreRef.current == null) signalStoreRef.current = createEventSignalStore()
  const signalStore = signalStoreRef.current
  const eventSignals = React.useSyncExternalStore(signalStore.subscribe, signalStore.get, signalStore.get)
  const mergedSignals = useControlledSignals(signals, eventSignals)
  const mergedSignalsRef = React.useRef(mergedSignals)
  mergedSignalsRef.current = mergedSignals
  // The spec the chart evaluates: with `urlLoad`, the one whose url datasets the chart loaded (and loads again when a signal their
  // urls read changes, wherever the change comes from); else the spec as given. A failed load is reported through `onError` (else the
  // logger) and the chart carries on with the rows it has, like a rejected `dataChanges` changeset: the bound input that picks the
  // next url must stay on the page, or one bad url would be the last.
  const urlLoaded = useUrlData(specProp, sceneOverride !== undefined || specError !== null || urlData === 'refuse' ? undefined : urlLoad, mergedSignals, stableLimits)
  const spec = urlLoaded.spec
  // Datasets the spec's event handlers edit with `modify(...)` (a Vega-Lite selection's `<param>_store`): the
  // event loop reports their rows, which are kept here and handed back as inputs, so a store is a dataset like any
  // other and the evaluation after an edit is the one a fresh chart with those rows computes. They belong to the
  // spec they were edited under.
  const dataStoreRef = React.useRef<DataStore | null>(null)
  if (dataStoreRef.current == null) dataStoreRef.current = createDataStore()
  const dataStore = dataStoreRef.current
  const editedData = React.useSyncExternalStore(dataStore.subscribe, dataStore.get, dataStore.get) as Record<string, unknown[]>
  // The snapshots of the edited datasets that a `timer` stream made (a Vega-Lite `time` animation's next frame): a scene
  // they cause is a change of data that a `transition` animates, where an edit by input (a brush) is drawn at once.
  const timerEditsRef = React.useRef<WeakSet<object> | null>(null)
  timerEditsRef.current ??= new WeakSet()
  const timerEdits = timerEditsRef.current
  const inputData = React.useMemo(
    () => (Object.keys(editedData).length ? { ...(data ?? {}), ...editedData } : data),
    [data, editedData],
  )
  // The logger object may change every render; evaluation and the event loop see one stable proxy that
  // always calls the latest (a changing identity must not re-evaluate the chart).
  const loggerRef = React.useRef(logger)
  loggerRef.current = logger
  // (read by the handle, whose identity never changes)
  const pngCapRef = React.useRef(pngCap)
  pngCapRef.current = pngCap
  const stableLogger = useStableLogger(logger)
  const bindDefs = React.useMemo(
    () => ((spec.signals as SignalBindDef[] | undefined) ?? []).filter((s) => s && s.bind != null),
    [spec],
  )

  // (development builds: the rows of a render that re-evaluates nothing -- the same arrays -- are checked for in-place changes too;
  // a stream's scene is the stream's, whose rows its own session checks at each flush)
  try {
    if (process.env.NODE_ENV !== 'production' && sceneOverride === undefined) checkChartRows(sessionRef.current, spec, { data: inputData, dataChanges, logger: stableLogger })
  } catch (e) {
    if (typeof process !== 'undefined') throw e
  }

  // Row counts of the previously evaluated `data`, to validate `dataChanges`.
  const prevLengthsRef = React.useRef<Map<string, number>>(new Map())
  const evaluation = React.useMemo<{ scene: SceneRoot | null; error: Error | null; problems: string[] }>(() => {
    if (sceneOverride !== undefined) {
      return { scene: sceneOverride, error: null, problems: [] }
    }
    if (specError) return { scene: null, error: specError, problems: [] }
    if (dataInput.error) return { scene: null, error: dataInput.error, problems: [] }
    if (addonError) return { scene: null, error: addonError, problems: [] }
    try {
      checkSizeProp('width', width)
      checkSizeProp('height', height)
      const { changes, problems } = validateDataChanges(dataChanges, inputData, prevLengthsRef.current)
      prevLengthsRef.current = new Map(Object.entries(inputData ?? {}).map(([name, rows]) => [name, rows.length]))
      const sc = sessionRef.current!.evaluate(spec, {
        data: inputData, dataChanges: changes, ...sizeInput,
        signals: mergedSignals, limits: stableLimits, urlPolicy, urlData, domainRaw, textMetrics, logger: stableLogger,
        ...(random ? { random } : {}),
      })
      // `maxSvgLength` bounds the serialized output. The DOM patcher never
      // builds that string, so the budget is enforced by measuring one — only
      // when the host asked for it (it costs a serialization per evaluation).
      if (stableLimits?.maxSvgLength != null && renderer !== 'canvas') checkSvgLength(renderSceneToSvg(sc), stableLimits)
      return { scene: sc, error: null, problems }
    } catch (err) {
      return { scene: null, error: err instanceof Error ? err : new Error(String(err)), problems: [] }
    }
  }, [sceneOverride, specError, dataInput.error, addonError, spec, width, height, inputData, dataChanges, sizeInput, mergedSignals, stableLimits, urlPolicy, urlData, random, domainRaw, textMetrics, stableLogger])
  const scene = evaluation.scene
  sceneRef.current = scene
  const renderError = evaluation.error

  const displayScene = React.useMemo(
    () => scene ? filterLegendScene(scene, hiddenLegend.values()) : null,
    [scene, hiddenLegend],
  )
  // Dense SVG marks: batched `<path>` chunks instead of one element per datum.
  // `'auto'` stays out of the way when the spec binds mark events (`signal.on`); `true`
  // forces batching regardless (the event loop resolves its datum from the scene hit
  // index, not from per-item DOM nodes).
  const denseRequested = denseMarks === true || denseMarks === 'auto'
  const denseAllowed = React.useMemo(() => {
    if (!denseRequested) return false
    if (denseMarks === true) return true
    const signalDefs = (scene as { compiled?: { signalDefs?: Array<{ on?: unknown[] }> } } | null)?.compiled?.signalDefs
    return !signalDefs?.some((d) => (d.on?.length ?? 0) > 0)
  }, [denseRequested, denseMarks, scene])
  // (only the incremental path batches: the batched DOM is built by the layout effect, while `incremental={false}` draws each
  // scene as one string of per-item markup, which the layout effect leaves alone)
  const denseSvg = incremental && denseAllowed && renderer === 'svg' && (scene != null ? hasDenseSymbolMarks(scene) : false)
  const hydrating = React.useSyncExternalStore(subscribeNothing, clientOnly, serverOrHydrating)
  const pixelRatio = React.useSyncExternalStore(subscribePixelRatio, devicePixelRatio, serverPixelRatio)

  // One report per error, however often the chart re-renders or re-evaluates while it persists: an inline `onError`, a
  // measurement, a signal or StrictMode's second effect run must not refire it. An error the chart is already showing (the
  // same name and message) is not reported again; a success ends it, so the next failure is reported. A rejected
  // `dataChanges` changeset is reported once per evaluation that rejected it.
  const reportedRef = React.useRef<{ evaluation: unknown; error: string | null }>({ evaluation: null, error: null })
  React.useEffect(() => {
    const reported = reportedRef.current
    if (reported.evaluation === evaluation) return
    reported.evaluation = evaluation
    const error = evaluation.error
    const key = error ? `${error.name}\u0000${error.message}` : null
    if (error && key !== reported.error) onErrorRef.current?.(error)
    reported.error = key
    for (const problem of evaluation.problems) onErrorRef.current?.(new Error(`[aster] ${problem}`))
  }, [evaluation])

  // A load that failed (the loader's own error, a policy refusal included, as it is): once per failure.
  const urlLoadError = urlLoaded.error
  React.useEffect(() => {
    if (urlLoadError === null) return
    if (onErrorRef.current) onErrorRef.current(urlLoadError)
    else (loggerRef.current ?? console).warn(urlLoadError.message)
  }, [urlLoadError])

  /** A problem the chart carries on through: to `onError`, else the logger, else the console. */
  const reportProblem = React.useCallback((problem: string): void => {
    const message = `[aster] ${problem}`
    if (onErrorRef.current) onErrorRef.current(new Error(message))
    else (loggerRef.current ?? console).warn(message)
  }, [])
  // A controlled view or interval that was refused (see `checkAxes`): reported once for each value that has the problem.
  const propProblemKey = propProblems.join('\n')
  React.useEffect(() => {
    if (propProblemKey) for (const problem of propProblemKey.split('\n')) reportProblem(problem)
  }, [propProblemKey, reportProblem])

  // A capability the caller needs but did not inject (plain `<SvgChart>`): the chart still renders what it can,
  // and every unavailable feature is REPORTED, like a rejected `dataChanges` changeset, never silently dead.
  // Types make the props a compile error; this is the net for JS callers and for specs whose event streams
  // are only known after evaluation. Reported through `onError`, else the logger, else the console.
  const eventStreamsUnbound = interaction == null && interactive && scene != null && hasEventStreams(scene)
  const interactionPropsUsed = interaction == null
    ? Object.entries({ tooltip: tooltip === true, renderTooltip, tooltipContainer, onPointSelect, selection, select, onSelectionChange, preventDefault: preventDefault === true, eventSources: eventSourcesProp })
      .filter(([, v]) => v !== undefined && v !== false).map(([k]) => k).join(', ')
    : ''
  const canvasUnavailable = requestedRenderer === 'canvas' && canvasCap == null
  const unknownRenderer = requestedRenderer !== 'svg' && requestedRenderer !== 'canvas' ? String(requestedRenderer) : ''
  const capabilityKey = `${canvasUnavailable ? 'c' : ''}${unknownRenderer ? `r${unknownRenderer}` : ''}|${interactionPropsUsed}|${eventStreamsUnbound ? 'e' : ''}`
  React.useEffect(() => {
    const fix = "pass interaction={interaction} from '@aster-charts/react/interaction'"
    const problems = [
      canvasUnavailable && 'renderer="canvas" needs <Chart>: <SvgChart> has no canvas renderer, so it renders SVG',
      unknownRenderer && `renderer=${JSON.stringify(unknownRenderer)} is no renderer ("svg" or "canvas"), so it renders SVG`,
      interactionPropsUsed && `${interactionPropsUsed} need hit testing and the signal event loop and are ignored: ${fix}`,
      eventStreamsUnbound && `this spec has event streams (signal.on) but no event loop is bound: ${fix}`,
    ]
    for (const problem of problems) if (problem) reportProblem(problem)
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
      if (baseSessionRef.current == null) {
        baseSessionRef.current = createChartSession()
        // (development builds: the chart's two sessions keep one watch, so an in-place change is reported once)
        try {
          if (process.env.NODE_ENV !== 'production') shareRowWatch(sessionRef.current!, baseSessionRef.current)
        } catch (e) {
          if (typeof process !== 'undefined') throw e
        }
      }
      const baseScene = baseSessionRef.current.evaluate(spec, {
        data: inputData, ...sizeInput, signals: mergedSignals, limits: stableLimits, urlPolicy, urlData, textMetrics, logger: stableLogger,
        ...(random ? { random } : {}),
      })
      return baseDomainsOf(chartInfoFromScene(baseScene), positional)
    } catch {
      return null
    }
  }, [panZoomEnabled, zoomed, fromStream, positional, spec, inputData, sizeInput, mergedSignals, stableLimits, urlPolicy, urlData, random, textMetrics, stableLogger])
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
  const sentFillRef = React.useRef(false)
  React.useEffect(() => {
    if (streamInput) {
      onStreamInputRef.current?.({
        ...(domainRaw ? { domainRaw } : {}), signals: mergedSignals,
        // the stream sizes its evaluations as this chart sizes its own: the props it fixes, and the container it measured
        // (`{}` once no dimension fills the element any more: the stream keeps the later value, so it is told the fill stopped)
        ...(containerSize ? { containerSize } : {}),
        ...(filled ? { measuredSize: filled } : sentFillRef.current ? { measuredSize: {} } : {}),
      })
      sentFillRef.current = filled != null
    }
  }, [streamInput, domainRaw, mergedSignals, containerSize, filled])

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
    try {
      return { __html: renderSceneToSvg(displayScene) }
    } catch (e) {
      reportRenderError(loggerRef.current, e)
      return { __html: '' }
    }
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
  // Image marks drawn from a `url` (the canvas renderer draws a bitmap and never fetches; vega's canvas loads them): the bitmaps
  // loaded so far by url, kept from one scene to the next so new data does not blank the images (and pruned to the scene's urls),
  // the urls being loaded, and the ones that failed (reported once, not asked for again while the scene names them). A load that
  // finishes bumps `canvasImagesEpoch`, which repaints.
  const canvasImagesRef = React.useRef({ loaded: new Map<string, ItemImage>(), pending: new Set<string>(), failed: new Set<string>() })
  const [canvasImagesEpoch, setCanvasImagesEpoch] = React.useState(0)
  const canvasImagesPaintedRef = React.useRef(-1)
  // Hit testing (canvas, batched dense marks, clicks) resolves marks through the
  // scene hit index, rebuilt only when the displayed scene object (or the renderer) changes. It picks as the renderer
  // shown does: vega's canvas pick tests the bounds it measured, the browser's hit test of the SVG does not.
  const hitIndexRef = React.useRef<{ scene: SceneRoot | null; renderer: string; index: HitIndex | null }>({ scene: null, renderer: '', index: null })
  const hitIndexFor = React.useCallback((target: SceneRoot | null): HitIndex | null => {
    if (target == null) return null
    if (interaction == null) return null
    if (hitIndexRef.current.scene !== target || hitIndexRef.current.renderer !== renderer) {
      hitIndexRef.current = { scene: target, renderer, index: interaction.buildHitIndex(target, undefined, renderer === 'canvas' ? { renderer } : undefined) }
    }
    return hitIndexRef.current.index
  }, [interaction, renderer])
  // `transition`: a change of data is drawn as frames from the picture on screen to the new scene (see transition.ts). The
  // options are read when a transition starts, so a new options object restarts nothing.
  const transitionOptions = resolveTransition(transition)
  const transitionRef = React.useRef(transitionOptions)
  transitionRef.current = transitionOptions
  const transitionOn = transitionOptions !== null
  const reportTransitionError = React.useCallback((error: Error): void => {
    reportProblem(`transition: ${error.message}; the chart draws its new scene at once`)
  }, [reportProblem])
  // The animator draws into the <svg> and knows what it shows. Every draw goes through it (or tells it), so a
  // `transition` set later starts from the true picture.
  const animatorRef = React.useRef<SceneAnimator | null>(null)
  animatorRef.current ??= createSceneAnimator((svg, sc) => patchSceneDom(svg, sc, { denseMarks: false }), reportTransitionError)
  const animator = animatorRef.current
  // the interpolation module loads as soon as the prop is set, so the first change of data can animate
  React.useEffect(() => {
    if (transitionOn) loadTransitions().catch((e: unknown) => reportTransitionError(e instanceof Error ? e : new Error(String(e))))
  }, [transitionOn, reportTransitionError])
  // unmount (and a spec swap, which is a new chart) ends a running transition: no frame is requested after it
  React.useLayoutEffect(() => () => animator.cancel(), [animator])
  // The inputs of the last commit: a scene is a change of DATA (what a transition animates) when it came with new
  // rows in `data` (another array for a dataset), new rows in the spec, a streamed scene, or a dataset a `timer` stream
  // moved on (a Vega-Lite `time` animation's next frame).
  const committedInputsRef = React.useRef<{ data: unknown; sceneOverride: unknown; spec: unknown; edited: unknown } | null>(null)

  // Incremental updates: create the <svg> once, then patch changed attributes
  // in place instead of re-serializing and re-parsing the whole markup every render.
  // `renderer` is a dependency: switching back from canvas mounts a fresh, empty
  // host element that must be filled even though the scene did not change.
  React.useLayoutEffect(() => {
    if (!displayScene || renderer === 'canvas') {
      animator.reset(null)
      return
    }
    // A sceneOverride still needs its DOM created: stream markup is client-owned
    // (no dangerouslySetInnerHTML), so the first frame builds the element here.
    if (!incremental && sceneOverride === undefined) {
      animator.reset(displayScene)
      return
    }
    const host = svgHostRef.current
    if (!host) return
    // This commit rendered the full SVG from this exact scene and the browser
    // just parsed it, so the tree already matches. Re-walking it with the
    // patcher would be pure cost — and it is O(all items), the worst place to
    // pay it (mount is where a large scene hurts most).
    if (domMarkup != null) {
      // ...except a HYDRATION commit: the DOM is the server's markup, which React keeps where the client's differs (the
      // server's time zone, its headless text estimate against the browser's measurement). It is patched to this scene once,
      // so the pixels are the scene the chart hit-tests and overlays with (C45). The patcher compares with the DOM it is given,
      // so markup that already matches costs a walk and no write.
      if (hydrating) {
        const adopted = host.firstElementChild
        try {
          if (adopted && adopted.tagName.toLowerCase() === 'svg') patchSceneDom(adopted, displayScene, { denseMarks: false })
          else host.replaceChildren(renderSceneToDomElement(displayScene, document, { denseMarks: false }))
        } catch (e) {
          reportRenderError(loggerRef.current, e)
        }
      }
      hasPatchedRef.current = true
      domSceneRef.current = displayScene
      domDenseRef.current = false // string markup is always per-item
      animator.reset(displayScene)
      // React has committed the string; never keep a large copy alive (and a
      // later remount of the host starts empty and is filled below).
      if (markupBox != null && incremental) markupBox.__html = ''
      return
    }
    const existing = host.firstElementChild
    try {
      if (incremental && existing && existing.tagName.toLowerCase() === 'svg') {
        // Patch when the scene changed, or when the render mode flipped (e.g. a
        // client-only dense mount, or hydration handing over to batched marks).
        if (domSceneRef.current !== displayScene || domDenseRef.current !== denseSvg) {
          const options = transitionRef.current
          if (options !== null && !denseSvg && !domDenseRef.current) {
            const prev = committedInputsRef.current
            const dataChanged = prev !== null && (
              datasetsChanged(data, prev.data as typeof data) || spec !== prev.spec
              || (sceneOverride !== undefined && sceneOverride !== prev.sceneOverride)
              || (editedData !== prev.edited && timerEdits.has(editedData)))
            animator.draw(existing, displayScene, dataChanged ? options : null)
          } else {
            patchSceneDom(existing, displayScene, { denseMarks: denseSvg })
            animator.reset(displayScene)
          }
          domDenseRef.current = denseSvg
        }
      } else {
        host.replaceChildren(renderSceneToDomElement(displayScene, document, { denseMarks: denseSvg }))
        domDenseRef.current = denseSvg
        animator.reset(displayScene)
      }
    } catch (e) {
      reportRenderError(loggerRef.current, e)
    }
    domSceneRef.current = displayScene
    hasPatchedRef.current = true
  }, [incremental, renderer, displayScene, sceneOverride, domMarkup, denseSvg, hydrating, animator, data, spec, editedData, timerEdits])
  React.useLayoutEffect(() => {
    committedInputsRef.current = { data, sceneOverride, spec, edited: editedData }
  })

  // The edited rows belong to the chart (compiled spec) they were made under: another one starts from its own. (The
  // compiled chart is the same object while only data changes, so appending rows or re-rendering an equal spec keeps them.)
  const storeOwnerRef = React.useRef<unknown>(undefined)
  React.useEffect(() => {
    const compiled = (scene as unknown as { compiled?: unknown } | null)?.compiled
    if (compiled === undefined) return
    if (storeOwnerRef.current !== undefined && storeOwnerRef.current !== compiled && Object.keys(dataStore.get()).length) dataStore.set({})
    storeOwnerRef.current = compiled
  }, [scene, dataStore])
  // Spec-driven signal event loop, on the SVG and on the canvas renderer. Rebinds when the DOM, the scene
  // or the signal values change — not on unrelated renders.
  const signalBindingRef = React.useRef<SignalBinding | null>(null)
  /** The most recent binding and the host element whose timers it keeps: they outlive a re-bind and end at unmount (or a new host). */
  const lastBindingRef = React.useRef<{ host: Element | null; release: () => void } | null>(null)
  /**
   * The canvas's events (vega's canvas handler: the hovered item, the one a button went down on), for as long as that canvas is
   * shown: they outlive the bindings, as the canvas does.
   */
  const canvasEventsRef = React.useRef<{ canvas: HTMLCanvasElement; events: CanvasEvents } | null>(null)
  const hasSignalListeners = signalListeners != null || onSignal != null
  React.useEffect(() => () => {
    lastBindingRef.current?.release()
    lastBindingRef.current = null
    canvasEventsRef.current?.events.release()
    canvasEventsRef.current = null
  }, [])
  React.useLayoutEffect(() => {
    // the events of a canvas that is no longer shown (another canvas, or the SVG renderer) are done
    const shownCanvas = renderer === 'canvas' ? canvasRef.current : null
    if (canvasEventsRef.current && canvasEventsRef.current.canvas !== shownCanvas) {
      canvasEventsRef.current.events.release()
      canvasEventsRef.current = null
    }
    if (!interactive || !scene || interaction == null) return
    // The element the view is drawn in: the svg (its DOM events are about the item under their point), or the canvas, whose
    // events are resolved as vega's canvas renderer resolves them (see `createCanvasEvents`). The canvas is its own host.
    let host: Element | null
    let svg: Element | null
    let events: CanvasEvents | undefined
    if (renderer === 'canvas') {
      if (shownCanvas == null || canvasCap == null) return
      host = svg = shownCanvas
      if (canvasEventsRef.current == null) canvasEventsRef.current = { canvas: shownCanvas, events: canvasCap.createCanvasEvents(shownCanvas) }
      events = canvasEventsRef.current.events
    } else {
      host = svgHostRef.current
      svg = host?.firstElementChild ?? null
    }
    if (!svg) return
    const signalDefs = (scene as unknown as { compiled?: { signalDefs?: Array<{ on?: unknown[] }> } }).compiled?.signalDefs
    const hasStreams = signalDefs?.some((d) => d.on?.length) ?? false
    // Bind when there is anything to drive/listen to, or when any signal exists
    // so ChartHandle.setSignal works on a purely imperative spec.
    // (a mark with a `hover` set reacts to the pointer through the loop as well: vega's view.hover(), on as vega-embed has it)
    const hovers = hasHoverSet((scene as unknown as { compiled?: { marks?: HoverMarks } }).compiled?.marks)
    if (!hasStreams && !hasSignalListeners && !signalDefs?.length && !hovers) return
    // (`htmlProp` is in the dependencies, not the markup string: it changes only when React is handed another svg to write, which
    // the binding must follow. The string is emptied after the first commit and so differs at the first re-render, which is no new svg.)
    // The binding mutates the signal object it is given: hand it a copy.
    // `event.item` (mark type / name / role / datum / enclosing group) comes from the scene hit index, the
    // same one that serves tooltips and clicks, so `@name:click` and `symbol:click` work without tooltips.
    const binding = interaction.bindSceneSignals(svg, scene, { ...mergedSignals }, {
      onSignal: (name, value, all) => {
        signalStore.write({ [name]: value }, all)
        signalListenersRef.current?.[name]?.(name, value)
        onSignalRef.current?.(name, value)
      },
      // (an item asked to be encoded again -- a handler's `encode: <set>`, the hover -- with no signal changed: the store moves on)
      onEncode: (all) => { signalStore.write({}, all) },
      // (a timer stream rewrites its store on every tick; only a tick that changes it is the animation's next frame)
      onData: (name, rows, fromTimer) => {
        const advanced = fromTimer && !sameRows(dataStore.get()[name] as unknown[] | undefined, rows)
        dataStore.merge({ [name]: rows }, advanced ? (snapshot) => timerEdits.add(snapshot) : undefined)
      },
      ...(stableLogger ? { logger: stableLogger } : {}),
      ...(preventDefault != null ? { preventDefault } : {}),
    }, {
      ...(eventSources ? { eventSources } : {}),
      pick: (x, y) => hitIndexFor(displayScene ?? scene)?.pick(x, y) ?? null, containerSize: liveContainerSize,
      ...(inputData ? { data: inputData } : {}), ...(host ? { owner: host } : {}), ...(events ? { events } : {}),
    })
    signalBindingRef.current = binding
    // a binding on a different host than the last one: the old host's timer streams are done
    const prev = lastBindingRef.current
    if (prev && prev.host !== host) prev.release()
    lastBindingRef.current = { host, release: binding.release }
    return () => {
      binding.detach()
      if (signalBindingRef.current === binding) signalBindingRef.current = null
    }
  }, [interactive, scene, displayScene, renderer, interaction, canvasCap, htmlProp, denseSvg, hasSignalListeners, mergedSignals, signalStore, dataStore, timerEdits, inputData, stableLogger, preventDefault, eventSources, hitIndexFor, liveContainerSize])

  // Canvas backend: size the backing store for devicePixelRatio and paint the scene whenever it changes: the appended marks of an
  // append-only scene, nothing for a scene that paints the same pixels, else all of it.
  React.useLayoutEffect(() => {
    if (renderer !== 'canvas' || !displayScene || canvasCap == null) return undefined
    const canvas = canvasRef.current
    if (!canvas) return undefined
    if (canvasElRef.current !== canvas) {
      // A new <canvas> (first mount, or back from the SVG renderer) is blank.
      canvasElRef.current = canvas
      canvasSnapshotRef.current = null
      canvasSceneRef.current = null
    }
    const dpr = pixelRatio
    const w = Math.max(1, Math.round(displayScene.width))
    const h = Math.max(1, Math.round(displayScene.height))
    let resized = false
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
      resized = true
    }
    // Image marks drawn from a url: paint the bitmaps already loaded, and load the missing ones (each load that ends repaints)
    const urls = canvasCap.sceneImageUrls(displayScene)
    let painted = displayScene
    if (urls.length > 0) {
      const imgs = canvasImagesRef.current
      const inScene = new Set(urls)
      for (const u of imgs.loaded.keys()) if (!inScene.has(u)) imgs.loaded.delete(u)
      for (const u of imgs.failed) if (!inScene.has(u)) imgs.failed.delete(u)
      painted = canvasCap.withSceneImages(displayScene, imgs.loaded)
      const missing = urls.filter((u) => !imgs.loaded.has(u) && !imgs.failed.has(u) && !imgs.pending.has(u))
      if (missing.length > 0) {
        for (const u of missing) imgs.pending.add(u)
        void canvasCap.loadImages(missing, {
          timeoutMs: CANVAS_IMAGE_TIMEOUT_MS,
          who: 'canvas',
          onError: (url, error) => {
            imgs.failed.add(url)
            ;(loggerRef.current ?? consoleLogger).warn(error.message)
          },
        }).then((loaded) => {
          for (const [u, bitmap] of loaded) imgs.loaded.set(u, bitmap)
          for (const u of missing) imgs.pending.delete(u)
          if (loaded.size > 0) setCanvasImagesEpoch((n) => n + 1)
        })
      }
    }
    // Identical scene, with the images it had: the canvas already shows it. Re-encoding/painting would
    // be a full repaint for zero visual change (the common no-op re-render).
    if (!resized && canvasSceneRef.current === displayScene && canvasImagesPaintedRef.current === canvasImagesEpoch) return undefined
    const ctx = canvas.getContext('2d')
    if (!ctx) return undefined
    // Append-only frames draw immediately: a handful of new items is cheaper
    // than a frame of latency, and drawing synchronously prevents a later
    // stream mutation from racing a coalesced rAF repaint. Full repaints still
    // go through rAF so they never block React's commit. (Image marks never take the append path, and a frame repainted because its
    // images arrived has appended nothing, so it is painted in full.)
    const prev = resized ? null : canvasSnapshotRef.current
    if (prev != null && canvasCap.renderSceneToCanvasAppend(prev, displayScene, ctx, { dpr })) {
      canvasSnapshotRef.current = canvasCap.snapshotCanvasScene(displayScene)
      canvasSceneRef.current = displayScene
      canvasImagesPaintedRef.current = canvasImagesEpoch
      return undefined
    }
    // A scene that paints exactly the pixels on the canvas (a signal that changed only a tooltip) paints nothing. (Not for image
    // marks: their bitmaps are the chart's, not the scene's.)
    if (prev != null && urls.length === 0 && canvasImagesPaintedRef.current === canvasImagesEpoch && canvasCap.paintsSameAs(prev, displayScene)) {
      canvasSnapshotRef.current = canvasCap.snapshotCanvasScene(displayScene)
      canvasSceneRef.current = displayScene
      return undefined
    }
    const draw = (): void => {
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      try {
        canvasCap.renderSceneToCanvas(painted, ctx, { dpr })
      } catch (e) {
        reportRenderError(loggerRef.current, e)
      }
      canvasSnapshotRef.current = canvasCap.snapshotCanvasScene(displayScene)
      canvasSceneRef.current = displayScene
      canvasImagesPaintedRef.current = canvasImagesEpoch
    }
    if (typeof requestAnimationFrame === 'function') {
      const id = requestAnimationFrame(draw)
      return () => cancelAnimationFrame(id)
    }
    draw()
    return undefined
  }, [renderer, displayScene, canvasCap, canvasImagesEpoch, pixelRatio])

  const hasSelection = onSelect != null || brush != null || onPointSelect != null
    || selection !== undefined || select !== undefined || onSelectionChange != null
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
  /** Where a pan drag started: the pointer, and each pannable axis's domain, its signed pixel length and its scale then. */
  const panStartRef = React.useRef<{ x: number; y: number; axes: Partial<Record<'x' | 'y', { domain: [number, number]; pixelSpan: number; scale: unknown }>> } | null>(null)
  const pointersRef = React.useRef<Map<number, { x: number; y: number }>>(new Map())
  const pinchRef = React.useRef<{ dist: number; cx: number; cy: number } | null>(null)

  // The pointer in the chart's own coordinates (the svg's user space, or the canvas's pixels; vega-scenegraph point()), read
  // through the svg's screen CTM, or the canvas's box past its border, so a CSS-scaled, bordered or transformed chart maps right.
  // Measured once and reused (no layout read per move); forgotten by `invalidatePointer` on anything that can change it.
  const pointerMapper = React.useMemo(
    () => createPointMapper(() => canvasRef.current ?? svgHostRef.current?.querySelector('svg') ?? containerRef.current),
    [],
  )

  /** The live scale of a positional axis (its type decides the space it pans and zooms in: see `zoomAxisBy`). */
  const axisScale = (info: ChartInfo, axis: 'x' | 'y'): unknown => {
    const name = gestureInputsRef.current.positional[axis]
    return name != null ? info.scales.get(name) : undefined
  }
  /** The live positional scales, for the keyboard's pan and zoom (each in its scale's own space). */
  const liveAxisScales = (): { x?: unknown; y?: unknown } => {
    const info = chartInfoRef.current
    return info ? { x: axisScale(info, 'x'), y: axisScale(info, 'y') } : {}
  }
  /** The axes a gesture can zoom: those with a base domain (a continuous positional scale). */
  const zoomableAxes = (axes: Array<'x' | 'y'>): Array<'x' | 'y'> => axes.filter((a) => baseDomainsRef.current[a] != null)

  // Zoom around the pointer by vega's stretch `k` (< 1 zooms in), each axis in its scale's own space, within the base extent
  // and `maxZoom` (see `zoomAxisBy`).
  const zoomAxes = React.useCallback((axes: Array<'x' | 'y'>, px: number, py: number, k: number) => {
    const info = chartInfoRef.current
    if (!info) return
    const base = baseDomainsRef.current
    const max = gestureInputsRef.current.maxZoom
    let next: ViewDomain = { ...(viewRef.current ?? {}) }
    let changed = false
    for (const axis of axes) {
      const scale = axisScale(info, axis) as { invert?: (v: number) => unknown } | undefined
      if (typeof scale?.invert !== 'function') continue
      const local = axis === 'x' ? px - info.padding.left : py - info.padding.top
      // (a time or utc scale inverts to a Date: its milliseconds)
      const anchor = Number(scale.invert(local))
      if (!Number.isFinite(anchor)) continue
      // Compose both axes into one update: a controlled host receives one view
      // value per gesture, not x from one call and y from a stale snapshot.
      const zoomed = zoomAxisBy(next, base, axis, anchor, k, scale, max)
      if (zoomed[axis] !== next[axis]) changed = true
      next = zoomed
    }
    if (changed) applyViewRef.current(next)
  }, [])

  React.useEffect(() => {
    if (!zoomEnabled) return
    const el = containerRef.current
    if (!el) return
    const onWheel = (evt: WheelEvent): void => {
      // a wheel over a bound input or another control inside the chart is the control's
      if (isOwnControl(evt.target)) return
      // (a horizontal scroll zooms nothing, and is left to the page)
      if (Math.abs(evt.deltaY) < 0.01) return
      const axes = zoomableAxes(['x', 'y'])
      if (axes.length === 0) return
      evt.preventDefault()
      const [px, py] = pointerMapper.map(evt.clientX, evt.clientY)
      zoomAxes(axes, px, py, wheelStretch(evt))
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
    panStartRef.current = null
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
    if (isOwnControl(e.target)) return
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
      const info = chartInfoRef.current
      const axes: NonNullable<typeof panStartRef.current>['axes'] = {}
      if (info) {
        for (const axis of ['x', 'y'] as const) {
          const domain = (viewRef.current?.[axis] ?? baseDomainsRef.current[axis]) as [number, number] | undefined
          const scale = axisScale(info, axis)
          const pixelSpan = domain ? pixelSpanOf(scale, domain) : null
          if (domain && pixelSpan != null) axes[axis] = { domain, pixelSpan, scale }
        }
      }
      panStartRef.current = { x, y, axes }
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
      if (prev.dist > 0 && dist > 0) zoomAxes(zoomableAxes(['x', 'y']), cx, cy, prev.dist / dist)
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
      // Move the data with the pointer, from where the drag started: the data that was under the pointer then is under it
      // now, on every scale type (each axis pans in its scale's own space: see `dragPan`).
      const pan = panStartRef.current
      if (!pan) return
      const next: ViewDomain = { ...(viewRef.current ?? {}) }
      for (const axis of ['x', 'y'] as const) {
        const a = pan.axes[axis]
        if (a) next[axis] = dragPan(a.domain, axis === 'x' ? pan.x : pan.y, axis === 'x' ? x : y, a.pixelSpan, a.scale)
      }
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
          // vega's event item (the topmost item that takes the pointer); a click selects it when it is an item of a mark, whose
          // datum is its row (or the `{}` of a mark without `from`, as in vega), never a group's box or a guide's part
          const target = hitIndexFor(g.displayScene)?.pick(x, y)
          const raw = target?.kind === 'mark' ? target.item.datum : undefined
          datum = raw != null && typeof raw === 'object' ? raw as Record<string, unknown> : null
          g.onPointSelect?.(datum)
        }
        g.onSelect?.(null)
        // the click replaces the interval: by the point it selected, else by nothing (the host was told `onSelect(null)`)
        emitSelectionRef.current(pointSelect ? { type: 'point', datum } : null)
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
    const live = sceneScaleMap(displayScene) !== undefined
    const scales = (live ? chartInfo?.scales : undefined) ?? new Map()
    return buildA11yTree(displayScene, scales as Map<string, unknown>, a11yOpts)
  }, [displayScene, a11yOpts, chartInfo])
  const a11yNodesRef = React.useRef<A11yNode[]>([])
  const activeA11yIdRef = React.useRef<string | null>(null)
  activeA11yIdRef.current = activeA11yId
  a11yNodesRef.current = a11yTree?.nodes ?? []
  // A chart is ONE tab stop. With pan or zoom the container is it (it owns the pan/zoom keys) and the nodes are only
  // programmatically focusable, reached from the container with PageDown / PageUp; otherwise the nodes are a roving
  // tabindex group (the last focused one is the stop, else the first). Arrows / PageUp / PageDown move between nodes.
  const a11yNodes = a11yTree?.nodes
  const tabStopId = panZoomEnabled ? null : a11yNodes?.some((n) => n.id === activeA11yId) ? activeA11yId : (a11yNodes?.[0]?.id ?? null)
  // Where focus is within the chart (a node id, or the container), so a commit that removes the focused element can put it
  // back instead of dropping it on <body>.
  const focusSpotRef = React.useRef<FocusSpot | null>(null)
  React.useLayoutEffect(() => () => { focusHandoff.current = focusSpotRef.current }, [focusHandoff])
  // Focus leaving an element ends the claim, unless the element is being removed by a commit (which can blur it too): a
  // blur to another element ends it at once, a blur to nowhere is judged after the commit, when a removed element is gone.
  const releaseFocusSpot = React.useCallback((el: HTMLElement, to: EventTarget | null): void => {
    if (to != null) { focusSpotRef.current = null; return }
    queueMicrotask(() => { if (el.isConnected && document.activeElement !== el) focusSpotRef.current = null })
  }, [])
  React.useLayoutEffect(() => {
    // the chart this one replaced (its cleanup ran in this same commit) left its focus to be taken over
    if (focusHandoff.current != null) { focusSpotRef.current = focusHandoff.current; focusHandoff.current = null }
    const host = containerRef.current
    const spot = focusSpotRef.current
    if (!host || spot == null) return
    const active = document.activeElement
    if (active != null && active !== document.body && host.contains(active)) return
    // focus is on <body> or in another widget; only act if it was this chart's focus that was lost (nothing else took it)
    if (active != null && active !== document.body) return
    const byId = (id: string): HTMLElement | null => host.querySelector<HTMLElement>(`[data-a11y-id="${CSS.escape(id)}"]`)
    const target = (spot !== CONTAINER_FOCUS ? byId(spot) : null)
      ?? (panZoomEnabled ? host : null)
      ?? (tabStopId != null ? byId(tabStopId) : null)
    if (target == null) { focusSpotRef.current = null; return }
    target.focus({ preventScroll: true })
  })

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
    const el = host.querySelector<HTMLElement>(`[data-a11y-id="${CSS.escape(next.id)}"]`)
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
      const result = keyboardView(e.key, viewRef.current, base, { axis, fast: e.shiftKey, pan: g.panEnabled, zoom: g.zoomEnabled, scales: liveAxisScales() })
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

  const handleA11yFocus = React.useCallback((node: A11yNode, e: React.FocusEvent<HTMLDivElement>) => {
    setActiveA11yId(node.id)
    focusSpotRef.current = node.id
    e.currentTarget.style.opacity = '0.001'
  }, [])
  const handleA11yBlur = React.useCallback((e: React.FocusEvent<HTMLDivElement>) => {
    e.currentTarget.style.opacity = '0'
    releaseFocusSpot(e.currentTarget, e.relatedTarget)
  }, [releaseFocusSpot])

  const handleChartKeyDown = React.useCallback((e: React.KeyboardEvent) => {
    if (e.defaultPrevented) return
    // a key typed in a bound input (or another control inside the chart) is the control's: no pan, zoom, reset or clear
    if (isOwnControl(e.target)) return
    const g = gestureInputsRef.current
    // The container is the chart's tab stop; PageDown / PageUp take focus into the nodes (the arrows pan here).
    if (e.target === e.currentTarget && (e.key === 'PageDown' || e.key === 'PageUp')) {
      const nodes = a11yNodesRef.current
      const entry = e.key === 'PageUp' ? nodes.at(-1) : nodes.find((n) => n.id === activeA11yIdRef.current) ?? nodes[0]
      if (entry == null) return
      e.preventDefault()
      e.stopPropagation()
      setActiveA11yId(entry.id)
      containerRef.current?.querySelector<HTMLElement>(`[data-a11y-id="${CSS.escape(entry.id)}"]`)?.focus()
      return
    }
    if (e.key === 'Escape') {
      emitSelectionRef.current(null)
      g.onSelect?.(null)
      g.onPointSelect?.(null)
      return
    }
    if (!g.panEnabled && !g.zoomEnabled) return
    const result = keyboardView(e.key, viewRef.current, baseDomainsRef.current, { fast: e.shiftKey, pan: g.panEnabled, zoom: g.zoomEnabled, scales: liveAxisScales() })
    if (result.handled) {
      e.preventDefault()
      applyViewRef.current(result.view ?? null)
    }
  }, [])

  const handleTooltipMove = React.useCallback(
    (e: React.MouseEvent) => {
      if (!tooltipEnabled) return
      // The item under the pointer, from the scene hit index, whatever the renderer: the SVG carries no per-item
      // attribute for it (vega's does not either), so SVG, canvas and batched marks all resolve the same way. It is the item
      // vega's tooltip handler is called with: the topmost item that takes the pointer (a mark without `from`, a group's box and
      // an interactive guide part included, as in vega), a line, an area or a trail resolved to one of its items.
      const [sx, sy] = pointerMapper.map(e.clientX, e.clientY)
      const target = hitIndexFor(displayScene)?.tooltip(sx, sy)
      const item = target?.item
      const datum = item?.datum
      const hasDatum = datum != null && typeof datum === 'object'
      const tip = (item as { tooltip?: unknown } | undefined)?.tooltip
      // vega shows the item's `tooltip`; a custom renderer is also called for an item of a mark that reads a dataset (the row
      // is the datum), not for one whose only datum is vega's generated `{}` (a mark without `from`, a group, a guide part)
      // (vega hands its tooltip handler `item.tooltip || null`: a falsy value -- '', 0, false, NaN -- is no tooltip)
      const shows = item != null && (!!tip || (renderTooltip != null && target!.kind === 'mark' && target!.fromData === true))
      // (the pointer's client point: the tooltip is a fixed box placed in the viewport, wherever the chart and its page are scrolled)
      tooltipStore.set(shows ? { datum: hasDatum ? (datum as Record<string, unknown>) : {}, item, x: e.clientX, y: e.clientY, doc: e.currentTarget.ownerDocument } : null)
    },
    [tooltipEnabled, displayScene, hitIndexFor, pointerMapper, renderTooltip, tooltipStore],
  )

  const handleTooltipLeave = React.useCallback(() => {
    if (tooltipEnabled) tooltipStore.set(null)
  }, [tooltipEnabled, tooltipStore])
  // Tooltips turned off while one shows: it goes, and turning them on again does not bring back the item hovered before.
  React.useEffect(() => {
    if (!tooltipEnabled) tooltipStore.set(null)
  }, [tooltipEnabled, tooltipStore])

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
  // (a controlled `brush`, `null` included, wins over the selection value)
  const persistedInterval = brush !== undefined ? brush : selectValueToInterval(selectionValue)
  const brushPixelRect = React.useMemo(() => {
    if (!persistedInterval || chartInfo == null) return null
    return clippedSelectionRect(persistedInterval, chartInfo, positional)
  }, [persistedInterval, chartInfo, positional])

  // --- imperative handle ------------------------------------------
  React.useImperativeHandle(chartRef, () => {
    /** The scene a handle call sees: none once the chart is unmounted. */
    const liveScene = (): SceneRoot | null => (mountedRef.current ? sceneRef.current : null)
    return {
    getScene: liveScene,
    getSvg: () => { const sc = liveScene(); return sc ? renderSceneToSvg(sc) : null },
    getPng: async (options) => {
      // the scene of the call, not of whenever the painter has loaded
      const scene = liveScene()
      const cap = pngCapRef.current
      if (cap == null) throw new Error(PNG_NEEDS_CAPABILITY)
      if (scene == null) return null
      const { renderSceneToPng } = await cap.load()
      const onImageError = options?.onImageError
        ?? ((url: string, error: Error) => (loggerRef.current ?? consoleLogger).warn(`[aster] getPng: ${error.message}`, url))
      return renderSceneToPng(scene, { ...options, onImageError })
    },
    getChartInfo: () => (mountedRef.current ? chartInfoRef.current : null),
    getView: () => (mountedRef.current ? viewRef.current ?? null : null),
    setView: (next) => { if (mountedRef.current) applyViewRef.current(next) },
    resetView: () => { if (mountedRef.current) applyViewRef.current(null) },
    // Portable: with the event loop bound (SVG or canvas) it runs the spec's
    // dependent signal updates; otherwise (`interactive={false}`, `<SvgChart>`
    // without `interaction`) the value is applied as a signal override.
    // Listeners are notified either way.
    setSignal: (name, value) => {
      if (!mountedRef.current) return
      const binding = signalBindingRef.current
      if (binding) {
        setThroughLoop(binding, signalStoreRef.current, name, value)
        return
      }
      signalStoreRef.current?.write({ [name]: value })
      signalListenersRef.current?.[name]?.(name, value)
      onSignalRef.current?.(name, value)
    },
    getSignals: () => (mountedRef.current ? { ...mergedSignalsRef.current } : {}),
    }
  }, [])

  // What the bound inputs show: the signal values the scene was drawn with (a spec's own value, `null` included, and what an
  // update expression computed), else the merged inputs of a scene that does not carry them.
  const boundValues = (scene as { signalParams?: Record<string, unknown> } | null)?.signalParams ?? mergedSignals
  const reportBindUnsupported = React.useCallback((message: string): void => { (loggerRef.current ?? console).warn(message) }, [])
  const setBoundSignal = React.useCallback((name: string, value: unknown): void => {
    const binding = signalBindingRef.current
    if (binding) {
      setThroughLoop(binding, signalStore, name, value)
      return
    }
    signalStore.write({ [name]: value })
    signalListenersRef.current?.[name]?.(name, value)
    onSignalRef.current?.(name, value)
  }, [signalStore])

  // The error state is drawn INSIDE the chart's own element: the element (and every effect bound to it -- the measurement,
  // the wheel, the pointer listeners) is the same before, during and after an error, so a chart that recovers needs nothing
  // re-attached, and the host's `className`, `style` and `ariaLabel` apply in both states.
  const failed = scene === null
  // Absolute-positioned children (brush overlays, a11y nodes) need a positioned
  // ancestor even on a non-interactive chart. (The tooltip is a fixed box placed in
  // the viewport, see ChartTooltip; a chart with tooltips keeps the style it had.)
  const needsPositioning = hasInteraction || tooltipEnabled || a11yTree != null
  // The host's `style` comes last and wins, whatever is on (C294): a `position` of its own other than `static` keeps the
  // overlays positioned. A chart that takes drags (a brush, a pan) takes them from touch too: the browser does not scroll the
  // page under them (C491).
  const baseStyle: React.CSSProperties = {
    ...(needsPositioning ? { position: 'relative' } : {}),
    width: '100%', height: '100%',
    ...(hasInteraction ? { touchAction: 'none' } : {}),
    ...style,
  }
  // vega shows 'default' where no item and no spec signal says otherwise; a host's own `style.cursor` takes that place, but
  // not the cursor of an item or of the spec's `cursor` signal, which is the chart saying what is under the pointer
  const outerStyle: React.CSSProperties = cursor === null ? baseStyle
    : cursor === 'default' ? { cursor, ...baseStyle }
    : { ...baseStyle, cursor }

  const role = a11yTree || failed ? (ariaLabel ? 'group' : undefined) : ariaLabel ? 'img' : undefined

  return (
    <div
      ref={containerRef}
      role={role}
      aria-label={ariaLabel}
      tabIndex={panZoomEnabled && !failed ? 0 : undefined}
      onFocus={(e) => { if (e.target === e.currentTarget) focusSpotRef.current = CONTAINER_FOCUS }}
      onBlur={(e) => { if (e.target === e.currentTarget) releaseFocusSpot(e.currentTarget, e.relatedTarget) }}
      onKeyDown={handleChartKeyDown}
      onDoubleClick={panZoomEnabled ? (e) => { if (!isOwnControl(e.target)) applyViewRef.current(null) } : undefined}
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
      {failed && (
        <div role="alert" title={renderError?.message}>
          {renderError instanceof AsterLimitError ? renderError.message : 'Chart render failed'}
        </div>
      )}
      {!failed && hasInteraction && (
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
      {failed ? null : renderer === 'canvas' ? (
        <canvas
          ref={canvasRef}
          data-testid="chart-canvas"
          aria-hidden={a11yTree != null ? true : undefined}
          // (as vega's canvas renderer: at a pixel ratio of 1 the backing store is the canvas's size, and a host's CSS sizes it as it
          // sizes any image -- `max-width` with `height: auto` keeps its proportions, and the pointer maps by that box; at another
          // ratio the store is larger and the CSS size says how large the canvas is)
          style={pixelRatio === 1 ? canvasStyle : { ...canvasStyle, width: scene.width, height: scene.height }}
        />
      ) : (
        <div
          ref={svgHostRef}
          aria-hidden={a11yTree != null ? true : undefined}
          // (`lineHeight: 0`: the inline <svg> sits on a text baseline, and the descender space under it would make the
          // element a few pixels taller than the chart, so a container sized by the chart grew on every measurement)
          style={{ position: 'relative', zIndex: 1, lineHeight: 0 }}
          // (server markup may differ from the client's -- another time zone, another text measurer -- and the chart patches
          // it to the client scene after hydrating, so React's warning about the difference is not the host's to act on)
          suppressHydrationWarning
          {...(htmlProp != null ? { dangerouslySetInnerHTML: htmlProp } : {})}
        />
      )}
      {!failed && bindDefs.length > 0 && (
        <SignalBinds
          // (React keeps the server's attributes where a hydrated element's differ, and does not patch them: the parts drawn
          // from the scene are made anew once hydration is over, from the client's scene; see the svg's patch, C45. Each sibling
          // has keys of its own: two siblings with one key are elements React cannot tell apart, and it adds one on every render)
          key={hydrating ? 'binds-server' : 'binds-client'}
          idPrefix={chartId}
          signals={bindDefs}
          values={boundValues}
          onChange={setBoundSignal}
          onUnsupported={reportBindUnsupported}
        />
      )}
      {!failed && a11yTree != null && (
        <A11yOverlay key={hydrating ? 'a11y-server' : 'a11y-client'} tree={a11yTree} tabStopId={tabStopId} onNodeKeyDown={handleA11yKeyDown} onNodeFocus={handleA11yFocus} onNodeBlur={handleA11yBlur} />
      )}
      {tooltipEnabled && <ChartTooltip store={tooltipStore} renderTooltip={renderTooltip} interaction={interaction} container={tooltipContainer} />}
    </div>
  )
}

interface A11yOverlayProps {
  tree: { label: string; summary?: string; nodes: readonly A11yNode[] }
  tabStopId: string | null
  onNodeKeyDown: (node: A11yNode, e: React.KeyboardEvent) => void
  onNodeFocus: (node: A11yNode, e: React.FocusEvent<HTMLDivElement>) => void
  onNodeBlur: (e: React.FocusEvent<HTMLDivElement>) => void
}

/**
 * The accessible overlay: a focusable, invisible element over every node of the accessible tree. A scene that leaves the tree as it
 * was (every node holding what it held: the same values, the same datum) renders nothing of it again (see `sameOverlay`).
 */
const A11yOverlay = React.memo(function A11yOverlay({ tree, tabStopId, onNodeKeyDown, onNodeFocus, onNodeBlur }: A11yOverlayProps): React.ReactElement {
  return (
    <div
      className="aster-a11y"
      data-testid="chart-a11y"
      role="group"
      aria-label={tree.label}
      style={{ position: 'absolute', inset: 0, zIndex: 30, pointerEvents: 'none' }}
      // (every element of the overlay is drawn from the scene, and a server that drew another scene than the client -- its text
      // measurer, its time zone -- wrote other positions and labels: React keeps the server's attributes where they differ and
      // reports it once per element. The overlay is made anew from the client's scene once hydration is over, `key` above, so
      // the difference is not the host's to act on; this is React's own switch for markup that is meant to differ)
      suppressHydrationWarning
    >
      {tree.summary != null && <span className="sr-only" style={srOnly} suppressHydrationWarning>{tree.summary}</span>}
      {tree.nodes.map((node) => {
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
            suppressHydrationWarning
            onKeyDown={(e) => onNodeKeyDown(node, e)}
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
            onFocus={(e) => onNodeFocus(node, e)}
            onBlur={onNodeBlur}
          />
        )
      })}
    </div>
  )
}, sameOverlay)

/** Two overlays render the same: the same handlers, tab stop, label and summary, and nodes that hold the same values (`Object.is`). */
function sameOverlay(a: A11yOverlayProps, b: A11yOverlayProps): boolean {
  if (a.tabStopId !== b.tabStopId || a.onNodeKeyDown !== b.onNodeKeyDown || a.onNodeFocus !== b.onNodeFocus || a.onNodeBlur !== b.onNodeBlur) return false
  if (a.tree === b.tree) return true
  if (a.tree.label !== b.tree.label || a.tree.summary !== b.tree.summary || a.tree.nodes.length !== b.tree.nodes.length) return false
  for (let i = 0; i < a.tree.nodes.length; i++) if (!sameNode(a.tree.nodes[i]!, b.tree.nodes[i]!)) return false
  return true
}

/** Every own property of the two nodes is the same value (a `domain` pair by its two numbers). */
function sameNode(a: A11yNode, b: A11yNode): boolean {
  if (a === b) return true
  const ka = Object.keys(a)
  if (ka.length !== Object.keys(b).length) return false
  for (const k of ka) {
    if (!Object.hasOwn(b, k)) return false
    const x = (a as unknown as Record<string, unknown>)[k]
    const y = (b as unknown as Record<string, unknown>)[k]
    if (Object.is(x, y)) continue
    if (k === 'domain' && Array.isArray(x) && Array.isArray(y) && x.length === y.length && x.every((v, i) => Object.is(v, y[i]))) continue
    return false
  }
  return true
}

/** What the tooltip shows: the item under the pointer, its datum, the pointer's client point and the chart's document. */
interface TooltipInfo { datum: Record<string, unknown>; item: SceneItem; x: number; y: number; doc: Document }

/** The tooltip under the pointer (see `ChartTooltip`): told only of a tooltip that is not the one it holds. */
interface TooltipStore {
  get: () => TooltipInfo | null
  subscribe: (listener: () => void) => () => void
  set: (next: TooltipInfo | null) => void
}

function createTooltipStore(): TooltipStore {
  let current: TooltipInfo | null = null
  const listeners = new Set<() => void>()
  return {
    get: () => current,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    set(next) {
      const was = current
      if (was === next || (was !== null && next !== null && was.item === next.item && was.datum === next.datum && was.x === next.x && was.y === next.y && was.doc === next.doc)) return
      current = next
      for (const l of listeners) l()
    },
  }
}

/** How far the tooltip sits from the pointer, across and down (vega-tooltip's `offsetX` / `offsetY`), in CSS pixels. */
const TOOLTIP_OFFSET = 10

/**
 * The room the tooltip has: the viewport, less a classic scrollbar (the document element's client box, where a document in
 * standards mode has one; a quirks-mode document's is the whole page, and a document with no layout reports 0).
 */
function viewportOf(doc: Document): { width: number; height: number } {
  const root = doc.documentElement
  const win = doc.defaultView
  const innerWidth = win?.innerWidth ?? root.clientWidth
  const innerHeight = win?.innerHeight ?? root.clientHeight
  return {
    width: root.clientWidth > 0 ? Math.min(root.clientWidth, innerWidth) : innerWidth,
    height: root.clientHeight > 0 ? Math.min(root.clientHeight, innerHeight) : innerHeight,
  }
}

/**
 * Where the tooltip's box goes for a pointer at the client point (x, y), as vega-tooltip places it (its `anchor: 'cursor'`): the
 * first of below-right, below-left, above-right and above-left of the pointer, at the offset, where the whole box is in the
 * viewport; above-left when it fits nowhere.
 */
function tooltipPlacement(
  x: number, y: number, box: { width: number; height: number }, viewport: { width: number; height: number },
): { left: number; top: number } {
  const right = x + TOOLTIP_OFFSET
  const left = x - TOOLTIP_OFFSET - box.width
  const below = y + TOOLTIP_OFFSET
  const above = y - TOOLTIP_OFFSET - box.height
  const fits = (l: number, t: number): boolean => l >= 0 && t >= 0 && l + box.width <= viewport.width && t + box.height <= viewport.height
  for (const [l, t] of [[right, below], [left, below], [right, above]] as const) {
    if (fits(l, t)) return { left: l, top: t }
  }
  return { left, top: above }
}

/**
 * The tooltip of the item under the pointer. It reads the tooltip store on its own, so a pointer move renders it and not the chart.
 * The default tooltip shows the hovered item's `tooltip` channel value, as vega-tooltip does (null: no tooltip); vega-view hands the
 * handler `item.tooltip || null`, so a falsy value shows nothing.
 *
 * Where it renders, as vega-tooltip's element: a `position: fixed` box in the document's body (the fullscreen element while there is
 * one), through a portal, so the chart's ancestors neither clip it nor grow their scroll area with it; `container` puts it in another
 * element, and `null` in the chart's own element. The content stays in the chart's React tree (context reaches `renderTooltip`'s).
 * Each move renders it hidden at the origin of its containing block, measures it there (one measurement, full width available to
 * it) and renders it where it goes, both before the browser paints.
 */
function ChartTooltip({ store, renderTooltip, interaction, container }: {
  store: TooltipStore
  renderTooltip: ChartProps['renderTooltip']
  interaction: InteractionCapability | undefined
  container: HTMLElement | null | undefined
}): React.ReactElement | null {
  const tooltipInfo = React.useSyncExternalStore(store.subscribe, store.get, store.get)
  const item = tooltipInfo?.item
  const datum = tooltipInfo?.datum
  // (the content depends on the item and its datum, not on where the pointer is: a move over the same item renders none of it again)
  const tooltipShown = React.useMemo(
    () => (item != null && renderTooltip == null && interaction != null
      ? interaction.tooltipContent((item as { tooltip?: unknown }).tooltip || null)
      : null),
    [item, renderTooltip, interaction],
  )
  const content = React.useMemo(
    () => (item == null || datum == null ? null
      : renderTooltip != null
        ? renderTooltip(datum, { tooltip: (item as { tooltip?: unknown }).tooltip, item })
        : tooltipShown != null && ('text' in tooltipShown
          ? tooltipShown.text
          : <>
              {tooltipShown.title != null && <div><strong>{tooltipShown.title}</strong></div>}
              {tooltipShown.rows.map(([k, v]) => (
                <div key={k}><strong>{k}:</strong> {v}</div>
              ))}
            </>)),
    [item, datum, renderTooltip, tooltipShown],
  )
  const target = tooltipInfo == null ? null
    : container === undefined ? (tooltipInfo.doc.fullscreenElement ?? tooltipInfo.doc.body) : container
  const boxRef = React.useRef<HTMLDivElement>(null)
  // Where the box goes, for the pointer, content and container it was measured with.
  const [placed, setPlaced] = React.useState<{ info: TooltipInfo; content: React.ReactNode; target: Element | null; left: number; top: number } | null>(null)
  const at = placed != null && placed.info === tooltipInfo && placed.content === content && placed.target === target ? placed : null
  React.useLayoutEffect(() => {
    const box = boxRef.current
    if (tooltipInfo == null || box == null || at != null) return
    // Rendered hidden at left 0, top 0: its rect is its size and where its containing block starts (the viewport's origin, or a
    // transformed ancestor's, which the placement is then made up for).
    const rect = box.getBoundingClientRect()
    const p = tooltipPlacement(tooltipInfo.x, tooltipInfo.y, rect, viewportOf(box.ownerDocument))
    setPlaced({ info: tooltipInfo, content, target, left: p.left - rect.left, top: p.top - rect.top })
  }, [tooltipInfo, content, target, at])
  if (tooltipInfo == null || (renderTooltip == null && tooltipShown == null)) return null
  const box = (
    <div
      ref={boxRef}
      data-testid="chart-tooltip"
      style={{
        position: 'fixed',
        left: at?.left ?? 0,
        top: at?.top ?? 0,
        ...(at == null ? { visibility: 'hidden' } : {}),
        zIndex: 1000,
        pointerEvents: 'none',
        background: 'rgba(0,0,0,0.85)',
        color: '#fff',
        padding: '4px 8px',
        borderRadius: 4,
        fontSize: 12,
        fontFamily: 'system-ui, sans-serif',
        maxWidth: 240,
        // (long values wrap inside the box: a list with no spaces breaks anywhere rather than run past the background)
        whiteSpace: 'normal',
        overflowWrap: 'anywhere',
      }}
    >
      {content}
    </div>
  )
  return target == null ? box : createPortal(box, target)
}

/**
 * Whether an event comes from a control inside the chart (a bound input, a form control, a link, an editable element): such
 * an event is the control's, never a chart gesture (`docs/INTERACTION.md`: "a gesture on a form control or link is ignored").
 */
function isOwnControl(target: EventTarget | null): boolean {
  return (target as Element | null)?.closest?.('[data-aster-binds], input, select, textarea, button, a, [contenteditable]:not([contenteditable="false"])') != null
}

/**
 * How far a wheel event zooms, as vega's stretch `k` (< 1 zooms in): Vega-Lite's `pow(1.001, event.deltaY * pow(16,
 * event.deltaMode))`, so a line-mode notch counts as sixteen pixels and a page as 256 (C488), with or without a modifier key.
 */
function wheelStretch(evt: WheelEvent): number {
  return Math.pow(1.001, evt.deltaY * Math.pow(16, evt.deltaMode))
}

/** The bound inputs `<Chart>` renders under the chart, inside its element. */
const bindsOf = (el: HTMLElement): HTMLElement | null => el.querySelector<HTMLElement>(':scope > [data-aster-binds]')
/** Their height: the part of the element's height that is not the chart's. */
const bindsHeight = (el: HTMLElement): number => bindsOf(el)?.getBoundingClientRect().height ?? 0

const CONTAINER_FOCUS = Symbol('container')
/** Where focus is inside a chart: the id of an a11y node, or the container. */
type FocusSpot = string | typeof CONTAINER_FOCUS

const canvasStyle: React.CSSProperties = { position: 'relative', zIndex: 1, display: 'block' }

const srOnly: React.CSSProperties = {
  position: 'absolute', width: 1, height: 1, padding: 0, margin: -1,
  overflow: 'hidden', clip: 'rect(0,0,0,0)', whiteSpace: 'nowrap', border: 0,
}

type HoverMarks = ReadonlyArray<{ encode?: Readonly<Record<string, unknown>>; marks?: HoverMarks }>
/** Whether a mark of a compiled chart, at any depth, has a `hover` encode set. */
function hasHoverSet(marks: HoverMarks | undefined): boolean {
  for (const m of marks ?? []) if (m.encode?.hover != null || hasHoverSet(m.marks)) return true
  return false
}
