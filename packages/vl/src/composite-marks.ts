/**
 * The composite marks: boxplot, errorbar and errorband. A composite mark is a unit that stands for several: it is rewritten, before
 * anything is compiled, into a layer of simple marks (rules, ticks, bars, areas...) that draw the summary statistics of one aggregate
 * transform, and the layer compiler takes it from there.
 *
 * The three share their anatomy: one continuous axis the statistics are of, the other channels every part draws, the parts the mark
 * def and the config switch on and off, and the tooltip that lists the statistics. They differ in the statistics and in the parts.
 */
import { VLCompileError, genName, splitAccessPath } from './names.js'
import { getTimeUnitParts } from './timeunit.js'
import { normalizeTimeUnit } from './validate.js'

type Obj = Record<string, any>
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v)
const titleCase = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)
const datumRef = (name: string): string => `datum[${JSON.stringify(name)}]`
const quotedRef = (name: string): string => `datum['${name.replaceAll("'", "\\'")}']`

export type CompositeMark = 'boxplot' | 'errorbar' | 'errorband'
type Orient = 'vertical' | 'horizontal'

/** Which composite mark a unit (or its mark def) is, if any. */
export function compositeMarkOf(unit: Obj): CompositeMark | undefined {
  const type = isObj(unit.mark) ? unit.mark.type : unit.mark
  return type === 'boxplot' || type === 'errorbar' || type === 'errorband' ? type : undefined
}

/** What a composite mark's config holds before the spec says anything. */
const DEFAULT_CONFIG: Record<'errorbar' | 'errorband', Obj> = {
  errorbar: { center: 'mean', rule: true, ticks: false },
  errorband: { band: { opacity: 0.3 }, borders: false },
}
const BOXPLOT_DEFAULTS: Obj = { size: 14, extent: 1.5, box: {}, median: { color: 'white' }, outliers: {}, rule: {}, ticks: null }

/** Objects merge key by key, anything else is replaced. */
function mergeDeep(base: Obj, over: Obj | undefined): Obj {
  const out: Obj = { ...base }
  for (const [k, v] of Object.entries(over ?? {})) out[k] = isObj(v) && isObj(out[k]) ? mergeDeep(out[k], v) : v
  return out
}

// --- reading the unit ----------------------------------------------------------------------------------------------------------

/** A channel the statistics can be of: quantitative and not binned, or temporal. */
const isContinuous = (d: unknown): boolean => isObj(d) && (d.type === 'temporal' || (d.type === 'quantitative' && !d.bin))
/** A channel that is given a field (or a datum). */
const hasField = (d: unknown): boolean => isObj(d) && (d.field !== undefined || d.datum !== undefined)

/** The axis the statistics are on: the mark def's, else the only continuous one, else the one that is not temporal-vs-not. */
function orientationOf(markDef: Obj, encoding: Obj, kind: CompositeMark): Orient {
  if (markDef.orient) return markDef.orient
  const { x, y } = encoding
  const xs = isContinuous(x)
  const ys = isContinuous(y)
  if (xs && ys) {
    // (an axis that already carries the composite's name as its aggregate is the one the statistics are of)
    const xAggregate = isObj(x) && x.aggregate
    const yAggregate = isObj(y) && y.aggregate
    if (!xAggregate && yAggregate === kind) return 'vertical'
    if (!yAggregate && xAggregate === kind) return 'horizontal'
    if (xAggregate === kind && yAggregate === kind) throw new VLCompileError(`${kind}: both x and y cannot have aggregate`)
    return y.type === 'temporal' && x.type !== 'temporal' ? 'horizontal' : 'vertical'
  }
  if (xs) return 'horizontal'
  if (ys) return 'vertical'
  throw new VLCompileError(`${kind} needs a continuous x or y axis`)
}

/** How the data holds the statistics: raw values, or already the two ends of the range, or a centre and its error. */
type Input = 'raw' | 'aggregated-upper-lower' | 'aggregated-error'

