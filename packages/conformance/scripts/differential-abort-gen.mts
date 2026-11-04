/**
 * The generator of the aborted-pass differentials: random trees of nested scopes (groups, faceted groups, groups per datum, own
 * scales and signals, axes, legends of every kind, titles, group transforms, header groups in grid layouts) with failures put at
 * random places (see differential-abort-trees.test.mts).
 */
import { makeRng, type Rng } from './differential-gen.mts'

type Spec = Record<string, unknown>

/** The ways a part of the tree fails. */
export type Fail = 'mark' | 'condition' | 'group' | 'axis' | 'legend' | 'title' | 'signal' | 'scope-signal' | 'scale' | 'late-signal' | 'transform' | 'sort'
  | 'group-transform' | 'header-sort' | 'encode-and-transform' | 'item-transform' | 'layout'
export const FAILS: readonly Fail[] = (process.env.ABORT_KINDS?.split(',') as Fail[] | undefined) ?? ['mark', 'condition', 'group', 'axis', 'legend', 'title', 'signal', 'scope-signal', 'scale', 'late-signal', 'transform', 'sort', 'group-transform', 'header-sort', 'encode-and-transform', 'item-transform', 'layout']

interface Gen {
  r: Rng
  /** the number of nodes made so far (marks, groups) */
  n: number
  fails: Map<number, Fail>
  used: Set<Fail>
  /** scales a failure puts in the view's scope */
  rootScales: Spec[]
  /** signals of the view a failure puts there */
  rootSignals: Spec[]
  /** the nodes that are groups */
  groups: Set<number>
}

/** The failures a leaf mark can hold, and those a group can (`signal` is the view's, wherever it is drawn). */
const LEAF_FAILS: ReadonlySet<Fail> = new Set(['mark', 'condition', 'scale', 'late-signal', 'transform', 'sort', 'encode-and-transform', 'signal', 'item-transform'])
const GROUP_FAILS: ReadonlySet<Fail> = new Set(['group', 'axis', 'legend', 'title', 'scope-signal', 'scale', 'late-signal', 'transform', 'sort', 'group-transform', 'header-sort', 'encode-and-transform', 'signal', 'layout'])

const COLORS = ['teal', 'crimson', 'goldenrod', 'slateblue', 'seagreen', 'orchid', 'tomato', 'navy']

/** An entry that throws when a guide item or a mark item evaluates it (the datum has no `o`, and no scale is named `nope`). */
function failingEntry(r: Rng): Record<string, unknown> {
  return r.pick<Record<string, unknown>>([
    { scale: 'nope', field: 'value' }, { scale: 'nope', value: 1 }, { scale: 'nope', range: 0.5 }, { scale: 'nope', band: 1 },
    { signal: 'datum.o.v' }, { signal: 'datum.o.v + 1', offset: 2 }, { scale: 'nope', field: 'value', offset: 3 },
  ])
}

/**
 * Transforms of a mark that work on its items and write what they compute onto them (a group's position, size or paint, read by
 * what the group holds), each of a kind vega lets a mark have. None of them throws.
 */
function itemTransforms(r: Rng): Spec[] {
  return r.pick<Spec[]>([
    [{ type: 'formula', as: 'x', expr: 'datum.x + 9' }],
    [{ type: 'formula', as: 'fill', expr: "datum.datum.k == 'q' ? 'orange' : 'purple'" }],
    [{ type: 'formula', as: 'y', expr: 'datum.datum.a ? datum.datum.a * 4 : 7' }],
    [{ type: 'window', ops: ['row_number'], as: ['n'] }, { type: 'formula', as: 'y', expr: 'datum.n * 5' }],
    [{ type: 'collect', sort: { field: 'datum.a', order: 'descending' } }, { type: 'window', ops: ['row_number'], as: ['n'] }, { type: 'formula', as: 'x', expr: 'datum.n * 11' }],
    [{ type: 'joinaggregate', ops: ['count'], as: ['c'] }, { type: 'formula', as: 'width', expr: 'datum.width + datum.c * 3' }],
    [{ type: 'stack', field: 'height', as: ['y', 'y1'] }],
    [{ type: 'bin', field: 'x', extent: [0, 200], step: 25, as: ['x', 'x1'] }],
    [{ type: 'extent', field: 'x' }, { type: 'formula', as: 'height', expr: 'datum.height - 6' }],
    // (transforms that work on copies of their tuples: what they compute is on the items all the same)
    [{ type: 'pie', field: 'width', as: ['p0', 'p1'] }, { type: 'formula', as: 'x', expr: 'datum.x + datum.p1 * 2' }],
    [{ type: 'dotbin', field: 'x', step: 20, as: 'x' }],
  ])
}

