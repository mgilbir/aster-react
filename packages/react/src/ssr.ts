/**
 * Server rendering and DOM-patcher hydration.
 *
 * `renderChartToStaticMarkup` is the string half: it accepts either grammar,
 * applies the same limits as the client, and emits the full SVG the server can
 * stream. `hydrateChart` is the client half: it adopts that existing `<svg>`
 * and patches it through `patchSceneDom` instead of creating a second tree, so
 * hydration does not repaint or flash.
 *
 * React apps can also use `renderToString(<Chart …/>)`; `<Chart>` emits the same
 * markup on its first client render. The low-level pair below is for hosts that
 * stream HTML outside React's render tree and want the strict no-replacement
 * guarantee.
 */
import {
  renderSpec,
  type RuntimeInput,
  type SceneRoot,
  type VgSpec,
} from '@aster-charts/core'
import { createChartSession, patchSceneDom, renderSceneToDomElement } from '@aster-charts/core/dom'
import { normalizeChartSpec } from './spec.js'

/**
 * What `hydrateChart` takes: the evaluation's input (`width`, `height`, `data`, `limits`, ...). It binds no tooltip, event
 * loop or hit index (an interactive chart is `<Chart>`), so there is nothing else to switch on (a former `tooltips` option only
 * wrote `data-datum` attributes that nothing read, DECISIONS Q20).
 */
export type HydrateChartOptions = RuntimeInput

/** Render a self-contained SVG string (same engine and budgets as the client). */
export function renderChartToStaticMarkup(spec: VgSpec, input: RuntimeInput = {}): string {
  return renderSpec(normalizeChartSpec(spec), input)
}

/**
 * What `hydrateChart` returns. It is one static patch: the call makes its own session, and the result holds no session, update or
 * dispose, so showing new data is another `hydrateChart` on the same container (it patches the svg it left there).
 */
export interface HydratedChart {
  scene: SceneRoot
  svg: SVGSVGElement
  /** True when an existing server-rendered svg was patched in place. */
  reused: boolean
}

/**
 * Adopt a server-rendered `<svg>` in `container` and patch it to the current
 * scene. When no svg is present (pure client use) one is created.
 */
export function hydrateChart(
  container: Element,
  spec: VgSpec,
  input: HydrateChartOptions = {},
): HydratedChart {
  const session = createChartSession()
  const scene = session.evaluate(normalizeChartSpec(spec), input)
  const existing = container.querySelector('svg')
  if (existing) {
    patchSceneDom(existing, scene)
    return { scene, svg: existing as SVGSVGElement, reused: true }
  }
  const svg = renderSceneToDomElement(scene, container.ownerDocument) as SVGSVGElement
  container.replaceChildren(svg)
  return { scene, svg, reused: false }
}
