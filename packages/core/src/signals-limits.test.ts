// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { compileChart, evaluateChart } from './index.js'
import { renderSceneToDomElement } from './addon-dom.js'
import { bindSceneSignals } from './signals.js'
import type { SpecLimits, VgSpec } from './index.js'

/** A chart whose signal `out` takes `update` on every mousedown (and `sep`, a signal the host may set). */
const chartWith = (update: string): VgSpec => ({
  width: 50, height: 50, autosize: 'none',
  signals: [{ name: 'sep', value: ',' }, { name: 'out', value: null, on: [{ events: 'mousedown', update }] }],
  marks: [{ type: 'rect', encode: { update: { width: { value: 50 }, height: { value: 50 }, fill: { value: 'red' } } } }],
}) as never

afterEach(() => { document.body.innerHTML = '' })

/** Evaluate under `limits`, bind the loop as a host does (nothing passed but the scene), and press the mouse `times`. */
function press(update: string, limits: SpecLimits | undefined, times = 1, before?: (b: ReturnType<typeof bindSceneSignals>) => void) {
  const scene = evaluateChart(compileChart(chartWith(update)), limits ? { limits } : {})
  const el = renderSceneToDomElement(scene, document)
  document.body.appendChild(el)
  const values: unknown[] = []
  const errors: string[] = []
  const logger = { error: (...a: unknown[]) => { errors.push(String(a[0])) }, warn: () => {}, info: () => {}, debug: () => {}, level() { return this } } as never
  const binding = bindSceneSignals(el, scene, {}, { onSignal: (n, v) => { if (n === 'out') values.push(v) }, logger })
  before?.(binding)
  const started = performance.now()
  for (let i = 0; i < times; i++) el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 10, clientY: 10 }))
  const ms = performance.now() - started
  binding.detach()
  return { values, errors, ms }
}

describe('the event loop runs under the limits the scene was evaluated with', () => {
  it('the regex screen: a backtracking pattern in a handler is refused, not run', () => {
    // unscreened, this pattern on these 26 characters blocks for seconds; screened it is refused before it runs
    const r = press("test('(a+)+$', 'aaaaaaaaaaaaaaaaaaaaaaaaa!')", {})
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0]).toMatch(/regexSafety: a repeated group/)
    expect(r.values).toEqual([])
    expect(r.ms).toBeLessThan(1000)
  })

  it('without limits nothing changes: the handler runs (vega parity)', () => {
    const r = press("test('(a+)+$', 'aaaa!')", undefined)
    expect(r.errors).toEqual([])
    expect(r.values).toEqual([false])
  })

  it('the budgets: generated rows in a handler are metered', () => {
    const update = 'length(sequence(0, 1000))'
    expect(press(update, undefined).values).toEqual([1000])
    expect(press(update, { maxGeneratedRows: 5000 }).values).toEqual([1000])
    const r = press(update, { maxGeneratedRows: 10 })
    expect(r.values).toEqual([])
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0]).toMatch(/limit exceeded: maxGeneratedRows/)
  })

  it("limits.regex 'refuse': a RegExp a host sets as a signal value is refused where a handler would run it", () => {
    const update = "length(split('a,b,c', sep))"
    expect(press(update, { regex: 'refuse' }).values).toEqual([3])
    const r = press(update, { regex: 'refuse' }, 1, (b) => b.setSignal('sep', /,/))
    expect(r.values).toEqual([])
    expect(r.errors.some((e) => e.includes("limits.regex: 'refuse'"))).toBe(true)
    // without the option, the same RegExp splits
    expect(press(update, {}, 1, (b) => b.setSignal('sep', /,/)).values).toEqual([3])
  })

  it('a violation is logged once, ends only its delivery, and the next one runs', () => {
    let n = 0
    const scene = evaluateChart(compileChart({
      ...chartWith('0'),
      signals: [{ name: 'k', value: 0, on: [{ events: 'mousedown', update: 'k + 1' }] },
        { name: 'out', value: null, on: [{ events: 'mousedown', update: "k % 2 ? length(sequence(0, 1000)) : 'ok'" }] }],
    } as never), { limits: { maxGeneratedRows: 10 } })
    const el = renderSceneToDomElement(scene, document)
    document.body.appendChild(el)
    const errors: string[] = []
    const outs: unknown[] = []
    const logger = { error: (...a: unknown[]) => { errors.push(String(a[0])) }, warn: () => {}, info: () => {}, debug: () => {}, level() { return this } } as never
    const binding = bindSceneSignals(el, scene, {}, { onSignal: (name, v) => { if (name === 'out') outs.push(v); n++ }, logger })
    for (let i = 0; i < 3; i++) el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 10, clientY: 10 }))
    binding.detach()
    // presses 1 and 3 (k odd) violate, press 2 runs
    expect(errors).toHaveLength(2)
    expect(outs).toContain('ok')
    expect(n).toBeGreaterThan(0)
  })

  it('a handler error that is not a limit is still logged as before (the delivery does not throw)', () => {
    const r = press('datum.nothing.here', {})
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0]).not.toMatch(/limit exceeded/)
  })

  it('the clock is per delivery: a press long after the evaluation is not charged for the time in between', async () => {
    const scene = evaluateChart(compileChart(chartWith("'pressed'")), { limits: { maxTimeMs: 50 } })
    const el = renderSceneToDomElement(scene, document)
    document.body.appendChild(el)
    const values: unknown[] = []
    const errors: string[] = []
    const logger = { error: (...a: unknown[]) => { errors.push(String(a[0])) }, warn: () => {}, info: () => {}, debug: () => {}, level() { return this } } as never
    const binding = bindSceneSignals(el, scene, {}, { onSignal: (name, v) => { if (name === 'out') values.push(v) }, logger })
    await new Promise((r) => setTimeout(r, 120))
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 10, clientY: 10 }))
    binding.detach()
    expect(errors).toEqual([])
    expect(values).toEqual(['pressed'])
  })
})
