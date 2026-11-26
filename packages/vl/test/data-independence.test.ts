// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { compile } from '../src/index.js'
import { compileUnit } from '../src/compile.js'
import type { VLSpec } from '../src/index.js'

// What a Vega-Lite spec compiles to depends on its structure, not on its rows: compiling reads no row of an inline `data.values`
// or of a `datasets` entry, so it costs the same for 3 rows as for 6,000. The rows travel to the output by reference; the
// output gets its own top-level array for each (one shallow copy, which reads the array's slots and no row).
// The reads that ARE required: whether two views' equal-but-distinct inline data are one dataset (compared row by row, stopping
// at the first difference) and the name of an anonymous lookup source (named after its content).

interface Counter { rowReads: number; slotReads: number; otherArrayReads: number; writes: number }

/** Rows whose every field read is counted, in an array whose every slot read is counted. Writes throw. */
function counted(rows: Array<Record<string, unknown>>, c: Counter): unknown[] {
  const tracked = rows.map((r) => new Proxy(r, {
    get(t, k, rcv) { if (typeof k === 'string') c.rowReads++; return Reflect.get(t, k, rcv) },
    ownKeys(t) { c.rowReads++; return Reflect.ownKeys(t) },
    getOwnPropertyDescriptor(t, k) { c.rowReads++; return Reflect.getOwnPropertyDescriptor(t, k) },
    set() { c.writes++; throw new TypeError('row write') },
    defineProperty() { c.writes++; throw new TypeError('row write') },
    deleteProperty() { c.writes++; throw new TypeError('row write') },
  }))
  return new Proxy(tracked, {
    get(t, k, rcv) {
      if (typeof k === 'string' && /^\d+$/.test(k)) c.slotReads++
      else if (k !== 'length' && k !== 'constructor' && k !== 'slice' && k !== 'toJSON') c.otherArrayReads++
      return Reflect.get(t, k, rcv)
    },
    set() { c.writes++; throw new TypeError('array write') },
    defineProperty() { c.writes++; throw new TypeError('array write') },
    deleteProperty() { c.writes++; throw new TypeError('array write') },
  })
}

const sample = (n: number): Array<Record<string, unknown>> =>
  Array.from({ length: n }, (_, i) => ({ k: `k${i % 4}`, g: i % 2 ? 'a' : 'b', x: i, y: (i * 7) % 11, t: `2024-01-${1 + (i % 28)}` }))

/**
 * Every payload slot of a spec (data.values, from.data.values, datasets entries) replaced by a counted array of about n rows. Each
 * payload has its own length, so no two are equal and telling them apart reads no row.
 */
function withCounted(spec: unknown, c: Counter, n: number): { spec: VLSpec; payloads: number; slots: number } {
  let payloads = 0
  let slots = 0
  const walk = (v: unknown, parentKey: string, key: string): unknown => {
    if (Array.isArray(v) && ((parentKey === 'data' && key === 'values') || parentKey === 'datasets')) {
      const rows = sample(n + payloads++)
      slots += rows.length
      return counted(rows, c)
    }
    if (Array.isArray(v)) return v.map((x) => walk(x, key, ''))
    if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, key, k)]))
    return v
  }
  const out = walk(spec, '', '') as VLSpec
  return { spec: out, payloads, slots }
}

