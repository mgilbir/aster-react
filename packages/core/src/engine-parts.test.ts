// @vitest-environment jsdom
/**
 * The parts of the engine the React shells load on demand (engine-parts.ts): where each is read, what reading an empty slot does,
 * and that the detector (`specNeeds` in addons.ts) names each where it is read. The corpus-wide check of the detector against the
 * engine is packages/conformance/src/parts-needed.test.ts; this file covers what a render of the corpus does not reach: expression
 * functions called with any arguments, the signal loop's handlers, the regular-expression screen, and re-evaluations.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { compileChart, evaluateChart, renderSceneToSvg } from './index.js'
import { bindSceneSignals, type SignalBinding } from './signals.js'
import { createChartSession } from './session.js'
import { compileExpr, expressionFunctionNames, type ExpressionRuntime } from './expression.js'
import { withLimits, AsterLimitError } from './limits.js'
import { ENGINE_PARTS, installPart, partLoaded, setPartRequester, withdrawParts, type EnginePart } from './engine-parts.js'
import { PART_FUNCTIONS, REGEX_ARGUMENT_FUNCTIONS, loadParts, specNeeds } from './addons.js'
import { setTimerClock } from './timer.js'
import { FakeClock } from './timer.testlib.js'
import type { VgSpec } from './types.js'

const SPEC_PARTS = ENGINE_PARTS.filter((p) => p !== 'canvas' && p !== 'signals')
const MISSING = /the "(\w+)" part of the engine is not loaded/
const parts = (spec: unknown, options?: Parameters<typeof specNeeds>[1]): string => [...specNeeds(spec as VgSpec, options).parts].join()

let restore: (() => void) | null = null
afterEach(async () => {
  restore?.()
  restore = null
  await loadParts(SPEC_PARTS.filter((p) => !partLoaded(p)))
})
/** As a browser build of the shells starts: every slot a spec can need empty (`afterEach` fills them again). */
const lean = (): void => { restore = withdrawParts(SPEC_PARTS) }

describe('an expression function that reads a part is one the detector names', () => {
  const RE = /a+/
  // (and the arguments the calendar and colour functions read: a month or a day, a date and a format, a unit, a colour)
  // (small instants: a date also reaches the functions that take a count, and as a number it must stay a small one)
  const DAY = new Date(5)
  const argLists: unknown[][] = [
    [], ['a'], ['abc', RE], ['abc', RE, 'x'], [['a', 'b'], RE], ['store', { a: 1 }], ['store', { a: 1 }, 'union'],
    [1], [DAY], [DAY, '%Y'], ['2020', '%Y'], ['day', DAY, 2], ['day', DAY, new Date(3 * 86_400_000)], [['year', 'month']], ['#f00'], ['#f00', '#0f0'],
  ]
  const runtime: ExpressionRuntime = { scale: () => undefined, data: () => [{ unit: 'u', fields: [], values: [] }], expr: (e) => compileExpr(e, runtime) }

  it('calling every function of the table with a regular expression argument, under limits, from empty slots', () => {
    lean()
    const reads = new Map<string, Set<string>>()
    for (const name of expressionFunctionNames()) {
      for (const args of argLists) {
        const fn = compileExpr(`${name}(${args.map((_, i) => `a${i}`).join(', ')})`, runtime)
        const signals = Object.fromEntries(args.map((a, i) => [`a${i}`, a]))
        try {
          withLimits({ maxTimeMs: 10_000 }, () => fn({}, signals))
        } catch (e) {
          const m = MISSING.exec(e instanceof Error ? e.message : String(e))
          if (m) { if (!reads.has(name)) reads.set(name, new Set()); reads.get(name)!.add(m[1]!) }
        }
      }
    }
    const unnamed: string[] = []
    for (const [name, read] of reads) {
      for (const p of read) {
        const named = PART_FUNCTIONS[name] === p || (p === 'regex' && REGEX_ARGUMENT_FUNCTIONS.has(name))
        if (!named) unnamed.push(`${name} reads ${p}`)
      }
    }
    expect(unnamed).toEqual([])
    // and every entry of the tables is a function that reads its part (no stale entry; modify, setdata and intersect read theirs in
    // the signal loop, where the runtime's own functions are bound: see below)
    for (const [name, p] of Object.entries(PART_FUNCTIONS)) if (!['modify', 'setdata', 'intersect'].includes(name)) expect(reads.get(name), name).toContain(p)
    for (const name of REGEX_ARGUMENT_FUNCTIONS) expect(reads.get(name), name).toContain('regex')
  })
})

