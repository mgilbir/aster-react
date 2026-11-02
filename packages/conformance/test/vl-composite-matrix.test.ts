// @vitest-environment node
/**
 * Every composite mark (boxplot, errorbar, errorband) x extent x orientation x input form, against vega-lite 6.4.3.
 *
 * A composite mark normalizes to a layer of simple marks over one aggregate transform. For each case the two compilers' output is compared on
 * what that normalization makes observable: the marks (in layer order, with their names, styles, encodes, tooltips and descriptions), the
 * axes (titles), the scales, the legends, the signals; the expression sets; and the SVG real Vega renders from each. The names of the
 * datasets a mark reads, the datasets a group mark carries, and the order of the keys of an object are what the compilers are free to differ in. A spec vega-lite
 * refuses must be refused here (the message is Aster's own).
 */
import { describe, it } from 'vitest'
import { compare } from './vl-composite-compare.js'
import { GROUPS } from './vl-composite-matrix-cases.js'

for (const [title, cases] of GROUPS) {
  describe(title, () => {
    for (const [name, spec] of cases) it(name, () => compare(spec), 30_000)
  })
}
