/**
 * GENERATED live differential of the array utilities under the scales (`core/src/arr.ts`) against the pinned d3-array
 * 3.2.4, in one process and one engine (nothing recorded: see `differential-util.mts`).
 *
 * Every export the rest of the engine reaches is driven with ordinary and degenerate input: reversed, zero-width,
 * NaN, +-Infinity, +-0, Dates, strings, null / undefined, non-finite and fractional counts. The arguments of the
 * tick functions come from several magnitudes at once (1e-12 to 1e15), because the error term of the step
 * (`e10`/`e5`/`e2`) and the rounding of `i1` / `i2` only differ from the real thing at a few ulp.
 */
import * as d3 from 'd3-array'
import { describe, expect, it, vi } from 'vitest'
import * as arr from '../../core/src/arr.ts'
import { compareCases, makeRng, scaled, type Rng } from './differential-gen.mts'

vi.setConfig({ testTimeout: 120_000 })

const ODD: unknown[] = [null, undefined, NaN, '', '3', '2.5', 'x', ' 7 ', true, false, Infinity, -Infinity, new Date(5), new Date(NaN), [4], {}, -0, 0, 1e21, -1e-7]

function magnitude(r: Rng): number {
  const m = r.pick([0, 1, -3.3, 1e-12, 1e-9, 1e-3, 0.1, 7, 100, 1e6, 1e12, 1e15, 123456.789, -2.5e9, 0.30000000000000004])
  return m + r.next() * r.pick([0, 1, 10, 1e-6, 1e6, 1e-12])
}

function tickInputs(r: Rng): [unknown, unknown, unknown] {
  const a = r.chance(0.04) ? r.pick(ODD) : magnitude(r)
  const b = r.chance(0.05) ? r.pick(ODD) : r.pick([a, magnitude(r), (a as number) + r.next() * r.pick([1, 100, 1e-4, 1e9]), (a as number) - r.next() * 5, NaN, Infinity, -Infinity])
  const c = r.chance(0.04) ? r.pick(ODD) : r.pick([0, 0.2, 0.5, 0.7, 1, 2, 3, 5, 10, 11, 20, 100, 1000, -1, NaN, Infinity, 2.5, 1.5, 7, 4])
  return [a, b, c]
}
const lab = (v: unknown): string => JSON.stringify(v, (_k, x) => (x === undefined ? '__undef' : typeof x === 'number' && !Number.isFinite(x) ? String(x) : x))

function column(r: Rng): unknown[] {
  const n = r.pick([0, 1, 2, 3, 4, 7, 12, 40])
  const mode = r.pick(['clean', 'clean', 'sparse', 'mostly-odd', 'all-missing', 'dups'])
  return Array.from({ length: n }, () => {
    if (mode === 'all-missing') return r.pick([null, undefined, NaN])
    if (mode === 'dups') return r.pick([1, 2, 2, 5, 0, -0, null])
    const odd = mode === 'mostly-odd' ? 0.7 : mode === 'sparse' ? 0.2 : 0
    return r.chance(odd) ? r.pick(ODD) : Math.round((r.next() * 30 - 8) * 4) / 4
  })
}

