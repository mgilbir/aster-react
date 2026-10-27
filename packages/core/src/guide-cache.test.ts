/**
 * What the guides keep between charts must not grow with the specs a page renders. Libraries that freeze what they hold
 * (immer and its kind) hand over a new frozen config for every state: none of it may be kept, keyed or pinned.
 */
import { describe, expect, it } from 'vitest'
import { compileChart } from './compiler.js'
import { evaluateChart } from './runtime.js'
import { sharedMarkCount } from './guide-encode.js'
import v8 from 'node:v8'
import vm from 'node:vm'

v8.setFlagsFromString('--expose-gc')
const collect = vm.runInNewContext('gc') as () => void

const deepFreeze = <T,>(o: T): T => {
  if (o !== null && typeof o === 'object') { Object.freeze(o); for (const k of Object.keys(o)) deepFreeze((o as Record<string, unknown>)[k]) }
  return o
}
const spec = (i: number, config: boolean): Record<string, unknown> => ({
  width: 120, height: 60,
  ...(config ? { config: { style: { 'guide-label': { fontSize: 9 + (i % 5) }, [`s${i}`]: { fill: 'red' } }, axis: { tickColor: `#${(i % 4096).toString(16).padStart(3, '0')}` }, legend: { padding: i % 7 } } } : {}),
  data: [{ name: 't', values: [{ k: 'a', v: i }, { k: 'b', v: 2 }] }],
  scales: [{ name: `x${i}`, type: 'band', domain: { data: 't', field: 'k' }, range: 'width' }, { name: 'c', type: 'ordinal', domain: ['a', 'b'], range: ['red', 'blue'] }],
  axes: [{ orient: 'bottom', scale: `x${i}`, title: `T${i}` }],
  legends: [{ fill: 'c', title: `L${i}` }], marks: [],
})

describe('what the guides share between charts', () => {
  it('does not grow with distinct frozen configs and styles', () => {
    evaluateChart(compileChart(spec(0, false)))
    evaluateChart(compileChart(spec(0, false)))
    const before = sharedMarkCount()
    for (let i = 1; i <= 400; i++) evaluateChart(compileChart(deepFreeze(spec(i, true)) as never))
    expect(sharedMarkCount()).toBe(before)
  })
  it('pins nothing of a chart whose config blocks a library froze', async () => {
    const refs: Array<WeakRef<object>> = []
    const run = (n: number): void => {
      for (let i = 0; i < n; i++) {
        const chart = compileChart(spec(i, true) as never) as unknown as { style?: object; axes: Array<{ cfg?: object }>; legends: Array<{ cfg?: object }> }
        // (what a frozen spec hands the compiler: the config blocks it reads are frozen, whoever copied them)
        deepFreeze(chart.style)
        for (const a of chart.axes) deepFreeze(a.cfg)
        for (const l of chart.legends) deepFreeze(l.cfg)
        evaluateChart(chart as never)
        refs.push(new WeakRef(chart.style ?? chart))
      }
    }
    run(60)
    await new Promise((r) => setTimeout(r, 0))
    collect()
    await new Promise((r) => setTimeout(r, 0))
    collect()
    expect(refs.filter((r) => r.deref() !== undefined).length).toBeLessThan(5)
  })
  it('is bounded for distinct specs of the default config too (titles, scale names)', () => {
    for (let i = 0; i < 1000; i++) evaluateChart(compileChart(spec(i, false) as never))
    expect(sharedMarkCount()).toBeLessThanOrEqual(300)
  })
})
