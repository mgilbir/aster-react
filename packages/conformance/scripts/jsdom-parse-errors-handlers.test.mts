// @vitest-environment jsdom
/**
 * LIVE differential for the handlers of signals (`on`). vega refuses the whole spec when it parses it, whatever is wrong in a handler:
 * its update, the events (a selector string, or streams however nested), the filters of a stream however it is written, a signal
 * or a scale that triggers it. Aster refuses it the same way, when the spec is compiled (`compileChart`, so `renderSpec` and the
 * mount of a `<Chart>`) and with vega's message, exactly -- the expressions are checked by the differential in
 * differential-parse-errors.test.mts at every one of these sites, and here the compile is looked at from the host's side.
 *
 * What is left for the time the handlers are bound is what only a running chart can know: a handler vega accepts binds and
 * reports nothing, and one whose function stopped existing since the spec was compiled is reported to the logger while the other
 * handlers still bind.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { compileChart, evaluateChart, registerExpressionFunction, renderSceneToSvg } from '@aster/core'
import { bindSceneSignals } from '@aster/core/signals'
import { asterOutcome, BAD, BIND_TIME_REPORTS, GOOD, HANDLER_SHAPES, HANDLER_SITES, type Spec, UNBOUND_HANDLER_SITES, vegaOutcome } from './expression-sites.mts'

/** Compile a spec, draw it, bind its handlers: what the engine reports, and the signals the handlers set when `fire` has run. */
function bound(spec: Spec, between: () => void = () => {}, fire: (svg: SVGSVGElement) => void = () => {}): { logs: string[]; store: Record<string, unknown> } {
  const chart = compileChart(structuredClone(spec) as never)
  between()
  const scene = evaluateChart(chart)
  const host = document.createElement('div')
  host.innerHTML = renderSceneToSvg(scene)
  document.body.appendChild(host)
  const svg = host.querySelector('svg') as SVGSVGElement
  const logs: string[] = []
  const store: Record<string, unknown> = {}
  const binding = bindSceneSignals(svg, scene, store, { logger: { error: (...a) => { logs.push(a.map((x) => (x instanceof Error ? x.message : String(x))).join(' ')) }, warn: () => {} } })
  fire(svg)
  binding.detach()
  host.remove()
  return { logs, store }
}

const click = (svg: SVGSVGElement): void => { svg.dispatchEvent(new MouseEvent('click', { bubbles: true })) }

const registered: Array<() => void> = []
afterEach(() => { for (const dispose of registered.splice(0)) dispose() })

describe('a broken handler of a signal refuses the spec at compile time, as vega does (Aster vs real Vega)', { timeout: 120_000 }, () => {
  for (const [site, make] of Object.entries({ ...HANDLER_SITES, ...UNBOUND_HANDLER_SITES })) {
    it(`${site}`, () => {
      for (const e of [...BAD, ...GOOD]) {
        const spec = make(e)
        const want = vegaOutcome(spec)
        if (want === 'ok') {
          // vega accepts: the spec compiles and the handlers bind, reporting nothing -- but what a site is known to report
          // (see BIND_TIME_REPORTS), which is all that is allowed there
          expect(asterOutcome(spec), `${site}: ${JSON.stringify(e)}`).toBe('ok')
          const reports = bound(spec).logs
          const allowed = BIND_TIME_REPORTS[site]
          for (const report of reports) expect(allowed ? allowed.test(report) : false, `${site}: ${JSON.stringify(e)} reported ${report}`).toBe(true)
        } else {
          // vega refuses: so does the compile, with the same message, and a host never gets as far as binding
          expect(() => compileChart(structuredClone(spec) as never), `${site}: ${JSON.stringify(e)}`).toThrow(want)
          expect(asterOutcome(spec), `${site}: ${JSON.stringify(e)}`).toBe(want)
        }
      }
    })
  }

  for (const [shape, spec] of Object.entries(HANDLER_SHAPES)) {
    it(`shape: ${shape}`, () => {
      expect(asterOutcome(spec), shape).toBe(vegaOutcome(spec))
    })
  }

  it('the refusal is a SpecParseError, as the other refusals of vega-parser', () => {
    const syntax = HANDLER_SITES.onUpdate!('1 +')
    expect(() => compileChart(structuredClone(syntax) as never)).toThrow(expect.objectContaining({ name: 'SpecParseError', message: 'Expression parse error: 1 +' }))
    const selector = HANDLER_SITES.onEventSelector!('[mousedown] > mousemove')
    expect(() => compileChart(structuredClone(selector) as never)).toThrow(expect.objectContaining({ name: 'SpecParseError', message: vegaOutcome(selector) }))
    const unknown = HANDLER_SITES.onEventFilter!('foo(1)')
    expect(() => compileChart(structuredClone(unknown) as never)).toThrow(expect.objectContaining({ name: 'SpecParseError', message: 'Unrecognized function: foo' }))
  })
})

describe('what is left for the time the handlers are bound', () => {
  it('handlers vega accepts bind, run, and report nothing', () => {
    const spec: Spec = {
      width: 100, height: 100,
      signals: [
        { name: 'n', value: 0, on: [{ events: 'click', update: 'n + 1' }] },
        { name: 'm', value: 0, on: [{ events: { type: 'click', filter: 'event.type === "click"' }, update: 'abs(-2)' }] },
      ],
    }
    const { logs, store } = bound(spec, undefined, click)
    expect(logs).toEqual([])
    expect(store.n).toBe(1)
    expect(store.m).toBe(2)
  })

  it('a function that stopped existing since the compile is reported, and the other handlers still bind', () => {
    const dispose = registerExpressionFunction('onlyForThisTest', () => 7)
    registered.push(dispose)
    const spec: Spec = {
      width: 100, height: 100,
      signals: [
        { name: 'gone', value: 0, on: [{ events: 'click', update: 'onlyForThisTest()' }] },
        { name: 'good', value: 0, on: [{ events: 'click', update: 'good + 1' }] },
      ],
    }
    // the spec is compiled while the function exists (vega would parse it), and is bound after it has been disposed
    const { logs, store } = bound(spec, dispose, click)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('gone')
    expect(logs[0]).toContain('Unrecognized function: onlyForThisTest')
    expect(store.good).toBe(1)
    expect(store.gone).toBeUndefined()
  })
})
