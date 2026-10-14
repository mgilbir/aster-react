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
  /** Named datasets. Overrides or fulfills spec data references by name. */
  data?: Record<string, unknown[]>
  /** Static width/height overrides for `{signal: 'width'|'height'}` and spec size. */
  width?: number
  height?: number
  /** Static signal values for signals that are referenced but not event-driven. */
  signals?: Record<string, unknown>
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
}

// ---------------------------------------------------------------------------
// CompiledChart — the IR emitted by compileChart()
// ---------------------------------------------------------------------------

export interface CompiledProjection {
  name: string
  type: string
  scale?: number | { signal: string }
  translate?: [number, number] | { signal: string }
  center?: [number, number] | { signal: string }
  rotate?: [number, number] | [number, number, number] | { signal: string }
  precision?: number | { signal: string }
  clipAngle?: number | { signal: string }
  reflectX?: boolean
  reflectY?: boolean
  /** Projection-specific parameters (parallels, pointRadius, clipExtent, ...) */
  params?: Record<string, unknown>
}

export interface CompiledChart {
  autosize?: string
  width: SizeSpec
  height: SizeSpec
  padding: { top: number; right: number; bottom: number; left: number }
  background: string | null
  /** Stroke of the plot frame border (e.g. '#ddd' from style 'cell'). */
  frameStroke?: string
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
  /** @internal Partial re-evaluation memo: the last scene's top-level groups. */
  __prevItems?: unknown
  /** Root-level trellis layout options (vega spec `layout`), when present. */
  layout?: Record<string, unknown>
}

export interface CompiledTitle {
  text: string
  subtitle?: string
  orient: 'top' | 'bottom' | 'left' | 'right'
  anchor: 'start' | 'middle' | 'end'
  offset: number
  subtitlePadding: number
  fontSize: number
  fontWeight?: string | number
  font?: string
  color: string
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
  /** Event-driven handlers (`signal.on` streams), bound by the host. */
  on?: SignalOnDef[]
}

/** One `signal.on` entry (vega SignalStream spec subset). */
export interface SignalOnDef {
  /** Event selector: 'mousemove', 'click', 'wheel', or a view-style string. */
  events: string
  /** Update expression; `event`, `datum` and signal refs are in scope. */
  update?: string
  /** Optional: only fire when a specific mark/datum is targeted. */
  between?: unknown[]
  throttle?: number
  debounce?: number
  consume?: boolean
  force?: boolean
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
  | { type: 'bin'; field: string; as: [string, string]; extent?: number[] | { signal: string }; step?: number; maxbins?: number; nice?: boolean; anchor?: number; signal?: string }
  | { type: 'aggregate'; groupby?: string[]; fields?: (string | null)[]; ops?: string[]; as?: string[] }
  | { type: 'window'; sort?: SortSpec; groupby?: string[]; fields?: (string | null)[]; ops?: string[]; as?: string[]; frame?: [number | null, number | null]; ignorePeers?: boolean }
  | { type: 'stack'; groupby?: string[]; field: string; sort?: SortSpec; as: [string, string]; offset?: 'zero' | 'normalize' | 'center'; }
  | { type: 'fold'; fields: string[]; as: [string, string] }
  | { type: 'flatten'; fields: string[]; as?: string[] }
  | { type: 'sample'; size: number }
  | { type: 'extent'; field: string; signal: string }
  | { type: 'collect'; sort?: SortSpec }
  | { type: 'joinaggregate'; groupby?: string[]; fields?: (string | null)[]; ops?: string[]; as?: string[] }
  | { type: 'impute'; field: string; key: string; groupby?: string[]; method?: string; value?: unknown }
  | { type: 'identifier' }
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
  nice?: boolean | number
  reverse?: boolean
  clamp?: boolean
  round?: boolean
  padding?: number
  paddingInner?: number
  paddingOuter?: number
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
}

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
  maxExtent?: number
  minExtent?: number
  titleAnchor?: string
  titleLimit?: number
  translate?: number | number[]
  position?: number
  offset?: number
  tickBand?: string
  values?: unknown[] | { signal: string }
  format?: string
  formatType?: string
  zindex?: number
  encode?: Record<string, Record<string, EncodeValue>>
}

export interface CompiledLegend {
  fill?: string
  stroke?: string
  size?: string
  shape?: string
  opacity?: string
  strokeDash?: string
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
  labelOffset?: number
  labelLimit?: number
  rowPadding?: number
  columnPadding?: number
  titlePadding?: number
  titleFontSize?: number
  titleFontWeight?: string | number
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
  encode?: Record<string, Record<string, EncodeValue>>
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
  /** Nested marks within a group. */
  marks?: CompiledMark[]
  /** Axis specifications within a group (nested scope). */
  axes?: CompiledAxis[]
  /** Scale specifications within a group (resolved against the group's size). */
  scales?: CompiledScale[]
  /** Data sets declared within a group's scope. */
  data?: CompiledData[]
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
  padding?: { top: number; right: number; bottom: number; left: number }
  items: SceneGroup[]
  /** Gradient definitions for use by fill="url(#...)" references. */
  defs?: Array<{ id: string; colorStops: Array<{ offset: number; color: string }>; direction?: 'vertical' | 'horizontal' }>
  name?: string
  ariaRole?: string
  ariaLabel?: string
}

export interface SceneGroup extends SceneItem {
  marktype?: string
  name?: string
  role?: string
  /** Nested scene items (children of a group). */
  items?: SceneNode[]
  clip?: boolean
  /** Pre-computed rounded-rect path `d` for clip-path defs (when cornerRadius > 0). */
  clipPathD?: string
  /** @internal The mark's source dataset, used to match a mark to its previous group. */
  __source?: string
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
  strokeLineCap?: string
  strokeLineJoin?: string
  opacity?: number
  cornerRadius?: number
  cornerRadiusTopLeft?: number
  cornerRadiusTopRight?: number
  cornerRadiusBottomLeft?: number
  cornerRadiusBottomRight?: number
  zindex?: number
  cursor?: string
  // accessibility
  ariaRole?: string
  ariaLabel?: string
  description?: string
  // line/area path continuity
  defined?: boolean
  // data
  datum?: unknown
}
