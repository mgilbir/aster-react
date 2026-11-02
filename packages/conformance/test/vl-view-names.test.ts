// @vitest-environment node
/**
 * The `name` of a view, against vega-lite 6.4.3: a view with a name names its scales, signals, datasets and marks after it
 * (`outer_x`, `outer_childWidth`, `outer_concat_0_group`), in every kind of view and with every kind of scale, legend, selection and
 * size that carries the name. The comparison is the composite-mark matrix's (vl-composite-compare.ts).
 */
import { describe, it } from 'vitest'
import { compare } from './vl-composite-compare.js'
import { GROUPS } from './vl-view-names-cases.js'

for (const [title, list] of GROUPS) {
  describe(title, () => {
    for (const [name, spec] of list) it(name, () => compare(spec), 30_000)
  })
}
