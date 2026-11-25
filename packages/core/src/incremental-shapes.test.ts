/**
 * The incremental guarantee over the shapes whose reuse rests on what a node READS rather than on the rows it is drawn from
 * (audit T2): for every generated spec of each shape and every generated sequence of updates, delivered through every surface
 * (the session's auto-diff, `evaluateChart` with `dataChanges`, with `dataPulse`, with `changedDatasets`, and with no hint), the
 * scene, its SVG and its datasets equal a fresh `evaluateChart(compileChart(spec), input)` at every step.
 *
 * The shapes, and the failure kind each stands for:
 * - mark-from-mark: a text, a rule, a voronoi path or a `label` text drawn from another mark's items (`from: {data: <mark>}`), at the
 *   top level and inside a group. Its record of the items it was drawn from must not be the live array the source mark advances in
 *   place (C7).
 * - group-scoped reads: a leaf mark inside a facet cell reads another pipeline dataset by expression (`length(data('o'))`,
 *   `indata`, `data('o')[0]`). The dataset's array is advanced in place by a pulse (C26).
 * - fitted projections: a dataset with `geopoint`, a mark with a `geopoint` / `geoshape` transform, an encode calling `scale(p)` --
 *   each over rows of its own while the projection fits ANOTHER dataset that changes (C42).
 * - large signal arrays: a signal holding a dataset (`data('t')`) past what a structural key takes in, and a derived array signal
 *   past it, read by a text mark (C24, C114).
 *
 * Plus the invariant all content reuse rests on: an engine-written array whose content stamp did not move holds what it held
 * (content-stamp.ts). Every array the scene publishes (its items, its datasets) is checked after every step.
 *
 *   ASTER_SHAPES_SEEDS=60   seeds per shape (default 12)
 */
import { describe, expect, it } from 'vitest'
import { compileChart } from './compiler.js'
import { evaluateChart } from './evaluate.js'
import { createChartSession } from './session.js'
import { datasetsOfScene, renderSceneToSvg } from './index.js'
import { diffRows, type RowDiff } from './pulse.js'
import { stampKey } from './content-stamp.js'
import { datumText, ENCODE_LOG, encodeIdentOf, type EncodeLog } from './encode-handlers.js'
import './addon-transforms.js'
import './addon-geo.js'
import type { RuntimeInput, SceneRoot, VgSpec } from './types.js'

type Row = Record<string, unknown>
type Rnd = () => number
type Data = Record<string, Row[]>

function mulberry32(seed: number): Rnd {
  let a = seed | 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const pick = <T,>(r: Rnd, a: readonly T[]): T => a[Math.floor(r() * a.length)]!
const int = (r: Rnd, lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1))
const clone = <T,>(v: T): T => structuredClone(v)

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

interface Scenario {
  spec: VgSpec
  data: Data
  signals?: Record<string, unknown>
  /** more of the input, the same at every step (`limits`) */
  extra?: Partial<RuntimeInput>
  /** the datasets an update may change */
  mutable: readonly string[]
  /** makes a row of dataset `name` */
  row: (r: Rnd, name: string, i: number) => Row
  /**
   * The log of requests the host's store holds (encode-handlers.ts), the same at every step: made from `session`, the state the event
   * loop keeps for it. A fresh evaluation is given a session of its own.
   */
  log?: (session: object) => EncodeLog
}

const GROUPS = ['A', 'B', 'C', 'D']
const plainRow = (r: Rnd, _name: string, i: number): Row => ({ x: int(r, 0, 20), v: int(r, 0, 9), g: `${pick(r, GROUPS)}${i % 3}`, k: pick(r, ['a', 'b', 'c']) })
const rowsOf = (r: Rnd, n: number, name = 't', make = plainRow): Row[] => Array.from({ length: n }, (_, i) => make(r, name, i))

const PIPELINES: ReadonlyArray<ReadonlyArray<Record<string, unknown>>> = [
  [],
  [{ type: 'formula', expr: 'datum.x * 2', as: 'f' }],
  [{ type: 'filter', expr: 'datum.v > 2' }],
  [{ type: 'formula', expr: 'datum.v + 1', as: 'f' }, { type: 'filter', expr: 'datum.f > 3' }],
  [{ type: 'collect', sort: { field: 'x' } }],
]

/** A pipeline: none as often as all the others (a dataset with no transforms hands the host's pulse on as it is, in place). */
const pipeline = (r: Rnd): ReadonlyArray<Record<string, unknown>> => (r() < 0.5 ? [] : pick(r, PIPELINES.slice(1)))

const FRAME = { width: 200, height: 120, padding: 5, autosize: 'none' } as const

/** A dataset the host gives rows to: declared with inline `values` the host's replace, or with none (each takes another path in). */
const hostData = (r: Rnd, name: string, more: Record<string, unknown> = {}): Record<string, unknown> => ({ name, ...(r() < 0.5 ? { values: [] } : {}), ...more })

