/**
 * Time units: what a unit string is made of, the names of the fields it makes, the Vega transform that cuts a field to it, and the
 * expression that does the same cut on the fly (for a predicate, which compares a field with a value without a transform).
 */
import { genName, guardedPathRef, replacePathInField } from './names.js'
import { normalizeTimeUnit, type NormalTimeUnit } from './validate.js'

export type { NormalTimeUnit }
export { normalizeTimeUnit }

/** The parts of a date, coarsest first: the order in which a timeunit transform lists the `units` it cuts to. */
export const CALENDAR_PARTS = ['year', 'quarter', 'month', 'week', 'day', 'dayofyear', 'date', 'hours', 'minutes', 'seconds', 'milliseconds'] as const

export type CalendarPart = (typeof CALENDAR_PARTS)[number]

/** The longest name first, so that `dayofyear` is read before `day` and `milliseconds` before `seconds`. */
const LONGEST_FIRST = [...CALENDAR_PARTS].sort((a, b) => b.length - a.length)

/** The parts a unit string is made of (`yearmonthdate` is the year, the month and the date), in calendar order. */
export function getTimeUnitParts(unit: string): CalendarPart[] {
  const named = new Set<CalendarPart>()
  for (let at = 0; at < unit.length; ) {
    const part = LONGEST_FIRST.find((p) => unit.startsWith(p, at))
    if (part === undefined) at++
    else {
      named.add(part)
      at += part.length
    }
  }
  return CALENDAR_PARTS.filter((p) => named.has(p))
}

/** The unit as the names of the fields it makes spell it: `utcyearmonth`, `month_step_2`. */
function spelling(tu: NormalTimeUnit): string {
  const word = (s: string): string => s.replace(/\W/g, '_')
  return (tu.utc ? 'utc' : '') + word(tu.unit) + (tu.step === undefined ? '' : word(`_step_${tu.step}`))
}

/** The field a time unit writes for `field` (`month_date`); a field that is binned to the unit already is its own. */
export function timeUnitFieldName(tu: NormalTimeUnit, field: string): string {
  return tu.binned ? field : genName(spelling(tu), field)
}

/** The Vega transform that cuts `fieldPath` to the unit, writing its start to `as` and its end to `as_end`. */
export function timeUnitTransform(tu: NormalTimeUnit, fieldPath: string, as: string): Record<string, unknown> {
  return {
    field: replacePathInField(fieldPath),
    type: 'timeunit',
    units: getTimeUnitParts(tu.unit),
    ...(tu.utc ? { timezone: 'utc' } : {}),
    ...(tu.step !== undefined ? { step: tu.step } : {}),
    as: [as, `${as}_end`],
  }
}

/**
 * The expression that cuts a field to the unit on the fly: the date made of the parts the unit has, read off the field, and of 2012
 * (a leap year, so that a month and a day always exist), January, the 1st and midnight for the ones it has not. `userPath` is the
 * field as the user wrote it, which may be a nested path.
 */
export function timeUnitFieldExpr(tu: NormalTimeUnit, userPath: string): string {
  const ref = guardedPathRef(userPath)
  const utc = tu.utc ? 'utc' : ''
  const has = new Set(getTimeUnitParts(tu.unit))
  // (a quarter counts from 1 in a date and from 0 as a month, and a weekday from 0 as a day of the month)
  const read = (part: CalendarPart): string => (part === 'quarter' ? `(${utc}quarter(${ref})-1)` : `${utc}${part}(${ref})`)
  const of = (part: CalendarPart): string | undefined => (has.has(part) ? read(part) : undefined)
  const args = [
    of('year') ?? 2012,
    of('month') ?? (has.has('quarter') ? `${read('quarter')}*3` : 0),
    of('date') ?? (has.has('day') ? `${read('day')}+1` : 1),
    of('hours') ?? 0,
    of('minutes') ?? 0,
    of('seconds') ?? 0,
    of('milliseconds') ?? 0,
  ]
  return `${tu.utc ? 'utc' : 'datetime'}(${args.join(', ')})`
}
