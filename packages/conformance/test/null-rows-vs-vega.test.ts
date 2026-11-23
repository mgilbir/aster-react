// @vitest-environment node
/**
 * A row that is `null` or `undefined`. vega reads a tuple's id wherever rows enter a dataset through a changeset -- a spec's inline
 * `values` (the View throws as it is made), the host's rows (`view.data` / `view.insert` throw before they change anything),
 * `setdata` -- and wherever a mark joins its tuples: there such a row throws JavaScript's own TypeError, `Cannot read properties of
 * null (reading 'Symbol(vega_id)')`. Its dynamic loader (a `{signal}` values) only ingests, so a `null` goes through and the error is
 * the mark's join's, logged as a dataflow error: the pass stops at that mark (the marks before it are made, it and the ones after it
 * are not). A row that is a number, a string or a boolean is wrapped as `{data}` everywhere, as vega wraps it.
 *
 * Aster fails in the same cases, at the same points, with the same class of error (TypeError); its message is its own -- which row
 * of which dataset, given how -- rather than vega's: compared with vega here are the class and where it is raised (thrown or logged,
 * how often, what is drawn), and the messages are pinned at the end.
 */
import { describe, it, expect } from 'vitest'
import * as vega from 'vega'
import { renderSpec, renderSceneToSvg, createChartStream } from '@aster-charts/core'
import { createChartSession } from '@aster-charts/core/dom'
import { canonicalizeSvg, diffCanonical, type CanonicalResult } from '../src/normalize.js'

type Spec = Record<string, unknown>
const text = (from: string, x = 5): Spec => ({ type: 'text', from: { data: from }, encode: { update: { x: { value: x }, y: { value: 20 }, text: { signal: '"<" + datum.a + "|" + datum.data + ">"' } } } })
const lone: Spec = { type: 'rule', encode: { update: { x: { value: 50 }, y: { value: 0 }, y2: { value: 40 }, stroke: { value: 'black' } } } }
const frame = (data: unknown[], marks: unknown[], extra: Spec = {}): Spec => ({ width: 100, height: 50, padding: 0, autosize: 'none', data, marks, ...extra })

/** What was thrown and logged, by class (vega's message and Aster's differ by design), and Aster's messages. */
interface Outcome { thrown?: string; svg?: CanonicalResult; errors: string[]; messages?: string[] }
const classOf = (e: unknown): string => (e instanceof Error ? e.constructor.name : String(e).split(':')[0]!)

async function withVega(spec: Spec, after?: (view: any) => Promise<void> | void): Promise<Outcome> {
  const errors: string[] = []
  const logger = { level() { return logger }, error: (...a: unknown[]) => { errors.push(classOf(a[0])); return logger }, warn: () => logger, info: () => logger, debug: () => logger }
  let view: any
  try {
    view = new (vega as any).View(vega.parse(spec as never), { renderer: 'none', logger })
  } catch (e) {
    return { thrown: classOf(e), errors }
  }
  try {
    await view.runAsync()
    if (after) {
      try { await after(view) } catch (e) { return { thrown: classOf(e), svg: canonicalizeSvg(await view.toSVG()), errors } }
    }
    return { svg: canonicalizeSvg(await view.toSVG()), errors }
  } finally {
    view.finalize()
  }
}

function withAster(f: (logger: unknown) => string): Outcome {
  const errors: string[] = []
  const messages: string[] = []
  const logger = { error: (e: unknown) => { errors.push(classOf(e)); messages.push((e as Error).message) }, warn: () => {} }
  try {
    return { svg: canonicalizeSvg(f(logger)), errors, messages }
  } catch (e) {
    return { thrown: classOf(e), errors, messages: [...messages, (e as Error).message] }
  }
}

function same(want: Outcome, got: Outcome): void {
  expect(got.thrown).toBe(want.thrown)
  expect(got.errors).toEqual(want.errors)
  if (want.svg !== undefined && got.svg !== undefined) expect(diffCanonical(want.svg, got.svg).slice(0, 3)).toEqual([])
}

