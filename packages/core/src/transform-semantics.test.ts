/**
 * Named regressions for the transform layer's Vega semantics (audit C24, C59, C94).
 *
 * The exhaustive check is `transform-vectors.test.ts` (thousands of params + rows
 * -> rows vectors recorded from real Vega). The tests here pin the headline
 * repros by name, the documented deviations from Vega, and properties the vectors
 * cannot express (uniformity, determinism, input immutability).
 */
import { describe, expect, it } from 'vitest'
import './addon-transforms.js'
import { applyTransforms, getField, type Row } from './transform.js'
import { compileExpr } from './expression.js'

const runtime = {
  scale: () => undefined,
  data: () => [],
  expr: (e: string) => compileExpr(e, runtime),
}

function run(rows: Row[], t: Record<string, unknown> | Array<Record<string, unknown>>, datasets: Record<string, Row[]> = {}): Row[] {
  const ctx = {
    runtime, signals: Object.create(null) as Record<string, unknown>,
    datasets: (n: string) => datasets[n], hierarchies: new Map<string, unknown>(),
  }
  return applyTransforms(rows, (Array.isArray(t) ? t : [t]) as never, ctx as never, 'src')
}

function withTZ<T>(tz: string, fn: () => T): T {
  const prev = process.env.TZ
  process.env.TZ = tz
  try {
    return fn()
  } finally {
    if (prev === undefined) delete process.env.TZ
    else process.env.TZ = prev
  }
}

const iso = (d: unknown): string => (d as Date).toISOString()

describe('C24: timeunit', () => {
  const t = new Date('2020-05-15T12:34:56.789Z')

  it('ends at the next unit of the FINEST unit, not the coarsest', () => {
    const [r] = run([{ t }], { type: 'timeunit', field: 't', units: ['year', 'month'], timezone: 'utc' })
    expect(iso(r!.unit0)).toBe('2020-05-01T00:00:00.000Z')
    expect(iso(r!.unit1)).toBe('2020-06-01T00:00:00.000Z') // was 2021-05-01
  })

  it('knows day and dayofyear (end = +1 day, not +1 ms)', () => {
    for (const unit of ['day', 'dayofyear']) {
      const [r] = run([{ t }], { type: 'timeunit', field: 't', units: [unit], timezone: 'utc' })
      expect((r!.unit1 as Date).getTime() - (r!.unit0 as Date).getTime(), unit).toBe(86400000)
    }
  })

  it.each(['America/New_York', 'Asia/Kolkata', 'Pacific/Auckland'])('honours timezone local vs utc under TZ=%s', (tz) => {
    withTZ(tz, () => {
      const units = ['year', 'month', 'date']
      const local = run([{ t }], { type: 'timeunit', field: 't', units, timezone: 'local' })[0]!
      const utc = run([{ t }], { type: 'timeunit', field: 't', units, timezone: 'utc' })[0]!
      // the UTC day starts at 00:00Z; the local day starts at local midnight
      expect(iso(utc.unit0)).toBe('2020-05-15T00:00:00.000Z')
      expect((local.unit0 as Date).getHours()).toBe(0)
      expect((local.unit0 as Date).getMinutes()).toBe(0)
      if (new Date(0).getTimezoneOffset() !== 0) expect(iso(local.unit0)).not.toBe(iso(utc.unit0))
    })
  })

  it('default timezone is local (not UTC)', () => {
    withTZ('Asia/Kolkata', () => {
      const [r] = run([{ t }], { type: 'timeunit', field: 't', units: ['year', 'month', 'date'] })
      expect(iso(r!.unit0)).toBe('2020-05-14T18:30:00.000Z') // 2020-05-15 00:00 IST
    })
  })
})