function markFromMark(r: Rnd): Scenario {
  const pipe = pipeline(r)
  const source = pick(r, [
    { type: 'symbol', name: 'pts', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'v' }, size: { value: 40 } } } },
    { type: 'rect', name: 'pts', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'x' }, width: { value: 6 }, y: { scale: 'y', field: 'v' }, y2: { scale: 'y', value: 0 } } } },
  ])
  const dependent = pick(r, [
    { type: 'text', from: { data: 'pts' }, encode: { update: { x: { field: 'x' }, y: { field: 'y' }, text: { signal: "datum.datum.g + '@' + datum.x" } } } },
    { type: 'rule', from: { data: 'pts' }, encode: { update: { x: { field: 'x' }, x2: { field: 'x' }, y: { field: 'y' }, y2: { value: 120 }, stroke: { signal: "datum.datum.k === 'a' ? 'red' : 'blue'" } } } },
    { type: 'path', from: { data: 'pts' }, encode: { update: { stroke: { value: '#ccc' } } }, transform: [{ type: 'voronoi', x: 'datum.x', y: 'datum.y', size: [{ signal: 'width' }, { signal: 'height' }] }] },
    { type: 'text', from: { data: 'pts' }, encode: { update: { text: { field: 'datum.g' }, fontSize: { value: 9 } } }, transform: [{ type: 'label', size: [{ signal: 'width' }, { signal: 'height' }], anchor: ['top', 'bottom'], offset: [1, 1] }] },
    // (the items read by name in an expression, `data('<mark>')`: C74)
    { type: 'text', encode: { update: { x: { value: 4 }, y: { value: 12 }, text: { signal: "join(pluck(pluck(data('pts'), 'datum'), 'g'), ',') + ':' + length(data('pts'))" } } } },
  ])
  const scales = [
    { name: 'x', type: 'linear', domain: [0, 20], range: 'width' },
    { name: 'y', type: 'linear', domain: [0, 10], range: 'height' },
  ]
  const marks = [source, dependent]
  // (inside a group: the same marks in one group item, which makes them instance marks of the group's scope)
  const nested = r() < 0.4
  return {
    spec: { ...FRAME, data: [hostData(r, 't', { transform: [...pipe] })], scales, marks: nested ? [{ type: 'group', encode: { update: { width: { signal: 'width' }, height: { signal: 'height' } } }, marks }] : marks } as unknown as VgSpec,
    data: { t: rowsOf(r, int(r, 1, 8)) },
    mutable: ['t'],
    row: plainRow,
  }
}

function groupScopedReads(r: Rnd): Scenario {
  const pipe = pick(r, PIPELINES.filter((p) => p.length > 0))
  const text = pick(r, [
    "datum.k + length(data('o'))",
    "datum.k + indata('o', 'k', datum.k)",
    "datum.k + (length(data('o')) ? data('o')[0].x : '-')",
  ])
  return {
    spec: {
      ...FRAME,
      data: [
        hostData(r, 't'),
        hostData(r, 'src2'),
        { name: 'o', source: 'src2', transform: [...pipe] },
      ],
      marks: [{
        type: 'group',
        from: { facet: { name: 'cell', data: 't', groupby: 'k' } },
        encode: { update: { width: { value: 50 }, height: { value: 30 } } },
        marks: [{ type: 'text', from: { data: 'cell' }, encode: { update: { text: { signal: text } } } }],
      }, {
        type: 'text', encode: { update: { y: { value: 100 }, text: { signal: "'top:' + length(data('o'))" } } },
      }],
    } as unknown as VgSpec,
    data: { t: rowsOf(r, int(r, 1, 5)), src2: rowsOf(r, int(r, 1, r() < 0.3 ? 600 : 6), 'src2') },
    mutable: r() < 0.7 ? ['src2'] : ['src2', 't'],
    row: plainRow,
  }
}

const feature = (x: number, y: number, w: number): Row => ({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[x, y], [x, y + w], [x + w, y + w], [x + w, y], [x, y]]] }, properties: { id: x } })
const geoRow = (r: Rnd, name: string): Row => (name === 'regions' ? feature(int(r, -60, 60), int(r, -40, 40), int(r, 2, 30)) : { lon: int(r, -60, 60), lat: int(r, -40, 40) })