function inputOf(markDef: Obj, e: Obj, kind: CompositeMark): { orient: Orient; input: Input } {
  const has = (...channels: string[]): boolean => channels.some((c) => hasField(e[c]))
  if ((has('x') || has('y')) && !has('x2', 'y2', 'xError', 'xError2', 'yError', 'yError2')) return { orient: orientationOf(markDef, e, kind), input: 'raw' }

  if (has('x2', 'y2')) {
    if (has('xError', 'xError2', 'yError', 'yError2')) throw new VLCompileError(`${kind} cannot be both aggregated-upper-lower and aggregated-error`)
    if (has('x2') && has('y2')) throw new VLCompileError(`${kind} cannot have both x2 and y2`)
    const axis = has('x2') ? 'x' : 'y'
    if (!isContinuous(e[axis])) throw new VLCompileError(`both ${axis} and ${axis}2 have to be quantitative in ${kind}`)
    return { orient: axis === 'x' ? 'horizontal' : 'vertical', input: 'aggregated-upper-lower' }
  }
  if (has('xError2') && !has('xError')) throw new VLCompileError(`${kind} cannot have xError2 without xError`)
  if (has('yError2') && !has('yError')) throw new VLCompileError(`${kind} cannot have yError2 without yError`)
  if (has('xError') && has('yError')) throw new VLCompileError(`${kind} cannot have both xError and yError`)
  for (const axis of ['x', 'y'] as const) {
    if (!has(`${axis}Error`)) continue
    if (!isContinuous(e[axis])) throw new VLCompileError(`${axis}, ${axis}Error and ${axis}Error2 have to be quantitative`)
    return { orient: axis === 'x' ? 'horizontal' : 'vertical', input: 'aggregated-error' }
  }
  throw new VLCompileError(`${kind} has no ranged axis`)
}

// --- lifting the transforms out of the channels ---------------------------------------------------------------------------------

/** The title a field gets from the transform on it: "Mean of v", "Count of Records", "year(t)" as the time-unit parts. */
function verbalTitle(def: Obj): string {
  const { field, bin, timeUnit, aggregate } = def
  if (aggregate === 'count') return 'Count of Records'
  if (bin) return `${field} (binned)`
  if (timeUnit) return `${field} (${getTimeUnitParts(normalizeTimeUnit(timeUnit).unit).join('-')})`
  if (aggregate) return `${titleCase(String(aggregate))} of ${field}`
  return String(field)
}

const LEGEND_CHANNELS = new Set(['color', 'fill', 'stroke', 'opacity', 'fillOpacity', 'strokeOpacity', 'strokeWidth', 'strokeDash', 'size', 'angle', 'shape'])

interface Lifted {
  timeUnits: Obj[]
  aggregate: Obj[]
  groupby: string[]
  encoding: Obj
}

/**
 * The transforms the shared channels ask for (an aggregate, a time unit), taken out of the channels and into transforms, and the
 * channels left to read the result. A channel that holds a list of definitions (`tooltip`, `detail`) is read entry by entry: each
 * entry takes part in the transforms and the grouping, and the channel keeps its list when an entry needs no transform, or the
 * replacement of the entry that did (so the last entry decides).
 */
function liftTransforms(channels: Obj, kind: CompositeMark): Lifted {
  const out: Lifted = { timeUnits: [], aggregate: [], groupby: [], encoding: {} }
  for (const [channel, entries] of Object.entries(channels)) {
    for (const def of Array.isArray(entries) ? entries : [entries]) {
      if (!isObj(def) || (def.field === undefined && def.aggregate !== 'count')) {
        out.encoding[channel] = entries
        continue
      }
      const { field, aggregate, bin, timeUnit, ...rest } = def
      if (!aggregate && !timeUnit && !bin) {
        out.groupby.push(field)
        out.encoding[channel] = entries
        continue
      }
      if (bin) throw new VLCompileError(`${kind} over a binned ${channel} channel is not supported`)
      if (isObj(aggregate)) throw new VLCompileError(`${kind}: argmin/argmax on ${channel} is not supported`)
      const as = timeUnit ? genName(normalizeTimeUnit(timeUnit).unit, field) : field === undefined ? '__count' : genName(String(aggregate), field)
      const title = isObj(def.axis) && def.axis.title !== undefined ? undefined : verbalTitle(def)
      const lifted: Obj = { ...(def.title === undefined && title !== undefined ? { title } : {}), ...rest, field: as }
      out.encoding[channel] = lifted
      if (aggregate) {
        out.aggregate.push({ op: aggregate, ...(field ? { field } : {}), as })
        continue
      }
      out.timeUnits.push({ timeUnit, field, as })
      out.groupby.push(as)
      // a time unit on a field that is not temporal is formatted as time all the same
      if (def.type !== undefined && def.type !== 'temporal') {
        if (channel === 'text' || channel === 'tooltip') lifted.formatType = 'time'
        else if (LEGEND_CHANNELS.has(channel)) lifted.legend = { formatType: 'time', ...(isObj(lifted.legend) ? lifted.legend : {}) }
        else if (channel === 'x' || channel === 'y') lifted.axis = { formatType: 'time', ...(isObj(lifted.axis) ? lifted.axis : {}) }
      }
    }
  }
  return out
}

