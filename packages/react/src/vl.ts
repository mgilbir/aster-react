/**
 * `@aster/react/vl` — opt-in Vega-Lite grammar support.
 *
 * Importing this module (for its side effect) registers the from-scratch
 * Vega-Lite compiler with `<Chart>`, `useChart`, `<ChartStream>` and the worker
 * request handlers. Without it the base `@aster/react` entry stays ~23 kB gzip
 * smaller and Vega-Lite specs fail with an actionable error.
 *
 *   import '@aster/react/vl'
 *   import { Chart } from '@aster/react'
 *
 * Worker hosts must import it in the *worker* entry as well, because the
 * compilation happens there.
 */
import { compile } from '@aster/vl'
import type { VgSpec } from '@aster/core'
import { registerVegaLiteCompiler } from './vl-registry.js'

registerVegaLiteCompiler((spec) => compile(spec as never) as VgSpec)

export { compile }
export { isVegaLiteSpec, normalizeChartSpec } from './spec.js'
