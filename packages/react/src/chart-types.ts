import type * as React from 'react'
import type {
  A11yOptions,
  ChartInfo,
  ImageUrlPolicy,
  Logger,
  SceneRoot,
  SpecLimits,
  TextMetricsProvider,
  VgSpec,
} from '@aster/core'
import type { SelectValue, SelectionInterval, ViewDomain } from './interaction.js'

// The public prop and handle types of `<Chart>`. They live apart from the component so the
// two shells over `ChartCore` (`<Chart>` and `<SvgChart>`) and the parity tests that compare
// them (`Chart.parity.types.ts`) share one definition.

export interface ChartProps {
  /**
   * A Vega spec, a Vega-Lite spec (needs `import '@aster/react/vl'`), or a
   * promise of either (suspends to the host's `<Suspense>`). Compared by
   * content: re-rendering with an equal inline literal does no work.
   */
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
  /**
   * Signal values for the spec's signals. Event- and input-driven values take
   * precedence; they are overwritten whenever this prop changes.
   */
  signals?: Record<string, unknown>
  /** Interval brush: called with the dragged interval on release (`x`/`y` = the horizontal/vertical positional scale), and with `null` for a click. */
  onSelect?: (interval: SelectionInterval | null) => void
  /**
   * Point/click selection: called with the clicked mark's datum (or null for a
   * click on empty space). Resolved through the scene hit index, so it works
   * identically on the SVG and canvas backends.
   */
  onPointSelect?: (datum: Record<string, unknown> | null) => void
  /** Persisted interval rectangle to draw (the legacy controlled form of `selection`). */
  brush?: SelectionInterval | null
  /**
   * Unified declarative selection (R10.2): either an interval or a point value.
   * Controlled when supplied (`select` wins when both are given);
   * `onSelectionChange` receives every change. A controlled or internal interval
   * is drawn as the persisted selection rectangle.
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
   * DOM event streams, a bound input (`signal.bind`) or the imperative
   * `ChartHandle.setSignal`. The chart re-renders with the updated signal
   * values after each event.
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
  /**
   * Budgets for untrusted specs (rows, marks, strings, paths, SVG size, time),
   * applied at every evaluation; a violation renders the error state and calls
   * `onError` with an `AsterLimitError`. `maxSvgLength` is checked by serializing
   * the scene (SVG renderer only), which costs one serialization per evaluation
   * and so only happens when it is set. Compared by content: an inline literal
   * is fine.
   */
  limits?: SpecLimits
  /**
   * Policy for image-mark `url`s, forwarded to evaluation (`RuntimeInput.urlPolicy`):
   * `baseURL`, `protocols`, a synchronous `allow(url)` veto and `onDeny` (drop the
   * image instead of failing the chart). Applied with its defaults whenever `limits`
   * is set. A denial without `onDeny` is a render error reported through `onError`.
   * Functions are compared by identity, so memoize the object to avoid re-evaluating.
   */
  urlPolicy?: ImageUrlPolicy
  /**
   * Where recovered errors go (`RuntimeInput.logger`, vega's logger shape): an expression that
   * throws while the chart is evaluated or while a `signal.on` event is handled is reported here
   * and the chart carries on, like vega. Default: the console. Only its presence is a dependency;
   * the latest object is always the one called.
   */
  logger?: Logger
  /**
   * Call `preventDefault()` on the events of `signal.on` streams from the chart's own surface
   * (vega's `view.preventDefault()`, default false). A stream marked `consume` always prevents.
   */
  preventDefault?: boolean
  /** Host text measurement for custom fonts / non-browser engines. */
  textMetrics?: TextMetricsProvider
  /** Accessible scene tree (R10.6). Enabled by default; pass `false` to opt out. */
  a11y?: boolean | A11yOptions
  /**
   * Called once per failed evaluation (typed `AsterLimitError` for budgets), and
   * once per rejected `dataChanges` changeset. A new callback identity does not
   * re-report the same error.
   */
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
