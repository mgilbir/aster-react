/**
 * @aster-charts/vl — a from-scratch Vega-Lite compiler.
 *
 * `compile(spec)` translates a Vega-Lite spec into a Vega spec, which
 * `@aster-charts/core` then renders. Behaviour is pinned to the vega-lite oracle by
 * rendering-parity tests in the conformance package.
 */
export { compile, compileUnit, VLCompileError } from './compile.js'
export type { VLSpec } from './compile.js'