const xy = { x: { field: 'x', type: 'quantitative' }, y: { field: 'y', type: 'quantitative' } }
const D = { values: [] as unknown[] }
/** One spec per shape whose rows are each its own (no two views share equal rows): no read of a row is required. */
const shapes: Record<string, unknown> = {
  unit: { data: D, mark: 'point', encoding: xy },
  namedUnit: { data: { name: 'table', values: [] }, mark: 'bar', encoding: { x: { field: 'k', type: 'nominal' }, y: { aggregate: 'sum', field: 'y', type: 'quantitative' } } },
  layer: { data: D, encoding: { x: xy.x }, layer: [{ mark: 'line', encoding: { y: xy.y } }, { transform: [{ filter: 'datum.y > 3' }], mark: 'rule', encoding: { y: xy.y } }, { mark: 'point', params: [{ name: 'hover', select: { type: 'point', fields: ['x'], nearest: true, on: 'pointermove' } }], encoding: { y: xy.y, opacity: { condition: { param: 'hover', value: 1, empty: false }, value: 0 } } }] },
  layerOwnData: { layer: [{ data: D, mark: 'point', encoding: xy }, { data: { values: [{ x: 1 }] }, mark: 'rule', encoding: { x: xy.x } }] },
  concat: { hconcat: [{ data: D, mark: 'point', encoding: xy }, { data: D, mark: 'bar', encoding: { x: { field: 'k', type: 'nominal' }, y: { aggregate: 'count', type: 'quantitative' } } }] },
  facet: { data: D, facet: { field: 'g', type: 'nominal' }, spec: { mark: 'point', encoding: xy } },
  facetLayer: { data: D, facet: { row: { field: 'g', type: 'nominal' } }, spec: { layer: [{ mark: 'point', encoding: xy }, { mark: 'rule', encoding: { y: { aggregate: 'mean', field: 'y', type: 'quantitative' } } }] } },
  repeat: { data: D, repeat: ['x', 'y'], spec: { mark: 'bar', encoding: { x: { field: { repeat: 'repeat' }, bin: true, type: 'quantitative' }, y: { aggregate: 'count', type: 'quantitative' } } } },
  repeatLayer: { data: D, repeat: { layer: ['x', 'y'] }, spec: { mark: 'line', encoding: { x: { field: 'k', type: 'nominal' }, y: { field: { repeat: 'layer' }, type: 'quantitative' }, color: { datum: { repeat: 'layer' } } } } },
  datasets: { datasets: { main: [] }, data: { name: 'main' }, mark: 'point', encoding: xy },
  lookupNamed: { datasets: { other: [] }, data: D, transform: [{ lookup: 'k', from: { data: { name: 'other' }, key: 'k', fields: ['g'] } }], mark: 'point', encoding: xy },
  composite: { data: D, mark: 'boxplot', encoding: { x: { field: 'k', type: 'nominal' }, y: xy.y } },
  selections: { data: D, params: [{ name: 'brush', select: 'interval' }, { name: 'p', select: { type: 'point', fields: ['k'] }, bind: 'legend' }], mark: 'point', encoding: { ...xy, color: { field: 'k', type: 'nominal' } } },
  ariaFalse: { data: D, config: { aria: false }, mark: 'bar', encoding: { x: { field: 'k', type: 'nominal' }, y: xy.y } },
  namedView: { name: 'chart', data: D, mark: 'point', encoding: xy },
  timeUnitsTransforms: { data: D, transform: [{ calculate: 'datum.x * 2', as: 'x2' }, { window: [{ op: 'rank', as: 'r' }] }, { fold: ['x', 'y'] }], mark: 'line', encoding: { x: { field: 't', timeUnit: 'month', type: 'temporal' }, y: { field: 'value', type: 'quantitative' }, color: { field: 'key', type: 'nominal' } } },
}

const CONFORMANCE = join(__dirname, '..', '..', 'conformance')
const corpus: Array<[string, unknown]> = []
for (const dir of ['corpus', 'corpus-vega-only']) {
  const d = join(CONFORMANCE, dir)
  if (!existsSync(d)) continue
  for (const f of readdirSync(d).filter((x) => x.endsWith('.vl.json')).sort()) {
    const doc = JSON.parse(readFileSync(join(d, f), 'utf8'))
    corpus.push([f.replace('.vl.json', ''), doc.$schema ? doc : (doc.spec ?? doc)])
  }
}

