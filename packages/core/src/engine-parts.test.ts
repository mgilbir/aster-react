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

const SPEC_PARTS = ENGINE_PARTS.filter((p) => p !== 'canvas')
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
  const argLists: unknown[][] = [[], ['a'], ['abc', RE], ['abc', RE, 'x'], [['a', 'b'], RE], ['store', { a: 1 }], ['store', { a: 1 }, 'union']]
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

  it('under limits, without the screen, a pattern is refused before it is compiled or run', () => {
    lean()
    // (what runs a pattern: a test or exec of a regular expression whose source is the spec's)
    const ran: string[] = []
    const test = vi.spyOn(RegExp.prototype, 'test').mockImplementation(function (this: RegExp, s: string) { ran.push(this.source); return RegExp.prototype.exec.call(this, s) !== null })
    try {
      for (const [expr, source] of [["test('^(a+)+$', 'aaaa')", '^(a+)+$'], ['test(/^(a+)+$/, "aaaa")', '^(a+)+$'], ["replace('aaaa', /a+/, 'b')", 'a+'], ["split('a,b', regexp(','))", ',']] as const) {
        ran.length = 0
        expect(() => withLimits({ maxTimeMs: 10_000 }, () => evaluateChart(compileChart(spec(expr)), { limits: { maxTimeMs: 10_000 } })), expr).toThrow(MISSING)
        expect(ran.filter((s) => s === source), expr).toEqual([])
      }
    } finally {
      test.mockRestore()
    }
  })
  it('with the screen loaded it refuses a dangerous pattern as the full engine does, and lets a safe one run', async () => {
    lean()
    expect(parts(spec("test('^(a+)+$', 'aaaa')"), { limits: true })).toBe('regex')
    await loadParts(['regex'])
    expect(() => signal("test('^(a+)+$', 'aaaa')", { maxTimeMs: 10_000 })).toThrow(AsterLimitError)
    expect(() => signal("test('^(a+)+$', 'aaaa')", { maxTimeMs: 10_000 })).toThrow(/regexSafety/)
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
    expect(parts(spec, { random: true })).toBe('')
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
