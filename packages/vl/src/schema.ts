/**
 * The Vega-Lite JSON schema's verdict on a spec, from the table generated out of the pinned schema (schema-table.ts, made by
 * scripts/schema-table.mjs).
 *
 * Every property of a spec has a type in the schema: the kinds of value it takes (a string, a number, an enumerated name, an object
 * of a known shape, an array of a type, an `{"expr"}` reference ...). A value the schema does not allow where it stands is refused
 * here with a VLCompileError naming its path, and so is a property the schema does not have: vega-lite reads such a spec in ways
 * its own schema does not describe, and the chart it would draw is no contract to match (C245). What the schema allows and Aster
 * does not implement is the other list, kept by hand: validate.ts, and the consumption check (consume.ts) for what the compile never
 * reads.
 *
 * The same walk decides where an `{"expr": ...}` object is an expression. vega-lite turns one into a signal only where the schema
 * says ExprRef; anywhere else (a lookup's `default`, an impute `value`, a parameter's `value` - every position the schema types as
 * "any value") the object is a literal, and so is everything inside a value given at such a position. The walk records those
 * values (`isLiteralValue`), and the compile's exit leaves them as they are (C442).
 *
 * The walk does not look into inline data rows (`data.values`, `datasets`): they are data, not spec (InlineDataset).
 */
import { ENUMS, EXPR_REF, INLINE_DATASET, NAMED, ROOT, SCHEMA_VERSION, SHAPES, TYPES } from './schema-table.js'
import { VLCompileError } from './names.js'
import { suggest } from './suggest.js'

/** Kinds mask bits (scripts/schema-table.mjs `K`). */
const STRING = 1
const NUMBER = 2
const INTEGER = 4
const BOOLEAN = 8
const NULL = 16
const ANY = 32
const OBJECT = 64

interface Type {
  readonly mask: number
  readonly enums: ReadonlySet<unknown> | undefined
  readonly shapes: readonly number[]
  readonly arrays: readonly (readonly [number, number, number])[]
  readonly maps: readonly number[]
  readonly nums: readonly (readonly [number | null, number | null, 1?])[]
  readonly strs: readonly (readonly [number | null, number | null])[]
  /** does the type take an `{"expr"}` reference? */
  readonly expr: boolean
}

interface Shape {
  readonly props: ReadonlyMap<string, number>
  readonly required: readonly string[]
  /** -1 no other property, -2 any other property, else the type of every other property */
  readonly additional: number
  readonly minProperties: number
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v)

// The table is decoded an entry at a time, the first time a spec reaches it.
const types: (Type | undefined)[] = []
const shapes: (Shape | undefined)[] = []
const NONE: readonly never[] = []

function typeAt(i: number): Type {
  let t = types[i]
  if (t !== undefined) return t
  const e = TYPES[i]!
  if (typeof e === 'number') t = { mask: e, enums: undefined, shapes: NONE, arrays: NONE, maps: NONE, nums: NONE, strs: NONE, expr: false }
  else {
    const [mask, en, sh, ar, mp, nu, st] = e as [number, number | number[] | undefined, number[] | 0 | undefined, [number, number, number][] | 0 | undefined, number[] | 0 | undefined, [number | null, number | null, 1?][] | 0 | undefined, [number | null, number | null][] | 0 | undefined]
    const enumIds = en === undefined || en === -1 ? [] : Array.isArray(en) ? en : [en]
    const s: readonly number[] = sh || NONE
    t = {
      mask,
      enums: enumIds.length ? new Set(enumIds.flatMap((k) => ENUMS[k]!)) : undefined,
      shapes: s,
      arrays: ar || NONE,
      maps: mp || NONE,
      nums: nu || NONE,
      strs: st || NONE,
      expr: s.includes(EXPR_REF),
    }
  }
  types[i] = t
  return t
}

const words = (s: string | undefined): string[] => (s ? s.split(' ') : [])

