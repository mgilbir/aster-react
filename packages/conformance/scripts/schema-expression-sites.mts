/**
 * Every place the pinned Vega JSON schema (vega/build/vega-schema.json) lets a spec hold an expression, generated from the schema
 * itself rather than listed by hand (C126, C284: a hand list of sites missed the root `layout` and `encode`, a facet's
 * parameters, ...). A site is a property whose schema admits a `signalRef` (`{signal: <expression>}`), an `exprString` (the text
 * is the expression) or an `expr` (`{expr: <expression>}`), at any depth of a definition the spec can place: the spec itself, a
 * dataset, each transform, each mark type, a facet, a scale, a projection, an axis, a legend, the title, a signal, a data or mark
 * trigger, and the encode entries of a mark.
 *
 * Each site is a function from the text of an expression to a whole spec: a minimal instance of its definition (its required
 * properties, each a minimal value that names the base spec's dataset `d`, field `a`, scale `x`, projection `p` and signal `s`
 * where a name is expected), placed in a base spec, with the expression at the site.
 */
import rawSchema from '../node_modules/vega/build/vega-schema.json' with { type: 'json' }

type Json = Record<string, unknown>
const schema = rawSchema as unknown as Json
const defs = schema.definitions as Record<string, Json>

const deref = (n: Json): Json => {
  let cur = n
  for (let i = 0; cur && typeof cur.$ref === 'string' && i < 20; i++) cur = defs[(cur.$ref as string).replace('#/definitions/', '')]!
  return cur
}
const refName = (n: Json): string | undefined => (typeof n.$ref === 'string' ? (n.$ref as string).replace('#/definitions/', '') : undefined)
const SIGNAL_DEFS = new Set(['signalRef'])
const branches = (n: Json): Json[] => [...((n.anyOf ?? n.oneOf ?? []) as Json[]), ...((n.allOf ?? []) as Json[])]

/** Whether a schema node admits `{signal}` (itself, or one of its alternatives, through references). */
function admitsSignal(n: Json, depth = 0): boolean {
  if (depth > 6 || !n) return false
  const name = refName(n)
  if (name && SIGNAL_DEFS.has(name)) return true
  if (name) return admitsSignal(defs[name]!, depth + 1)
  return ((n.anyOf ?? n.oneOf ?? []) as Json[]).some((b) => admitsSignal(b, depth + 1))
}
const isExprString = (n: Json): boolean => refName(n) === 'exprString'
const admitsExprObject = (n: Json, depth = 0): boolean => {
  if (depth > 6 || !n) return false
  const name = refName(n)
  if (name === 'expr') return true
  if (name) return admitsExprObject(defs[name]!, depth + 1)
  return ((n.anyOf ?? n.oneOf ?? []) as Json[]).some((b) => admitsExprObject(b, depth + 1))
}

/** A value for a string the base spec can resolve, by the name of the property that holds it. */
function nameFor(prop: string): string {
  if (/^(data|from|source)$/.test(prop)) return 'd'
  if (/scale|^(fill|stroke|size|shape|opacity|strokeDash|strokeWidth)$/.test(prop)) return 'x'
  if (prop === 'projection') return 'p'
  if (prop === 'name') return 'n0'
  return 'a'
}

/** A minimal instance of a schema node: its required properties, each minimal; the first alternative that is not a signal. */
function instance(n: Json, prop = '', depth = 0): unknown {
  if (depth > 12) return undefined
  const name = refName(n)
  if (name === 'signalRef') return { signal: 's' }
  if (name === 'exprString') return 'datum.a'
  if (name) return instance(defs[name]!, prop, depth + 1)
  if ('const' in n) return n.const
  if (Array.isArray(n.enum)) return n.enum[0]
  if (n.allOf) {
    let out: Json = {}
    for (const part of n.allOf as Json[]) { const v = instance(part, prop, depth + 1); if (v && typeof v === 'object' && !Array.isArray(v)) out = { ...out, ...(v as Json) } }
    return out
  }
  const alts = (n.anyOf ?? n.oneOf) as Json[] | undefined
  if (alts) {
    // (a plain value first: a field is its name, a list a list of names; then any alternative that is not an expression)
    const plain = (b: Json, depth2 = 0): boolean => {
      const node = deref(b)
      if (!node || depth2 > 4) return false
      const t = node.type
      if (t === 'string' || t === 'number' || t === 'boolean') return true
      return ((node.anyOf ?? node.oneOf ?? []) as Json[]).some((x) => refName(x) !== 'signalRef' && plain(x, depth2 + 1))
    }
    const pick = alts.find((b) => refName(b) !== 'signalRef' && plain(b)) ?? alts.find((b) => !admitsSignal(b) && refName(b) !== 'expr') ?? alts[0]!
    return instance(pick, prop, depth + 1)
  }
  const type = Array.isArray(n.type) ? (n.type as string[])[0] : n.type
  switch (type) {
    case 'object': {
      const out: Json = {}
      const props = (n.properties ?? {}) as Record<string, Json>
      for (const r of (n.required ?? []) as string[]) out[r] = props[r] ? instance(props[r]!, r, depth + 1) : nameFor(r)
      return out
    }
    case 'array': return Array.from({ length: (n.minItems as number | undefined) ?? 0 }, () => instance((n.items ?? {}) as Json, prop, depth + 1))
    case 'string': return nameFor(prop)
    case 'number': case 'integer': return 1
    case 'boolean': return true
    case 'null': return null
    default: return undefined
  }
}