const PATHS = {
  renderSpec: (spec: Spec, input: Spec = {}) => (logger: unknown) => renderSpec(spec as never, { ...input, logger } as never) as string,
  session: (spec: Spec, input: Spec = {}) => (logger: unknown) => renderSceneToSvg(createChartSession().evaluate(spec as never, { ...input, logger } as never)),
  stream: (spec: Spec, input: Spec = {}) => (logger: unknown) => {
    const stream = createChartStream(spec as never, { initial: { ...input, logger } as never })
    try {
      stream.push({ signals: {} })
      stream.flush()
      return renderSceneToSvg(stream.scene()!)
    } finally { stream.close() }
  },
}

describe('a null or undefined row where rows enter a dataset: the same TypeError, where vega throws it', () => {
  const INLINE: Record<string, unknown[]> = {
    'a null row': [{ a: 1 }, null],
    'an undefined row': [undefined, { a: 2 }],
    'a null row first, an undefined one after': [null, undefined],
    'a null row among primitives': [1, 'x', null, true],
    'only primitives (wrapped, no error)': [1, 'x', true, { a: 3 }],
  }
  for (const [name, values] of Object.entries(INLINE)) {
    for (const [path, run] of Object.entries(PATHS)) {
      it(`inline values, ${name}: ${path}`, async () => {
        const spec = frame([{ name: 't', values }], [text('t')])
        same(await withVega(spec), withAster(run(spec)))
      })
    }
    it(`inline values with no mark reading them, ${name}`, async () => {
      const spec = frame([{ name: 't', values }], [lone])
      same(await withVega(spec), withAster(PATHS.renderSpec(spec)))
    })
    it(`a nested group's inline values, ${name}`, async () => {
      const spec = frame([], [{ type: 'group', data: [{ name: 'g', values }], marks: [text('g')] }])
      same(await withVega(spec), withAster(PATHS.renderSpec(spec)))
    })
  }

  const HOST: Record<string, unknown[]> = {
    'a null row': [{ a: 1 }, null],
    'an undefined row': [{ a: 1 }, undefined],
    'primitives (wrapped, no error)': [5, { a: 2 }],
  }
  for (const [name, rows] of Object.entries(HOST)) {
    const spec = frame([{ name: 't', values: [{ a: 9 }] }], [text('t')])
    it(`host rows (view.data / the data prop), ${name}: renderSpec and a session`, async () => {
      const want = await withVega(spec, (view) => view.data('t', rows))
      // (vega's view.data throws before it changes anything; Aster's evaluation with those rows throws the same error)
      for (const run of [PATHS.renderSpec, PATHS.session]) {
        const got = withAster(run(spec, { data: { t: rows } }))
        expect(got.thrown).toBe(want.thrown)
        if (want.thrown === undefined) same(want, got)
      }
    })
    it(`a session given host rows and dataChanges over them, ${name}`, async () => {
      const want = await withVega(spec, (view) => view.data('t', rows))
      const session = createChartSession()
      const start = rows.map((r) => (r == null ? { a: 0 } : r))
      session.evaluate(spec as never, { data: { t: start } })
      const got = withAster((logger) => renderSceneToSvg(session.evaluate(spec as never, { data: { t: rows }, dataChanges: { t: [1] }, logger } as never)))
      expect(got.thrown).toBe(want.thrown)
    })
    it(`a stream append (view.insert), ${name}`, async () => {
      const want = await withVega(spec, (view) => view.insert('t', rows))
      const stream = createChartStream(spec as never)
      const got = withAster(() => { stream.push({ append: { t: rows } }); stream.flush(); return renderSceneToSvg(stream.scene()!) })
      expect(got.thrown).toBe(want.thrown)
      // (a refused batch is not queued: the stream goes on as it was)
      if (want.thrown !== undefined) {
        expect(stream.stats().queuedRows ?? 0).toBe(0)
        stream.push({ append: { t: [{ a: 4 }] } })
        expect(stream.flush()).not.toBeNull()
      }
      stream.close()
    })
  }
})

