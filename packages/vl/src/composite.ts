// errorbar and errorband composite marks: vega-lite 6.4.3 compositemark/{errorbar,errorband,common}.ts.
// A composite mark is a normalization: the unit spec becomes a layer of simple marks (tick, rule, area, rect,
// line) over a shared aggregate transform, which the ordinary layer compiler then handles.
import { VLCompileError, genName } from './names.js'
import { getTimeUnitParts } from './timeunit.js'
import { normalizeTimeUnit } from './validate.js'

type Obj = Record<string, any>
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v)
const isField = (d: unknown): d is Obj => isObj(d) && (d.field !== undefined || d.datum !== undefined)
const titleCase = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)
const datumRef = (name: string): string => `datum[${JSON.stringify(name)}]`

/** Continuous = quantitative (unbinned) or temporal (channeldef.ts isContinuousFieldOrDatumDef). */
const isContinuous = (d: unknown): boolean => isObj(d) && (d.type === 'temporal' || (d.type === 'quantitative' && !d.bin))

const DEFAULT_CONFIG: Record<string, Obj> = {
  errorbar: { center: 'mean', rule: true, ticks: false },
  errorband: { band: { opacity: 0.3 }, borders: false },
}

/** The verbal title of an aggregated / time-unit / binned field (channeldef.ts verbalTitleFormatter). */
function verbalTitle(def: Obj): string {
  const { field, bin, timeUnit, aggregate } = def
  if (aggregate === 'count') return 'Count of Records'
  if (bin) return `${field} (binned)`
  if (timeUnit) return `${field} (${getTimeUnitParts(normalizeTimeUnit(timeUnit).unit).join('-')})`
  if (aggregate) return `${titleCase(String(aggregate))} of ${field}`
  return String(field)
}

function orientOf(spec: Obj, composite: string): 'vertical' | 'horizontal' {
  const { mark, encoding } = spec
  const { x, y } = encoding
  if (isObj(mark) && mark.orient) return mark.orient
  if (isContinuous(x)) {
    if (isContinuous(y)) {
      const xa = isObj(x) && x.aggregate
      const ya = isObj(y) && y.aggregate
      if (!xa && ya === composite) return 'vertical'
      if (!ya && xa === composite) return 'horizontal'
      if (xa === composite && ya === composite) throw new VLCompileError(`${composite}: both x and y cannot have aggregate`)
      return y.type === 'temporal' && x.type !== 'temporal' ? 'horizontal' : 'vertical'
    }
    return 'horizontal'
  }
  if (isContinuous(y)) return 'vertical'
  throw new VLCompileError(`${composite} needs a continuous x or y axis`)
}

type InputType = 'raw' | 'aggregated-upper-lower' | 'aggregated-error'

function orientAndInput(spec: Obj, composite: string): { orient: 'vertical' | 'horizontal'; inputType: InputType } {
  const e = spec.encoding
  const raw = (isField(e.x) || isField(e.y)) && !isField(e.x2) && !isField(e.y2) && !isField(e.xError) && !isField(e.xError2) && !isField(e.yError) && !isField(e.yError2)
  if (raw) return { orient: orientOf(spec, composite), inputType: 'raw' }
  const upperLower = isField(e.x2) || isField(e.y2)
  const errored = isField(e.xError) || isField(e.xError2) || isField(e.yError) || isField(e.yError2)
  if (upperLower) {
    if (errored) throw new VLCompileError(`${composite} cannot be both aggregated-upper-lower and aggregated-error`)
    if (isField(e.x2) && isField(e.y2)) throw new VLCompileError(`${composite} cannot have both x2 and y2`)
    if (isField(e.x2)) {
      if (isContinuous(e.x)) return { orient: 'horizontal', inputType: 'aggregated-upper-lower' }
      throw new VLCompileError(`both x and x2 have to be quantitative in ${composite}`)
    }
    if (isContinuous(e.y)) return { orient: 'vertical', inputType: 'aggregated-upper-lower' }
    throw new VLCompileError(`both y and y2 have to be quantitative in ${composite}`)
  }
  if (isField(e.xError2) && !isField(e.xError)) throw new VLCompileError(`${composite} cannot have xError2 without xError`)
  if (isField(e.yError2) && !isField(e.yError)) throw new VLCompileError(`${composite} cannot have yError2 without yError`)
  if (isField(e.xError) && isField(e.yError)) throw new VLCompileError(`${composite} cannot have both xError and yError`)
  if (isField(e.xError)) {
    if (isContinuous(e.x)) return { orient: 'horizontal', inputType: 'aggregated-error' }
    throw new VLCompileError('x, xError and xError2 have to be quantitative')
  }
  if (isField(e.yError)) {
    if (isContinuous(e.y)) return { orient: 'vertical', inputType: 'aggregated-error' }
    throw new VLCompileError('y, yError and yError2 have to be quantitative')
  }
  throw new VLCompileError(`${composite} has no ranged axis`)
}

