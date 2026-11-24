// Generates packages/vl/src/schema-table.ts from the Vega-Lite JSON schema the repo pins (vega-lite 6.4.3, through the conformance
// package's dependency). Run it after changing the pinned vega-lite or the extensions below:
//
//   node packages/vl/scripts/schema-table.mjs            (writes the table)
//   node packages/vl/scripts/schema-table.mjs --check    (exits 1 if the committed table is not what the schema gives)
//
// packages/vl/test/schema-table.test.ts runs the same check, so a table that drifts from the schema (or from this generator) fails
// the gates.
//
// What the table is. Every position of a Vega-Lite spec has a type in the schema: a union of primitive kinds (string, number,
// integer, boolean, null), enumerated values, arrays (of a type, with length bounds), objects of a known shape (their properties,
// which are required, whether others are allowed) and maps (`Dict<T>`). The generator resolves every `$ref` and flattens every
// `anyOf`, so each position's type is ONE flat union; equal unions share an entry. Descriptions are dropped. The checker that reads
// the table is packages/vl/src/schema.ts.
//
// Encoding (compact, so the table costs little in the bundle):
//   TYPES[i]  = a number (the kinds mask alone), or [mask, enumIndex | [enumIndex ...] | -1, shapes | 0, arrays | 0, maps | 0, numbers | 0, strings | 0]
//               shapes: indices into SHAPES; arrays: [itemType, minItems, maxItems] (-1 for none); maps: value types;
//               numbers: [minimum, maximum] of bounded number alternatives ([minimum, maximum, 1] for an integer; null for an
//               open bound); strings: [minLength,
//               maxLength] pairs of bounded string alternatives
//   SHAPES[j] = ["prop prop ...", [type of each prop], "required ...", additional, minProperties], or, for a shape that is an earlier
//               one with a few differences, [base, "removed ...", "added or retyped ...", [their types], "required ...", additional,
//               minProperties]. additional: -1 no other property (the default), -2 any other property, else the type of every
//               other property. Trailing defaults ("", -1, 0) are left out.
//   ENUMS[k]  = the enumerated values (strings, numbers, true, null)
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const OUT = join(here, '..', 'src', 'schema-table.ts')

/** Kinds mask bits (schema.ts reads the same bits). */
export const K = { STRING: 1, NUMBER: 2, INTEGER: 4, BOOLEAN: 8, NULL: 16, ANY: 32, OBJECT: 64, ARRAY: 128 }

/** Patch helpers: `ref('X')` is a reference to the definition X; `widen(node, ...alts)` makes `node` take `alts` too. */
const ref = (name) => ({ $ref: `#/definitions/${name}` })
function widen(holder, key, ...alts) {
  const node = holder[key]
  holder[key] = { anyOf: [node.anyOf ? { anyOf: node.anyOf } : stripBounds(node), ...alts], ...bounds(node) }
}
const BOUND_KEYS = ['minimum', 'maximum', 'minItems', 'maxItems', 'minLength', 'maxLength']
const bounds = (n) => Object.fromEntries(BOUND_KEYS.filter((k) => n[k] !== undefined && n.anyOf).map((k) => [k, n[k]]))
const stripBounds = (n) => n
const optional = (def, key) => { def.required = def.required.filter((r) => r !== key) }
const TYPE = ref('Type')
/** A Vega {"signal"} reference, which vega-lite passes on to Vega where it reads one. */
const SIGNAL = { type: 'object', properties: { signal: { type: 'string' } }, required: ['signal'], additionalProperties: false }
const ANY_BIN = { anyOf: [{ type: 'boolean' }, ref('BinParams'), { const: 'binned' }, { type: 'null' }] }

/**
 * Where vega-lite 6.4.3 reads a spec beyond its own schema, and Aster draws vega-lite's chart there: the schema is widened so the
 * form is not refused. Kept by hand and small; each entry names the vega-lite differential that holds Aster to vega-lite's output
 * for it, and an example that the unwidened schema refuses (packages/vl/test/schema-table.test.ts holds every entry to its example,
 * so an entry cannot outlive its reason). Anything else the schema forbids is refused (schema.ts).
 */
