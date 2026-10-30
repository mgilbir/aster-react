/**
 * The shape of the parameters a transform is written with, and the refusals a spec author sees when one is wrong. A
 * transform is checked as written, before its signals are evaluated: that is where a list given as a plain value, a
 * missing required parameter or a force that is not one of the known kinds is refused, in the order the transform
 * lists its parameters.
 *
 * Fixed by the observable behaviour: which parameter is reported first (definition order), the wording of each message,
 * and that a LITERAL scalar for a list parameter is refused while a signal that evaluates to a scalar is not.
 */

type Params = Record<string, unknown>

/** One parameter of a transform definition. */
export interface ParamRule {
  name: string
  required?: boolean
  /** A list: its value must be an array unless it is a signal. */
  list?: boolean
  /** A list of objects, each of which must carry the entries of one of these (the `force` of a force, say). */
  kinds?: ReadonlyArray<Readonly<Record<string, string>>>
}

/** A value as it is quoted in a message: JSON for strings and objects, the bare value otherwise. */
function quoted(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map((e) => (e === null ? 'null' : quoted(e)))}]`
  if ((v !== null && typeof v === 'object') || typeof v === 'string') return JSON.stringify(v).replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029')
  return String(v)
}

const isSignal = (v: unknown): boolean => v !== null && typeof v === 'object' && !!(v as { signal?: unknown }).signal

function checkKinds(list: readonly unknown[], kinds: NonNullable<ParamRule['kinds']>): void {
  for (const item of list) {
    const matches = kinds.some((kind) => Object.keys(kind).every((key) => (item as Params)[key] === kind[key]))
    if (!matches) throw new Error('Unsupported parameter: ' + quoted(item))
  }
}

/**
 * Refuses the first parameter (in definition order) that is missing though required, or that is a list given as
 * something else, or a list member of no known kind. `t` is the transform as written.
 */
export function checkParams(t: Params, rules: readonly ParamRule[]): void {
  for (const rule of rules) {
    const value = t[rule.name]
    if (value === undefined) {
      if (rule.required) throw new Error(`Missing required ${JSON.stringify(t.type)} parameter: ${JSON.stringify(rule.name)}`)
      continue
    }
    if (rule.kinds) {
      if (!Array.isArray(value)) throw new Error('Expected an array of sub-parameters. Instead: ' + quoted(value))
      checkKinds(value, rule.kinds)
    } else if (rule.list && !isSignal(value) && !Array.isArray(value)) {
      throw new TypeError(value === null ? "Cannot read properties of null (reading 'map')" : 'value.map is not a function')
    }
  }
}

const KDE2D_PARAMS: readonly ParamRule[] = [
  { name: 'size', required: true, list: true },
  { name: 'x', required: true },
  { name: 'y', required: true },
  { name: 'weight' },
  { name: 'groupby', list: true },
  { name: 'cellSize' },
  { name: 'bandwidth', list: true },
]
const CONTOUR_PARAMS: readonly ParamRule[] = [
  { name: 'size', required: true, list: true },
  { name: 'values', list: true },
  { name: 'thresholds', list: true },
]
const ISOCONTOUR_PARAMS: readonly ParamRule[] = [{ name: 'thresholds', list: true }, { name: 'translate', list: true }]

/** The rules of the transforms that have them, by transform type. */
export const PARAM_RULES: ReadonlyMap<string, readonly ParamRule[]> = new Map([
  ['kde2d', KDE2D_PARAMS],
  ['contour', CONTOUR_PARAMS],
  ['isocontour', ISOCONTOUR_PARAMS],
])