/** Pull aggregate / time-unit out of the remaining channels into transforms (encoding.ts extractTransformsFromEncoding). */
function extractTransforms(old: Obj, composite: string): { timeUnits: Obj[]; aggregate: Obj[]; groupby: string[]; encoding: Obj } {
  const timeUnits: Obj[] = []
  const aggregate: Obj[] = []
  const groupby: string[] = []
  const encoding: Obj = {}
  for (const [channel, def] of Object.entries(old)) {
    if (!isObj(def) || Array.isArray(def) || def.field === undefined) {
      encoding[channel] = def
      if (isObj(def) && def.field !== undefined) groupby.push(def.field)
      continue
    }
    const { field, aggregate: agg, bin, timeUnit, ...rest } = def
    if (!agg && !timeUnit && !bin) {
      groupby.push(field)
      encoding[channel] = def
      continue
    }
    if (bin) throw new VLCompileError(`${composite} over a binned ${channel} channel is not supported`)
    if (typeof agg === 'object' && agg !== null) throw new VLCompileError(`${composite}: argmin/argmax on ${channel} is not supported`)
    const as = timeUnit ? genName(normalizeTimeUnit(timeUnit).unit, field) : genName(String(agg), field)
    const title = isObj(def.axis) && def.axis.title !== undefined ? undefined : verbalTitle(def)
    encoding[channel] = { ...(def.title === undefined && title !== undefined ? { title } : {}), ...rest, field: as }
    if (agg) aggregate.push({ op: agg, ...(field ? { field } : {}), as })
    else {
      timeUnits.push({ timeUnit, field, as })
      groupby.push(as)
    }
  }
  return { timeUnits, aggregate, groupby, encoding }
}

interface Params {
  transform: Obj[]
  continuousAxis: 'x' | 'y'
  continuous: Obj
  encoding: Obj
  ticksOrient: 'vertical' | 'horizontal'
  markDef: Obj
  outer: Obj
  tooltip: Obj
}