/**
 * Transforms of a mark that is not a group, of the kinds vega lets a mark have, that work on its items: they read what the encode
 * gave the items (`datum.x`, `datum.y`) and their data (`datum.datum.a`), and what they write onto the items (a position, a paint,
 * a number a later transform reads) is what is drawn. None of them throws.
 */
function leafTransforms(r: Rng, type: string): Spec[] {
  const paint = type === 'line' || type === 'rule' ? 'stroke' : 'fill'
  return r.pick<Spec[]>([
    [{ type: 'formula', as: 'x', expr: 'datum.datum.a * 10' }],
    [{ type: 'formula', as: 'y', expr: 'datum.y + datum.datum.a * 3' }],
    [{ type: 'formula', as: paint, expr: "datum.datum.k == 'q' ? 'orange' : 'purple'" }],
    [{ type: 'formula', as: 'opacity', expr: 'datum.datum.a / 4' }],
    [{ type: 'window', ops: ['row_number'], as: ['n'] }, { type: 'formula', as: 'x', expr: 'datum.n * 11' }],
    [{ type: 'window', ops: ['sum'], fields: ['x'], as: ['run'] }, { type: 'formula', as: 'y', expr: 'datum.run / 2' }],
    [{ type: 'collect', sort: { field: 'datum.a', order: 'descending' } }, { type: 'window', ops: ['row_number'], as: ['n'] }, { type: 'formula', as: 'x', expr: 'datum.n * 11' }],
    [{ type: 'joinaggregate', ops: ['count', 'max'], fields: [null, 'x'], as: ['c', 'top'] }, { type: 'formula', as: 'y', expr: 'datum.y + datum.c + datum.top / 4' }],
    [{ type: 'stack', field: 'x', as: ['x', 'x2'] }],
    [{ type: 'stack', groupby: ['datum.k'], field: 'y', sort: { field: 'datum.a' }, as: ['y', 'y2'] }],
    [{ type: 'bin', field: 'x', extent: [0, 40], step: 5, as: ['x', 'x1'] }],
    [{ type: 'extent', field: 'x' }, { type: 'formula', as: 'y', expr: 'datum.x * 2' }],
    [{ type: 'pie', field: 'x', as: ['p0', 'p1'] }, { type: 'formula', as: 'x', expr: 'datum.x + datum.p1 * 2' }],
    [{ type: 'dotbin', field: 'x', step: 4, as: 'x' }],
    [{ type: 'timeunit', field: 'datum.a', units: ['year'], as: ['t0', 't1'] }, { type: 'formula', as: 'y', expr: 'datum.y + (datum.t0 > 0 ? 3 : 9)' }],
  ])
}

/** A transform that reads the mark's defaults: they are the encode's, so a line's width is 2 before its transforms run. */
const READS_DEFAULTS: Spec = { type: 'formula', as: 'y', expr: 'datum.strokeWidth == 2 ? 20 : 8' }

/** Transforms of a mark that has no data (one item, whose datum is empty): they read what the encode gave it. */
function sourcelessTransforms(r: Rng): Spec[] {
  return r.pick<Spec[]>([
    [{ type: 'formula', as: 'y', expr: 'datum.x / 2 + 3' }],
    [{ type: 'window', ops: ['row_number'], as: ['n'] }, { type: 'formula', as: 'x', expr: 'datum.n * 11' }],
    [{ type: 'formula', as: 'opacity', expr: '0.5' }],
  ])
}

/** A transform of a mark that throws when it runs on the items and would not on the data (or would with another message). */
function failingItemTransform(r: Rng): Spec {
  return r.pick<Spec>([
    failingTransform(r),
    { type: 'formula', as: 'z', expr: 'datum.datum.zz.q' },
    { type: 'formula', as: 'x', expr: 'datum.datum.o.v.w' },
    { type: 'window', ops: ['sum'], fields: ['datum.zz.q'], as: ['s'] },
    { type: 'joinaggregate', ops: ['max'], fields: ['datum.zz.q'], as: ['s'] },
    { type: 'stack', field: 'datum.zz.q' },
    { type: 'bin', field: 'datum.zz.q', extent: [0, 10] },
    { type: 'pie', field: 'datum.zz.q' },
    { type: 'collect', sort: { field: 'datum.zz.q' } },
  ])
}