function shapeAt(i: number): Shape {
  let s = shapes[i]
  if (s !== undefined) return s
  const e = SHAPES[i]!
  let props: Map<string, number>
  let tail: unknown[]
  if (typeof e[0] === 'number') {
    // (an earlier shape, with some properties removed and some added or retyped)
    const [base, removed, added, addedTypes, ...rest] = e as [number, string, string, number[], ...unknown[]]
    props = new Map(shapeAt(base).props)
    for (const p of words(removed)) props.delete(p)
    words(added).forEach((p, k) => props.set(p, addedTypes[k]!))
    tail = rest
  } else {
    const [names, propTypes, ...rest] = e as [string, number[], ...unknown[]]
    props = new Map(words(names).map((p, k) => [p, propTypes[k]!]))
    tail = rest
  }
  s = { props, required: words(tail[0] as string | undefined), additional: (tail[1] as number | undefined) ?? -1, minProperties: (tail[2] as number | undefined) ?? 0 }
  shapes[i] = s
  return s
}

/** The properties the schema gives the definition `name` (one of the few the table names: schema-table.ts NAMED). */
export function schemaProperties(name: keyof typeof NAMED): ReadonlySet<string> {
  return new Set(shapeAt(NAMED[name]).props.keys())
}

/** What went wrong, and where: the keys from the value checked down to the offending one, innermost first (the path is only built for a refusal). */
interface Problem {
  readonly keys: (string | number)[]
  /** what is wrong, in words (worked out only for the refusal that is thrown) */
  readonly msg: () => string
  /** how far into the value it was found: a union reports the alternative that got furthest */
  depth: number
  /** the value is not the one constant a property takes (a `type: "boxplot"`): the alternative is not the one meant */
  weak?: boolean
}

/** A type that is a list of names and nothing else (a mark type, a selection type). */
const isNamesOnly = (t: Type): boolean => t.enums !== undefined && t.mask === 0 && t.shapes.length === 0 && t.arrays.length === 0 && t.maps.length === 0 && t.nums.length === 0 && t.strs.length === 0

/** Is `p` a better account of what is wrong than `q`: not a mismatched constant, then further in. */
const better = (p: Problem, q: Problem | undefined): boolean => q === undefined || (!p.weak && q.weak === true) || (p.weak === q.weak && p.depth > q.depth)

const problem = (msg: () => string): Problem => ({ keys: [], msg, depth: 0 })
function below(p: Problem, key: string | number): Problem {
  p.keys.push(key)
  p.depth++
  return p
}

/** The values the walk found at a position the schema types as any value: they are literals, `{"expr"}` objects included. */
const literals: WeakSet<object> = new WeakSet()

/** Is `v` (an object of a checked spec) a literal value, given where the schema types any value, so no `{"expr"}` in it is an expression? */
export function isLiteralValue(v: object): boolean {
  return literals.has(v)
}

/** An object as the walk reads it: its keys that hold something, and their values, each read once (the compile's copy of the spec
 * counts reads: consume.ts). */
interface Entries {
  readonly v: Obj
  readonly keys: readonly string[]
  readonly vals: readonly unknown[]
}
function entriesOf(v: Obj): Entries {
  const keys: string[] = []
  const vals: unknown[] = []
  for (const k of Object.keys(v)) {
    const x = v[k]
    if (x === undefined) continue
    keys.push(k)
    vals.push(x)
  }
  return { v, keys, vals }
}
const isExprRefEntries = (o: Entries): boolean => o.keys.length === 1 && o.keys[0] === 'expr' && typeof o.vals[0] === 'string'
const has = (o: Entries, k: string): boolean => o.keys.includes(k)

const isExprRef = (v: Obj): boolean => {
  for (const k in v) if (k !== 'expr') return false
  return typeof v.expr === 'string'
}