function params(spec: Obj, composite: 'errorbar' | 'errorband', config: Obj): Params {
  const { mark, encoding, params: _p, projection: _pr, ...outer } = spec
  const markDef: Obj = isObj(mark) ? mark : { type: mark }
  const { orient, inputType } = orientAndInput(spec, composite)
  const axis = orient === 'vertical' ? 'y' : 'x'
  const noAgg = (d: Obj | undefined): Obj | undefined => {
    if (!isObj(d) || !d.aggregate) return d
    const { aggregate: _a, ...rest } = d
    return rest
  }
  const continuous = noAgg(encoding[axis])!
  const def2 = noAgg(encoding[`${axis}2`])
  const error = noAgg(encoding[`${axis}Error`])
  const error2 = noAgg(encoding[`${axis}Error2`])
  const f = continuous.field as string
  const n = (prefix: string): string => genName(prefix, f)

  let specific: Obj[] = []
  let calcs: Obj[] = []
  let summary: Array<{ prefix: string; title: string }>
  let titleWithField = false
  if (inputType === 'raw') {
    // (errorband reads the errorbar config's center, as vega-lite does)
    const center: string = markDef.center ?? (markDef.extent ? (markDef.extent === 'iqr' ? 'median' : 'mean') : config.errorbar.center)
    const extent: string = markDef.extent ?? (center === 'mean' ? 'stderr' : 'iqr')
    if (extent === 'stderr' || extent === 'stdev') {
      specific = [{ op: extent, field: f, as: n('extent') }, { op: center, field: f, as: n('center') }]
      calcs = [
        { calculate: `${datumRef(n('center'))} + ${datumRef(n('extent'))}`, as: n('upper') },
        { calculate: `${datumRef(n('center'))} - ${datumRef(n('extent'))}`, as: n('lower') },
      ]
      summary = [
        { prefix: n('center'), title: titleCase(center) },
        { prefix: n('upper'), title: `${titleCase(center)} + ${extent}` },
        { prefix: n('lower'), title: `${titleCase(center)} - ${extent}` },
      ]
      titleWithField = true
    } else {
      const [centerOp, lowOp, highOp] = extent === 'ci' ? ['mean', 'ci0', 'ci1'] : ['median', 'q1', 'q3']
      specific = [
        { op: lowOp, field: f, as: n('lower') },
        { op: highOp, field: f, as: n('upper') },
        { op: centerOp, field: f, as: n('center') },
      ]
      summary = [
        { prefix: n('upper'), title: verbalTitle({ field: f, aggregate: highOp }) },
        { prefix: n('lower'), title: verbalTitle({ field: f, aggregate: lowOp }) },
        { prefix: n('center'), title: verbalTitle({ field: f, aggregate: centerOp }) },
      ]
    }
  } else {
    const titled = (c: Obj): { prefix: string; title: string } => ({ prefix: c.as as string, title: String(c.calculate).replace(/datum\["|"\]/g, '') })
    if (inputType === 'aggregated-upper-lower') {
      calcs = [
        { calculate: datumRef(def2!.field), as: n('upper') },
        { calculate: datumRef(f), as: n('lower') },
      ]
      summary = calcs.map(titled)
    } else {
      calcs = [
        { calculate: `${datumRef(f)} + ${datumRef(error!.field)}`, as: n('upper') },
        { calculate: `${datumRef(f)} ${error2 ? '+' : '-'} ${datumRef((error2 ?? error)!.field)}`, as: n('lower') },
      ]
      summary = [{ prefix: f, title: f }, ...calcs.map(titled)]
    }
  }

  const rest: Obj = {}
  for (const [k, v] of Object.entries(encoding)) {
    if (k !== axis && k !== `${axis}2` && k !== `${axis}Error` && k !== `${axis}Error2`) rest[k] = v
  }
  const { timeUnits, aggregate: oldAggregate, groupby: oldGroupby, encoding: sharedEncoding } = extractTransforms(rest, composite)
  const aggregate = [...oldAggregate, ...specific]
  const groupby = inputType !== 'raw' ? [] : oldGroupby

  // the tooltip: the summary fields, then the remaining channels' fields (common.ts getCompositeMarkTooltip)
  let tooltip: Obj
  if ('tooltip' in sharedEncoding) tooltip = { tooltip: sharedEncoding.tooltip }
  else {
    const main = continuous.title ?? f
    const summaryDefs = summary.map(({ prefix, title }) => ({
      field: prefix,
      type: continuous.type,
      title: `${title}${titleWithField ? ` of ${main}` : ''}`,
    }))
    const seen = new Set<string>()
    const others: Obj[] = []
    for (const d of Object.values(sharedEncoding)) {
      for (const x of Array.isArray(d) ? d : [d]) {
        if (!isObj(x) || x.field === undefined) continue
        const { bin: _b, timeUnit: _t, aggregate: _a, sort: _s, scale: _sc, legend: _l, axis: _ax, stack: _st, ...plain } = x
        const key = JSON.stringify(plain)
        if (!seen.has(key)) (seen.add(key), others.push(plain))
      }
    }
    tooltip = { tooltip: [...summaryDefs, ...others] }
  }

  return {
    transform: [
      ...((outer.transform as Obj[] | undefined) ?? []),
      ...timeUnits,
      ...(aggregate.length ? [{ aggregate, groupby }] : []),
      ...calcs,
    ],
    continuousAxis: axis,
    continuous,
    encoding: sharedEncoding,
    ticksOrient: orient === 'vertical' ? 'horizontal' : 'vertical',
    markDef,
    outer,
    tooltip,
  }
}

