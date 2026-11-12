import type * as React from 'react'
import type {
  A11yOptions,
  ChartInfo,
  ImageUrlPolicy,
  UrlDataMode,
  Logger,
  SceneItem,
  SceneRoot,
  SpecLimits,
  TextMetricsProvider,
  VgSpec,
} from '@aster-charts/core'
import type { EasingName } from '@aster-charts/core/transition'
import type { PngOptions } from '@aster-charts/core/png'
import type { SelectValue, SelectionInterval, ViewDomain } from './interaction.js'

// The public prop and handle types of `<Chart>`. They live apart from the component so the
// two shells over `ChartCore` (`<Chart>` and `<SvgChart>`) and the parity tests that compare
// them (`parity.assert.ts`) share one definition.

/** What `renderTooltip` receives besides the datum: the hovered item and its `tooltip` value. */
export interface TooltipInfo {
  /** The item's `tooltip` channel value, as the spec encodes it (`undefined` when the mark has none). */
  tooltip: unknown
  /** The hovered scene item. */
  item: SceneItem
}

/** How a chart animates a change of its data (see `ChartProps.transition`). */
export interface TransitionOptions {
  /** Milliseconds. Default 300. */
  duration?: number
  /**
   * A named curve (`'linear'`, `'quad-in'`, `'quad-out'`, `'quad-in-out'`, `'cubic-in'`, `'cubic-out'`, `'cubic-in-out'`,
   * `'sin-in'`, `'sin-out'`, `'sin-in-out'`) or a function from linear progress in [0, 1] to eased progress. Default
   * `'cubic-in-out'`.
   */
  easing?: EasingName | ((t: number) => number)
  /**
   * `'user'` (default): no animation when the user prefers reduced motion (`prefers-reduced-motion: reduce`); `'always'`:
   * never animate; `'never'`: animate whatever the preference.
   */
  reducedMotion?: 'user' | 'always' | 'never'
  /**
   * The most items a transition animates. A change that would move more (data mark items and axis parts whose position,
   * size, opacity or colour changes) is drawn at once. Default 1000: past that, a frame costs more than an animation is worth
   * (docs/ANIMATION.md has the measured frame costs).
   */
  maxItems?: number
}

