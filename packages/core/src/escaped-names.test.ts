/**
 * A name in an expression may be spelled with `\uXXXX` escapes (an escaped `data` calls `data`, an escaped `k` reads the signal `k`), as
 * vega's lexer reads them. Whatever reads names in the text of an expression to tell what it depends on -- the order of the datasets
 * and the signals, what a change affects, what a random site read, what a late signal took with it, the keys of kept results -- must
 * find them so spelled. The oracle: the same spec with every name of every expression spelled with escapes evaluates, step by step,
 * to the scene the plain spec makes, and to a fresh evaluation.
 */
import { describe, expect, it } from 'vitest'
import './addon-transforms.js'
import './addon-geo.js'
import { compileChart } from './compiler.js'
import { evaluateChart } from './evaluate.js'
import { createChartSession } from './session.js'
import { datasetsOfScene, renderSceneToSvg } from './index.js'
import type { RuntimeInput, SceneRoot, VgSpec } from './types.js'

type Row = Record<string, unknown>
const BS = String.fromCharCode(92)

/** `text` with every name (outside string literals, numbers and the keywords) spelled with escapes, one per character. */
function escapeNames(text: string): string {
  const keep = new Set(['true', 'false', 'null', 'if', 'this'])
  let out = ''
  let i = 0
  while (i < text.length) {
    const c = text[i]!
    if (c === '"' || c === "'") {
      let j = i + 1
      while (j < text.length && text[j] !== c) j += text[j] === BS ? 2 : 1
      out += text.slice(i, j + 1)
      i = j + 1
      continue
    }
    const num = /^(?:0[xX][0-9a-fA-F]+|\d*\.?\d+(?:[eE][+-]?\d+)?)/.exec(text.slice(i))
    if (/[0-9.]/.test(c) && num && num[0].length) { out += num[0]; i += num[0].length; continue }
    const id = /^[A-Za-z_$][\w$]*/.exec(text.slice(i))
    if (id) {
      out += keep.has(id[0]) ? id[0] : [...id[0]].map((ch) => `${BS}u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`).join('')
      i += id[0].length
      continue
    }
    out += c
    i++
  }
  return out
}

/** The spec with every expression's names escaped: `expr`, `test`, `update`, `init` strings, and a `{signal}` that is no transform's output. */
function escapedSpec(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(escapedSpec)
  if (v === null || typeof v !== 'object') return v
  const o = v as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const [k, x] of Object.entries(o)) {
    const expression = typeof x === 'string' && (['expr', 'test', 'update', 'init'].includes(k) || (k === 'signal' && o.type === undefined))
    out[k] = expression ? escapeNames(x as string) : escapedSpec(x)
  }
  return out
}

const SKIP_KEYS = new Set(['runtime', 'compiled', '__scaleMap', '__gen', '__itemGen', '__domDesc', '__source'])
function norm(v: unknown, depth = 0): unknown {
  if (depth > 40) return '[deep]'
  if (v === undefined || v === null || typeof v === 'string' || typeof v === 'boolean') return v
  if (typeof v === 'number') return Number.isNaN(v) ? '[NaN]' : v
  if (typeof v === 'function') return '[fn]'
  if (v instanceof Map || v instanceof Set) return '[collection]'
  if (Array.isArray(v)) return v.map((x) => { const n = norm(x, depth + 1); return n === undefined ? null : n })
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(v as object).sort()) {
    if (SKIP_KEYS.has(k)) continue
    const n = norm((v as Record<string, unknown>)[k], depth + 1)
    if (n !== undefined) out[k] = n
  }
  return out
}
const view = (s: SceneRoot): unknown => ({ scene: norm(s), svg: renderSceneToSvg(s) })

const mulberry = (seed: number): (() => number) => { let a = seed; return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }
const quiet = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} }

interface Case { what: string; spec: VgSpec; steps: RuntimeInput[]; random?: boolean; fresh?: boolean; escaped?: VgSpec; check?: (scene: SceneRoot, step: number) => void }

