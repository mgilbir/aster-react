// The probe behind packages/vl/src/ignored-table.ts: what vega-lite 6.4.3 does with each mark-definition property, per mark type.
// Shared by the generator (ignored-table.mjs) and the conformance differential (vl-ignored-table.test.ts), so the two read one
// matrix.
//
// For every mark type, every property of the pinned schema's MarkDef, every value the schema gives it (representative values, below)
// and every chart shape the mark is tried on (CONTEXTS), the probe compiles the chart with and without the property through real
// vega-lite and compares the two Vega specs:
//   - the same Vega: vega-lite IGNORES the property there;
//   - the same Vega but for the property written, as it is (`{value}`, or `{signal}` for an `{expr}`), into the encoding of the
//     marks under its own name (vega-lite base.ts markDefProperties): vega-lite FORWARDS it there (Vega's mark may draw it or not:
//     a `fontSize` on a rect is forwarded and draws nothing, which is Vega's business, not the compiler's);
//   - anything else: vega-lite USES it there.
// The table (ignored-table.ts) lists, per mark type, the properties IGNORED in every case of the mark, and those FORWARDED in every
// case where they are not ignored: @aster-charts/vl consumes the first as no-ops and forwards the second as vega-lite does. Any
// other property stays held to the consumption check: Aster's compile code reads it (and draws vega-lite's chart) or refuses it.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
// (vega-lite and vega are pinned by the conformance package; @aster-charts/vl itself depends on neither)
const require = createRequire(join(here, '..', '..', 'conformance', 'package.json'))
export const vl = await import(require.resolve('vega-lite'))
const vlDir = join(dirname(require.resolve('vega-lite')), '..')
export const SCHEMA = JSON.parse(readFileSync(join(vlDir, 'build', 'vega-lite-schema.json'), 'utf8'))
export const VEGA_LITE_VERSION = JSON.parse(readFileSync(join(vlDir, 'package.json'), 'utf8')).version

const quiet = { level: () => quiet, warn: () => quiet, info: () => quiet, debug: () => quiet, error: () => quiet }

/** The rows every chart draws: a category, two numbers, a date, an image url. */
const ROWS = [
  { c: 'alpha', v: 28, w: 3, t: '2024-01-07', u: 'data:image/png;base64,iVBORw0KGgo=' },
  { c: 'beta', v: 55, w: 7, t: '2024-03-19', u: 'data:image/png;base64,iVBORw0KGgo=' },
  { c: 'gamma', v: 43, w: 5, t: '2024-06-02', u: 'data:image/png;base64,iVBORw0KGgo=' },
  { c: 'alpha', v: 91, w: 9, t: '2024-09-11', u: 'data:image/png;base64,iVBORw0KGgo=' },
]
const q = (field) => ({ field, type: 'quantitative' })
const n = (field) => ({ field, type: 'nominal' })
const tm = (field) => ({ field, type: 'temporal' })
const tmu = (field) => ({ field, type: 'temporal', timeUnit: 'yearmonth' })
const bin = (field) => ({ field, type: 'quantitative', bin: true })

/**
 * The chart shapes each mark type is tried on: the encodings that decide which of its properties mean something (a band or a
 * continuous position, an orientation, a bin, a stack, a range, polar positions, no encoding at all). A property USED on any of them
 * is not in the table.
 */