export const EXTENSIONS = [
  {
    why: 'a facet\'s `spec` may be any view: a facet (vega-lite\'s `_future` gallery examples), a repeat or a concat; vega-lite\'s schema lists a layer or a unit only',
    pinnedBy: 'conformance/test/vl-facet-composite.test.ts',
    example: { data: { values: [] }, facet: { column: { field: 'g' } }, spec: { hconcat: [{ mark: 'point' }] } },
    patch: (d) => {
      for (const f of ['FacetSpec', 'TopLevelFacetSpec']) {
        for (const v of ['FacetSpec', 'RepeatSpec', 'ConcatSpec<GenericSpec>', 'HConcatSpec<GenericSpec>', 'VConcatSpec<GenericSpec>']) d[f].properties.spec.anyOf.push(ref(v))
      }
    },
  },
  {
    why: 'a longitude / latitude is projected whatever its definition says: vega-lite reads any `type` and ignores `bin` and a `value` there, and ignores `bin` on a secondary channel (x2, y2, theta2 ...)',
    pinnedBy: 'conformance/test/vl-geo-channels.test.ts, vl-mark-channels.test.ts; vl/test/readme-refusals.test.ts',
    example: { data: { values: [] }, mark: 'point', encoding: { longitude: { field: 'a', type: 'nominal', bin: true }, latitude: { field: 'b', type: 'quantitative' } } },
    patch: (d) => {
      d.LatLongFieldDef.properties.type = TYPE
      // (a constant: vega-lite reads no position from it, and draws the mark where it would without it)
      d.LatLongFieldDef.properties.value = {}
      d.LatLongFieldDef.properties.bin = ANY_BIN
      d.SecondaryFieldDef.properties.bin = ANY_BIN
    },
  },
  {
    why: 'a shape field of any measurement type: vega-lite draws a quantitative or temporal shape field as it draws an ordinal one',
    pinnedBy: 'conformance/test/vl-mark-channels.test.ts, vl-honoured-scale-types.test.ts',
    example: { data: { values: [] }, mark: 'point', encoding: { shape: { field: 'a', type: 'quantitative' } } },
    patch: (d) => { d.TypeForShape = TYPE },
  },
  {
    why: 'an `order` with a condition that gives a field or a datum (vega-lite reads it as it reads the condition of any other channel)',
    pinnedBy: 'conformance/test/vl-mark-channels.test.ts',
    example: { data: { values: [] }, mark: 'point', encoding: { order: { condition: { test: 'true', field: 'a' }, value: 1 } } },
    patch: (d) => { widen(d.OrderValueDef.properties, 'condition', ref('ConditionalMarkPropFieldOrDatumDef')) },
  },
  {
    why: 'field predicates that compare with null (`equal: null`, a `oneOf` list that mixes kinds) or with month and day names (`range: ["Jan", "Mar"]` under a time unit): vega-lite writes each into the filter expression',
    pinnedBy: 'conformance/test/vl-predicate.tz.test.ts',
    example: { data: { values: [] }, mark: 'point', transform: [{ filter: { field: 'a', oneOf: [0, null] } }] },
    patch: (d) => {
      widen(d.FieldEqualPredicate.properties, 'equal', { type: 'null' })
      d.FieldOneOfPredicate.properties.oneOf = { type: 'array', items: { anyOf: [{ type: ['string', 'number', 'boolean', 'null'] }, ref('DateTime')] } }
      d.FieldRangePredicate.properties.range.anyOf[0].items.anyOf.push({ type: 'string' })
    },
  },
  {
    why: '`stack: "wiggle"` (vega-lite 6.4.3 accepts it and stacks from zero)',
    pinnedBy: 'corpus/area-stack-wiggle.vl.json',
    example: { data: { values: [] }, mark: 'area', encoding: { y: { field: 'a', type: 'quantitative', stack: 'wiggle' } } },
    patch: (d) => { d.StackOffset.enum.push('wiggle') },
  },
  {
    why: 'a loess `as` given as a string: vega-lite reads it as the list of its characters, and so does Aster',
    pinnedBy: 'corpus/loess.vl.json',
    example: { data: { values: [] }, mark: 'line', transform: [{ loess: 'y', on: 'x', as: 'yx' }] },
    patch: (d) => { widen(d.LoessTransform.properties, 'as', ref('FieldName')) },
  },
  {
    why: 'a projection\'s `rotate`, `translate` and `center` with an {"expr"} or a Vega {"signal"} per component, and a projection type in any letter case (vega reads it case-insensitively; validate.ts refuses a name vega does not have)',
    pinnedBy: 'corpus/vlx-geo-params-type-rotate.vl.json, vlx-geo-params-scale-translate.vl.json, vlx-geo-geoshape-config-projection-signal-expr.vl.json, vlx-geo-proj-uppercase-type.vl.json',
    example: { data: { values: [] }, mark: 'geoshape', projection: { type: 'Mercator', rotate: [{ signal: 'r' }, 0] } },
    patch: (d) => {
      const component = { anyOf: [{ type: 'number' }, ref('ExprRef'), SIGNAL] }
      d.Projection.properties.rotate.anyOf.push({ type: 'array', items: component, minItems: 2, maxItems: 3 })
      for (const k of ['translate', 'center']) d.Projection.properties[k].anyOf.push({ type: 'array', items: component, minItems: 2, maxItems: 2 })
      d.Projection.properties.type.anyOf.push({ type: 'string' })
    },
  },
  {
    why: 'an aggregate\'s and a stack transform\'s `as` may be left out: vega-lite names the outputs itself',
    pinnedBy: 'corpus/vlx-tr-aggregate-default-as.vl.json, vlx-tr-stack-default-as.vl.json',
    example: { data: { values: [] }, mark: 'bar', transform: [{ aggregate: [{ op: 'count' }] }] },
    patch: (d) => { optional(d.AggregatedFieldDef, 'as'); optional(d.StackTransform, 'as') },
  },
  {
    why: 'a scale `domain` or `domainRaw` given as a Vega {"signal"} reference (vega-lite passes it to Vega)',
    pinnedBy: 'conformance/test/vl-compiler-parity.test.ts (datums, mark defs and unscaled values)',
    example: { data: { values: [] }, mark: 'point', encoding: { x: { field: 'a', type: 'quantitative', scale: { domain: { signal: '[0, 1]' } } } } },
    patch: (d) => {
      d.Scale.properties.domain.anyOf.push(SIGNAL)
      widen(d.Scale.properties, 'domainRaw', SIGNAL)
    },
  },
  {
    why: 'a channel set to null (a layer unsets a channel it would otherwise share): vega-lite drops it',
    pinnedBy: 'conformance/test/vl-compiler-parity.test.ts (shared layer encodings), vl-ignored-properties.test.ts',
    example: { data: { values: [] }, mark: 'point', encoding: { color: null } },
    patch: (d) => {
      for (const e of ['Encoding', 'FacetedEncoding', 'SharedEncoding']) for (const k of Object.keys(d[e].properties)) widen(d[e].properties, k, { type: 'null' })
    },
  },
  {
    why: 'an hconcat\'s or a vconcat\'s `spacing` as a {row, column} object (vega-lite reads the part of its direction)',
    pinnedBy: 'conformance/test/vl-compiler-parity.test.ts (the spacing of a composition)',
    example: { data: { values: [] }, spacing: { row: 1 }, hconcat: [{ mark: 'point' }] },
    patch: (d) => {
      for (const c of ['HConcatSpec<GenericSpec>', 'VConcatSpec<GenericSpec>', 'TopLevelHConcatSpec', 'TopLevelVConcatSpec']) widen(d[c].properties, 'spacing', ref('RowCol<number>'))
    },
  },
  {
    why: '`config.errorbar.center` and `config.errorband.center`: vega-lite reads the center of the composite mark from its config',
    pinnedBy: 'conformance/test/vl-composite-matrix.test.ts (errorbar and errorband, parts)',
    example: { data: { values: [] }, mark: 'errorbar', config: { errorbar: { center: 'median' } } },
    patch: (d) => { for (const c of ['ErrorBarConfig', 'ErrorBandConfig']) d[c].properties.center = { enum: ['mean', 'median'], type: 'string' } },
  },
  {
    why: '`config.header.title` (and the other header configs\') as a text: vega-lite titles the headers with it',
    pinnedBy: 'conformance/test/vl-facet-headers.test.ts',
    example: { data: { values: [] }, mark: 'point', config: { header: { title: 'T' } } },
    patch: (d) => { d.HeaderConfig.properties.title = { anyOf: [ref('Text'), ref('ExprRef'), { type: 'null' }] } },
  },
  {
    why: 'a `background: null` (no background: vega-lite emits none)',
    pinnedBy: 'conformance/test/vl-top-level.test.ts',
    example: { data: { values: [] }, mark: 'point', background: null },
    patch: (d) => {
      for (const t of ['TopLevelUnitSpec', 'TopLevelLayerSpec', 'TopLevelFacetSpec', 'TopLevelConcatSpec', 'TopLevelHConcatSpec', 'TopLevelVConcatSpec']) widen(d[t].properties, 'background', { type: 'null' })
      for (const a of d.TopLevelRepeatSpec.anyOf) widen(a.properties, 'background', { type: 'null' })
    },
  },
  {
    why: 'a title object with no `text` (a subtitle alone): vega-lite draws what it has',
    pinnedBy: 'conformance/test/vl-top-level.test.ts',
    example: { data: { values: [] }, mark: 'point', title: { subtitle: 'S' } },
    patch: (d) => { optional(d.TitleParams, 'text') },
  },
  {
    why: 'a pre-binned time unit (`binnedyearmonth` ...) in a timeUnit transform: vega-lite reads the field as the start of the unit',
    pinnedBy: 'conformance/test/vl-timeunit.tz.test.ts (the pre-binned time units, in a transform)',
    example: { data: { values: [] }, mark: 'point', transform: [{ timeUnit: 'binnedyearmonth', field: 't', as: 'm' }] },
    patch: (d) => { d.TimeUnitTransform.properties.timeUnit.anyOf.push(ref('BinnedTimeUnit')) },
  },
]

