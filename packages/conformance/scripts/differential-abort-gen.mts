/**
 * The generator of the aborted-pass differentials: random trees of nested scopes (groups, faceted groups, groups per datum, own
 * scales and signals, axes, legends of every kind, titles) with failures put at random places (see differential-abort-trees.test.mts).
 */
import { makeRng, type Rng } from './differential-gen.mts'

type Spec = Record<string, unknown>

/** The ways a part of the tree fails. */
export type Fail = 'mark' | 'condition' | 'group' | 'axis' | 'legend' | 'title' | 'signal' | 'scope-signal' | 'scale'
export const FAILS: readonly Fail[] = (process.env.ABORT_KINDS?.split(',') as Fail[] | undefined) ?? ['mark', 'condition', 'group', 'axis', 'legend', 'title', 'signal', 'scope-signal', 'scale']

interface Gen {
  r: Rng
  /** the number of nodes made so far (marks, groups) */
  n: number
  fails: Map<number, Fail>
  used: Set<Fail>
  /** scales a failure puts in the view's scope */
  rootScales: Spec[]
}

const COLORS = ['teal', 'crimson', 'goldenrod', 'slateblue', 'seagreen', 'orchid', 'tomato', 'navy']

/** An entry that throws when a guide item or a mark item evaluates it (the datum has no `o`, and no scale is named `nope`). */
function failingEntry(r: Rng): Record<string, unknown> {
  return r.pick<Record<string, unknown>>([
    { scale: 'nope', field: 'value' }, { scale: 'nope', value: 1 }, { scale: 'nope', range: 0.5 }, { scale: 'nope', band: 1 },
    { signal: 'datum.o.v' }, { signal: 'datum.o.v + 1', offset: 2 }, { scale: 'nope', field: 'value', offset: 3 },
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
  if (fail === 'mark') {
    update[g.r.pick(['x', 'y', 'fill', 'opacity'])] = failingEntry(g.r)
    g.used.add(fail)
  } else if (fail === 'condition') {
    update.opacity = [{ test: 'datum.o.v > 1', value: 1 }, { value: 0.5 }]
    g.used.add(fail)
  } else if (fail === 'scale') {
    g.rootScales.push(badScale(id))
    g.used.add(fail)
  }
  return { type, name: `m${id}`, from: { data }, encode: { update } }
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

function legend(g: Gen, fails: boolean): Spec {
  const kind = g.r.pick(['c', 'c', 'g', 'q'])
  const l: Spec = { fill: kind }
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
  const fail = g.fails.get(id)
  const own = g.r.chance(0.4)
  const shape = g.r.pick(['plain', 'plain', 'plain', 'facet', 'data'])
  const marks: Spec[] = []
  const kids = g.r.between(0, 3)
  const childData = shape === 'facet' ? `f${id}` : data
  for (let i = 0; i < kids; i++) marks.push(depth < 2 && g.r.chance(0.4) ? group(g, depth + 1, childData) : leaf(g, childData))
  const update: Record<string, unknown> = { x: { value: 2 + (id % 4) * 30 }, y: { value: 2 }, width: { value: 28 }, height: { value: 28 }, fill: { value: '#eee' } }
  if (fail === 'group') {
    update[g.r.pick(['width', 'x', 'fill'])] = failingEntry(g.r)
    g.used.add(fail)
  }
  const node: Spec = { type: 'group', name: `g${id}`, encode: { update }, marks }
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
  for (let i = g.r.between(0, 1) + (fail === 'axis' ? 1 : 0); i > 0; i--) axes.push(axis(g, own ? `s${id}` : undefined, false))
  for (let i = g.r.between(0, 1) + (fail === 'legend' ? 1 : 0); i > 0; i--) legends.push(legend(g, false))
  if (fail === 'axis') {
    axes[g.r.int(axes.length)] = axis(g, own ? `s${id}` : undefined, true)
    g.used.add(fail)
  }
  if (fail === 'legend') {
    legends[g.r.int(legends.length)] = legend(g, true)
    g.used.add(fail)
  }
  if (axes.length) node.axes = axes
  if (legends.length) node.legends = legends
  if (fail === 'title') {
    node.title = { text: 'T', encode: { [g.r.pick(['title', 'group'])]: { update: { dx: failingEntry(g.r) } } } }
    g.used.add(fail)
  } else if (g.r.chance(0.15)) node.title = { text: 'title' }
  return node
}

export function treeSpec(r: Rng): { spec: Spec; fails: Fail[]; label: string } {
  const total = r.between(2, 5)
  const seed = r.int(1 << 30) + 1
  // The nodes are numbered in generation order, and a failure is put on one of them: the tree is made twice, once to count them.
  const make = (fails: Map<number, Fail>): { marks: Spec[]; g: Gen } => {
    const g: Gen = { r: makeRng(seed), n: 0, fails, used: new Set(), rootScales: [] }
    const marks: Spec[] = []
    for (let i = 0; i < total; i++) marks.push(g.r.chance(0.55) ? group(g, 0, 't') : leaf(g, 't'))
    return { marks, g }
  }
  const nodes = make(new Map()).g.n
  const fails = new Map<number, Fail>()
  const count = process.env.ABORT_ONE ? 1 : r.between(1, 2)
  for (let i = 0; i < count; i++) fails.set(r.int(nodes), r.pick(FAILS))
  const { marks, g } = make(fails)
  const spec: Spec = {
    width: 130, height: 60, padding: 4, autosize: 'none',
    signals: [],
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