function check(v: unknown, ti: number): Problem | undefined {
  if (v === undefined) return undefined
  if (ti === INLINE_DATASET) return Array.isArray(v) || typeof v === 'string' || isObj(v) ? undefined : problem(() => `must be ${expected(typeAt(ti))}, got ${show(v)}`)
  const t = typeAt(ti)
  if (t.mask & ANY) {
    if (v !== null && typeof v === 'object' && !(t.expr && isObj(v) && isExprRef(v))) literals.add(v)
    return undefined
  }
  if (t.enums?.has(v)) return undefined
  if (t.enums?.size === 1 && isNamesOnly(t)) {
    return { keys: [], msg: () => `must be ${expected(t)}, got ${show(v)}`, depth: 0, weak: true }
  }
  switch (typeof v) {
    case 'string':
      if (t.mask & STRING) return undefined
      if (t.strs.some(([lo, hi]) => (lo === null || v.length >= lo) && (hi === null || v.length <= hi))) return undefined
      return problem(() => `must be ${expected(t)}, got ${show(v)}${t.enums ? suggest(v, [...t.enums].filter((x): x is string => typeof x === 'string')) : ''}`)
    case 'number':
      if (Number.isFinite(v)) {
        if (t.mask & NUMBER) return undefined
        if ((t.mask & INTEGER) && Number.isInteger(v)) return undefined
        if (t.nums.some(([lo, hi, int]) => (lo === null || v >= lo) && (hi === null || v <= hi) && (int !== 1 || Number.isInteger(v)))) return undefined
      }
      return problem(() => `must be ${expected(t)}, got ${show(v)}`)
    case 'boolean':
      return t.mask & BOOLEAN ? undefined : problem(() => `must be ${expected(t)}, got ${show(v)}`)
    case 'object':
      if (v === null) return t.mask & NULL ? undefined : problem(() => `must be ${expected(t)}, got null`)
      if (Array.isArray(v)) return checkArray(v, t)
      return checkObject(entriesOf(v as Obj), t)
  }
  return problem(() => `must be ${expected(t)}, got ${show(v)}`)
}

function checkArray(v: unknown[], t: Type): Problem | undefined {
  if (t.arrays.length === 0) return problem(() => `must be ${expected(t)}, got an array`)
  let best: Problem | undefined
  for (const [item, lo, hi] of t.arrays) {
    let p: Problem | undefined
    if (lo >= 0 && v.length < lo) p = problem(() => `must have at least ${lo} item${lo === 1 ? '' : 's'}, got ${v.length}`)
    else if (hi >= 0 && v.length > hi) p = problem(() => `must have at most ${hi} item${hi === 1 ? '' : 's'}, got ${v.length}`)
    else {
      for (let i = 0; i < v.length && p === undefined; i++) {
        const q = check(v[i], item)
        if (q !== undefined) p = below(q, i)
      }
    }
    if (p === undefined) return undefined
    if (better(p, best)) best = p
  }
  return best
}

