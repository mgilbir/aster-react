// @vitest-environment node
/**
 * What stacks, and what the stack does to the scale and the marks, against vega-lite 6.4.3: every mark over every pair of position
 * channels in vl-stack-space.ts (marks, axes, scales, legends, signals, expressions and the SVG; see vl-composite-compare.ts). The
 * cases cover the rules that decide whether a stack happens at all (the mark, an aggregate with nothing to split by, a ranged mark,
 * `stack` on a channel that is not the measure) and what follows (the scale's domain, the baseline of a rule, the padding of a bar).
 */
import { describe, it } from 'vitest'
import { compare } from './vl-composite-compare.js'
import { STACK_MARKS, stackCases } from './vl-stack-space.js'

for (const mark of STACK_MARKS) {
  describe(`@aster-charts/vl == vega-lite: stacking on a ${mark}`, () => {
    for (const [name, spec] of stackCases(mark)) it(name, () => compare(spec), 30_000)
  })
}
