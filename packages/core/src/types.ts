/**
 * @aster/core — scene IR types.
 *
 * The compiler consumes a Vega spec (JSON) and produces a `CompiledChart` (our IR).
 * `evaluateChart` resolves the IR against runtime inputs (data, size) into a
 * renderer-neutral `SceneRoot`. The renderer turns a `SceneRoot` into SVG.
 *
 * The `SceneRoot`/`SceneItem` shapes intentionally mirror vega-scenegraph's JSON
 * structure so the conformance oracle (real vega rendered headless) can be
 * compared structurally, and so debugging against vega output is direct.
 */

/** Loose input: the Vega spec is JSON we interpret. Refined per-mark types come later. */
export type VgSpec = Record<string, unknown>

/** Specified chart size: fixed number, a width/height signal, or a band step. */
export type SizeSpec = number | { signal: string } | { step: number }

/** Runtime inputs resolved at evaluate time. */
export interface RuntimeInput {
  /** Budgets for untrusted specs (see limits.ts). */
  limits?: import('./limits.js').SpecLimits
  /**
   * Policy for image-mark `url`s (C93). Applied when given, and with its
   * defaults whenever `limits` is set (a spec rendered under limits is
   * untrusted). Default: only http:, https: and data: (and relative) URLs pass;
   * `javascript:`, `file:`, `blob:` ... and URLs with credentials throw
   * `AsterUrlError`. Add `allow(url)` to restrict hosts and `onDeny` to drop
   * denied images instead of throwing. See docs/LIMITS.md.
   */
  urlPolicy?: import('./url-policy.js').ImageUrlPolicy
  /**
   * Where the engine reports errors it recovers from, like vega's logger (default: the
   * console). vega logs a failing expression -- a conditional-encode test, a signal in an
   * encode, a transform's predicate, a sort -- and carries on with what the dataflow had
   * computed; so does the engine, and every such report goes through here.
   */
  logger?: import('./logger.js').Logger
  /** Host text measurement (custom fonts, non-browser hosts). */
  textMetrics?: import('./text-metrics.js').TextMetricsProvider
  /** Named datasets. Overrides or fulfills spec data references by name. */
  data?: Record<string, unknown[]>
  /** Static width/height overrides for `{signal: 'width'|'height'}` and spec size. */
  width?: number
  height?: number
  /** Static signal values for signals that are referenced but not event-driven. */
  signals?: Record<string, unknown>
  /**
   * The size of the element the chart fills, in pixels: what `containerSize()`
   * returns in expressions (vega-lite's `width: "container"` reads it). Without
   * it `containerSize()` is `[undefined, undefined]`, as in headless vega, and
   * the spec falls back to its own default size.
   */
  containerSize?: { width: number; height: number }
  /**
   * Partial re-evaluation: the names of datasets whose VALUES changed since
   * the previous evaluate (the datasets' transform pipeline re-runs, and only
   * the marks drawing from them — directly or via a derived source chain —
   * are rebuilt). Unaffected marks reuse the previous scene's groups, so an
   * update to one dataset skips re-encoding every other mark. Scales rebuild
   * whenever any dataset changed (domains may span datasets). When omitted,
   * all datasets are treated as changed (the safe default).
   */
  changedDatasets?: string[]
  /**
   * Per-datum differential update: for each dataset, the indices (into the NEW
   * row array, unchanged length/order) whose values changed. Marks drawing from
   * a dataset with a changeset reuse the previous item objects for unchanged
   * indices (identity preserved for the DOM patcher, re-encode skipped) — only
   * when that is provably safe: the mark uses no scale whose data-domain spans a
   * changed dataset and the published rows keep the same length/order. Omit to
   * fully re-encode (safe default).
   */
  dataChanges?: Record<string, number[]>
  /**
   * Length-changing pulse: per source dataset, the changed output indices plus
   * the old<->new index mapping and added/removed ranges from `diffRows`.
   * This is what lets an append/insert/delete splice cached rows/items instead
   * of falling back to a full re-derive. `dataChanges` remains the compact
   * same-length form; when both are present `dataPulse` wins for that dataset.
   */
  dataPulse?: Record<string, {
    changed?: number[]
    /** new index -> previous index (-1 for inserted rows). */
    from?: number[]
    /** previous index -> new index (-1 for removed rows). */
    to?: number[]
    /** Appended ranges in new coordinates. */
    added?: Array<[number, number]>
    /** Removed ranges in previous coordinates. */
    removed?: Array<[number, number]>
    /**
     * Compact append-only pulse: the retained prefix is unchanged in index, so
     * `from` can be synthesised on demand. `baseLength` is the previous length.
     */
    appendOnly?: boolean
    baseLength?: number
  }>
  /**
   * Infer a per-datum changeset by diffing replaced source arrays against the
   * previous session evaluation. Defaults to true when `dataChanges` is absent;
   * set false to force a full re-encode.
   */
  autoChanges?: boolean
  /**
   * Direct scale-domain overrides (vega's `domainRaw`): scale name -> values.
   * The view/guides/encodes all rebuild from the overridden scale, which is the
   * primitive pan/zoom and brush domain binding are built on.
   */
  domainRaw?: Record<string, unknown[]>
}

