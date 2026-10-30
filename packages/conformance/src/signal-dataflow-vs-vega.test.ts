/**
 * Event-driven signal graphs against real vega, on the virtual clock, with identical events.
 *
 * What a signal holds after a timer tick or a click is decided by vega-dataflow's run loop: operators are RANKED (creation order,
 * pushed above their sources when connected to one), a run takes them off a queue in rank order, an operator is evaluated at
 * most once per stamp, a signal set by an event handler is not re-evaluated but pulses its dependents, a handler of a signal
 * stream that has already run in the run misses a later change of its source, `setdata` reaches only the operators ranked after
 * the dataset, and the edits of `modify` are a run of their own. A fixed-point evaluator agrees on a chain and disagrees on a
 * cycle through streams, which is where an animation (a game, a clock) lives.
 *
 * The graphs are generated, from a seeded stream: signals declared in a shuffled order, derived (`update`) signals over an
 * acyclic order, and `on` entries from timers (several delays, so several handlers share one stream and ticks of two streams
 * land together), clicks, a signal, an expression over signals (`a || b`), several signals merged, with and without `force`,
 * reading and writing each other with nothing to stop a cycle through the streams; a dataset written by `setdata` and `modify`
 * and read by derived signals. Each is run in vega and in `<Chart>` (headless Chromium, the gallery page: both on one virtual
 * clock, the clicks dispatched at the same virtual instants) and the picture, which prints every signal, must be equal.
 */
import { describe, expect, it } from 'vitest'
import * as vega from 'vega'
import { runInline, type InlineSpec } from './gallery/react.js'

import { generate, HAND, type Case, type Spec } from './signal-graphs.js'

/** vega parses and runs it without an error (a graph that vega itself rejects, e.g. a derived/handler cycle, is not a case) */
async function vegaAccepts(spec: Spec): Promise<boolean> {
  const errors: unknown[] = []
  const logger = { level: () => logger, error: (...a: unknown[]) => { errors.push(a); return logger }, warn: () => logger, info: () => logger, debug: () => logger }
  try {
    const view = new vega.View(vega.parse(structuredClone(spec) as never), { renderer: 'none', logger: logger as never })
    try { await view.runAsync() } finally { view.finalize() }
    return errors.length === 0
  } catch {
    return false
  }
}

const SEEDS = Number(process.env.SIGNAL_GRAPH_SEEDS ?? 70)

describe('event-driven signal graphs: vega-dataflow\'s run loop', () => {
  it('the hand-written graphs, one for each rule of the run loop, show the same signals as vega', { timeout: 300_000 }, async () => {
    for (const c of HAND) expect(await vegaAccepts(c.spec), `${c.id}: vega runs it`).toBe(true)
    const inputs: InlineSpec[] = HAND.flatMap((c) => c.times.map((t) => ({ id: `${c.id}@${t}`, spec: c.spec, liveMs: t, clicks: c.clicks })))
    const out = await runInline(inputs, () => undefined, 4)
    const bad = out.filter((o) => o.status !== 'pass')
    expect(bad.length, bad.map((o) => `${o.id}: ${o.status} ${o.reason ?? ''} ${o.first ?? ''}`).join('\n')).toBe(0)
  })

  it('the generator is deterministic and covers every kind of entry', () => {
    expect(JSON.stringify(generate(7))).toBe(JSON.stringify(generate(7)))
    const features = { timer: 0, click: 0, signal: 0, expr: 0, merged: 0, force: 0, setdata: 0, modify: 0 }
    for (let s = 1; s <= SEEDS; s++) {
      const text = JSON.stringify(generate(s).spec)
      if (/timer:\d+|"type":"timer"/.test(text)) features.timer++
      if (text.includes('"events":"click"')) features.click++
      if (/"events":\{"signal":"s\d"\}/.test(text)) features.signal++
      if (/"events":\{"signal":"s\d \|\| s\d"\}/.test(text)) features.expr++
      if (/"events":\[\{"signal"/.test(text)) features.merged++
      if (text.includes('"force":true')) features.force++
      if (text.includes('setdata(')) features.setdata++
      if (text.includes('modify(')) features.modify++
    }
    for (const [k, v] of Object.entries(features)) expect(v, `${k} graphs among ${SEEDS}`).toBeGreaterThan(2)
  })

  it(`${SEEDS} generated graphs show the same signals as vega after timer ticks and clicks`, { timeout: 900_000 }, async () => {
    const cases: Case[] = []
    for (let seed = 1; cases.length < SEEDS && seed < SEEDS * 4; seed++) {
      const c = generate(seed)
      if (await vegaAccepts(c.spec)) cases.push(c)
    }
    expect(cases.length).toBe(SEEDS)
    const inputs: InlineSpec[] = cases.flatMap((c) => c.times.map((t) => ({ id: `${c.id}@${t}`, spec: c.spec, liveMs: t, clicks: c.clicks })))
    const out = await runInline(inputs, () => undefined, 4)
    const bad = out.filter((o) => o.status !== 'pass')
    const report = bad.slice(0, 6).map((o) => {
      const c = cases.find((k) => o.id.startsWith(k.id + '@'))!
      return `${o.id}: ${o.status} ${o.reason ?? ''} ${o.first ?? ''}\n${JSON.stringify(c.spec.signals)}\nclicks ${c.clicks}`
    })
    expect(bad.length, `${bad.length} of ${out.length} runs differ from vega:\n${report.join('\n\n')}`).toBe(0)
  })
})
