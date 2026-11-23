// @vitest-environment node
/**
 * A name a spec supplies (a field, a parameter, a dataset, a view, a style, a selection projection, a repeat field, an `as`, a
 * `usermeta` key ...) may be any string, including the ones a plain JavaScript object treats specially: `__proto__`,
 * `constructor`, `prototype`, `hasOwnProperty`. Every table the compiler keys by such a name must be prototype-safe.
 *
 * The test is generated and metamorphic. For every base spec below and every string it holds (as a value, as a key, or both), the
 * string is replaced everywhere by a benign name that sorts where the hostile one sorts (`<hostile>Q`). When that spec compiles, the
 * hostile name in the same places must compile too, write nothing to any built-in prototype, and give the same Vega with the
 * benign name swapped back: the compiler may not treat a name differently because of what an object's prototype holds.
 */
import { describe, it, expect } from 'vitest'
import { compile } from '../src/index.js'

const HOSTILE = ['__proto__', 'constructor', 'prototype', 'hasOwnProperty'] as const

const V = [{ a: 'A', b: 28, c: 'x', t: '2020-01-01' }, { a: 'B', b: 55, c: 'y', t: '2020-02-01' }]
type Spec = Record<string, unknown>
const BASES: Record<string, Spec> = {
  bar: {
    title: 'T', description: 'd', name: 'n', width: 200, height: { step: 10 }, usermeta: { k: 1 }, datasets: { d: V }, data: { name: 'd' },
    transform: [{ filter: { field: 'b', gt: 1 } }, { calculate: 'datum.b*2', as: 'b2' }, { bin: true, field: 'b', as: 'bb' }, { timeUnit: 'month', field: 't', as: 'm' }, { aggregate: [{ op: 'sum', field: 'b', as: 's' }], groupby: ['a', 'c'] }],
    mark: { type: 'bar', tooltip: true, style: 'sty' },
    encoding: {
      x: { field: 'a', type: 'nominal', sort: { field: 's', op: 'sum', order: 'descending' }, axis: { title: 'x', style: 'axsty' } },
      y: { field: 's', type: 'quantitative', stack: 'zero' },
      color: { field: 'c', type: 'nominal', legend: { title: 'L' }, condition: { test: 'datum.s > 3', value: 'red' } },
      tooltip: [{ field: 'a', type: 'nominal' }], order: { field: 's', sort: 'ascending' },
    },
    config: { style: { sty: { fill: 'red' }, axsty: { labelColor: 'blue' } } },
  },
  layer: {
    data: { values: V }, params: [{ name: 'p', value: 3, bind: { input: 'range', min: 0, max: 10, name: 'pn' } }],
    layer: [
      { mark: 'line', encoding: { x: { field: 't', type: 'temporal', timeUnit: 'yearmonth' }, y: { field: 'b', type: 'quantitative', aggregate: 'mean' } } },
      { mark: { type: 'text', dy: -5 }, encoding: { text: { field: 'b', type: 'quantitative', format: '.1f' }, x: { field: 't', type: 'temporal' }, y: { field: 'b', type: 'quantitative' } } },
      { mark: 'rule', encoding: { y: { datum: 30 } } },
    ],
    resolve: { scale: { y: 'independent' } }, encoding: { color: { field: 'c', type: 'nominal' } },
  },
  legendSelection: {
    data: { values: [{ b: 1, c: 'x' }] },
    params: [{ name: 'pt', select: { type: 'point', fields: ['c'] }, bind: 'legend' }],
    mark: 'point',
    encoding: { x: { field: 'b', type: 'quantitative' }, color: { condition: { param: 'pt', field: 'c', type: 'nominal' }, value: 'grey' } },
  },
  selections: {
    data: { values: V },
    params: [
      { name: 'brush', select: { type: 'interval', encodings: ['x'] }, value: { x: [1, 2] } },
      { name: 'pt', select: { type: 'point', fields: ['c'], on: 'mouseover', clear: 'mouseout', toggle: true }, bind: 'legend', value: [{ c: 'x' }] },
      { name: 'iv', select: { type: 'interval', encodings: ['y'], fields: ['b'] }, bind: 'scales' },
    ],
    mark: 'point',
    encoding: {
      x: { field: 'b', type: 'quantitative' }, y: { field: 'b', type: 'quantitative' },
      color: { condition: { param: 'brush', field: 'c', type: 'nominal', empty: false }, value: 'grey' },
      size: { condition: [{ param: 'pt', value: 3 }, { test: { field: 'b', lt: 3 }, value: 4 }], value: 1 },
    },
  },
  facet: {
    data: { values: V }, facet: { row: { field: 'c', type: 'nominal', header: { title: 'h' }, sort: 'descending' } },
    spec: { mark: 'point', encoding: { x: { field: 'b', type: 'quantitative' } } }, resolve: { scale: { x: 'independent' } },
  },
  wrap: { data: { values: V }, facet: { field: 'c', type: 'nominal' }, columns: 2, spec: { layer: [{ mark: 'bar', encoding: { x: { field: 'a', type: 'nominal' }, y: { field: 'b', type: 'quantitative' } } }, { mark: 'text', encoding: { x: { field: 'a', type: 'nominal' }, y: { field: 'b', type: 'quantitative' }, text: { field: 'b' } } }] } },
  concat: {
    data: { values: V },
    concat: [
      { name: 'left', mark: 'bar', encoding: { x: { field: 'a', type: 'nominal' } } },
      { repeat: ['b'], columns: 1, spec: { mark: 'point', encoding: { x: { field: { repeat: 'repeat' }, type: 'quantitative' } } } },
      { hconcat: [{ mark: 'arc', encoding: { theta: { field: 'b', type: 'quantitative' } } }] },
    ],
    columns: 2,
  },
  repeat: { data: { values: V }, repeat: { row: ['b'], column: ['a'] }, spec: { mark: 'point', encoding: { x: { field: { repeat: 'column' }, type: 'nominal' }, y: { field: { repeat: 'row' }, type: 'quantitative' } } } },
  layerRepeat: { data: { values: V }, repeat: { layer: ['b', 'a'] }, spec: { mark: 'line', encoding: { x: { field: 't', type: 'temporal' }, y: { field: { repeat: 'layer' }, type: 'quantitative' }, color: { datum: { repeat: 'layer' }, type: 'nominal' } } } },
  transforms: {
    data: { values: V, format: { type: 'json', parse: { t: 'date' } } },
    transform: [
      { window: [{ op: 'rank', as: 'r' }], sort: [{ field: 'b', order: 'descending' }], frame: [null, 0], groupby: ['c'] },
      { joinaggregate: [{ op: 'mean', field: 'b', as: 'mb' }], groupby: ['a'] },
      { stack: 'b', groupby: ['a'], as: ['s0', 's1'], offset: 'zero', sort: [{ field: 'c' }] },
      { fold: ['b', 'r'], as: ['k', 'v'] },
      { flatten: ['z'], as: ['zz'] },
      { pivot: 'c', value: 'b', groupby: ['a'], op: 'sum' },
      { impute: 'b', key: 'a', method: 'value', value: 0, groupby: ['c'] },
      { lookup: 'a', from: { data: { values: V }, key: 'a', fields: ['b'] }, as: ['q'] },
      { density: 'b', groupby: ['c'], as: ['dv', 'dd'] },
      { loess: 'b', on: 'b', as: ['lx', 'ly'] },
      { regression: 'b', on: 'b', as: ['rx', 'ry'] },
      { quantile: 'b', as: ['qp', 'qv'] },
      { extent: 'b', param: 'ex' },
    ],
    mark: 'point', encoding: { x: { field: 'b', type: 'quantitative' }, y: { field: 'r', type: 'quantitative' } },
  },
  lookupSelection: {
    data: { values: V },
    hconcat: [
      { params: [{ name: 'sel', select: { type: 'point', fields: ['a'] } }], mark: 'bar', encoding: { x: { field: 'a', type: 'nominal' }, y: { field: 'b', type: 'quantitative' } } },
      { transform: [{ filter: { param: 'sel' } }], mark: 'point', encoding: { x: { field: 'b', type: 'quantitative' }, y: { field: 'c', type: 'nominal' } } },
    ],
  },
  boxplot: { data: { values: V }, mark: { type: 'boxplot', extent: 1.5 }, encoding: { x: { field: 'a', type: 'nominal' }, y: { field: 'b', type: 'quantitative' } } },
  errorbar: { data: { values: V }, mark: { type: 'errorbar', extent: 'ci', ticks: true }, encoding: { x: { field: 'a', type: 'nominal' }, y: { field: 'b', type: 'quantitative' } } },
  facetedEncoding: { data: { values: V }, mark: 'bar', encoding: { x: { field: 'a', type: 'nominal' }, y: { field: 'b', type: 'quantitative', aggregate: 'sum' }, column: { field: 'c', type: 'nominal' } } },
  variableParams: {
    data: { values: V },
    params: [{ name: 'cut', value: 30, bind: { input: 'range', min: 0, max: 60 } }, { name: 'clr', expr: "cut > 20 ? 'red' : 'blue'" }],
    transform: [{ filter: 'datum.b > cut' }],
    mark: { type: 'bar', color: { expr: 'clr' } },
    encoding: { x: { field: 'a', type: 'nominal' }, y: { field: 'b', type: 'quantitative' } },
  },
  domainParam: {
    data: { values: V },
    vconcat: [
      { params: [{ name: 'zoom', select: { type: 'interval', encodings: ['x'] } }], mark: 'point', encoding: { x: { field: 'b', type: 'quantitative' } } },
      { mark: 'point', encoding: { x: { field: 'b', type: 'quantitative', scale: { domain: { param: 'zoom', encoding: 'x' } } } } },
    ],
  },
  guides: {
    data: { values: V },
    title: { text: 'T', subtitle: 'S', color: 'red' },
    mark: 'bar',
    encoding: {
      x: { field: 'a', type: 'nominal', axis: { title: 'x', labelColor: 'red', zindex: 1 }, header: { title: 'h' } },
      y: { field: 'b', type: 'quantitative', axis: { grid: false, tickCount: 3 } },
      color: { field: 'c', type: 'nominal', legend: { orient: 'bottom', labelColor: 'red', symbolType: 'square' } },
      size: { field: 'b', type: 'quantitative', legend: { gradientLength: 30, symbolLimit: 3 } },
      column: { field: 'c', type: 'nominal', header: { labelColor: 'red', titleColor: 'blue' } },
    },
    config: {
      axis: { labelFont: 'serif' }, axisX: { tickColor: 'red' }, legend: { labelFont: 'serif' }, header: { labelFont: 'serif' },
      range: { category: ['red', 'blue'], ramp: { scheme: 'blues' } }, view: { stroke: 'red' }, mark: { opacity: 0.5 }, title: { anchor: 'start', color: 'red' },
      bar: { cornerRadius: 2 }, boxplot: { box: { color: 'red' }, median: { color: 'black' } },
    },
  },
  layeredLegends: {
    data: { values: V },
    layer: [
      { mark: 'point', encoding: { x: { field: 'b', type: 'quantitative', axis: { title: 'one', labelColor: 'red' } }, color: { field: 'c', type: 'nominal', legend: { labelColor: 'red' } } } },
      { mark: 'line', encoding: { x: { field: 'b', type: 'quantitative', axis: { tickColor: 'blue' } }, color: { field: 'c', type: 'nominal', legend: { titleColor: 'blue' } } } },
    ],
  },
  bindings: {
    data: { values: V },
    params: [
      { name: 'pick', select: { type: 'point', fields: ['c', 'a'] }, bind: { c: { input: 'select', options: ['x', 'y'] }, a: { input: 'radio', options: ['A', 'B'] } }, value: [{ c: 'x', a: 'A' }] },
    ],
    mark: 'point',
    encoding: { x: { field: 'b', type: 'quantitative' }, opacity: { condition: { param: 'pick', value: 1 }, value: 0.2 } },
  },
  namedDatasets: {
    datasets: { left: V, right: [{ a: 'A', w: 3 }] },
    data: { name: 'left' },
    transform: [{ lookup: 'a', from: { data: { name: 'right' }, key: 'a', fields: ['w'] } }, { calculate: 'datum.w * 2', as: 'w2' }],
    mark: 'bar',
    encoding: { x: { field: 'a', type: 'nominal' }, y: { field: 'w2', type: 'quantitative' } },
  },
  namedViews: {
    data: { values: V }, name: 'root',
    vconcat: [
      { name: 'top', mark: 'bar', encoding: { x: { field: 'a', type: 'nominal' }, y: { field: 'b', type: 'quantitative', aggregate: 'sum' } } },
      { name: 'bottom', layer: [{ name: 'pts', mark: 'point', encoding: { x: { field: 't', type: 'temporal' }, y: { field: 'b', type: 'quantitative' } } }, { mark: 'rule', encoding: { y: { field: 'b', aggregate: 'mean', type: 'quantitative' } } }] },
    ],
  },
  sortsAndPredicates: {
    data: { values: V },
    transform: [{ filter: { and: [{ field: 'b', range: [0, 100] }, { field: 'a', oneOf: ['A', 'B'] }, { not: { field: 'c', equal: 'z' } }] } }],
    mark: 'bar',
    encoding: {
      x: { field: 'a', type: 'ordinal', sort: ['B', 'A'] },
      y: { field: 'b', type: 'quantitative', aggregate: 'max' },
      color: { field: 'c', type: 'nominal', sort: { field: 'b', op: 'mean' }, scale: { domain: ['x', 'y'], range: ['red', 'blue'] } },
      opacity: { condition: { test: { field: 't', timeUnit: 'month', equal: 1 }, value: 1 }, value: 0.5 },
    },
  },
}

