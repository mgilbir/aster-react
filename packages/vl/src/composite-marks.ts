/**
 * The composite marks: boxplot, errorbar and errorband. A composite mark is a unit that stands for several: it is rewritten, before
 * anything is compiled, into a layer of simple marks (rules, ticks, bars, areas...) that draw the summary statistics of one aggregate
 * transform, and the layer compiler takes it from there.
 *
 * The three share their anatomy: one continuous axis the statistics are of, the other channels every part draws, the parts the mark
 * def and the config switch on and off, and the tooltip that lists the statistics. They differ in the statistics and in the parts.
 */
import { VLCompileError, dict, genName, guardedPathRef, splitAccessPath } from './names.js'
import { getTimeUnitParts } from './timeunit.js'
import { normalizeTimeUnit } from './validate.js'
import { derive, deriveWithout } from './consume.js'

type Obj = Record<string, any>
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v)
/** What the literal of a default title reads of a field written with escapes: `a\\.b` is titled `a.b` (a title the user wrote is text, not this). */
const readEscapes = (s: string): string => s.replace(/\\(.)/gs, '$1')
const titleCase = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)
/** The field a row has under `name` itself (a name this module made: a statistic), as source text of an expression. */
const datumRef = (name: string): string => `datum[${JSON.stringify(name)}]`
/**
 * The value of a field of the unit's own rows, as an operand of an expression: a one-piece path (`a`, `a\\.b`) is the row's key, a nested
 * one (`o.v`) is read through each piece and guarded, as a flat copy would hold it (vega-lite names that copy `o.v` and reads it).
 */
const fieldRead = (f: string): string => {
  const pieces = splitAccessPath(f)
  return pieces.length === 1 ? datumRef(pieces[0]!) : quotedRef(pieces.join('.'))
}
/**
 * The flat copy of a nested field the statistics read: vega-lite's parse step writes `o.v` (the path joined) for the field `o.v`, but only
 * for a field some channel names, and the statistics are made from the field no channel names (an error mark's measure), so its aggregate
 * reads nothing and makes nulls. The copy is made here, first, for every composite mark.
 */
function flatCopyOf(field: string): Obj[] {
  const pieces = splitAccessPath(field)
  return pieces.length > 1 ? [{ calculate: guardedPathRef(field), as: pieces.join('.') }] : []
}

/**
 * The name of a statistic of `field`, `prefix_path` (vega-lite's: `lower_box_o.v` for the field `o.v`, written as the row's key, which a
 * path of that name reads back). A name no path reads back as written (brackets, quotes) gets a safe stand-in.
 */
function statName(prefix: string, field: string): string {
  const path = splitAccessPath(field).join('.')
  const name = `${prefix}_${path}`
  return splitAccessPath(name).join('.') === name ? name : genName(prefix, path)
}
/** `datum['name']` as source text of an expression: the name is a string literal, so its backslashes and quotes are escaped. */
export const quotedRef = (name: string): string => `datum['${name.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}']`

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
  const out: Obj = Object.assign(dict(), base)
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
  // (vega-lite also takes an axis whose aggregate is the composite's own name as the one the statistics are of; the aggregate of a
  // channel is one of the schema's operations, so no spec has one)
  if (xs && ys) return y.type === 'temporal' && x.type !== 'temporal' ? 'horizontal' : 'vertical'
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
function axisDef(a: Anatomy, field: string, raw = false): Obj {
  const { scale, axis } = a.continuous
  // (a part over a statistic is named by a title: the field's default one, whose escapes the literal of a description or tooltip reads
  // (`a\\.b` is read `a.b`), while the axis shows the name as written; the outliers draw the raw field and keep its own default title)
  const own = a.continuous.title
  const title = own !== undefined ? own : raw ? undefined : readEscapes(a.continuous.field)
  const axisOut = own === undefined && !raw && axis !== null && !(isObj(axis) && axis.title !== undefined) ? { ...(isObj(axis) ? axis : {}), title: a.continuous.field } : axis
  return { field, type: a.continuous.type, ...(title !== undefined ? { title } : {}), ...(scale !== undefined ? { scale } : {}), ...(axisOut !== undefined ? { axis: axisOut } : {}) }
}