/** One part of the composite mark as a unit spec, or none when the part is switched off (common.ts partLayerMixins). */
function part(p: Params, config: Obj, composite: string, name: string, mark: Obj, positionPrefix: string, endPrefix?: string): Obj[] {
  const cfg: Obj = config[composite] ?? {}
  const own = p.markDef[name]
  if (!(own || (own === undefined && cfg[name]))) return []
  const f = p.continuous.field as string
  const { scale, axis } = p.continuous
  const title = p.continuous.title ?? f
  const { clip, color, opacity } = p.markDef
  return [
    {
      encoding: {
        [p.continuousAxis]: { field: genName(positionPrefix, f), type: p.continuous.type, title, ...(scale !== undefined ? { scale } : {}), ...(axis !== undefined ? { axis } : {}) },
        ...(endPrefix ? { [`${p.continuousAxis}2`]: { field: genName(endPrefix, f) } } : {}),
        ...p.encoding,
        ...p.tooltip,
      },
      mark: {
        ...(isObj(cfg[name]) ? cfg[name] : {}),
        ...(clip ? { clip } : {}),
        ...(color ? { color } : {}),
        ...(opacity ? { opacity } : {}),
        ...mark,
        style: `${composite}-${name}`,
        ...(typeof own === 'boolean' || own === undefined ? {} : own),
      },
    },
  ]
}

function normalizeErrorBar(spec: Obj, config: Obj): Obj {
  const p = params(spec, 'errorbar', config)
  const { thickness, size } = p.markDef
  const tick = { type: 'tick', orient: p.ticksOrient, aria: false, ...(thickness !== undefined ? { thickness } : {}), ...(size !== undefined ? { size } : {}) }
  const layer = [
    ...part(p, config, 'errorbar', 'ticks', tick, 'lower'),
    ...part(p, config, 'errorbar', 'ticks', tick, 'upper'),
    ...part(p, config, 'errorbar', 'rule', { type: 'rule', ariaRoleDescription: 'errorbar', ...(thickness !== undefined ? { size: thickness } : {}) }, 'lower', 'upper'),
  ]
  for (const l of layer) delete (l.encoding as Obj).size
  return { ...p.outer, transform: p.transform, ...(layer.length > 1 ? { layer } : { ...layer[0] }) }
}

function normalizeErrorBand(spec: Obj, config: Obj): Obj {
  const p = params(spec, 'errorband', config)
  const is2D = spec.encoding.x !== undefined && spec.encoding.y !== undefined
  const interpolate = { ...(p.markDef.interpolate ? { interpolate: p.markDef.interpolate } : {}), ...(p.markDef.tension && p.markDef.interpolate ? { tension: p.markDef.tension } : {}) }
  const band = is2D ? { type: 'area', ...interpolate, ariaRoleDescription: 'errorband' } : { type: 'rect' }
  const borders = is2D ? { type: 'line', ...interpolate, aria: false } : { type: 'rule' }
  return {
    ...p.outer,
    transform: p.transform,
    layer: [
      ...part(p, config, 'errorband', 'band', band, 'lower', 'upper'),
      ...part(p, config, 'errorband', 'borders', borders, 'lower'),
      ...part(p, config, 'errorband', 'borders', borders, 'upper'),
    ],
  }
}

const kindOf = (spec: Obj): 'errorbar' | 'errorband' | undefined => {
  const t = isObj(spec.mark) ? spec.mark.type : spec.mark
  return t === 'errorbar' || t === 'errorband' ? t : undefined
}

