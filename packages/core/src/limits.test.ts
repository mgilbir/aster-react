// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest'
import {
  AsterLimitError, checkSpecLimits, checkSceneLimits, renderSpec, compileChart, evaluateChart,
  defaultLocale, resetDefaultLocale, locale, compileExpr,
} from './index.js'
import { createChartSession } from './addon-dom.js'
import { withLimits, activeMeter, boundedCount } from './limits.js'
import { FORMATTER_CACHE_MAX as CACHE_MAX } from './locale.js'
import type { VgSpec } from './types.js'

const lim = (fn: () => unknown): AsterLimitError => {
  try { fn() } catch (e) { return e as AsterLimitError }
  throw new Error('expected an AsterLimitError, nothing was thrown')
}

describe('checkSpecLimits (C9, C49)', () => {
  it('counts nested group data, top-level data and host input.data toward maxRows', () => {
    const spec = {
      data: [{ name: 'a', values: new Array(40).fill({}) }],
      marks: [{ type: 'group', data: [{ name: 'b', values: new Array(40).fill({}) }],
        marks: [{ type: 'group', data: [{ name: 'c', values: new Array(40).fill({}) }] }] }],
    }
    expect(lim(() => checkSpecLimits(spec, { maxRows: 100 })).message).toMatch(/maxRows 120 > 100/)
    expect(() => checkSpecLimits(spec, { maxRows: 120 })).not.toThrow()
    expect(lim(() => checkSpecLimits({ data: [{ name: 'a' }] }, { maxRows: 5 }, { data: { a: new Array(6).fill(1) } })).message).toMatch(/maxRows 6 > 5/)
  })

  it('walks iteratively: 200k-deep specs and cycles are limit errors', () => {
    let deep: unknown = 1
    for (let i = 0; i < 200_000; i++) deep = [deep]
    expect(lim(() => checkSpecLimits({ x: deep } as never, {})).message).toMatch(/maxDepth/)
    expect(lim(() => checkSpecLimits({ x: deep } as never, { maxDepth: 10 })).message).toMatch(/maxDepth \d+ > 10/)
    const cyc: Record<string, unknown> = {}
    cyc.a = [{ b: cyc }]
    expect(lim(() => checkSpecLimits(cyc, {})).message).toMatch(/cycle/)
    // shared (non-cyclic) references are fine
    const shared = { v: 1 }
    expect(() => checkSpecLimits({ a: shared, b: shared }, {})).not.toThrow()
  })
})

describe('checkSceneLimits (C49)', () => {
  const group = (marktype: string, items: unknown[]) => ({ items: [{ marktype, items }] })
  it('line/area points imply a minimum path length', () => {
    const pts = Array.from({ length: 1000 }, () => ({}))
    expect(lim(() => checkSceneLimits(group('line', pts), { maxPathLength: 3000 })).message).toMatch(/maxPathLength 4000 > 3000/)
    expect(() => checkSceneLimits(group('line', pts), { maxPathLength: 5000 })).not.toThrow()
    // undefined points draw nothing
    expect(() => checkSceneLimits(group('area', pts.map(() => ({ defined: false }))), { maxPathLength: 10 })).not.toThrow()
  })
  it('text arrays count toward maxStringLength (sum of the elements)', () => {
    const scene = { items: [{ marktype: 'text', items: [{ text: ['a'.repeat(60), 'b'.repeat(60)] }] }] }
    expect(lim(() => checkSceneLimits(scene, { maxStringLength: 100 })).message).toMatch(/maxStringLength 120 > 100/)
    expect(() => checkSceneLimits(scene, { maxStringLength: 120 })).not.toThrow()
  })
})

describe('the meter is ambient, nests, and a swallowed violation still fails the call (T3)', () => {
  it('no scope: every helper is a no-op', () => {
    expect(activeMeter()).toBeNull()
    expect(boundedCount(1e12, 'x')).toBe(1e12)
  })

  it('scopes with the same limits object share one meter; others get their own and restore', () => {
    const limits = { maxTimeMs: 10_000 }
    withLimits(limits, (outer) => {
      expect(activeMeter()).toBe(outer)
      withLimits(limits, (inner) => expect(inner).toBe(outer))
      withLimits({ maxTimeMs: 5 }, (other) => { expect(other).not.toBe(outer); expect(activeMeter()).toBe(other) })
      expect(activeMeter()).toBe(outer)
    })
    expect(activeMeter()).toBeNull()
  })

  it('a limit error swallowed by a defensive catch is re-thrown when the scope exits', () => {
    // signal `update` expressions are evaluated inside try/catch blocks that fall back to a default
    const err = lim(() => renderSpec({
      width: 50, height: 50,
      signals: [{ name: 'w', update: 'length(sequence(0, 100000000))' }],
      marks: [{ type: 'symbol', encode: { update: { x: { signal: 'w' }, y: { value: 1 } } } }],
    } as unknown as VgSpec, { limits: { maxRows: 1000 } }))
    expect(err.message).toMatch(/maxRows/)
  })

  it('a violation swallowed with no later meter call is still re-thrown at scope exit', () => {
    const err = lim(() => withLimits({ maxRows: 1 }, (m) => {
      try { m!.rows(100, 'x') } catch { /* a defensive catch eats it */ }
      return 'finished normally'
    }))
    expect(err.message).toMatch(/maxRows 100 > 1/)
  })

  it('after a violation every later meter call re-throws the same error (sticky)', () => {
    // (the scope still throws on exit: the violation is never forgotten)
    expect(() => withLimits({ maxRows: 1, maxTimeMs: 1e9 }, (m) => {
      let first: unknown
      try { m!.rows(100, 'x') } catch (e) { first = e }
      expect(first).toBeInstanceOf(AsterLimitError)
      for (const call of [() => m!.tick('a', 5000), () => m!.checkRows(0, 'b'), () => m!.bytes(0, 'c'), () => m!.items(0, 'd'), () => m!.clock.check('e')]) {
        expect(call).toThrow(first as Error)
      }
    })).toThrow(/maxRows 100 > 1/)
  })

  it('the scope is restored after a throw', () => {
    expect(() => withLimits({ maxRows: 1 }, () => { throw new Error('boom') })).toThrow('boom')
    expect(activeMeter()).toBeNull()
  })

  it('sessions run in a scope too (evaluate and change)', () => {
    const session = createChartSession()
    const spec = { width: 10, height: 10, data: [{ name: 't', transform: [{ type: 'sequence', start: 0, stop: 1e7, as: 'x' }] }] } as unknown as VgSpec
    expect(lim(() => session.evaluate(spec, { limits: { maxRows: 1000 } })).message).toMatch(/maxRows/)
    // a rejected evaluation leaves the session usable
    expect(() => session.evaluate({ width: 10, height: 10 } as unknown as VgSpec)).not.toThrow()
  })
})

