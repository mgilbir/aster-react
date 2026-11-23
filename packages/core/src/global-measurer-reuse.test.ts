// @vitest-environment node
/**
 * The text measurer set for every chart (`setTextMetricsProvider`) changes what a text mark measures, so whatever an earlier evaluation
 * kept (a kept mark, a kept group, a guide, a scene a session hands back) was made under the measurer of then. A change of it is a
 * change of the evaluation's environment like `input.textMetrics`, the locale or the time zone: an evaluation under another measurer
 * makes what a fresh one would, on every path that keeps anything (C217).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { compileChart } from './compiler.js'
import { evaluateChart } from './evaluate.js'
import { createChartSession } from './session.js'
import { installAllParts } from './install-parts.testlib.js'
import { setTextMetricsProvider, type TextMetricsProvider } from './text-metrics.js'
import { renderSceneToSvg } from './render.js'
import type { SceneRoot, VgSpec } from './types.js'

installAllParts()
afterEach(() => setTextMetricsProvider(null))

const narrow: TextMetricsProvider = { measure: (t) => t.length * 2 }
const wide: TextMetricsProvider = { measure: (t) => t.length * 30 }
const LONG = 'a long piece of text that is cut'
const text = { type: 'text', from: { data: 't' }, encode: { update: { x: { value: 0 }, y: { value: 20 }, text: { field: 's' } } } }
const axis = (extra: object) => ({ scale: 'x', orient: 'bottom', ...extra })
const base = { width: 200, height: 100, autosize: 'pad', signals: [{ name: 'o', value: 1 }], data: [{ name: 't', values: [{ s: LONG }] }] }

// where the text sits: top level, inside a group mark, a guide's labels (they are text too), a legend
const SPECS: Record<string, VgSpec> = {
  'top-level text mark': { ...base, marks: [text] } as unknown as VgSpec,
  'text inside a group mark': { ...base, marks: [{ type: 'group', marks: [text] }] } as unknown as VgSpec,
  'axis labels': {
    ...base, data: [{ name: 't', values: [{ s: LONG }] }],
    scales: [{ name: 'x', type: 'point', domain: [LONG, 'another long label text'], range: 'width' }],
    axes: [axis({ labelLimit: 0 })], marks: [],
  } as unknown as VgSpec,
  'legend labels': {
    ...base, scales: [{ name: 'c', type: 'ordinal', domain: [LONG, 'another long label text'], range: ['red', 'blue'] }],
    legends: [{ fill: 'c' }], marks: [],
  } as unknown as VgSpec,
}

// every way a host can ask for the second evaluation: it names nothing it changed (a signal no mark reads), it names an empty set of
// changed datasets, it is a session's second call, it names a dataset that did not change
const PATHS: Record<string, (spec: VgSpec) => { first: SceneRoot; again: () => SceneRoot }> = {
  'evaluateChart, no hints': (spec) => {
    const chart = compileChart(spec)
    return { first: evaluateChart(chart, {}), again: () => evaluateChart(chart, { signals: { o: 2 } }) }
  },
  'evaluateChart + changedDatasets: []': (spec) => {
    const chart = compileChart(spec)
    return { first: evaluateChart(chart, {}), again: () => evaluateChart(chart, { signals: { o: 2 }, changedDatasets: [] }) }
  },
  'session': (spec) => {
    const session = createChartSession()
    return { first: session.evaluate(spec, {}), again: () => session.evaluate(spec, { signals: { o: 2 } }) }
  },
  'session, same signals': (spec) => {
    const session = createChartSession()
    return { first: session.evaluate(spec, {}), again: () => session.evaluate(spec, {}) }
  },
}

const fresh = (spec: VgSpec, signals?: Record<string, unknown>): string => renderSceneToSvg(evaluateChart(compileChart(spec), signals ? { signals } : {}))

describe('a change of the text measurer set for every chart reaches what an evaluation kept (C217)', () => {
  for (const [specName, spec] of Object.entries(SPECS)) {
    for (const [pathName, path] of Object.entries(PATHS)) {
      it(`${specName}, ${pathName}`, () => {
        setTextMetricsProvider(narrow)
        const { first, again } = path(spec)
        const underNarrow = renderSceneToSvg(first)
        setTextMetricsProvider(wide)
        const second = again()
        const signals = pathName.includes('same signals') ? undefined : { o: 2 }
        expect(renderSceneToSvg(second)).toBe(fresh(spec, signals))
        // not vacuous: the two measurers draw these specs differently
        setTextMetricsProvider(narrow)
        expect(fresh(spec, signals === undefined ? undefined : { o: 1 })).toBe(underNarrow)
        setTextMetricsProvider(wide)
        expect(fresh(spec, signals)).not.toBe(underNarrow)
      })
    }
  }

  it('the measurer given with the input still wins, and switching it back reuses the right result', () => {
    const spec = SPECS['text inside a group mark']!
    const chart = compileChart(spec)
    setTextMetricsProvider(narrow)
    const a = evaluateChart(chart, {})
    const b = evaluateChart(chart, { signals: { o: 2 }, textMetrics: wide })
    expect(renderSceneToSvg(b)).toBe(renderSceneToSvg(evaluateChart(compileChart(spec), { signals: { o: 2 }, textMetrics: wide })))
    const c = evaluateChart(chart, { signals: { o: 3 } })
    expect(renderSceneToSvg(c)).toBe(renderSceneToSvg(evaluateChart(compileChart(spec), { signals: { o: 3 } })))
    expect(renderSceneToSvg(a)).not.toBe(renderSceneToSvg(b))
  })
})