describe('C59: aggregate semantics', () => {
  const rows = [{ g: 'a', v: '10' }, { g: 'a', v: 2 }, { g: 'a', v: null }, { g: 'b', v: NaN }, { g: 'b', v: '' }]

  it('coerces with +v, counts valid/missing and yields undefined for empty groups', () => {
    const out = run(rows, { type: 'aggregate', groupby: ['g'], fields: ['v', 'v', 'v', 'v', 'v'], ops: ['sum', 'mean', 'valid', 'missing', 'max'], as: ['s', 'm', 'valid', 'missing', 'mx'] })
    expect(out[0]).toMatchObject({ g: 'a', s: 12, m: 6, valid: 2, missing: 1 })
    expect(out[1]).toMatchObject({ g: 'b', valid: 0, missing: 1 })
    expect(out[1]!.s).toBeUndefined()
    expect(out[1]!.m).toBeUndefined()
    expect(out[1]!.mx).toBeUndefined()
  })

  it('argmin / argmax return the winning tuple (and {} for a group with no valid value)', () => {
    const src = [{ g: 'a', v: 3 }, { g: 'a', v: 1 }, { g: 'a', v: 7 }, { g: 'b', v: null }]
    const out = run(src, { type: 'aggregate', groupby: ['g'], fields: ['v', 'v'], ops: ['argmin', 'argmax'], as: ['lo', 'hi'] })
    expect(out[0]!.lo).toBe(src[1])
    expect(out[0]!.hi).toBe(src[2])
    expect(out[1]).toMatchObject({ lo: {}, hi: {} })
  })

  it('ci0 / ci1 bracket the mean and are a pure function of the data', () => {
    const src = Array.from({ length: 30 }, (_, i) => ({ v: (i * 7) % 11 }))
    const t = { type: 'aggregate', fields: ['v', 'v', 'v'], ops: ['ci0', 'mean', 'ci1'], as: ['lo', 'mean', 'hi'] }
    const [a] = run(src, t)
    const [b] = run(src, t)
    expect(a).toEqual(b) // deterministic: incremental === fresh
    expect(a!.lo as number).toBeLessThan(a!.mean as number)
    expect(a!.hi as number).toBeGreaterThan(a!.mean as number)
  })

  it('stderr / stdev / variance need two valid values', () => {
    const out = run([{ v: 4 }], { type: 'aggregate', fields: ['v', 'v', 'v'], ops: ['stderr', 'stdev', 'variance'], as: ['se', 'sd', 'va'] })
    expect(out[0]).toMatchObject({ se: undefined, sd: undefined, va: undefined })
  })

  it('reads nested access paths: a.b, a[0], a\\.b', () => {
    const src = [{ a: { b: 1 }, 'a.b': 100, k: [5] }, { a: { b: 2 }, 'a.b': 200, k: [6] }]
    expect(run(src, { type: 'aggregate', fields: ['a.b'], ops: ['sum'], as: ['n'] })[0]).toEqual({ n: 3 })
    expect(run(src, { type: 'aggregate', fields: ['a\\.b'], ops: ['sum'], as: ['lit'] })[0]).toEqual({ lit: 300 })
    expect(run(src, { type: 'aggregate', fields: ['k[0]'], ops: ['sum'], as: ['idx'] })[0]).toEqual({ idx: 11 })
    expect(getField(src[0]!, 'a.b')).toBe(1)
    expect(getField(src[0]!, 'a\\.b')).toBe(100)
    expect(getField(src[0]!, 'k[0]')).toBe(5)
  })

  it('omitted ops default to count; as defaults to op_field', () => {
    expect(run(rows, { type: 'aggregate', groupby: ['g'] }).map((r) => r.count)).toEqual([3, 2])
    expect(Object.keys(run(rows, { type: 'aggregate', fields: ['v'], ops: ['sum'] })[0]!)).toEqual(['sum_v'])
  })

  it('groups by String(value): 1 and "1" are one group, the first tuple names it', () => {
    const out = run([{ g: 1, v: 1 }, { g: '1', v: 2 }], { type: 'aggregate', groupby: ['g'], fields: ['v'], ops: ['sum'] })
    expect(out).toEqual([{ g: 1, sum_v: 3 }])
  })

  it('an unknown or inherited op name is refused', () => {
    expect(() => run(rows, { type: 'aggregate', fields: ['v'], ops: ['constructor'] })).toThrow(/unsupported aggregate op/)
  })
})

describe('C59: lookup', () => {
  const lk = [{ k: 'a', w: 1 }, { k: 'b', w: 2 }, { k: 'a', w: 99 }, { k: 1, w: 'one' }]

  it('the last row wins and keys are string-coerced', () => {
    const out = run([{ f: 'a' }, { f: '1' }, { f: 1 }, { f: 'z' }], { type: 'lookup', from: 'lk', key: 'k', fields: ['f'], values: ['w'], as: ['m'], default: 'none' }, { lk })
    expect(out.map((r) => r.m)).toEqual([99, 'one', 'one', 'none'])
  })

  it('without values the whole row is stored under as; without as it is an error like Vega', () => {
    const out = run([{ f: 'b' }], { type: 'lookup', from: 'lk', key: 'k', fields: ['f'], as: ['row'] }, { lk })
    expect(out[0]!.row).toBe(lk[1])
    expect(() => run([{ f: 'b' }], { type: 'lookup', from: 'lk', key: 'k', fields: ['f'] }, { lk })).toThrow(/Missing output field names/)
  })

  it('values default their output names to the value fields (the join key is not overwritten)', () => {
    const out = run([{ k: 'a', f: 'b' }], { type: 'lookup', from: 'lk', key: 'k', fields: ['f'], values: ['w'] }, { lk })
    expect(out[0]).toEqual({ k: 'a', f: 'b', w: 2 })
  })
})