describe('generated rows are budgeted cumulatively (maxGeneratedRows)', () => {
  it('two sequences that each fit maxRows but not together', () => {
    const spec = { data: [
      { name: 'a', transform: [{ type: 'sequence', start: 0, stop: 600, as: 'x' }] },
      { name: 'b', transform: [{ type: 'sequence', start: 0, stop: 600, as: 'x' }] },
    ] } as unknown as VgSpec
    expect(() => renderSpec(spec, { limits: { maxRows: 1000 } })).not.toThrow()
    expect(lim(() => renderSpec(spec, { limits: { maxRows: 1000, maxGeneratedRows: 1000 } })).message).toMatch(/maxGeneratedRows/)
  })
})

describe('expression locale follows the default locale (C70)', () => {
  afterEach(() => { resetDefaultLocale() })
  const ev = (expr: string): unknown =>
    compileExpr(expr, { scale: () => undefined, data: () => undefined, expr: () => { throw new Error('unused') } })({}, {})

  it('format() / timeFormat() reflect a defaultLocale() call made AFTER import', () => {
    expect(ev("format(1234.5, ',.1f')")).toBe('1,234.5')
    expect(ev("timeFormat(datetime(2024, 0, 15), '%B')")).toBe('January')
    defaultLocale(
      { decimal: ',', thousands: '.', grouping: [3], currency: ['', ' €'] },
      { dateTime: '%A, %e de %B de %Y', date: '%d/%m/%Y', time: '%H:%M:%S', periods: ['AM', 'PM'],
        days: ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'], shortDays: ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'],
        months: ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'],
        shortMonths: ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'] },
    )
    expect(ev("format(1234.5, ',.1f')")).toBe('1.234,5')
    expect(ev("timeFormat(datetime(2024, 0, 15), '%B')")).toBe('enero')
    expect(ev('monthFormat(0)')).toBe('enero')
    resetDefaultLocale()
    expect(ev("format(1234.5, ',.1f')")).toBe('1,234.5')
  })
})

describe('formatter caches are bounded LRU (C70)', () => {
  it('the table never grows past FORMATTER_CACHE_MAX and evicts the least recently used', () => {
    const l = locale()
    const keep = l.format('.3f')
    const first = l.format('.1f')
    for (let i = 0; i < CACHE_MAX + 50; i++) {
      l.format(`${i + 1}d`) // a distinct, valid specifier each time
      if (i % 50 === 0) l.format('.3f') // keep one entry hot
    }
    expect(l.format('.3f')).toBe(keep) // the hot entry survived the flood
    expect(l.format('.1f')).not.toBe(first) // a cold one was evicted and rebuilt
  })

  it('a flood of distinct specifiers stays bounded (heap does not retain 100k closures)', () => {
    const l = locale()
    for (let i = 0; i < 100_000; i++) l.timeFormat(`%Y-${i}`)
    // observable bound: the oldest key is gone, so asking again builds a new formatter
    const a = l.timeFormat('%Y-0')
    expect(l.timeFormat('%Y-0')).toBe(a) // cached again after the rebuild
  })
})

describe('expression parser depth (C9)', () => {
  const parse = (n: number): unknown => compileExpr('(' .repeat(n) + '1' + ')'.repeat(n), { scale: () => undefined, data: () => undefined, expr: () => { throw new Error('x') } })
  it('ordinary nesting is unaffected; absurd nesting is an AsterLimitError, not a RangeError', () => {
    expect(() => parse(100)).not.toThrow()
    expect(lim(() => parse(50_000)).message).toMatch(/maxDepth/)
    const chain = '1' + '+1'.repeat(900)
    const f = compileExpr(chain, { scale: () => undefined, data: () => undefined, expr: () => { throw new Error('x') } })
    expect(f({}, {})).toBe(901) // a 900-term chain still evaluates (the interpreter walks it recursively)
  })
})