/** Rows (a `data.values`, a `datasets` entry) are the user's data, not the spec: compile carries them as they are. */
const isRows = (parentKey: string, key: string): boolean => (parentKey === 'data' && key === 'values') || parentKey === 'datasets'

/** Replace every occurrence of `from` (a whole string value, an object key, or both) by `to`, outside the rows. */
function substitute(node: unknown, from: string, to: string, where: 'values' | 'keys' | 'both', parentKey = ''): unknown {
  if (typeof node === 'string') return node === from && where !== 'keys' ? to : node
  if (Array.isArray(node)) return node.map((n) => substitute(n, from, to, where, parentKey))
  if (node === null || typeof node !== 'object') return node
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(node)) {
    const key = k === from && where !== 'values' ? to : k
    // (an own `__proto__` key, as JSON.parse makes it)
    Object.defineProperty(out, key, { value: isRows(parentKey, k) ? v : substitute(v, from, to, where, k), enumerable: true, writable: true, configurable: true })
  }
  return out
}

/** Every place a string stands (a value or a key) outside the rows: the path to it, and whether it is the key there. */
type Occurrence = { path: Array<string | number>; key: boolean }
function occurrences(node: unknown, parentKey = '', path: Array<string | number> = []): Occurrence[] {
  if (typeof node === 'string') return [{ path, key: false }]
  if (Array.isArray(node)) return node.flatMap((n, i) => occurrences(n, parentKey, [...path, i]))
  if (node === null || typeof node !== 'object') return []
  return Object.entries(node).flatMap(([k, v]) => [{ path: [...path, k], key: true }, ...(isRows(parentKey, k) ? [] : occurrences(v, k, [...path, k]))])
}

