// @vitest-environment jsdom
/**
 * LIVE differential for the error a broken `on` handler of a signal gives. vega refuses the whole spec when it parses it. The engine
 * builds a handler when the signals are bound and reports one that cannot be built through the logger, as an error in the log,
 * while the other handlers still bind (the contract of packages/core/src/signals.test.tsx); what it reports is vega's message.
 *
 * Every place a handler holds an expression (the update, the filters of a stream however it is written, a signal that is a source)
 * is given broken and good expressions: where vega refuses, Aster must compile, bind, and log vega's message; where vega accepts,
 * Aster must log nothing.
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { compileChart, evaluateChart, renderSceneToSvg } from '@aster/core'
import { bindSceneSignals } from '@aster/core/signals'

type Spec = Record<string, unknown>

const BAD = ['1 +', 'a b', '(1', 'x..y', ')', '"abc', '1 +* 2', 'a ? b', "datum['a'", '{a: }', 'f(1,)', '1 2', '!', 'a.', '[1,', '#', 'a = 1']
const GOOD = ['1', 'datum.a', 'width', '2 + 2 * 2', "'x'", 'if(true, 1, 2)', 'event.x > 1', '[1, 2]', '{a: 1}', 'datum.a ? 1 : 0']

const base = (o: Spec = {}): Spec => ({ width: 100, height: 100, data: [{ name: 'd', values: [{ a: 1 }] }], signals: [{ name: 's', value: 1 }], marks: [], ...o })
const inGroup = (o: Spec): Spec => base({ marks: [{ type: 'group', ...o }] })

const SITES: Record<string, (e: string) => Spec> = {
  onUpdate: (e) => base({ signals: [{ name: 't', value: 0, on: [{ events: 'mousedown', update: e }] }] }),
  onUpdateExpr: (e) => base({ signals: [{ name: 't', value: 0, on: [{ events: 'mousedown', update: { expr: e } }] }] }),
  onUpdateSignal: (e) => base({ signals: [{ name: 't', value: 0, on: [{ events: 'mousedown', update: { signal: e } }] }] }),
  onEventFilterSelector: (e) => base({ signals: [{ name: 't', value: 0, on: [{ events: `mousedown[${e}]`, update: '1' }] }] }),
  onEventFilter: (e) => base({ signals: [{ name: 't', value: 0, on: [{ events: { type: 'mousedown', filter: e }, update: '1' }] }] }),
  onEventFilterList: (e) => base({ signals: [{ name: 't', value: 0, on: [{ events: { type: 'mousedown', filter: ['event.x > 0', e] }, update: '1' }] }] }),
  onEventMark: (e) => base({ signals: [{ name: 't', value: 0, on: [{ events: { type: 'mousedown', marktype: 'rect', markname: 'm', filter: e }, update: '1' }] }] }),
  onEventMerge: (e) => base({ signals: [{ name: 't', value: 0, on: [{ events: [{ type: 'mouseup' }, { type: 'mousedown', filter: e }], update: '1' }] }] }),
  onEventBetween: (e) => base({ signals: [{ name: 't', value: 0, on: [{ events: { type: 'mousemove', between: [{ type: 'mousedown' }, { type: 'mouseup', filter: e }] }, update: '1' }] }] }),
  onEventNested: (e) => base({ signals: [{ name: 't', value: 0, on: [{ events: { stream: { type: 'mousedown', filter: e } }, update: '1' }] }] }),
  onEventSignal: (e) => base({ signals: [{ name: 't', value: 0, on: [{ events: { signal: e }, update: '1' }] }] }),
  onEventSignals: (e) => base({ signals: [{ name: 's', value: 1 }, { name: 't', value: 0, on: [{ events: [{ signal: 's' }, { signal: e }], update: '1' }] }] }),
  onInGroup: (e) => inGroup({ signals: [{ name: 'g', value: 0, on: [{ events: { type: 'mousedown', filter: e }, update: '1' }] }] }),
  onInGroupSelector: (e) => inGroup({ signals: [{ name: 'g', value: 0, on: [{ events: `mousedown[${e}]`, update: '1' }] }] }),
}

function vegaOutcome(spec: Spec): string {
  try {
    vega.parse(structuredClone(spec) as never)
    return 'ok'
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

/** What the engine reports when the handlers of a spec are bound: nothing thrown, the logged errors. */
function asterLog(spec: Spec): string[] {
  const chart = compileChart(structuredClone(spec) as never)
  const scene = evaluateChart(chart)
  const host = document.createElement('div')
  host.innerHTML = renderSceneToSvg(scene)
  const svg = host.querySelector('svg') as SVGSVGElement
  const logs: string[] = []
  const binding = bindSceneSignals(svg, scene, {}, { logger: { error: (...a) => { logs.push(a.map((x) => (x instanceof Error ? x.message : String(x))).join(' ')) }, warn: () => {} } })
  binding.detach()
  return logs
}

describe('a broken handler of a signal is reported as vega refuses it (Aster vs real Vega)', { timeout: 120_000 }, () => {
  for (const [site, make] of Object.entries(SITES)) {
    it(`${site}`, () => {
      for (const e of [...BAD, ...GOOD]) {
        const spec = make(e)
        const want = vegaOutcome(spec)
        const logs = asterLog(spec)
        if (want === 'ok') expect(logs, `${site}: ${JSON.stringify(e)}`).toEqual([])
        else expect(logs.some((l) => l.includes(want)), `${site}: ${JSON.stringify(e)} wants ${want}, logged ${JSON.stringify(logs)}`).toBe(true)
      }
    })
  }
})