const ROWS: Row[] = Array.from({ length: 8 }, (_, i) => ({ v: i, w: (i * 3) % 8, g: `g${i % 2}` }))
const frame = { width: 120, height: 60, autosize: 'none' }
const dots = (data: string, x = 'datum.v', extra: Record<string, unknown> = {}): Record<string, unknown> => ({ type: 'symbol', from: { data }, encode: { update: { x: { signal: x }, y: { value: 5 }, ...extra } } })

const CASES: Case[] = [
  {
    // (a site that draws is fingerprinted by the signals it names: `k` moves, the formula draws again)
    what: 'a random site, by the signals it reads',
    spec: { ...frame, signals: [{ name: 'k', value: 1 }, { name: 'u', value: 0 }], data: [{ name: 't', transform: [{ type: 'formula', as: 'r', expr: 'random() * k' }] }], marks: [dots('t', 'datum.r * 100')] } as unknown as VgSpec,
    steps: [{ data: { t: ROWS }, signals: { k: 1, u: 0 } }, { data: { t: ROWS }, signals: { k: 2, u: 0 } }, { data: { t: ROWS }, signals: { k: 2, u: 1 } }, { data: { t: ROWS }, signals: { k: 3, u: 1 } }],
    random: true, fresh: false,
  },
  {
    // (a signal that draws is drawn once per run of what it reads, however often an evaluation resolves it: the tape replays it)
    what: 'a signal that draws',
    spec: { ...frame, signals: [{ name: 'u', value: 0 }, { name: 'n', update: "length(data('t'))" }, { name: 'r', update: 'random()' }], data: [{ name: 't' }], marks: [{ type: 'rect', encode: { update: { x: { signal: 'r * 100' }, width: { value: 2 }, height: { value: 2 } } } }] } as unknown as VgSpec,
    steps: [{ data: { t: ROWS }, signals: { u: 0 } }, { data: { t: ROWS }, signals: { u: 1 } }, { data: { t: ROWS.slice(1) }, signals: { u: 1 } }],
    random: true, fresh: false,
  },
  {
    // (the same site with only the signal escaped: the fingerprint of what it read holds the signal)
    what: 'a random site, by a signal it names with escapes',
    spec: { ...frame, signals: [{ name: 'k', value: 1 }, { name: 'n', update: "length(data('t'))" }, { name: 'r', update: 'random() * k' }], data: [{ name: 't' }], marks: [{ type: 'rect', encode: { update: { x: { signal: 'r * 10' }, width: { value: 2 }, height: { value: 2 } } } }] } as unknown as VgSpec,
    escaped: { ...frame, signals: [{ name: 'k', value: 1 }, { name: 'n', update: "length(data('t'))" }, { name: 'r', update: `random() * ${BS}u006b` }], data: [{ name: 't' }], marks: [{ type: 'rect', encode: { update: { x: { signal: 'r * 10' }, width: { value: 2 }, height: { value: 2 } } } }] } as unknown as VgSpec,
    steps: [{ data: { t: ROWS }, signals: { k: 1 } }, { data: { t: ROWS }, signals: { k: 2 } }, { data: { t: ROWS }, signals: { k: 3 } }],
    random: true, fresh: false,
  },
  {
    // (the filter reads `t` by name: a change of `t` is a change of `d`, and of the mark drawn from it)
    what: 'a dataset read by name in a filter',
    spec: { ...frame, data: [{ name: 't' }, { name: 'u' }, { name: 'd', source: 'u', transform: [{ type: 'filter', expr: "indata('t', 'v', datum.w)" }] }], marks: [dots('d', 'datum.w')] } as unknown as VgSpec,
    steps: [{ data: { t: ROWS.slice(0, 3), u: ROWS } }, { data: { t: ROWS.slice(0, 6), u: ROWS } }, { data: { t: ROWS.slice(2, 4), u: ROWS } }],
  },
  {
    // (`n` reads the store; `d` reads `n`: the store is built first, and `n` resolved, before `d`)
    what: 'a dataset that reads a signal that reads data',
    spec: { ...frame, signals: [{ name: 'n', update: "length(data('store'))" }], data: [{ name: 't' }, { name: 'd', source: 't', transform: [{ type: 'filter', expr: 'datum.v < n' }] }, { name: 'store' }], marks: [dots('d')] } as unknown as VgSpec,
    steps: [{ data: { t: ROWS, store: [{ a: 1 }, { a: 2 }] } }, { data: { t: ROWS, store: [{ a: 1 }, { a: 2 }, { a: 3 }] } }],
  },
  {
    // (a later signal read by an earlier one: they are resolved in the order of what they read)
    what: 'signals that read signals declared after them',
    spec: { ...frame, signals: [{ name: 'a', update: 'b * 2' }, { name: 'b', update: 'c + 1' }, { name: 'c', value: 1 }], marks: [{ type: 'rect', encode: { update: { x: { signal: 'a' }, width: { value: 2 }, height: { value: 2 } } } }] } as unknown as VgSpec,
    steps: [{ signals: { c: 1 } }, { signals: { c: 4 } }],
  },
  {
    // (a row-wise formula that reads a hierarchy is not row-local: a change of the tree moves every row)
    what: 'a formula that reads a hierarchy',
    spec: { ...frame, data: [{ name: 'tree', transform: [{ type: 'stratify', key: 'id', parentKey: 'parent' }] }, { name: 'p', transform: [{ type: 'formula', as: 'depth', expr: "length(treePath('tree', datum.id, 1))" }] }], marks: [dots('p', 'datum.depth * 10')] } as unknown as VgSpec,
    steps: [
      { data: { tree: [{ id: 1 }, { id: 2, parent: 1 }, { id: 3, parent: 1 }], p: [{ id: 2 }, { id: 3 }] } },
      { data: { tree: [{ id: 1 }, { id: 2, parent: 1 }, { id: 3, parent: 2 }], p: [{ id: 2 }, { id: 3 }] }, dataChanges: { tree: [2] } },
      // (the rows of `p` change with the tree: the rows that did not change read the new tree too)
      { data: { tree: [{ id: 1 }, { id: 2, parent: 1 }, { id: 3, parent: 1 }], p: [{ id: 2 }, { id: 3 }, { id: 1 }] }, dataPulse: { tree: { changed: [2] }, p: { appendOnly: true, baseLength: 2, changed: [] } } },
    ],
  },
  {
    // (a filter that reads a scale runs after the scale; numbered rows after it are numbered after the ones of `b`)
    what: 'a filter that reads a scale, numbered rows after it',
    spec: {
      ...frame, signals: [{ name: 'u', value: 0 }],
      scales: [{ name: 'x', type: 'linear', domain: { data: 't', field: 'v' }, range: [0, 100] }],
      data: [{ name: 't' }, { name: 'a', source: 't', transform: [{ type: 'filter', expr: "scale('x', datum.v) > 50" }, { type: 'identifier', as: 'id' }] }, { name: 'b', transform: [{ type: 'identifier', as: 'id' }] }],
      marks: [dots('a', 'datum.id'), dots('b', 'datum.id')],
    } as unknown as VgSpec,
    steps: [{ data: { t: ROWS, b: [{ w: 1 }, { w: 2 }] }, signals: { u: 0 } }, { data: { t: ROWS, b: [{ w: 1 }, { w: 2 }, { w: 3 }] }, signals: { u: 1 } }],
    fresh: false,
  },
  {
    // (a signal ranked after the data throws: what reads it, by any spelling, did not run)
    what: 'a late signal that throws',
    spec: {
      ...frame, signals: [{ name: 'bad', update: "length(data('t')) > 3 ? null[0] : 1" }, { name: 'ok', update: 'bad + 1' }],
      data: [{ name: 't' }],
      marks: [dots('t', 'ok * 10 + datum.v'), dots('t', 'datum.v')],
    } as unknown as VgSpec,
    steps: [{ data: { t: ROWS.slice(0, 2) }, logger: quiet }, { data: { t: ROWS }, logger: quiet }],
  },
  {
    // (an `init` that reads data runs once the data is built, not before: it runs once)
    what: 'an init that reads data',
    spec: { ...frame, signals: [{ name: 'first', init: "length(data('t'))" }], data: [{ name: 't' }], marks: [{ type: 'rect', encode: { update: { x: { signal: 'first' }, width: { value: 2 }, height: { value: 2 } } } }] } as unknown as VgSpec,
    steps: [{ data: { t: ROWS } }],
  },
  {
    // (an `init` that reads a scale runs once the scales are built)
    what: 'an init that reads a scale',
    spec: { ...frame, signals: [{ name: 'first', init: "length(domain('x')) + domain('x')[1]" }], data: [{ name: 't' }], scales: [{ name: 'x', type: 'linear', domain: { data: 't', field: 'v' }, range: [0, 100], zero: false }], marks: [{ type: 'rect', encode: { update: { x: { signal: 'first' }, width: { value: 2 }, height: { value: 2 } } } }] } as unknown as VgSpec,
    steps: [{ data: { t: ROWS } }],
  },
  {
    // (a signal ranked after the dataset it reads writes it with `setdata` once the dataset ran: the pulse is lost, as in vega)
    what: 'setdata from a signal that reads the dataset',
    spec: { ...frame, signals: [{ name: 'w', update: "length(data('t')) + setdata('t', [{v: 9}])" }], data: [{ name: 't' }], marks: [dots('t')] } as unknown as VgSpec,
    steps: [{ data: { t: ROWS.slice(0, 3) } }],
    check: (scene) => expect(datasetsOfScene(scene).get('t')?.length).toBe(3),
  },
  {
    // (a dataset that reads a signal another dataset's extent writes is built after it, wherever it is declared)
    what: 'a reader of an extent declared before the writer',
    spec: {
      ...frame,
      data: [
        { name: 'seq', transform: [{ type: 'sequence', start: { signal: 'ext[0]' }, stop: { signal: 'ext[1] + 1' }, as: 'v' }] },
        { name: 'base', values: [{ x: 3 }, { x: 9 }, { x: 5 }], transform: [{ type: 'extent', field: 'x', signal: 'ext' }] },
      ],
      marks: [dots('seq')],
    } as unknown as VgSpec,
    steps: [{ logger: quiet }],
  },
  {
    // (a projection that fits a dataset declared after the one that projects with it builds that dataset first)
    what: 'a projection fit to a dataset',
    spec: {
      ...frame,
      projections: [{ name: 'p', type: 'mercator', fit: { signal: "data('shapes')" }, size: [120, 60] }],
      data: [
        { name: 'src', values: [{ lon: 0, lat: 0 }, { lon: 10, lat: 5 }] },
        { name: 'pos', source: 'src', transform: [{ type: 'geopoint', projection: 'p', fields: ['lon', 'lat'] }] },
        { name: 'shapes', values: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[-20, -10], [20, -10], [20, 10], [-20, 10], [-20, -10]]] } }] },
      ],
      marks: [dots('pos', 'datum.x')],
    } as unknown as VgSpec,
    steps: [{ logger: quiet }],
  },
  {
    // (a dataset downstream of others draws: which build takes a pulse decides which numbers the source hands out)
    what: 'a dataset that draws, downstream of a pulse',
    spec: {
      ...frame, signals: [{ name: 'u', value: 0 }, { name: 'n', update: "length(data('store'))" }],
      data: [{ name: 'store' }, { name: 't' }, { name: 'd', source: 't', transform: [{ type: 'formula', as: 'w', expr: 'datum.v * 2' }] }, { name: 'r', source: 'd', transform: [{ type: 'formula', as: 'z', expr: 'random()' }] }],
      marks: [dots('r', 'datum.z * 100')],
    } as unknown as VgSpec,
    steps: [0, 1, 2, 3].map((i) => ({ data: { t: [...ROWS, ...ROWS.slice(0, i)], store: [] }, signals: { u: i } })),
    random: true, fresh: false,
  },
  {
    // (a mark's transform that draws is made again with the mark, from the same inputs: the tape replays its numbers)
    what: 'a mark transform that draws',
    spec: { ...frame, signals: [{ name: 'u', value: 0 }], data: [{ name: 't' }], marks: [{ type: 'symbol', from: { data: 't' }, transform: [{ type: 'formula', as: 'z', expr: 'random() + u * 0' }], encode: { update: { x: { field: 'v' }, y: { value: 5 } } } }] } as unknown as VgSpec,
    steps: [0, 1, 2].map((u) => ({ data: { t: ROWS }, signals: { u } })),
    random: true, fresh: false,
  },
  {
    // (signals that draw, resolved in the order of what they read: `b` draws before `a`, which reads it)
    what: 'signals that draw, in the order they read each other',
    spec: { ...frame, signals: [{ name: 'a', update: 'random() + b * 0' }, { name: 'b', update: 'random()' }], marks: [{ type: 'rect', encode: { update: { x: { signal: 'a * 100' }, x2: { signal: 'b * 100' }, height: { value: 2 } } } }] } as unknown as VgSpec,
    steps: [{}],
    random: true, fresh: false,
  },
  {
    // (a sequence that stops at a signal that reads data is built once the data it reads is)
    what: 'a sequence that stops at a signal that reads data',
    spec: { ...frame, signals: [{ name: 'n', update: "length(data('store'))" }], data: [{ name: 'seq', transform: [{ type: 'sequence', start: 0, stop: { signal: 'n' }, as: 'v' }] }, { name: 'store' }], marks: [dots('seq')] } as unknown as VgSpec,
    steps: [{ data: { store: [{ a: 1 }, { a: 2 }, { a: 3 }] }, logger: quiet }],
    check: (scene) => expect(datasetsOfScene(scene).get('seq')?.length).toBe(3),
  },
  {
    // (a react: false signal that reads a signal reading the scale it feeds sees that signal's initial value: vega's ranks)
    what: 'a react: false signal in a cycle through a scale',
    spec: {
      ...frame,
      signals: [{ name: 'computed', update: "domain('c')" }, { name: 'cd', react: false, update: 'computed' }],
      data: [{ name: 'src', values: [{ o: 'USA' }, { o: 'Japan' }, { o: 'Europe' }] }],
      scales: [{ name: 'c', type: 'ordinal', domain: { signal: 'cd' }, range: [0, 10, 20] }],
      marks: [dots('src', "scale('c', datum.o)")],
    } as unknown as VgSpec,
    steps: [{}],
    check: (scene) => expect((scene as unknown as { __scaleMap: Map<string, { domain(): unknown[] }> }).__scaleMap.get('c')!.domain()).toEqual(['USA', 'Japan', 'Europe']),
  },
  {
    // (a mark reads a scale by a call: the scale made again from new rows is the one it reads)
    what: 'a mark that reads a scale by a call',
    spec: { ...frame, data: [{ name: 'pts' }, { name: 'dom' }], scales: [{ name: 'x', type: 'linear', domain: { data: 'dom', field: 'v' }, range: [0, 100] }], marks: [dots('pts', "scale('x', datum.v)")] } as unknown as VgSpec,
    steps: [{ data: { pts: ROWS, dom: [{ v: 0 }, { v: 8 }] } }, { data: { pts: ROWS, dom: [{ v: 0 }, { v: 16 }] }, changedDatasets: ['dom'] }],
  },
]

describe('names spelled with escapes are the names they spell', () => {
  for (const c of CASES) {
    it(c.what, () => {
      const escaped = c.escaped ?? (escapedSpec(c.spec) as VgSpec)
      expect(JSON.stringify(escaped), 'the spec is spelled otherwise').not.toBe(JSON.stringify(c.spec))
      const plain = createChartSession()
      const other = createChartSession()
      const ra = mulberry(11)
      const rb = mulberry(11)
      for (const [i, step] of c.steps.entries()) {
        const a = plain.evaluate(c.spec, { ...step, ...(c.random ? { random: ra } : {}) })
        const b = other.evaluate(escaped, { ...step, ...(c.random ? { random: rb } : {}) })
        expect(view(b), `${c.what}: step ${i}`).toEqual(view(a))
        if (c.fresh !== false) expect(view(a), `${c.what}: step ${i}, fresh`).toEqual(view(evaluateChart(compileChart(c.spec), step)))
        c.check?.(b, i)
      }
    })
  }
})