describe('arr.ts vs d3-array 3.2.4 (generated)', () => {
  it('ticks, tickStep and tickIncrement', () => {
    const r = makeRng(0x71c5)
    const out = compareCases('ticks', scaled(30000), () => {
      const [a, b, c] = tickInputs(r)
      return {
        label: lab([a, b, c]),
        oracle: () => [d3.ticks(a as number, b as number, c as number), d3.tickStep(a as number, b as number, c as number), d3.tickIncrement(a as number, b as number, c as number)],
        aster: () => [arr.ticks(a as number, b as number, c as number), arr.tickStep(a as number, b as number, c as number), arr.tickIncrement(a as number, b as number, c as number)],
      }
    })
    expect(out.informative).toBeGreaterThan(10000)
  })

  it('ticks with a large count (the arrays a dense axis makes)', () => {
    const r = makeRng(0x71c6)
    compareCases('ticks-big', scaled(400), () => {
      const a = r.pick([0, -1e6, 3.7, 1e-3])
      const b = a + r.pick([1, 1e3, 1e6, 1e9])
      const c = r.pick([1000, 5000, 20000, 100000])
      return { label: lab([a, b, c]), oracle: () => d3.ticks(a, b, c), aster: () => arr.ticks(a, b, c) }
    })
  })

  it('ascending, descending', () => {
    const r = makeRng(0xa5c)
    compareCases('ascending', scaled(6000), () => {
      const u = r.pick([...ODD, 1, 2, 3, 'a', 'b', 'B', new Date(1), new Date(2)])
      const v = r.pick([...ODD, 1, 2, 3, 'a', 'b', 'B', new Date(1), new Date(2)])
      return {
        label: lab([u, v]),
        oracle: () => [d3.ascending(u as number, v as number), d3.descending(u as number, v as number)],
        aster: () => [arr.ascending(u, v), arr.descending(u, v)],
      }
    })
  })

  it('range', () => {
    const r = makeRng(0x4a9e)
    compareCases('range', scaled(6000), () => {
      const args = Array.from({ length: r.pick([0, 1, 2, 3, 3, 3, 4]) }, () => r.chance(0.12) ? r.pick(ODD.filter((v) => Math.abs(+(v as number)) === 0 || (Math.abs(+(v as number)) > 1e-3 && Math.abs(+(v as number)) < 1e6) || !Number.isFinite(+(v as number)))) : r.pick([0, 1, 5, -3, 10, 0.5, 0.1, 2.5, -0.5, 0.01, 100]))
      return {
        label: lab(args),
        oracle: () => (d3.range as (...a: unknown[]) => unknown)(...args),
        aster: () => (arr.range as (...a: unknown[]) => unknown)(...args),
      }
    })
  })

  it('bisect, bisectLeft, bisectRight, bisectCenter and the bisector forms', () => {
    const r = makeRng(0xb15)
    compareCases('bisect', scaled(12000), () => {
      const base = column(r)
      const sorted = r.chance(0.8)
      const a = sorted ? base.slice().sort((x, y) => (d3.ascending(x as number, y as number) || 0)) : base
      const x = r.chance(0.35) ? r.pick(ODD) : r.pick([-10, -1, 0, 0.5, 1, 2, 2.5, 3, 5, 7.5, 9, 12, 25, 100])
      const lo = r.chance(0.3) ? r.pick([0, 1, 2, a.length, a.length + 2, 1.5, NaN]) : undefined
      const hi = r.chance(0.3) ? r.pick([0, 1, 2, a.length - 1, a.length, a.length + 2, -1, NaN]) : undefined
      const acc = { v: (d: unknown) => (d as { v: unknown }).v }
      const wrapped = a.map((v) => ({ v }))
      const run = (b: typeof d3 | typeof arr): unknown => {
        const bis = (b as typeof d3).bisector
        const cmp = (p: { v: unknown }, q: unknown): number => (b as typeof d3).ascending(p.v as number, q as number)
        return [
          (b as typeof d3).bisect(a as number[], x as number, lo, hi),
          (b as typeof d3).bisectLeft(a as number[], x as number, lo, hi),
          (b as typeof d3).bisectRight(a as number[], x as number, lo, hi),
          (b as typeof d3).bisectCenter(a as number[], x as number, lo, hi),
          bis(acc.v).left(wrapped, x as never, lo, hi),
          bis(acc.v).right(wrapped, x as never, lo, hi),
          bis(acc.v).center(wrapped, x as never, lo, hi),
          bis(cmp).left(wrapped, x as never, lo, hi),
          bis(cmp).right(wrapped, x as never, lo, hi),
          bis(cmp).center(wrapped, x as never, lo, hi),
          bis((b as typeof d3).descending).left(a as never, x as never, lo, hi),
          bis((b as typeof d3).descending).right(a as never, x as never, lo, hi),
        ]
      }
      return {
        label: lab({ a, x, lo, hi }),
        oracle: () => run(d3),
        aster: () => run({ ...arr, bisector: arr.default } as unknown as typeof d3),
      }
    })
  })

  it('quantile and quantileSorted', () => {
    const r = makeRng(0x9a1)
    compareCases('quantile', scaled(12000), () => {
      const v = column(r)
      const p = r.pick([0, 0.25, 0.5, 0.75, 1, 0.999, 0.001, 1 / 3, r.next(), r.next(), -1, 2, NaN, '0.5', null, undefined, Infinity])
      const keyed = v.map((d) => ({ d }))
      const sorted = v.filter((d) => d != null).map(Number).filter((d) => d === d).sort((a, b) => a - b)
      return {
        label: lab({ v, p }),
        oracle: () => [
          d3.quantile(v as number[], p as number),
          d3.quantile(keyed, p as number, (e) => e.d as number),
          d3.quantileSorted(sorted, p as number),
          d3.quantileSorted(keyed, p as number, (e) => +(e.d as number)),
        ],
        aster: () => [
          arr.quantile(v, p as number),
          arr.quantile(keyed, p as number, (e) => (e as { d: unknown }).d),
          arr.quantileSorted(sorted, p as number),
          arr.quantileSorted(keyed, p as number, (e) => +((e as { d: unknown }).d as number)),
        ],
      }
    })
  })

  it('quantile on columns of every size (the selection must agree beyond one partition round)', () => {
    const r = makeRng(0x9a2)
    compareCases('quantile-big', scaled(120), () => {
      const n = r.pick([100, 599, 600, 601, 1500, 5000, 20000])
      const kind = r.pick(['uniform', 'ties', 'sorted', 'reversed'])
      const v = Array.from({ length: n }, (_, i) =>
        kind === 'ties' ? r.int(7) - 3 : kind === 'sorted' ? i : kind === 'reversed' ? n - i : r.next() * 1000 - 300)
      const p = r.pick([0.1, 0.25, 0.5, 0.9, 0.999, r.next()])
      return { label: `${kind} n=${n} p=${p}`, oracle: () => d3.quantile(v, p), aster: () => arr.quantile(v, p) }
    })
  })

  it('Adder (exact summation)', () => {
    const r = makeRng(0xadd)
    compareCases('adder', scaled(4000), () => {
      const xs = Array.from({ length: r.pick([0, 1, 2, 5, 30, 200]) }, () =>
        r.chance(0.04) ? r.pick([NaN, Infinity, -Infinity, 0, -0]) : (r.next() - 0.5) * r.pick([1, 1e-9, 1e9, 1e16, 1e300, 1e-300]))
      const run = (A: new () => { add(x: number): unknown; valueOf(): number }): unknown => {
        const a = new A()
        const partial = xs.map((x) => (a.add(x), a.valueOf()))
        return [partial, +a]
      }
      return { label: lab(xs), oracle: () => run(d3.Adder as never), aster: () => run(arr.Adder as never) }
    })
  })

  it('merge', () => {
    const r = makeRng(0x3e9)
    compareCases('merge', scaled(600), () => {
      const arrays = Array.from({ length: r.pick([0, 1, 2, 4]) }, () => column(r))
      return { label: lab(arrays), oracle: () => d3.merge(arrays), aster: () => arr.merge(arrays) }
    })
  })

  it('InternMap', () => {
    const r = makeRng(0x1a7)
    compareCases('internmap', scaled(1500), () => {
      const pool: unknown[] = [0, 1, 2, '1', 'a', null, undefined, NaN, -0, true, new Date(0), new Date(0), new Date(1), new Date(NaN), { valueOf: () => 7 }, { valueOf: () => 7 }, [1], [1], {}, Symbol.for('s')]
      const ops = Array.from({ length: r.pick([1, 5, 20]) }, () => [r.pick(['get', 'set', 'has', 'delete', 'size', 'keys', 'entries']), r.pick(pool), r.int(100)] as const)
      // one random choice of initial entries for both sides
      const seeded = r.chance(0.3)
      const runBoth = (M: never): unknown => {
        const m = new (M as new (e?: Iterable<[unknown, unknown]>) => Map<unknown, unknown>)(seeded ? [[new Date(5), 'five'], [new Date(5), 'again']] : undefined)
        return ops.map(([op, k, v]) => (op === 'get' ? m.get(k) : op === 'set' ? m.set(k, v) === m : op === 'has' ? m.has(k) : op === 'delete' ? m.delete(k) : op === 'size' ? m.size : op === 'keys' ? [...m.keys()] : [...m.entries()]))
      }
      return { label: lab(ops.map(([o, k]) => [o, String(k)])), oracle: () => runBoth(d3.InternMap as never), aster: () => runBoth(arr.InternMap as never) }
    })
  })
})