describe('C59: ordering', () => {
  it('ascending sorts null/undefined FIRST, NaN ties, ties stay in input order', () => {
    const rows = [{ v: 3, i: 0 }, { v: null, i: 1 }, { v: 1, i: 2 }, { v: undefined, i: 3 }, { v: 3, i: 4 }]
    expect(run(rows, { type: 'collect', sort: { field: 'v' } }).map((r) => r.i)).toEqual([1, 3, 2, 0, 4])
    expect(run(rows, { type: 'collect', sort: { field: 'v', order: 'descending' } }).map((r) => r.i)).toEqual([0, 4, 2, 1, 3])
  })

  it('stack keeps the input order whatever the sort and groups', () => {
    const rows = [{ x: 'a', g: 'p', v: 1 }, { x: 'b', g: 'p', v: 2 }, { x: 'a', g: 'q', v: 3 }, { x: 'b', g: 'q', v: 4 }]
    const out = run(rows, { type: 'stack', groupby: ['x'], field: 'v', sort: { field: 'g', order: 'descending' } })
    expect(out.map((r) => [r.x, r.g])).toEqual([['a', 'p'], ['b', 'p'], ['a', 'q'], ['b', 'q']])
    expect(out.map((r) => [r.y0, r.y1])).toEqual([[3, 4], [4, 6], [0, 3], [0, 4]])
  })
})

describe('C59: hierarchy layouts write only their own output fields', () => {
  const nodes = [{ id: 'r', p: null, s: 0 }, { id: 'a', p: 'r', s: 3 }, { id: 'b', p: 'r', s: 1 }]
  const keep = nodes.map((n) => ({ ...n, x: 'k', y: 'k', width: 'k', height: 'k', r: 'k', depth: 'k', children: 'k', x0: 'k' }))
  const st = { type: 'stratify', key: 'id', parentKey: 'p' }

  it('treemap writes x0 y0 x1 y1 depth children and nothing else', () => {
    const out = run(keep, [st, { type: 'treemap', field: 's', size: [10, 10] }])
    for (const [i, o] of out.entries()) {
      // the only new keys are the three output fields the rows did not carry yet
      expect(Object.keys(o).sort()).toEqual([...Object.keys(keep[i]!), 'x1', 'y0', 'y1'].sort())
      expect(o.x).toBe('k')
      expect(o.y).toBe('k')
      expect(o.width).toBe('k')
      expect(o.height).toBe('k')
      expect(typeof o.x1).toBe('number')
    }
    const bare = run(nodes, [st, { type: 'treemap', field: 's', size: [10, 10] }])
    expect(Object.keys(bare[1]!).sort()).toEqual(['children', 'depth', 'id', 'p', 's', 'x0', 'x1', 'y0', 'y1'])
    expect(bare[0]).toMatchObject({ depth: 0, children: 2 })
  })

  it('pack and partition likewise; the input rows are not touched', () => {
    const before = JSON.stringify(nodes)
    const pk = run(nodes, [st, { type: 'pack', field: 's', size: [10, 10] }])
    expect(Object.keys(pk[1]!).sort()).toEqual(['children', 'depth', 'id', 'p', 'r', 's', 'x', 'y'])
    const pt = run(nodes, [st, { type: 'partition', field: 's', size: [10, 10] }])
    expect(Object.keys(pt[1]!).sort()).toEqual(['children', 'depth', 'id', 'p', 's', 'x0', 'x1', 'y0', 'y1'])
    expect(JSON.stringify(nodes)).toBe(before)
  })

  it('treemap padding offsets use the d3 sign convention', () => {
    const out = run(nodes, [st, { type: 'treemap', field: 's', size: [100, 100], paddingInner: 4, paddingOuter: 2 }])
    const root = out[0]!
    expect([root.x0, root.y0, root.x1, root.y1]).toEqual([0, 0, 100, 100])
    // the children tile the root minus the 2px outer padding, then lose half the inner padding at each shared edge
    expect(out[1]!.x0 as number).toBeGreaterThanOrEqual(2)
  })
})

