/**
 * Generated specs for the live differentials of what `vega.parse` refuses before a view exists, built from the definitions of the pinned
 * vega (differential-transform-params.test.mts, differential-parse-errors.test.mts).
 *
 * - `transformSpec`: data sets and marks with transforms of every type, each written from its definition (the parameters it requires,
 *   others at random), with one or two of them spoiled at random: a required parameter left out, a list given as something else, a
 *   projection or a data set named that the scope does not have, a lookup without a literal `from`, sub-parameters (a force, a
 *   distribution) of no known kind, not in a list, or missing what they require.
 * - `referenceSpec`: the other names a spec refers to (the scale of an axis or a legend, a facet's name, data and groups, a signal pushed
 *   to an outer scope, the field a scale's domain is sorted by, the domain `domainMin` overrides), present or not, in nested scopes.
 */
import * as vega from 'vega'
import { TRANSFORM_TYPES, TUPLE_MAKING_TRANSFORMS } from '../../core/src/transform-names.ts'

type Spec = Record<string, unknown>
export interface Rand { next(): number; int(n: number): number; pick<T>(list: readonly T[]): T }

interface Param { name: string; type: string; array?: boolean; required?: boolean; length?: number; values?: unknown[]; expr?: boolean; params?: SubDef[] }
interface SubDef { key: Record<string, string>; params?: Param[] }
const definition = (type: string): { params: Param[] } => (vega as unknown as { definition(t: string): { params: Param[] } }).definition(type)

const chance = (r: Rand, p: number): boolean => r.next() < p

/** A value a parameter of that definition takes. */
function value(p: Param, r: Rand): unknown {
  const one = (): unknown => {
    switch (p.type) {
      case 'field': return r.pick(['a', 'b'])
      case 'number': return r.pick([1, 2, 5])
      case 'boolean': return r.pick([true, false])
      case 'string': return r.pick(['s1', 's2', 's3', 's4', 's5', 's6', 's7'])
      case 'enum': return p.values?.[0]
      case 'expr': return 'datum.a > 0'
      case 'compare': return { field: 'a' }
      case 'projection': return 'p'
      case 'data': return 'other'
      case 'date': return 0
      case 'array': return [0, 1]
      case 'signal': return { signal: 'sig' }
      case 'object': return { a: 1 }
      default: return 1
    }
  }
  if (p.type === 'param') return subValue(p, r)
  if (!p.array) return one()
  const n = p.length ?? r.pick([1, 2])
  if (p.type === 'string' && p.length) return Array.from({ length: n }, (_, i) => `o${i}`)
  return Array.from({ length: n }, one)
}

/** A sub-parameter object (or a list of them) of one of the kinds its definition has. */
function subValue(p: Param, r: Rand): unknown {
  const make = (): Spec => {
    const def = r.pick(p.params!)
    const o: Spec = { ...def.key }
    for (const q of def.params ?? []) if (q.required || chance(r, 0.3)) o[q.name] = value(q, r)
    return o
  }
  return p.array ? Array.from({ length: r.pick([1, 2]) }, make) : make()
}

