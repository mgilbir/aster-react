/**
 * Recovered errors follow vega (audit C90).
 *
 * vega does not throw out of a render when an expression fails: the dataflow logs the error
 * through its logger and carries on with what it has -- a conditional-encode test or a signal
 * in an encode that throws leaves that item part-encoded and every later item unencoded, a
 * transform that throws publishes no rows (its marks are never built), a sort that throws
 * leaves data order. The engine used to swallow the first, throw on the second and swallow
 * the third. Each case is rendered by real vega (its logger captured) and by the engine
 * (RuntimeInput.logger captured): the SVG must be identical and BOTH must have reported the error.
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import '@aster/core/geo'
import '@aster/core/transforms'
import { renderSpec } from '@aster/core'
import { canonicalizeSvg, diffCanonical } from './normalize.js'

type Spec = Record<string, unknown>

async function oracle(spec: Spec): Promise<{ svg: string; errors: string[] }> {
  const errors: string[] = []
  const logger = {
    level() { return 2 },
    error: (...a: unknown[]) => { errors.push(a.map(String).join(' ')); return logger },
    warn: () => logger, info: () => logger, debug: () => logger,
  }
  const view = new (vega as unknown as { View: new (rt: unknown, o: unknown) => { runAsync(): Promise<void>; toSVG(): Promise<string>; finalize(): void } }).View(
    vega.parse(spec as never),
    { renderer: 'none', logger },
  )
  try {
    await view.runAsync()
    return { svg: await view.toSVG(), errors }
  } finally {
    view.finalize()
  }
}

function engine(spec: Spec): { svg: string; errors: unknown[] } {
  const errors: unknown[] = []
  const svg = renderSpec(spec as never, { logger: { error: (...a) => { errors.push(a[0]) }, warn: () => {} } })
  return { svg, errors }
}

const DATA = (extra: Record<string, unknown> = {}) => [
  { name: 't', values: [{ a: 1, o: { x: 1 } }, { a: 2 }, { a: 3, o: { x: 3 } }, { a: 4, o: { x: 4 } }], ...extra },
]
const frame = (marks: unknown[], data: unknown[] = DATA(), more: Spec = {}): Spec => ({ width: 120, height: 40, padding: 0, autosize: 'none', data, marks, ...more })
const rect = (update: Record<string, unknown>, more: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'rect', from: { data: 't' }, ...more, encode: { update: { width: { value: 5 }, height: { value: 5 }, ...update } },
})

const CASES: Array<[string, Spec]> = [
  ['conditional test throws', frame([rect({ x: { field: 'a', mult: 10 }, fill: [{ test: 'datum.o.x > 1', value: 'red' }, { value: 'blue' }] })])],
  ['conditional branch value throws', frame([rect({ x: { field: 'a', mult: 10 }, fill: [{ test: 'datum.a > 0', signal: 'datum.o.x ? "red" : "blue"' }, { value: 'blue' }] })])],
  ['signal in an encode throws', frame([rect({ x: { signal: 'datum.o.x' }, fill: { value: 'red' } })])],
  ['the first item fails', frame([rect({ x: { signal: 'datum.nope.x' }, fill: { value: 'red' } })])],
  ['filter predicate throws', frame([rect({ x: { field: 'a', mult: 10 } })], DATA({ transform: [{ type: 'filter', expr: 'datum.o.x > 1' }] }))],
  ['formula throws', frame([rect({ x: { field: 'z', mult: 10 } })], DATA({ transform: [{ type: 'formula', as: 'z', expr: 'datum.o.x + 1' }] }))],
  ['a later transform of the pipeline throws', frame([rect({ x: { field: 'a', mult: 10 } })], DATA({ transform: [{ type: 'filter', expr: 'datum.a > 1' }, { type: 'filter', expr: 'datum.o.x > 1' }] }))],
  ['mark sort throws', frame([rect({ x: { field: 'a', mult: 10 }, fill: { value: 'teal' } }, { sort: { field: 'datum.o.x' } })])],
  // the abort is the whole run's: a mark AFTER the failing one is left unencoded too
  ['an error also leaves the marks after it unencoded', frame([rect({ x: { signal: 'datum.o.x' }, fill: { value: 'red' } }), rect({ x: { field: 'a', mult: 10 }, y: { value: 20 }, fill: { value: 'green' } })])],
]

describe('recovered errors are logged and the render carries on, like vega (C90)', () => {
  it.each(CASES)('%s', async (_name, spec) => {
    const want = await oracle(spec)
    expect(want.errors.length, 'vega itself must report the error').toBeGreaterThan(0)
    const got = engine(spec) // must not throw
    expect(got.errors.length, 'the engine must report it too').toBeGreaterThan(0)
    expect(got.errors[0]).toBeInstanceOf(Error)
    expect(diffCanonical(canonicalizeSvg(want.svg), canonicalizeSvg(got.svg))).toEqual([])
  })

  it('the default logger is the console: nothing is swallowed even without a host logger', () => {
    const seen: unknown[] = []
    const orig = console.error
    console.error = (...a: unknown[]) => { seen.push(a[0]) }
    try {
      renderSpec(CASES[0]![1] as never)
    } finally {
      console.error = orig
    }
    expect(seen.length).toBeGreaterThan(0)
  })

  it('limit refusals are NOT recovered: they still throw', () => {
    const spec = frame([rect({ x: { field: 'a' } })], DATA({ transform: [{ type: 'filter', expr: 'true' }] }))
    expect(() => renderSpec(spec as never, { limits: { maxRows: 2 }, logger: { error: () => {}, warn: () => {} } })).toThrow(/maxRows|rows/i)
  })

  it('an expression that does not PARSE is a spec error and still throws (vega throws it from vega.parse)', async () => {
    const spec = frame([rect({ x: { field: 'a' } })], DATA({ transform: [{ type: 'filter', expr: 'datum.a >' }] }))
    expect(() => vega.parse(spec as never)).toThrow()
    const logs: unknown[] = []
    expect(() => renderSpec(spec as never, { logger: { error: (...a) => { logs.push(a[0]) }, warn: () => {} } })).toThrow()
    expect(logs).toEqual([])
  })

  it('an evaluation that failed does not become the base of the next incremental one', () => {
    const logs: unknown[] = []
    const logger = { error: (...a: unknown[]) => { logs.push(a[0]) }, warn: () => {} }
    const spec = frame([rect({ x: { field: 'a', mult: 10 }, fill: [{ test: 'datum.o.x > 1', value: 'red' }, { value: 'blue' }] })])
    const first = renderSpec(spec as never, { logger })
    const second = renderSpec(spec as never, { logger })
    expect(second).toBe(first)
    expect(logs.length).toBe(2)
  })
})
