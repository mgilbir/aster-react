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
}

// ---------------------------------------------------------------------------
// CompiledChart — the IR emitted by compileChart()
// ---------------------------------------------------------------------------

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
  | { type: 'impute'; field: string; key: string; groupby?: string[]; method?: string; value?: unknown; step?: number }
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
  labelAlign?: string
  labelBaseline?: string
  labelFlush?: boolean | number
  labelOverlap?: boolean | string
  labelPadding?: number
  labelAngle?: number
  tickBand?: string
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
  title?: string | { signal: string }
  offset?: number
  padding?: number
  gradientLength?: number
  gradientThickness?: number
  symbolSize?: number
  symbolType?: string
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
  /** Axis specifications within a group. */
  axes?: unknown[]
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
  background?: string | null
  frameStroke?: string
  padding?: { top: number; right: number; bottom: number; left: number }
  items: SceneGroup[]
  /** Gradient definitions for use by fill="url(#...)" references. */
  defs?: Array<{ id: string; colorStops: Array<{ offset: number; color: string }> }>
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
}

export type SceneNode = SceneGroup

export interface SceneItem {
  // mark identity
  mark?: { role?: string; name?: string }
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