describe('the regular-expression screen is never skipped', () => {
  const spec = (expr: string): VgSpec => ({ width: 10, height: 10, signals: [{ name: 's', update: expr }] } as VgSpec)
  const signal = (expr: string, limits?: object): unknown => evaluateChart(compileChart(spec(expr)), limits ? { limits } : {})

  it('under limits, without the screen, a pattern is refused before it is run (and one the expression computes before it is built)', () => {
    lean()
    // What compiles a pattern: the RegExp constructor (a literal in an expression is built through it); what runs one: `exec`, which
    // `test`, `replace` and `split` all go through (spying `test` alone sees none of the last two). Both are recorded for the
    // sources of the spec's patterns.
    const sources = new Set(['^(a+)+$', 'a+', ','])
    const made: string[] = []
    const ran: string[] = []
    const RealRegExp = RegExp
    const exec = RegExp.prototype.exec
    const spy = vi.spyOn(RegExp.prototype, 'exec').mockImplementation(function (this: RegExp, s: string) { ran.push(this.source); return exec.call(this, s) })
    vi.stubGlobal('RegExp', new Proxy(RealRegExp, {
      construct(target, args, newTarget) {
        const first = args[0] as unknown
        made.push(first instanceof RealRegExp ? first.source : String(first))
        return Reflect.construct(target, args, newTarget)
      },
    }))
    try {
      // (a literal is built when the expression is compiled, from the spec's own text: building never runs it, and the screen refuses
    // it before its first run. A pattern the expression computes -- a string, `regexp()` -- is built only after the screen, so it
    // is never built: that is what `compiled` asserts)
    for (const [expr, literal] of [["test('^(a+)+$', 'aaaa')", false], ['test(/^(a+)+$/, "aaaa")', true], ["replace('aaaa', /a+/, 'b')", true], ["split('a,b', regexp(','))", false]] as const) {
        made.length = 0
        ran.length = 0
        expect(() => withLimits({ maxTimeMs: 10_000 }, () => evaluateChart(compileChart(spec(expr)), { limits: { maxTimeMs: 10_000 } })), expr).toThrow(MISSING)
        if (!literal) expect(made.filter((s) => sources.has(s)), `${expr}: compiled`).toEqual([])
        expect(ran.filter((s) => sources.has(s)), `${expr}: run`).toEqual([])
      }
      // the recorders see what they record: an unlimited evaluation of the same expressions compiles and runs them
      made.length = 0
      ran.length = 0
      evaluateChart(compileChart(spec("replace('zzzz', /z+/, 'b')")))
      evaluateChart(compileChart(spec("split('a;b', regexp(';'))")))
      expect(made).toEqual(expect.arrayContaining(['z+', ';']))
      expect(ran).toEqual(expect.arrayContaining(['z+', ';']))
    } finally {
      vi.unstubAllGlobals()
      spy.mockRestore()
    }
  })
  it('with the screen loaded it refuses a dangerous pattern as the full engine does, and lets a safe one run', async () => {
    lean()
    expect(parts(spec("test('^(a+)+$', 'aaaa')"), { limits: true })).toBe('regex')
    await loadParts(['regex'])
    expect(() => signal("test('^(a+)+$', 'aaaa')", { maxTimeMs: 10_000 })).toThrow(AsterLimitError)
    expect(() => signal("test('^(a+)+$', 'aaaa')", { maxTimeMs: 10_000 })).toThrow(/regexSafety/)
    // ... and lets a safe one run: the same call with a pattern that cannot blow up answers, under the same limits
    expect(signal("test('^a+$', 'aaaa')", { maxTimeMs: 10_000 })).toBeDefined()
    expect(() => signal("test('^a+$', 'aaaa')", { maxTimeMs: 10_000 })).not.toThrow()
    expect(() => signal("replace('aaaa', /a+/, 'b')", { maxTimeMs: 10_000 })).not.toThrow()
    expect(() => signal("split('a,b', regexp(','))", { maxTimeMs: 10_000 })).not.toThrow()
  })
  it('without limits no pattern is screened, so none needs the screen', () => {
    lean()
    expect(parts(spec("test('^a+$', 'aaaa')"))).toBe('')
    expect(() => evaluateChart(compileChart(spec("test('^a+$', 'aaaa')")))).not.toThrow()
  })
  it('the detector names the screen for anything that can hand it a pattern, and only under limits', () => {
    const l = { limits: true }
    expect(parts(spec("test('a', 'b')"), l)).toBe('regex')
    expect(parts(spec("regexp('a')"), l)).toBe('regex')
    expect(parts(spec("'a' + /b/"), l)).toBe('regex')
    expect(parts(spec('replace(datum.s, datum.p, "")'), l)).toBe('regex')
    expect(parts(spec('split(datum.s, datum.p)'), l)).toBe('regex')
    expect(parts(spec("replace(datum.s, '-', '')"), l)).toBe('')
    expect(parts(spec('indexof(datum.s, datum.p)'), l)).toBe('')
    expect(parts({ data: [{ name: 'd', transform: [{ type: 'countpattern', field: 't' }] }] }, l)).toBe('regex')
    expect(parts({ signals: [{ name: 's', on: [{ events: "click[test('a', event.type)]", update: '1' }] }] }, l)).toBe('regex')
    expect(parts(spec("test('a', 'b')"))).toBe('')
  })
})