export interface ChartProps {
  /**
   * A Vega spec, a Vega-Lite spec (needs `import '@aster-charts/react/vl'`), or a
   * promise of either (suspends to the host's `<Suspense>`). Compared by
   * content: re-rendering with an equal inline literal does no work.
   */
  spec: VgSpec | Promise<VgSpec>
  /**
   * @internal Pre-evaluated scene override (streaming): when provided, the chart
   * renders this scene instead of evaluating the spec. `undefined` keeps the
   * normal session path; `null` renders the loading/error state. Used by
   * `<ChartStream>` / `<ChartWorkerStream>` so streamed scenes go through the
   * same DOM patcher, canvas renderer, interaction and a11y tree.
   *
   * Unstable, host-internal plumbing between those components and `<Chart>`: it
   * is not covered by semver and may change or go away in any release.
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
   * A fixed size is the view's size for a container-sized spec too (Vega-Lite's
   * `width: 'container'`): its `width` / `height` signals, including a
   * `window:resize` handler's, do not move it. The measured container (no prop)
   * only sizes a spec that has no such signal; one that drives them keeps
   * doing so, and reads the container through `containerSize()`.
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
   * spec `signal.on` mark events, which resolve their item the same way, do too.
   * Ignored for canvas (already batched). Server rendering always emits the
   * per-item markup so hydration matches; a client-only mount batches directly.
   */
  denseMarks?: boolean | 'auto'
  /**
   * Animate a change of the chart's data instead of drawing the new scene at once (SVG): `true` for the defaults, or
   * `{ duration, easing, reducedMotion }`. Off by default. A new `data` (or `dataChanges`), new rows in an otherwise
   * equal spec, a streamed scene (`<ChartStream>`) and a frame of a Vega-Lite `time` animation move the marks and the
   * axes from where they are drawn to the new scene, which is exactly what a chart without `transition` draws once it
   * settles. Items are matched by the mark's `key` (Vega-Lite's `key` channel), else by their order in the mark.
   *
   * Interaction (signals, brushes, hover, pan / zoom), a resize, hiding a legend entry and a new spec are drawn at once
   * (while a transition runs, such a change becomes its new end). Hit testing, tooltips, selection and the accessible
   * tree answer for the new scene from the start. The canvas renderer, batched dense marks (`denseMarks`) and
   * `incremental={false}` draw the new scene at once. The animation code loads on demand once this prop is set. Read
   * when a transition starts: a new options object does not restart one.
   */
  transition?: boolean | TransitionOptions
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
   * Unified declarative selection: either an interval or a point value.
   * Controlled when supplied (`select` wins when both are given);
   * `onSelectionChange` receives every change. A controlled or internal interval
   * is drawn as the persisted selection rectangle.
   */
  selection?: SelectValue | null
  /** Alias for `selection` (the declarative select value). */
  select?: SelectValue | null
  onSelectionChange?: (value: SelectValue | null) => void
  /**
   * Pan/zoom: wheel, drag, pinch and keyboard. The in-flight state is
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
  /**
   * Called with `(name, value)` for every signal that changes, whatever drives the
   * change (the spec's `signal.on` event streams, a bound input or
   * `ChartHandle.setSignal`). `signalListeners` is the per-signal form of the same
   * notification.
   */
  onSignal?: (name: string, value: unknown) => void
  /**
   * @internal Used by `<ChartStream>`/`<ChartWorkerStream>` (with `sceneOverride`)
   * to receive what this chart derives from props and gestures — the `domainRaw`
   * of the pan/zoom view and the merged signal values — so the stream can
   * re-evaluate with them.
   *
   * Unstable, host-internal plumbing (the counterpart of `sceneOverride`): it is
   * not covered by semver and may change or go away in any release.
   */
  onStreamInput?: (input: ChartStreamInput) => void
  /** Disable the spec-driven event loop (defaults to on when the spec has signal.on streams). */
  interactive?: boolean
  /**
   * Show a tooltip on hover over a mark: the hovered item's `tooltip` value,
   * as Vega with vega-tooltip shows it (the mark's `tooltip` encoding, or
   * Vega-Lite's `tooltip` channel with its titles and formats). An object is
   * shown as `key: value` rows under its `title`, an array as `[a, b]`, any
   * other value as text; an item without a `tooltip` value shows nothing. To
   * list a datum's fields, encode `tooltip: { signal: 'datum' }` (Vega-Lite:
   * `mark: { tooltip: { content: 'data' } }`). Resolved through the scene hit
   * index on every renderer (SVG, canvas and batched dense marks alike). Off by
   * default.
   */
  tooltip?: boolean
  /**
   * Custom tooltip content rendered inside the chart's React tree (not a
   * detached overlay). Providing this enables tooltips without `tooltip`. It is
   * called for every hovered item that has a datum or a `tooltip` value, with
   * the datum (`{}` when the item has none) and `info`: the item's `tooltip`
   * value and the scene item itself. Return `null` to show nothing.
   */
  renderTooltip?: (datum: Record<string, unknown>, info: TooltipInfo) => React.ReactNode
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
   * `'refuse'`: a spec that has a `url` dataset (one with a `url` and no `values`, at any depth of nested groups) is refused
   * before any add-on loads and before evaluation, whether or not `data` gives rows under its name: the chart renders its
   * error state and `onError` receives an `AsterUrlError` (`ASTER_URL_DENIED`) that names the dataset. For an app that
   * supplies every row through `data` and draws specs it did not write; the data counterpart of `urlPolicy`. Default
   * `'allow'` (`RuntimeInput.urlData`).
   */
  urlData?: UrlDataMode
  /**
   * The source of random numbers of this chart (`RuntimeInput.random`, the per-chart counterpart of vega's `setRandom`): expression
   * `random()`, `sampleNormal` / `sampleLogNormal` / `sampleUniform`, the `sample` transform and the bootstrap `ci0` / `ci1` draw from
   * it, in vega's order and count. Pass one seeded generator for the life of the chart (memoize it) and the chart is a function of its
   * inputs: a transform or signal whose inputs did not change keeps its numbers (a resize, an unrelated signal), one whose inputs
   * changed draws the next ones from the stream, as vega's dataflow does. Without one, expressions use `Math.random`.
   */
  random?: () => number
  /**
   * Where recovered errors go (`RuntimeInput.logger`, vega's logger shape): an expression that
   * throws while the chart is evaluated or while a `signal.on` event is handled is reported here
   * and the chart carries on, like vega. Default: the console. Only its presence is a dependency;
   * the latest object is always the one called.
   */
  logger?: Logger
  /**
   * vega's `view.preventDefault()` (default false): whether the events of `signal.on` streams from the chart's own
   * surface are prevented when `config.events.defaults` names neither `prevent` nor `allow` (by default the config
   * prevents all but `wheel`). A stream marked `consume` always prevents.
   */
  preventDefault?: boolean
  /** Host text measurement for custom fonts / non-browser engines. */
  textMetrics?: TextMetricsProvider
  /** Accessible scene tree. Enabled by default; pass `false` to opt out. */
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

/** Imperative handle exposed by `<Chart ref={…}>`. */
export interface ChartHandle {
  getScene(): SceneRoot | null
  getSvg(): string | null
  /**
   * The chart as a PNG: `getScene()` (what `getSvg()` serializes) painted by the canvas renderer, which loads on the first call, and
   * encoded by the browser's canvas. `null` when there is no scene (still loading, or an error). Needs no `blob:` or `data:` image
   * loading, so it works under a Content-Security-Policy that allows neither in `img-src`. `scale` is pixels per CSS pixel (default
   * 1; 2 for a sharp image on a high-density screen). Image marks are loaded from their urls with CORS (`crossOrigin="anonymous"`,
   * as vega's canvas does); one that does not load is left out of the PNG and reported through `onImageError`, by default the
   * chart's `logger` (a warning). Rejects with a `RangeError` for an invalid `scale` or an image beyond `PNG_MAX_SIDE` /
   * `PNG_MAX_PIXELS`. On `<SvgChart>` it needs `png={png}` from `@aster-charts/react/png` and rejects without it.
   */
  getPng(options?: PngOptions): Promise<Blob | null>
  getChartInfo(): ChartInfo | null
  getView(): ViewDomain | null
  setView(view: ViewDomain | null): void
  resetView(): void
  setSignal(name: string, value: unknown): void
  getSignals(): Record<string, unknown>
}