/** Replace every errorbar / errorband unit in the spec tree by its layer of simple marks. */
export function normalizeComposites(node: unknown, userConfig: Obj | undefined): unknown {
  if (Array.isArray(node)) return node.map((n) => normalizeComposites(n, userConfig))
  if (!isObj(node)) return node
  const config: Obj = {
    errorbar: { ...DEFAULT_CONFIG.errorbar, ...(userConfig?.errorbar ?? {}) },
    errorband: { ...DEFAULT_CONFIG.errorband, ...(userConfig?.errorband ?? {}) },
  }
  const kind = kindOf(node)
  if (kind) {
    const spec = { ...node, encoding: node.encoding ?? {} }
    return kind === 'errorbar' ? normalizeErrorBar(spec, config) : normalizeErrorBand(spec, config)
  }
  const out: Obj = { ...node }
  for (const k of ['layer', 'hconcat', 'vconcat', 'concat']) if (node[k] !== undefined) out[k] = normalizeComposites(node[k], userConfig)
  if (node.spec !== undefined) out.spec = normalizeComposites(node.spec, userConfig)
  return out
}

// --- path overlays (normalize/pathoverlay.ts) --------------------------------------------------------------------------

const DEFAULT_REDUCED_OPACITY = 0.7
const OVERLAY_MARKS = new Set(['line', 'rule', 'trail', 'area'])

const pick = (o: Obj, keys: string[]): Obj => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]))
const omit = (o: Obj, keys: string[]): Obj => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)))

/** The point overlay of a path mark: `point` on the mark, `config.<mark>.point`, or a `shape` channel (getPointOverlay). */
function getPointOverlay(markDef: Obj, markConfig: Obj, encoding: Obj): Obj | null | undefined {
  if (markDef.point === 'transparent') return { opacity: 0 }
  if (markDef.point) return isObj(markDef.point) ? markDef.point : {}
  if (markDef.point !== undefined) return null
  if (markConfig.point || encoding.shape) return isObj(markConfig.point) ? markConfig.point : {}
  return undefined
}

/** The line overlay of an area mark: `line` on the mark or `config.area.line` (getLineOverlay). */
function getLineOverlay(markDef: Obj, markConfig: Obj): Obj | null | undefined {
  if (markDef.line) return markDef.line === true ? {} : markDef.line
  if (markDef.line !== undefined) return null
  if (markConfig.line) return markConfig.line === true ? {} : markConfig.line
  return undefined
}

export interface StackProps {
  fieldChannel: string
  offset?: string
}

/** The marks a layer of mark + overlay replaces: `point` / `line` leave the mark definition. */
function dropLineAndPoint(markDef: Obj): Obj | string {
  const mark = omit(markDef, ['point', 'line'])
  return Object.keys(mark).length > 1 ? mark : (mark.type as string)
}

/**
 * Replace every line / area / rule / trail unit that carries a point (or, for an area, a line) overlay by the layer
 * vega-lite normalizes it to: the mark, then its line, then its points, over the same encoding (a stacked measure's
 * `stack` carried over, `x2` / `y2` and `shape` dropped from the overlays).
 * `stackOf` answers the stack properties of a unit spec; `inherited` is the encoding a parent layer shares.
 */
