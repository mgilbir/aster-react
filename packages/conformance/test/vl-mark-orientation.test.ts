// @vitest-environment node
/**
 * Marks whose orientation vega-lite settles by itself, compiled and drawn against vega-lite 6.4.3 (marks, axes, scales, legends,
 * signals, expressions and the SVG; see vl-composite-compare.ts): a rule over pre-binned channels, a bar, a tick or an area over two
 * channels that are neither measures, and a line with a second channel (which vega-lite makes a rule).
 */
import { describe, it } from 'vitest'
import { compare } from './vl-composite-compare.js'
import { GROUPS } from './vl-mark-orientation-cases.js'

for (const [title, list] of GROUPS) {
  describe(title, () => {
    for (const [name, spec] of list) it(name, () => compare(spec), 30_000)
  })
}