function checkObject(o: Entries, t: Type): Problem | undefined {
  const v = o.v
  if (t.expr && isExprRefEntries(o)) return undefined
  if (t.mask & OBJECT) {
    literals.add(v)
    return undefined
  }
  // (an {"expr"} where the schema takes no ExprRef, nor any object: vega-lite does not read it as an expression, and as the object
  // it is it is no value of the position's type - an object of a known shape whose keys it would not have)
  if (t.maps.length === 0 && isExprRefEntries(o)) return problem(() => `must be ${expected(t)}, got an {"expr"} reference (an expression is not allowed here)`)
  const n = t.shapes.length + t.maps.length
  if (n === 0) return problem(() => `must be ${expected(t)}, got ${show(v)}`)
  // (where a value goes - a primitive, or else a DateTime, an ExprRef ... - an object that has none of their properties is not one
  // of them: `{"a": 1}` as a domain value or a datum)
  if (((t.mask & ~NULL) !== 0 || t.enums !== undefined) && t.maps.length === 0 && !t.shapes.some((si) => knowsAny(o, shapeAt(si)))) return problem(() => `must be ${expected(t)}, got ${show(v)}`)
  if (n === 1 && t.maps.length === 0) return checkShape(o, shapeAt(t.shapes[0]!))
  // (several alternatives: the object is the one that has the most of its keys and all of its required ones - the others are
  // properties vega-lite ignores there; it passes if one of those takes it. When none does, the refusal is the one of the alternative
  // that got furthest into the object, or else of the one whose properties the keys fit best)
  const tiers = new Map<number, number[]>()
  let closest = -1
  let closestFit = -1
  for (const si of t.shapes) {
    const s = shapeAt(si)
    const [known, complete, fit] = keysFit(o, s)
    if (complete && (strictKeys === 0 || known === o.keys.length)) {
      const tier = tiers.get(known)
      if (tier === undefined) tiers.set(known, [si])
      else tier.push(si)
    }
    if (fit > closestFit) { closest = si; closestFit = fit }
  }
  // (the alternatives that have the most of its keys first; the next ones only when those are not what the object is - each refused
  // a required constant of theirs, a `type` that names another kind)
  let best: Problem | undefined
  for (const known of [...tiers.keys()].sort((a, b) => b - a)) {
    let allWeak = true
    for (const si of tiers.get(known)!) {
      const p = checkShape(o, shapeAt(si))
      if (p === undefined) return undefined
      if (!p.weak) allWeak = false
      if (better(p, best)) best = p
    }
    if (!allWeak) break
  }
  for (const m of t.maps) {
    const p = checkMap(o, m)
    if (p === undefined) return undefined
    best ??= p
  }
  if (best !== undefined) return best
  return closest >= 0 ? checkShape(o, shapeAt(closest)) : problem(() => `must be ${expected(t)}, got ${show(v)}`)
}

/**
 * How `s` fits `v`: how many of `v`'s keys `s` has, whether `v` has all of `s`'s required keys, and a score for the refusal of an
 * object no alternative takes (its keys that `s` has and its required keys that are there, then whether `s` has the first key: the
 * one a spec writes first says what the object is - `field` on an `x2`, `repeat` on a view).
 */
function keysFit(o: Entries, s: Shape): [known: number, complete: boolean, fit: number] {
  let known = 0
  for (const k of o.keys) if (s.additional !== -1 || s.props.has(k)) known++
  const first = o.keys.length > 0 && (s.additional !== -1 || s.props.has(o.keys[0]!)) ? 1 : 0
  let required = 0
  for (const r of s.required) if (has(o, r)) required++
  return [known, required === s.required.length, (known + required) * 2 + first]
}

/**
 * Inside the config, a property the schema does not have is refused (the config is copied as plain data: nothing else notices a
 * typo there). In the spec it is left to validate.ts and the consumption check, which refuse what the compiler does not read; what it
 * reads beyond the schema is what vega-lite reads there (the differentials of conformance/test pin each).
 */
let strictKeys = 0

/** Does `v` have at least one of the properties of `s` (or none at all)? */
function knowsAny(o: Entries, s: Shape): boolean {
  if (o.keys.length === 0) return true
  for (const k of o.keys) if (s.props.has(k)) return true
  return false
}

function checkShape(o: Entries, s: Shape): Problem | undefined {
  const config = s === shapeAt(NAMED.Config)
  if (config) strictKeys++
  try {
    for (let i = 0; i < o.keys.length; i++) {
      const k = o.keys[i]!
      const x = o.vals[i]
      let ti = s.props.get(k)
      if (ti === undefined) {
        if (s.additional === -2) continue
        if (s.additional === -1) {
          // (outside the config, a property the definition does not have is left to validate.ts and the consumption check)
          if (strictKeys === 0) continue
          return problem(() => `unknown property ${JSON.stringify(k)}${suggest(k, s.props.keys())}`)
        }
        ti = s.additional
      }
      const p = check(x, ti)
      if (p !== undefined) {
        // (a required property whose value is not one of the names it takes: the object is another alternative's)
        if (p.depth === 0 && s.required.includes(k) && isNamesOnly(typeAt(ti))) p.weak = true
        return below(p, k)
      }
    }
    for (const r of s.required) if (!has(o, r)) return problem(() => `needs \`${r}\``)
    if (o.keys.length < s.minProperties) return problem(() => 'must not be empty')
    return undefined
  } finally {
    if (config) strictKeys--
  }
}

