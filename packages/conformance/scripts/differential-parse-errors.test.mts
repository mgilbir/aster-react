/**
 * LIVE differential for the error a syntax error in an expression gives. vega parses every expression of a spec when it parses
 * the spec, before a view exists, and refuses with `Expression parse error: <the text it parsed>` -- not the parser's own words.
 * The text is what vega built, which is the expression as written in some places and in others a longer one: an encode entry
 * becomes `(signal)`, `_scale("x", (signal))`, a rule's `(test)?value:...`, a stream's filters `(a)&&(event.item&&...)`, a data
 * trigger `if(trigger,modify("name",...),0)`.
 *
 * Every place a spec holds an expression (signals, formula/filter and field expressions of transforms, data triggers, encode
 * entries of marks and guides, and the `{signal: ...}` of any property; the handlers of signals are in
 * differential-parse-errors-handlers.test.mts) is given a series of broken expressions
 * and a series of good ones; Aster must refuse exactly when vega does, with vega's message, and accept what vega accepts.
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { compileChart } from '@aster/core'

type Spec = Record<string, unknown>

const BAD = ['1 +', 'a b', '(1', 'x..y', ')', '"abc', '1 +* 2', 'a ? b', "datum['a'", '{a: }', 'f(1,)', '1 2', '!', 'a.', '[1,', '#', 'a = 1']
const GOOD = ['1', 'datum.a', 'width', '2 + 2 * 2', "'x'", 'if(true, 1, 2)', 'event.x > 1', '[1, 2]', '{a: 1}', 'datum.a ? 1 : 0']

const rect = (update: Spec, extra: Spec = {}): Spec => ({ type: 'rect', from: { data: 'd' }, encode: { update: { x: { value: 1 }, width: { value: 1 }, height: { value: 1 }, ...update } }, ...extra })
const linear = { name: 'x', type: 'linear', domain: [0, 1], range: [0, 1] }
const base = (o: Spec = {}): Spec => ({ width: 100, height: 100, data: [{ name: 'd', values: [{ a: 1 }] }], signals: [{ name: 's', value: 1 }], marks: [], ...o })
const inGroup = (o: Spec): Spec => base({ marks: [{ type: 'group', ...o }] })

const SITES: Record<string, (e: string) => Spec> = {
  signalInit: (e) => base({ signals: [{ name: 't', init: e }] }),
  signalUpdate: (e) => base({ signals: [{ name: 't', update: e }] }),
  formula: (e) => base({ data: [{ name: 'd', values: [{ a: 1 }], transform: [{ type: 'formula', expr: e, as: 'x' }] }] }),
  filter: (e) => base({ data: [{ name: 'd', values: [{ a: 1 }], transform: [{ type: 'filter', expr: e }] }] }),
  crossFilter: (e) => base({ data: [{ name: 'd', values: [{ a: 1 }], transform: [{ type: 'cross', filter: e }] }] }),
  fieldExpr: (e) => base({ data: [{ name: 'd', values: [{ a: 1 }], transform: [{ type: 'aggregate', groupby: [{ expr: e, as: 'g' }] }] }] }),
  projectExpr: (e) => base({ data: [{ name: 'd', values: [{ a: 1 }], transform: [{ type: 'project', fields: [{ expr: e }], as: ['z'] }] }] }),
  sortFieldExpr: (e) => base({ data: [{ name: 'd', values: [{ a: 1 }], transform: [{ type: 'collect', sort: { field: { expr: e } } }] }] }),
  paramSignal: (e) => base({ data: [{ name: 'd', values: [{ a: 1 }], transform: [{ type: 'bin', field: 'a', extent: [0, 1], maxbins: { signal: e } }] }] }),
  paramPointRadius: (e) => base({ data: [{ name: 'd', values: [{ a: 1 }], transform: [{ type: 'geopath', pointRadius: { expr: e } }] }] }),
  groupData: (e) => inGroup({ data: [{ name: 'gd', values: [{ a: 1 }], transform: [{ type: 'filter', expr: e }] }] }),
  triggerInsert: (e) => base({ data: [{ name: 'd', values: [{ a: 1 }], on: [{ trigger: 's', insert: e }] }] }),
  triggerRemove: (e) => base({ data: [{ name: 'd', values: [{ a: 1 }], on: [{ trigger: 's', remove: e }] }] }),
  triggerToggle: (e) => base({ data: [{ name: 'd', values: [{ a: 1 }], on: [{ trigger: 's', toggle: e }] }] }),
  triggerModify: (e) => base({ data: [{ name: 'd', values: [{ a: 1 }], on: [{ trigger: 's', modify: e, values: 'datum' }] }] }),
  triggerValues: (e) => base({ data: [{ name: 'd', values: [{ a: 1 }], on: [{ trigger: 's', insert: 'datum', values: e }] }] }),
  triggerTrigger: (e) => base({ data: [{ name: 'd', values: [{ a: 1 }], on: [{ trigger: e, remove: true }] }] }),
  encSignal: (e) => base({ marks: [rect({ x: { signal: e } })] }),
  encSignalScale: (e) => base({ scales: [linear], marks: [rect({ x: { scale: 'x', signal: e } })] }),
  encSignalOffset: (e) => base({ scales: [linear], marks: [rect({ x: { scale: 'x', field: 'a', offset: { signal: e } } })] }),
  encSignalMult: (e) => base({ scales: [linear], marks: [rect({ x: { field: 'a', mult: { signal: e }, round: true } })] }),
  encSignalExponent: (e) => base({ scales: [linear], marks: [rect({ x: { signal: 's', exponent: { signal: e } } })] }),
  encSignalBand: (e) => base({ scales: [{ name: 'b', type: 'band', domain: ['a'], range: [0, 1] }], marks: [rect({ x: { scale: 'b', field: 'a', band: { signal: e } } })] }),
  encScaleSignal: (e) => base({ scales: [linear], marks: [rect({ x: { scale: { signal: e }, field: 'a' } })] }),
  encFieldSignal: (e) => base({ marks: [rect({ x: { field: { signal: e } } })] }),
  encColor: (e) => base({ marks: [rect({ fill: { color: { r: { signal: e }, g: { value: 1 }, b: { value: 2 } } } })] }),
  encGradient: (e) => base({ scales: [{ name: 'c', type: 'linear', domain: [0, 1], range: ['red', 'blue'] }], marks: [rect({ fill: { gradient: 'c', start: [0, 0], stop: [1, 1], count: { signal: e } } })] }),
  encRule: (e) => base({ marks: [rect({ x: [{ test: e, value: 1 }, { value: 2 }] })] }),
  encRuleSignal: (e) => base({ marks: [rect({ x: [{ test: 'true', signal: e }, { value: 2 }] })] }),
  encEnter: (e) => base({ marks: [{ type: 'rect', encode: { enter: { x: { signal: e } }, hover: { y: { signal: '1' } } } }] }),
  encSecondChannel: (e) => base({ marks: [rect({ y: { signal: '2' }, x: { signal: e } })] }),
  encGroupMark: (e) => inGroup({ marks: [rect({ x: { signal: e } })] }),
  axisEncode: (e) => base({ scales: [linear], axes: [{ scale: 'x', orient: 'bottom', encode: { labels: { update: { text: { signal: e } } } } }] }),
  legendEncode: (e) => base({ scales: [{ name: 'c', type: 'ordinal', domain: [0, 1], range: ['red', 'blue'] }], legends: [{ fill: 'c', encode: { labels: { update: { text: { signal: e } } } } }] }),
  titleEncode: (e) => base({ title: { text: 'x', encode: { title: { update: { fill: { signal: e } } } } } }),
  scaleDomain: (e) => base({ scales: [{ name: 'x', type: 'linear', domain: { signal: e }, range: [0, 1] }] }),
  scaleDomainItem: (e) => base({ scales: [{ name: 'x', type: 'linear', domain: [0, { signal: e }], range: [0, 1] }] }),
  scaleRange: (e) => base({ scales: [{ name: 'x', type: 'linear', domain: [0, 1], range: { signal: e } }] }),
  scaleRound: (e) => base({ scales: [{ name: 'x', type: 'linear', domain: [0, 1], range: [0, 1], round: { signal: e } }] }),
  scaleZero: (e) => base({ scales: [{ name: 'x', type: 'linear', domain: [0, 1], range: [0, 1], zero: { signal: e } }] }),
  scaleSecond: (e) => base({ scales: [{ name: 'x', type: 'linear', domain: [0, 1], range: [0, 1] }, { name: 'y', type: 'linear', domain: { signal: e }, range: [0, 1] }] }),
  axisValues: (e) => base({ scales: [linear], axes: [{ scale: 'x', orient: 'bottom', values: { signal: e } }] }),
  axisTitle: (e) => base({ scales: [linear], axes: [{ scale: 'x', orient: 'bottom', title: { signal: e } }] }),
  axisTickCount: (e) => base({ scales: [linear], axes: [{ scale: 'x', orient: 'bottom', tickCount: { signal: e } }] }),
  legendTitle: (e) => base({ scales: [{ name: 'c', type: 'ordinal', domain: [0, 1], range: ['red', 'blue'] }], legends: [{ fill: 'c', title: { signal: e } }] }),
  title: (e) => base({ title: { text: { signal: e } } }),
  markClip: (e) => base({ marks: [{ type: 'group', clip: { signal: e } }] }),
  markZindex: (e) => base({ marks: [rect({}, { zindex: { signal: e } })] }), // (a z-index is not parsed)
  markInteractive: (e) => base({ marks: [rect({}, { interactive: { signal: e } })] }),
  markSort: (e) => base({ marks: [rect({}, { sort: { field: { signal: e } } })] }),
  markLayout: (e) => base({ marks: [{ type: 'group', layout: { columns: { signal: e } } }] }),
  projection: (e) => base({ projections: [{ name: 'p', type: 'mercator', scale: { signal: e } }] }),
  dataUrl: (e) => base({ data: [{ name: 'd', url: { signal: e } }] }),
  dataValues: (e) => base({ data: [{ name: 'd', values: { signal: e } }] }),
  dataFormat: (e) => base({ data: [{ name: 'd', values: [], format: { type: { signal: e } } }] }),
  viewWidth: (e) => ({ ...base(), width: { signal: e } }),
  viewPadding: (e) => ({ ...base(), padding: { signal: e } }),
  viewAutosize: (e) => ({ ...base(), autosize: { signal: e } }),
  viewBackground: (e) => ({ ...base(), background: { signal: e } }),
  bindProp: (e) => base({ signals: [{ name: 't', value: 0, bind: { input: 'range', min: { signal: e } } }] }),
  inGroupScale: (e) => inGroup({ scales: [{ name: 'gx', type: 'linear', domain: { signal: e }, range: [0, 1] }] }),
  inGroupAxis: (e) => inGroup({ scales: [{ name: 'gx', type: 'linear', domain: [0, 1], range: [0, 1] }], axes: [{ scale: 'gx', orient: 'bottom', values: { signal: e } }] }),
  // the same expression twice, in two places: the first one in vega's order is the one reported
  orderSignalThenMark: (e) => base({ signals: [{ name: 't', update: e }], marks: [rect({ x: { signal: '(' } })] }),
  orderMarkThenLambda: (e) => base({ scales: [{ name: 'x', type: 'linear', domain: { signal: ')' }, range: [0, 1] }], marks: [rect({ x: { signal: e } })] }),
  orderTransformThenSignal: (e) => base({ data: [{ name: 'd', values: [{ a: 1 }], transform: [{ type: 'filter', expr: e }] }], signals: [{ name: 't', update: '(' }] }),
}

function vegaOutcome(spec: Spec): string {
  try {
    vega.parse(structuredClone(spec) as never)
    return 'ok'
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

function asterOutcome(spec: Spec): string {
  try {
    compileChart(structuredClone(spec) as never)
    return 'ok'
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

describe('a syntax error in an expression is refused as vega refuses it (Aster vs real Vega)', { timeout: 120_000 }, () => {
  for (const [site, make] of Object.entries(SITES)) {
    it(`${site}`, () => {
      for (const e of [...BAD, ...GOOD]) {
        const spec = make(e)
        expect(asterOutcome(spec), `${site}: ${JSON.stringify(e)}`).toBe(vegaOutcome(spec))
      }
    })
  }

  it('the sites refuse many things', () => {
    let refused = 0
    for (const make of Object.values(SITES)) for (const e of BAD) if (vegaOutcome(make(e)).startsWith('Expression parse error')) refused++
    expect(refused).toBeGreaterThan(Object.keys(SITES).length * 8)
  })
})
