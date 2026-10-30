/**
 * The signals a unit's selections add to the compiled Vega, and the ones the spec carries at its top.
 *
 * Every selection is wired by the same sequence of steps, in a fixed order that the compiled spec shows:
 *
 *   1. its source of tuples: a point selection's event handler (or an animation's clock), an interval selection's brushes;
 *   2. the signal that names the fields its tuples hold;
 *   3. the toggle that decides whether a gesture adds to the selection or replaces it;
 *   4. what feeds the tuples instead of the pointer (input widgets, a legend), and what drives the brush instead (bound scales);
 *   5. what clears it, and what pans and zooms its brush;
 *   6. the signal that writes the tuple into the store.
 *
 * Each step works on the signal objects the earlier ones made (`Wire`), instead of finding them again by name.
 */
import { parseEventSelectorString, type StreamDef } from './event-selector.js'
import { animationSignals, animationTopLevelSignals, animationTupleSignal } from './animation.js'
import { assembleInit, assembleProjection } from './selection-marks.js'
import {
  BRUSH, CENTER, GEO_INIT_TICK, INIT, MODIFY, RESOLVE_FN, SCALE_TRIGGER, SELECTION_ID, STORE, TOGGLE, TRANSLATE_ANCHOR, TRANSLATE_DELTA, TUPLE,
  TUPLE_FIELDS, VORONOI_DATUM, ZOOM_ANCHOR, ZOOM_DELTA, bindsInputs, bindsLegend, bindsScales, deepCopy, escapeFieldPath, hasClear, hasContinuousDomain,
  isLegendStream, isTimerSelection, stringValue, togglesMembers, unitNameExpr, varName,
  type Obj, type SelectedField, type Selection, type SelUnit,
} from './selection-model.js'

type Signal = Obj
type Selections = Record<string, Selection>

/** The signals of one interval-selection channel. */
interface Brush {
  field: SelectedField
  /** the brush in pixels (absent when bound scales drive the selection) */
  visual?: Signal
  /** the brush in data values (absent on a map) */
  data?: Signal
}

/** What one selection has wired so far. */
interface Wire {
  /** the signals of the selection, in order */
  signals: Signal[]
  /** the signals to place before everything else the unit has (the one placed last comes first) */
  early: Signal[]
  tuple: Signal
  toggle?: Signal
  brushes: Brush[]
}

const onList = (s: Signal): Obj[] => s.on as Obj[]

// --- unit signals --------------------------------------------------------------------------------------------------------------

/** The signals of the unit's selections, in the order they are declared in. */
export function assembleUnitSelectionSignals(unit: SelUnit, selections: Selections): Signal[] {
  const front: Signal[] = []
  const rest: Signal[] = []
  const declared = (name: string): boolean => front.some((s) => s.name === name) || rest.some((s) => s.name === name)
  for (const sel of Object.values(selections)) {
    const wire = sel.type === 'point' ? wirePoint(unit, sel, selections) : wireInterval(unit, sel, declared)
    for (const s of wire.early) front.unshift(s)
    rest.push(...finishWire(unit, sel, wire, declared))
  }
  return dropEmptyHandlers([...front, ...rest])
}

