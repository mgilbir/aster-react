import type { ChartHandle, ChartProps } from './chart-types.js'
import type { InteractionCapability } from './capabilities.js'

/**
 * `<SvgChart>`'s props and handle, derived from `<Chart>`'s by three explicit, exhaustive lists.
 *
 * Every key of `ChartProps` (and of `ChartHandle`) must be in exactly one list; `parity.assert.ts`
 * fails `pnpm typecheck` otherwise. So adding a prop to `<Chart>` forces a decision about
 * `<SvgChart>` in the same change, and a prop that is shared has the SAME type by construction
 * (it is a `Pick`), which the same file re-checks.
 */

/** ChartProps shared with `<SvgChart>`, unchanged. These need neither the canvas nor the interaction capability. */
export const SVG_CHART_SHARED_PROPS = [
  'spec', 'sceneOverride', 'data', 'dataChanges', 'width', 'height', 'ariaLabel', 'incremental', 'denseMarks',
  'className', 'style', 'signals', 'onSelect', 'brush', 'panZoom', 'pan', 'zoom', 'view', 'onViewChange', 'maxZoom',
  'signalListeners', 'onSignal', 'onStreamInput', 'interactive', 'limits', 'urlPolicy', 'random', 'logger', 'textMetrics',
  'a11y', 'onError',
] as const

/**
 * ChartProps that need the `interaction` capability (hit index and/or the signal event loop):
 * a compile-time error on `<SvgChart>` without `interaction`, and reported at runtime for JS callers.
 *   tooltip, renderTooltip      resolve the hovered datum through the hit index
 *   onPointSelect, selection,   a click resolves the mark under the pointer through the hit index
 *   select, onSelectionChange
 *   preventDefault              only affects the `signal.on` event loop
 */
export const SVG_CHART_INTERACTION_PROPS = [
  'tooltip', 'renderTooltip', 'onPointSelect', 'selection', 'select', 'onSelectionChange', 'preventDefault',
] as const

/** ChartProps `<SvgChart>` does not have, each with the reason. */
export const SVG_CHART_EXCLUDED_PROPS = {
  renderer: '`<SvgChart>` is always SVG: the canvas renderer is the code it exists to leave out. Use `<Chart renderer="canvas">`.',
} as const

/** ChartHandle members `<SvgChart>`'s ref has, unchanged (all of them work without `interaction`: `setSignal` applies the value as a signal override when no event loop is bound). */
export const SVG_CHART_SHARED_HANDLE = [
  'getScene', 'getSvg', 'getChartInfo', 'getView', 'setView', 'resetView', 'setSignal', 'getSignals',
] as const

/** ChartHandle members `<SvgChart>`'s ref does not have, each with the reason. */
export const SVG_CHART_EXCLUDED_HANDLE = {} as const

type Shared = (typeof SVG_CHART_SHARED_PROPS)[number]
type InteractionOnly = (typeof SVG_CHART_INTERACTION_PROPS)[number]

/** Props that work with or without `interaction`. */
export type SvgChartBaseProps = Pick<ChartProps, Shared>

/** Props that need `interaction`, as `<Chart>` types them. */
export type SvgChartInteractionProps = Pick<ChartProps, InteractionOnly>

/**
 * `<SvgChart>` props: a discriminated union on `interaction`. Pass it (from `@aster/react/interaction`)
 * and every interaction prop is available; omit it and they are `never`, so using one is a compile error.
 */
export type SvgChartProps = SvgChartBaseProps & (
  | ({ interaction: InteractionCapability } & SvgChartInteractionProps)
  | ({ interaction?: undefined } & { [K in InteractionOnly]?: never })
)

/** Imperative handle of `<SvgChart ref={…}>`: `<Chart>`'s, member for member. */
export type SvgChartHandle = Pick<ChartHandle, (typeof SVG_CHART_SHARED_HANDLE)[number]>