/**
 * Every property path under an object schema where an expression can stand, and how it is written there. Where the schema offers
 * alternative objects (a scale of one type or another, a force of one kind or another), each alternative is its own set of sites,
 * and `templates` says what the containers along the path are for it (its minimal instance), so the site is a valid one of it.
 */
interface SitePath { path: Array<string | number>; form: 'signal' | 'exprString' | 'expr'; templates: Array<{ path: Array<string | number>; value: unknown }> }
function sitePaths(n: Json, path: Array<string | number> = [], out: SitePath[] = [], seen = new Set<Json>(), depth = 0, templates: SitePath['templates'] = []): SitePath[] {
  const node = deref(n)
  if (!node || depth > 5 || seen.has(node)) return out
  seen.add(node)
  const alternatives = branches(node).map(deref).filter((b) => b && b.properties)
  const objectBranches = node.properties ? [node, ...alternatives] : alternatives
  for (const b of objectBranches) {
    // (an alternative is placed as itself: its own minimal instance at this place, the property set on it)
    const here = b === node || path.length === 0 ? templates : [...templates, { path, value: instance(b) }]
    for (const [prop, sub] of Object.entries(b.properties as Record<string, Json>)) {
      if (prop === 'signal' || prop === 'encode' || prop === 'marks' || prop === 'data' || prop === 'signals' || prop === 'scales' || prop === 'axes' || prop === 'legends' || prop === 'projections' || prop === 'transform' || prop === 'on') continue
      const p = [...path, prop]
      if (isExprString(sub)) out.push({ path: p, form: 'exprString', templates: here })
      else if (admitsSignal(sub)) out.push({ path: p, form: 'signal', templates: here })
      else if (admitsExprObject(sub)) out.push({ path: p, form: 'expr', templates: here })
      const target = deref(sub)
      // (lists of values: the first item)
      const items = target?.type === 'array' && target.items ? (target.items as Json) : undefined
      if (items) {
        if (admitsSignal(items)) out.push({ path: [...p, 0], form: 'signal', templates: here })
        else if (admitsExprObject(items)) out.push({ path: [...p, 0], form: 'expr', templates: here })
        sitePaths(items, [...p, 0], out, new Set(seen), depth + 1, here)
      } else {
        sitePaths(sub, p, out, new Set(seen), depth + 1, here)
      }
    }
  }
  return out
}

const setAt = (root: Json, path: Array<string | number>, value: unknown): Json => {
  const copy = structuredClone(root)
  if (path.length === 0) return value as Json
  let cur: Record<string | number, unknown> = copy
  for (let i = 0; i < path.length - 1; i++) {
    const k = path[i]!
    const next = path[i + 1]
    if (cur[k] === undefined || cur[k] === null || typeof cur[k] !== 'object') cur[k] = typeof next === 'number' ? [] : {}
    cur = cur[k] as Record<string | number, unknown>
  }
  cur[path[path.length - 1]!] = value
  return copy
}

export const schemaBase = (o: Json = {}): Json => ({
  width: 100, height: 100,
  data: [{ name: 'd', values: [{ a: 1 }] }],
  scales: [{ name: 'x', type: 'linear', domain: [0, 1], range: [0, 1] }],
  projections: [{ name: 'p', type: 'mercator' }],
  signals: [{ name: 's', value: 1 }],
  marks: [],
  ...o,
})