/** One way to spoil a parameter of the transform, or undefined when there is none for it. */
function spoil(t: Spec, p: Param, r: Rand): string | undefined {
  if (p.type === 'index') {
    const how = r.pick(['missing', 'number', 'signal', 'dangling', 'mark', 'null'])
    if (how === 'missing') delete t.from
    else t.from = how === 'number' ? 3 : how === 'signal' ? { signal: "'other'" } : how === 'dangling' ? 'nope' : how === 'mark' ? 'm' : null
    return `from:${how}`
  }
  if (p.required && chance(r, 0.4)) { delete t[p.name]; return `drop ${p.name}` }
  if (p.type === 'param') {
    const how = r.pick(['scalar', 'kind', 'null-item', 'sub-required', 'sub-data'])
    if (how === 'scalar') t[p.name] = r.pick([1, 'x', { a: 1 }, ...(p.array ? [{ ...p.params![0]!.key }] : [[]])])
    else {
      const items = (Array.isArray(t[p.name]) ? t[p.name] : [t[p.name] ?? subValue(p, r)]) as Spec[]
      const at = r.int(items.length)
      if (how === 'kind') items[at] = { ...items[at], [Object.keys(p.params![0]!.key)[0]!]: 'nope' }
      else if (how === 'null-item') (items as unknown[])[at] = null
      else {
        const def = p.params!.find((d) => Object.entries(d.key).every(([k, v]) => items[at]![k] === v))
        const target = def?.params?.find((q) => (how === 'sub-required' ? q.required : q.type === 'data'))
        if (target === undefined) return undefined
        if (how === 'sub-required') delete items[at]![target.name]
        else items[at]![target.name] = 'nope'
      }
      t[p.name] = p.array ? items : items[0]
    }
    return `${p.name}:${how}`
  }
  if (p.type === 'projection') { t[p.name] = r.pick(['nope', 'x', 'c', { signal: "'p'" }, 7]); return `${p.name}:projection` }
  if (p.type === 'data') { t[p.name] = r.pick(p.array ? [['nope'], ['m'], ['other', 'nope'], 'other'] : ['nope', 'm', 'd']); return `${p.name}:data` }
  if (p.array) { t[p.name] = r.pick([1, 'x', null, { a: 1 }, true, { signal: '[1]' }]); return `${p.name}:list` }
  if (p.required) { delete t[p.name]; return `drop ${p.name}` }
  return undefined
}

/** A transform of that type written from its definition, with `spoils` of its parameters spoiled. */
function transform(type: string, r: Rand, spoils: number): { t: Spec; what: string[] } {
  const params = definition(type).params
  const t: Spec = { type: chance(r, 0.15) ? type.toUpperCase() : type }
  for (const p of params) {
    if (p.type === 'index') { t.from = 'other'; t.key = 'a' } else if (p.required || chance(r, 0.25)) t[p.name] = value(p, r)
  }
  const what: string[] = []
  for (let i = 0; i < spoils; i++) {
    const p = r.pick(params.length ? params : [{ name: 'none', type: 'none' }])
    const done = p.type === 'none' ? undefined : spoil(t, p, r)
    if (done !== undefined) what.push(done)
  }
  return { t, what }
}

const TYPES = [...TRANSFORM_TYPES]

/**
 * A spec whose data sets and marks hold transforms, a few of them spoiled. The scope has a projection `p`, scales `x` and `c`, the data
 * sets `d` and `other` (declared before the transforms that read them), a signal `sig`, and a mark named `m` (declared after the data
 * sets: a data set's transform cannot name it, a later mark's can).
 */
export function transformSpec(r: Rand): { spec: Spec; label: string } {
  const what: string[] = []
  const many = (n: number, mark: boolean): Spec[] => Array.from({ length: n }, () => {
    let type = r.pick(TYPES)
    // (a mark refuses the transforms that make or drop tuples: tested on their own, in the test above this one)
    if (mark) while (TUPLE_MAKING_TRANSFORMS.has(type)) type = r.pick(TYPES)
    const { t, what: w } = transform(type, r, chance(r, 0.25) ? 0 : chance(r, 0.8) ? 1 : 2)
    what.push(`${type}(${w.join(',')})`)
    return t
  })
  const where = r.pick(['data', 'data', 'group-data', 'mark', 'both'])
  const values = [{ a: 1, b: 2 }, { a: 2, b: 3 }]
  const spec: Spec = {
    width: 50, height: 50,
    signals: [{ name: 'sig', value: 1 }],
    projections: [{ name: 'p', type: 'mercator' }],
    scales: [{ name: 'x', type: 'linear', domain: [0, 1], range: [0, 1] }, { name: 'c', type: 'ordinal', domain: ['a'], range: ['red'] }],
    data: [{ name: 'd', values }, { name: 'other', values }],
    marks: [{ type: 'rect', name: 'm', from: { data: 'd' } }],
  }
  if (where === 'data' || where === 'both') (spec.data as Spec[]).push({ name: 't', source: 'd', transform: many(r.pick([1, 2, 3]), false) })
  if (where === 'group-data') (spec.marks as Spec[]).push({ type: 'group', data: [{ name: 'g', source: 'd', transform: many(r.pick([1, 2]), false) }] })
  if (where === 'mark' || where === 'both') (spec.marks as Spec[]).push({ type: r.pick(['symbol', 'group']), from: { data: 'd' }, transform: many(r.pick([1, 2]), true) })
  return { spec, label: `${where}: ${what.join(' ')}` }
}