const XY = [
  ['n x, q y', { x: n('c'), y: q('v') }],
  ['q x, n y', { x: q('v'), y: n('c') }],
  ['q x, q y', { x: q('w'), y: q('v') }],
  ['t x, q y', { x: tm('t'), y: q('v') }],
  ['q x, t y', { x: q('v'), y: tm('t') }],
  ['timeUnit x, q y', { x: tmu('t'), y: q('v') }],
  ['q x, timeUnit y', { x: q('v'), y: tmu('t') }],
  ['timeUnit x, count y', { x: tmu('t'), y: { aggregate: 'count', type: 'quantitative' } }],
  ['bin x, count y', { x: bin('v'), y: { aggregate: 'count', type: 'quantitative' } }],
  ['bin y, count x', { y: bin('v'), x: { aggregate: 'count', type: 'quantitative' } }],
  ['stacked by colour', { x: n('t'), y: q('v'), color: n('c') }],
  ['x and x2', { x: q('w'), x2: q('v'), y: n('c') }],
  ['y and y2', { y: q('w'), y2: q('v'), x: n('c') }],
  ['x only', { x: q('v') }],
  ['no encoding', {}],
]
const POLAR = [
  ['theta q, colour', { theta: q('v'), color: n('c') }],
  ['theta n', { theta: n('c') }],
  ['theta q, radius q', { theta: q('v'), radius: q('w') }],
  ['theta, theta2', { theta: q('w'), theta2: q('v') }],
  ['radius, radius2', { theta: q('v'), radius: q('w'), radius2: { value: 10 } }],
]
export const CONTEXTS = {
  bar: XY,
  rect: [...XY, ['n x, n y', { x: n('c'), y: n('t'), color: q('v') }]],
  tick: [...XY.filter(([k]) => !k.startsWith('stacked')), ['n x, n y', { x: n('c'), y: n('t') }]],
  rule: XY,
  line: [...XY, ['colour series', { x: tm('t'), y: q('v'), color: n('c') }], ['ordered', { x: q('w'), y: q('v'), order: q('v') }]],
  area: [...XY, ['colour series', { x: tm('t'), y: q('v'), color: n('c') }]],
  trail: [...XY, ['size', { x: tm('t'), y: q('v'), size: q('w') }]],
  point: [...XY, ...POLAR, ['size, shape', { x: q('w'), y: q('v'), size: q('v'), shape: n('c') }]],
  circle: [...XY, ...POLAR],
  square: [...XY, ...POLAR],
  text: [...XY.map(([k, e]) => [k, { ...e, text: n('c') }]), ...POLAR.map(([k, e]) => [k, { ...e, text: n('c') }]), ['no text channel', { x: n('c'), y: q('v') }]],
  arc: [...POLAR, ['no encoding', {}], ['colour only', { color: n('c') }]],
  image: [['q x, q y', { x: q('w'), y: q('v'), url: { field: 'u' } }], ['n x, q y', { x: n('c'), y: q('v'), url: { field: 'u' } }], ['no url', { x: q('w'), y: q('v') }]],
}
export const MARKS = Object.keys(CONTEXTS)

const defs = SCHEMA.definitions
const deref = (node) => {
  let n = node
  while (n && n.$ref) n = defs[n.$ref.replace('#/definitions/', '')]
  return n
}
/**
 * A schema node's alternatives, `$ref`s resolved and `anyOf`s flattened. A bound written beside the `anyOf` (`{anyOf: [{type: number},
 * ExprRef], minimum: 0, maximum: 1}`, an opacity) holds for the number alternatives inside it: they carry it down.
 */
function alternatives(node, outer = {}) {
  const n = deref(node)
  if (!n) return []
  const bounds = { ...outer }
  if (n.minimum !== undefined) bounds.minimum = Math.max(bounds.minimum ?? -Infinity, n.minimum)
  if (n.maximum !== undefined) bounds.maximum = Math.min(bounds.maximum ?? Infinity, n.maximum)
  if (n.anyOf) return n.anyOf.flatMap((alt) => alternatives(alt, bounds))
  const own = n.type === 'number' || n.type === 'integer' || (Array.isArray(n.type) && n.type.some((t) => t === 'number' || t === 'integer')) ? { ...n, ...(bounds.minimum !== undefined ? { minimum: Math.max(n.minimum ?? -Infinity, bounds.minimum) } : {}), ...(bounds.maximum !== undefined ? { maximum: Math.min(n.maximum ?? Infinity, bounds.maximum) } : {}) } : n
  if (Array.isArray(n.type)) return n.type.map((type) => ({ ...own, type }))
  return [own]
}
const isExprRef = (n) => n.type === 'object' && n.properties && Object.keys(n.properties).join() === 'expr'

/**
 * The values a property is tried with, chosen from its schema and nothing else: every word of an enumeration (the first few of a
 * long one, a colour name's), both booleans, two numbers (one in range for a bounded one), a short string, an array of the item
 * kind, and an `{expr}` of the first of these where the schema takes an expression. Objects other than an expression are not tried
 * (a property with only those is never in the table).
 */
