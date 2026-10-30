/**
 * What a legend draws for a scale: the values it labels (`labelValues`), the text of each label (`labelFormat`), and where
 * along a gradient a value sits (`labelFraction`). A legend of discretizing scales labels the classes between break
 * points ("a - b", "< b", ">= a") rather than the points themselves.
 *
 * What callers observe, and so what is fixed here: a symbol legend over a discretizing scale or a binned scale labels each
 * class by its two limits; the first value of a discrete legend is the lower end of the first class and gets no label;
 * a quantile or quantize scale writes all its labels at one precision, taken from the smallest gap between its limits;
 * a threshold scale's gradient is padded by one step on each side.
 */
import { peek } from './arr.js'
import type { Locale } from './locale.js'
import { Log, Quantile, Quantize, Threshold, Time, UTC, type Scale } from './scale-registry.js'
import { logTicks, tickFormat, tickValues } from './scale-ticks.js'

export const SymbolLegend = 'symbol'
export const DiscreteLegend = 'discrete'
export const GradientLegend = 'gradient'

/** The scale member that lists a discretizing scale's limits, by type. */
const LIMITS_OF: Record<string, string> = { [Quantile]: 'quantiles', [Quantize]: 'thresholds', [Threshold]: 'domain' }
/** The scale member whose values set the label precision. */
const PRECISION_FROM: Record<string, string> = { [Quantile]: 'quantiles', [Quantize]: 'domain' }

/** The values a legend labels; `max` is the upper end of the last class of a discretizing scale. */
export type LabelValues = unknown[] & { max?: number }

/** The values a legend labels for a scale: bins, log ticks, a discretizing scale's limits, else its ticks. */
export function labelValues(scale: Scale, count: unknown): LabelValues {
  if (scale.bins) {
    const bins: LabelValues = scale.bins.slice(0, -1)
    bins.max = peek(scale.bins as number[])
    return bins
  }
  if (scale.type === Log) return logTicks(scale, count, true) as LabelValues
  const member = Object.hasOwn(LIMITS_OF, scale.type) ? LIMITS_OF[scale.type]! : undefined
  if (member) {
    const values: LabelValues = [-Infinity, ...(scale as unknown as Record<string, () => unknown[]>)[member]!()]
    values.max = +Infinity
    return values
  }
  return tickValues(scale, count)
}

/** A formatter whose precision is set by the smallest gap between the values a scale cuts at. */
export function thresholdFormat(locale: Locale, scale: Scale, specifier: unknown): (v: unknown) => string {
  const cuts = (scale as unknown as Record<string, () => number[]>)[PRECISION_FROM[scale.type]!]!()
  const n = cuts.length
  let gap = n > 1 ? cuts[1]! - cuts[0]! : cuts[0]!
  for (let i = 1; i < n; ++i) gap = Math.min(gap, cuts[i]! - cuts[i - 1]!)
  // three ticks across the gap, ten times over for resolution
  return locale.formatSpan(0, gap, 3 * 10, specifier) as unknown as (v: unknown) => string
}

/** A legend label function: `(value, index, values) => label`. */
export type LabelFormat = (value: unknown, index: number, values: LabelValues) => string | null

const labelsClasses = (scale: Scale): boolean => Object.hasOwn(LIMITS_OF, scale.type) || !!scale.bins

/** How a legend labels each of its values, by the kind of legend and scale. */
export function labelFormat(
  locale: Locale,
  scale: Scale,
  count: unknown,
  type: string,
  specifier?: unknown,
  formatType?: string,
  noSkip?: boolean,
): LabelFormat {
  const write =
    Object.hasOwn(PRECISION_FROM, scale.type) && formatType !== Time && formatType !== UTC
      ? thresholdFormat(locale, scale, specifier)
      : tickFormat(locale, scale, count, specifier, formatType, noSkip)
  if (type === SymbolLegend && labelsClasses(scale)) {
    const finite = (v: unknown): string | null => (Number.isFinite(v) ? write(v) : null)
    return (value, index, values) => {
      const next = values[index + 1]
      const lo = finite(value)
      const hi = finite(next != null ? next : values.max != null ? values.max : +Infinity)
      return lo && hi ? `${lo} – ${hi}` : hi ? `< ${hi}` : `≥ ${lo}`
    }
  }
  // the first value of a discrete legend is the lower end of the first class: it has no label
  if (type === DiscreteLegend) return (value, index) => (index ? write(value) : null)
  return (value) => write(value)
}

/** Where along the legend a value of a discretizing scale sits, as a fraction. */
export function labelFraction(scale: Scale): (value: unknown) => number {
  const domain = scale.domain() as number[]
  const classes = domain.length - 1
  let lo = +domain[0]!
  let hi = +peek(domain)!
  let span = hi - lo
  if (scale.type === Threshold) {
    const pad = classes ? span / classes : 0.1
    lo -= pad
    hi += pad
    span = hi - lo
  }
  return (value) => ((value as number) - lo) / span
}