/** The definitions the hand-kept checks name (validate.ts asks the table for their properties). */
const NAMED_SHAPES = ['Config']

/** The pinned schema: vega-lite as the conformance package installs it. */
export function pinnedSchema() {
  const pkg = join(here, '..', '..', 'conformance', 'node_modules', 'vega-lite')
  const version = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')).version
  return { schema: JSON.parse(readFileSync(join(pkg, 'build', 'vega-lite-schema.json'), 'utf8')), version }
}

/** The schema with the extensions applied (a copy). */
export function extendedSchema(schema, extensions = EXTENSIONS) {
  const copy = structuredClone(schema)
  for (const e of extensions) e.patch(copy.definitions)
  return copy
}

/** The table's TypeScript source for `schema` (already extended) at `version`. */
export function generate(schema, version) {
  const defs = schema.definitions
  const refName = (ref) => {
    if (!ref.startsWith('#/definitions/')) throw new Error(`unsupported $ref ${ref}`)
    return decodeURIComponent(ref.slice('#/definitions/'.length))
  }
  const KNOWN = new Set(['$ref', 'anyOf', 'type', 'enum', 'const', 'properties', 'additionalProperties', 'required', 'items', 'minItems', 'maxItems', 'minimum', 'maximum', 'minLength', 'maxLength', 'minProperties', 'format', 'description', 'markdownDescription'])

  const types = []
  const typeIndex = new Map()
  const shapes = []
  const shapeOfDef = new Map()
  const enums = []
  const enumIndex = new Map()

  const enumId = (values) => {
    const key = JSON.stringify(values)
    let i = enumIndex.get(key)
    if (i === undefined) { i = enums.length; enums.push(values); enumIndex.set(key, i) }
    return i
  }

  /**
   * The bounds a node puts on what it holds, tightened by the ones of the node around it: a `minimum` or a `minItems` beside an
   * `anyOf` holds for every alternative of the right kind (Padding's minimum, a range predicate's two items).
   */
  const BOUNDS = [['minimum', Math.max], ['maximum', Math.min], ['minItems', Math.max], ['maxItems', Math.min], ['minLength', Math.max], ['maxLength', Math.min]]
  const tighten = (node, outer) => {
    const c = { ...outer }
    for (const [k, pick] of BOUNDS) if (node[k] !== undefined) c[k] = c[k] === undefined ? node[k] : pick(c[k], node[k])
    return c
  }
  const pair = (lo, hi) => [lo ?? null, hi ?? null]

  /** Flatten `node` into `u` (a union being built), under the bounds `outer` of the nodes around it. */
  const collect = (node, u, outer = {}) => {
    for (const k of Object.keys(node)) if (!KNOWN.has(k)) throw new Error(`unsupported schema keyword ${k}`)
    const c = tighten(node, outer)
    if (node.$ref !== undefined) {
      const name = refName(node.$ref)
      const def = defs[name]
      if (def === undefined) throw new Error(`no definition ${name}`)
      if (isShape(def)) u.shapes.add(shapeId(def, name))
      else collect(def, u, c)
      return
    }
    if (node.anyOf !== undefined) {
      for (const alt of node.anyOf) collect(alt, u, c)
      return
    }
    if (node.enum !== undefined || 'const' in node) {
      u.enum.push(node.enum ?? [node.const])
      return
    }
    if (node.type === undefined) {
      if (Object.keys(node).every((k) => k === 'description' || k === 'markdownDescription')) { u.mask |= K.ANY; return }
      throw new Error(`a schema node without a type: ${JSON.stringify(node).slice(0, 200)}`)
    }
    for (const t of Array.isArray(node.type) ? node.type : [node.type]) {
      switch (t) {
        case 'string':
          if (c.minLength !== undefined || c.maxLength !== undefined) u.strs.add(JSON.stringify(pair(c.minLength, c.maxLength)))
          else u.mask |= K.STRING
          break
        case 'boolean': u.mask |= K.BOOLEAN; break
        case 'null': u.mask |= K.NULL; break
        case 'integer':
        case 'number':
          // (a bounded number is [minimum, maximum], a bounded integer [minimum, maximum, 1])
          if (c.minimum !== undefined || c.maximum !== undefined) u.nums.add(JSON.stringify(t === 'integer' ? [...pair(c.minimum, c.maximum), 1] : pair(c.minimum, c.maximum)))
          else u.mask |= t === 'integer' ? K.INTEGER : K.NUMBER
          break
        case 'array': {
          const item = node.items === undefined ? typeId({}) : typeId(node.items)
          u.arrays.add(JSON.stringify([item, c.minItems ?? -1, c.maxItems ?? -1]))
          break
        }
        case 'object':
          if (node.properties !== undefined || node.additionalProperties === false) u.shapes.add(shapeId(node))
          else if (node.additionalProperties === undefined || isEmpty(node.additionalProperties)) u.mask |= K.OBJECT
          else u.maps.add(typeId(node.additionalProperties))
          break
        default:
          throw new Error(`unsupported type ${t}`)
      }
    }
  }
  const isEmpty = (n) => n === true || (typeof n === 'object' && Object.keys(n).every((k) => k === 'description' || k === 'markdownDescription'))
  const isShape = (n) => n.type === 'object' && (n.properties !== undefined || n.additionalProperties === false)

  /** The index of the flattened union of `node`. A reference to a definition that is not an object shape is one entry (made once:
   * a definition can hold itself, through an array). */
  const refTypes = new Map()
  function typeId(node) {
    if (node.$ref !== undefined && Object.keys(node).every((k) => k === '$ref' || k === 'description' || k === 'markdownDescription')) {
      const name = refName(node.$ref)
      if (!isShape(defs[name] ?? {})) {
        let i = refTypes.get(name)
        if (i === undefined) {
          i = types.length
          types.push(null)
          refTypes.set(name, i)
          types[i] = unionEntry(node)
        }
        return i
      }
    }
    const entry = unionEntry(node)
    const key = JSON.stringify(entry)
    let i = typeIndex.get(key)
    if (i === undefined) { i = types.length; types.push(entry); typeIndex.set(key, i) }
    return i
  }

  /** The table entry of the flattened union of `node`. */
  function unionEntry(node) {
    const u = { mask: 0, enum: [], shapes: new Set(), arrays: new Set(), maps: new Set(), nums: new Set(), strs: new Set() }
    collect(node, u)
    if (u.mask & K.ANY) u.mask = K.ANY
    if (u.mask & K.NUMBER) { u.mask &= ~K.INTEGER; u.nums.clear() }
    if (u.mask & K.STRING) u.strs.clear()
    // (an enumerated value the kinds already accept says nothing more)
    const covered = (v) => (u.mask & K.ANY) || (typeof v === 'string' && (u.mask & K.STRING)) || (typeof v === 'number' && (u.mask & K.NUMBER)) || (v === null && (u.mask & K.NULL)) || (typeof v === 'boolean' && (u.mask & K.BOOLEAN))
    // (each enumeration of the schema stays one list, shared by every union that holds it; a list another of the union holds is left out)
    const lists = u.enum.map((l) => l.filter((v) => !covered(v))).filter((l) => l.length > 0)
    const kept = lists.filter((l, i) => !lists.some((o, j) => j !== i && (o.length > l.length || (o.length === l.length && j < i)) && l.every((v) => o.includes(v))))
    const ids = [...new Set(kept.map(enumId))].sort((a, b) => a - b)
    const enumI = ids.length === 0 ? -1 : ids.length === 1 ? ids[0] : ids
    const sorted = (s) => [...s].sort((a, b) => a - b)
    const parts = [u.mask, enumI, u.shapes.size ? sorted(u.shapes) : 0, u.arrays.size ? [...u.arrays].sort().map((a) => JSON.parse(a)) : 0, u.maps.size ? sorted(u.maps) : 0, u.nums.size ? [...u.nums].sort().map((a) => JSON.parse(a)) : 0, u.strs.size ? [...u.strs].sort().map((a) => JSON.parse(a)) : 0]
    while (parts.length > 1 && parts[parts.length - 1] === 0) parts.pop()
    if (parts.length === 2 && parts[1] === -1) parts.pop()
    return parts.length === 1 ? parts[0] : parts
  }

  /** The index of the object shape `node` (a named definition is one shape, however many places refer to it). */
  function shapeId(node, name) {
    if (name !== undefined && shapeOfDef.has(name)) return shapeOfDef.get(name)
    const i = shapes.length
    shapes.push(undefined)
    if (name !== undefined) shapeOfDef.set(name, i)
    const props = Object.keys(node.properties ?? {})
    const propTypes = props.map((p) => typeId(node.properties[p]))
    const add = node.additionalProperties
    const additional = add === false ? -1 : add === undefined || isEmpty(add) ? -2 : typeId(add)
    const required = (node.required ?? []).filter((r) => props.includes(r) || additional !== -1)
    for (const p of props) if (/\s/.test(p) || p === '') throw new Error(`property name ${JSON.stringify(p)} cannot be space-joined`)
    shapes[i] = { props, propTypes, required, additional, minProperties: node.minProperties ?? 0 }
    return i
  }

  const root0 = typeId({ $ref: schema.$ref })
  const exprRef0 = shapeOfDef.get('ExprRef')
  if (exprRef0 === undefined) throw new Error('the schema has no ExprRef')

  // Many definitions are the same type under another name (the instances of one generic, the same object written inline in several
  // places): equal shapes and equal types are made one, until nothing more merges.
  let tOf = types.map((_, i) => i)
  let sOf = shapes.map((_, i) => i)
  const typeKey = (e) => {
    if (typeof e === 'number') return String(e)
    const [mask, en, sh, ar, mp, nu, st] = e
    const sset = (l) => (l ? [...new Set(l.map((x) => sOf[x]))].sort((a, b) => a - b) : 0)
    const tset = (l) => (l ? [...new Set(l.map((x) => tOf[x]))].sort((a, b) => a - b) : 0)
    const arrs = ar ? [...new Set(ar.map(([it, lo, hi]) => JSON.stringify([tOf[it], lo, hi])))].sort() : 0
    return JSON.stringify([mask, en, sset(sh), arrs, tset(mp), nu ?? 0, st ?? 0])
  }
  const shapeKey = (s) => JSON.stringify([s.props.map((p, k) => [p, tOf[s.propTypes[k]]]).sort((a, b) => (a[0] < b[0] ? -1 : 1)), [...s.required].sort(), s.additional < 0 ? s.additional : tOf[s.additional], s.minProperties])
  for (let changed = true; changed;) {
    const firstS = new Map()
    const nextS = shapes.map((s, i) => { const k = shapeKey(s); if (!firstS.has(k)) firstS.set(k, i); return firstS.get(k) })
    sOf = nextS
    const firstT = new Map()
    const nextT = types.map((e, i) => { const k = typeKey(e); if (!firstT.has(k)) firstT.set(k, i); return firstT.get(k) })
    changed = nextT.some((x, i) => x !== tOf[i])
    tOf = nextT
    if (!changed) changed = shapes.some((s, i) => { const k = shapeKey(s); return firstS.get(k) !== sOf[i] })
  }
  // (renumbered densely, in order of first appearance)
  const keptT = types.map((_, i) => i).filter((i) => tOf[i] === i)
  const keptS = shapes.map((_, i) => i).filter((i) => sOf[i] === i)
  const newT = new Map(keptT.map((i, n) => [i, n]))
  const newS = new Map(keptS.map((i, n) => [i, n]))
  const T = (i) => newT.get(tOf[i])
  const Sh = (i) => newS.get(sOf[i])
  const finalTypes = keptT.map((i) => {
    const e = types[i]
    if (typeof e === 'number') return e
    const [mask, en, sh, ar, mp, nu, st] = e
    const parts = [mask, en, sh ? [...new Set(sh.map(Sh))].sort((a, b) => a - b) : 0, ar ? [...new Map(ar.map(([it, lo, hi]) => [JSON.stringify([T(it), lo, hi]), [T(it), lo, hi]])).values()] : 0, mp ? [...new Set(mp.map(T))].sort((a, b) => a - b) : 0, nu ?? 0, st ?? 0]
    while (parts.length > 1 && parts[parts.length - 1] === 0) parts.pop()
    return parts
  })
  const finalShapes = keptS.map((i) => {
    const s = shapes[i]
    return { props: s.props, propTypes: s.propTypes.map(T), required: s.required, additional: s.additional < 0 ? s.additional : T(s.additional), minProperties: s.minProperties }
  })
  types.length = 0
  types.push(...finalTypes)
  shapes.length = 0
  shapes.push(...finalShapes)
  const root = T(root0)
  const exprRef = Sh(exprRef0)
  if (!refTypes.has('InlineDataset')) throw new Error('the schema has no InlineDataset')
  const inlineDataset = T(refTypes.get('InlineDataset'))
  if (tOf.some((c, i) => c === tOf[refTypes.get('InlineDataset')] && i !== refTypes.get('InlineDataset'))) throw new Error('InlineDataset is merged with another type')
  // (the enumerations the merged types still use, renumbered)
  const enumsOf = (e) => (typeof e === 'number' || e.length < 2 || e[1] === -1 ? [] : [e[1]].flat())
  const usedEnums = [...new Set(types.flatMap(enumsOf))].sort((a, b) => a - b)
  const enumAt = new Map(usedEnums.map((k, n) => [k, n]))
  for (const e of types) if (enumsOf(e).length) e[1] = Array.isArray(e[1]) ? e[1].map((k) => enumAt.get(k)) : enumAt.get(e[1])
  const finalEnums = usedEnums.map((k) => enums[k])
  enums.length = 0
  enums.push(...finalEnums)
  // (properties in name order: shapes that share properties then read alike, which is what the compression of the bundle uses)
  for (const s of shapes) {
    const order = s.props.map((_, k) => k).sort((a, b) => (s.props[a] < s.props[b] ? -1 : 1))
    s.props = order.map((k) => s.props[k])
    s.propTypes = order.map((k) => s.propTypes[k])
  }

  const trimTail = (tail) => {
    const t = [...tail]
    const defaults = ['', -1, 0]
    while (t.length && t[t.length - 1] === defaults[t.length - 1]) t.pop()
    return t
  }
  // (many shapes are another's with a few properties more or less - the mark definitions and their configs, the spec kinds: such a
  // shape is written as the earlier one it shares most with, and the difference)
  const encoded = shapes.map((sh, i) => {
    const tail = [sh.required.join(' '), sh.additional, sh.minProperties]
    const own = new Map(sh.props.map((p, k) => [p, sh.propTypes[k]]))
    let best = -1
    let bestShared = 0
    for (let j = 0; j < i; j++) {
      const o = shapes[j]
      let shared = 0
      for (let k = 0; k < o.props.length; k++) if (own.get(o.props[k]) === o.propTypes[k]) shared++
      if (shared > bestShared) { best = j; bestShared = shared }
    }
    if (best >= 0 && bestShared >= 5) {
      const base = shapes[best]
      const baseOf = new Map(base.props.map((p, k) => [p, base.propTypes[k]]))
      const removed = base.props.filter((p) => !own.has(p))
      const added = sh.props.filter((p) => baseOf.get(p) !== own.get(p))
      return [best, removed.join(' '), added.join(' '), added.map((p) => own.get(p)), ...trimTail(tail)]
    }
    return [sh.props.join(' '), sh.propTypes, ...trimTail(tail)]
  })

  const lines = [
    '// GENERATED by packages/vl/scripts/schema-table.mjs from the Vega-Lite JSON schema; do not edit.',
    '// packages/vl/test/schema-table.test.ts fails when this file is not what the pinned schema gives. Format: schema-table.mjs.',
    '/* eslint-disable */',
    `export const SCHEMA_VERSION = ${JSON.stringify(version)}`,
    `export const ROOT = ${root}`,
    `export const EXPR_REF = ${exprRef}`,
    `export const INLINE_DATASET = ${inlineDataset}`,
    `/** Shapes the hand-kept checks ask for by name (validate.ts). */`,
    `export const NAMED = ${JSON.stringify(Object.fromEntries(NAMED_SHAPES.map((n) => { if (!shapeOfDef.has(n)) throw new Error(`no shape ${n}`); return [n, Sh(shapeOfDef.get(n))] })))} as const`,
    `export const TYPES: readonly (number | readonly unknown[])[] = ${JSON.stringify(types)}`,
    `export const SHAPES: readonly (readonly unknown[])[] = ${JSON.stringify(encoded)}`,
    `export const ENUMS: readonly (readonly (string | number | boolean | null)[])[] = ${JSON.stringify(enums)}`,
    '',
  ]
  return lines.join('\n')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { schema, version } = pinnedSchema()
  const src = generate(extendedSchema(schema), version)
  if (process.argv.includes('--check')) {
    const now = readFileSync(OUT, 'utf8')
    if (now !== src) { console.error(`${OUT} is not what vega-lite ${version}'s schema gives: run node packages/vl/scripts/schema-table.mjs`); process.exit(1) }
    console.log(`${OUT} matches vega-lite ${version}'s schema`)
  } else {
    writeFileSync(OUT, src)
    console.log(`wrote ${OUT} (${src.length} bytes) from vega-lite ${version}'s schema`)
  }
}
