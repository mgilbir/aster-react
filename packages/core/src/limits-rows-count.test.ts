// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { renderSpec, createChartStream, AsterLimitError } from './index.js'
import { createChartSession } from './addon-dom.js'
import type { RuntimeInput, VgSpec } from './types.js'

// `maxRows` budgets the rows a chart is given, each counted once, wherever it comes from: a dataset's inline `values`, the host's
// `data` under its name (which replaces the inline rows, it does not add to them), a nested group's inline rows, a stream's snapshot and appends. Every case below sits at exactly `maxRows` (renders) and at `maxRows + 1` (refused
// with `maxRows`), spread over several datasets so that it is the summed pre-flight that decides, not one dataset's own count.

const MAX = 10
const rows = (n: number, tag = 'r'): Array<Record<string, unknown>> => Array.from({ length: n }, (_, i) => ({ k: `${tag}${i}`, v: i }))
const rect = (from: string): Record<string, unknown> => ({ type: 'rect', from: { data: from }, encode: { update: { x: { field: 'v' }, width: { value: 1 }, y: { value: 0 }, height: { value: 1 } } } })
const spec = (data: unknown[], marks: unknown[] = [], extra: Record<string, unknown> = {}): VgSpec =>
  ({ width: 50, height: 20, data, marks: marks.length ? marks : data.filter((d) => typeof (d as { name?: unknown }).name === 'string').map((d) => rect((d as { name: string }).name)), ...extra }) as unknown as VgSpec

/** A case: what the chart is given when it holds `total` rows, split as the case splits them. */
type Case = (total: number) => { spec: VgSpec; input?: RuntimeInput }
const half = (total: number): [number, number] => [Math.floor(total / 2), total - Math.floor(total / 2)]

const CASES: Record<string, Case> = {
  'two inline datasets': (n) => { const [a, b] = half(n); return { spec: spec([{ name: 'a', values: rows(a) }, { name: 'b', values: rows(b) }]) } },
  'host rows replace a dataset\'s inline rows (not added to them)': (n) => {
    const [a, b] = half(n)
    return { spec: spec([{ name: 'a', values: rows(MAX) }, { name: 'b', values: rows(b) }]), input: { data: { a: rows(a, 'h') } } }
  },
  'host rows for a url dataset': (n) => { const [a, b] = half(n); return { spec: spec([{ name: 'a', url: 'x.json' }, { name: 'b', values: rows(b) }]), input: { data: { a: rows(a) } } } },
  'host rows for a dataset with no rows of its own': (n) => { const [a, b] = half(n); return { spec: spec([{ name: 'a' }, { name: 'b', values: rows(b) }]), input: { data: { a: rows(a) } } } },
  'a nested group\'s inline rows': (n) => {
    const [a, b] = half(n)
    return { spec: spec([{ name: 'a', values: rows(a) }], [rect('a'), { type: 'group', data: [{ name: 'g', values: rows(b) }], marks: [rect('g')] }]) }
  },
  'a dataset derived from another adds no rows': (n) => {
    const [a, b] = half(n)
    return { spec: spec([{ name: 'a', values: rows(a) }, { name: 'd', source: 'a', transform: [{ type: 'filter', expr: 'true' }] }, { name: 'b', values: rows(b) }]) }
  },
  'host rows for a derived dataset are not rows of the chart': (n) => {
    const [a, b] = half(n)
    return { spec: spec([{ name: 'a', values: rows(a) }, { name: 'd', source: 'a' }, { name: 'b', values: rows(b) }]), input: { data: { d: rows(MAX) } } }
  },
}

const refused = (f: () => unknown): boolean => {
  try { f(); return false } catch (e) {
    if (e instanceof AsterLimitError && /maxRows/.test(e.message)) return true
    throw e
  }
}

describe('maxRows counts every row once, on every path', () => {
  for (const [name, make] of Object.entries(CASES)) {
    for (const [path, run] of Object.entries({
      renderSpec: (c: ReturnType<Case>) => renderSpec(c.spec, { ...c.input, limits: { maxRows: MAX } }),
      'a session': (c: ReturnType<Case>) => createChartSession().evaluate(c.spec, { ...c.input, limits: { maxRows: MAX } }),
    })) {
      it(`${path}: ${name}`, () => {
        expect(refused(() => run(make(MAX)))).toBe(false)
        expect(refused(() => run(make(MAX + 1)))).toBe(true)
      })
    }
  }

  it('a host array under a name no dataset has is refused, as Vega refuses it (C306); a budget still counts it first', () => {
    const s = spec([{ name: 'b', values: rows(2) }])
    const input = { data: { extra: rows(2) }, limits: { maxRows: MAX } }
    expect(() => renderSpec(s, input)).toThrow(/dataset "extra", which the chart does not declare/)
    expect(() => createChartSession().evaluate(s, input)).toThrow(/dataset "extra", which the chart does not declare/)
    // (the pre-flight of the budget reads every row the host gives, so a huge array under a typo is a limit error before it is a usage error)
    expect(refused(() => renderSpec(s, { data: { extra: rows(MAX + 1) }, limits: { maxRows: MAX } }))).toBe(true)
  })

  it('a session: `dataChanges` over host rows count the rows as they are now', () => {
    const s = spec([{ name: 'a', values: rows(4) }, { name: 'b', values: rows(5) }])
    const session = createChartSession()
    const a5 = rows(5)
    session.evaluate(s, { data: { a: a5 }, limits: { maxRows: MAX } })
    const edited = a5.map((r, i) => (i === 2 ? { ...r, v: 9 } : r))
    expect(refused(() => session.evaluate(s, { data: { a: edited }, dataChanges: { a: [2] }, limits: { maxRows: MAX } }))).toBe(false)
    expect(refused(() => session.evaluate(s, { data: { a: [...edited, { k: 'x', v: 0 }] }, limits: { maxRows: MAX } }))).toBe(true)
  })

  for (const [name, make] of Object.entries({
    'inline rows and appends': (inline: number, appended: number) => ({ spec: spec([{ name: 'a', values: rows(inline) }, { name: 'b', values: rows(2) }]), initial: {}, append: { a: rows(appended, 'n') } }),
    'initial host rows and appends': (inline: number, appended: number) => ({ spec: spec([{ name: 'a', values: rows(MAX) }, { name: 'b', values: rows(2) }]), initial: { data: { a: rows(inline, 'h') } }, append: { a: rows(appended, 'n') } }),
    'a snapshot': (inline: number, appended: number) => ({ spec: spec([{ name: 'a', values: rows(MAX) }, { name: 'b', values: rows(2) }]), initial: {}, data: { a: rows(inline + appended, 's') } }),
  })) {
    it(`a stream: ${name}`, () => {
      const flush = (total: number): unknown => {
        const c = make(4, total - 2 - 4) as { spec: VgSpec; initial: Record<string, unknown>; append?: Record<string, unknown[]>; data?: Record<string, unknown[]> }
        const stream = createChartStream(c.spec, { limits: { maxRows: MAX }, initial: c.initial as never })
        stream.push(c.data ? { data: c.data } : { append: c.append! })
        try { return stream.flush() } finally { stream.close() }
      }
      expect(refused(() => flush(MAX))).toBe(false)
      expect(refused(() => flush(MAX + 1))).toBe(true)
    })
  }
})
