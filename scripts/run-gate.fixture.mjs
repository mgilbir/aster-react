#!/usr/bin/env node
/**
 * A gate that reports what it is told (scripts/run-gate.test.mjs drives `runGate` through it as a real process).
 *
 * FAKE_GATE is JSON: { counters, partial, agree: [case], differ: [case], error: [case], problems: [text], crash: bool,
 * plantDiffers: bool }. With `--plant-difference` and `plantDiffers`, every agreeing case is reported as differing instead.
 */
import { runGate } from './lib/run-gate.mjs'

const fake = JSON.parse(process.env.FAKE_GATE ?? '{}')
await runGate({
  name: fake.name ?? 'fake',
  counters: fake.counters ?? { compared: { floor: 1, what: 'cases' } },
  partial: Boolean(fake.partial),
  reads: [],
  run: async (gate) => {
    for (const c of fake.agree ?? []) {
      if (gate.plant && fake.plantDiffers) gate.differ(c, 'planted')
      else gate.agree(c)
    }
    for (const c of fake.differ ?? []) gate.differ(c, 'differs')
    for (const c of fake.error ?? []) gate.error(c, 'threw')
    for (const p of fake.problems ?? []) gate.problem(p)
    if (fake.crash) throw new Error('the script crashed')
  },
})