export function normalizePathOverlays(node: unknown, config: Obj, stackOf: (unit: Obj) => StackProps | undefined, inherited: Obj = {}): unknown {
  if (Array.isArray(node)) return node.map((n) => normalizePathOverlays(n, config, stackOf, inherited))
  if (!isObj(node)) return node
  if (node.layer !== undefined) {
    const encoding = { ...inherited, ...(isObj(node.encoding) ? node.encoding : {}) }
    return { ...node, layer: (node.layer as unknown[]).map((c) => normalizePathOverlays(c, config, stackOf, encoding)) }
  }
  for (const k of ['hconcat', 'vconcat', 'concat']) {
    if (node[k] !== undefined) return { ...node, [k]: normalizePathOverlays(node[k], config, stackOf, {}) }
  }
  if (node.spec !== undefined) return { ...node, spec: normalizePathOverlays(node.spec, config, stackOf, {}) }
  if (node.mark === undefined) return node

  // a unit faceted through its encoding becomes a facet over the overlay layer (normalize/facet.ts first)
  if (isObj(node.encoding) && (node.encoding.row !== undefined || node.encoding.column !== undefined || node.encoding.facet !== undefined)) {
    const { row, column, facet, ...rest } = node.encoding
    const { width, height, params, projection, mark, name, ...outerRest } = node
    const inner = normalizePathOverlays({ ...(width !== undefined ? { width } : {}), ...(height !== undefined ? { height } : {}), ...(params ? { params } : {}), ...(projection !== undefined ? { projection } : {}), ...(name !== undefined ? { name } : {}), mark, encoding: rest }, config, stackOf, inherited)
    if (inner === undefined || (isObj(inner) && inner.layer === undefined)) return node
    const { encoding: _e, ...facetOuter } = outerRest
    void _e
    return { ...facetOuter, facet: facet !== undefined ? facet : { ...(row !== undefined ? { row } : {}), ...(column !== undefined ? { column } : {}) }, spec: inner }
  }

  const { params, projection, mark, name, encoding: own, ...outer } = node
  const markDef: Obj = isObj(mark) ? mark : { type: mark }
  if (!OVERLAY_MARKS.has(markDef.type)) return node
  const encoding: Obj = { ...inherited, ...(isObj(own) ? own : {}) }
  const markConfig: Obj = isObj(config[markDef.type]) ? config[markDef.type] : {}
  const pointOverlay = getPointOverlay(markDef, markConfig, encoding)
  const lineOverlay = markDef.type === 'area' ? getLineOverlay(markDef, markConfig) : undefined
  if (!pointOverlay && !lineOverlay) return node

  const opacitySet = (k: string): boolean => (markDef[k] ?? markConfig[k] ?? (isObj(config.mark) ? config.mark[k] : undefined)) !== undefined
  const layer: Obj[] = [
    {
      ...(name !== undefined ? { name } : {}),
      ...(params ? { params } : {}),
      mark: dropLineAndPoint({
        ...(markDef.type === 'area' && !opacitySet('opacity') && !opacitySet('fillOpacity') ? { opacity: DEFAULT_REDUCED_OPACITY } : {}),
        ...markDef,
      }),
      encoding: omit(own === undefined ? {} : (own as Obj), ['shape']),
    },
  ]
  // a stacked measure stacks the overlays alike
  const stackProps = stackOf({ ...node, encoding })
  let overlayEncoding: Obj = encoding
  if (stackProps) {
    overlayEncoding = {
      ...encoding,
      [stackProps.fieldChannel]: { ...(encoding[stackProps.fieldChannel] as Obj), ...(stackProps.offset ? { stack: stackProps.offset } : {}) },
    }
  }
  // (overlays must not be ranged: x2 / y2 would make them rules)
  overlayEncoding = omit(overlayEncoding, ['y2', 'x2'])
  // the overlays carry what the parent layer shares only through their own encoding: drop what the layer would inherit twice
  const ownOverlay = (e: Obj): Obj => omit(e, Object.keys(inherited).filter((k) => deepEq(inherited[k], e[k])))
  if (lineOverlay) {
    layer.push({
      ...(projection !== undefined ? { projection } : {}),
      mark: { type: 'line', ...pick(markDef, ['clip', 'interpolate', 'tension', 'tooltip']), ...lineOverlay },
      encoding: ownOverlay(overlayEncoding),
    })
  }
  if (pointOverlay) {
    layer.push({
      ...(projection !== undefined ? { projection } : {}),
      mark: { type: 'point', opacity: 1, filled: true, ...pick(markDef, ['clip', 'tooltip']), ...pointOverlay },
      encoding: ownOverlay(overlayEncoding),
    })
  }
  return { ...outer, layer }
}

const deepEq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