describe('the signal loop reads its parts where the detector looks for them', () => {
  const opened: SignalBinding[] = []
  afterEach(() => {
    for (const b of opened.splice(0)) b.release()
    document.body.innerHTML = ''
    setTimerClock(null)
  })
  function mount(signals: unknown[]): { spec: VgSpec; svg: SVGSVGElement; scene: ReturnType<typeof evaluateChart> } {
    const spec = { width: 100, height: 60, signals, data: [{ name: 'store' }, { name: 't', values: [{ x: 1 }] }], marks: [{ type: 'rect', from: { data: 't' }, encode: { update: { x: { value: 1 }, y: { value: 1 }, width: { value: 50 }, height: { value: 50 } } } }] } as unknown as VgSpec
    const host = document.createElement('div')
    document.body.appendChild(host)
    const scene = evaluateChart(compileChart(spec))
    host.innerHTML = renderSceneToSvg(scene)
    return { spec, svg: host.querySelector('svg') as SVGSVGElement, scene }
  }
  /** What the loop logs while it binds and handles one click, with `loaded` the only event-loop parts in their slots. */
  function clickWith(signals: unknown[], loaded: EnginePart[]): string[] {
    const { svg, scene } = mount(signals)
    const errors: string[] = []
    restore = withdrawParts(['intersect', 'modify', 'timer'].filter((p) => !loaded.includes(p as EnginePart)) as EnginePart[])
    const b = bindSceneSignals(svg, scene, {}, { logger: { error: (...a) => errors.push(a.map(String).join(' ')), warn: () => {} }, onData: () => {} })
    opened.push(b)
    svg.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    return errors
  }
  const cases: Array<[EnginePart, unknown[]]> = [
    ['modify', [{ name: 'go', value: 0, on: [{ events: 'click', update: 'modify("store", {"a": 1})' }] }]],
    ['modify', [{ name: 'go', value: 0, on: [{ events: 'click', update: 'setdata("store", [{"a": 1}])' }] }]],
    ['intersect', [{ name: 'go', value: 0, on: [{ events: 'click', update: 'length(intersect([0, 0, 100, 60]))' }] }]],
  ]
  it.each(cases)('%s: read by the handler, named by the detector, and enough on its own', (p, signals) => {
    expect(parts({ signals })).toContain(p)
    expect(clickWith(signals, []).join('\n')).toMatch(new RegExp(`the "${p}" part of the engine is not loaded`))
    restore?.()
    restore = null
    expect(clickWith(signals, [p])).toEqual([])
  })
  it('timer: a timer stream reads the scheduler when the loop binds it; the detector names it in every form a stream takes', () => {
    setTimerClock(new FakeClock())
    for (const events of ['timer{100}', { type: 'timer', throttle: 100 }, { merge: ['click', { type: 'timer' }] }, '[mousedown, timer] > timer']) {
      expect(parts({ signals: [{ name: 'n', value: 0, on: [{ events, update: 'n + 1' }] }] }), JSON.stringify(events)).toContain('timer')
    }
    const signals = [{ name: 'n', value: 0, on: [{ events: 'timer{100}', update: 'n + 1' }] }]
    restore = withdrawParts(['timer'])
    const { svg, scene } = mount(signals)
    expect(() => opened.push(bindSceneSignals(svg, scene, {}, { logger: { error: (m) => { throw new Error(String(m)) }, warn: () => {} } }))).toThrow(/the "timer" part of the engine is not loaded/)
  })
})

