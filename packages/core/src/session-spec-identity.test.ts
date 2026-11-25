/**
 * A session evaluating a DEEP-FROZEN spec object again reads none of it (C503): a frozen spec cannot change, so the skeleton made for it
 * stands. Any other spec is compared by content, an edit in place included. Nested rows are written once per array only when frozen.
 */
import { describe, expect, it, vi } from 'vitest'
import { createChartSession } from './addon-dom.js'
import type { VgSpec } from './types.js'

const rowsOf = (n: number, k = 0): Array<{ x: number; y: number }> => Array.from({ length: n }, (_, i) => ({ x: i, y: (i * 7 + k) % 11 }))
const MANY = 120
const freeze = <T,>(v: T): T => {
  if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) { Object.freeze(v); for (const k of Object.keys(v)) freeze((v as Record<string, unknown>)[k]) }
  return v
}
const group = (rows: Array<{ x: number; y: number }>, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'group', data: [{ name: 'inner', values: rows }],
  scales: [{ name: 'gx', type: 'linear', domain: { data: 'inner', field: 'x' }, range: [0, 100] }, { name: 'gy', type: 'linear', domain: { data: 'inner', field: 'y' }, range: [50, 0] }],
  marks: [{ type: 'symbol', from: { data: 'inner' }, encode: { update: { x: { scale: 'gx', field: 'x' }, y: { scale: 'gy', field: 'y' }, size: { value: 20 } } } }],
  ...extra,
})
const specOf = (rows: Array<{ x: number; y: number }>, size = 20, top = rowsOf(5)): VgSpec => ({
  width: 200, height: 100, padding: 5, autosize: 'none',
  data: [{ name: 'table', values: top }],
  marks: [group(rows), { type: 'symbol', from: { data: 'table' }, encode: { update: { x: { field: 'x' }, y: { field: 'y' }, size: { value: size } } } }],
}) as unknown as VgSpec

describe('a session and the spec object it evaluated last', () => {
  it('a deep-frozen spec evaluated again writes none of it as text', () => {
    const session = createChartSession()
    const spec = freeze(specOf(rowsOf(MANY)))
    const first = session.evaluate(spec, {})
    const stringify = vi.spyOn(JSON, 'stringify')
    try {
      expect(session.evaluate(spec, {})).toBe(first)
      expect(session.evaluate(spec, {})).toBe(first)
      expect(stringify).not.toHaveBeenCalled()
    } finally { stringify.mockRestore() }
  })

  it('a spec that is not frozen is compared by content each time, the same object or not', () => {
    const session = createChartSession()
    const spec = specOf(rowsOf(MANY))
    const first = session.evaluate(spec, {})
    const stringify = vi.spyOn(JSON, 'stringify')
    try {
      expect(session.evaluate(spec, {})).toBe(first)
      expect(stringify).toHaveBeenCalled()
      stringify.mockClear()
      expect(session.evaluate(specOf(rowsOf(MANY)), {})).toBe(first)
      expect(stringify).toHaveBeenCalled()
    } finally { stringify.mockRestore() }
  })

  it('a spec that is only partly frozen is read each time (a frozen top with a live inside)', () => {
    const session = createChartSession()
    const spec = specOf(rowsOf(10), 20)
    const marks = (spec as unknown as { marks: unknown[] }).marks
    Object.freeze(spec); Object.freeze(marks)
    const first = session.evaluate(spec, {})
    ;((marks[1] as { encode: { update: { size: { value: number } } } }).encode.update.size).value = 400
    expect(session.evaluate(spec, {})).not.toBe(first)
  })

  it('a spec edited in place IS seen', () => {
    const session = createChartSession()
    const spec = specOf(rowsOf(10), 20)
    const first = session.evaluate(spec, {})
    ;((spec as unknown as { marks: Array<{ encode: { update: { size: { value: number } } } }> }).marks[1]!.encode.update.size).value = 400
    const edited = session.evaluate(spec, {})
    expect(edited).not.toBe(first)
    expect(session.evaluate(spec, {})).toBe(edited)
  })

  it('a nested dataset\'s frozen rows are written once per array', () => {
    const rows = freeze(rowsOf(MANY))
    const live = rowsOf(MANY)
    const session = createChartSession()
    const sessionLive = createChartSession()
    session.evaluate(specOf(rows), {})
    sessionLive.evaluate(specOf(live), {})
    const stringify = vi.spyOn(JSON, 'stringify')
    const writes = (r: unknown): number => stringify.mock.calls.filter((c) => c[0] === r).length
    try {
      for (let i = 0; i < 3; i++) { session.evaluate(specOf(rows), {}); sessionLive.evaluate(specOf(live), {}) }
      expect(writes(rows)).toBe(0)
    } finally { stringify.mockRestore() }
  })

  it('a live row edited in place under a new spec object is seen', () => {
    const session = createChartSession()
    const live = rowsOf(MANY)
    const first = session.evaluate(specOf(live), {})
    live[3] = { x: 3, y: 99 }
    expect(session.evaluate(specOf(live), {})).not.toBe(first)
  })

  it('a spec that cannot be written as text is never cached, the same object or not', () => {
    const session = createChartSession()
    const spec = specOf(rowsOf(10)) as unknown as Record<string, unknown>
    // (a value JSON refuses: the skeleton of such a spec is made anew on every call)
    spec.usermeta = { toJSON: (): never => { throw new Error('not text') } }
    const a = session.evaluate(spec as unknown as VgSpec, {})
    const b = session.evaluate(spec as unknown as VgSpec, {})
    expect(b).not.toBe(a)
  })
})
