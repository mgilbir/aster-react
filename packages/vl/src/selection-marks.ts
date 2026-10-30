/**
 * What a unit's selections add around its marks and to its data: the store datasets, the brush of an interval selection (a filled
 * rectangle behind the marks, an outline in front), and the voronoi cells a nearest selection picks the closest mark through.
 */
import { dateTimeToExpr, dateTimeToTimestamp, isDateTime } from './predicate.js'
import {
  BRUSH, SELECTION_ID, STORE, VORONOI, bindsScales, canonicalJson, escapeFieldPath, stringValue, unitNameExpr,
  type Obj, type SelectedField, type Selection, type SelUnit,
} from './selection-model.js'

type Selections = Record<string, Selection>

/**
 * A stored field as the tuples' `fields` entry describes it: its storage, the field as an access path, the channel it was chosen on.
 * (The entry is a value of the signal and of the store, which the view API hands out: its keys come in this order.)
 */
export function assembleProjection(f: SelectedField): Obj {
  const field = escapeFieldPath(f.field)
  if (f.channel === undefined) return { type: f.storage, field }
  return { field, channel: f.channel, type: f.storage, ...(f.geoChannel !== undefined ? { geoChannel: f.geoChannel } : {}) }
}

/**
 * An initial value as the compiled spec writes it: an expression of its text (`wrap` closes each leaf over it, to scale it for
 * instance) or, with `asExpr` off, the values themselves with a date as its timestamp.
 */
export function assembleInit(init: unknown, asExpr = true, wrap: (s: string | number) => string | number = (x) => x): unknown {
  if (Array.isArray(init)) {
    const items = init.map((v) => assembleInit(v, asExpr, wrap))
    return asExpr ? `[${items.join(', ')}]` : items
  }
  if (isDateTime(init)) return asExpr ? wrap(dateTimeToExpr(init)) : wrap(dateTimeToTimestamp(init))
  return asExpr ? wrap(canonicalJson(init) as string) : init
}

// --- store datasets ------------------------------------------------------------------------------------------------------------

/** The store dataset of each selection of the unit that the spec does not already have, with its initial tuples. */
export function assembleUnitSelectionData(unit: SelUnit, selections: Selections, existing: ReadonlySet<string>): Obj[] {
  const out: Obj[] = []
  const have = new Set(existing)
  for (const sel of Object.values(selections)) {
    const store: Obj = { name: sel.name + STORE }
    if (sel.fields.byRowId) store.transform = [{ type: 'collect', sort: { field: SELECTION_ID } }]
    if (sel.init) {
      const unitName = unitNameExpr(unit, false)
      const fields = sel.fields.list.map(assembleProjection)
      store.values = sel.fields.byRowId
        ? sel.init.map((row) => ({ unit: unitName, [SELECTION_ID]: (assembleInit(row, false) as unknown[])[0] }))
        : sel.init.map((row) => ({ unit: unitName, fields, values: assembleInit(row, false) }))
    }
    const name = store.name as string
    if (have.has(name)) continue
    have.add(name)
    out.push(store)
  }
  return out
}

// --- marks ---------------------------------------------------------------------------------------------------------------------

/** The unit's marks with the selections' brushes around them and voronoi cells after the unit's first mark. */
export function assembleUnitSelectionMarks(unit: SelUnit, selections: Selections, marks: Obj[]): Obj[] {
  let out = marks
  for (const sel of Object.values(selections)) {
    if (sel.type === 'interval') out = withBrush(unit, sel, out)
    else if (sel.nearest) out = withVoronoi(unit, sel, out)
  }
  return out
}

/**
 * The brush of an interval selection: the rectangle between the two ends of each axis. Two marks draw it, the fill behind the unit's
 * marks and the outline in front of them, so that neither interferes with the marks and the region can still be grabbed to drag it.
 * A selection whose scales are bound has no brush, nor has one with no x or y.
 */
