/**
 * Vega-Lite predicates (filter transform, condition.test) -> Vega expressions.
 * Ported from vega-lite 6.4.3 predicate.ts / compile/predicate.ts. Selection
 * (`param`) predicates are rejected by validate.ts before they reach here.
 */
import { datumPathRef, VLCompileError } from './names.js'
import { normalizeTimeUnit, timeUnitFieldExpr } from './timeunit.js'

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v)

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const isNumeric = (v: unknown): boolean => (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v)))

function normalizeQuarter(q: number | string): number {
  const n = isNumeric(q) ? Number(q) : NaN
  if (Number.isNaN(n)) throw new VLCompileError(`invalid quarter ${JSON.stringify(q)} in a DateTime`)
  return n - 1
}
function normalizeMonth(m: number | string): number {
  if (isNumeric(m)) return Number(m) - 1
  const lower = String(m).toLowerCase()
  let i = MONTHS.indexOf(lower)
  if (i === -1) i = MONTHS.map((x) => x.slice(0, 3)).indexOf(lower.slice(0, 3))
  if (i === -1) throw new VLCompileError(`invalid month ${JSON.stringify(m)} in a DateTime`)
  return i
}
function normalizeDay(d: number | string): number {
  if (isNumeric(d)) return Number(d) % 7
  const lower = String(d).toLowerCase()
  let i = DAYS.indexOf(lower)
  if (i === -1) i = DAYS.map((x) => x.slice(0, 3)).indexOf(lower.slice(0, 3))
  if (i === -1) throw new VLCompileError(`invalid day ${JSON.stringify(d)} in a DateTime`)
  return i
}

/** vega-lite `isDateTime`: any time-unit part present. */
function isDateTime(o: unknown): o is Obj {
  return isObj(o) && ['year', 'quarter', 'month', 'week', 'day', 'dayofyear', 'date', 'hours', 'minutes', 'seconds', 'milliseconds'].some((k) => k in o)
}

/** vega-lite `dateTimeToExpr` (normalizing). */
function dateTimeToExpr(d0: Obj): string {
  let d = d0
  const parts: Array<string | number> = []
  if (d.day !== undefined && Object.keys(d).length > 1) {
    d = { ...d }
    delete d.day
  }
  parts.push(d.year !== undefined ? (d.year as number) : 2012)
  if (d.month !== undefined) parts.push(normalizeMonth(d.month as number | string))
  else if (d.quarter !== undefined) parts.push(normalizeQuarter(d.quarter as number | string) * 3)
  else parts.push(0)
  if (d.date !== undefined) parts.push(d.date as number)
  else if (d.day !== undefined) parts.push(normalizeDay(d.day as number | string) + 1)
  else parts.push(1)
  for (const k of ['hours', 'minutes', 'seconds', 'milliseconds']) parts.push((d[k] as number | undefined) ?? 0)
  return `${d.utc === true ? 'utc' : 'datetime'}(${parts.join(', ')})`
}

/** vega-lite `valueExpr(v, {timeUnit, wrapTime: true})`. */
function valueExpr(v: unknown, unit: string | undefined): string {
  let isTime = unit !== undefined
  let expr: string | undefined
  if (isObj(v) && typeof v.expr === 'string') expr = v.expr
  else if (isObj(v) && typeof v.signal === 'string') expr = v.signal
  else if (isDateTime(v)) {
    isTime = true
    expr = dateTimeToExpr(v)
  } else if (typeof v === 'string' || typeof v === 'number') {
    if (isTime) {
      expr = `datetime(${JSON.stringify(v)})`
      if (unit !== undefined && /^(year|quarter|month|week|day|dayofyear|date|hours|minutes|seconds|milliseconds)$/.test(unit)) {
        if ((typeof v === 'number' && v < 10000) || (typeof v === 'string' && Number.isNaN(Date.parse(v)))) expr = dateTimeToExpr({ [unit]: v })
      }
    }
  }
  if (expr) return isTime ? `time(${expr})` : expr
  if (isObj(v)) throw new VLCompileError(`unsupported predicate value ${JSON.stringify(v)}`)
  return JSON.stringify(v)
}

function fieldPredicateExpr(p: Obj): string {
  const field = p.field as string
  const tu = p.timeUnit !== undefined ? normalizeTimeUnit(p.timeUnit) : undefined
  const raw = datumPathRef(field)
  const fieldExpr = tu ? `time(${timeUnitFieldExpr(tu, field)})` : raw
  const val = (v: unknown): string => valueExpr(v, tu ? (tu.utc ? 'utc' + tu.unit : tu.unit) : undefined)
  if (p.equal !== undefined) return `${fieldExpr}===${val(p.equal)}`
  if (p.lt !== undefined) return `${fieldExpr}<${val(p.lt)}`
  if (p.gt !== undefined) return `${fieldExpr}>${val(p.gt)}`
  if (p.lte !== undefined) return `${fieldExpr}<=${val(p.lte)}`
  if (p.gte !== undefined) return `${fieldExpr}>=${val(p.gte)}`
  if (p.oneOf !== undefined) return `indexof([${(p.oneOf as unknown[]).map(val).join(',')}], ${fieldExpr}) !== -1`
  if (p.valid !== undefined) {
    return p.valid === true ? `isValid(${fieldExpr}) && isFinite(+${fieldExpr})` : `!isValid(${fieldExpr}) || !isFinite(+${fieldExpr})`
  }
  if (p.range !== undefined) {
    const [lo, hi] = p.range as [unknown, unknown]
    if (lo !== null && hi !== null) return `inrange(${fieldExpr}, [${val(lo)}, ${val(hi)}])`
    const exprs: string[] = []
    if (lo !== null) exprs.push(`${fieldExpr} >= ${val(lo)}`)
    if (hi !== null) exprs.push(`${fieldExpr} <= ${val(hi)}`)
    return exprs.length > 0 ? exprs.join(' && ') : 'true'
  }
  throw new VLCompileError(`invalid field predicate ${JSON.stringify(p)}`)
}

/** vega-lite `logicalExpr`: and/or/not composition with parenthesization. */
export function predicateExpr(p: unknown): string {
  if (typeof p === 'string') return p
  if (!isObj(p)) throw new VLCompileError(`invalid predicate ${JSON.stringify(p)}`)
  if (p.not !== undefined) return `!(${predicateExpr(p.not)})`
  if (p.and !== undefined) return `(${(p.and as unknown[]).map(predicateExpr).join(') && (')})`
  if (p.or !== undefined) return `(${(p.or as unknown[]).map(predicateExpr).join(') || (')})`
  return fieldPredicateExpr(p)
}