function finishWire(unit: SelUnit, sel: Selection, wire: Wire, declared: (name: string) => boolean): Signal[] {
  const { signals } = wire
  const tuple = sel.name + TUPLE
  let writes = `${tuple}, ${sel.resolve === 'global' ? 'true' : `{unit: ${unitNameExpr(unit)}}`}`

  const fieldsName = sel.name + TUPLE_FIELDS
  if (!sel.fields.byRowId && !declared(fieldsName) && !signals.some((s) => s.name === fieldsName)) {
    signals.push({ name: fieldsName, value: sel.fields.list.map(assembleProjection) })
  }
  if (togglesMembers(sel)) {
    wire.toggle = { name: sel.name + TOGGLE, value: false, on: [{ events: sel.events, update: sel.toggle }] }
    signals.push(wire.toggle)
    const flag = sel.name + TOGGLE
    writes = `${flag} ? null : ${tuple}, ${sel.resolve === 'global' ? `${flag} ? null : true, ` : `${flag} ? null : {unit: ${unitNameExpr(unit)}}, `}${flag} ? ${tuple} : null`
  }
  if (bindsInputs(sel)) fromInputs(sel, wire)
  if (bindsScales(sel)) pushBoundScalesOut(sel, wire)
  if (bindsLegend(sel)) fromLegend(sel, wire)
  if (hasClear(sel)) wireClear(sel, wire)
  if (sel.type === 'interval' && sel.translate) wireTranslate(unit, sel, wire)
  if (sel.type === 'interval' && sel.zoom) wireZoom(unit, sel, wire)
  signals.push({ name: sel.name + MODIFY, on: [{ events: { signal: tuple }, update: `modify(${stringValue(sel.name + STORE)}, ${writes})` }] })
  return signals
}

// --- the source of tuples: a point selection -----------------------------------------------------------------------------------

function wirePoint(unit: SelUnit, sel: Selection, all: Selections): Wire {
  const tupleName = sel.name + TUPLE
  if (isTimerSelection(sel)) {
    const signals = [...animationSignals(sel.name, unit.scaleName('time')), animationTupleSignal(sel.name, unitNameExpr(unit))] as Signal[]
    return { signals, early: [], tuple: signals[signals.length - 1]!, brushes: [] }
  }

  // A datum selects when it is there, it is not the group of a facet cell (that would pollute the state of faceted views), it is not
  // a legend, and no brush of the unit is being dragged. The handler always runs, so that a selection that is constantly null can be
  // toggled.
  const brushes = Object.values(all).filter((s) => s.type === 'interval').map((s) => `indexof(item().mark.name, '${s.name + BRUSH}') < 0`)
  const guard = ['datum', "item().mark.marktype !== 'group'", "indexof(item().mark.role, 'legend') < 0", ...brushes].join(' && ')

  const fieldsName = sel.name + TUPLE_FIELDS
  const tuple = `unit: ${unitNameExpr(unit)}, ` + (sel.fields.byRowId
    ? `${SELECTION_ID}: ${VORONOI_DATUM}[${stringValue(SELECTION_ID)}]`
    : `fields: ${fieldsName}, values: [${sel.fields.list.map((f) => storedValue(unit, f)).join(', ')}]`)

  const signal: Signal = { name: tupleName, on: sel.events ? [{ events: sel.events, update: `${guard} ? {${tuple}} : null`, force: true }] : [] }
  return { signals: [signal], early: [], tuple: signal, brushes: [] }
}

/** The expression a tuple reads one field's value with: a binned field holds the bin's two ends. */
function storedValue(unit: SelUnit, f: SelectedField): string {
  const def = f.channel === undefined ? undefined : unit.fieldDef(f.channel)
  const read = (key: string): string => `${VORONOI_DATUM}[${stringValue(key)}]`
  return def?.bin ? `[${read(unit.vgField(f.channel!))}, ${read(unit.vgField(f.channel!, { binSuffix: 'end' }))}]` : read(f.field)
}

// --- the source of tuples: an interval selection -------------------------------------------------------------------------------