function fittedProjection(r: Rnd): Scenario {
  const projections = [{ name: 'p', type: pick(r, ['mercator', 'equirectangular']), fit: { signal: "data('regions')" }, size: [{ signal: 'width' }, { signal: 'height' }] }]
  const sym = (enc: Record<string, unknown>, transform?: unknown[]): Record<string, unknown> => ({ type: 'symbol', from: { data: 'cities' }, encode: { update: enc }, ...(transform ? { transform } : {}) })
  const variant = int(r, 0, 3)
  const cities: Record<string, unknown> = hostData(r, 'cities')
  let marks: unknown[]
  if (variant === 0) {
    cities.transform = [{ type: 'geopoint', projection: 'p', fields: ['lon', 'lat'] }]
    marks = [sym({ x: { field: 'x' }, y: { field: 'y' } })]
  } else if (variant === 1) {
    marks = [sym({ x: { field: 'x' }, y: { field: 'y' } }, [{ type: 'geopoint', projection: 'p', fields: ['datum.lon', 'datum.lat'] }])]
  } else if (variant === 2) {
    marks = [sym({ x: { signal: "scale('p', [datum.lon, datum.lat])[0]" }, y: { signal: "scale('p', [datum.lon, datum.lat])[1]" } })]
  } else {
    marks = [{ type: 'shape', from: { data: 'cities' }, transform: [{ type: 'geoshape', projection: 'p' }] }]
  }
  // (the regions themselves are drawn too, or not: the projection is fitted either way)
  if (r() < 0.5) marks.unshift({ type: 'shape', from: { data: 'regions' }, transform: [{ type: 'geoshape', projection: 'p' }] })
  const shapeCities = variant === 3
  return {
    spec: { ...FRAME, projections, data: [hostData(r, 'regions'), cities], marks } as unknown as VgSpec,
    data: {
      regions: Array.from({ length: int(r, 1, 3) }, () => geoRow(r, 'regions')),
      cities: Array.from({ length: int(r, 1, 4) }, () => (shapeCities ? geoRow(r, 'regions') : geoRow(r, 'cities'))),
    },
    mutable: r() < 0.7 ? ['regions'] : ['regions', 'cities'],
    row: (rr, name) => geoRow(rr, name === 'cities' && shapeCities ? 'regions' : name),
  }
}

function largeSignal(r: Rnd): Scenario {
  const n = pick(r, [100, 170, 171, 300, 520])
  const pipe = pipeline(r)
  const derived = r() < 0.3
  const signals = derived
    ? [{ name: 's', update: `sequence(0, ${n} + length(data('t')))` }]
    : [{ name: 's', update: "data('t')" }]
  const text = derived ? "length(s) + ':' + s[length(s) - 1]" : "(length(s) ? s[length(s) - 1].v + '|' + s[0].x : '-') + ':' + length(s)"
  return {
    spec: {
      ...FRAME, signals,
      data: [hostData(r, 't', { transform: [...pipe] })],
      marks: [{ type: 'text', encode: { update: { text: { signal: text } } } }],
    } as unknown as VgSpec,
    data: { t: rowsOf(r, derived ? int(r, 1, 5) : n) },
    mutable: ['t'],
    row: plainRow,
  }
}

export const labelRow = (r: Rnd, _name: string, i: number): Row => ({ i, x: int(r, -40, 240), y: int(r, -30, 150), o: r() < 0.25 ? null : { label: pick(r, ['', 'a', 'long label', `L${i}`]) }, t: r() < 0.2 ? (r() < 0.5 ? null : undefined) : `t${i}` })

/** C110 (a failing step): an encode that throws for some rows (`datum.o.label` of a null `o`), with a mark after it. */
function recoveredErrors(r: Rnd): Scenario {
  return {
    spec: {
      ...FRAME,
      data: [hostData(r, 't', { transform: [...pipeline(r).filter((t) => t.type !== 'filter')] })],
      marks: [
        { type: 'text', name: 'labels', from: { data: 't' }, encode: { update: { x: { field: 'x' }, y: { field: 'y' }, text: { signal: 'datum.o.label' } } } },
        { type: 'symbol', from: { data: 't' }, encode: { update: { x: { field: 'x' }, y: { field: 'y' } } } },
      ],
    } as unknown as VgSpec,
    data: { t: rowsOf(r, int(r, 1, 6), 't', labelRow) },
    mutable: ['t'],
    row: labelRow,
  }
}

/** C116: marks whose bounds lay the view out (`autosize: pad`) -- text with missing labels or no `text` channel, a rect with a text channel, a stroked rule. */
function measuredMarks(r: Rnd): Scenario {
  const mark = pick(r, [
    { type: 'text', from: { data: 't' }, encode: { update: { x: { field: 'x' }, y: { field: 'y' }, text: { field: 't' } } } },
    { type: 'text', from: { data: 't' }, encode: { update: { x: { field: 'x' }, y: { field: 'y' } } } },
    { type: 'rect', from: { data: 't' }, encode: { update: { x: { field: 'x' }, y: { field: 'y' }, width: { value: 5 }, height: { value: 5 }, text: { field: 't' } } } },
    { type: 'rule', from: { data: 't' }, encode: { update: { x: { field: 'x' }, y: { field: 'y' }, strokeWidth: { value: 6 }, stroke: { value: 'red' } } } },
    { type: 'symbol', from: { data: 't' }, encode: { update: { x: { field: 'x' }, y: { field: 'y' }, size: { value: 400 }, stroke: { value: 'red' }, strokeWidth: { value: 5 } } } },
  ])
  return {
    spec: { width: 200, height: 100, padding: 5, ...(r() < 0.3 ? { title: 'T', autosize: 'none' } : {}), data: [hostData(r, 't')], marks: [mark] } as unknown as VgSpec,
    data: { t: rowsOf(r, int(r, 0, 5), 't', labelRow) },
    mutable: ['t'],
    row: labelRow,
  }
}

