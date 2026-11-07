/**
 * Vega-Lite compiler registry.
 *
 * The from-scratch VL compiler (`@aster-charts/vl`) is about 100 kB gzip
 * (the `Chart + VL` row of the bundle budget). Hosts that only
 * render Vega specs should not pay for it, so `<Chart>` no longer imports it
 * statically: `@aster-charts/react/vl` registers it as a side effect.
 *
 *   import '@aster-charts/react/vl'   // once, before rendering Vega-Lite specs
 *   import { Chart } from '@aster-charts/react'
 *
 * This mirrors the `@aster-charts/core/dom` / `@aster-charts/core/transforms` addon pattern:
 * the base entry stays lean, and the missing addon produces an actionable error
 * instead of silently rendering nothing.
 */
import type { VgSpec } from '@aster-charts/core'

export type VegaLiteCompiler = (spec: VgSpec) => VgSpec

// The registry lives on `globalThis` (under a registered symbol), not in module
// scope: a bundler or package manager can load two copies of this package (one
// imports `@aster-charts/react/vl`, the other renders `<Chart>`), and a module-level
// variable would be invisible across them.
const REGISTRY_KEY = Symbol.for('@aster-charts/react/vega-lite-compiler')
interface Registry { [REGISTRY_KEY]?: VegaLiteCompiler | null }
const registry = globalThis as unknown as Registry

/** @internal Register the Vega-Lite compiler (called by `@aster-charts/react/vl`). */
export function registerVegaLiteCompiler(fn: VegaLiteCompiler): void {
  registry[REGISTRY_KEY] = fn
}

/** True once `@aster-charts/react/vl` has been imported (by any copy of this package). */
export function hasVegaLiteCompiler(): boolean {
  return registry[REGISTRY_KEY] != null
}

/** @internal Compile a VL spec with the registered compiler. */
export function compileVegaLite(spec: VgSpec): VgSpec {
  const compiler = registry[REGISTRY_KEY]
  if (!compiler) {
    throw new Error(
      'A Vega-Lite spec was passed but the compiler is not loaded. '
      + 'Add `import \'@aster-charts/react/vl\'` (side-effect import) before rendering Vega-Lite specs, '
      + 'or pass an already-compiled Vega spec. Vega specs need no extra import.',
    )
  }
  return compiler(spec)
}

/** @internal Test seam: restore the "addon not imported" state. */
export function resetVegaLiteCompiler(): void {
  registry[REGISTRY_KEY] = null
}