describe('the pulse path: a re-evaluation without it derives in full, the same scene, and asks for it', () => {
  const spec = {
    width: 120, height: 60,
    data: [
      { name: 't', transform: [{ type: 'identifier', as: 'id' }, { type: 'filter', expr: 'datum.v >= 0' }, { type: 'aggregate', groupby: ['g'], fields: ['v'], ops: ['sum'], as: ['s'] }, { type: 'collect', sort: { field: 'g' } }] },
      { name: 'w', source: 't', transform: [{ type: 'window', ops: ['rank'], as: ['r'] }, { type: 'formula', expr: 'datum.s * 2', as: 'd' }] },
    ],
    scales: [{ name: 'x', type: 'band', domain: { data: 't', field: 'g' }, range: 'width' }, { name: 'y', type: 'linear', domain: { data: 'w', field: 'd' }, range: 'height' }],
    marks: [{ type: 'rect', from: { data: 'w' }, encode: { update: { x: { scale: 'x', field: 'g' }, width: { value: 5 }, y: { scale: 'y', field: 'd' }, y2: { value: 60 } } } }],
  } as unknown as VgSpec
  /** A sequence of row arrays (appends, edits, removals, a filter that flips), each a new array as the shells hand it over. */
  function steps(): Array<Record<string, unknown>[]> {
    let rows: Record<string, unknown>[] = [{ g: 'a', v: 1 }, { g: 'b', v: 2 }]
    const out = [rows]
    const next = (f: (r: Record<string, unknown>[]) => Record<string, unknown>[]): void => { rows = f(rows); out.push(rows) }
    next((r) => [...r, { g: 'c', v: 3 }])
    next((r) => [...r, { g: 'a', v: 4 }, { g: 'd', v: -1 }])
    next((r) => r.map((x, i) => (i === 1 ? { ...x, v: 10 } : x)))
    next((r) => r.slice(0, -1))
    next((r) => r.map((x, i) => (i === 0 ? { ...x, v: -5 } : x)))
    next((r) => [...r, { g: 'e', v: 7 }])
    return out
  }
  const run = (): string[] => {
    const session = createChartSession()
    return steps().map((rows) => renderSceneToSvg(session.evaluate(spec, { data: { t: rows } })))
  }

  it('every step draws what the session with the pulse path draws; the part is asked for at the first change', async () => {
    const full = run()
    const asked: EnginePart[] = []
    setPartRequester((p) => asked.push(p))
    try {
      restore = withdrawParts(['pulse'])
      expect(run()).toEqual(full)
      expect(asked.length).toBeGreaterThan(0)
      expect(new Set(asked)).toEqual(new Set(['pulse']))
      // half way: the part arrives, and the rest of the session is incremental, drawing the same
      const session = createChartSession()
      const out: string[] = []
      steps().forEach((rows, i) => {
        if (i === 3) installPart('pulse', { applyPipelineWithPulse: savedPulse! })
        out.push(renderSceneToSvg(session.evaluate(spec, { data: { t: rows } })))
      })
      expect(out).toEqual(full)
    } finally {
      setPartRequester(null)
    }
  })
  let savedPulse: undefined | ((...args: never[]) => never)
  beforeEach(async () => {
    const mod = await import('./part-pulse.js')
    savedPulse = mod.part.applyPipelineWithPulse as never
  })

  it('with an injected random source a drawing dataset needs it from the first evaluation: which build takes a pulse decides the draws', () => {
    const drawing = { width: 10, height: 10, data: [{ name: 't', transform: [{ type: 'formula', expr: 'random()', as: 'r' }] }], marks: [{ type: 'text', from: { data: 't' }, encode: { update: { text: { field: 'r' } } } }] } as unknown as VgSpec
    expect(parts(drawing, { random: true })).toBe('pulse')
    expect(parts(drawing)).toBe('')
    // (the transforms of `spec` are parts of their own; the pulse path is not among them: its datasets draw nothing)
    expect(parts(spec, { random: true })).toBe('aggregate,window,reshape')
    const draws = (): string[] => {
      let n = 0
      const random = (): number => ((n++ * 37) % 101) / 101
      const session = createChartSession()
      return [[{ k: 1 }], [{ k: 1 }, { k: 2 }], [{ k: 1 }, { k: 2 }, { k: 3 }]].map((rows) => renderSceneToSvg(session.evaluate(drawing, { data: { t: rows }, random })))
    }
    const withPulse = draws()
    restore = withdrawParts(['pulse'])
    expect(draws()).not.toEqual(withPulse)
  })
})