export function valuesOf(node) {
  const out = []
  const add = (v) => { if (!out.some((o) => JSON.stringify(o) === JSON.stringify(v))) out.push(v) }
  let expr = false
  for (const a of alternatives(node)) {
    if (isExprRef(a)) { expr = true; continue }
    if (a.const !== undefined) add(a.const)
    else if (a.enum) for (const v of a.enum.length > 16 ? a.enum.slice(0, 3) : a.enum) add(v)
    else if (a.type === 'boolean') { add(true); add(false) }
    else if (a.type === 'number' || a.type === 'integer') {
      const lo = a.minimum ?? (a.exclusiveMinimum !== undefined ? a.exclusiveMinimum + 1 : undefined)
      const hi = a.maximum
      if (lo !== undefined && hi !== undefined) { add(lo); add(hi) } else { add(lo ?? 0); add(8) }
    } else if (a.type === 'string') add(a.format === 'color' || a.pattern ? '#ff0000' : 'a')
    else if (a.type === 'null') add(null)
    else if (a.type === 'array') {
      const item = alternatives(a.items)[0]
      add(item && (item.type === 'number' || item.type === 'integer') ? [4, 2] : ['a'])
    }
  }
  const first = out.find((v) => typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean')
  if (expr && first !== undefined) add({ expr: JSON.stringify(first) })
  return out
}

/** The MarkDef properties the probe tries (`type` is the mark itself). */
export const MARK_PROPS = Object.keys(defs.MarkDef.properties).filter((p) => p !== 'type').sort()

export function baseSpec(mark, encoding) {
  return { width: 200, height: 120, data: { values: ROWS }, mark: { type: mark }, encoding: structuredClone(encoding) }
}

/** vega-lite's Vega of `spec` (JSON text), or undefined when vega-lite refuses it. */
export function vlCompile(spec) {
  try {
    return JSON.stringify(vl.compile(structuredClone(spec), { logger: quiet }).spec)
  } catch {
    return undefined
  }
}

/**
 * How `json` (vega-lite's Vega with the property) differs from `without` (without it): 'ignored' (not at all), 'forwarded' (only by
 * `encode.update[prop]` holding the value as it is, on one or more marks), or 'used'.
 */
export function effectOf(json, without, prop, value) {
  if (json === without) return 'ignored'
  const ref = JSON.stringify(value !== null && typeof value === 'object' && !Array.isArray(value) && typeof value.expr === 'string' ? { signal: value.expr } : { value })
  let found = false
  const strip = (node) => {
    if (Array.isArray(node)) { node.forEach(strip); return }
    if (node === null || typeof node !== 'object') return
    const update = node.encode?.update
    if (update !== null && typeof update === 'object' && Object.hasOwn(update, prop) && JSON.stringify(update[prop]) === ref) {
      delete update[prop]
      found = true
    }
    for (const k of Object.keys(node)) strip(node[k])
  }
  const spec = JSON.parse(json)
  strip(spec.marks)
  return found && JSON.stringify(spec) === without ? 'forwarded' : 'used'
}

/**
 * Every case of the matrix: `{ mark, context, prop, value, spec, effect }`: `effect` is 'ignored', 'forwarded' or 'used' (see the
 * top of the file), or 'refused' when vega-lite refuses the spec with the property (not counted either way). Contexts vega-lite
 * refuses without the property are not cases.
 */
export function* probe({ marks = MARKS, props = MARK_PROPS } = {}) {
  for (const mark of marks) {
    for (const [context, encoding] of CONTEXTS[mark]) {
      const without = vlCompile(baseSpec(mark, encoding))
      if (without === undefined) continue
      for (const prop of props) {
        for (const value of valuesOf(defs.MarkDef.properties[prop])) {
          const spec = baseSpec(mark, encoding)
          spec.mark[prop] = value
          const json = vlCompile(spec)
          yield { mark, context, prop, value, spec, effect: json === undefined ? 'refused' : effectOf(json, without, prop, value) }
        }
      }
    }
  }
}

/**
 * The table: per mark type, `ignored` (no case of the mark finds the property anything but ignored) and `forwarded` (no case finds it
 * used, and some case finds it forwarded), each sorted. A property no case could try (vega-lite refused every value) is in neither.
 */
export function ignoredTable(opts) {
  const seen = new Map()
  for (const c of probe(opts)) {
    if (c.effect === 'refused') continue
    const key = `${c.mark} ${c.prop}`
    const s = seen.get(key) ?? new Set()
    s.add(c.effect)
    seen.set(key, s)
  }
  const table = {}
  for (const mark of opts?.marks ?? MARKS) {
    const of = (p) => seen.get(`${mark} ${p}`)
    const props = opts?.props ?? MARK_PROPS
    table[mark] = {
      ignored: props.filter((p) => of(p) !== undefined && of(p).size === 1 && of(p).has('ignored')),
      forwarded: props.filter((p) => of(p) !== undefined && of(p).has('forwarded') && !of(p).has('used')),
    }
  }
  return table
}