function wireInterval(unit: SelUnit, sel: Selection, declared: (name: string) => boolean): Wire {
  const init = sel.init ? sel.init[0]! : null
  const channels = Object.values(sel.fields.byChannel).filter((f) => f.channel === 'x' || f.channel === 'y')
  const signals: Signal[] = []
  const brushes: Brush[] = channels.map((field) => {
    const brush = brushOf(unit, sel, field, init?.[field.slot])
    signals.push(...[brush.visual, brush.data].filter((s): s is Signal => s !== undefined))
    return brush
  })
  const tupleName = sel.name + TUPLE

  if (unit.hasProjection) {
    const { tuple, early } = coveredMarksTuple(unit, sel, channels, init, declared)
    signals.push(tuple)
    return { signals, early, tuple, brushes }
  }

  // A scale that moves for another reason (a filter that touches it) must not redraw the brush it is the source of: the trigger passes
  // only changes that the brush does not already say.
  if (!bindsScales(sel) && channels.length) {
    const trigger = sel.name + SCALE_TRIGGER
    const settled = channels.map((f) => {
      const { data, visual } = f.signals
      const scale = stringValue(unit.scaleName(f.channel!))
      const num = hasContinuousDomain(unit.scaleType(f.channel!)) ? '+' : ''
      const inverted = `${num}invert(${scale}, ${visual})`
      return `(!isArray(${data}) || (${inverted}[0] === ${num}${data}[0] && ${inverted}[1] === ${num}${data}[1]))`
    })
    signals.push({
      name: trigger,
      value: {},
      on: [{ events: channels.map((f) => ({ scale: unit.scaleName(f.channel!) })), update: `${settled.join(' && ')} ? ${trigger} : {}` }],
    })
  }

  // The interval enters the store only when every extent is valid. Extents are null when their pixel ends are equal (an interval over
  // an ordinal domain would still invert to a datum), and the handler waits on all of them at once so it runs once per change.
  const extents = channels.map((f) => f.signals.data)
  const head = `unit: ${unitNameExpr(unit)}, fields: ${sel.name + TUPLE_FIELDS}, values`
  const tuple: Signal = {
    name: tupleName,
    ...(init ? { init: `{${head}: ${assembleInit(init)}}` } : {}),
    ...(extents.length
      ? { on: [{ events: [{ signal: extents.join(' || ') }], update: `${extents.join(' && ')} ? {${head}: [${extents}]} : null` }] }
      : {}),
  }
  signals.push(tuple)
  return { signals, early: [], tuple, brushes }
}

/** The brush of one channel: in pixels, and in the data values the scale inverts them to. */
function brushOf(unit: SelUnit, sel: Selection, field: SelectedField, init: unknown): Brush {
  const channel = field.channel!
  const size = unit.sizeSignal(channel === 'x' ? 'width' : 'height')
  const pointer = `${channel}(unit)`
  const visualName = field.signals.visual!
  // a gesture starts a brush at the pointer and drags its end, kept inside the view
  const gestures: Obj[] = (sel.events ?? []).flatMap((e) => [
    { events: (e.between as StreamDef[])[0], update: `[${pointer}, ${pointer}]` },
    { events: e, update: `[${visualName}[0], clamp(${pointer}, 0, ${size})]` },
  ])

  if (unit.hasProjection) {
    // on a map the brush starts from the projected initial value
    const column = channel === 'x' ? 0 : 1
    const start = sel.name + INIT
    return { field, visual: { name: visualName, ...(init ? { init: `[${start}[0][${column}], ${start}[1][${column}]]` } : { value: [] }), on: gestures } }
  }

  const dataName = field.signals.data!
  const scaleName = stringValue(unit.scaleName(channel))
  const scaled = (expr: string | number): string => `scale(${scaleName}, ${expr})`
  if (bindsScales(sel)) return { field, data: { name: dataName, on: [] } }

  // a scale that moves redraws the brush where it is continuous, and clears it where it is not (a band or point scale cannot move)
  gestures.push({
    events: { signal: sel.name + SCALE_TRIGGER },
    update: hasContinuousDomain(unit.scaleType(channel)) ? `[${scaled(`${dataName}[0]`)}, ${scaled(`${dataName}[1]`)}]` : '[0, 0]',
  })
  return {
    field,
    visual: { name: visualName, ...(init ? { init: assembleInit(init, true, scaled) } : { value: [] }), on: gestures },
    data: {
      name: dataName,
      // (an initial value cannot be `value`: it may be a date written as a date expression)
      ...(init ? { init: assembleInit(init) } : {}),
      on: [{ events: { signal: visualName }, update: `${visualName}[0] === ${visualName}[1] ? null : invert(${scaleName}, ${visualName})` }],
    },
  }
}

