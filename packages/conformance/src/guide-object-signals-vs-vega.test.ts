// @vitest-environment node
/**
 * The guide parameters vega reads through `scope.objectProperty` -- an axis's and a legend's `values` and `tickCount`, and
 * `config.legend.layout` -- whose parts may be signals at any depth, and the tick counts vega's `tickCount` takes (a number, an
 * interval name, `{interval, step}`, anything else), against vega (C147, C148, C421).
 *
 * Generated: every scale type an axis or a legend reads (linear, log, time, utc, band, point, ordinal, quantize), each tick count
 * form (as written, as a `{signal}`, with signals inside), with and without explicit `values` (a list holding signals, a signal
 * of a list), on an axis and on a legend; and every setting of the legend layout (`offset`, `anchor`, `margin`, `direction`,
 * `center`, `bounds`, `frame`, per orient) written as a value, as a signal inside the layout, and the whole layout as one signal.
 * A host writing the signals afterwards re-lays the guides out as a fresh evaluation does. Canonical SVG, strict.
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { compileChart, evaluateChart, renderSceneToSvg, renderSpec } from '@aster-charts/core'
import { canonicalizeSvg, diffCanonical } from './normalize.js'

type Obj = Record<string, unknown>

async function oracle(spec: Obj, signals: Obj = {}): Promise<string> {
  const view = new vega.View(vega.parse(structuredClone(spec) as never), { renderer: 'none', logLevel: vega.None })
  try {
    for (const [k, v] of Object.entries(signals)) view.signal(k, v)
    await view.runAsync()
    return await view.toSVG()
  } finally {
    view.finalize()
  }
}
const diff = (theirs: string, ours: string): string[] => diffCanonical(canonicalizeSvg(theirs), canonicalizeSvg(ours))

const T0 = Date.UTC(1970, 0, 1)
const T1 = Date.UTC(1971, 1, 5)
const SCALES: Record<string, Obj> = {
  linear: { type: 'linear', domain: [0, 100] },
  log: { type: 'log', domain: [1, 10000] },
  time: { type: 'time', domain: [T0, T1] },
  utc: { type: 'utc', domain: [T0, T1] },
  band: { type: 'band', domain: ['a', 'b', 'c', 'd'] },
  point: { type: 'point', domain: ['a', 'b', 'c'] },
  quantize: { type: 'quantize', domain: [0, 100] },
}
const SIGNALS = [{ name: 'n', value: 6 }, { name: 'iv', value: 'year' }, { name: 'v40', value: 40 }, { name: 'tz', value: 'month' }]

/** Tick counts as vega's tickCount reads them, and as signals: written whole, or with signals inside. */
const COUNTS: unknown[] = [
  undefined, 3, 0, -2, true, false, null, '5', 'year', 'YEAR', 'month', 'hour', 'hours', 'bogus', { interval: 'month' }, { interval: 'month', step: 3 },
  { interval: 'month', step: 0 }, { interval: 'bogus' }, { interval: 'month', step: { signal: 'n' } }, { interval: { signal: 'iv' } },
  { interval: { signal: 'tz' }, step: { signal: 'n' } }, { signal: 'n' }, { signal: "{interval: 'month', step: 3}" }, { signal: 'iv' }, { step: 2 },
]
/** Explicit values: a list, a list holding signals, a signal of a list. */
function valuesFor(scale: string): unknown[] {
  if (scale === 'band' || scale === 'point') return [undefined, ['a', 'c'], [{ signal: "'b'" }, 'c'], { signal: "['a', 'd']" }]
  if (scale === 'time' || scale === 'utc') return [undefined, [{ signal: 'datetime(1970, 6, 1)' }, Date.UTC(1970, 9, 1)], { signal: '[datetime(1970, 3, 1)]' }]
  if (scale === 'log') return [undefined, [10, { signal: '1000' }]]
  return [undefined, [{ signal: 'v40' }, 80], [20, 50], { signal: '[10, v40]' }]
}

function axisSpec(scale: string, tickCount: unknown, values: unknown): Obj {
  return {
    width: 200, height: 100, signals: SIGNALS,
    scales: [{ name: 's', ...SCALES[scale], range: scale === 'quantize' ? [0, 50, 100] : 'width' }],
    axes: [{ scale: 's', orient: 'bottom', ...(tickCount === undefined ? {} : { tickCount }), ...(values === undefined ? {} : { values }) }],
  }
}
function legendSpec(scale: string, tickCount: unknown, values: unknown): Obj {
  const range = scale === 'band' || scale === 'point' ? ['red', 'green', 'blue', 'black'] : scale === 'quantize' ? ['red', 'green', 'blue'] : ['white', 'black']
  const type = scale === 'band' || scale === 'point' ? 'ordinal' : scale
  return {
    width: 100, height: 100, signals: SIGNALS,
    scales: [{ name: 'c', ...SCALES[scale], type, range }],
    legends: [{ fill: 'c', ...(tickCount === undefined ? {} : { tickCount }), ...(values === undefined ? {} : { values }) }],
  }
}