/** The end of a ranged part: its field (the position channel carries the title, which names the axis). */
function endDef(a: Anatomy, prefix: string): Obj {
  return { field: a.fieldName(prefix) }
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
      [a.axis]: axisDef(a, p.field ?? a.fieldName(p.at!), p.name === 'outliers'),
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
  const at = (prefix: string): string => statName(prefix, f)
  const titledCalc = (c: Obj): { field: string; title: string } => ({ field: c.as, title: String(c.calculate).replace(/datum\["|"\]/g, '') })

  if (input === 'aggregated-upper-lower') {
    const calculate = [{ calculate: fieldRead(encoding[`${a.axis}2`].field), as: at('upper') }, { calculate: fieldRead(f), as: at('lower') }]
    return { aggregate: [], calculate, lines: calculate.map(titledCalc), named: false }
  }
  if (input === 'aggregated-error') {
    const error = encoding[`${a.axis}Error`]
    const error2 = encoding[`${a.axis}Error2`]
    const calculate = [
      { calculate: `${fieldRead(f)} + ${fieldRead(error.field)}`, as: at('upper') },
      { calculate: `${fieldRead(f)} ${error2 ? '+' : '-'} ${fieldRead((error2 ?? error).field)}`, as: at('lower') },
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

/**
 * The unit's `outer` properties with the parameters it keeps: the variable ones (a value, a binding, an expression), which signals of the
 * parts read (a filter, a title) and which vega-lite keeps. A selection of a composite mark is dropped by vega-lite with a warning, which
 * here is a refusal (nothing is silently ignored); the ones a composition gave to every unit below it are handled by `compositeLayers`.
 */
function withVariableParams(outer: Obj, params: unknown, kind: CompositeMark): Obj {
  if (!Array.isArray(params)) return outer
  const kept: unknown[] = []
  for (const p of params) {
    if (!isObj(p) || p.select === undefined) kept.push(p)
    else if (!isGiven(p)) throw new VLCompileError(`params: the selection parameter ${JSON.stringify(p.name)} on a ${kind}: a selection of a composite mark is not supported (vega-lite 6.4.3 drops it with a warning); put it on a unit of a layer`)
  }
  return kept.length > 0 ? { ...outer, params: kept } : outer
}

/** What errorbar and errorband read of the unit before they draw: the anatomy, the transforms and the tooltip. */
function readErrorMark(unit: Obj, kind: 'errorbar' | 'errorband', config: Obj): { a: Anatomy; transform: Obj[]; tooltip: Obj; outer: Obj; orient: Orient } {
  const { mark, encoding, params, projection: _pr, ...rest } = unit
  const outer = withVariableParams(rest, params, kind)
  const markDef: Obj = isObj(mark) ? mark : { type: mark }
  const { orient, input } = inputOf(markDef, encoding, kind)
  const axis = orient === 'vertical' ? 'y' : 'x'
  const withoutAggregate = (d: Obj | undefined): Obj | undefined => {
    if (!isObj(d) || !d.aggregate) return d
    const { aggregate: _a, ...rest } = d
    return rest
  }
  const continuous = withoutAggregate(encoding[axis])!
  // vega-lite makes the statistics of an error mark before the flat copy of a nested path exists, and reads a name with a dot in it as a
  // path: its aggregates read nothing, and it draws no bar (an errorbar) or nulls (an errorband). Q9: refused, not drawn differently.
  if (typeof continuous.field === 'string') {
    const pieces = splitAccessPath(continuous.field)
    if (pieces.length > 1 || pieces[0] !== continuous.field) {
      throw new VLCompileError(`encoding.${axis}.field: the ${kind} measure ${JSON.stringify(continuous.field)} is a nested path or a name with a dot in it: vega-lite 6.4.3 cannot read it (its statistics are made before the field is flattened, so it draws no bar or nulls); name a plain column, made by a calculate`)
    }
  }
  const others: Obj = {}
  for (const [channel, def] of Object.entries(encoding)) {
    if (channel !== axis && channel !== `${axis}2` && channel !== `${axis}Error` && channel !== `${axis}Error2`) others[channel] = def
  }
  const lifted = liftTransforms(others, kind)
  const a: Anatomy = { kind, markDef, config: config[kind], axis, continuous, shared: lifted.encoding, fieldName: (prefix) => statName(prefix, continuous.field) }
  const ends = { [`${axis}2`]: withoutAggregate(encoding[`${axis}2`]), [`${axis}Error`]: withoutAggregate(encoding[`${axis}Error`]), [`${axis}Error2`]: withoutAggregate(encoding[`${axis}Error2`]) }
  // (an errorband reads the errorbar config's centre, as an errorbar does)
  const stats = errorStatistics(a, input, ends, config.errorbar.center)

  const aggregate = [...lifted.aggregate, ...stats.aggregate]
  const name = a.continuous.title !== undefined ? a.continuous.title : readEscapes(a.continuous.field)
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
  const { mark, encoding, params, projection: _pr, ...unitRest } = unit
  const outer = withVariableParams(unitRest, params, 'boxplot')
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
  const { rest, raw: rawTooltip } = splitTooltip(others)
  const lifted = liftTransforms(rest, 'boxplot')
  const shared = lifted.encoding
  const stat = (prefix: string): string => statName(prefix, f)

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
  const a: Anatomy = { kind: 'boxplot', markDef, config, axis, continuous, shared, fieldName: (prefix) => statName(prefix, f) }

  const summary = (stats: Array<[prefix: string, label: string]>): Obj =>
    tooltipOf(stats.map(([prefix, label]) => ({ field: statName(prefix.replace(/_$/, ''), continuous.field), type: continuous.type, title: `${label} of ${continuous.title !== undefined ? continuous.title : readEscapes(continuous.field)}` })), shared)
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
        color: { condition: { test: `${quotedRef(stat('lower_box'))} >= ${quotedRef(stat('upper_box'))}`, ...(color || { value: boxColor }) } },
        ...fiveNumbers,
      },
    }),
  ]
  if (minMax) return { ...outer, transform: ((outer.transform as Obj[] | undefined) ?? []).concat(flatCopyOf(f), transform), layer: boxParts }

  // Tukey's box plot: the whiskers reach the furthest datum within `extent` interquartile ranges of the box; data beyond are outliers
  const lower = quotedRef(stat('lower_box'))
  const upper = quotedRef(stat('upper_box'))
  const range = `(${upper} - ${lower})`
  const lowerFence = `${lower} - ${extent} * ${range}`
  const upperFence = `${upper} + ${extent} * ${range}`
  const value = fieldRead(f)

  const withinFences: Obj = {
    transform: [
      { filter: `(${lowerFence} <= ${value}) && (${value} <= ${upperFence})` },
      {
        aggregate: [
          { op: 'min', field: f, as: stat('lower_whisker') },
          { op: 'max', field: f, as: stat('upper_whisker') },
          { op: 'min', field: stat('lower_box'), as: stat('lower_box') },
          { op: 'max', field: stat('upper_box'), as: stat('upper_box') },
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
  const copy = flatCopyOf(f)
  return { ...outer, ...(copy.length ? { transform: ((outer.transform as Obj[] | undefined) ?? []).concat(copy) } : {}), layer: [fenced, { transform, layer: boxParts }] }
}

// --- entry ---------------------------------------------------------------------------------------------------------------------

/**
 * The selection parameters a composition gave to a unit are told from the ones the unit declares (which a composite mark does not
 * take) by a flag on the parameter, which survives the copies a repeat makes of its spec.
 */
const GIVEN = '$given'
export function markGiven<T extends object>(param: T): T {
  return derive(param as Obj, { [GIVEN]: true }) as T
}
export const isGiven = (param: unknown): boolean => isObj(param) && param[GIVEN] === true

/** Whether a rewritten spec draws no mark at all (every part the mark def and the config left on is off). */
const drawsNothing = (node: Obj): boolean => node.mark === undefined && (!Array.isArray(node.layer) || node.layer.every((l: unknown) => isObj(l) && drawsNothing(l)))

/** A composite unit as the layer of simple marks that draws it. `unit.encoding` is complete and typed. */
export function compositeLayers(kind: CompositeMark, unit: Obj, userConfig: Obj | undefined): Obj {
  const made = layersOf(kind, unit, userConfig)
  if (drawsNothing(made)) throw new VLCompileError(`mark: every part of the ${kind} is switched off, so it draws nothing (vega-lite 6.4.3 throws "Invalid specification" or draws an empty view)`)
  const given = Array.isArray(unit.params) ? unit.params.filter(isGiven).map((param: Obj) => deriveWithout(param, [GIVEN])) : []
  if (given.length === 0) return made
  // a selection is declared by every unit the composition gave it to: a composite mark of one unit takes it, one of several declares its
  // signals twice in a Vega scope, which Vega rejects
  const leaves = Array.isArray(made.layer) ? (made.layer as Obj[]) : [made]
  if (kind === 'boxplot' || leaves.length !== 1) {
    throw new VLCompileError(`params: a selection parameter given to every unit below a composition cannot be given to a ${kind}, which is ${leaves.length === 1 ? 'a layer' : `${leaves.length} units`} once vega-lite has normalized it: declare it on a unit instead`)
  }
  if (Array.isArray(made.layer)) return { ...made, layer: [{ ...leaves[0], params: given }] }
  return { ...made, params: [...(Array.isArray(made.params) ? made.params : []), ...given] }
}

function layersOf(kind: CompositeMark, unit: Obj, userConfig: Obj | undefined): Obj {
  if (kind === 'boxplot') return boxplotLayers(unit, userConfig)
  const config = {
    errorbar: { ...DEFAULT_CONFIG.errorbar, ...(userConfig?.errorbar ?? {}) },
    errorband: { ...DEFAULT_CONFIG.errorband, ...(userConfig?.errorband ?? {}) },
  }
  return kind === 'errorbar' ? errorbarLayers(unit, config) : errorbandLayers(unit, config)
}