/** On a map the tuples are the marks the brush covers; the brush starts from the center of the view when an axis has no initial value. */
function coveredMarksTuple(unit: SelUnit, sel: Selection, channels: SelectedField[], init: unknown[] | null, declared: (name: string) => boolean): { tuple: Signal; early: Signal[] } {
  const projection = stringValue(unit.projectionName())
  const center = unit.projectionName() + CENTER
  const { x, y } = sel.fields.byChannel
  const startX = (x ? init?.[x.slot] : `${center}[0]`) as unknown[] | string
  const startY = (y ? init?.[y.slot] : `${center}[1]`) as unknown[] | string
  const visualX = x?.signals.visual
  const visualY = y?.signals.visual
  const box =
    `[[${visualX ? `${visualX}[0]` : '0'}, ${visualY ? `${visualY}[0]` : '0'}],` +
    `[${visualX ? `${visualX}[1]` : unit.sizeSignal('width')}, ${visualY ? `${visualY}[1]` : unit.sizeSignal('height')}]]`

  const early: Signal[] = []
  if (init) {
    const corner = (end: 0 | 1): string => `scale(${projection}, [${x ? (startX as unknown[])[end] : startX}, ${y ? (startY as unknown[])[end] : startY}])`
    early.push({ name: sel.name + INIT, init: `[${corner(0)}, ${corner(1)}]` })
    // (a one-dimensional brush takes the other coordinate from the center of the view)
    if ((!x || !y) && !declared(center)) {
      early.push({ name: center, update: `invert(${projection}, [${unit.sizeSignal('width')}/2, ${unit.sizeSignal('height')}/2])` })
    }
  }

  const covered = `vlSelectionTuples(intersect(${box}, {markname: ${stringValue(unit.getName('marks'))}}, unit.mark), {unit: ${unitNameExpr(unit)}})`
  const brushes = channels.map((f) => f.signals.visual)
  return {
    early,
    tuple: {
      name: sel.name + TUPLE,
      on: [{ events: [...(brushes.length ? [{ signal: brushes.join(' || ') }] : []), ...(init ? [{ signal: GEO_INIT_TICK }] : [])], update: covered }],
    },
  }
}

// --- what feeds a selection instead of the pointer -----------------------------------------------------------------------------

/** Input widgets: the tuple is the widgets' values, once every one has one. */
function fromInputs(sel: Selection, wire: Wire): void {
  const names = sel.fields.list.map((f) => varName(`${sel.name}_${f.field}`))
  if (names.length) {
    wire.tuple.update = `${names.map((n) => `${n} !== null`).join(' && ')} ? {fields: ${sel.name + TUPLE_FIELDS}, values: [${names.join(', ')}]} : null`
  }
  delete wire.tuple.value
  delete wire.tuple.on
}

/** An interactive legend: the tuple is the legend entry clicked, and a legend click toggles like a gesture does. */
function fromLegend(sel: Selection, wire: Wire): void {
  const names = sel.fields.list.filter((f) => f.legendBound).map((f) => varName(`${sel.name}_${varName(f.field)}_legend`))
  const update = `${names.map((n) => `${n} !== null`).join(' && ')} ? {fields: ${sel.name + TUPLE_FIELDS}, values: [${names.join(', ')}]} : null`
  if (sel.events && names.length > 0) {
    onList(wire.tuple).push({ events: names.map((signal) => ({ signal })), update })
  } else if (names.length > 0) {
    wire.tuple.update = update
    delete wire.tuple.value
    delete wire.tuple.on
  }

  if (wire.toggle) {
    const handlers = onList(wire.toggle)
    const legend = isLegendStream(sel.bind) && (sel.bind as Obj).legend
    if (!sel.events) handlers[0]!.events = legend
    else handlers.push({ ...handlers[0], events: legend })
  }
}

