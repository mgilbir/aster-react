/**
 * What `limits` cost an interactive chart (docs/LIMITS.md, "What `limits` cost"; audit C277). Without `limits`, a write to a signal
 * only a rule reads keeps the symbol items of a scatter by identity (signal-scoped reuse), so the DOM patcher has nothing to diff; under
 * `limits` an evaluation keeps no result of the one before (a kept result is not counted against the budgets again), so every
 * item is made again. The two are the documented trade-off: the day a kept result is charged its recorded counts, the second half
 * of this test fails and the section of LIMITS.md goes.
 */
import { describe, expect, it } from 'vitest'
import { createChartSession } from './session.js'
import type { RuntimeInput, VgSpec } from './types.js'

const rows = Array.from({ length: 2000 }, (_, i) => ({ x: i % 97, y: (i * 17) % 100 }))
const spec = {
  width: 400, height: 300, signals: [{ name: 'h', value: 0 }], data: [{ name: 't' }],
  scales: [{ name: 'x', type: 'linear', domain: { data: 't', field: 'x' }, range: 'width' }, { name: 'y', type: 'linear', domain: { data: 't', field: 'y' }, range: 'height' }],
  marks: [
    { type: 'symbol', from: { data: 't' }, encode: { update: { x: { scale: 'x', field: 'x' }, y: { scale: 'y', field: 'y' } } } },
    { type: 'rule', encode: { update: { x: { signal: 'h' }, y: { value: 0 }, y2: { signal: 'height' } } } },
  ],
} as unknown as VgSpec

/** How many of the writes of the signal `h` kept the first symbol item the evaluation before made. */
function keptOfWrites(extra: RuntimeInput): number {
  const session = createChartSession()
  const input = (h: number): RuntimeInput => ({ data: { t: rows }, signals: { h }, ...extra })
  const firstSymbol = (scene: ReturnType<typeof session.evaluate>): unknown => (scene.items[0] as { items: unknown[] }).items[0]
  let prev = session.evaluate(spec, input(0))
  let kept = 0
  for (let h = 1; h <= 5; h++) {
    const scene = session.evaluate(spec, input(h))
    if (firstSymbol(scene) === firstSymbol(prev)) kept++
    prev = scene
  }
  return kept
}

describe('what limits cost an interactive chart', () => {
  it('without limits a write to a signal only a rule reads keeps the symbol items by identity', () => {
    expect(keptOfWrites({})).toBe(5)
  })

  it('under limits (here a generous maxTimeMs) the same writes keep none: every item is made again', () => {
    expect(keptOfWrites({ limits: { maxTimeMs: 60_000 } })).toBe(0)
  })
})
