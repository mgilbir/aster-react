/**
 * A session evaluating the spec object it evaluated last does not read the spec again (C503): its skeleton -- the walk that bounds the
 * spec's depth and the text of all of it -- is the one made then; and a spec rebuilt around rows that are the same array does not have
 * those rows written as text again. What it must still see: a new object with other content, rows with other values, a spec that cannot
 * be written as text.
 */
import { describe, expect, it, vi } from 'vitest'
import { afterEach } from 'vitest'
import { createChartSession } from './addon-dom.js'
import type { VgSpec } from './types.js'

const rowsOf = (n: number, k = 0): Array<{ x: number; y: number }> => Array.from({ length: n }, (_, i) => ({ x: i, y: (i * 7 + k) % 11 }))
const MANY = 120
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

/** Rows that count the times anything reads a field of them. */
function counted(n: number): { rows: Array<{ x: number; y: number }>; reads: () => number } {
  let reads = 0
  const rows = rowsOf(n).map((r) => ({ get x() { reads++; return r.x }, get y() { reads++; return r.y } }))
  return { rows, reads: () => reads }
}

afterEach(() => vi.unstubAllEnvs())

describe('a session and the spec object it evaluated last', () => {
  it('evaluating the same object again writes none of it as text', () => {
    const session = createChartSession()
    const spec = specOf(rowsOf(MANY))
    const first = session.evaluate(spec, {})
    // (a development build reads the spec again to say it was changed in place: the cost this is about is production's)
    vi.stubEnv('NODE_ENV', 'production')
    const stringify = vi.spyOn(JSON, 'stringify')
    try {
      const again = session.evaluate(spec, {})
      expect(again).toBe(first)
      expect(stringify).not.toHaveBeenCalled()
    } finally { stringify.mockRestore(); vi.unstubAllEnvs() }
  })

  it('a new spec object that is the same chart does write itself, and is still the same scene', () => {
    const session = createChartSession()
    const rows = rowsOf(MANY)
    const first = session.evaluate(specOf(rows), {})
    const stringify = vi.spyOn(JSON, 'stringify')
    try {
      expect(session.evaluate(specOf(rows), {})).toBe(first)
      expect(stringify).toHaveBeenCalled()
    } finally { stringify.mockRestore() }
  })

  it('a new spec object around the same nested rows does not read those rows again', () => {
    const session = createChartSession()
    const { rows, reads } = counted(MANY)
    const first = session.evaluate(specOf(rows), {})
    const afterFirst = reads()
    expect(afterFirst).toBeGreaterThan(0)
    for (let i = 0; i < 3; i++) {
      // (the rows are read by the evaluation too when it is not a no-op: this is one, and the count must not move)
      expect(session.evaluate(specOf(rows), {})).toBe(first)
      expect(reads()).toBe(afterFirst)
    }
  })

  it('nested rows with other values are another chart; the same values in another array are the same chart', () => {
    const session = createChartSession()
    const first = session.evaluate(specOf(rowsOf(MANY)), {})
    expect(session.evaluate(specOf(rowsOf(MANY)), {})).toBe(first)
    const other = session.evaluate(specOf(rowsOf(MANY, 3)), {})
    expect(other).not.toBe(first)
    const svg = (s: unknown): string => JSON.stringify((s as { items?: unknown }).items, (k, v) => (k === 'datum' || k === 'mark' ? undefined : v))
    expect(svg(other)).not.toBe(svg(first))
  })

  it('a spec edited in place is not seen (the spec is treated as immutable), and a development build says so once', () => {
    const warn = vi.fn()
    const session = createChartSession()
    const spec = specOf(rowsOf(10), 20)
    const first = session.evaluate(spec, { logger: { error: vi.fn(), warn } })
    ;((spec as unknown as { marks: Array<{ encode: { update: { size: { value: number } } } }> }).marks[1]!.encode.update.size).value = 400
    expect(session.evaluate(spec, { logger: { error: vi.fn(), warn } })).toBe(first)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]![0])).toMatch(/spec object was changed in place/)
    session.evaluate(spec, { logger: { error: vi.fn(), warn } })
    expect(warn).toHaveBeenCalledTimes(1)
    // a new object with the edit is read
    expect(session.evaluate(JSON.parse(JSON.stringify(spec)) as VgSpec, {})).not.toBe(first)
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