/** In a view inside a composition the data signals of bound scales belong to the composition: the unit's push to them. */
function pushBoundScalesOut(sel: Selection, wire: Wire): void {
  if (!sel.nested) return
  for (const field of sel.scales ?? []) {
    const data = wire.brushes.find((b) => b.field === field)?.data
    if (!data) continue
    data.push = 'outer'
    delete data.value
    delete data.update
  }
}

// --- what clears a selection ---------------------------------------------------------------------------------------------------

/** The clear events reset only the signal that holds each part of the selection, so that the dataflow runs as little as possible. */
function wireClear(sel: Selection, wire: Wire): void {
  const reset = (signal: Signal | undefined, update: string): void => {
    if (signal?.on) onList(signal).push({ events: sel.clear, update })
  }
  if (sel.type === 'interval') {
    for (const field of sel.fields.list) {
      const brush = wire.brushes.find((b) => b.field === field)
      if (brush?.visual) reset(brush.visual, '[0, 0]')
      else reset(brush?.data, 'null')
    }
    return
  }
  reset(wire.tuple, 'null')
  if (togglesMembers(sel)) reset(wire.toggle, 'false')
}

// --- what pans and zooms the brush ---------------------------------------------------------------------------------------------

/** The Vega function that pans or zooms a domain of this scale type, with the scale's parameter. */
function panZoomCall(unit: SelUnit, kind: 'pan' | 'zoom', channel: string, boundScales: boolean): { fn: string; arg: string } {
  const type = boundScales ? unit.scaleType(channel) : undefined
  const fn = `${kind}${type === 'log' ? 'Log' : type === 'symlog' ? 'Symlog' : type === 'pow' ? 'Pow' : 'Linear'}`
  const arg = type === 'pow' ? `, ${unit.scaleProp(channel, 'exponent') ?? 1}` : type === 'symlog' ? `, ${unit.scaleProp(channel, 'constant') ?? 1}` : ''
  return { fn, arg }
}

/** The signal of a channel the pan and zoom edit: the brush in pixels, or the extent in data values when scales are bound. */
function editedSignal(sel: Selection, wire: Wire, field: SelectedField): Signal {
  const brush = wire.brushes.find((b) => b.field === field)!
  return (bindsScales(sel) ? brush.data : brush.visual)!
}

const domainOf = (unit: SelUnit, channel: string): string => `domain(${stringValue(unit.scaleName(channel))})`

function wireTranslate(unit: SelUnit, sel: Selection, wire: Wire): void {
  const bound = bindsScales(sel)
  const anchor = sel.name + TRANSLATE_ANCHOR
  const delta = sel.name + TRANSLATE_DELTA
  const { x, y } = sel.fields.byChannel
  let events = parseEventSelectorString(sel.translate as string, 'scope')
  // an unbound brush is dragged by grabbing it
  if (!bound) events = events.map((e) => ((e.between![0]!.markname = sel.name + BRUSH), e))

  const extent = (f: SelectedField | undefined, channel: 'x' | 'y'): string =>
    f === undefined ? '' : `, extent_${channel}: ${bound ? domainOf(unit, channel) : `slice(${f.signals.visual})`}`
  wire.signals.push(
    { name: anchor, value: {}, on: [{ events: events.map((e) => e.between![0]), update: `{x: x(unit), y: y(unit)${extent(x, 'x')}${extent(y, 'y')}}` }] },
    { name: delta, value: {}, on: [{ events, update: `{x: ${anchor}.x - x(unit), y: ${anchor}.y - y(unit)}` }] },
  )

  const follow = (f: SelectedField | undefined, channel: 'x' | 'y'): void => {
    if (f === undefined) return
    const size = unit.sizeSignal(channel === 'x' ? 'width' : 'height')
    const reversed = unit.scaleReverse(channel)
    // a bound scale moves against the drag, unless it runs backwards
    const sign = bound && (channel === 'x') !== reversed ? '-' : ''
    const from = `${anchor}.extent_${channel}`
    const { fn, arg } = panZoomCall(unit, 'pan', channel, bound)
    const moved = `${fn}(${from}, ${sign}${delta}.${channel} / ${bound ? size : `span(${from})`}${arg})`
    onList(editedSignal(sel, wire, f)).push({ events: { signal: delta }, update: bound ? moved : `clampRange(${moved}, 0, ${size})` })
  }
  follow(x, 'x')
  follow(y, 'y')
}