// ---------------------------------------------------------------------------
// CompiledChart — the IR emitted by compileChart()
// ---------------------------------------------------------------------------

export interface CompiledProjection {
  name: string
  type: string
  /**
   * Every other projection parameter as the spec wrote it (scale, translate,
   * center, rotate, parallels, clipAngle, clipExtent, pointRadius, fit, size,
   * extent, ...); a value may be a `{signal}` or contain signals.
   */
  [param: string]: unknown
}

export interface CompiledChart {
  autosize?: string
  /** `config.range` — named range lookup for scales. */
  configRange?: Record<string, unknown>
  /** vega autosize `contains` (viewSizeLayout's contains: 'padding' makes the
   * spec'd width/height include the padding). */
  autosizeContains?: string
  width: SizeSpec
  height: SizeSpec
  padding: { top: number; right: number; bottom: number; left: number }
  background: string | null
  /** Stroke of the plot frame border (e.g. '#ddd' from style 'cell'). */
  frameStroke?: string
  frameFill?: string
  frameStrokeWidth?: number
  frameFillOpacity?: number
  frameOpacity?: number
  frameStrokeDash?: number[]
  frameCornerRadius?: number
  frameClip?: boolean
  frameStrokeOpacity?: number
  frameStrokeMiterLimit?: number
  frameStrokeDashOffset?: number
  frameStrokeCap?: string
  frameStrokeJoin?: string
  data: CompiledData[]
  scales: CompiledScale[]
  axes: CompiledAxis[]
  legends: CompiledLegend[]
  marks: CompiledMark[]
  /** Resolved static signal values (width/height and any provided overrides). */
  signals: Record<string, unknown>
  /** Raw signal definitions, including `update` expressions for static resolution. */
  signalDefs?: CompiledSignalDef[]
  /** Top-level chart title (string or object form, defaults merged from config.title). */
  title?: CompiledTitle
  /** Cartographic projections referenced by geo marks / the geoshape transform. */
  projections?: CompiledProjection[]
  /** Signal values supplied by the host (not serialized). */
  /** Root-level trellis layout options (vega spec `layout`), when present. */
  layout?: Record<string, unknown>
}

export interface CompiledTitle {
  /** The text, or a signal expression (a group title reads its facet datum as `parent`). */
  text: string | { signal: string }
  subtitle?: string
  orient: 'top' | 'bottom' | 'left' | 'right' | 'none'
  anchor: 'start' | 'middle' | 'end'
  offset: number
  subtitlePadding: number
  fontSize: number
  fontWeight?: string | number
  font?: string
  fontStyle?: string
  color: string
  baseline?: string
  align?: string
  angle?: number
  subtitleColor?: string
  subtitleFontSize?: number
  subtitleFontWeight?: string | number
  dx?: number
  dy?: number
  limit?: number
  lineBreak?: string
  frame?: string
  encode?: Record<string, Record<string, EncodeValue>>
}

export interface CompiledSignalDef {
  name: string
  value?: unknown
  /** Static (`update`) expression, resolved to a fixed point. */
  update?: string
  /**
   * vega's `init`: an expression evaluated once, at startup (`op.initonly`).
   * It is not a literal value: a string here is source code.
   */
  init?: string
  /** Input binding (`signal.bind`), rendered by interactive hosts. */
  bind?: Record<string, unknown> | string
  /** Event-driven handlers (`signal.on` streams), bound by the host. */
  on?: SignalOnDef[]
}