/** C625: pulses under `limits` (a pipeline that generates rows, metered). */
function underLimits(r: Rnd): Scenario {
  const pipe = pick(r, [
    [{ type: 'fold', fields: ['x', 'v'] }],
    [{ type: 'flatten', fields: ['arr'] }, { type: 'formula', as: 'w', expr: 'datum.arr * 2' }],
    [{ type: 'formula', as: 'f', expr: 'datum.x + 1' }, { type: 'filter', expr: 'datum.v > 3' }],
  ])
  const row = (rr: Rnd, name: string, i: number): Row => ({ ...plainRow(rr, name, i), arr: [int(rr, 0, 5), int(rr, 0, 5)] })
  return {
    spec: { ...FRAME, data: [hostData(r, 't', { transform: pipe })], marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { field: 'x' }, y: { field: 'v' } } } }] } as unknown as VgSpec,
    data: { t: rowsOf(r, int(r, 1, 6), 't', row) },
    extra: { limits: { maxRows: 10_000, maxGeneratedRows: 1_000_000, maxItems: 10_000 } },
    mutable: ['t'],
    row,
  }
}

/**
 * Marks whose items are not one per row in data order: a mark `key` joins the rows that share a key into one item (C120); an item
 * `zindex` paints it out of order (C28); colour objects are written as vega's code (C27). At the top level and inside a group, over
 * a pipeline, with the joined key colliding and coming apart as rows change.
 */
function keyedPaintOrder(r: Rnd): Scenario {
  const pipe = pipeline(r)
  const enc = (): Record<string, unknown> => ({
    x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'v' },
    ...(r() < 0.6 ? { zindex: pick(r, [{ field: 'v' }, { signal: '-datum.v % 3' }, { signal: "datum.k === 'a' ? 2 : 0" }]) } : {}),
    ...(r() < 0.5 ? { fill: { color: { h: { field: 'x', mult: 15 }, c: { value: 40 }, l: { field: 'v', mult: 8 } } } } : { fill: { value: '#4c78a8' } }),
  })
  const keyed = (type: string): Record<string, unknown> => ({
    type, from: { data: 't' }, ...(r() < 0.7 ? { key: pick(r, ['k', 'g', 'x']) } : {}), ...(r() < 0.3 ? { zindex: int(r, 0, 2) } : {}),
    encode: { update: { ...enc(), ...(type === 'rect' ? { width: { value: 9 }, height: { value: 7 } } : type === 'text' ? { text: { field: 'g' } } : { size: { value: 60 } }) } },
  })
  const marks = [keyed(pick(r, ['symbol', 'rect'])), keyed(pick(r, ['text', 'symbol']))]
  const scales = [{ name: 'x', type: 'linear', domain: [0, 20], range: 'width' }, { name: 'y', type: 'linear', domain: [0, 10], range: 'height' }]
  const nested = r() < 0.4
  return {
    spec: { ...FRAME, data: [hostData(r, 't', { transform: [...pipe] })], scales, marks: nested ? [{ type: 'group', encode: { update: { width: { signal: 'width' }, height: { signal: 'height' } } }, marks }] : marks } as unknown as VgSpec,
    data: { t: rowsOf(r, int(r, 1, 9)) },
    mutable: ['t'],
    row: plainRow,
  }
}


/** The items of the named leaf mark in a scene (its group's items), at any depth. */
function itemsOfMark(node: unknown, name: string): Array<Record<string, unknown>> | null {
  const n = node as { marktype?: string; name?: string; items?: unknown[] } | null
  if (n === null || typeof n !== 'object') return null
  if (n.marktype !== undefined && n.marktype !== 'group' && n.name === name) return (n.items ?? []) as Array<Record<string, unknown>>
  for (const c of n.items ?? []) {
    const f = itemsOfMark(c, name)
    if (f !== null) return f
  }
  return null
}

/**
 * A mark with `on` triggers, whose items the host's log holds property writes for (what the loop records when a trigger's `modify`
 * runs, C73): written onto the items the evaluation makes before the mark's sort and the marks drawn from it, a write to a channel
 * the mark's `update` owns taken back, the others kept for as long as the item has the datum it had when the write was made -- while
 * rows come, go, move and change.
 */