describe('the detector reads the structure', () => {
  it('legends in any scope; a layout on the view or a group mark, not a legend layout in the config', () => {
    expect(parts({ legends: [{ fill: 'c' }] })).toBe('legend,svgpath')
    expect(parts({ marks: [{ type: 'group', marks: [{ type: 'group', legends: [{ fill: 'c' }] }] }] })).toBe('legend,svgpath')
    expect(parts({ legends: [] })).toBe('')
    expect(parts({ layout: { columns: 2 } })).toBe('layout')
    expect(parts({ marks: [{ type: 'group', marks: [{ type: 'group', layout: { columns: 2 } }] }] })).toBe('layout')
    expect(parts({ config: { legend: { layout: { anchor: 'middle' } } } })).toBe('')
  })
  it('path data: a path mark, and any symbol shape that may not be a built-in one, in marks and in the config', () => {
    expect(parts({ marks: [{ type: 'path', encode: { update: { path: { value: 'M0,0L1,1' } } } }] })).toBe('svgpath')
    expect(parts({ marks: [{ type: 'symbol', encode: { update: { shape: { value: 'triangle-up' } } } }] })).toBe('')
    expect(parts({ marks: [{ type: 'symbol', encode: { update: { shape: { value: 'M0,0L1,1Z' } } } }] })).toBe('svgpath')
    expect(parts({ marks: [{ type: 'symbol', encode: { update: { shape: { field: 's' } } } }] })).toBe('svgpath')
    expect(parts({ marks: [{ type: 'symbol', encode: { update: { shape: [{ test: 'datum.a', value: 'circle' }, { value: 'square' }] } } }] })).toBe('svgpath')
    expect(parts({ config: { symbol: { shape: 'M0,0L1,1Z' } } })).toBe('svgpath')
    expect(parts({ config: { legend: { symbolType: 'M0,0L1,1Z' } } })).toBe('svgpath')
    expect(parts({ data: [{ name: 'd', values: [{ shape: 'M0,0' }] }] })).toBe('') // rows are data
  })
  it('vega-selections in any expression, and the event-loop parts', () => {
    expect(parts({ marks: [{ type: 'rect', encode: { update: { opacity: [{ test: 'vlSelectionTest("s_store", datum)', value: 1 }, { value: 0.2 }] } } }] })).toBe('selections')
    expect(parts({ data: [{ name: 'd', transform: [{ type: 'filter', expr: '!length(data("s")) || vlSelectionIdTest("s", datum)' }] }] })).toBe('selections')
    expect(parts({ signals: [{ name: 's', on: [{ events: 'click', update: 'modify("d", datum)' }] }] })).toBe('modify')
    expect(parts({ signals: [{ name: 's', on: [{ events: 'click', update: '1' }] }] })).toBe('')
  })
})

