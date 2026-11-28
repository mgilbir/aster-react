// @vitest-environment node
/**
 * Scales, bins, casts, config and guides against vega-lite 6.4.3 (marks, axes, scales, legends, signals, expressions and the SVG; see
 * vl-composite-compare.ts), over the specs of vl-scales-guides-space.ts: a field binned twice, a binned ordinal on every channel, the
 * scale properties that take an expression and every config.scale key against every encoding that has its own say, polar scales, the ends
 * of a range, order lists, pre-binned positions, the casts of the data, axes and legends, config assembly and the autosize of a composition.
 */
import { describe, it } from 'vitest'
import { compare } from './vl-composite-compare.js'
import { GROUPS } from './vl-scales-guides-space.js'

for (const [title, list] of GROUPS) {
  describe(title, () => {
    for (const [name, spec] of list) it(name, () => compare(spec), 30_000)
  })
}