/** A transform of a mark that throws when it runs on the items (they have no `zz`), of one of the kinds a mark can have. */
function failingTransform(r: Rng): Spec {
  return r.pick<Spec>([
    { type: 'formula', as: 'z', expr: 'datum.zz.q' },
    { type: 'window', ops: ['sum'], fields: ['zz.q'], as: ['s'] },
    { type: 'joinaggregate', ops: ['max'], fields: ['zz.q'], as: ['s'] },
    { type: 'stack', field: 'zz.q' },
    { type: 'bin', field: 'zz.q', extent: [0, 10] },
    { type: 'extent', field: 'zz.q' },
    { type: 'timeunit', field: 'zz.q', units: ['year'] },
  ])
}

/** A scale whose operator throws (no such scheme). */
const badScale = (id: number): Spec => ({ name: `bad${id}`, type: 'ordinal', domain: ['a'], range: { scheme: 'nonesuch' } })

const MARK_TYPES: Array<[string, (id: number) => Record<string, unknown>]> = [
  ['rect', (id) => ({ width: { value: 4 }, height: { value: 4 }, fill: { value: COLORS[id % COLORS.length] } })],
  ['symbol', (id) => ({ size: { value: 30 }, fill: { value: COLORS[id % COLORS.length] } })],
  ['text', (id) => ({ text: { value: 'a' }, fill: { value: COLORS[id % COLORS.length] } })],
  ['rule', (id) => ({ x2: { value: 12 }, stroke: { value: COLORS[id % COLORS.length] } })],
  ['line', (id) => ({ stroke: { value: COLORS[id % COLORS.length] } })],
  ['area', (id) => ({ y2: { value: 30 }, fill: { value: COLORS[id % COLORS.length] } })],
]

function leaf(g: Gen, data: string): Spec {
  const id = g.n++
  const fail = g.fails.get(id)
  const [type, paint] = g.r.pick(MARK_TYPES)
  const update: Record<string, unknown> = { x: { scale: 'x', field: 'a' }, y: { value: 4 + (id % 7) * 6 }, ...paint(id) }
  if (fail === 'mark' || fail === 'encode-and-transform') {
    update[g.r.pick(['x', 'y', 'fill', 'opacity'])] = failingEntry(g.r)
    g.used.add(fail)
  } else if (fail === 'condition') {
    update.opacity = [{ test: 'datum.o.v > 1', value: 1 }, { value: 0.5 }]
    g.used.add(fail)
  } else if (fail === 'scale') {
    g.rootScales.push(badScale(id))
    g.used.add(fail)
  }
  // (a late signal read by the encode, by a transform of the mark or by its sort: what reads it, and what comes after that, never runs)
  let lateTransform: Spec | undefined
  let lateSort: Spec | undefined
  if (fail === 'late-signal') {
    lateSignal(g, id)
    const where = g.r.int(10)
    if (where < 5) update.opacity = { signal: `late${id}` }
    else if (where < 8) lateTransform = { type: 'formula', as: g.r.pick(['y', 'opacity']), expr: `late${id} + 1` }
    else if (where < 9) lateSort = { field: 'datum.k', order: { signal: `late${id}` } }
    g.used.add(fail)
  }
  // (a mark with no data has one item; its transforms run on it all the same)
  const sourceless = fail === undefined && g.r.chance(0.08)
  if (sourceless) update.x = { value: 5 + id }
  const mark: Spec = { type, name: `m${id}`, ...(sourceless ? {} : { from: { data } }), encode: { update } }
  // (the transforms and the sort of a mark run on its encoded items, after the encode, and write onto them)
  // (what reads a late signal never runs, nor what comes after it: the mark's transforms and its sort)
  const transforms: Spec[] = sourceless ? sourcelessTransforms(g.r) : g.r.chance(0.35) || fail === 'late-signal' ? leafTransforms(g.r, type) : []
  if (lateTransform) transforms.splice(g.r.int(transforms.length + 1), 0, lateTransform)
  if (type === 'line' && g.r.chance(0.4)) transforms.push(READS_DEFAULTS)
  if (fail === 'item-transform') {
    transforms.splice(g.r.int(transforms.length + 1), 0, failingItemTransform(g.r))
    g.used.add(fail)
  }
  if (transforms.length) mark.transform = transforms
  if (lateSort) mark.sort = lateSort
  else if (fail === 'late-signal' && g.r.chance(0.4)) mark.sort = { field: 'datum.a', order: 'descending' }
  // (a mark that fails in its encode and in its transform or sort too: vega runs the encode first)
  const both = fail === 'encode-and-transform' && g.r.chance(0.6)
  if (fail === 'transform' || both) {
    mark.transform = [failingTransform(g.r)]
    g.used.add(fail)
  } else if (fail === 'sort' || fail === 'encode-and-transform') {
    mark.sort = { field: 'datum.zz.q' }
    g.used.add(fail)
  }
  return mark
}

