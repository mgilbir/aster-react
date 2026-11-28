// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { createChartStream } from './index.js'
import { createChartSession } from './addon-dom.js'
import type { VgSpec } from './types.js'

// Development builds warn, once per chart and dataset, when the rows a chart was given are changed in place between two
// evaluations (row-watch.ts): an edited row, a row replaced in the array, a push or a splice. Passing a new array, describing the
// change (`dataChanges`, a stream's `append`), or re-rendering equal content never warns; neither do getters or Proxy rows that do not
// change; and a production build reads nothing.

const rows = (n: number): Array<Record<string, unknown>> => Array.from({ length: n }, (_, i) => ({ k: `k${i}`, v: i }))
const spec = (values?: unknown[]): VgSpec => ({
  width: 50, height: 20,
  data: [{ name: 't', ...(values ? { values } : {}) }, { name: 'u', values: rows(3) }],
  marks: [{ type: 'rect', from: { data: 't' }, encode: { update: { x: { field: 'v' }, width: { value: 1 }, y: { value: 0 }, height: { value: 1 } } } }],
}) as unknown as VgSpec

function logged(): { warnings: string[]; logger: { error: () => void; warn: (m: unknown) => void } } {
  const warnings: string[] = []
  return { warnings, logger: { error: () => {}, warn: (m: unknown) => { warnings.push(String(m)) } } }
}

const MUTATIONS: Record<string, (a: Array<Record<string, unknown>>) => void> = {
  'a row\'s value edited': (a) => { a[0]!.v = 99 },
  'the last row\'s value edited': (a) => { a[a.length - 1]!.k = 'changed' },
  'a row replaced in the array': (a) => { a[0] = { k: 'new', v: 0 } },
  'a row pushed': (a) => { a.push({ k: 'x', v: 1 }) },
  'a row spliced out': (a) => { a.splice(1, 1) },
  'a field added to a row': (a) => { a[0]!.extra = 1 },
}


describe('a row changed in place warns once per chart and dataset', () => {
  for (const [name, mutate] of Object.entries(MUTATIONS)) {
    it(`host rows, ${name}: a session warns once, naming the dataset and what to do`, () => {
      const { warnings, logger } = logged()
      const session = createChartSession()
      const data = rows(40)
      session.evaluate(spec(), { data: { t: data }, logger })
      expect(warnings).toEqual([])
      mutate(data)
      session.evaluate(spec(), { data: { t: data }, logger })
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toMatch(/^\[aster\] the rows of dataset "t" were changed in place/)
      expect(warnings[0]).toMatch(/Pass a new array instead, or describe the change with `dataChanges`/)
      // (once: a further change, or the same state again, says nothing more)
      mutate(data)
      session.evaluate(spec(), { data: { t: data }, logger })
      session.evaluate(spec(), { data: { t: data }, logger })
      expect(warnings).toHaveLength(1)
    })

    it(`a spec's inline values, ${name}: the same spec evaluated again warns once`, () => {
      const { warnings, logger } = logged()
      const session = createChartSession()
      const values = rows(40)
      const s = spec(values)
      session.evaluate(s, { logger })
      mutate(values)
      session.evaluate(s, { logger })
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toMatch(/dataset "t"/)
    })
  }

  it('session.change with the same array changed in place warns', () => {
    const { warnings, logger } = logged()
    const session = createChartSession()
    const data = rows(10)
    session.evaluate(spec(), { data: { t: data }, logger })
    data.push({ k: 'x', v: 1 })
    session.change({ data: { t: data }, logger })
    expect(warnings).toHaveLength(1)
  })

  it('a stream: a snapshot the host pushed and then changed in place warns at the next flush', () => {
    const { warnings, logger } = logged()
    const stream = createChartStream(spec(rows(2)), { initial: { logger } })
    const snapshot = rows(10)
    stream.push({ data: { t: snapshot } })
    stream.flush()
    snapshot[0]!.v = 42
    stream.push({ data: { u: rows(4) } })
    stream.flush()
    expect(warnings).toHaveLength(1)
    stream.close()
  })

  it('two datasets changed in place: one warning each', () => {
    const { warnings, logger } = logged()
    const session = createChartSession()
    const t = rows(5)
    const v = rows(5)
    session.evaluate(spec(), { data: { t, u: v }, logger })
    t.push({}); v.push({})
    session.evaluate(spec(), { data: { t, u: v }, logger })
    expect(warnings.map((w) => /Dataset: "(\w+)"/.exec(w)?.[1]).sort()).toEqual(['t', 'u'])
  })
})