/**
 * One `signal.on` entry (vega's signal update spec). `events` is whatever the spec
 * had: a selector string, an event-stream object, an array of either, or
 * `{signal}` / `{scale}` operator sources; `@aster/core/signals` interprets it.
 */
export interface SignalOnDef {
  events: unknown
  /** Update: an expression string, or `{expr}` / `{value}` / `{signal}`. */
  update?: string | { expr?: string; value?: unknown; signal?: string }
  /** vega: pulse the signal even when the new value equals the old one. */
  force?: boolean
  /** vega: `encode` set name (mark re-encode) -- mutually exclusive with `update`. */
  encode?: unknown
}

export interface CompiledData {
  name: string
  /** Inline values when present in the spec. */
  values?: unknown[]
  url?: string
  format?: Record<string, unknown>
  transform: CompiledTransform[]
}

export type CompiledTransform =
  | { type: 'formula'; expr: string; as: string }
  | { type: 'filter'; expr: string }
  | { type: 'bin'; field: string; as: [string, string]; extent?: number[] | { signal: string }; step?: number; maxbins?: number; base?: number; divide?: number[] | { signal: string }; minstep?: number; steps?: number[] | { signal: string }; span?: number; nice?: boolean; anchor?: number; interval?: boolean; signal?: string }
  | { type: 'aggregate'; groupby?: string[]; fields?: (string | null)[]; ops?: string[]; as?: string[]; aggregate_params?: (number | null)[] }
  | { type: 'window'; sort?: SortSpec; groupby?: string[]; fields?: (string | null)[]; ops?: string[]; params?: (number | null)[]; aggregate_params?: (number | null)[]; as?: string[]; frame?: [number | null, number | null]; ignorePeers?: boolean }
  | { type: 'stack'; groupby?: string[]; field: string; sort?: SortSpec; as: [string, string]; offset?: 'zero' | 'normalize' | 'center'; }
  | { type: 'fold'; fields: string[]; as: [string, string] }
  | { type: 'flatten'; fields: string[]; as?: string[] }
  | { type: 'sample'; size: number }
  | { type: 'extent'; field: string; signal: string }
  | { type: 'collect'; sort?: SortSpec }
  | { type: 'joinaggregate'; groupby?: string[]; fields?: (string | null)[]; ops?: string[]; as?: string[]; key?: string }
  | { type: 'impute'; field: string; key: string; groupby?: string[]; keyvals?: unknown[] | { signal: string }; method?: string; value?: unknown }
  | { type: 'identifier'; as?: string }
  | { [name: string]: unknown }

export interface SortSpec {
  field?: string | string[]
  order?: 'ascending' | 'descending' | ('ascending' | 'descending')[]
}

export type ScaleDomain =
  | { data: string; field: string; sort?: boolean | SortSpec | 'ascending' | 'descending'; fields?: string[] }
  | { data: string; fields: string[]; sort?: boolean | SortSpec | 'ascending' | 'descending' }
  | { signal: string }
  | unknown[]

export type ScaleRange =
  | 'width'
  | 'height'
  | 'category'
  | 'ordinal'
  | 'ramp'
  | 'diverging'
  | 'heatmap'
  | 'symbol'
  | 'error'
  | 'grey'
  | { signal: string }
  | unknown[]

export interface CompiledScale {
  name: string
  type: 'linear' | 'log' | 'pow' | 'sqrt' | 'symlog' | 'time' | 'utc' | 'band' | 'point' | 'ordinal' | 'quantize' | 'quantile' | 'threshold' | 'sequential' | 'bin-ordinal' | 'identity'
  domain: ScaleDomain
  range: ScaleRange
  zero?: boolean
  nice?: boolean | number | string
  reverse?: boolean
  clamp?: boolean
  round?: boolean
  padding?: number
  paddingInner?: number
  paddingOuter?: number
  rangeMin?: number
  rangeMax?: number
  base?: number
  exponent?: number
  constant?: number
  domainMin?: number
  domainMax?: number
  domainMid?: number
  bins?: unknown[]
  interpolate?: string
  scheme?: string
  align?: number
  bands?: number | boolean
  domainRaw?: unknown[]
  unknown?: unknown
  schemeExtent?: unknown
  schemeCount?: unknown
  interpolateGamma?: unknown
  domainImplicit?: unknown
  rangeStep?: unknown
}

