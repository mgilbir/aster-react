/**
 * LIVE differential for `modify(...)` on named datasets (the selection stores) and for the signals that read them.
 *
 * A scenario is a dataset `s_store` (optionally sorted by a `collect`, as vega-lite does for extensional
 * stores), a `modify(...)` call, and a sequence of steps; each step sets some signals and fires the call.
 * Real vega runs it as a `View`; Aster runs it through the signal event loop (`bindSceneSignals`: the call
 * is a signal handler, the edit is applied when the pass ends, and the derived signals that read the store
 * run again), in the same process on one engine. After every step both must agree on
 *   - the derived signals (`vlSelectionResolve` of the store, the length of `data()`),
 *   - the dataset's rows, and
 *   - the signal the call is made from (what `modify` returned).
 * Aster's side also feeds the rows its loop reported through `onData` to a FRESH evaluation, which must show
 * the same dataset and signals: the incremental path and the fresh path are the same function of the inputs.
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { compileChart } from '../../core/src/compiler.ts'
import { evaluateChart } from '../../core/src/runtime.ts'
import { bindSceneSignals } from '../../core/src/signals.ts'
import { createChartSession } from '../../core/src/session.ts'
import { enc, quietLogger } from './differential-util.mts'

type Row = Record<string, unknown>

function image(v: unknown): unknown {
  if (v instanceof Set) return { $: 'set', values: [...v].map(image) }
  if (Array.isArray(v)) return v.map(image)
  if (v instanceof Date) return enc(v)
  if (v !== null && typeof v === 'object') {
    const o: Record<string, unknown> = {}
    for (const k of Object.keys(v).sort()) {
      const x = (v as Row)[k]
      if (typeof x !== 'function') o[k] = image(x)
    }
    return o
  }
  return enc(v)
}

const STORE = 's_store'
const T = (unit: string, fields: Row[], values: unknown[]): Row => ({ unit, fields, values })
const F = (field: string, type = 'E'): Row => ({ field, type })
const ID = (unit: string, id: number): Row => ({ unit, _vgsid_: id })

interface Step { set?: Record<string, unknown> }
interface Scenario {
  name: string
  sorted?: boolean
  init?: () => Row[]
  /** the arguments of modify(), as an expression over the signals a, b, c, d, e */
  call: string
  steps: Step[]
}

const P1 = (): Row => T('', [F('k')], ['x'])
const P2 = (): Row => T('', [F('k')], ['y'])
const P3 = (): Row => T('', [F('k')], ['z'])
const U = (unit: string, v: string): Row => T(unit, [F('k')], [v])
const R = (unit: string, lo: number, hi: number): Row => T(unit, [F('n', 'R')], [[lo, hi]])

/** vega-lite's point selection, resolve global: modify(store, toggle ? null : tuple, toggle ? null : true, toggle ? tuple : null). */
const POINT_GLOBAL = 'modify("s_store", a ? null : b, a ? null : true, a ? b : null)'
/** resolve union / intersect: the tuple's own unit is replaced. */
const POINT_UNIT = 'modify("s_store", a ? null : b, a ? null : {unit: c}, a ? b : null)'
/** interval selections: modify(store, tuple, true). */
const INTERVAL = 'modify("s_store", b, true)'