function markWrites(r: Rnd): Scenario {
  const pipe = pipeline(r)
  const sorted = r() < 0.4
  const pts = {
    type: 'symbol', name: 'pts', from: { data: 't' },
    on: [{ trigger: 'go', modify: 'item()', values: '{foo: 1}' }],
    ...(sorted ? { sort: { field: 'foo' } } : {}),
    encode: {
      enter: { fill: { value: '#4c78a8' }, ...(r() < 0.5 ? { opacity: { value: 0.8 } } : {}) },
      update: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'v' }, size: { value: 60 }, ...(r() < 0.4 ? { fill: { signal: "datum.k === 'a' ? 'tomato' : '#4c78a8'" } } : {}) },
    },
  }
  const dependent = pick(r, [
    { type: 'text', encode: { update: { x: { value: 4 }, y: { value: 12 }, text: { signal: "join(pluck(data('pts'), 'foo'), ',') + ':' + length(data('pts'))" } } } },
    { type: 'rule', from: { data: 'pts' }, encode: { update: { x: { field: 'x' }, x2: { field: 'x' }, y: { field: 'y' }, y2: { value: 120 }, stroke: { signal: "datum.fill === 'red' ? 'red' : 'blue'" } } } },
  ])
  const scales = [
    { name: 'x', type: 'linear', domain: [0, 20], range: 'width' },
    { name: 'y', type: 'linear', domain: [0, 10], range: 'height' },
  ]
  const nested = r() < 0.4
  const marks = [pts, dependent]
  const spec = { ...FRAME, signals: [{ name: 'go', value: 0 }], data: [hostData(r, 't', { transform: [...pipe] })], scales, marks: nested ? [{ type: 'group', encode: { update: { width: { signal: 'width' }, height: { signal: 'height' } } }, marks }] : marks } as unknown as VgSpec
  const data = { t: rowsOf(r, int(r, 2, 8)) }
  // (the items the first scene makes: the log names them as the loop does, by the idents the evaluation stamped, and the datums they hold)
  const probe = evaluateChart(compileChart(clone(spec)), { logger: quiet, data: clone(data) })
  const items = itemsOfMark(probe, 'pts') ?? []
  const writes: EncodeLog['writes'][number][] = []
  let seq = 0
  for (const item of items.slice(0, 4)) {
    const ident = encodeIdentOf(item)
    if (ident === undefined || r() < 0.3) continue
    seq++
    for (const [field, value] of [['fill', pick(r, ['red', 'gold'])], ['size', 500], ['foo', int(r, 0, 5)], ['bar', 'b']] as const) {
      if (r() < 0.6) writes.push({ ident, field, value, datum: datumText(item.datum), seq })
    }
  }
  return {
    spec, data, mutable: ['t'], row: plainRow,
    log: (session) => Object.freeze({ session, rev: 1, requests: Object.freeze([]), writes: Object.freeze(writes.slice()) }),
  }
}

export const SHAPES: ReadonlyArray<readonly [string, (r: Rnd) => Scenario]> = [
  ['keys, zindex and colour objects', keyedPaintOrder],
  ['mark triggers: writes onto items', markWrites],
  ['mark-from-mark', markFromMark],
  ['group-scoped reads', groupScopedReads],
  ['fitted projection', fittedProjection],
  ['large signal arrays', largeSignal],
  ['recovered encode errors', recoveredErrors],
  ['marks that lay the view out', measuredMarks],
  ['pulses under limits', underLimits],
]

// ---------------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------------

const OPS = ['edit', 'move', 'swap', 'append', 'insert', 'remove', 'truncate', 'replace', 'same'] as const
type Op = typeof OPS[number]
type Delivery = 'session' | 'dataChanges' | 'dataPulse' | 'changedDatasets' | 'none' | 'dataChanges+previousScene' | 'dataPulse+previousScene'
const DELIVERIES: readonly Delivery[] = ['session', 'dataChanges', 'dataPulse', 'changedDatasets', 'none', 'dataChanges+previousScene', 'dataPulse+previousScene']
/** Whether a delivery names the scene its hints are relative to (`previousScene`: checked by identity, not by reading the rows). */
const namesScene = (d: Delivery): boolean => d.endsWith('+previousScene')

function update(r: Rnd, sc: Scenario, data: Data, op: Op): Data {
  const name = pick(r, sc.mutable)
  const rows = data[name]!.slice()
  const at = rows.length ? int(r, 0, rows.length - 1) : 0
  switch (op) {
    case 'edit': if (rows.length) { const k = pick(r, Object.keys(rows[at]!)); const fresh = sc.row(r, name, at); rows[at] = { ...rows[at]!, [k]: fresh[k] } } break
    case 'move': if (rows.length) rows[at] = sc.row(r, name, at); break
    case 'swap': if (rows.length > 1) { const b = (at + 1) % rows.length; [rows[at], rows[b]] = [rows[b]!, rows[at]!] } break
    case 'append': rows.push(...Array.from({ length: int(r, 1, 3) }, (_, i) => sc.row(r, name, rows.length + i))); break
    case 'insert': rows.splice(at, 0, sc.row(r, name, at)); break
    case 'remove': if (rows.length) rows.splice(at, 1); break
    case 'truncate': rows.length = Math.max(0, rows.length - int(r, 1, 3)); break
    case 'replace': return { ...data, [name]: Array.from({ length: int(r, 1, 6) }, (_, i) => sc.row(r, name, i)) }
    case 'same': return data
  }
  return { ...data, [name]: rows }
}