/** The spec with the one string at `at` replaced by `to`. */
function substituteOne(node: unknown, at: Occurrence, to: string, depth = 0): unknown {
  if (depth === at.path.length) return at.key ? node : to
  const step = at.path[depth]!
  if (Array.isArray(node)) return node.map((n, i) => (i === step ? substituteOne(n, at, to, depth + 1) : n))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    const here = k === step
    const key = here && at.key && depth === at.path.length - 1 ? to : k
    Object.defineProperty(out, key, { value: here ? substituteOne(v, at, to, depth + 1) : v, enumerable: true, writable: true, configurable: true })
  }
  return out
}

function candidates(spec: unknown): Set<string> {
  const out = new Set<string>()
  const walk = (n: unknown, parentKey: string): void => {
    if (typeof n === 'string') out.add(n)
    else if (Array.isArray(n)) n.forEach((x) => walk(x, parentKey))
    else if (n !== null && typeof n === 'object') {
      for (const [k, v] of Object.entries(n)) {
        out.add(k)
        if (!isRows(parentKey, k)) walk(v, k)
      }
    }
  }
  walk(spec, '')
  return out
}

/** Where two compiled specs first differ, with some context. */
function firstDifference(a: string, b: string): string {
  let i = 0
  while (i < a.length && a[i] === b[i]) i++
  return `at ${i}: got …${a.slice(Math.max(0, i - 60), i + 60)}… want …${b.slice(Math.max(0, i - 60), i + 60)}…`
}

