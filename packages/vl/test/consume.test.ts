// @vitest-environment node
/**
 * The consumption check (consume.ts): a property of the spec that the compile never reads is refused with a VLCompileError naming its
 * path, and the primitives that rewrite a spec keep what they move unconsumed until its new place is read.
 */
import { describe, it, expect } from 'vitest'
import { compile, VLCompileError } from '../src/index.js'
import { arm, consumeAll, consuming, derive, deriveDeep, deriveWithout, ignore, merge, peek, pick, refuseUnconsumed, transfer, unconsumedPaths, withConsumption } from '../src/consume.js'
import { dict } from '../src/names.js'

/** A spec copy as compile makes it (dicts), armed; `f` runs on it; the unread paths after. */
function run(spec: Record<string, unknown>, f: (s: Record<string, any>) => void): string[] {
  return withConsumption(() => {
    const copy = JSON.parse(JSON.stringify(spec), (_k, v: unknown) => (v !== null && typeof v === 'object' && !Array.isArray(v) ? Object.assign(dict(), v) : v))
    f(arm(copy, () => false))
    return unconsumedPaths()
  })
}

describe('the primitives', () => {
  it('a read consumes; a peek does not; a write without a read does not', () => {
    expect(run({ a: 1, b: 2, c: 3 }, (s) => { void s.a; peek(() => s.b); s.c = 4 })).toEqual(['b', 'c'])
  })
  it('the first read settles the property: later reads see the value, writes stay', () => {
    run({ a: 1 }, (s) => {
      expect(s.a).toBe(1)
      s.a = 5
      expect(s.a).toBe(5)
      expect(Object.getOwnPropertyDescriptor(s, 'a')!.get).toBeUndefined()
    })
  })
  it('a property that holds objects is consumed through what is below it; a scalar array or an empty object must be read itself', () => {
    expect(run({ o: { x: 1, y: 2 }, list: [{ k: 1 }], s: ['a'], e: {} }, (s) => { void peek(() => s.o).x; void peek(() => s.list)[0].k })).toEqual(['o.y', 's', 'e'])
  })
  it('derive / deriveWithout / pick / transfer copy a property unconsumed; reading the copy consumes the original', () => {
    expect(run({ a: 1, b: 2, c: 3, d: 4 }, (s) => {
      const d1 = derive(s, { z: 9 })
      const d2 = deriveWithout(s, ['a'])
      const p = pick(s, ['c'])
      const t: Record<string, unknown> = {}
      transfer(s, 'd', t, 'dd')
      void d1.a
      void d2.b
      expect(d2.a).toBeUndefined()
      void p.c
      expect(unconsumedPaths()).toEqual(['d'])
      void t.dd
    })).toEqual([])
  })
  it('a spread or a destructuring is a read (what the primitives are for)', () => {
    expect(run({ a: 1, b: 2 }, (s) => { const { a: _a, ...rest } = s; void rest })).toEqual([])
  })
  it('merge consumes the overridden properties of the base, as an override has no effect', () => {
    expect(run({ base: { a: 1, b: 2 }, top: { b: 3 } }, (s) => {
      const m = merge(peek(() => s.base), peek(() => s.top))
      expect(m.b).toBe(3)
      expect(unconsumedPaths()).toEqual(['base.a'])
      void m.a
    })).toEqual([])
  })
  it('deriveDeep copies a subtree with every property still standing for the original', () => {
    expect(run({ p: { name: 'x', select: { type: 'point', on: 'click' } } }, (s) => {
      const copy = deriveDeep(peek(() => s.p))
      void copy.select.type
    })).toEqual(['p.name', 'p.select.on'])
  })
  it('ignore and consumeAll consume a property and everything below it without reading', () => {
    expect(run({ a: { b: { c: 1 } }, d: 2, e: { f: [1] } }, (s) => { ignore(s, 'a', 'test'); ignore(s, 'd', 'test'); consumeAll(peek(() => s.e)) })).toEqual([])
  })
  it('consuming reads for real inside a peek', () => {
    expect(run({ a: 1, b: 2 }, (s) => peek(() => { void s.a; consuming(() => s.b) }))).toEqual(['a'])
  })
  it('refuseUnconsumed throws a VLCompileError naming every unread path', () => {
    expect(() => withConsumption(() => {
      const s = Object.assign(dict(), { a: 1, b: Object.assign(dict(), { c: 2 }) })
      void arm(s, () => false)
      refuseUnconsumed()
    })).toThrow(/a: is valid Vega-Lite but @aster-charts\/vl does not implement it here, so it would be ignored \(and b\.c\)/)
  })
})

describe('compile refuses what it does not read', () => {
  const data = { values: [{ a: 'A', b: 1, c: 'x' }] }
  const bar = { mark: 'bar', encoding: { x: { field: 'a', type: 'nominal' }, y: { field: 'b', type: 'quantitative' } } }
  it('a spec with every property read compiles', () => {
    expect(() => compile({ data, ...bar })).not.toThrow()
  })
  it('a property the compile does not read is refused, by its path (a header on a colour: vega-lite titles the legend with it)', () => {
    expect(() => compile({ data, ...bar, encoding: { ...bar.encoding, color: { field: 'a', type: 'nominal', header: { title: 'h' } } } }))
      .toThrow(/\[aster\/vl\] encoding\.color\.header\.title: is valid Vega-Lite but @aster-charts\/vl does not implement it here/)
  })
  it('one that vega-lite ignores is consumed as ignored (a header on x), and the spec compiles', () => {
    expect(() => compile({ data, ...bar, encoding: { ...bar.encoding, x: { ...bar.encoding.x, header: { title: 'h' } } } })).not.toThrow()
  })
  it('the input is never armed: it stays plain data and is not consumed by a compile', () => {
    const spec = { data, ...bar }
    compile(spec)
    expect(Object.getOwnPropertyDescriptor(spec, 'mark')!.get).toBeUndefined()
    expect(Object.getOwnPropertyDescriptor(compile(spec) as object, 'marks')!.get).toBeUndefined()
  })
})