function withBrush(unit: SelUnit, sel: Selection, marks: Obj[]): Obj[] {
  const { x, y } = sel.fields.byChannel
  if (bindsScales(sel) || (!x && !y)) return marks
  const xv = x?.signals.visual
  const yv = y?.signals.visual

  // an axis the selection is not over spans the view
  const update: Record<string, unknown> = {
    x: x ? { signal: `${xv}[0]` } : { value: 0 },
    y: y ? { signal: `${yv}[0]` } : { value: 0 },
    x2: x ? { signal: `${xv}[1]` } : { field: { group: 'width' } },
    y2: y ? { signal: `${yv}[1]` } : { field: { group: 'height' } },
  }
  // with the global resolve the store holds a single interval: a view other than the one that owns it hides its brush
  if (sel.resolve === 'global') {
    const store = `data(${stringValue(sel.name + STORE)})`
    for (const key of Object.keys(update)) {
      update[key] = [{ test: `${store}.length && ${store}[0].unit === ${unitNameExpr(unit)}`, ...(update[key] as Obj) }, { value: 0 }]
    }
  }

  const { fill, fillOpacity, cursor, ...outline } = sel.mark as Obj
  // an empty brush has no outline
  const nonEmpty = [x && `${xv}[0] !== ${xv}[1]`, y && `${yv}[0] !== ${yv}[1]`].filter((t) => t).join(' && ')
  const outlined: Obj = {}
  for (const [prop, value] of Object.entries(outline)) outlined[prop] = [{ test: nonEmpty, value }, { value: null }]

  // the cursor says "move" when the brush can be dragged
  const grab = cursor ?? (sel.translate ? 'move' : null)
  return [
    {
      name: `${sel.name + BRUSH}_bg`,
      type: 'rect',
      clip: true,
      encode: { enter: { fill: { value: fill }, fillOpacity: { value: fillOpacity } }, update },
    },
    ...marks,
    {
      name: sel.name + BRUSH,
      type: 'rect',
      clip: true,
      encode: { enter: { ...(grab ? { cursor: { value: grab } } : {}), fill: { value: 'transparent' } }, update: { ...update, ...outlined } },
    },
  ]
}

const PATH_MARKS = new Set(['line', 'area', 'trail'])

/**
 * The voronoi cells over the unit's marks' positions, which a nearest selection listens on: the pointer picks the mark whose cell it is
 * in. A path mark has no cells, and a unit has one set of them however many selections are nearest.
 */
function withVoronoi(unit: SelUnit, sel: Selection, marks: Obj[]): Obj[] {
  if (PATH_MARKS.has(unit.mark)) return marks
  const { x, y } = sel.fields.byChannel

  const cells: Obj = {
    name: unit.getName(VORONOI),
    type: 'path',
    interactive: true,
    aria: false,
    from: { data: unit.getName('marks') },
    encode: {
      update: {
        fill: { value: 'transparent' },
        strokeWidth: { value: 0.35 },
        stroke: { value: 'transparent' },
        isVoronoi: { value: true },
        ...unit.voronoiTooltip(),
      },
    },
    transform: [{
      type: 'voronoi',
      x: { expr: x || !y ? 'datum.datum.x || 0' : '0' },
      y: { expr: y || !x ? 'datum.datum.y || 0' : '0' },
      size: [{ signal: unit.sizeSignal('width') }, { signal: unit.sizeSignal('height') }],
    }],
  }

  // (a view inside a facet names its marks `child_marks` only once the facet has embedded it: until then they are `marks`)
  const named = marks.some((m) => m.name === unit.firstMarkName)
  let after = 0
  let present = false
  marks.forEach((m, i) => {
    const name = (m.name as string | undefined) ?? ''
    if (name === unit.firstMarkName || (!named && name === 'marks')) after = i
    else if (name.includes(VORONOI)) present = true
  })
  if (present) return marks
  marks.splice(after + 1, 0, cells)
  return marks
}
