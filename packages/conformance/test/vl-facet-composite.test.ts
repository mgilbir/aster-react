// @vitest-environment node
/**
 * A facet whose spec is a repeat or a concat, against vega-lite 6.4.3: the cell holds the composition, laid out by its own layout, with its
 * scales, and the headers lay out by their bands. The comparison is the composite-mark matrix's (vl-composite-compare.ts).
 */
import { describe, it } from 'vitest'
import { compare } from './vl-composite-compare.js'
import { GROUPS } from './vl-facet-composite-cases.js'

for (const [title, list] of GROUPS) {
  describe(title, () => {
    for (const [name, spec] of list) it(name, () => compare(spec), 30_000)
  })
}