const SCENARIOS: Scenario[] = [
  {
    name: 'click, click elsewhere, click on nothing (replace)',
    call: POINT_GLOBAL,
    steps: [{ set: { a: false, b: P1() } }, { set: { b: P2() } }, { set: { b: null } }, { set: { b: P3() } }],
  },
  {
    name: 'toggle on and off (shift-click)',
    call: POINT_GLOBAL,
    steps: [
      { set: { a: false, b: P1() } }, { set: { a: true, b: P2() } }, { set: { b: P3() } }, { set: { b: P2() } },
      { set: { b: P1() } }, { set: { b: P1() } }, { set: { a: false, b: null } },
    ],
  },
  {
    name: 'toggle with a tuple that is only equal (arrays compare by value)',
    call: POINT_GLOBAL,
    steps: [{ set: { a: true, b: T('', [F('k'), F('n')], ['x', [1, 2]]) } }, { set: { b: T('', [F('k'), F('n')], ['x', [1, 2]]) } }, { set: { b: T('', [F('k'), F('n')], ['x', [1, 3]]) } }],
  },
  {
    name: 'initial values, then toggle one of them off',
    init: () => [P1(), P2()],
    call: POINT_GLOBAL,
    steps: [{ set: { a: true, b: P1() } }, { set: { b: P3() } }, { set: { a: false, b: null } }],
  },
  {
    name: 'two units, each replaces only its own tuples',
    call: POINT_UNIT,
    steps: [
      { set: { a: false, b: U('u1', 'x'), c: 'u1' } }, { set: { b: U('u2', 'x'), c: 'u2' } }, { set: { b: U('u1', 'y'), c: 'u1' } },
      { set: { b: null, c: 'u2' } }, { set: { a: true, b: U('u1', 'z'), c: 'u1' } },
    ],
  },
  {
    name: 'interval brushes: the store holds one tuple',
    call: INTERVAL,
    steps: [{ set: { b: R('', 1, 3) } }, { set: { b: R('', 2, 5) } }, { set: { b: null } }, { set: { b: R('', 0, 1) } }],
  },
  {
    name: 'interval in a Date-valued domain',
    call: INTERVAL,
    steps: [{ set: { b: T('', [F('t', 'R')], [[new Date(Date.UTC(2020, 0, 1)), new Date(Date.UTC(2021, 0, 1))]]) } }, { set: { b: null } }],
  },
  {
    name: 'ids: sorted store, insert and remove',
    sorted: true,
    call: POINT_GLOBAL,
    steps: [{ set: { a: false, b: ID('', 5) } }, { set: { a: true, b: ID('', 2) } }, { set: { b: ID('', 9) } }, { set: { b: ID('', 5) } }, { set: { b: ID('', 1) } }],
  },
  {
    name: 'ids across units, toggled',
    sorted: true,
    init: () => [ID('u1', 3), ID('u1', 1)],
    call: POINT_UNIT,
    steps: [{ set: { a: true, b: ID('u2', 3), c: 'u2' } }, { set: { b: ID('u1', 3), c: 'u1' } }, { set: { a: false, b: ID('u2', 8), c: 'u2' } }],
  },
  {
    name: 'insert an array of tuples',
    call: 'modify("s_store", b)',
    steps: [{ set: { b: [P1(), P2()] } }, { set: { b: [P3()] } }, { set: { b: [] } }, { set: { b: P1() } }],
  },
  {
    name: 'remove: everything, by pattern, by array of data() tuples',
    init: () => [U('u1', 'x'), U('u1', 'y'), U('u2', 'x'), U('u3', 'q')],
    call: 'modify("s_store", null, a)',
    steps: [{ set: { a: { unit: 'u1' } } }, { set: { a: { unit: 'zzz' } } }, { set: { a: { fields: [{ field: 'k', type: 'E' }] } } }, { set: { a: true } }, { set: { a: true } }],
  },
  {
    name: 'remove and insert in one call keep the inserted tuple',
    init: () => [U('u1', 'x')],
    call: 'modify("s_store", b, true)',
    steps: [{ set: { b: U('u1', 'x') } }, { set: { b: U('u1', 'x') } }],
  },
  {
    name: 'modify a tuple field',
    init: () => [U('u1', 'x'), U('u1', 'y')],
    call: 'modify("s_store", null, null, null, data("s_store")[b], {unit: c})',
    steps: [{ set: { b: 0, c: 'moved' } }, { set: { b: 1, c: 'moved2' } }, { set: { b: 5, c: 'nowhere' } }],
  },
  {
    name: 'nothing to do (empty store, no insert, no toggle) returns 0',
    call: 'modify("s_store", b ? {unit: ""} : null, true)',
    steps: [{ set: { b: false } }, { set: { b: false } }],
  },
]

interface Observed {
  res: unknown
  len: unknown
  m: unknown
  rows: unknown
}