const PROTOTYPES: ReadonlyArray<[string, object]> = [
  ['Object.prototype', Object.prototype], ['Array.prototype', Array.prototype], ['Function.prototype', Function.prototype],
  ['String.prototype', String.prototype], ['Number.prototype', Number.prototype], ['Boolean.prototype', Boolean.prototype],
]
function prototypeState(): string {
  return PROTOTYPES.map(([n, p]) => `${n}:${Reflect.ownKeys(p).map((k) => {
    const d = Object.getOwnPropertyDescriptor(p, k)!
    const v: unknown = d.value
    const shown = typeof v === 'function' ? `function ${v.name}` : v !== null && typeof v === 'object' ? 'object' : String(v)
    return `${String(k)}=${'get' in d ? 'accessor' : shown}`
  }).join(',')}`).join('\n')
}

/** Undo what a failing compile wrote to a prototype, so one failure does not mask the next spec's result. */
function restorePrototypes(snapshot: ReadonlyArray<ReadonlySet<PropertyKey>>): void {
  PROTOTYPES.forEach(([, p], i) => {
    for (const k of Reflect.ownKeys(p)) if (!snapshot[i]!.has(k)) delete (p as Record<PropertyKey, unknown>)[k]
  })
}

function tryCompile(spec: unknown): string | undefined {
  try {
    return JSON.stringify(compile(spec as Spec))
  } catch {
    return undefined
  }
}

