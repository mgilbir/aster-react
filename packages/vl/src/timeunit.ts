/**
 * Time-unit helpers: part decomposition, generated names, the expression that
 * recomputes a time unit on the fly (used by predicates), and the units list
 * Vega's timeunit transform consumes. Ported from vega-lite 6.4.3 timeunit.ts.
 */
import { genName } from './names.js'
import { normalizeTimeUnit, type NormalTimeUnit } from './validate.js'
import { datumPathRef } from './names.js'

export type { NormalTimeUnit }
export { normalizeTimeUnit }

/** vega-lite TIMEUNIT_PARTS order. */
export const TIMEUNIT_PARTS = ['year', 'quarter', 'month', 'week', 'day', 'dayofyear', 'date', 'hours', 'minutes', 'seconds', 'milliseconds'] as const

/** True when the (non-utc) unit string contains the single unit `part`. */
export function containsTimeUnit(full: string, part: string): boolean {
  const index = full.indexOf(part)
  if (index < 0) return false
  // exclude milliseconds
  if (index > 0 && part === 'seconds' && full.charAt(index - 1) === 'i') return false
  // exclude dayofyear
  if (full.length > index + 3 && part === 'day' && full.charAt(index + 3) === 'o') return false
  // exclude the `year` inside dayofyear
  if (index > 0 && part === 'year' && full.charAt(index - 1) === 'f') return false
  return true
}

/** The primitive units of `unit`, in vega-lite's calendar order. */
export function getTimeUnitParts(unit: string): string[] {
  return TIMEUNIT_PARTS.filter((p) => containsTimeUnit(unit, p))
}

/** `unit` plus `utc` prefix and step: vega-lite's `timeUnitToString`. */
export function timeUnitToString(tu: NormalTimeUnit): string {
  const v = (s: string): string => s.replace(/\W/g, '_')
  return (tu.utc ? 'utc' : '') + v(tu.unit) + (tu.step !== undefined ? v(`_step_${tu.step}`) : '')
}

/** Generated output field name `unit_field` for a time-unit field. */
export function timeUnitFieldName(tu: NormalTimeUnit, field: string): string {
  return genName(timeUnitToString(tu), field)
}

/** The Vega `timeunit` transform for `field` -> [as, as_end]. */
export function timeUnitTransform(tu: NormalTimeUnit, fieldPath: string, as: string): Record<string, unknown> {
  return {
    field: fieldPath,
    type: 'timeunit',
    units: getTimeUnitParts(tu.unit),
    ...(tu.utc ? { timezone: 'utc' } : {}),
    ...(tu.step !== undefined ? { step: tu.step } : {}),
    as: [as, `${as}_end`],
  }
}

/**
 * Expression computing the (start of the) time unit of a field on the fly:
 * `datetime(year, month, date, ...)` with vega-lite's defaults (year 2012).
 * `userPath` is the user's (possibly nested) field path.
 */
export function timeUnitFieldExpr(tu: NormalTimeUnit, userPath: string): string {
  const ref = datumPathRef(userPath)
  const utc = tu.utc ? 'utc' : ''
  const fn = (part: string): string => (part === 'quarter' ? `(${utc}quarter(${ref})-1)` : `${utc}${part}(${ref})`)
  const d: Record<string, string> = {}
  for (const part of TIMEUNIT_PARTS) if (containsTimeUnit(tu.unit, part)) d[part] = fn(part)
  const parts: Array<string | number> = []
  parts.push(d.year ?? 2012)
  if (d.month !== undefined) parts.push(d.month)
  else if (d.quarter !== undefined) parts.push(`${d.quarter}*3`)
  else parts.push(0)
  if (d.date !== undefined) parts.push(d.date)
  else if (d.day !== undefined) parts.push(`${d.day}+1`)
  else parts.push(1)
  for (const p of ['hours', 'minutes', 'seconds', 'milliseconds'] as const) parts.push(d[p] ?? 0)
  return `${tu.utc ? 'utc' : 'datetime'}(${parts.join(', ')})`
}

/** Months/quarters etc. the smallest part drives tickMinStep / offset. */
export function smallestTimeUnitPart(unit: string): string {
  const parts = getTimeUnitParts(unit)
  return parts[parts.length - 1]!
}
