/**
 * Predicates (a filter transform, a condition's test) as Vega expressions, and the dates they compare with: a DateTime object, or a part
 * of a date that a time unit is compared with. A selection predicate (`param`) is written by the compile context, which knows the
 * selections.
 */
import { flatAccessRef, VLCompileError } from './names.js'
import { CALENDAR_PARTS, normalizeTimeUnit, timeUnitFieldExpr } from './timeunit.js'

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v)

// --- DateTime objects ------------------------------------------------------------------------------------------------------------

const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

const isNumeric = (v: unknown): boolean => (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v)))

/** The 0-based index of a month or a day given as a number or as a name, in full or in its first three letters. */
function nameIndex(value: number | string, names: readonly string[]): number {
  const lower = String(value).toLowerCase()
  const exact = names.indexOf(lower)
  return exact !== -1 ? exact : names.findIndex((n) => n.slice(0, 3) === lower.slice(0, 3))
}

function monthOf(m: number | string): number {
  if (isNumeric(m)) return Number(m) - 1
  const i = nameIndex(m, MONTH_NAMES)
  if (i === -1) throw new VLCompileError(`invalid month ${JSON.stringify(m)} in a DateTime`)
  return i
}

function dayOf(d: number | string): number {
  if (isNumeric(d)) return Number(d) % 7
  const i = nameIndex(d, DAY_NAMES)
  if (i === -1) throw new VLCompileError(`invalid day ${JSON.stringify(d)} in a DateTime`)
  return i
}

function quarterOf(q: number | string): number {
  if (!isNumeric(q)) throw new VLCompileError(`invalid quarter ${JSON.stringify(q)} in a DateTime`)
  return Number(q) - 1
}

/** Whether the object names a part of a date: a DateTime. */
export function isDateTime(o: unknown): o is Obj {
  return isObj(o) && CALENDAR_PARTS.some((part) => part in o)
}

/**
 * The arguments of `datetime(...)` for a DateTime: year, month, date, hours, minutes, seconds, milliseconds. What it does not name is
 * 2012, January, the 1st and midnight; a quarter is the month it starts in and a weekday the date it falls on in the week of January
 * 1st 2012. (A weekday is ignored when the DateTime names anything else, the way the other parts decide the date.)
 */
function dateTimeArguments(dateTime: Obj): Array<number | string> {
  const d = dateTime.day !== undefined && Object.keys(dateTime).length > 1 ? { ...dateTime, day: undefined } : dateTime
  const at = (part: string): number => (d[part] as number | undefined) ?? 0
  return [
    (d.year as number | undefined) ?? 2012,
    d.month !== undefined ? monthOf(d.month as number | string) : d.quarter !== undefined ? quarterOf(d.quarter as number | string) * 3 : 0,
    d.date !== undefined ? (d.date as number) : d.day !== undefined ? dayOf(d.day as number | string) + 1 : 1,
    at('hours'),
    at('minutes'),
    at('seconds'),
    at('milliseconds'),
  ]
}

/** The `datetime(...)` (or `utc(...)`) expression of a DateTime. */
export function dateTimeToExpr(d: Obj): string {
  return `${d.utc === true ? 'utc' : 'datetime'}(${dateTimeArguments(d).join(', ')})`
}

/** The instant a DateTime is. */
export function dateTimeToTimestamp(d: Obj): number {
  const args = dateTimeArguments(d) as [number, number, number, number, number, number, number]
  return d.utc === true ? +new Date(Date.UTC(...args)) : +new Date(...args)
}

// --- the values a predicate compares with -----------------------------------------------------------------------------------------

/** The units that are one part of a date: a bare number or name compared with such a unit is that part of a date. */
const SINGLE_PART = new RegExp(`^(${CALENDAR_PARTS.join('|')})$`)

/**
 * The expression of a value, and whether it is a time. A value is a time when the field is (it has a time unit, or is temporal) or
 * when it is a DateTime. A signal or an expression stands for itself. A bare number or string compared with a time is a date, unless the
 * unit is one part of a date and it cannot be a date: then it is that part (the month 3, the day "Mon").
 */
function operand(v: unknown, unit: string | undefined, temporal: boolean): { expr: string | undefined; time: boolean } {
  const time = unit !== undefined || temporal
  if (isObj(v) && typeof v.expr === 'string') return { expr: v.expr, time }
  if (isObj(v) && typeof v.signal === 'string') return { expr: v.signal, time }
  if (isDateTime(v)) return { expr: dateTimeToExpr(v), time: true }
  if ((typeof v !== 'string' && typeof v !== 'number') || !time) return { expr: undefined, time }
  const partOfDate = unit !== undefined && SINGLE_PART.test(unit) && ((typeof v === 'number' && v < 10000) || (typeof v === 'string' && Number.isNaN(Date.parse(v))))
  return { expr: partOfDate ? dateTimeToExpr({ [unit]: v }) : `datetime(${JSON.stringify(v)})`, time }
}