/** A signal of the view that reads a scale or a dataset and throws: ranked after everything else of the view's scope. */
function lateSignal(g: Gen, id: number): void {
  g.rootSignals.push({ name: `late${id}`, update: g.r.pick([`null.x + scale('x', 1)`, `data('t')[0].zz.q`, `bandwidth('x') + null.x`]) })
}

function guideEncode(r: Rng, parts: readonly string[]): Record<string, unknown> {
  const part = r.pick(parts)
  const block = r.pick(['update', 'update', 'enter'])
  return { [part]: { [block]: { [r.pick(['dx', 'x', 'y', 'opacity', 'fontSize'])]: failingEntry(r) } } }
}

function axis(g: Gen, own: string | undefined, fails: boolean): Spec {
  const a: Spec = { scale: own ?? 'x', orient: g.r.pick(['bottom', 'top', 'left', 'right']) }
  if (g.r.chance(0.3)) a.grid = true
  if (g.r.chance(0.3)) a.title = 'axis'
  if (g.r.chance(0.15)) a.domain = false
  if (g.r.chance(0.15)) a.ticks = false
  if (g.r.chance(0.15)) a.labels = false
  if (fails) {
    const parts = ['axis', 'ticks', 'labels', 'domain', 'grid', 'title'].filter((p) => (p === 'grid' ? a.grid === true : p === 'title' ? a.title !== undefined : p === 'domain' ? a.domain !== false : p === 'ticks' ? a.ticks !== false : p === 'labels' ? a.labels !== false : true))
    a.encode = guideEncode(g.r, parts)
  }
  return a
}

function legend(g: Gen, fails: boolean, badColumns = false): Spec {
  const kind = badColumns ? 'c' : g.r.pick(['c', 'c', 'g', 'q'])
  const l: Spec = { fill: kind }
  // (a symbol legend lays its entries out in a grid of its own: one it cannot take throws there)
  if (badColumns) l.columns = g.r.pick([1.5, -1, 2.5])
  else if (kind === 'c' && g.r.chance(0.15)) l.columns = g.r.pick([0, 1, 2, 3])
  if (g.r.chance(0.35)) l.title = 'legend'
  if (g.r.chance(0.2)) l.orient = g.r.pick(['left', 'top', 'bottom', 'none'])
  if (fails) {
    const parts = kind === 'c' ? ['legend', 'entries', 'symbols', 'labels', ...(l.title !== undefined ? ['title'] : [])]
      : ['legend', 'gradient', 'labels', ...(l.title !== undefined ? ['title'] : [])]
    l.encode = guideEncode(g.r, kind === 'q' ? parts.map((p) => p) : parts)
  }
  return l
}

