/**
 * A signal's `init` / `update` against real vega. vega-parser reads a truthy one as the TEXT of an expression -- a number, a
 * boolean, an array or an object is written out as its JSON, so `init: 15` is 15 and `init: [1, 2]` is the list -- and ignores a
 * falsy one (`init: 0` is no init, the signal stays at its `value`). (The gallery's `vega/platformer` has `init: 15` beside
 * timer handlers: its player stood at 0 instead of 15.)
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { compileChart, evaluateChart } from '@aster/core'

type Spec = Record<string, unknown>
const VALUES: unknown[] = [15, 0, -3, 2.5, 1e21, true, false, null, '', 'sqrt(16)', '3 + 4', 'width * 2', [1, 2, 3], [], [[1, 2], [3]], { a: 1 }, { a: [1, { b: 2 }] }, 'datum', 'width / 0']

async function vegaSignals(signals: Spec[]): Promise<Record<string, unknown>> {
  const view = new vega.View(vega.parse({ width: 40, height: 30, signals, marks: [] } as never), { renderer: 'none' })
  try {
    await view.runAsync()
    return Object.fromEntries(signals.map((s) => [s.name as string, view.signal(s.name as string)]))
  } finally {
    view.finalize()
  }
}
function asterSignals(signals: Spec[]): Record<string, unknown> {
  const scene = evaluateChart(compileChart({ width: 40, height: 30, signals, marks: [] } as never), {}) as unknown as { signalParams: Record<string, unknown> }
  return Object.fromEntries(signals.map((s) => [s.name as string, scene.signalParams[s.name as string]]))
}
const same = (a: unknown, b: unknown): void => expect(JSON.stringify(b, (_k, v) => (typeof v === 'number' && !Number.isFinite(v) ? String(v) : v === undefined ? '__undefined__' : v))).toBe(JSON.stringify(a, (_k, v) => (typeof v === 'number' && !Number.isFinite(v) ? String(v) : v === undefined ? '__undefined__' : v)))

describe('a signal init / update that is not a string', () => {
  for (const [key, label] of [['init', 'init'], ['update', 'update']] as const) {
    for (const v of VALUES) {
      it(`${label}: ${JSON.stringify(v)}`, async () => {
        // (a value beside it, so that "no expression" is visibly different from an expression)
        const signals = [{ name: 's', value: 'kept', [key]: v }, { name: 't', [key]: v }, { name: 'u', init: v, on: [{ events: { type: 'timer', throttle: 17 }, update: 's' }] }].map((s) => (key === 'update' ? { ...s, ...(('init' in s) ? { init: undefined } : {}) } : s))
        const wanted = await vegaSignals(signals as Spec[])
        // (vega-parser refuses `init` together with `update` on one signal; the cases above never have both)
        same(wanted, asterSignals(signals as Spec[]))
      })
    }
  }
  it('the comparison is not vacuous: init 15 is 15', async () => {
    const signals = [{ name: 'a', init: 15, on: [{ events: { type: 'timer', throttle: 17 }, update: 'a + 1' }] }]
    expect((await vegaSignals(signals))['a']).toBe(15)
    expect(asterSignals(signals)['a']).toBe(15)
  })
})