// --- the anatomy and the parts -------------------------------------------------------------------------------------------------

interface Anatomy {
  kind: CompositeMark
  markDef: Obj
  /** the composite's config block over its defaults */
  config: Obj
  axis: 'x' | 'y'
  /** the definition of the channel the statistics are of, without its aggregate */
  continuous: Obj
  /** the channels every part draws (the other channels, after the transforms are lifted out of them) */
  shared: Obj
  /** the name of the field that holds a statistic, from the prefix that says which */
  fieldName: (prefix: string) => string
}

interface PartSpec {
  /** the key the mark def and the config switch it by */
  name: string
  mark: Obj | string
  /** the statistic on the continuous axis, or where the part starts on it */
  at?: string
  /** the field itself, for a part that draws the data and not a statistic */
  field?: string
  /** where a ranged part ends */
  to?: string
  /** the channels the part draws beyond the position (the shared ones, and its tooltip) */
  encoding: Obj
  /** a transform that picks the rows the part draws */
  transform?: Obj[]
}

/** The continuous channel as a part draws it: at one statistic, with the title and the scale and axis the user gave it. */
function axisDef(a: Anatomy, field: string): Obj {
  const { scale, axis } = a.continuous
  return { field, type: a.continuous.type, title: a.continuous.title ?? a.continuous.field, ...(scale !== undefined ? { scale } : {}), ...(axis !== undefined ? { axis } : {}) }
}

/** The end of a ranged part: its field, titled by its plain name where a safe name stands in for one with a path in it. */
function endDef(a: Anatomy, prefix: string): Obj {
  const field = a.fieldName(prefix)
  const plain = `${prefix}_${a.continuous.field}`
  return field === plain ? { field } : { field, title: plain }
}

/** A part of the composite mark as a unit spec, or nothing when the mark def or the config switches it off. */
function part(a: Anatomy, p: PartSpec): Obj[] {
  const configured = a.config[p.name]
  const own = a.markDef[p.name]
  if (!(own || (own === undefined && configured))) return []
  const { clip, color, opacity } = a.markDef
  return [{
    ...(p.transform ? { transform: p.transform } : {}),
    mark: {
      ...(isObj(configured) ? configured : {}),
      ...(clip ? { clip } : {}),
      ...(color ? { color } : {}),
      ...(opacity ? { opacity } : {}),
      ...(isObj(p.mark) ? p.mark : { type: p.mark }),
      style: `${a.kind}-${p.name}`,
      ...(isObj(own) ? own : {}),
    },
    encoding: {
      [a.axis]: axisDef(a, p.field ?? a.fieldName(p.at!)),
      ...(p.to ? { [`${a.axis}2`]: endDef(a, p.to) } : {}),
      ...p.encoding,
    },
  }]
}

// --- the tooltip ---------------------------------------------------------------------------------------------------------------

/** Every field definition of an encoding: a conditional channel through its condition, lists entry by entry. */
function fieldDefsOf(encoding: Obj): Obj[] {
  const out: Obj[] = []
  for (const entries of Object.values(encoding)) {
    for (const d of Array.isArray(entries) ? entries : [entries]) {
      if (isObj(d) && d.field !== undefined) out.push(d)
      else if (isObj(d) && isObj(d.condition) && d.condition.field !== undefined) out.push(d.condition)
    }
  }
  return out
}

/** JSON with the keys of every object sorted, so two definitions with the same content in another key order are the same. */
function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`
  if (!isObj(v)) return JSON.stringify(v) ?? 'null'
  return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`
}

/**
 * The tooltip of a part: the one the spec gives, else a line per summary statistic followed by the other fields the parts show (a
 * channel's own legend, axis, header and scale have no place in a tooltip, nor has the condition a field is read through).
 */