describe('setdata with a null row: the error vega logs, at the same point', () => {
  for (const rows of ['[{a: 7}, null]', '[{a: 7}, data("u")[3]]', '[5, {a: 2}]']) {
    it(`setdata("t", ${rows})`, async () => {
      const spec = frame([{ name: 't', values: [{ a: 1 }] }, { name: 'u', values: [] }], [text('t')], { signals: [{ name: 's', update: `setdata("t", ${rows})` }] })
      same(await withVega(spec), withAster(PATHS.renderSpec(spec)))
    })
  }
})

describe('a null or undefined row a {signal} values gives: the mark that joins it fails the pass, as vega logs it', () => {
  const CASES: Record<string, Spec> = {
    'the failing mark first': frame([{ name: 't', values: { signal: '[1, null]' } }, { name: 'u', values: [{ a: 1 }] }], [text('t', 10), text('u', 30), lone]),
    'the failing mark last': frame([{ name: 't', values: { signal: '[{a: 1}, null]' } }, { name: 'u', values: [{ a: 1 }] }], [lone, text('u', 30), text('t', 10)]),
    'an undefined row': frame([{ name: 't', values: { signal: '[1, data("u")[5]]' } }, { name: 'u', values: [{ a: 1 }] }], [lone, text('t')]),
    'no mark reads it (no error)': frame([{ name: 't', values: { signal: '[1, null]' } }], [lone]),
  }
  for (const [name, spec] of Object.entries(CASES)) {
    for (const [path, run] of Object.entries(PATHS)) {
      it(`${name}: ${path}`, async () => {
        same(await withVega(spec), withAster(run(spec)))
      })
    }
  }

  // (on a change, vega's pass stops at the mark and its old items stay on screen; the engine is a pure function of its inputs and
  // draws what the new signal values make -- what vega draws for them from the start -- as every second render does, see the
  // `retained` count of the sweep-signals gate. The error is the same, logged at the change.)
  it('a signal-driven change to a null row: the same error, logged at the change, and the chart of the new values', async () => {
    const spec = frame([{ name: 't', values: { signal: 'n ? [1, null] : [{a: 1}, {a: 2}]' } }], [lone, text('t')], { signals: [{ name: 'n', value: false }] })
    const changed = await withVega(spec, async (view) => { view.signal('n', true); await view.runAsync() })
    const fresh = await withVega({ ...spec, signals: [{ name: 'n', value: true }] })
    expect(fresh.errors).toEqual(changed.errors)
    for (const path of ['session', 'stream'] as const) {
      const errors: string[] = []
      const logger = { error: (e: unknown) => { errors.push(classOf(e)) }, warn: () => {} }
      let svg: string
      if (path === 'session') {
        const session = createChartSession()
        session.evaluate(spec as never, { logger } as never)
        expect(errors).toEqual([])
        svg = renderSceneToSvg(session.evaluate(spec as never, { signals: { n: true }, logger } as never))
      } else {
        const stream = createChartStream(spec as never, { initial: { logger } as never })
        stream.push({ signals: {} })
        stream.flush()
        expect(errors).toEqual([])
        stream.push({ signals: { n: true } })
        stream.flush()
        svg = renderSceneToSvg(stream.scene()!)
        stream.close()
      }
      expect(errors, path).toEqual(changed.errors)
      expect(diffCanonical(fresh.svg!, canonicalizeSvg(svg)).slice(0, 3), path).toEqual([])
    }
  })
})

