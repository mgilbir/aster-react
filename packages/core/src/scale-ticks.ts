/**
 * Choosing ticks for an axis or a legend from a scale: how many (`tickCount`), which values (`tickValues`, `validTicks`),
 * and how to write them (`tickFormat`).
 *
 * What callers observe, and so what is fixed here: a count may be a number, a time interval name (only on time and UTC
 * scales: anything else is an error), or an `{interval, step}` object; a scale with bins takes its ticks from the bins
 * that lie in its range, thinned by halving until they fit the count; a minimum step shrinks the count until the ticks it
 * gives are at least that far apart; a log scale's labels are filtered to the leading digits that fit the room.
 */
import { peek, tickStep } from './arr.js'
import type { Locale } from './locale.js'
import { isLogarithmic, isTemporal, Time, UTC, type Scale } from './scale-registry.js'
import { timeIntervalFor, utcIntervalFor, type TimeInterval } from './time.js'
import { error, isNumber, isObject, isString } from './util.js'

/**
 * The tick count or interval for a scale: `count` as given, raised to the number of bins, lowered so that ticks are at
 * least `minStep` apart, and an interval name or object resolved to a time interval.
 */
export function tickCount(scale: Scale, count: unknown, minStep?: number): unknown {
  let step: unknown
  if (isNumber(count)) {
    let wanted = count as number
    if (scale.bins) wanted = Math.max(wanted, scale.bins.length)
    if (minStep != null) {
      const domain = scale.domain() as number[]
      const lo = Math.min(domain[0]!, peek(domain))
      const hi = Math.max(domain[0]!, peek(domain))
      wanted = Math.min(wanted, Math.floor((hi - lo) / minStep || 1) + 1)
      if (!scale.bins && !isLogarithmic(scale.type) && !isTemporal(scale.type) && lo < hi) {
        // a tick step only grows as the count falls, so stepping down finds the largest count that spaces them enough
        while (wanted > 1 && tickStep(lo, hi, wanted) < minStep) --wanted
      }
    }
    count = wanted
  }
  if (isObject(count)) {
    step = (count as { step?: unknown }).step
    count = (count as { interval?: unknown }).interval
  }
  if (isString(count)) {
    count =
      scale.type === Time
        ? timeIntervalFor(count as string)!
        : scale.type === UTC
          ? utcIntervalFor(count as string)!
          : error('Only time and utc scales accept interval strings.')
    if (step) count = (count as TimeInterval).every!(step as number)
  }
  return count
}

/** The candidate ticks that map inside the scale's range (to whole pixels), in range order, thinned to fit `count`. */
export function validTicks(scale: Scale, candidates: unknown[], count: number): unknown[] {
  const range = scale.range() as number[]
  const reversed = range[0]! > peek(range)
  const lo = Math.floor(reversed ? peek(range) : range[0]!)
  const hi = Math.ceil(reversed ? range[0]! : peek(range))
  const byPosition = reversed ? (a: [unknown, unknown], b: [unknown, unknown]) => (b[1] as number) - (a[1] as number) : (a: [unknown, unknown], b: [unknown, unknown]) => (a[1] as number) - (b[1] as number)
  let ticks = candidates
    .map((v) => [v, scale(v)] as [unknown, unknown])
    .filter((p) => lo <= (p[1] as number) && (p[1] as number) <= hi)
    .sort(byPosition)
    .map((p) => p[0])
  if (count > 0 && ticks.length > 1) {
    const ends = [ticks[0], peek(ticks)]
    while (ticks.length > count && ticks.length >= 3) ticks = ticks.filter((_, i) => !(i % 2))
    if (ticks.length < 3) ticks = ends
  }
  return ticks
}

/** The values to put ticks at: the bins in range, else the scale's own ticks, else (for scales without ticks) its domain. */
export function tickValues(scale: Scale, count?: unknown): unknown[] {
  return scale.bins ? validTicks(scale, scale.bins, count as number) : scale.ticks ? scale.ticks(count) : scale.domain()
}

const stringify = (value: unknown): unknown => (Array.isArray(value) ? value.map((v) => String(v)) : String(value))

/** The ticks of a log scale that carry a label (or the test for one): a leading digit small enough for the room. */
export function logTicks(scale: Scale, count: unknown, valuesOnly: boolean): number[] | ((d: number) => boolean) {
  const ticks = tickValues(scale, count) as number[]
  const base = scale.base()
  const lnBase = Math.log(base)
  const room = Math.max(1, (base * (count as number)) / ticks.length)
  const fits = (d: number): boolean => {
    let lead = d / Math.pow(base, Math.round(Math.log(d) / lnBase))
    if (lead * base < base - 0.5) lead *= base
    return lead <= room
  }
  return valuesOnly ? ticks.filter(fits) : fits
}

/**
 * A formatter for a scale's tick values: a time format on time scales (or when `formatType` says so), a thinning
 * number format on log scales, a span-aware number format on other continuous scales, else plain text.
 */
export function tickFormat(
  locale: Locale,
  scale: Scale,
  count?: unknown,
  specifier?: unknown,
  formatType?: string,
  noSkip?: boolean,
): (v: unknown) => string {
  const type = scale.type
  if (type === Time || formatType === Time) return locale.timeFormat(specifier as string) as unknown as (v: unknown) => string
  if (type === UTC || formatType === UTC) return locale.utcFormat(specifier as string) as unknown as (v: unknown) => string
  if (isLogarithmic(type)) {
    const write = locale.formatFloat(specifier) as unknown as (v: number) => string
    if (noSkip || scale.bins) return write as unknown as (v: unknown) => string
    const labelled = logTicks(scale, count, false) as (d: number) => boolean
    return (v) => (labelled(v as number) ? write(v as number) : '')
  }
  if (scale.tickFormat) {
    const d = scale.domain() as number[]
    return locale.formatSpan(d[0]!, peek(d), count as number, specifier) as unknown as (v: unknown) => string
  }
  if (specifier) return locale.format(specifier) as unknown as (v: unknown) => string
  return stringify as (v: unknown) => string
}