function wireZoom(unit: SelUnit, sel: Selection, wire: Wire): void {
  const bound = bindsScales(sel)
  const delta = sel.name + ZOOM_DELTA
  const { x, y } = sel.fields.byChannel
  let events = parseEventSelectorString(sel.zoom as string, 'scope')
  if (!bound) events = events.map((e) => ((e.markname = sel.name + BRUSH), e))

  const under = (channel: 'x' | 'y'): string => `${channel}: invert(${stringValue(unit.scaleName(channel))}, ${channel}(unit))`
  wire.signals.push(
    { name: sel.name + ZOOM_ANCHOR, on: [{ events, update: bound ? `{${under('x')}, ${under('y')}}` : '{x: x(unit), y: y(unit)}' }] },
    { name: delta, on: [{ events, force: true, update: 'pow(1.001, event.deltaY * pow(16, event.deltaMode))' }] },
  )

  const follow = (f: SelectedField | undefined, channel: 'x' | 'y'): void => {
    if (f === undefined) return
    const size = unit.sizeSignal(channel === 'x' ? 'width' : 'height')
    const edited = editedSignal(sel, wire, f)
    const from = bound ? domainOf(unit, channel) : (edited.name as string)
    const { fn, arg } = panZoomCall(unit, 'zoom', channel, bound)
    const zoomed = `${fn}(${from}, ${sel.name}${ZOOM_ANCHOR}.${channel}, ${delta}${arg})`
    onList(edited).push({ events: { signal: delta }, update: bound ? zoomed : `clampRange(${zoomed}, 0, ${size})` })
  }
  follow(x, 'x')
  follow(y, 'y')
}

// --- the spec's top-level signals ----------------------------------------------------------------------------------------------

/**
 * The signals the spec carries at its top for these selections: the one named after each parameter, the ones its input widgets and
 * legends set, the clock of an animation, and the `unit` signal that tells which view the pointer is in.
 */
export function assembleTopLevelSelectionSignals(selections: Selections, signals: Signal[]): Signal[] {
  let top = signals
  const declared = (name: string): boolean => top.some((s) => s.name === name)
  for (const sel of Object.values(selections)) {
    if (!declared(sel.name)) {
      const resolve = sel.resolve === 'global' ? 'union' : sel.resolve
      top.push({ name: sel.name, update: `${RESOLVE_FN}(${stringValue(sel.name + STORE)}, ${stringValue(resolve)}${sel.type === 'point' ? ', true, true)' : ')'}` })
    }
    if (sel.type === 'point' && isTimerSelection(sel)) top = animationTopLevelSignals(top) as Signal[]
    if (sel.type === 'interval' && sel.geo && sel.init && !declared(GEO_INIT_TICK)) {
      top.unshift({ name: GEO_INIT_TICK, value: null, on: [{ events: 'timer{1}', update: `${GEO_INIT_TICK} === null ? {} : ${GEO_INIT_TICK}` }] })
    }
    if (bindsInputs(sel)) declareInputs(sel, top, declared)
    if (bindsScales(sel)) top = declareBoundScales(sel, top)
    if (bindsLegend(sel)) declareLegendSignals(sel, top, declared)
    if (hasClear(sel) && bindsInputs(sel)) {
      for (const field of sel.fields.list) {
        const input = top.find((s) => s.name === varName(`${sel.name}_${field.field}`))
        if (input) onList(input).push({ events: sel.clear, update: 'null' })
      }
    }
  }
  if (Object.keys(selections).length > 0 && !declared('unit')) {
    top.unshift({ name: 'unit', value: {}, on: [{ events: 'pointermove', update: 'isTuple(group()) ? group() : unit' }] })
  }
  return dropEmptyHandlers(top)
}