describe("Aster's message: which row of which dataset, given how", () => {
  const SOURCES: Record<string, string> = {
    values: 'its inline `values`', data: 'the rows the host gave it (`data`)', append: 'a stream `push` (`append`)',
    snapshot: 'a stream `push` (`data` snapshot)', signal: 'the rows its `{signal}` values made', setdata: '`setdata(...)`',
  }
  const message = (dataset: string, row: number, source: string, value: 'null' | 'undefined', listed = false): string =>
    `[aster] dataset "${dataset}": row ${row} of ${SOURCES[source]} is ${value}${listed ? ' (an index `dataChanges` lists)' : ''}; ` +
    'a row must be an object or a value (a number, string or boolean is read as {data: value}), not null or undefined. vega rejects this data too.'
  const caught = (f: () => unknown): Error => { try { f() } catch (e) { return e as Error } throw new Error('did not throw') }

  it('inline values, through renderSpec, a session and a stream (thrown)', () => {
    for (const [values, row, value] of [[[{ a: 1 }, null], 1, 'null'], [[undefined, { a: 2 }], 0, 'undefined']] as const) {
      const spec = frame([{ name: 't', values: [...values] as unknown[] }], [text('t')])
      for (const run of Object.values(PATHS)) {
        const e = caught(() => run(spec)(undefined))
        expect(e).toBeInstanceOf(TypeError)
        expect(e.message).toBe(message('t', row, 'values', value))
      }
    }
  })

  it('host rows, and an index the host listed in dataChanges (thrown)', () => {
    const spec = frame([{ name: 't', values: [{ a: 9 }] }], [text('t')])
    expect(caught(() => renderSpec(spec as never, { data: { t: [{ a: 1 }, { a: 2 }, null] } } as never)).message).toBe(message('t', 2, 'data', 'null'))
    const session = createChartSession()
    session.evaluate(spec as never, { data: { t: [{ a: 1 }, { a: 2 }] } } as never)
    const e = caught(() => session.evaluate(spec as never, { data: { t: [{ a: 1 }, undefined] }, dataChanges: { t: [1] } } as never))
    expect(e).toBeInstanceOf(TypeError)
    expect(e.message).toBe(message('t', 1, 'data', 'undefined', true))
  })

  it('a stream push: thrown at the call, naming append or snapshot', () => {
    const stream = createChartStream(frame([{ name: 't', values: [{ a: 1 }] }], [text('t')]) as never)
    expect(caught(() => stream.push({ append: { t: [{ a: 2 }, { a: 3 }, null] } })).message).toBe(message('t', 2, 'append', 'null'))
    expect(caught(() => stream.push({ data: { t: [undefined] } })).message).toBe(message('t', 0, 'snapshot', 'undefined'))
    stream.close()
  })

  it('logged: a group\'s inline values, setdata, a {signal} values joined by a mark, and a signal-driven change to one', () => {
    const logged = (spec: Spec, input: Spec = {}, after?: (s: ReturnType<typeof createChartSession>, logger: unknown) => void): string[] => {
      const messages: string[] = []
      const logger = { error: (e: unknown) => { expect(e).toBeInstanceOf(TypeError); messages.push((e as Error).message) }, warn: () => {} }
      const session = createChartSession()
      session.evaluate(spec as never, { ...input, logger } as never)
      after?.(session, logger)
      return messages
    }
    expect(logged(frame([], [{ type: 'group', data: [{ name: 'g', values: [{ a: 1 }, null] }], marks: [text('g')] }]))).toEqual([message('g', 1, 'values', 'null')])
    expect(logged(frame([{ name: 't', values: [{ a: 1 }] }], [text('t')], { signals: [{ name: 's', update: 'setdata("t", [{a: 7}, null])' }] }))).toEqual([message('t', 1, 'setdata', 'null')])
    expect(logged(frame([{ name: 't', values: { signal: '[1, null]' } }], [text('t')]))).toEqual([message('t', 1, 'signal', 'null')])
    const changing = frame([{ name: 't', values: { signal: 'n ? [1, 2, null] : [1, 2]' } }], [text('t')], { signals: [{ name: 'n', value: false }] })
    expect(logged(changing, {}, (session, logger) => { session.evaluate(changing as never, { signals: { n: true }, logger } as never) })).toEqual([message('t', 2, 'signal', 'null')])
  })
})