/** Where a definition is placed in a spec, given its instance. */
const SLOTS: Array<[string, (v: Json) => Json]> = [
  ['data', (v) => schemaBase({ data: [{ name: 'd', values: [{ a: 1 }] }, { name: 'e', source: 'd', ...v }] })],
  // (a scale with a domain, so `domainMin` and its kin have one to override; a range object that names no scheme is a scheme's)
  ['scale', (v) => schemaBase({ scales: [{ name: 'x', type: 'linear', domain: [0, 1], range: [0, 1] }, {
    name: 'y', domain: [0, 1], ...v,
    ...(v.range && typeof v.range === 'object' && !Array.isArray(v.range) && !(v.range as Json).signal && !(v.range as Json).step && !(v.range as Json).scheme ? { range: { scheme: 'blues', ...(v.range as Json) } } : {}),
  }] })],
  ['projection', (v) => schemaBase({ projections: [{ name: 'p', type: 'mercator' }, { name: 'q', ...v }] })],
  ['axis', (v) => schemaBase({ axes: [{ orient: 'bottom', scale: 'x', ...v }] })],
  ['legend', (v) => schemaBase({ legends: [{ fill: 'x', ...v }] })],
  ['title', (v) => schemaBase({ title: { text: 't', ...v } })],
  ['mark', (v) => schemaBase({ marks: [{ type: 'rect', from: { data: 'd' }, ...v }] })],
  ['markGroup', (v) => schemaBase({ marks: [{ type: 'group', ...v }] })],
  ['facet', (v) => schemaBase({ marks: [{ type: 'group', from: { facet: { name: 'f', data: 'd', groupby: 'a', ...v } } }] })],
  ['root', (v) => schemaBase(v)],
]

export interface SchemaSite { name: string; make: (e: string) => Json }

/** The sites of the schema: every definition placed in its slot, every place in it an expression can be written. */
export function schemaSites(): SchemaSite[] {
  const out: SchemaSite[] = []
  const add = (slot: string, schemaNode: Json, place: (v: Json) => Json, extra: Json = {}): void => {
    const base = { ...(instance(schemaNode) as Json), ...extra }
    for (const { path, form, templates } of sitePaths(schemaNode)) {
      const key = path.join('.')
      if (key === 'name' || key === 'type' || key.startsWith('from.facet') && slot !== 'facet') continue
      const kind = templates.map((t) => { const v = t.value as Json | undefined; return v && typeof v === 'object' ? String(v.type ?? v.force ?? v.function ?? '') : '' }).filter(Boolean).join('/')
      let shaped = base
      for (const t of templates) shaped = setAt(shaped, t.path, { ...(t.value as Json), ...((shaped as Json)[t.path[0] as string] && t.path.length === 1 ? {} : {}) })
      out.push({
        name: `${slot}.${key}${kind ? ` [${kind}]` : ''} (${form})`,
        make: (e) => place(setAt(shaped, path, form === 'signal' ? { signal: e } : form === 'expr' ? { expr: e } : e)),
      })
    }
  }
  const slot = (name: string): (v: Json) => Json => SLOTS.find(([n]) => n === name)![1]
  for (const t of Object.keys(defs).filter((k) => /Transform$/.test(k) && k !== 'transform' && k !== 'transformMark')) {
    const node = defs[t]!
    const type = ((node.properties as Record<string, Json>)?.type?.enum as string[] | undefined)?.[0]
    if (!type) continue
    add(`transform:${type}`, node, (v) => schemaBase({ data: [{ name: 'd', values: [{ a: 1 }] }, { name: 'e', source: 'd', transform: [{ ...v, type }] }] }))
  }
  add('data', defs.data!, slot('data'))
  add('scale', defs.scale!, slot('scale'))
  add('projection', defs.projection!, slot('projection'))
  add('axis', defs.axis!, slot('axis'))
  add('legend', defs.legend!, slot('legend'))
  add('title', defs.title!, slot('title'))
  add('mark', defs.mark!, slot('mark'))
  add('markGroup', defs.markGroup!, slot('markGroup'))
  add('facet', defs.facet!, slot('facet'))
  // the spec itself: its own properties (layout, autosize, padding, background, ...), read through the schema's top level
  add('root', { allOf: schema.allOf as Json[] } as Json, slot('root'))
  // every channel of an encode entry, in the view's own encode and in a mark's
  for (const channel of Object.keys((defs.encodeEntry!.properties ?? {}) as Json)) {
    out.push({ name: `root.encode.update.${channel} (signal)`, make: (e) => schemaBase({ encode: { update: { [channel]: { signal: e } } } }) })
    out.push({ name: `mark.encode.update.${channel} (signal)`, make: (e) => schemaBase({ marks: [{ type: 'rect', from: { data: 'd' }, encode: { update: { [channel]: { signal: e } } } }] }) })
  }
  return out
}