function group(g: Gen, depth: number, data: string): Spec {
  const id = g.n++
  g.groups.add(id)
  const fail = g.fails.get(id)
  const own = g.r.chance(0.4)
  const shape = g.r.pick(['plain', 'plain', 'plain', 'facet', 'data'])
  const marks: Spec[] = []
  // (a group with nothing in it: its scope has no marks, which is what the ranks of the layouts above it depend on)
  const empty = (fail === undefined || fail === 'group' || fail === 'scope-signal') && g.r.chance(0.15)
  const kids = empty ? 0 : g.r.between(0, 3)
  const childData = shape === 'facet' ? `f${id}` : data
  for (let i = 0; i < kids; i++) marks.push(depth < 2 && g.r.chance(0.4) ? group(g, depth + 1, childData) : leaf(g, childData))
  const update: Record<string, unknown> = { x: { value: 2 + (id % 4) * 30 }, y: { value: 2 }, width: { value: 28 }, height: { value: 28 }, fill: { value: '#eee' } }
  // (what the group holds reads the group's own size and position: what its transforms wrote)
  if (marks.length && g.r.chance(0.3)) marks.push({ type: 'rect', encode: { update: { x: { field: { group: 'x' }, mult: 0.1 }, y: { value: 1 }, width: { field: { group: 'width' }, mult: 0.2 }, height: { field: { group: 'height' }, mult: 0.2 }, fill: { value: 'black' } } } })
  if (fail === 'group' || fail === 'encode-and-transform') {
    update[g.r.pick(['width', 'x', 'fill'])] = failingEntry(g.r)
    g.used.add(fail)
  }
  if (fail === 'late-signal') {
    lateSignal(g, id)
    if (g.r.chance(0.5)) update.opacity = { signal: `late${id}` }
    g.used.add(fail)
  }
  const node: Spec = { type: 'group', name: `g${id}`, encode: { update }, marks }
  // the transforms of a group run on its items, after their encode and before what they hold is made
  const transforms: Spec[] = g.r.chance(0.35) ? itemTransforms(g.r) : []
  const both = fail === 'encode-and-transform' && g.r.chance(0.6)
  if ((fail === 'transform' && g.r.chance(0.5)) || fail === 'group-transform' || both) {
    transforms.splice(g.r.int(transforms.length + 1), 0, failingTransform(g.r))
    g.used.add(fail as Fail)
  } else if (fail === 'sort' || fail === 'encode-and-transform') { node.sort = { field: 'datum.zz.q' }; g.used.add(fail) }
  if (transforms.length) node.transform = transforms
  // (a layout that throws: a column count no grid can take, or a legend whose entries' grid cannot take its own)
  const layoutFails = fail === 'layout' ? g.r.pick(['columns', 'columns', 'legend']) : undefined
  if (fail === 'header-sort' || layoutFails === 'columns' || g.r.chance(0.12)) {
    // a grid of the group's groups, with a header (or footer) group whose items are sorted by what they do not have. The columns are
    // drawn at random: with more columns than cells, a column header or footer finds no cell to line up with, and the layout throws.
    const columns = layoutFails === 'columns' ? g.r.pick([1.5, -2, 0.5]) : g.r.pick([undefined, 1, 2, 3, 4])
    node.layout = { ...(columns !== undefined ? { columns } : {}), padding: 3, bounds: g.r.pick(['full', 'flush']), ...(g.r.chance(0.2) ? { headerBand: 0.5 } : {}) }
    if (layoutFails !== undefined) g.used.add('layout')
    const header: Spec = {
      type: 'group', role: g.r.pick(['column-header', 'row-header', 'column-footer', 'row-footer']), name: `h${id}`, from: { data: g.r.chance(0.3) ? 't' : childData },
      sort: { field: fail === 'header-sort' ? 'datum.zz.q' : 'datum.k', order: 'descending' },
      encode: { update: { width: { value: 10 }, height: { value: 6 } } },
      title: { text: { signal: "'' + parent.a" }, fontSize: 6 },
    }
    marks.splice(g.r.int(marks.length + 1), 0, header)
    if (fail === 'header-sort') g.used.add(fail)
  }
  if (shape === 'facet') node.from = { facet: { data, name: `f${id}`, groupby: 'k' } }
  else if (shape === 'data') node.from = { data }
  if (own) node.scales = [{ name: `s${id}`, type: 'linear', domain: [0, 4], range: [0, 20] }]
  if (fail === 'scale') {
    node.scales = [...((node.scales as Spec[] | undefined) ?? []), badScale(id)]
    g.used.add(fail)
  }
  if (fail === 'scope-signal') {
    node.signals = [{ name: `sig${id}`, update: 'null.x' }]
    g.used.add(fail)
  }
  const axes: Spec[] = []
  const legends: Spec[] = []
  for (let i = (empty ? 0 : g.r.between(0, 1)) + (fail === 'axis' ? 1 : 0); i > 0; i--) axes.push(axis(g, own ? `s${id}` : undefined, false))
  for (let i = (empty ? 0 : g.r.between(0, 1)) + (fail === 'legend' || layoutFails === 'legend' ? 1 : 0); i > 0; i--) legends.push(legend(g, false))
  if (fail === 'axis') {
    axes[g.r.int(axes.length)] = axis(g, own ? `s${id}` : undefined, true)
    g.used.add(fail)
  }
  if (fail === 'legend') {
    legends[g.r.int(legends.length)] = legend(g, true)
    g.used.add(fail)
  }
  if (layoutFails === 'legend') {
    legends[g.r.int(legends.length)] = legend(g, false, true)
    g.used.add('layout')
  }
  if (axes.length) node.axes = axes
  if (legends.length) node.legends = legends
  if (fail === 'title') {
    node.title = { text: 'T', encode: { [g.r.pick(['title', 'group'])]: { update: { dx: failingEntry(g.r) } } } }
    g.used.add(fail)
  } else if (!empty && g.r.chance(0.15)) node.title = { text: 'title' }
  return node
}