describe('the detector reads the families of the engine from the structure', () => {
  const x = { name: 'x', type: 'linear', domain: [0, 1], range: 'width' }
  it('a transform names its part by its literal type; a facet by its groupby; a domain sorted by an aggregate', () => {
    expect(parts({ data: [{ name: 'd', transform: [{ type: 'aggregate', groupby: ['a'] }] }] })).toBe('aggregate')
    expect(parts({ data: [{ name: 'd', transform: [{ type: 'pivot', field: 'k', value: 'v' }, { type: 'window', ops: ['rank'] }] }] })).toBe('aggregate,window')
    expect(parts({ data: [{ name: 'd', transform: [{ type: 'stack', field: 'v' }, { type: 'filter', expr: 'true' }, { type: 'formula', expr: '1', as: 'o' }] }] })).toBe('reshape')
    expect(parts({ data: [{ name: 'd', transform: [{ type: 'timeunit', field: 'd' }] }] })).toBe('time')
    expect(parts({ marks: [{ type: 'group', from: { facet: { name: 'f', data: 'd', groupby: 'a' } } }] })).toBe('aggregate')
    expect(parts({ marks: [{ type: 'group', from: { facet: { name: 'f', data: 'd', field: 'rows' } } }] })).toBe('')
    expect(parts({ scales: [{ name: 's', type: 'band', domain: { data: 'd', field: 'a', sort: true } }] })).toBe('')
    expect(parts({ scales: [{ name: 's', type: 'band', domain: { data: 'd', field: 'a', sort: { op: 'mean', field: 'v' } } }] })).toBe('aggregate')
    expect(parts({ scales: [{ name: 's', type: 'band', domain: { data: 'd', fields: ['a', 'b'], sort: true } }] })).toBe('aggregate')
  })
  it('time: a calendar scale, a date format type, a date parse pattern, a calendar function', () => {
    expect(parts({ scales: [{ name: 't', type: 'utc' }] })).toBe('time')
    expect(parts({ axes: [{ scale: 'x', formatType: 'time' }], scales: [x] })).toBe('time')
    expect(parts({ axes: [{ scale: 'x', formatType: 'number' }], scales: [x] })).toBe('')
    expect(parts({ axes: [{ scale: 'x', formatType: { signal: 'ft' } }], scales: [x] })).toBe('time')
    expect(parts({ data: [{ name: 'd', format: { parse: { a: 'date:%Y' } } }] })).toBe('time')
    expect(parts({ data: [{ name: 'd', format: { parse: { a: 'date', b: 'number' } } }] })).toBe('')
    expect(parts({ data: [{ name: 'd', format: { parse: 'auto' } }] })).toBe('')
    expect(parts({ signals: [{ name: 's', update: "timeFormat(now(), '%Y')" }] })).toBe('time')
    expect(parts({ signals: [{ name: 's', update: 'year(now())' }] })).toBe('')
  })
  it('curves: a literal curve besides linear, or anything that is not a literal', () => {
    const line = (interpolate: unknown): object => ({ marks: [{ type: 'line', encode: { update: { interpolate } } }] })
    expect(parts(line({ value: 'linear' }))).toBe('')
    expect(parts(line({ value: 'nonsense' }))).toBe('')
    expect(parts(line({ value: 'monotone' }))).toBe('curves')
    expect(parts(line({ signal: 'i' }))).toBe('curves')
    expect(parts(line([{ test: 'datum.a', value: 'linear' }, { value: 'step' }]))).toBe('curves')
    expect(parts({ config: { line: { interpolate: 'basis' } } })).toBe('curves')
    // (a scale's `interpolate` is its colour space, not a curve)
    expect(parts({ scales: [{ name: 'c', type: 'ordinal', interpolate: 'step' }] })).toBe('color')
  })
  it('colours and rare scales: what a scale blends, by its type, scheme, range and interpolate', () => {
    expect(parts({ scales: [{ name: 'c', type: 'ordinal', range: { scheme: 'category10' } }] })).toBe('')
    expect(parts({ scales: [{ name: 'c', type: 'ordinal', range: 'category' }] })).toBe('')
    expect(parts({ scales: [{ name: 'c', type: 'ordinal', range: 'ordinal' }] })).toBe('color')
    expect(parts({ scales: [{ name: 'c', type: 'ordinal', range: 'category' }], config: { range: { category: { scheme: 'blues' } } } })).toBe('color')
    expect(parts({ scales: [{ name: 'c', type: 'quantize', range: { scheme: 'tableau10' } }] })).toBe('scales')
    expect(parts({ scales: [{ name: 'c', type: 'linear', range: ['red', 'blue'] }] })).toBe('color,scales')
    expect(parts({ scales: [{ name: 'c', type: 'linear', range: [0, { signal: 'width' }] }] })).toBe('')
    expect(parts({ signals: [{ name: 'w', value: 10, update: 'containerSize()[0] * 2' }], scales: [{ name: 'c', type: 'linear', range: [0, { signal: 'w' }] }] })).toBe('')
    expect(parts({ signals: [{ name: 'w', value: 'red' }], scales: [{ name: 'c', type: 'linear', range: [0, { signal: 'w' }] }] })).toBe('color,scales')
    expect(parts({ signals: [{ name: 'w', value: 1, bind: { input: 'text' } }], scales: [{ name: 'c', type: 'linear', range: [0, { signal: 'w' }] }] })).toBe('color,scales')
    expect(parts({ scales: [{ name: 'c', type: 'linear', range: { signal: '[0, width]' } }] })).toBe('')
    expect(parts({ scales: [{ name: 'c', type: 'sequential', scheme: 'viridis' }] })).toBe('color,scales')
    expect(parts({ scales: [{ name: 'c', type: 'log', range: 'height' }] })).toBe('scales')
    expect(parts({ scales: [{ name: 'c', type: { signal: 't' } }] })).toBe('time,color,scales')
    expect(parts({ signals: [{ name: 's', update: "luminance('red')" }] })).toBe('color')
  })
  it("a host's signal value that is not a number decides for the colour part, whatever the spec declares", () => {
    const spec = { signals: [{ name: 'w', value: 10 }], scales: [{ name: 'c', type: 'linear', range: [0, { signal: 'w' }] }] }
    expect(parts(spec)).toBe('')
    expect(parts(spec, { signals: { w: 20 } })).toBe('')
    expect(parts(spec, { signals: { w: 'red' } })).toBe('color,scales')
    expect(parts({ scales: [{ name: 'c', type: 'linear', range: [0, { signal: 'width' }] }] }, { signals: { width: 'red' } })).toBe('color,scales')
  })
})