describe('axis and legend values and tick counts, signals inside them included, as vega reads them', () => {
  for (const kind of ['axis', 'legend'] as const) {
    for (const scale of Object.keys(SCALES)) {
      it(`${kind} over a ${scale} scale`, { timeout: 60_000 }, async () => {
        const bad: string[] = []
        let n = 0
        for (const tickCount of COUNTS) {
          for (const values of valuesFor(scale)) {
            const spec = kind === 'axis' ? axisSpec(scale, tickCount, values) : legendSpec(scale, tickCount, values)
            let want: string
            try { want = await oracle(spec) } catch { continue }
            n++
            let got: string
            try { got = renderSpec(structuredClone(spec) as never) } catch (e) { bad.push(`${JSON.stringify({ tickCount, values })}: aster threw ${(e as Error).message}`); continue }
            const d = diff(want, got)
            if (d.length) bad.push(`${JSON.stringify({ tickCount, values })}: ${d.slice(0, 3).join(' | ')}`)
          }
        }
        expect(bad, `${bad.length} of ${n} differ:\n${bad.slice(0, 8).join('\n')}`).toEqual([])
        expect(n).toBeGreaterThan(COUNTS.length)
      })
    }
  }

  it('a signal inside values or a tick count, written by the host, re-lays the guide out as a fresh evaluation does', async () => {
    for (const [kind, spec] of [
      ['axis values', axisSpec('linear', undefined, [{ signal: 'v40' }, 80])],
      ['axis tickCount step', axisSpec('utc', { interval: 'month', step: { signal: 'n' } }, undefined)],
      ['legend tickCount step', legendSpec('utc', { interval: 'month', step: { signal: 'n' } }, undefined)],
      ['axis tickCount interval', axisSpec('time', { interval: { signal: 'iv' } }, undefined)],
    ] as Array<[string, Obj]>) {
      const chart = compileChart(structuredClone(spec) as never)
      for (const signals of [{}, { n: 2, v40: 10 }, { n: 4, iv: 'month', v40: 95 }, {}]) {
        const ours = renderSceneToSvg(evaluateChart(chart, { signals }))
        expect(diff(await oracle(spec, signals), ours), `${kind} ${JSON.stringify(signals)}`).toEqual([])
      }
    }
  })
})

describe('config.legend.layout, signals inside it included, as vega reads it', () => {
  const legends = (orients: string[]): Obj[] => orients.map((orient, i) => ({ fill: 'c', orient, title: `L${i}`, ...(i % 2 ? { direction: 'horizontal' } : {}) }))
  const spec = (layout: unknown, orients: string[]): Obj => ({
    width: 120, height: 80, signals: [{ name: 'off', value: 40 }, { name: 'anc', value: 'end' }, { name: 'mar', value: 3 }, { name: 'dir', value: 'vertical' }, { name: 'fr', value: 'bounds' }],
    scales: [{ name: 'c', type: 'ordinal', domain: ['x', 'y'], range: ['red', 'blue'] }, { name: 'x', type: 'linear', domain: [0, 10], range: 'width' }],
    axes: [{ scale: 'x', orient: 'bottom' }],
    legends: legends(orients),
    config: { legend: { layout } },
  })
  const SETTINGS: Record<string, unknown[]> = {
    offset: [25, { signal: 'off' }, { signal: 'off / 2' }],
    anchor: ['middle', { signal: 'anc' }, { signal: "'middle'" }],
    margin: [12, { signal: 'mar' }],
    direction: ['vertical', { signal: 'dir' }, { signal: "'horizontal'" }],
    center: [true, { signal: 'true' }, { column: { signal: 'true' } }],
    bounds: ['full', { signal: "'full'" }],
    frame: ['bounds', { signal: 'fr' }],
  }
  const ORIENT_SETS = [['right', 'right'], ['left'], ['top', 'top'], ['bottom'], ['top-left', 'bottom-right']]
  it('every setting as a value, as a signal inside the layout, and under an orient of its own', { timeout: 120_000 }, async () => {
    const bad: string[] = []
    let n = 0
    for (const orients of ORIENT_SETS) {
      for (const [key, forms] of Object.entries(SETTINGS)) {
        for (const form of forms) {
          for (const layout of [{ [key]: form }, { [orients[0]!]: { [key]: form } }, { [orients[0]!]: { [key]: form }, [key]: forms[0] }]) {
            const s = spec(layout, orients)
            let want: string
            try { want = await oracle(s) } catch { continue }
            n++
            const d = diff(want, renderSpec(structuredClone(s) as never))
            if (d.length) bad.push(`${JSON.stringify({ orients, layout })}: ${d.slice(0, 3).join(' | ')}`)
          }
        }
      }
    }
    expect(bad, `${bad.length} of ${n} differ:\n${bad.slice(0, 8).join('\n')}`).toEqual([])
    expect(n).toBeGreaterThan(200)
  })

  it('the whole layout as one signal, and a host writing the signals it reads', { timeout: 60_000 }, async () => {
    for (const layout of [{ signal: "{offset: off, anchor: anc}" }, { offset: { signal: 'off' }, right: { anchor: { signal: 'anc' }, margin: { signal: 'mar' } } }]) {
      const s = spec(layout, ['right', 'right'])
      const chart = compileChart(structuredClone(s) as never)
      for (const signals of [{}, { off: 5, anc: 'middle', mar: 20 }, { off: 60 }, {}]) {
        expect(diff(await oracle(s, signals), renderSceneToSvg(evaluateChart(chart, { signals }))), `${JSON.stringify(layout)} ${JSON.stringify(signals)}`).toEqual([])
      }
    }
  })
})