/**
 * A guide element's `encode` block (vega axis / legend `encode`): per element
 * ('axis', 'ticks', 'labels', 'title', 'grid', 'domain'; legends: 'legend',
 * 'title', 'labels', 'symbols', 'gradient', 'entries'), the property sets
 * `enter` / `update` (the static render applies both, `update` last).
 */
export interface GuideEncodeBlock {
  name?: string
  interactive?: boolean
  style?: string | string[]
  enter?: Record<string, EncodeValue | EncodeValue[]>
  update?: Record<string, EncodeValue | EncodeValue[]>
  exit?: Record<string, EncodeValue | EncodeValue[]>
  hover?: Record<string, EncodeValue | EncodeValue[]>
}

export type GuideEncode = Record<string, GuideEncodeBlock>

export interface CompiledAxis {
  scale: string
  orient: 'top' | 'bottom' | 'left' | 'right'
  grid?: boolean
  gridScale?: string
  domain?: boolean
  labels?: boolean
  ticks?: boolean
  tickCount?: number | { signal: string }
  tickMinStep?: number
  tickSize?: number
  title?: string | { signal: string }
  titlePadding?: number
  titleFontSize?: number
  titleFontWeight?: string | number
  titleFont?: string
  titleOpacity?: number
  titleColor?: string
  titleAngle?: number
  titleAlign?: string
  titleBaseline?: string
  titleX?: number
  titleY?: number
  labelAlign?: string
  labelBaseline?: string
  labelFlush?: boolean | number
  labelOverlap?: boolean | string
  labelPadding?: number
  labelAngle?: number
  labelOffset?: number
  labelColor?: string
  labelOpacity?: number
  labelFontSize?: number
  labelFont?: string
  labelLimit?: number
  bandPosition?: number
  tickColor?: string
  tickWidth?: number
  tickDash?: number[]
  tickOffset?: number
  tickRound?: boolean | number
  tickExtra?: boolean
  domainColor?: string
  domainWidth?: number
  domainDash?: number[]
  domainOpacity?: number
  domainCap?: string
  domainDashOffset?: number
  gridColor?: string
  gridWidth?: number
  gridDash?: number[]
  gridOpacity?: number
  gridCap?: string
  gridDashOffset?: number
  tickCap?: string
  tickOpacity?: number
  tickDashOffset?: number
  labelFontWeight?: string | number
  labelFontStyle?: string
  titleFontStyle?: string
  maxExtent?: number
  minExtent?: number
  titleAnchor?: string
  titleLimit?: number
  translate?: number | number[]
  position?: number
  offset?: number
  /** The axis's own properties (before config merge). */
  own?: Record<string, unknown>
  tickBand?: string
  values?: unknown[] | { signal: string }
  format?: string
  formatType?: string
  zindex?: number
  aria?: boolean
  description?: string
  encode?: GuideEncode
}

export interface CompiledLegend {
  /** The legend's own properties (before config merge). */
  own?: Record<string, unknown>
  fill?: string
  stroke?: string
  size?: string
  shape?: string
  opacity?: string
  strokeDash?: string
  /** Stroke-width channel scale (a string) — distinct from the numeric border width. */
  strokeWidth?: string | number
  orient?: string
  direction?: string
  columns?: number
  title?: string | { signal: string }
  offset?: number
  padding?: number
  gradientLength?: number
  gradientThickness?: number
  symbolSize?: number
  symbolType?: string
  tickCount?: number | string | { signal: string }
  symbolStrokeWidth?: number
  symbolOpacity?: number
  symbolDash?: number[]
  symbolStrokeColor?: string
  symbolOffset?: number
  labelAlign?: string
  labelBaseline?: string
  labelColor?: string
  labelOpacity?: number
  labelFontSize?: number
  labelFontWeight?: string | number
  labelFontStyle?: string
  labelFont?: string
  labelOffset?: number
  labelLimit?: number
  rowPadding?: number
  columnPadding?: number
  titlePadding?: number
  titleFontSize?: number
  titleFontWeight?: string | number
  titleFontStyle?: string
  titleFont?: string
  titleOpacity?: number
  titleColor?: string
  titleBaseline?: string
  titleAlign?: string
  titleAnchor?: string
  titleAngle?: number
  titleLimit?: number
  gridAlign?: string
  clipHeight?: number
  cornerRadius?: number
  fillColor?: string
  strokeColor?: string
  labelOverlap?: boolean | string
  symbolLimit?: number
  encode?: GuideEncode
  zindex?: number
  type?: 'gradient' | 'symbol'
}

