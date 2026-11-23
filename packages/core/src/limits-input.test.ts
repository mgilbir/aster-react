// @vitest-environment node
/** Limits read as given: a budget that is no number is a host error (C233), and maxStringLength covers every drawn string (C704). */
import { describe, expect, it } from 'vitest'
import { createChartSession } from './session.js'
import { compileChart } from './compiler.js'
import { evaluateChart } from './evaluate.js'
import { checkSceneLimits, checkSpecLimits, createLimitClock, validateLimits, type SpecLimits } from './limits.js'
import { renderSpec } from './index.js'
import type { VgSpec } from './types.js'

describe('limits are validated where a scope opens (C233)', () => {
  const KEYS = ['maxRows', 'maxMarks', 'maxStringLength', 'maxItems', 'maxPathLength', 'maxSvgLength', 'maxDepth', 'maxGeneratedRows', 'maxGeneratedBytes', 'maxTimeMs']
  const spec = { width: 10, height: 10, data: [{ name: 't', values: [{ a: 1 }] }] } as unknown as VgSpec
  const entries: Array<[string, (l: SpecLimits) => unknown]> = [
    ['renderSpec', (l) => renderSpec(spec, { limits: l })],
    ['session', (l) => createChartSession().evaluate(spec, { limits: l })],
    ['evaluateChart', (l) => evaluateChart(compileChart(spec), { limits: l })],
    ['checkSpecLimits', (l) => checkSpecLimits(spec as never, l)],
    ['checkSceneLimits', (l) => checkSceneLimits({ items: [] }, l)],
    ['createLimitClock', (l) => createLimitClock(l)],
  ]
  it('a budget that is not a number >= 0, or a key that is no limit, is a TypeError at every entry', () => {
    for (const key of KEYS) {
      for (const bad of [NaN, -1, '5', null, true, {}]) {
        for (const [entry, run] of entries) expect(() => run({ [key]: bad } as never), `${entry} ${key}=${String(bad)}`).toThrow(TypeError)
      }
      for (const good of [0, 1, 12.5, Infinity]) expect(() => validateLimits({ [key]: good } as never), `${key}=${good}`).not.toThrow()
    }
    for (const [entry, run] of entries) expect(() => run({ maxrows: 5 } as never), entry).toThrow(/maxrows is not a limit/)
    expect(() => validateLimits({ regex: 'off' } as never)).toThrow(TypeError)
  })
})

describe('maxStringLength covers every string an item draws (C704)', () => {
  const big = "pad('', 5000, 'x')"
  for (const channel of ['href', 'description', 'fill', 'cursor', 'font', 'text']) {
    it(`a ${channel} built by an expression`, () => {
      const spec = { width: 10, height: 10, marks: [{ type: 'text', encode: { update: { [channel]: { signal: big } } } }] } as unknown as VgSpec
      expect(() => renderSpec(spec, { limits: { maxStringLength: 1000 } })).toThrow(/maxStringLength 5000 > 1000/)
      expect(() => renderSpec(spec, { limits: { maxStringLength: 10_000 } })).not.toThrow()
    })
  }
})
