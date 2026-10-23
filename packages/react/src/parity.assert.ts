/**
 * Compile-time parity between `<Chart>` and `<SvgChart>`. A TYPE-ONLY module: it is checked by
 * `pnpm typecheck` (and by `Chart.types.test.ts`, which proves it fails when it should) and emits nothing.
 *
 *  - every key of ChartProps / ChartHandle is shared, interaction-only or excluded WITH A REASON
 *    (a new prop on `<Chart>` that nobody decided about breaks the build here);
 *  - every shared key has the SAME type on both components;
 *  - the interaction-only keys are available with `interaction` (same type) and `never` without.
 */
import type { ChartHandle, ChartProps } from './chart-types.js'
import type { InteractionCapability } from './capabilities.js'
import type {
  SVG_CHART_EXCLUDED_HANDLE, SVG_CHART_EXCLUDED_PROPS, SVG_CHART_INTERACTION_PROPS, SVG_CHART_SHARED_HANDLE,
  SVG_CHART_SHARED_PROPS, SvgChartHandle, SvgChartProps,
} from './svg-chart-types.js'

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
type Assert<T extends true> = T
type AllTrue<T extends Record<string, boolean>> = false extends T[keyof T] ? false : true

type Shared = (typeof SVG_CHART_SHARED_PROPS)[number]
type InteractionOnly = (typeof SVG_CHART_INTERACTION_PROPS)[number]
type Excluded = keyof typeof SVG_CHART_EXCLUDED_PROPS
type HandleShared = (typeof SVG_CHART_SHARED_HANDLE)[number]
type HandleExcluded = keyof typeof SVG_CHART_EXCLUDED_HANDLE

type WithInteraction = Extract<SvgChartProps, { interaction: InteractionCapability }>
type WithoutInteraction = Exclude<SvgChartProps, { interaction: InteractionCapability }>

// Exhaustive: no ChartProps key is undecided, and no list names a key ChartProps lacks.
export type PropsDecided = Assert<Equal<keyof ChartProps, Shared | InteractionOnly | Excluded>>
export type HandleDecided = Assert<Equal<keyof ChartHandle, HandleShared | HandleExcluded>>
// A key is in one list only.
export type PropsDisjoint = Assert<Equal<Shared & InteractionOnly, never>>
export type PropsDisjoint2 = Assert<Equal<(Shared | InteractionOnly) & Excluded, never>>
export type HandleDisjoint = Assert<Equal<HandleShared & HandleExcluded, never>>

// Same type, key by key.
export type SharedSameType = Assert<AllTrue<{ [K in Shared]: Equal<SvgChartProps[K], ChartProps[K]> }>>
export type InteractionSameType = Assert<AllTrue<{ [K in InteractionOnly]: Equal<WithInteraction[K], ChartProps[K]> }>>
export type InteractionUnavailable = Assert<AllTrue<{ [K in InteractionOnly]: Equal<WithoutInteraction[K], undefined> }>>
export type HandleSameType = Assert<AllTrue<{ [K in HandleShared]: Equal<SvgChartHandle[K], ChartHandle[K]> }>>
// `<SvgChart>` has exactly these props besides `interaction`.
export type NoExtraProps = Assert<Equal<Exclude<keyof SvgChartProps, 'interaction'>, Shared | InteractionOnly>>
export type NoExtraHandle = Assert<Equal<keyof SvgChartHandle, HandleShared>>