const SCALES = ['x', 'c', 'p', 'nope', undefined] as const
const LEGEND_CHANNELS = ['size', 'shape', 'fill', 'stroke', 'strokeWidth', 'strokeDash', 'opacity'] as const

/** One scope's worth of references: axes and legends naming scales, groups faceting data, signals pushed out, scales sorting domains. */
function scope(r: Rand, depth: number, signals: readonly string[]): Spec {
  const out: Spec = {}
  const own: string[] = []
  if (chance(r, 0.5)) {
    out.signals = Array.from({ length: r.pick([1, 2]) }, (_, i) => {
      if (depth > 0 && chance(r, 0.4)) {
        // a signal that pushes to an outer scope must be one that scope declared, and say nothing of its own value
        const s: Spec = { name: chance(r, 0.6) && signals.length ? r.pick(signals) : 'nosig', push: 'outer' }
        if (chance(r, 0.2)) s[r.pick(['value', 'update', 'init', 'react', 'bind'])] = r.pick([1, 'sig + 1', true])
        return s
      }
      const name = `s${depth}${i}`
      own.push(name)
      return { name, value: 1 }
    })
  }
  if (chance(r, 0.4)) {
    out.scales = [{ name: `y${depth}`, type: r.pick(['ordinal', 'band', 'linear', 'point']), range: [0, 1],
      ...(chance(r, 0.7) ? { domain: { data: 'd', field: 'a', ...(chance(r, 0.6) ? { sort: r.pick([true, { op: 'sum' }, { op: 'count' }, { op: 'mean', field: 'b' }, { order: 'descending' }]) } : {}) } } : {}),
      ...(chance(r, 0.3) ? { [r.pick(['domainMin', 'domainMax'])]: 0 } : {}) }]
  }
  if (chance(r, 0.6)) out.axes = Array.from({ length: r.pick([1, 2]) }, () => ({ ...(chance(r, 0.9) ? { scale: r.pick(SCALES) } : {}), orient: r.pick(['bottom', 'left']) }))
  if (chance(r, 0.6)) {
    out.legends = Array.from({ length: r.pick([1, 2]) }, () => {
      const l: Spec = {}
      for (const c of LEGEND_CHANNELS) if (chance(r, 0.15)) l[c] = r.pick(SCALES)
      if (chance(r, 0.4)) l.fill = r.pick(SCALES)
      if (chance(r, 0.3)) l.title = 'legend'
      return l
    })
  }
  const marks: Spec[] = [{ type: 'rect', from: { data: 'd' } }]
  if (depth < 2 && chance(r, 0.6)) {
    const g: Spec = { type: 'group', ...scope(r, depth + 1, [...signals, ...own]) }
    if (chance(r, 0.5)) {
      const facet: Spec = {}
      if (chance(r, 0.8)) facet.name = `f${depth}`
      if (chance(r, 0.85)) facet.data = r.pick(['d', 'd', 'nope'])
      const by = r.int(4)
      if (by === 0) facet.groupby = 'a'
      else if (by === 1) facet.field = 'a'
      else if (by === 2) facet.groupby = ['a', 'b']
      g.from = { facet }
    }
    marks.push(g)
  }
  out.marks = marks
  return out
}

export function referenceSpec(r: Rand): Spec {
  const view = scope(r, 0, [])
  return {
    width: 50, height: 50,
    projections: [{ name: 'p', type: 'mercator' }],
    data: [{ name: 'd', values: [{ a: 1, b: 2 }] }],
    ...view,
    scales: [{ name: 'x', type: 'linear', domain: [0, 1], range: [0, 1] }, { name: 'c', type: 'ordinal', domain: ['a'], range: ['red'] }, ...((view.scales as Spec[] | undefined) ?? [])],
  }
}