describe('compiling reads no row', () => {
  for (const [name, shape] of Object.entries(shapes)) {
    for (const entry of ['compile', 'compileUnit'] as const) {
      if (entry === 'compileUnit' && !['unit', 'namedUnit', 'selections', 'ariaFalse', 'datasets', 'lookupNamed', 'timeUnitsTransforms'].includes(name)) continue
      it(`${entry}: ${name} reads no row and copies each payload's slots once, whatever the row count`, () => {
        const counts = [3, 300].map((n) => {
          const c: Counter = { rowReads: 0, slotReads: 0, otherArrayReads: 0, writes: 0 }
          const { spec, payloads, slots } = withCounted(shape, c, n)
          ;(entry === 'compile' ? compile : compileUnit)(spec)
          return { c, payloads, slots }
        })
        for (const { c, payloads, slots } of counts) {
          expect(payloads).toBeGreaterThan(0)
          expect(c.writes).toBe(0)
          expect(c.rowReads).toBe(0)
          expect(c.otherArrayReads).toBe(0)
          // (each payload is copied into the output at most once: its slots, nothing else of it)
          expect(c.slotReads).toBeLessThanOrEqual(slots)
        }
        // the cost guard: a hundred times the rows costs no read more than the one copy of the extra slots
        const [small, big] = counts
        expect(big!.c.slotReads - small!.c.slotReads).toBeLessThanOrEqual(big!.slots - small!.slots)
      })
    }
  }

  // every corpus spec with inline rows compiles reading none of them, unless two views carry equal-but-distinct rows (same length)
  // or a lookup names its source after them
  const withRows = corpus.filter(([, spec]) => /"values"\s*:\s*\[\s*\{|"datasets"/.test(JSON.stringify(spec)))
  it('found the corpus specs with inline rows', () => {
    expect(withRows.length).toBeGreaterThan(400)
  })
  for (const [name, spec] of withRows) {
    it(`corpus ${name}: compiles without writing a row or reading one it need not, to what a plain copy compiles to`, () => {
      const c: Counter = { rowReads: 0, slotReads: 0, otherArrayReads: 0, writes: 0 }
      const payloads: Array<Array<Record<string, unknown>>> = []
      const walk = (v: unknown, parentKey: string, key: string): unknown => {
        if (Array.isArray(v) && ((parentKey === 'data' && key === 'values') || parentKey === 'datasets') && v.every((r) => r !== null && typeof r === 'object' && !Array.isArray(r))) {
          payloads.push(v as Array<Record<string, unknown>>)
          return counted(v as Array<Record<string, unknown>>, c)
        }
        if (Array.isArray(v)) return v.map((x) => walk(x, key, ''))
        if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, key, k)]))
        return v
      }
      const traced = walk(spec, '', '')
      const lengths = payloads.map((p) => p.length)
      const sameLength = new Set(lengths).size < lengths.length
      const anonymousLookup = JSON.stringify(spec).includes('"lookup"')
      let plain: string
      try { plain = JSON.stringify(compile(JSON.parse(JSON.stringify(spec)))) } catch (e) {
        // (a spec the compiler refuses is refused the same way with counted rows)
        expect(() => compile(traced as VLSpec)).toThrow((e as Error).message)
        return
      }
      const out = compile(traced as VLSpec)
      expect(c.writes).toBe(0)
      expect(c.otherArrayReads).toBe(0)
      if (!sameLength && !anonymousLookup) expect(c.rowReads).toBe(0)
      expect(JSON.stringify(out)).toBe(plain)
    })
  }

  it('distinct rows are compared only as far as the first difference: the reads do not grow with the rows', () => {
    const readsFor = (n: number): number => {
      const c: Counter = { rowReads: 0, slotReads: 0, otherArrayReads: 0, writes: 0 }
      const a = sample(n)
      const b = sample(n).map((r, i) => (i === 0 ? { ...r, y: -1 } : r)) // differs in its first row
      const spec = { layer: [{ data: { values: counted(a, c) }, mark: 'point', encoding: xy }, { data: { values: counted(b, c) }, mark: 'rule', encoding: { y: xy.y } }] } as VLSpec
      const out = compile(spec) as { data: Array<{ values?: unknown }> }
      expect(out.data.filter((d) => d.values !== undefined)).toHaveLength(2)
      return c.rowReads
    }
    const small = readsFor(10)
    expect(small).toBeGreaterThan(0)
    expect(readsFor(1000)).toBe(small)
  })

  it('equal-but-distinct rows are compared once per compile, however many views carry them', () => {
    const readsFor = (views: number): number => {
      const c: Counter = { rowReads: 0, slotReads: 0, otherArrayReads: 0, writes: 0 }
      const base = sample(50)
      const spec = { hconcat: Array.from({ length: views }, () => ({ data: { values: counted(base.map((r) => ({ ...r })), c) }, mark: 'point', encoding: xy })) } as VLSpec
      const out = compile(spec) as { data: Array<{ values?: unknown }> }
      expect(out.data.filter((d) => d.values !== undefined)).toHaveLength(1)
      return c.rowReads
    }
    // (each further view's rows are read once, to compare them with the first view's: the work grows by one payload a view)
    const two = readsFor(2)
    const three = readsFor(3)
    expect(three - two).toBeLessThanOrEqual(two)
  })
})

describe('the compiled spec and the input', () => {
  it('the output carries the user\'s row objects, in arrays of its own', () => {
    const values = sample(5)
    const spec = { data: { values }, mark: 'point', encoding: xy } as VLSpec
    const out = compile(spec) as { data: Array<{ values?: unknown[] }> }
    const emitted = out.data.find((d) => d.values !== undefined)!.values!
    expect(emitted).not.toBe(values)
    expect(emitted).toEqual(values)
    emitted.forEach((r, i) => expect(r).toBe(values[i]))
  })

  it('a payload that two places reach is one array in the output, and an equal-but-distinct one is the same dataset', () => {
    const values = sample(5)
    const same = compile({ layer: [{ data: { values }, mark: 'point', encoding: xy }, { data: { values }, mark: 'rule', encoding: { y: xy.y } }] } as VLSpec) as { data: Array<{ values?: unknown[] }> }
    const equal = compile({ layer: [{ data: { values }, mark: 'point', encoding: xy }, { data: { values: sample(5) }, mark: 'rule', encoding: { y: xy.y } }] } as VLSpec) as { data: Array<{ values?: unknown[] }> }
    expect(same.data.filter((d) => d.values)).toHaveLength(1)
    expect(JSON.stringify(equal)).toBe(JSON.stringify(same))
  })

  it('a value structuredClone refuses in the spec\'s structure is still refused, with the same message', () => {
    const f = (): number => 1
    expect(() => compile({ data: { values: [] }, mark: 'point', encoding: { x: { field: 'x', type: 'quantitative', f } } } as unknown as VLSpec)).toThrow('the spec must be plain JSON-compatible data (() => 1 could not be cloned.)')
    expect(() => compile([] as unknown as VLSpec)).toThrow('a Vega-Lite spec must be a JSON object')
  })
})