export function treeSpec(r: Rng): { spec: Spec; fails: Fail[]; label: string } {
  const total = r.between(2, 5)
  const seed = r.int(1 << 30) + 1
  // The nodes are numbered in generation order, and a failure is put on one of them: the tree is made twice, once to count them.
  const make = (fails: Map<number, Fail>): { marks: Spec[]; g: Gen } => {
    const g: Gen = { r: makeRng(seed), n: 0, fails, used: new Set(), rootScales: [], rootSignals: [], groups: new Set() }
    const marks: Spec[] = []
    for (let i = 0; i < total; i++) marks.push(g.r.chance(0.55) ? group(g, 0, 't') : leaf(g, 't'))
    return { marks, g }
  }
  const { g: shape } = make(new Map())
  const fails = new Map<number, Fail>()
  const count = process.env.ABORT_ONE ? 1 : r.between(1, 2)
  for (let i = 0; i < count; i++) {
    // (a kind of failure, on a node that can hold it)
    const kind = r.pick(FAILS)
    const nodes = Array.from({ length: shape.n }, (_, id) => id).filter((id) => (shape.groups.has(id) ? GROUP_FAILS : LEAF_FAILS).has(kind))
    fails.set(nodes.length ? r.pick(nodes) : r.int(shape.n), kind)
  }
  const { marks, g } = make(fails)
  const spec: Spec = {
    width: 130, height: 60, padding: 4, autosize: process.env.ABORT_AUTOSIZE ?? r.pick(['none', 'pad', 'fit']),
    signals: [...g.rootSignals],
    scales: [
      { name: 'x', type: 'linear', domain: [0, 4], range: [0, 20] },
      { name: 'c', type: 'ordinal', domain: ['p', 'q'], range: ['red', 'blue'] },
      { name: 'g', type: 'linear', domain: [0, 4], range: ['white', 'black'] },
      { name: 'q', type: 'quantize', domain: [0, 4], range: ['#eee', '#9bd', '#06c'] },
      ...g.rootScales,
    ],
    data: [{ name: 't', values: [{ a: 1, k: 'p', o: { v: 3 } }, { a: 2, k: 'q' }, { a: 3, k: 'p', o: { v: 2 } }] }],
    marks,
  }
  // a grid of the view's own groups, with a header or a footer: its columns drawn at random (more columns than cells make a column header
  // or footer that finds no cell throw), and a count no grid can take where the view's layout is to fail
  if (r.chance(0.12)) {
    const columns = r.chance(0.2) ? r.pick([1.5, -1]) : r.pick([undefined, 1, 2, 3, 5])
    spec.layout = { ...(columns !== undefined ? { columns } : {}), padding: 2, bounds: r.pick(['full', 'flush']) }
    ;(spec.marks as Spec[]).push({
      type: 'group', role: r.pick(['column-header', 'row-header', 'column-footer', 'row-footer']), name: 'vh', from: { data: 't' },
      encode: { update: { width: { value: 10 }, height: { value: 6 } } }, title: { text: { signal: "'' + parent.a" }, fontSize: 6 },
    })
  }
  // the view's own guides and title, and a failing signal of the view
  const view = process.env.ABORT_ONE && !FAILS.some((f) => f === 'axis' || f === 'legend' || f === 'title') ? [] : r.pick<string[]>([[], [], ['axis'], ['legend'], ['title'], ['axis', 'legend', 'title']])
  const viewFails = [...fails.values()]
  if (view.includes('axis')) (spec.axes = [axis(g, undefined, viewFails.includes('axis') && r.chance(0.5))])
  if (view.includes('legend')) (spec.legends = [legend(g, viewFails.includes('legend') && r.chance(0.5))])
  if (view.includes('title')) spec.title = viewFails.includes('title') && r.chance(0.5) ? { text: 'T', encode: { title: { update: { dx: failingEntry(r) } } } } : { text: 'title' }
  if (viewFails.includes('signal')) {
    (spec.signals as unknown[]).push({ name: 'bad', update: 'null.x' })
    g.used.add('signal')
  }
  const label = `fails ${[...fails].map(([id, f]) => `${id}:${f}`).join(',')} used ${[...g.used].join(',')}`
  return { spec, fails: [...g.used], label }
}