describe('names that a plain object treats specially are names like any other', () => {
  for (const [label, base] of Object.entries(BASES)) {
    it(`${label}: every string, as a value, a key or both, can be ${HOSTILE.join(' / ')}`, () => {
      expect(tryCompile(base), 'the base spec compiles').toBeDefined()
      const before = prototypeState()
      const keys = PROTOTYPES.map(([, p]) => new Set(Reflect.ownKeys(p)))
      let compared = 0
      const failures: string[] = []
      const original = tryCompile(base)
      // (each string everywhere it stands - a dataset's name and the references to it, a field and every read of it - then each
      // place alone)
      const variants: Array<[string, (to: string) => unknown]> = []
      for (const name of candidates(base)) {
        for (const where of ['values', 'keys', 'both'] as const) variants.push([`${JSON.stringify(name)} (${where})`, (to) => substitute(base, name, to, where)])
      }
      for (const at of occurrences(base)) variants.push([`${at.key ? 'the key' : 'the value'} at ${at.path.join('.')}`, (to) => substituteOne(base, at, to)])
      for (const [name, make] of variants) {
        {
          for (const hostile of HOSTILE) {
            const benign = `${hostile}Q`
            const expected = tryCompile(make(benign))
            if (expected === undefined || expected === original) continue
            const hostileSpec = make(hostile)
            let got: string | undefined
            let error: unknown
            try {
              got = JSON.stringify(compile(hostileSpec as Spec))
            } catch (e) {
              error = e
            }
            const after = prototypeState()
            if (after !== before) {
              failures.push(`${name} -> ${hostile}: a built-in prototype changed`)
              restorePrototypes(keys)
              continue
            }
            compared++
            const want = expected.split(benign).join(hostile)
            if (got !== want) failures.push(`${name} -> ${hostile}: ${error ? `throws ${String(error)}` : `compiles to different Vega ${firstDifference(got!, want)}`}`)
          }
        }
      }
      expect(prototypeState()).toBe(before)
      expect(compared, 'positions compared').toBeGreaterThan(20)
      expect(failures).toEqual([])
    }, 120_000)
  }
})