function tooltipOf(statistics: Obj[], shared: Obj): Obj {
  if ('tooltip' in shared) return { tooltip: shared.tooltip }
  const seen = new Set<string>()
  const fields: Obj[] = []
  for (const d of fieldDefsOf(shared)) {
    const { legend: _l, axis: _a, header: _h, scale: _s, ...def } = d
    const key = stableStringify(def)
    if (seen.has(key)) continue
    seen.add(key)
    const { param: _p, test: _t, empty: _e, ...shown } = def
    fields.push(shown)
  }
  return { tooltip: [...statistics, ...fields] }
}

/** Split the tooltip into the part computed with the box (aggregates) and the part that decorates the raw outliers. */
function splitTooltip(channels: Obj): { rest: Obj; raw?: unknown } {
  const { tooltip, ...rest } = channels
  if (!tooltip) return { rest }
  if (!Array.isArray(tooltip)) {
    if (tooltip.aggregate) rest.tooltip = tooltip
    return { rest, raw: tooltip.aggregate ? undefined : tooltip }
  }
  const aggregated = tooltip.filter((t) => t.aggregate)
  const raw = tooltip.filter((t) => !t.aggregate)
  if (aggregated.length) rest.tooltip = aggregated
  return { rest, raw: raw.length === 1 ? raw[0] : raw.length ? raw : undefined }
}

// --- errorbar and errorband ----------------------------------------------------------------------------------------------------

/** The statistics of an error mark: what to aggregate, what to derive from it, and how the tooltip names each. */
interface Statistics {
  aggregate: Obj[]
  calculate: Obj[]
  lines: Array<{ field: string; title: string }>
  /** the lines name the field they are of ("Mean + stderr of v") */
  named: boolean
}

function errorStatistics(a: Anatomy, input: Input, encoding: Obj, defaultCenter: string): Statistics {
  const f = a.continuous.field as string
  const at = (prefix: string): string => genName(prefix, f)
  const titledCalc = (c: Obj): { field: string; title: string } => ({ field: c.as, title: String(c.calculate).replace(/datum\["|"\]/g, '') })

  if (input === 'aggregated-upper-lower') {
    const calculate = [{ calculate: datumRef(encoding[`${a.axis}2`].field), as: at('upper') }, { calculate: datumRef(f), as: at('lower') }]
    return { aggregate: [], calculate, lines: calculate.map(titledCalc), named: false }
  }
  if (input === 'aggregated-error') {
    const error = encoding[`${a.axis}Error`]
    const error2 = encoding[`${a.axis}Error2`]
    const calculate = [
      { calculate: `${datumRef(f)} + ${datumRef(error.field)}`, as: at('upper') },
      { calculate: `${datumRef(f)} ${error2 ? '+' : '-'} ${datumRef((error2 ?? error).field)}`, as: at('lower') },
    ]
    return { aggregate: [], calculate, lines: [{ field: f, title: f }, ...calculate.map(titledCalc)], named: false }
  }

  // raw values: the error is a spread around a centre, or the range between two quantiles (an errorband takes the errorbar's centre)
  const { markDef } = a
  const center: string = markDef.center ?? (markDef.extent ? (markDef.extent === 'iqr' ? 'median' : 'mean') : defaultCenter)
  const extent: string = markDef.extent ?? (center === 'mean' ? 'stderr' : 'iqr')
  if (extent === 'stderr' || extent === 'stdev') {
    const c = titleCase(center)
    return {
      aggregate: [{ op: extent, field: f, as: at('extent') }, { op: center, field: f, as: at('center') }],
      calculate: [
        { calculate: `${datumRef(at('center'))} + ${datumRef(at('extent'))}`, as: at('upper') },
        { calculate: `${datumRef(at('center'))} - ${datumRef(at('extent'))}`, as: at('lower') },
      ],
      lines: [{ field: at('center'), title: c }, { field: at('upper'), title: `${c} + ${extent}` }, { field: at('lower'), title: `${c} - ${extent}` }],
      named: true,
    }
  }
  const [mid, low, high] = extent === 'ci' ? ['mean', 'ci0', 'ci1'] : ['median', 'q1', 'q3']
  const stat = (op: string): string => verbalTitle({ field: f, aggregate: op })
  return {
    aggregate: [{ op: low, field: f, as: at('lower') }, { op: high, field: f, as: at('upper') }, { op: mid, field: f, as: at('center') }],
    calculate: [],
    lines: [{ field: at('upper'), title: stat(high) }, { field: at('lower'), title: stat(low) }, { field: at('center'), title: stat(mid) }],
    named: false,
  }
}