export interface CompiledMark {
  type: string
  name: string
  role?: string
  style?: string | string[]
  from?: { data?: string; facet?: unknown; aggregate?: unknown }
  clip?: boolean
  interactive?: boolean
  zindex?: number
  key?: string
  sort?: SortSpec
  encode?: Record<string, Record<string, EncodeValue | EncodeValue[]>>
  transform?: CompiledTransform[]
  /** Group mark title (for axis/row titles). */
  title?: unknown
  /** A group's title, resolved like the view's (config.title, then its style). */
  groupTitle?: CompiledTitle
  /** Nested marks within a group. */
  marks?: CompiledMark[]
  /** Axis specifications within a group (nested scope), with the view's config defaults applied. */
  axes?: CompiledAxis[]
  /** Legend specifications within a group (nested scope), with the view's config defaults applied. */
  legends?: CompiledLegend[]
  /** Scale specifications within a group (resolved against the group's size). */
  scales?: CompiledScale[]
  /** Data sets declared within a group's scope. */
  data?: CompiledData[]
  /** Group mark grid layout (vega-native trellis `layout` def). */
  layout?: Record<string, unknown>
  /** Cartographic projections declared within a group's scope. */
  projections?: CompiledProjection[]
}

export type EncodeValue =
  | { value: unknown }
  | { field: string; format?: unknown; formatType?: string; type?: string }
  | { scale: string; field: string | EncodeValue; band?: boolean | number; offset?: number; round?: boolean; range?: boolean }
  | { signal: string }
  | EncodeConditional

export interface EncodeConditional {
  test?: string
  value?: unknown
  field?: string
  scale?: string
  signal?: string
  format?: unknown
  formatType?: string
  band?: boolean | number
  offset?: number
}

// ---------------------------------------------------------------------------
// SceneRoot — renderer-neutral scene emitted by evaluateChart()
//
// Mirrors vega-scenegraph JSON: a root with width/height/items; marks are groups
// whose `items` are per-datum scene items; other groups (axis/legend/frame) nest.
// ---------------------------------------------------------------------------

/** Plain scale snapshot attached to scenes for the scene-level differential. */
export interface ScaleSnapshot {
  name: string
  type: string
  domain: unknown[]
  range: unknown[]
  bandwidth?: number
  /** Endpoint samples for interpolating (colour) scales, where d3 reports [0,1]. */
  samples?: [unknown, unknown]
  /** vega-scale labelValues (thresholds/quantiles/bins) for discretizing scales. */
  labelValues?: unknown[]
}

export interface SceneRoot {
  width: number
  height: number
  /** Content (plot) size: the frame background rect. With autosize pad the
   *  totals can overflow far past fp precision (huge geo clip bounds), so the
   *  plot rect is carried separately rather than derived by subtraction. */
  plotWidth?: number
  plotHeight?: number
  /** @internal The expression runtime for this evaluation (event-loop wiring). */
  runtime?: unknown
  /** @internal The compiled chart for this evaluation. */
  compiled?: unknown
  background?: string | null
  frameStroke?: string
  frameFill?: string
  frameStrokeWidth?: number
  frameFillOpacity?: number
  frameOpacity?: number
  frameStrokeDash?: number[]
  /** Corner radius of the plot frame (config.view.cornerRadius). */
  frameCornerRadius?: number
  /** Clip the plot contents to the frame (config.view.clip). */
  frameClip?: boolean
  frameStrokeOpacity?: number
  frameStrokeMiterLimit?: number
  frameStrokeDashOffset?: number
  frameStrokeCap?: string
  frameStrokeJoin?: string
  padding?: { top: number; right: number; bottom: number; left: number }
  items: SceneGroup[]
  /** Gradient definitions for use by fill="url(#...)" references. */
  defs?: Array<{ id: string; colorStops: Array<{ offset: number; color: string }>; direction?: 'vertical' | 'horizontal' }>
  name?: string
  ariaRole?: string
  ariaLabel?: string
  /** @internal Resolved scales in this scope (scene-differential metadata). */
  __scales?: ScaleSnapshot[]
  /**
   * @internal Live scales for this evaluation, so hosts can derive `ChartInfo`
   * (interaction, hit tests) from an already-evaluated scene without compiling
   * and evaluating a second time. Not serializable — stripped by worker clones.
   */
  __scaleMap?: Map<string, unknown>
}