describe('C94: minor divergences', () => {
  it('sample: a reservoir of `size` rows, uniform over the input, deterministic', () => {
    const rows = Array.from({ length: 1000 }, (_, i) => ({ i }))
    const a = run(rows, { type: 'sample', size: 100 })
    const b = run(rows, { type: 'sample', size: 100 })
    expect(a).toHaveLength(100)
    expect(a).toEqual(b) // seeded: a pure function of the rows
    expect(new Set(a.map((r) => r.i)).size).toBe(100) // no duplicates
    // not "the first rows": each decile of the input is represented about 10 times
    const deciles = new Array<number>(10).fill(0)
    for (const r of a) deciles[Math.floor((r.i as number) / 100)]!++
    for (const c of deciles) expect(c).toBeGreaterThanOrEqual(2)
    for (const c of deciles) expect(c).toBeLessThanOrEqual(25)
    // chi-square against uniform (9 dof; 99.9th percentile 27.9)
    const chi = deciles.reduce((s, c) => s + (c - 10) ** 2 / 10, 0)
    expect(chi).toBeLessThan(27.9)
  })

  it('sample keeps everything (in order) when size covers the input', () => {
    const rows = [{ i: 0 }, { i: 1 }, { i: 2 }]
    expect(run(rows, { type: 'sample', size: 5 })).toEqual(rows)
  })

  it('sample without a size follows vega 6.3.1: the documented default of 1000 is not applied by its runtime', () => {
    expect(run([{ i: 0 }, { i: 1 }], { type: 'sample' })).toEqual([])
  })

  it('impute: imputed keys follow keyvals order (not sorted); a non-numeric value is kept', () => {
    const rows = [{ g: 'a', k: 3, v: 1 }]
    const out = run(rows, { type: 'impute', field: 'v', key: 'k', groupby: ['g'], keyvals: [3, 1, 2], value: 'n/a' })
    expect(out.slice(1).map((r) => [r.k, r.v])).toEqual([[1, 'n/a'], [2, 'n/a']])
  })

  it('kde: null support values are not counted as 0', () => {
    const withNulls = run([{ v: 1 }, { v: null }, { v: 3 }, { v: 5 }], { type: 'kde', field: 'v', steps: 5, resolve: 'independent' })
    expect(Number.isFinite(withNulls[0]!.density as number)).toBe(true)
    expect(withNulls[0]!.value).toBe(1)
  })

  it('project with no fields copies every field', () => {
    expect(run([{ a: 1, b: 2 }], { type: 'project' })).toEqual([{ a: 1, b: 2 }])
  })

  it('regression: params:true emits the coefficient rows; every vega method is supported', () => {
    const rows = [1, 2, 3, 4, 5].map((x) => ({ x, y: 2 * x + 1 }))
    const [p] = run(rows, { type: 'regression', x: 'x', y: 'y', params: true })
    expect((p!.coef as number[]).map((c) => Math.round(c * 1e9) / 1e9)).toEqual([1, 2])
    expect(p!.rSquared).toBeCloseTo(1, 12)
    for (const method of ['linear', 'log', 'exp', 'pow', 'quad', 'poly', 'constant']) {
      expect(() => run(rows, { type: 'regression', x: 'x', y: 'y', method }), method).not.toThrow()
    }
  })
})

describe('documented extensions', () => {
  it('bin without an extent derives it from the finite numeric values (vega requires the param)', () => {
    const out = run([{ v: 0 }, { v: 7 }, { v: 'x' }, { v: 20 }], { type: 'bin', field: 'v', maxbins: 4, as: ['b0', 'b1'] })
    expect(out.map((r) => r.b0)).toEqual([0, 5, NaN, 15]) // extent [0, 20], step 5
  })

  it('countpattern counts tokens named like Object.prototype members as data', () => {
    const out = run([{ t: 'constructor toString constructor __proto__ hasOwnProperty' }], { type: 'countpattern', field: 't' })
    expect(out.map((r) => [r.text, r.count])).toEqual([['constructor', 2], ['toString', 1], ['__proto__', 1], ['hasOwnProperty', 1]])
  })

  it('a window range frame that starts past the last row does not crash (vega throws a TypeError)', () => {
    const out = run([{ k: 1, v: 1 }, { k: 2, v: 2 }], { type: 'window', sort: { field: 'k' }, ops: ['sum'], fields: ['v'], frame: [1, 2] })
    expect(out.map((r) => r.sum_v)).toEqual([2, undefined])
  })

  it('identifier numbers only the rows whose id is falsy, from 1', () => {
    const out = run([{ id: 7 }, { v: 1 }, { id: 0 }, { id: 'x' }, { v: 2 }], { type: 'identifier', as: 'id' })
    expect(out.map((r) => r.id)).toEqual([7, 1, 2, 'x', 3])
  })

  it('signal-valued params are evaluated before the transform runs', () => {
    const ctx = { runtime, signals: { n: 2 } as Record<string, unknown>, datasets: () => undefined }
    const out = applyTransforms([{ i: 0 }, { i: 1 }, { i: 2 }] as never, [{ type: 'sample', size: { signal: 'n' } }] as never, ctx as never)
    expect(out).toHaveLength(2)
  })
})
