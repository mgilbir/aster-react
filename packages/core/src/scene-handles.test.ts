// @vitest-environment jsdom
/**
 * The handles an evaluated scene carries for the event loop (`runtime`, `compiled`, `signalParams`, `__limits`), and a pulse a host
 * got from `diffRows`.
 *  - a scene that crossed a worker or a JSON round trip has none: `bindSceneSignals` says so, once, through the host's logger
 *    instead of returning a binding that never calls back (C524);
 *  - `diffRows`' own result is a `dataPulse` and a stream pulse, and means what it says: the ranges it names are read as ranges
 *    (C278).
 */
import { describe, expect, it, vi } from 'vitest'
import { compileChart } from './compiler.js'
import { evaluateChart } from './evaluate.js'
import { installAllParts } from './install-parts.testlib.js'
import { renderSceneToDomElement } from './dom.js'
import { renderSceneToSvg } from './render.js'
import { bindSceneSignals } from './signals.js'
import { createChartSession } from './session.js'
import { createChartStream } from './stream.js'
import { diffRows, pulseChangeOf } from './pulse.js'
import type { SceneRoot, VgSpec } from './types.js'

installAllParts()

const SIGNALS: VgSpec = {
  width: 100, height: 50, autosize: 'none',
  signals: [{ name: 'n', value: 1, on: [{ events: 'click', update: 'n + 1' }] }],
  marks: [{ type: 'rect', encode: { update: { x: { value: 0 }, y: { value: 0 }, width: { value: 100 }, height: { value: 50 }, fill: { value: 'red' } } } }],
} as unknown as VgSpec

describe('bindSceneSignals on a scene without the evaluation handles (C524)', () => {
  const live = evaluateChart(compileChart(SIGNALS), {})
  const noHandles = JSON.parse(JSON.stringify(live)) as SceneRoot

  it('an evaluated scene has the handles, a JSON copy has none (the premise)', () => {
    expect(live.compiled).toBeDefined()
    expect(live.runtime).toBeDefined()
    expect(live.signalParams).toEqual(expect.objectContaining({ n: 1 }))
    // (JSON keeps what is data: the compiled chart; the runtime's functions are gone, what is left is an object that runs nothing)
    expect(typeof (live.runtime as unknown as { expr: unknown }).expr).toBe('function')
    expect(typeof (noHandles.runtime as unknown as { expr?: unknown } | undefined)?.expr).not.toBe('function')
  })

  it('reports it once through hooks.logger, and the binding is inert but safe to use', () => {
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }
    const onSignal = vi.fn()
    const el = renderSceneToDomElement(noHandles, document)
    const binding = bindSceneSignals(el, noHandles, {}, { logger, onSignal })
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(String(logger.warn.mock.calls[0]![0])).toMatch(/no runtime or compiled chart/)
    expect(() => { binding.setSignal('n', 7); binding.detach(); binding.release() }).not.toThrow()
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(onSignal).not.toHaveBeenCalled()
  })

  it('an evaluated scene is bound and reports nothing', () => {
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }
    const onSignal = vi.fn()
    const el = renderSceneToDomElement(live, document)
    const binding = bindSceneSignals(el, live, {}, { logger, onSignal })
    binding.setSignal('n', 7)
    expect(onSignal).toHaveBeenCalled()
    expect(logger.warn).not.toHaveBeenCalled()
    binding.release()
  })
})

describe('a RowDiff is a pulse (C278)', () => {
  const SPEC: VgSpec = {
    width: 200, height: 60, autosize: 'none',
    data: [{ name: 't', values: [] }],
    scales: [{ name: 'x', type: 'linear', domain: { data: 't', field: 'v' }, range: 'width' }],
    marks: [{ type: 'symbol', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'v' }, y: { value: 30 }, fill: { value: 'teal' } } } }],
  } as unknown as VgSpec
  const rows = (...vs: number[]): Array<{ v: number }> => vs.map((v) => ({ v }))
  const base = rows(1, 2, 3, 4, 5)
  // appended, inserted in the middle, removed from the middle, a mix of both, a shuffle that changes values
  const NEXT: Record<string, Array<{ v: number }>> = {
    append: [...base, ...rows(6, 7)],
    insert: [base[0]!, base[1]!, ...rows(9), ...base.slice(2)],
    delete: [base[0]!, base[1]!, base[4]!],
    mixed: [base[0]!, ...rows(8), base[2]!, base[3]!, ...rows(10, 11)],
    changed: [base[0]!, ...rows(20), ...base.slice(2)],
  }

  it.each(Object.keys(NEXT))('%s: diffRows(prev, next) as dataPulse draws what a fresh evaluation draws', (name) => {
    const next = NEXT[name]!
    const diff = diffRows(base, next)!
    expect(diff).not.toBeNull()
    const session = createChartSession()
    session.evaluate(SPEC, { data: { t: base } })
    const scene = session.evaluate(SPEC, { data: { t: next }, dataPulse: { t: diff } })
    expect(renderSceneToSvg(scene)).toBe(renderSceneToSvg(evaluateChart(compileChart(SPEC), { data: { t: next } })))
  })

  it.each(Object.keys(NEXT))('%s: the stream delivers the pulse the diff names', (name) => {
    const next = NEXT[name]!
    const diff = diffRows(base, next)!
    const stream = createChartStream(SPEC, { initial: { data: { t: base } } })
    stream.flush()
    expect(stream.push({ data: { t: next }, pulse: { t: diff } })).toBe(true)
    const flush = stream.flush()!
    expect(renderSceneToSvg(flush.scene)).toBe(renderSceneToSvg(evaluateChart(compileChart(SPEC), { data: { t: next } })))
    // what the pulse says about the rows is what the diff says, ranges as ranges
    const delivered = flush.pulse.datasets.get('t')
    const want = pulseChangeOf(diff)
    expect(delivered?.addedRanges ?? []).toEqual(want.added ?? [])
    expect(delivered?.removedRanges ?? []).toEqual(want.removed ?? [])
  })

  it('pulseChangeOf reads a RowDiff and leaves the long form alone', () => {
    const diff = diffRows(base, NEXT.mixed!)!
    const long = pulseChangeOf(diff)
    expect(long.added).toEqual(diff.addedRanges)
    expect(long.removed).toEqual(diff.removedRanges)
    expect(long.from).toEqual(diff.from)
    const given = { changed: [1], added: [[0, 1]] as Array<[number, number]> }
    expect(pulseChangeOf(given)).toBe(given)
  })
})