describe('a missed detection is refused, naming the part, never drawn differently', () => {
  const view = { width: 60, height: 40, padding: 0, autosize: 'none' }
  const rows = [{ a: 'x', v: 1, d: Date.UTC(2020, 0, 1) }, { a: 'y', v: 3, d: Date.UTC(2020, 5, 1) }, { a: 'x', v: 2, d: Date.UTC(2021, 0, 1) }]
  const marks = (field: string, more: object = {}): object[] => [{ type: 'line', from: { data: 'd' }, encode: { update: { x: { field: 'v' }, y: { field }, ...more } } }]
  const CASES: Array<[EnginePart, object]> = [
    ['aggregate', { data: [{ name: 'd', values: rows, transform: [{ type: 'aggregate', groupby: ['a'], fields: ['v'], ops: ['sum'], as: ['s'] }] }], marks: marks('s') }],
    ['window', { data: [{ name: 'd', values: rows, transform: [{ type: 'window', ops: ['rank'], as: ['r'] }] }], marks: marks('r') }],
    ['reshape', { data: [{ name: 'd', values: rows, transform: [{ type: 'stack', field: 'v' }] }], marks: marks('y0') }],
    ['time', { data: [{ name: 'd', values: rows }], scales: [{ name: 't', type: 'time', domain: { data: 'd', field: 'd' }, range: 'width' }], marks: marks('v', { x: { scale: 't', field: 'd' } }) }],
    ['time', { data: [{ name: 'd', values: rows, transform: [{ type: 'formula', as: 'l', expr: "timeFormat(datum.d, '%Y')" }] }], marks: [{ type: 'text', from: { data: 'd' }, encode: { update: { text: { field: 'l' } } } }] }],
    ['curves', { data: [{ name: 'd', values: rows }], marks: marks('v', { interpolate: { value: 'monotone' } }) }],
    ['color', { data: [{ name: 'd', values: rows }], scales: [{ name: 'c', type: 'ordinal', domain: { data: 'd', field: 'a' }, range: { scheme: 'blues' } }], marks: marks('v', { stroke: { scale: 'c', field: 'a' } }) }],
    ['color', { data: [{ name: 'd', values: rows }], marks: marks('v', { stroke: { signal: "rgb('red') + ''" } }) }],
    ['scales', { data: [{ name: 'd', values: rows }], scales: [{ name: 'y', type: 'log', domain: [1, 10], range: 'height' }], marks: marks('v', { y: { scale: 'y', field: 'v' } }) }],
  ]
  for (const [p, body] of CASES) {
    it(`${p}: ${JSON.stringify(body).slice(0, 90)}`, () => {
      const spec = { ...view, ...body } as unknown as VgSpec
      expect(specNeeds(spec).parts, 'the detector names it (the test plants the miss by emptying the slot)').toContain(p)
      const full = renderSceneToSvg(createChartSession().evaluate(spec, {}))
      restore = withdrawParts([p])
      let drawn: string | undefined
      expect(() => { drawn = renderSceneToSvg(createChartSession().evaluate(spec, {})) }).toThrow(new RegExp(`\\[aster\\] the "${p}" part of the engine is not loaded`))
      expect(drawn).toBeUndefined()
      restore()
      restore = null
      expect(renderSceneToSvg(createChartSession().evaluate(spec, {}))).toBe(full)
    })
  }
})