/** A value of a scale's domain: a time as a `datetime(...)`, a signal or an expression as itself, anything else as JSON. */
export function domainValueExpr(v: unknown, type: string | undefined, unit: string | undefined): string {
  return operand(v, unit, type === 'temporal').expr ?? JSON.stringify(v)
}

// --- field predicates -------------------------------------------------------------------------------------------------------------

/** The comparisons that take one value, in the order they are looked for in a predicate, with the operator they write. */
const COMPARISONS: ReadonlyArray<readonly [key: string, operator: string]> = [['equal', '==='], ['lt', '<'], ['gt', '>'], ['lte', '<='], ['gte', '>=']]

function fieldPredicateExpr(p: Obj): string {
  const field = p.field as string
  const tu = p.timeUnit !== undefined ? normalizeTimeUnit(p.timeUnit) : undefined
  const raw = flatAccessRef(field)
  // (a field that is binned to the unit already holds the start of the unit)
  const subject = tu ? `time(${tu.binned ? raw : timeUnitFieldExpr(tu, field)})` : raw
  const unit = tu ? (tu.utc ? 'utc' + tu.unit : tu.unit) : undefined
  const value = (v: unknown): string => {
    const { expr, time } = operand(v, unit, false)
    if (expr) return time ? `time(${expr})` : expr
    if (isObj(v)) throw new VLCompileError(`unsupported predicate value ${JSON.stringify(v)}`)
    return JSON.stringify(v)
  }

  for (const [key, operator] of COMPARISONS) if (p[key] !== undefined) return `${subject}${operator}${value(p[key])}`
  if (p.oneOf !== undefined) return `indexof([${(p.oneOf as unknown[]).map(value).join(',')}], ${subject}) !== -1`
  if (p.valid !== undefined) {
    return p.valid === true ? `isValid(${subject}) && isFinite(+${subject})` : `!isValid(${subject}) || !isFinite(+${subject})`
  }
  if (p.range !== undefined) {
    const [lo, hi] = p.range as [unknown, unknown]
    if (lo !== null && hi !== null) return `inrange(${subject}, [${value(lo)}, ${value(hi)}])`
    const bounds = [...(lo !== null ? [`${subject} >= ${value(lo)}`] : []), ...(hi !== null ? [`${subject} <= ${value(hi)}`] : [])]
    return bounds.length > 0 ? bounds.join(' && ') : 'true'
  }
  throw new VLCompileError(`invalid field predicate ${JSON.stringify(p)}`)
}

// --- composition ------------------------------------------------------------------------------------------------------------------

/** The `{param}` leaves of a (possibly composed) predicate. */
export function paramLeaves(p: unknown, out: Array<{ param: string; empty?: boolean }> = []): Array<{ param: string; empty?: boolean }> {
  if (!isObj(p)) return out
  if (typeof p.param === 'string') out.push({ param: p.param, ...(p.empty !== undefined ? { empty: p.empty as boolean } : {}) })
  for (const k of ['and', 'or'] as const) if (Array.isArray(p[k])) for (const q of p[k] as unknown[]) paramLeaves(q, out)
  if (p.not !== undefined) paramLeaves(p.not, out)
  return out
}

/** How the predicates of an `and` / `or` are joined (each one in parentheses). */
const CONNECTIVES = [['and', ') && ('], ['or', ') || (']] as const

/**
 * The expression of a predicate: a field predicate, an expression string, a `not` / `and` / `or` of predicates, or a `{param}` leaf,
 * which only `paramTest` (the compile context's) can write.
 */
export function predicateExpr(p: unknown, paramTest?: (pred: { param: string; empty?: boolean }) => string): string {
  const sub = (q: unknown): string => predicateExpr(q, paramTest)
  if (typeof p === 'string') return p
  if (!isObj(p)) throw new VLCompileError(`invalid predicate ${JSON.stringify(p)}`)
  if (p.not !== undefined) return `!(${sub(p.not)})`
  for (const [key, glue] of CONNECTIVES) if (p[key] !== undefined) return `(${(p[key] as unknown[]).map(sub).join(glue)})`
  if (typeof p.param === 'string') {
    if (!paramTest) throw new VLCompileError(`a {"param": ${JSON.stringify(p.param)}} predicate needs the compile context`)
    return paramTest({ param: p.param, ...(p.empty !== undefined ? { empty: p.empty as boolean } : {}) })
  }
  return fieldPredicateExpr(p)
}
