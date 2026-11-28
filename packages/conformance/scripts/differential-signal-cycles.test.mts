/**
 * LIVE differential for the cycles vega refuses (C145): random views of a few signals (updates, inits, `react: false`, handlers of
 * `{signal}` sources and of expressions over signals, handlers whose update reads signals, handlers of events) and a data set
 * that reads signals and is read by them. vega throws `Cycle detected in dataflow graph.` when it builds the view, depending on
 * the order it ranks its operators in; `compileChart` must refuse exactly those, with that message, and accept the rest.
 */
import { describe, expect, it } from 'vitest'
import { Worker } from 'node:worker_threads'
import { compileChart } from '@aster-charts/core'
import { makeRng } from './differential-gen.mts'

type Spec = Record<string, unknown>
const CYCLE = 'Cycle detected in dataflow graph.'

/** What building a vega View of each spec gives, in a worker killed past `deadline` ms on one spec: `HANG` (vega's rerank loops). */
const HANG = 'hang'
async function vegaVerdicts(specs: Spec[], deadline = 3000): Promise<string[]> {
  const out: string[] = []
  let worker: Worker | null = null
  for (let i = 0; i < specs.length; i++) {
    worker ??= new Worker(new URL('./vega-view-verdict.worker.mjs', import.meta.url))
    const w = worker
    out[i] = await new Promise<string>((resolve) => {
      const timer = setTimeout(() => { void w.terminate(); worker = null; resolve(HANG) }, deadline)
      w.once('message', (m: { verdict: string }) => { clearTimeout(timer); resolve(m.verdict) })
      w.postMessage({ id: i, spec: structuredClone(spec(i)) })
    })
  }
  await worker?.terminate()
  return out
  function spec(i: number): Spec { return specs[i]! }
}
function asterVerdict(spec: Spec): string {
  try {
    compileChart(structuredClone(spec) as never)
    return 'ok'
  } catch (e) {
    return (e as Error).message === CYCLE ? CYCLE : 'other: ' + (e as Error).message
  }
}

function randomView(seed: number): Spec {
  const r = makeRng(seed)
  const n = 2 + r.int(4)
  const names = Array.from({ length: n }, (_, i) => `s${i}`)
  const pick = (): string => names[r.int(n)]!
  const expr = (): string => r.pick([`${pick()} + 1`, `${pick()} * ${pick()}`, '1', `length(data('t')) + ${pick()}`, `${pick()}`])
  const useData = r.int(2) === 0
  const signals = names.map((name) => {
    const s: Record<string, unknown> = { name }
    const kind = r.int(4)
    if (kind === 0) s.update = expr()
    else if (kind === 1) s.init = expr()
    else s.value = 0
    if (r.int(5) === 0) s.react = false
    const handlers: unknown[] = []
    for (let k = r.int(3); k > 0; k--) {
      const events = r.pick<unknown>([{ signal: pick() }, { signal: `${pick()} + 1` }, 'click', [{ signal: pick() }, { signal: pick() }]])
      handlers.push({ events, update: expr() })
    }
    if (handlers.length) s.on = handlers
    if (s.update !== undefined && s.on !== undefined) delete s.on
    return s
  })
  return {
    width: 10, height: 10, signals,
    data: [{ name: 't', values: [{ v: 1 }, { v: 2 }], transform: useData ? [{ type: 'filter', expr: `datum.v < ${pick()}` }] : [] }],
  }
}

describe('cycles are refused exactly where vega refuses them (C145)', () => {
  it('generated views', async () => {
    let cycles = 0
    const specs = Array.from({ length: 800 }, (_, i) => randomView(i + 1))
    const verdicts = await vegaVerdicts(specs)
    specs.forEach((spec, i) => {
      // vega's rerank loops for ever on some cycles (it walks paths, not nodes): a hang is never matched (DECISIONS Q13), the cycle
      // is refused as vega refuses the others
      const want = verdicts[i] === HANG ? CYCLE : verdicts[i]!
      expect(asterVerdict(spec), `${i + 1}: ${JSON.stringify(spec.signals)} ${JSON.stringify(spec.data)}`).toBe(want)
      if (want === CYCLE) cycles++
    })
    // (the generator makes both: views vega refuses for a cycle, and views it builds)
    expect(cycles).toBeGreaterThan(80)
    expect(cycles).toBeLessThan(720)
    expect(verdicts.filter((v) => v === HANG).length).toBeLessThan(40)
  }, 300_000)

  it('the refusal is a SpecParseError carrying vega\'s message', () => {
    let err: unknown
    try { compileChart({ signals: [{ name: 'a', update: 'b + 1' }, { name: 'b', update: 'a + 1' }] } as never) } catch (e) { err = e }
    expect((err as Error).name).toBe('SpecParseError')
    expect((err as Error).message).toBe(CYCLE)
  })
})