export interface SceneGroup extends SceneItem {
  marktype?: string
  name?: string
  role?: string
  /** Nested scene items (children of a group). */
  items?: SceneNode[]
  clip?: boolean
  /** The runtime sets it when some item of this mark carries an `href`: only then do the renderers look for links. */
  hasLinks?: boolean
  /** The MARK's `clip` (not the item's): this group item sits in a container clipped to the enclosing group's frame. */
  markClip?: boolean
  /** Pre-computed rounded-rect path `d` for clip-path defs (when cornerRadius > 0). */
  clipPathD?: string
  /** @internal The mark's source dataset, used to match a mark to its previous group. */
  __source?: string
  /** Guide orientation (`left`/`right`/`top`/`bottom`) for axes. */
  orient?: string
  /** Guide scale name for axes/legends (accessibility metadata). */
  scale?: string
  /** Resolved guide title (accessibility metadata). */
  title?: string
  /** Legend kind (`gradient`/`symbol`) for caption construction. */
  legendType?: string
  /** Legend scale/channels (accessibility caption metadata). */
  legendScale?: string
  legendChannels?: string[]
  /** @internal Resolved scales in this nested scope (scene-differential metadata). */
  __scales?: ScaleSnapshot[]
}

export type SceneNode = SceneGroup

export interface SceneItem {
  // mark identity
  mark?: { role?: string; name?: string }
  /** @internal Differential-update generation: set when an item is (re)encoded; a DOM
   * patch skips subtrees whose item was not touched this eval. */
  __gen?: number
  /** @internal Cached DOM descriptor for a reused (unchanged) item, so the DOM
   * desc is not rebuilt from scratch every patch. */
  __domDesc?: unknown
  // geometry
  x?: number
  y?: number
  x2?: number
  y2?: number
  width?: number
  height?: number
  size?: number
  radius?: number
  innerRadius?: number
  outerRadius?: number
  startAngle?: number
  endAngle?: number
  padAngle?: number
  theta?: number
  path?: string
  // text
  text?: unknown
  align?: 'left' | 'center' | 'right'
  baseline?: 'top' | 'middle' | 'bottom' | 'alphabetic' | string
  angle?: number
  dx?: number
  dy?: number
  limit?: number
  lineBreak?: string
  lineHeight?: number
  ellipsis?: string
  font?: string
  fontSize?: number
  fontWeight?: string | number
  fontStyle?: string
  fontVariant?: string
  // symbol
  shape?: string
  // image
  url?: string
  aspect?: boolean
  // presentation
  fill?: string | { gradient: string }
  fillOpacity?: number
  stroke?: string | { gradient: string }
  strokeOpacity?: number
  strokeWidth?: number
  strokeDash?: number[]
  strokeCap?: string
  strokeJoin?: string
  strokeDashOffset?: number
  strokeMiterLimit?: number
  blend?: string
  opacity?: number
  cornerRadius?: number
  cornerRadiusTopLeft?: number
  cornerRadiusTopRight?: number
  cornerRadiusBottomLeft?: number
  cornerRadiusBottomRight?: number
  zindex?: number
  cursor?: string
  /** Hyperlink: the item's element is drawn inside `<a xlink:href>` (after `sanitizeHref`). */
  href?: string
  /** Internal: marks a legend title item so the builder can paint it last. */
  _legendTitle?: boolean
  // accessibility
  ariaRole?: string
  ariaLabel?: string
  ariaRoleDescription?: string
  aria?: boolean
  description?: string
  // line/area path continuity
  defined?: boolean
  // data
  datum?: unknown
}
