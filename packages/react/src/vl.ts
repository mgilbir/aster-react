/**
 * `@aster-charts/react/vl` — opt-in Vega-Lite grammar support.
 *
 * Importing this module (for its side effect) registers the from-scratch
 * Vega-Lite compiler with `<Chart>`, `useChart`, `<ChartStream>` and the worker
 * request handlers. Without it the base `@aster-charts/react` entry stays about 100 kB gzip
 * smaller (the `Chart + VL` row of the bundle budget, `pnpm --filter @aster-charts/benchmarks run budget`)
 * and Vega-Lite specs fail with an actionable error.
 *
 *   import '@aster-charts/react/vl'
 *   import { Chart } from '@aster-charts/react'
 *
 * Worker hosts must import it in the *worker* entry as well, because the
 * compilation happens there.
 */
import { compile } from '@aster-charts/vl'
import type { VgSpec } from '@aster-charts/core'
import { registerVegaLiteCompiler } from './vl-registry.js'

registerVegaLiteCompiler((spec) => compile(spec as never) as VgSpec)

export { compile }
export { isVegaLiteSpec, normalizeChartSpec } from './spec.js'