describe('what vega reads of a guide, and what it never reads (C553)', () => {
  const base = (extra: Obj, legend = false): Obj => ({
    width: 100, height: 60,
    scales: [{ name: 'y', type: 'linear', domain: [0, 100], range: 'height' }, { name: 'c', type: 'ordinal', domain: ['x', 'y'], range: ['red', 'blue'] }],
    ...(legend ? { legends: [{ fill: 'c', ...extra }] } : { axes: [{ scale: 'y', orient: 'left', tickCount: 2, ...extra }] }),
  })
  const outcome = (spec: Obj): string => { try { compileChart(structuredClone(spec) as never); return 'ok' } catch (e) { return (e as Error).message } }
  const vegaParse = (spec: Obj): string => { try { vega.parse(structuredClone(spec) as never); return 'ok' } catch (e) { return (e as Error).message } }
  const CASES: Array<[string, Obj]> = [
    ['axis grid as a signal vega never evaluates', base({ grid: { signal: 'nope(1)' } })],
    ['axis grid as a signal that is false', base({ grid: { signal: 'false' } })],
    ['config.axis labelBound as a signal', { ...base({}), config: { axis: { labelBound: { signal: 'nope(1)' } } } }],
    ['config.axis labelOverlap as a signal', { ...base({}), config: { axis: { labelOverlap: { signal: 'nope(1)' } } } }],
    ['config.legend symbolLimit as a signal', { ...base({}, true), config: { legend: { symbolLimit: { signal: 'nope(1)' } } } }],
    ['axis labelBound as a signal', base({ labelBound: { signal: 'nope(1)' } })],
    ['legend orient not one of vega\'s', base({ orient: 'bogus' }, true)],
    ['legend orient empty', base({ orient: '' }, true)],
  ]
  for (const [name, spec] of CASES) {
    it(name, async () => {
      const want = vegaParse(spec)
      expect(outcome(spec)).toBe(want)
      if (want === 'ok') expect(diff(await oracle(spec), renderSpec(structuredClone(spec) as never))).toEqual([])
    })
  }
})

describe('a guide group item\'s clip and blend, its caption\'s title, and lines of text that are null (C533, C422, C423)', () => {
  const S = (extra: Obj): Obj => ({
    width: 80, height: 60,
    scales: [{ name: 'c', type: 'ordinal', domain: ['x', 'y'], range: ['red', 'blue'] }, { name: 'y', type: 'linear', domain: [0, 100], range: 'height' }],
    ...extra,
  })
  const CASES: Array<[string, Obj]> = [
    ['legend clip and blend', S({ legends: [{ fill: 'c', encode: { legend: { update: { clip: { value: true }, blend: { value: 'multiply' } } } } }] })],
    ['legend clip of a sized box', S({ legends: [{ fill: 'c', encode: { legend: { update: { clip: { value: true }, width: { value: 15 }, height: { value: 12 }, fill: { value: '#eee' } } } } }] })],
    ['axis clip and blend', S({ axes: [{ scale: 'y', orient: 'left', encode: { axis: { update: { clip: { value: true }, blend: { value: 'screen' } } } } }] })],
    ['axis clip of a sized box', S({ axes: [{ scale: 'y', orient: 'left', encode: { axis: { update: { clip: { value: true }, x: { value: -12 }, width: { value: 20 }, height: { value: 30 }, fill: { value: '#eee' } } } } }] })],
    ['group mark blend', S({ marks: [{ type: 'group', encode: { update: { width: { value: 20 }, height: { value: 20 }, fill: { value: 'pink' }, blend: { value: 'multiply' } } } }] })],
    ['caption: config.legend.title is no title of the legend', S({ legends: [{ fill: 'c' }], config: { legend: { title: 'cfgtitle' } } })],
    ['caption: a title whose text is null', S({ legends: [{ fill: 'c', title: 'Cat', encode: { title: { update: { text: { value: null } } } } }] })],
    ['axis labels as lines with null and undefined', S({ axes: [{ scale: 'y', orient: 'left', tickCount: 2, encode: { labels: { update: { text: { signal: '[datum.label, null, datum.nope]' } } } } }] })],
    ['a text mark with null lines', S({ marks: [{ type: 'text', encode: { update: { x: { value: 10 }, y: { value: 10 }, text: { value: ['a', null, 'b'] } } } }] })],
    ['a text mark of one null line', S({ marks: [{ type: 'text', encode: { update: { x: { value: 10 }, y: { value: 10 }, text: { value: [null] } } } }] })],
  ]
  for (const [name, spec] of CASES) {
    it(name, async () => {
      expect(diff(await oracle(spec), renderSpec(structuredClone(spec) as never))).toEqual([])
    })
  }
})