function toDataPulse(d: RowDiff): NonNullable<RuntimeInput['dataPulse']>[string] {
  return {
    changed: d.changed,
    ...(d.from ? { from: d.from } : {}),
    ...(d.to ? { to: d.to } : {}),
    ...(d.addedRanges ? { added: d.addedRanges } : {}),
    ...(d.removedRanges ? { removed: d.removedRanges } : {}),
    ...(d.appendOnly ? { appendOnly: true, baseLength: d.baseLength } : {}),
  }
}

/** Truthful hints for the step from `a` to `b`, in the form `delivery` names (a form that cannot say it falls back to naming). */
function hints(how: Delivery, a: Data, b: Data): Partial<RuntimeInput> {
  const delivery = how.replace('+previousScene', '') as Delivery
  const touched = Object.keys(b).filter((n) => a[n] !== b[n])
  if (!touched.length || delivery === 'none' || delivery === 'session') return {}
  if (delivery === 'changedDatasets') return { changedDatasets: touched }
  const out: Partial<RuntimeInput> = {}
  const named: string[] = []
  for (const n of touched) {
    const d = diffRows(a[n]!, b[n]!)
    if (d === null) { named.push(n); continue }
    if (delivery === 'dataChanges') {
      if (d.sameLength) (out.dataChanges ??= {})[n] = d.changed
      else named.push(n)
    } else (out.dataPulse ??= {})[n] = toDataPulse(d)
  }
  if (named.length) out.changedDatasets = named
  return out
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

const SKIP = new Set(['runtime', 'compiled', '__scaleMap', '__gen', '__itemGen', '__domDesc', '__source', '__editGen', '__engineItems'])
function norm(v: unknown, depth = 0): unknown {
  if (depth > 40) return '[deep]'
  if (v === undefined || v === null || typeof v === 'string' || typeof v === 'boolean') return v
  if (typeof v === 'number') return Number.isNaN(v) ? '[NaN]' : Object.is(v, -0) ? '[-0]' : v
  if (typeof v === 'function') return '[fn]'
  if (v instanceof Date) return { $date: v.getTime() }
  if (v instanceof Map || v instanceof Set) return '[collection]'
  if (Array.isArray(v)) return v.map((x) => norm(x, depth + 1) ?? null)
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(v as object).sort()) {
    if (SKIP.has(k)) continue
    const n = norm((v as Record<string, unknown>)[k], depth + 1)
    if (n !== undefined) out[k] = n
  }
  return out
}
function firstDiff(a: unknown, b: unknown, path = '$'): string | null {
  if (Object.is(a, b)) return null
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return `${path}: fresh ${JSON.stringify(a)?.slice(0, 100)} incremental ${JSON.stringify(b)?.slice(0, 100)}`
  if (Array.isArray(a) !== Array.isArray(b)) return `${path}: array/object`
  if (Array.isArray(a) && Array.isArray(b) && a.length !== b.length) return `${path}: length fresh ${a.length} incremental ${b.length}`
  for (const k of new Set([...Object.keys(a as object), ...Object.keys(b as object)])) {
    const d = firstDiff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`)
    if (d) return d
  }
  return null
}
const datasetsOf = (scene: SceneRoot): unknown => Object.fromEntries([...datasetsOfScene(scene)].map(([k, rows]) => [k, norm(rows)]))

function compare(fresh: SceneRoot, inc: SceneRoot): string | null {
  return firstDiff(norm(fresh), norm(inc))
    ?? (renderSceneToSvg(fresh) !== renderSceneToSvg(inc) ? 'svg differs' : null)
    ?? firstDiff(datasetsOf(fresh), datasetsOf(inc), '$datasets')
}

/**
 * The arrays a scene publishes (every items array, every dataset) with their content stamp and a copy of what they held: an array
 * whose stamp has not moved by a later step must still hold exactly that (element identity for items, content for rows).
 */
interface Published { arr: readonly unknown[]; stamp: string; was: unknown[]; rows: string | null }
function publishedArrays(scene: SceneRoot): Published[] {
  const out: Published[] = []
  const walk = (n: unknown): void => {
    if (n === null || typeof n !== 'object') return
    const items = (n as { items?: unknown }).items
    if (Array.isArray(items)) {
      out.push({ arr: items, stamp: stampKey(items), was: items.slice(), rows: null })
      for (const c of items) walk(c)
    }
  }
  walk(scene)
  for (const rows of datasetsOfScene(scene).values()) if (rows !== null) out.push({ arr: rows, stamp: stampKey(rows), was: rows.slice(), rows: JSON.stringify(rows) })
  return out
}
function brokenStamp(seen: readonly Published[]): string | null {
  for (const p of seen) {
    if (stampKey(p.arr) !== p.stamp) continue
    if (p.arr.length !== p.was.length || p.arr.some((x, i) => x !== p.was[i])) return `an array kept its stamp ${p.stamp} but its elements changed`
    if (p.rows !== null && JSON.stringify(p.arr) !== p.rows) return `a dataset kept its stamp ${p.stamp} but its rows changed`
  }
  return null
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const quiet = { error() {}, warn() {}, info() {}, debug() {} }

/** The signals a scenario's evaluations are given: its own, and the log of requests the host's store holds (made from `session`). */
function signalsOf(sc: Scenario, session: object): Record<string, unknown> | undefined {
  if (!sc.signals && !sc.log) return undefined
  const signals: Record<string, unknown> = sc.signals ? clone(sc.signals) : {}
  if (sc.log) (signals as Record<symbol, unknown>)[ENCODE_LOG] = sc.log(session)
  return signals
}
function inputOf(sc: Scenario, data: Data, session: object): RuntimeInput {
  const signals = signalsOf(sc, session)
  return { logger: quiet, data: clone(data), ...(signals ? { signals } : {}), ...(sc.extra ? clone(sc.extra) : {}) }
}
interface Fail { shape: string; seed: number; delivery: Delivery; step: number; ops: string[]; detail: string }

export function runScenario(shape: string, gen: (r: Rnd) => Scenario, seed: number, steps: number, delivery: Delivery): Fail | null {
  const r = mulberry32(seed * 7919 + shape.length)
  const sc = gen(r)
  const chart = delivery === 'session' ? null : compileChart(clone(sc.spec))
  const session = delivery === 'session' ? createChartSession() : null
  let data = sc.data
  const ops: string[] = []
  const incSession = {}
  let stamps: Published[] = []
  let stampFail: Fail | undefined
  // (DECISIONS Q14: `datasetsOfScene(scene)` is that scene's rows, whatever evaluations came after it)
  const history: Array<{ scene: SceneRoot; rows: string }> = []
  let last: SceneRoot | undefined
  for (let step = 0; step <= steps; step++) {
    const prev = data
    if (step > 0) {
      const op = pick(r, OPS)
      ops.push(op)
      data = update(r, sc, data, op)
    }
    // (the evaluations of the chart under test keep one session, as the event loop does; a fresh evaluation has a session of its own)
    const input = (fresh = false): RuntimeInput => inputOf(sc, data, fresh ? {} : incSession)
    let inc: SceneRoot
    try {
      // (the session is handed new arrays for the datasets that changed and the very arrays it was given for the others, as a host's
      // immutable state does; the chart is handed what its hints describe)
      if (session) inc = session.evaluate(clone(sc.spec), { logger: quiet, data: { ...data }, ...(sc.signals || sc.log ? { signals: signalsOf(sc, incSession) } : {}), ...(sc.extra ? clone(sc.extra) : {}) })
      else inc = evaluateChart(chart!, { ...input(), ...(step > 0 ? hints(delivery, prev, data) : {}), ...(namesScene(delivery) && last !== undefined ? { previousScene: last } : {}) })
    } catch (e) {
      return { shape, seed, delivery, step, ops, detail: `incremental threw ${(e as Error).message}` }
    }
    last = inc
    const fresh = evaluateChart(compileChart(clone(sc.spec)), input(true))
    const d = compare(fresh, inc)
    if (d !== null) return { shape, seed, delivery, step, ops, detail: d }
    // (the stamp invariant is reported apart: a scene that is still right over an array written behind its stamp is a failure too,
    // but the scene comparison goes on, so the run shows which of the two a defect breaks)
    const broken = brokenStamp(stamps)
    if (broken !== null) stampFail ??= { shape, seed, delivery, step, ops: ops.slice(), detail: broken }
    stamps = publishedArrays(inc)
    for (const h of history) {
      if (JSON.stringify(datasetsOf(h.scene)) !== h.rows) return { shape, seed, delivery, step, ops, detail: `the datasets of the scene of step ${history.indexOf(h)} changed after it was returned (Q14)` }
    }
    history.push({ scene: inc, rows: JSON.stringify(datasetsOf(inc)) })
  }
  return stampFail ?? null
}

const env = (k: string): string | undefined => (typeof process !== 'undefined' ? process.env[k] : undefined)
const SEEDS = Number(env('ASTER_SHAPES_SEEDS') ?? 12)
const STEPS = 8

describe('incremental === fresh over the shapes whose reuse rests on what a node reads', () => {
  for (const [shape, gen] of SHAPES) {
    for (const delivery of DELIVERIES) {
      it(`${shape}, delivered by ${delivery}`, () => {
        const fails: Fail[] = []
        for (let seed = 1; seed <= SEEDS; seed++) {
          const f = runScenario(shape, gen, seed, STEPS, delivery)
          if (f) fails.push(f)
        }
        expect(fails.map((f) => `seed ${f.seed} step ${f.step} [${f.ops.join(' ')}]: ${f.detail}`)).toEqual([])
      })
    }
  }
})

/**
 * One compiled chart shared by two callers (DECISIONS Q16: supported, and per-chart state must not leak between them): each caller
 * evaluates its own sequence of states with hints relative to ITS previous state, the two interleaved. Every scene equals a fresh
 * evaluation of that caller's input. A caller that names its previous scene (`previousScene`) has its hints checked by identity: the
 * callers then take turns at random, so a caller's hint is sometimes relative to the chart's last evaluation (its own: the hint is
 * taken) and sometimes not (the other caller evaluated since: it must not be applied to that caller's state).
 */
export function runShared(shape: string, gen: (r: Rnd) => Scenario, seed: number, steps: number, delivery: Exclude<Delivery, 'session'>): Fail | null {
  const r = mulberry32(seed * 6151 + shape.length)
  const sc = gen(r)
  const chart = compileChart(clone(sc.spec))
  const callers = [sc.data, update(r, sc, sc.data, 'replace')]
  const scenes: Array<SceneRoot | undefined> = [undefined, undefined]
  const sessions = [{}, {}]
  const ops: string[] = []
  for (let step = 0; step <= steps; step++) {
    const who = step < 2 || !namesScene(delivery) ? step % 2 : int(r, 0, 1)
    const prev = callers[who]!
    let data = prev
    if (step > 1) { const op = pick(r, OPS); ops.push(`${who}:${op}`); data = update(r, sc, prev, op) }
    callers[who] = data
    const input = (): RuntimeInput => inputOf(sc, data, sessions[who]!)
    let inc: SceneRoot
    try {
      inc = evaluateChart(chart, { ...input(), ...(step > 1 ? hints(delivery, prev, data) : {}), ...(namesScene(delivery) && scenes[who] !== undefined ? { previousScene: scenes[who] } : {}) })
    } catch (e) {
      return { shape, seed, delivery, step, ops, detail: `incremental threw ${(e as Error).message}` }
    }
    scenes[who] = inc
    const d = compare(evaluateChart(compileChart(clone(sc.spec)), inputOf(sc, data, {})), inc)
    if (d !== null) return { shape, seed, delivery, step, ops, detail: d }
  }
  return null
}

describe('one compiled chart shared by two callers equals fresh for each (Q16)', () => {
  for (const [shape, gen] of SHAPES) {
    for (const delivery of DELIVERIES.filter((d): d is Exclude<Delivery, 'session'> => d !== 'session')) {
      it(`${shape}, delivered by ${delivery}`, () => {
        const fails: string[] = []
        for (let seed = 1; seed <= SEEDS; seed++) {
          const f = runShared(shape, gen, seed, STEPS, delivery)
          if (f) fails.push(`seed ${f.seed} step ${f.step} [${f.ops.join(' ')}]: ${f.detail}`)
        }
        expect(fails).toEqual([])
      })
    }
  }
})

/**
 * DECISIONS Q29, decided by this test: an `appendOnly` pulse whose `baseLength` is not the length of the rows before is not taken
 * (the evaluation derives the dataset in full); the hint is trusted only where it can be checked without reading a row.
 */
describe('a false appendOnly pulse (a wrong baseLength) is detected (Q29)', () => {
  for (const [shape, gen] of SHAPES) for (const named of [false, true]) {
    it(`${shape}${named ? ', from a caller that names its previous scene' : ''}`, () => {
      const fails: string[] = []
      for (let seed = 1; seed <= SEEDS; seed++) {
        const r = mulberry32(seed * 911 + shape.length)
        const sc = gen(r)
        const chart = compileChart(clone(sc.spec))
        let data = sc.data
        const session = {}
        const input = (): RuntimeInput => inputOf(sc, data, session)
        let last = evaluateChart(chart, input())
        for (let step = 1; step <= STEPS; step++) {
          const prev = data
          data = update(r, sc, data, pick(r, ['edit', 'append', 'remove', 'insert'] as const))
          const lie: NonNullable<RuntimeInput['dataPulse']> = {}
          for (const n of sc.mutable) lie[n] = { changed: [], appendOnly: true, baseLength: prev[n]!.length + pick(r, [-1, 1, 2]) }
          const inc = last = evaluateChart(chart, { ...input(), dataPulse: lie, ...(named ? { previousScene: last } : {}) })
          const d = compare(evaluateChart(compileChart(clone(sc.spec)), inputOf(sc, data, {})), inc)
          if (d !== null) { fails.push(`seed ${seed} step ${step}: ${d}`); break }
        }
      }
      expect(fails).toEqual([])
    })
  }
})