/** One signal per bound field, each bound to its widget: a widget set for the field's name, else its channel, else for all of them. */
function declareInputs(sel: Selection, top: Signal[], declared: (name: string) => boolean): void {
  const bind = sel.bind as Obj
  const init = sel.init?.[0] // only a single selection has an initial value
  const datum = sel.type === 'point' && sel.nearest ? VORONOI_DATUM : 'datum'
  sel.fields.list.forEach((f, i) => {
    const name = varName(`${sel.name}_${f.field}`)
    if (declared(name)) return
    top.unshift({
      name,
      ...(init ? { init: assembleInit(init[i]) } : { value: null }),
      on: sel.events ? [{ events: sel.events, update: `datum && item().mark.marktype !== 'group' ? ${datum}[${stringValue(f.field)}] : null` }] : [],
      bind: bind[f.field] ?? (f.channel !== undefined ? bind[f.channel] : undefined) ?? bind,
    })
  })
}

/**
 * In a view inside a composition, bound scales are driven from the composition: it carries the data signals the units push to, and the
 * selection's own signal is made of them (the store holds one tuple per unit, but the selection is the unit that moved last).
 */
function declareBoundScales(sel: Selection, top: Signal[]): Signal[] {
  const bound = (sel.scales ?? []).filter((f) => !top.some((s) => s.name === f.signals.data))
  if (!sel.nested || bound.length === 0) return top
  const named = top.find((s) => s.name === sel.name)
  if (!named) return top
  const entry = (f: SelectedField): string => `${stringValue(escapeFieldPath(f.field))}: ${f.signals.data}`
  const update = named.update as string
  if (update.includes(RESOLVE_FN)) {
    named.update = `{${bound.map(entry).join(', ')}}`
  } else {
    let text = update
    for (const f of bound) if (!text.includes(entry(f))) text = `${text.slice(0, -1)}, ${entry(f)}}`
    named.update = text
  }
  return top.concat(bound.map((f) => ({ name: f.signals.data as string })))
}

/** A bound legend clicks into one signal per field: the legend entry's value, kept until the next click lands on something else. */
function declareLegendSignals(sel: Selection, top: Signal[], declared: (name: string) => boolean): void {
  const stream = (sel.bind as { legend: { merge: StreamDef[] } }).legend
  for (const f of sel.fields.list) {
    if (!f.legendBound) continue
    const prefix = `${varName(f.field)}_legend`
    const name = `${sel.name}_${prefix}`
    if (declared(name)) continue
    // a legend is drawn as symbols, labels and entries, each a mark of its own to listen on
    const onMark = (suffix: string): StreamDef[] => stream.merge.map((s) => ({ ...deepCopy(s), markname: `${prefix}_${suffix}` }))
    top.unshift({
      name,
      ...(!sel.init ? { value: null } : {}),
      on: [
        // (an entry holds no value: the symbol's datum is reached through the scenegraph)
        { events: [...onMark('symbols'), ...onMark('labels'), ...onMark('entries')], update: 'isDefined(datum.value) ? datum.value : item().items[0].items[0].datum.value', force: true },
        { events: stream.merge, update: `!event.item || !datum ? null : ${name}`, force: true },
      ],
    })
  }
}

/** A facet's cells track which cell the pointer is in, for the names of their units. */
export function assembleFacetSignals(cellName: string, signals: Signal[]): Signal[] {
  signals.unshift({
    name: 'facet',
    value: {},
    on: [{ events: [{ source: 'scope', type: 'pointermove' }], update: `isTuple(facet) ? facet : group(${stringValue(cellName)}).datum` }],
  })
  return dropEmptyHandlers(signals)
}

/** A signal with no handler left carries no `on`. */
function dropEmptyHandlers(signals: Signal[]): Signal[] {
  for (const s of signals) if (s.on && !(s.on as unknown[]).length) delete s.on
  return signals
}