function specOf(sc: Scenario): Record<string, unknown> {
  return {
    data: [{
      name: STORE,
      ...(sc.init ? { values: sc.init() } : {}),
      ...(sc.sorted ? { transform: [{ type: 'collect', sort: { field: '_vgsid_' } }] } : {}),
    }],
    signals: [
      ...['a', 'b', 'c', 'd', 'e'].map((name) => ({ name, value: null })),
      { name: 'go', value: 0 },
      { name: 'm', on: [{ events: { signal: 'go' }, update: sc.call }] },
      { name: 'res', update: `vlSelectionResolve("${STORE}", "union", true, true)` },
      { name: 'len', update: `length(data("${STORE}"))` },
    ],
  }
}

async function vegaSteps(sc: Scenario): Promise<Observed[]> {
  const errors: unknown[][] = []
  const q = quietLogger(errors)
  const view = new vega.View(vega.parse(structuredClone(specOf(sc)) as vega.Spec), { renderer: 'none', logger: q as never })
  view.logger(q as never)
  await view.runAsync()
  const out: Observed[] = []
  let go = 0
  for (const step of sc.steps) {
    for (const [k, v] of Object.entries(step.set ?? {})) view.signal(k, structuredClone(v))
    await view.runAsync()
    view.signal('go', ++go)
    await view.runAsync()
    out.push({ res: image(view.signal('res')), len: view.signal('len'), m: view.signal('m'), rows: image(view.data(STORE)) })
  }
  if (errors.length) throw new Error(`vega logged: ${String(errors[0])}`)
  return out
}

const fakeSvg = { addEventListener() {}, removeEventListener() {} } as unknown as SVGSVGElement

async function asterSteps(sc: Scenario): Promise<Observed[]> {
  const spec = specOf(sc)
  const compiled = compileChart(structuredClone(spec) as never)
  const errors: unknown[][] = []
  const logger = quietLogger(errors) as never
  const session = createChartSession()
  const hostData: Record<string, unknown[]> = {}
  const hostSignals: Record<string, unknown> = {}
  const out: Observed[] = []

  let scene = session.evaluate(structuredClone(spec), { data: hostData, signals: hostSignals, logger })
  let binding = bind()
  function bind() {
    return bindSceneSignals(fakeSvg, scene, { ...hostSignals }, {
      logger,
      onSignal: (name, value, all) => { Object.assign(hostSignals, all); void name; void value },
      onData: (name, rows) => { hostData[name] = rows },
    }, { data: hostData })
  }
  const rerender = (): void => {
    scene = session.evaluate(structuredClone(spec) as never, { data: { ...hostData }, signals: { ...hostSignals }, logger })
    binding.detach()
    binding = bind()
  }
  let go = 0
  for (const step of sc.steps) {
    for (const [k, v] of Object.entries(step.set ?? {})) binding.setSignal(k, structuredClone(v))
    rerender()
    binding.setSignal('go', ++go)
    // what the loop itself computed before anything re-rendered: the derived signals ran again on the edited store
    const was = (scene as unknown as { signalParams: Row }).signalParams
    const liveOf = (n: string): unknown => (Object.hasOwn(hostSignals, n) ? hostSignals[n] : was[n])
    const live = { res: image(liveOf('res')), len: liveOf('len') }
    rerender()
    const p = (scene as unknown as { signalParams: Row }).signalParams
    // the same inputs, evaluated from scratch
    const fresh = evaluateChart(compiled, { data: { ...hostData }, signals: { ...hostSignals }, logger })
    const fp = (fresh as unknown as { signalParams: Row }).signalParams
    expect(live, 'the event loop settles the derived signals itself').toEqual({ res: image(p.res), len: p.len })
    expect(image(fp.res), 'fresh evaluation shows the same selection').toEqual(image(p.res))
    expect(fp.len, 'fresh evaluation shows the same dataset').toEqual(p.len)
    out.push({
      res: image(p.res),
      len: p.len,
      m: p.m,
      rows: image((scene as unknown as { runtime: { data: (n: string) => unknown } }).runtime.data(STORE)),
    })
  }
  if (errors.length) throw new Error(`aster logged: ${String(errors[0])}`)
  return out
}

describe(`modify on datasets vs vega@${vega.version}`, () => {
  for (const sc of SCENARIOS) {
    it(sc.name, async () => {
      const want = await vegaSteps(sc)
      const got = await asterSteps(sc)
      expect(got).toEqual(want)
    })
  }
})