function checkMap(o: Entries, ti: number): Problem | undefined {
  for (let i = 0; i < o.keys.length; i++) {
    const p = check(o.vals[i], ti)
    if (p !== undefined) return below(p, o.keys[i]!)
  }
  return undefined
}

/** What a type takes, in words: "a number or an {"expr"} reference". */
function expected(t: Type): string {
  if (t.mask & ANY) return 'any value'
  const out: string[] = []
  if (t.mask & STRING) out.push('a string')
  for (const [lo, hi] of t.strs) out.push(lo === hi ? `a string of ${lo} character${lo === 1 ? '' : 's'}` : hi === null ? `a string of at least ${lo} characters` : `a string of at most ${hi} character${hi === 1 ? '' : 's'}`)
  if (t.mask & NUMBER) out.push('a number')
  else if (t.mask & INTEGER) out.push('an integer')
  for (const [lo, hi, int] of t.nums) {
    const what = int === 1 ? 'an integer' : 'a number'
    out.push(lo !== null && hi !== null ? `${what} from ${lo} to ${hi}` : lo !== null ? `${what} of at least ${lo}` : `${what} of at most ${hi}`)
  }
  if (t.mask & BOOLEAN) out.push('a boolean')
  if (t.enums !== undefined) {
    const vals = [...t.enums]
    out.push(vals.length === 1 ? JSON.stringify(vals[0]) : vals.length <= 12 ? `one of ${vals.map((x) => JSON.stringify(x)).join(', ')}` : `one of the ${vals.length} names Vega-Lite defines`)
  }
  if (t.arrays.length) out.push('an array')
  if (t.shapes.length > (t.expr ? 1 : 0) || t.maps.length || t.mask & OBJECT) out.push('an object')
  if (t.expr) out.push('an {"expr"} reference')
  if (t.mask & NULL) out.push('null')
  return out.length <= 1 ? (out[0] ?? 'nothing') : `${out.slice(0, -1).join(', ')} or ${out[out.length - 1]}`
}

/** A value as a refusal shows it (JSON would print a NaN or an infinity as null). */
function show(v: unknown): string {
  if (typeof v === 'number' && !Number.isFinite(v)) return String(v)
  if (Array.isArray(v)) return 'an array'
  if (isObj(v)) return 'an object'
  const s = JSON.stringify(v)
  return s === undefined ? String(v) : s.length > 60 ? `${s.slice(0, 57)}...` : s
}

/** `a.b[2].c` from the keys of a problem (innermost first). */
function pathOf(keys: readonly (string | number)[]): string {
  let out = ''
  for (let i = keys.length - 1; i >= 0; i--) {
    const k = keys[i]!
    out += typeof k === 'number' ? `[${k}]` : out === '' ? k : `.${k}`
  }
  return out
}

/**
 * Hold `spec` to the Vega-Lite schema: throws a VLCompileError naming the first value (in the spec's order) the schema does not
 * allow where it stands. Records the literal values (`isLiteralValue`) as it goes.
 */
export function checkSchema(spec: unknown): void {
  const p = check(spec, ROOT)
  if (p !== undefined) throw new VLCompileError(`${pathOf(p.keys) || '<spec>'}: ${p.msg()} (Vega-Lite ${SCHEMA_VERSION} schema)`)
}