describe('no warning where nothing was changed in place', () => {
  const quiet = (f: (logger: ReturnType<typeof logged>['logger']) => void): void => {
    const { warnings, logger } = logged()
    f(logger)
    expect(warnings).toEqual([])
  }

  it('a new array, with the change in it', () => quiet((logger) => {
    const session = createChartSession()
    const data = rows(10)
    session.evaluate(spec(), { data: { t: data }, logger })
    session.evaluate(spec(), { data: { t: [...data, { k: 'x', v: 1 }] }, logger })
    session.evaluate(spec(), { data: { t: data.map((r, i) => (i === 0 ? { ...r, v: 9 } : r)) }, logger })
  }))

  it('an equal re-render: the same arrays, untouched, and new equal ones', () => quiet((logger) => {
    const session = createChartSession()
    const data = rows(10)
    for (let i = 0; i < 3; i++) session.evaluate(spec(), { data: { t: data }, logger })
    session.evaluate(spec(), { data: { t: rows(10) }, logger })
  }))

  it('an in-place change the host describes with dataChanges (and with changedDatasets, dataPulse)', () => quiet((logger) => {
    const session = createChartSession()
    const data = rows(10)
    session.evaluate(spec(), { data: { t: data }, logger })
    data[3]!.v = 77
    session.evaluate(spec(), { data: { t: data }, dataChanges: { t: [3] }, logger })
    data.push({ k: 'y', v: 2 })
    session.evaluate(spec(), { data: { t: data }, changedDatasets: ['t'], logger })
    data[0]!.v = 5
    session.change({ data: { t: data }, dataChanges: { t: [0] }, logger })
  }))

  it('a stream\'s appends and snapshots (the stream changes its own copies, and says so)', () => quiet((logger) => {
    const stream = createChartStream(spec(rows(3)), { initial: { logger } })
    for (let i = 0; i < 5; i++) {
      stream.push({ append: { t: rows(2) } })
      stream.flush()
    }
    stream.push({ data: { t: rows(4) } })
    stream.flush()
    stream.push({ append: { t: rows(1) } })
    stream.flush()
    stream.close()
  }))

  it('rows whose fields are getters: never called, and a getter whose value changes says nothing', () => {
    let calls = 0
    const data = Array.from({ length: 5 }, (_, i) => {
      const r: Record<string, unknown> = { k: `k${i}` }
      Object.defineProperty(r, 'v', { enumerable: true, get: () => { calls++; return Math.random() } })
      return r
    })
    quiet((logger) => {
      const session = createChartSession()
      session.evaluate(spec(), { data: { t: data }, logger })
      const before = calls
      session.evaluate(spec(), { data: { t: data }, logger })
      // (the second evaluation is the session's no-op: only the watch could have called the getters, and it did not)
      expect(calls).toBe(before)
    })
  })

  it('Proxy rows: read through ownKeys / getOwnPropertyDescriptor, never get; unchanged ones say nothing', () => {
    let gets = 0
    const data = rows(5).map((r) => new Proxy(r, { get(t, k, rcv) { gets++; return Reflect.get(t, k, rcv) } }))
    quiet((logger) => {
      const session = createChartSession()
      session.evaluate(spec(), { data: { t: data }, logger })
      const before = gets
      session.evaluate(spec(), { data: { t: data }, logger })
      expect(gets).toBe(before)
    })
  })

  it('a production build reads no row and warns about nothing', () => {
    const saved = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    try {
      let reads = 0
      const data = rows(10).map((r) => new Proxy(r, {
        get(t, k, rcv) { reads++; return Reflect.get(t, k, rcv) },
        ownKeys(t) { reads++; return Reflect.ownKeys(t) },
        getOwnPropertyDescriptor(t, k) { reads++; return Reflect.getOwnPropertyDescriptor(t, k) },
      }))
      quiet((logger) => {
        const session = createChartSession()
        session.evaluate(spec(), { data: { t: data }, logger })
        const before = reads
        data.push({ k: 'z', v: 1 })
        session.evaluate(spec(), { data: { t: data }, logger })
        // (the evaluation after the push re-runs nothing: the session's cache sees the same array; no watch read anything)
        expect(reads).toBe(before)
      })
    } finally {
      process.env.NODE_ENV = saved
    }
  })
})

describe('rows edited in place and handed back in a new array warn too (C266)', () => {
  // (the diff takes a row object it saw before for the row it was: `rows[3].v = 3; setData([...rows])` keeps the old picture, so
  // the watch looks at the sampled rows the new array still holds at their place)
  const EDITS: Record<string, (a: Array<Record<string, unknown>>) => void> = {
    'the first row': (a) => { a[0]!.v = 99 },
    'the last row': (a) => { a[a.length - 1]!.k = 'changed' },
    // (a sampled row: the second of the 16 evenly spaced ones the watch reads)
    'a field added to a middle row': (a) => { a[a.length > 1 ? Math.round((a.length - 1) / (Math.min(a.length, 16) - 1)) : 0]!.extra = 1 },
  }
  for (const n of [1, 5, 40]) {
    for (const [name, edit] of Object.entries(EDITS)) {
      it(`${n} rows, ${name} edited, then [...rows]: one warning; new row objects instead: none`, () => {
        for (const fresh of [false, true]) {
          const { warnings, logger } = logged()
          const session = createChartSession()
          const data = rows(n)
          session.evaluate(spec(), { data: { t: data }, logger })
          const next = fresh ? data.map((r) => ({ ...r })) : data
          edit(next)
          session.evaluate(spec(), { data: { t: [...next] }, logger })
          expect(warnings).toHaveLength(fresh ? 0 : 1)
          if (!fresh) expect(warnings[0]).toMatch(/^\[aster\] the rows of dataset "t" were changed in place/)
        }
      })
    }
  }
})
