/**
 * The doors of the engine refuse what is plainly a mistake with a message that names the mistake (C306, C644, C645), instead of a
 * TypeError from inside the engine or, worse, a chart that silently ignores what was passed. Every case below ran silently, or with a
 * raw `TypeError: Cannot read properties of null`, before.
 */
import { describe, it, expect, vi } from 'vitest'
import { compileChart } from './compiler.js'
import { createChartSession } from './session.js'
import { createChartStream } from './stream.js'
import { evaluateChart } from './evaluate.js'
import { renderSpec } from './index.js'
import type { VgSpec } from './types.js'

const spec = {
  width: 100, height: 50,
  data: [{ name: 'table', values: [{ a: 1 }] }],
  marks: [{ type: 'rect', from: { data: 'table' }, encode: { enter: { x: { field: 'a' }, width: { value: 5 }, height: { value: 5 } } } }],
} as unknown as VgSpec
const bad = (v: unknown): never => v as never

describe('host `data` (C306: Vega\'s view.data(name, rows) throws "Unrecognized data set")', () => {
  it('a name no top-level dataset declares is refused, naming the datasets there are', () => {
    expect(() => renderSpec(spec, { data: { tabel: [{ a: 2 }] } })).toThrow(/names dataset "tabel", which the chart does not declare \(it declares: table/)
  })

  it('on every door that takes data: render, a compiled chart, a session', () => {
    const input = { data: { tabel: [{ a: 2 }] } }
    expect(() => evaluateChart(compileChart(spec), input)).toThrow(/dataset "tabel"/)
    expect(() => createChartSession().evaluate(spec, input)).toThrow(/dataset "tabel"/)
  })

  it('a list where a record by dataset is expected is refused', () => {
    expect(() => renderSpec(spec, bad({ data: [{ a: 1 }] }))).toThrow(/input\.data must be an object of rows by dataset name .*got a list/)
  })

  it('the declared name, and null rows (no rows given), still render', () => {
    expect(renderSpec(spec, { data: { table: [{ a: 2 }] } })).toContain('<svg')
    expect(renderSpec(spec, bad({ data: { table: null } }))).toContain('<svg')
  })

  it('a stream flush refuses the name too (a pushed typo is not a silent no-op)', () => {
    const s = createChartStream(spec, { policy: 'drop-oldest' })
    expect(s.push({ data: { tabel: [{ a: 3 }] } })).toBe(true)
    expect(() => s.flush()).toThrow(/dataset "tabel"/)
  })
})

describe('the doors that take a spec or a compiled chart (C644)', () => {
  it.each([null, undefined, 'spec', 3])('a session and a stream refuse %s as compileChart does', (v) => {
    expect(() => createChartSession().evaluate(bad(v))).toThrow('[aster] ChartSession.evaluate expects a Vega spec object')
    expect(() => createChartStream(bad(v))).toThrow('[aster] createChartStream expects a Vega spec object')
    expect(() => compileChart(bad(v))).toThrow('[aster] compileChart expects a Vega spec object')
  })

  it('evaluateChart of a spec (the mistake its name invites) says what it wants', () => {
    expect(() => evaluateChart(bad(spec), {})).toThrow(/\[aster\] evaluateChart expects a CompiledChart \(compileChart\(spec\) makes one\), got an object that is no compiled chart/)
    expect(() => evaluateChart(bad(null))).toThrow(/got null/)
    expect(evaluateChart(compileChart(spec)).items.length).toBeGreaterThan(0)
  })

  it('a partial logger is completed from the console: the report of an error is not a TypeError of its own', () => {
    const failing = { width: 10, height: 10, signals: [{ name: 's', value: 0 }], data: [{ name: 't', values: [{ x: 1 }], transform: [{ type: 'formula', expr: 'datum.x.y.z', as: 'q' }] }] } as unknown as VgSpec
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      // (the failing expression is reported through the logger, and the chart carries on)
      const seen: unknown[] = []
      expect(() => renderSpec(failing, { logger: { warn: () => {}, error: (...a: unknown[]) => { seen.push(a) } } })).not.toThrow()
      expect(seen.length, 'a complete logger hears the error').toBeGreaterThan(0)
      // a logger without `error`: the console answers, no TypeError
      expect(() => renderSpec(failing, bad({ logger: {} }))).not.toThrow()
      expect(error).toHaveBeenCalled()
      // a logger with `error` only: the report reaches it, `warn` falls back
      const errors: unknown[] = []
      expect(() => renderSpec(failing, bad({ logger: { error: (...a: unknown[]) => { errors.push(a) } } }))).not.toThrow()
      expect(errors.length).toBeGreaterThan(0)
    } finally { error.mockRestore() }
  })
})

describe('stream options and batches (C645)', () => {
  it('a policy that is no policy ("drop_oldest") is refused, not run as drop-newest', () => {
    expect(() => createChartStream(spec, bad({ policy: 'drop_oldest' }))).toThrow(/stream policy must be one of coalesce, drop-oldest, drop-newest, error, got "drop_oldest"/)
  })

  it.each([['capacity', 0], ['capacity', -3], ['maxQueuedRows', 0]])('%s: %s is refused, not read as 1', (name, v) => {
    expect(() => createChartStream(spec, { [name]: v })).toThrow(new RegExp(`stream ${name} must be at least 1`))
    expect(() => createChartStream(spec, { [name]: Infinity })).not.toThrow()
  })

  it('a batch key that is no batch field is refused (push({ rows }), push({ appends }))', () => {
    const s = createChartStream(spec)
    expect(() => s.push(bad({ rows: [{ a: 1 }] }))).toThrow(/stream batch\.rows is not a batch field \(known: data, append, pulse/)
    expect(() => s.push(bad({ appends: { table: [] } }))).toThrow(/batch\.appends/)
    expect(s.push({ append: { table: [{ a: 2 }] } })).toBe(true)
  })
})
