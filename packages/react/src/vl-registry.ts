/**
 * Vega-Lite compiler registry.
 *
 * The from-scratch VL compiler (`@aster/vl`) is ~23 kB gzip. Hosts that only
 * render Vega specs should not pay for it, so `<Chart>` no longer imports it
 * statically: `@aster/react/vl` registers it as a side effect.
 *
 *   import '@aster/react/vl'   // once, before rendering Vega-Lite specs
 *   import { Chart } from '@aster/react'
 *
 * This mirrors the `@aster/core/dom` / `@aster/core/transforms` addon pattern:
 * the base entry stays lean, and the missing addon produces an actionable error
 * instead of silently rendering nothing.
 */
import type { VgSpec } from '@aster/core'

export type VegaLiteCompiler = (spec: VgSpec) => VgSpec

let compiler: VegaLiteCompiler | null = null

/** @internal Register the Vega-Lite compiler (called by `@aster/react/vl`). */
export function registerVegaLiteCompiler(fn: VegaLiteCompiler): void {
  compiler = fn
}

/** True once `@aster/react/vl` has been imported. */
export function hasVegaLiteCompiler(): boolean {
  return compiler != null
}

/** @internal Compile a VL spec with the registered compiler. */
export function compileVegaLite(spec: VgSpec): VgSpec {
  if (!compiler) {
    throw new Error(
      'A Vega-Lite spec was passed but the compiler is not loaded. '
      + 'Add `import \'@aster/react/vl\'` (side-effect import) before rendering Vega-Lite specs, '
      + 'or pass an already-compiled Vega spec. Vega specs need no extra import.',
    )
  }
  return compiler(spec)
}

/** @internal Test seam: restore the "addon not imported" state. */
export function resetVegaLiteCompiler(): void {
  compiler = null
}