/** What errorbar and errorband read of the unit before they draw: the anatomy, the transforms and the tooltip. */
function readErrorMark(unit: Obj, kind: 'errorbar' | 'errorband', config: Obj): { a: Anatomy; transform: Obj[]; tooltip: Obj; outer: Obj; orient: Orient } {
  const { mark, encoding, params: _p, projection: _pr, ...outer } = unit
  const markDef: Obj = isObj(mark) ? mark : { type: mark }
  const { orient, input } = inputOf(markDef, encoding, kind)
  const axis = orient === 'vertical' ? 'y' : 'x'
  const withoutAggregate = (d: Obj | undefined): Obj | undefined => {
    if (!isObj(d) || !d.aggregate) return d
    const { aggregate: _a, ...rest } = d
    return rest
  }
  const continuous = withoutAggregate(encoding[axis])!
  const others: Obj = {}
  for (const [channel, def] of Object.entries(encoding)) {
    if (channel !== axis && channel !== `${axis}2` && channel !== `${axis}Error` && channel !== `${axis}Error2`) others[channel] = def
  }
  const lifted = liftTransforms(others, kind)
  const a: Anatomy = { kind, markDef, config: config[kind], axis, continuous, shared: lifted.encoding, fieldName: (prefix) => genName(prefix, continuous.field) }
  const ends = { [`${axis}2`]: withoutAggregate(encoding[`${axis}2`]), [`${axis}Error`]: withoutAggregate(encoding[`${axis}Error`]), [`${axis}Error2`]: withoutAggregate(encoding[`${axis}Error2`]) }
  // (an errorband reads the errorbar config's centre, as an errorbar does)
  const stats = errorStatistics(a, input, ends, config.errorbar.center)

  const aggregate = [...lifted.aggregate, ...stats.aggregate]
  const name = a.continuous.title ?? a.continuous.field
  const tooltip = tooltipOf(stats.lines.map(({ field, title }) => ({ field, type: continuous.type, title: `${title}${stats.named ? ` of ${name}` : ''}` })), lifted.encoding)
  return {
    a,
    outer,
    orient,
    tooltip,
    transform: [
      ...((outer.transform as Obj[] | undefined) ?? []),
      ...lifted.timeUnits,
      ...(aggregate.length ? [{ aggregate, groupby: input === 'raw' ? lifted.groupby : [] }] : []),
      ...stats.calculate,
    ],
  }
}

function errorbarLayers(unit: Obj, config: Obj): Obj {
  const { a, transform, tooltip, outer, orient } = readErrorMark(unit, 'errorbar', config)
  const { thickness, size } = a.markDef
  const tick = { type: 'tick', orient: orient === 'vertical' ? 'horizontal' : 'vertical', aria: false, ...(thickness !== undefined ? { thickness } : {}), ...(size !== undefined ? { size } : {}) }
  const rule = { type: 'rule', ariaRoleDescription: 'errorbar', ...(thickness !== undefined ? { size: thickness } : {}) }
  const encoding = { ...a.shared, ...tooltip }
  const layers = [
    ...part(a, { name: 'ticks', mark: tick, at: 'lower', encoding }),
    ...part(a, { name: 'ticks', mark: tick, at: 'upper', encoding }),
    ...part(a, { name: 'rule', mark: rule, at: 'lower', to: 'upper', encoding }),
  ]
  // the marks are sized by the mark def, never by a channel
  for (const l of layers) delete l.encoding.size
  return { ...outer, transform, ...(layers.length > 1 ? { layer: layers } : { ...layers[0] }) }
}

function errorbandLayers(unit: Obj, config: Obj): Obj {
  const { a, transform, tooltip, outer } = readErrorMark(unit, 'errorband', config)
  // a band over a continuous second axis is an area with its outline, over a discrete one a rectangle with its edges
  const ranged = unit.encoding.x !== undefined && unit.encoding.y !== undefined
  const { interpolate, tension } = a.markDef
  const curve = { ...(interpolate ? { interpolate } : {}), ...(tension && interpolate ? { tension } : {}) }
  const band = ranged ? { type: 'area', ...curve, ariaRoleDescription: 'errorband' } : { type: 'rect' }
  const edge = ranged ? { type: 'line', ...curve, aria: false } : { type: 'rule' }
  const encoding = { ...a.shared, ...tooltip }
  return {
    ...outer,
    transform,
    layer: [
      ...part(a, { name: 'band', mark: band, at: 'lower', to: 'upper', encoding }),
      ...part(a, { name: 'borders', mark: edge, at: 'lower', encoding }),
      ...part(a, { name: 'borders', mark: edge, at: 'upper', encoding }),
    ],
  }
}

// --- boxplot -------------------------------------------------------------------------------------------------------------------

function boxplotLayers(unit: Obj, userConfig: Obj | undefined): Obj {
  const config = mergeDeep(BOXPLOT_DEFAULTS, isObj(userConfig?.boxplot) ? (userConfig!.boxplot as Obj) : undefined)
  const { mark, encoding, params: _p, projection: _pr, ...outer } = unit
  const markDef: Obj = isObj(mark) ? mark : { type: mark }
  const extent: 'min-max' | number = markDef.extent ?? config.extent
  const minMax = extent === 'min-max'
  if (!minMax && !(typeof extent === 'number' && Number.isFinite(extent) && extent >= 0)) {
    throw new VLCompileError(`mark.extent must be a non-negative number or "min-max", got ${JSON.stringify(extent)}`)
  }
  // the mark def's size, else the config's, else the generic mark config's
  const size = markDef.size ?? config.size ?? (isObj(userConfig?.mark) ? (userConfig!.mark as Obj).size : undefined)
  const invalid = markDef.invalid

  const orient = orientationOf(markDef, encoding, 'boxplot')
  const axis = orient === 'vertical' ? 'y' : 'x'
  const { [axis]: continuousChannel, ...others } = encoding as Obj
  if (!isObj(continuousChannel) || continuousChannel.field === undefined) throw new VLCompileError(`boxplot: the ${axis} channel needs a field`)
  const { aggregate: _agg, ...continuous } = continuousChannel
  const f = continuous.field as string
  const path = splitAccessPath(f).join('.')
  const { rest, raw: rawTooltip } = splitTooltip(others)
  const lifted = liftTransforms(rest, 'boxplot')
  const shared = lifted.encoding
  const stat = (prefix: string): string => `${prefix}_${path}`

  const quartiles = (): Obj[] => [{ op: 'q1', field: f, as: stat('lower_box') }, { op: 'q3', field: f, as: stat('upper_box') }]
  // the whiskers reach the extremes when the extent is min-max; otherwise they reach the last datum within the fences, computed below
  const aggregates: Obj[] = [
    ...quartiles(),
    { op: 'median', field: f, as: stat('mid_box') },
    { op: 'min', field: f, as: minMax ? stat('lower_whisker') : stat('min') },
    { op: 'max', field: f, as: minMax ? stat('upper_whisker') : stat('max') },
  ]
  const transform: Obj[] = [...lifted.timeUnits, { aggregate: [...lifted.aggregate, ...aggregates], groupby: lifted.groupby }]

  const { color, size: sizeChannel, ...unsized } = shared
  const a: Anatomy = { kind: 'boxplot', markDef, config, axis, continuous, shared, fieldName: (prefix) => `${prefix}_${f}` }

  const summary = (stats: Array<[prefix: string, label: string]>): Obj =>
    tooltipOf(stats.map(([prefix, label]) => ({ field: prefix + continuous.field, type: continuous.type, title: `${label} of ${continuous.title ?? continuous.field}` })), shared)
  const fiveNumbers = summary([
    [minMax ? 'upper_whisker_' : 'max_', 'Max'], ['upper_box_', 'Q3'], ['mid_box_', 'Median'], ['lower_box_', 'Q1'], [minMax ? 'lower_whisker_' : 'min_', 'Min'],
  ])
  const whiskerTooltip = minMax ? fiveNumbers : summary([['upper_whisker_', 'Upper Whisker'], ['lower_whisker_', 'Lower Whisker']])

  // the whiskers: a rule from each end of the box to the extreme, and a tick at the extreme
  const rule = { type: 'rule', invalid, aria: false }
  const tick = { type: 'tick', color: 'black', opacity: 1, orient: orient === 'vertical' ? 'horizontal' : 'vertical', invalid, aria: false }
  const whiskerEncoding = { ...unsized, ...whiskerTooltip }
  const whiskers = [
    ...part(a, { name: 'rule', mark: rule, at: 'lower_whisker', to: 'lower_box', encoding: whiskerEncoding }),
    ...part(a, { name: 'rule', mark: rule, at: 'upper_box', to: 'upper_whisker', encoding: whiskerEncoding }),
    ...part(a, { name: 'ticks', mark: tick, at: 'lower_whisker', encoding: whiskerEncoding }),
    ...part(a, { name: 'ticks', mark: tick, at: 'upper_whisker', encoding: whiskerEncoding }),
  ]

  // the box, and a tick at the median that shows where the box is inverted (its colour is the box's, or the box's default)
  const boxColor = (isObj(config.box) ? config.box.color : isObj(userConfig?.mark) ? (userConfig!.mark as Obj).color : undefined) || '#4c78a8'
  const median = {
    type: 'tick',
    invalid,
    ...(isObj(config.median) && config.median.color ? { color: config.median.color } : {}),
    ...(size ? { size } : {}),
    orient: orient === 'vertical' ? 'horizontal' : 'vertical',
    aria: false,
  }
  const boxParts = [
    ...(minMax ? whiskers : []),
    ...part(a, { name: 'box', mark: { type: 'bar', ...(size ? { size } : {}), orient, invalid, ariaRoleDescription: 'box' }, at: 'lower_box', to: 'upper_box', encoding: { ...shared, ...fiveNumbers } }),
    ...part(a, {
      name: 'median',
      mark: median,
      at: 'mid_box',
      encoding: {
        ...unsized,
        ...(sizeChannel ? { size: sizeChannel } : {}),
        color: { condition: { test: `${quotedRef(`lower_box_${f}`)} >= ${quotedRef(`upper_box_${f}`)}`, ...(color || { value: boxColor }) } },
        ...fiveNumbers,
      },
    }),
  ]
  if (minMax) return { ...outer, transform: ((outer.transform as Obj[] | undefined) ?? []).concat(transform), layer: boxParts }

  // Tukey's box plot: the whiskers reach the furthest datum within `extent` interquartile ranges of the box; data beyond are outliers
  const lower = quotedRef(`lower_box_${path}`)
  const upper = quotedRef(`upper_box_${path}`)
  const range = `(${upper} - ${lower})`
  const lowerFence = `${lower} - ${extent} * ${range}`
  const upperFence = `${upper} + ${extent} * ${range}`
  const value = quotedRef(f)

  const withinFences: Obj = {
    transform: [
      { filter: `(${lowerFence} <= ${value}) && (${value} <= ${upperFence})` },
      {
        aggregate: [
          { op: 'min', field: f, as: stat('lower_whisker') },
          { op: 'max', field: f, as: stat('upper_whisker') },
          { op: 'min', field: `lower_box_${f}`, as: stat('lower_box') },
          { op: 'max', field: `upper_box_${f}`, as: stat('upper_box') },
          ...lifted.aggregate,
        ],
        groupby: lifted.groupby,
      },
    ],
    layer: whiskers,
  }
  const { tooltip: _t, ...unsizedNoTooltip } = unsized
  const outliers = part(a, {
    name: 'outliers',
    mark: 'point',
    field: f,
    transform: [{ filter: `(${value} < ${lowerFence}) || (${value} > ${upperFence})` }],
    encoding: { ...unsizedNoTooltip, ...(color ? { color } : {}), ...(rawTooltip ? { tooltip: rawTooltip } : {}) },
  })[0]

  const quartilesOfGroup = [...lifted.timeUnits, { joinaggregate: quartiles(), groupby: lifted.groupby }]
  let fenced: Obj
  if (outliers) fenced = { transform: quartilesOfGroup, layer: [outliers, withinFences] }
  else fenced = { ...withinFences, transform: [...quartilesOfGroup, ...withinFences.transform] }
  return { ...outer, layer: [fenced, { transform, layer: boxParts }] }
}

// --- entry ---------------------------------------------------------------------------------------------------------------------

/** A composite unit as the layer of simple marks that draws it. `unit.encoding` is complete and typed. */
export function compositeLayers(kind: CompositeMark, unit: Obj, userConfig: Obj | undefined): Obj {
  if (kind === 'boxplot') return boxplotLayers(unit, userConfig)
  const config = {
    errorbar: { ...DEFAULT_CONFIG.errorbar, ...(userConfig?.errorbar ?? {}) },
    errorband: { ...DEFAULT_CONFIG.errorband, ...(userConfig?.errorband ?? {}) },
  }
  return kind === 'errorbar' ? errorbarLayers(unit, config) : errorbandLayers(unit, config)
}
