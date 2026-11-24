/**
 * What the structural half of the compiler-parity check compares of two compiled Vega specs (the other half is the expression diff and
 * the render): the size and layout of the root and of every group below it, the axes' steps, what the data-shaping nodes group by and
 * compute, and the wiring of the interaction. Each is a function of one compiled spec; the test compares the two sides' results.
 */
import { canonicalExpression, type Side } from './vl-expressions.js'

const HASH = /_[0-9a-f]{6}(?![0-9A-Za-z])/g
/** A field or signal name as both compilers can write it: Aster's hash suffix removed (its side only), every other non-word character one underscore. */
const canonicalName = (name: string, side: Side): string => (side === 'aster' ? name.replace(HASH, '') : name).replace(/\\/g, '').replace(/[^\w ]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '')

export const SIZE_KEYS = (vg: any) => ({
  width: vg.width,
  height: vg.height,
  signals: (vg.signals ?? []).filter((s: any) => /width|height|step/i.test(s.name)).map((s: any) => ({ name: s.name, value: s.value, update: s.update, init: s.init })),
  scales: Object.fromEntries((vg.scales ?? []).filter((s: any) => /^(\w+_)?[xy](Offset)?$/.test(s.name)).map((s: any) => [s.name, { type: s.type, range: s.range, paddingInner: s.paddingInner, paddingOuter: s.paddingOuter, padding: s.padding }])),
})
/** The root and every group mark below it, in document order, with its path (a concat, a facet and a repeat keep their scales and axes in the child groups). */
export const groupsOf = (vg: any): Array<[path: string, group: any]> => {
  const out: Array<[string, any]> = []
  const walk = (g: any, path: string): void => {
    out.push([path, g])
    ;(g.marks ?? []).forEach((m: any, i: number) => { if (m.type === 'group') walk(m, `${path}/${i}`) })
  }
  walk(vg, '')
  return out
}
/** The size / layout of the root, then of every group below it: its size signals and its positional scales. */
export const SIZE_TREE = (vg: any): unknown => groupsOf(vg).map(([path, g]) => [path, path === '' ? SIZE_KEYS(g) : { signals: SIZE_KEYS(g).signals, scales: SIZE_KEYS(g).scales }])
/** The kinds of data-shaping node in the spec (formula casts, the dataset layout, naming, order and the sharing of nodes between views are not part of it). */
export const DATA_NODES = (vg: any): string[] =>
  (vg.data ?? [])
    .flatMap((d: any) => (d.transform ?? []).map((t: any) => t.type))
    .filter((ty: string) => ['aggregate', 'bin', 'extent', 'stack', 'impute', 'window', 'joinaggregate', 'timeunit', 'pivot', 'flatten', 'fold', 'lookup', 'sequence'].includes(ty))

export const DATA_NODE_KINDS = (vg: any): string[] => [...new Set(DATA_NODES(vg))].sort()
/**
 * What each data-shaping node groups and computes (the kind of the node is DATA_NODE_KINDS; a wrong `groupby` or `ops` is a node of the
 * same kind), as a set: how many datasets repeat a node is the sharing of datasets, which the compilers differ in. A bin's `_end` field in
 * a `groupby` is its start's twin and so is its `_range` (the three name one bin), so they are not told apart. An aggregate, a
 * joinaggregate and a window are told apart by the set of fields they group by anywhere in the spec (a facet's child groups by its
 * own keys in a pass of its own in vega-lite and by all of them in one pass in Aster).
 */
export const NODE_SHAPES = (vg: any, side: Side): string[] => {
  const name = (f: unknown): unknown => (typeof f === 'string' ? canonicalName(f, side) : f)
  const list = (a: unknown, grouping: boolean): unknown => {
    if (!Array.isArray(a)) return a ?? null
    const names = a.map(name).map((f) => (grouping && typeof f === 'string' ? f.replace(/_(end|range)$/, '') : f))
    return grouping ? [...new Set(names)].sort() : names
  }
  const all: any[] = groupsOf(vg).flatMap(([, g]) => (g.data ?? []).flatMap((d: any) => d.transform ?? []))
  const GROUPING = ['aggregate', 'joinaggregate', 'window']
  const shaped = all
    // (a stack with no group key and no order is vega-lite's stack of a single series, which Aster does not write: the pixels hold it)
    .filter((t) => ['bin', 'stack', 'impute', 'pivot', 'fold', 'flatten'].includes(t.type) && !(t.type === 'stack' && (t.groupby ?? []).length === 0 && (t.sort?.field ?? []).length === 0))
    .map((t) => JSON.stringify({ type: t.type, groupby: list(t.groupby, true), fields: Array.isArray(t.fields) ? list(t.fields, false) : name(t.fields ?? t.field), offset: t.offset ?? null, sort: t.sort ?? null }))
    .filter((x: string, i: number, xs: string[]) => xs.indexOf(x) === i)
  // (one entry per kind: the fields grouped by anywhere in the spec)
  const grouped = GROUPING.flatMap((type) => {
    const hit = all.filter((t) => t.type === type)
    return hit.length === 0 ? [] : [JSON.stringify({ type, groupby: [...new Set(hit.flatMap((t) => (list(t.groupby, true) as unknown[] | null) ?? []))].sort() })]
  })
  return [...shaped, ...grouped].sort()
}
/** The tick steps of the axes (one entry per axis, in order). */
export const AXIS_STEPS = (vg: any): unknown[] => groupsOf(vg).map(([path, g]) => [path, (g.axes ?? []).map((a: any) => ({ orient: a.orient, grid: a.grid, tickMinStep: a.tickMinStep }))])
/**
 * The wiring of the interaction, in every group: each signal that holds a value, a binding or handlers (the handlers' event streams
 * in full, the object form too, and their update expressions), and each mark's `interactive` and `cursor`. None of it is an
 * expression the expression diff reads or a pixel of a first frame.
 */
export const INTERACTION = (vg: any, side: Side): unknown => {
  const marks: unknown[] = []
  const walkMarks = (ms: any[] | undefined): void => {
    for (const m of ms ?? []) {
      marks.push([m.name ?? null, m.type, m.interactive ?? null, m.encode?.update?.cursor ?? m.encode?.hover?.cursor ?? null])
      walkMarks(m.marks)
    }
  }
  walkMarks(vg.marks)
  return {
    signals: groupsOf(vg).map(([path, g]) => [path, (g.signals ?? []).filter((s: any) => s.on !== undefined || s.bind !== undefined || (s.value !== undefined && s.update === undefined)).sort((x: any, y: any) => (x.name < y.name ? -1 : 1)).map((s: any) => ({ name: s.name, value: s.value ?? null, bind: s.bind ?? null, push: s.push ?? null, on: (s.on ?? []).map((h: any) => ({ events: h.events, update: typeof h.update === 'string' ? canonicalExpression(h.update, side) : h.update, force: h.force ?? null })) }))]),
    marks,
  }
}


const EXPR_KEYS = new Set(['expr', 'signal', 'init', 'update', 'test'])
const SITES_NOT_WALKED = new Set(['encode', 'config', 'axes', 'legends', 'title', 'layout', 'projections'])
/** A cast written onto its own field (vega-lite writes it as the source's parse, Aster as a formula: where it is written is not compared here) and a plain copy of a field. */
const SKIPPED_FORMULA = /^(toNumber|toDate|toString)\(datum\[("(?:[^"\\]|\\.)*")\]\)$|^datum\[("(?:[^"\\]|\\.)*")\]$/
/**
 * Which kind of site each expression of the dataflow sits at: `data.transform.filter`, `signals.update`, `signals.on.update`,
 * `scales.domain`. The expression diff compares the set of all expressions of the spec; this one compares the set of (site kind,
 * expression) pairs, so an expression dropped at one kind of site and present at another is a difference. The sites of the drawn
 * parts (a mark's encode, a guide's, the config's) are not walked: where a compiler puts a guide's conditional is its own, and the
 * render compares what it draws.
 */
export const EXPRESSION_SITES = (vg: unknown, side: Side): string[] => {
  const out = new Set<string>()
  const walk = (v: unknown, site: string): void => {
    if (Array.isArray(v)) {
      for (const x of v) walk(x, site)
      return
    }
    if (v === null || typeof v !== 'object') return
    const o = v as Record<string, unknown>
    for (const [k, x] of Object.entries(o)) {
      if (EXPR_KEYS.has(k) && typeof x === 'string') {
        const canonical = canonicalExpression(x, side)
        if (k === 'expr' && o.type === 'formula' && SKIPPED_FORMULA.test(canonical)) continue
        out.add(`${site.replace(/^(marks\.)+/, 'marks.').replace(/^marks\.data\./, 'data.')}${o.type !== undefined && typeof o.type === 'string' && /^[a-z]+$/.test(o.type) && site.endsWith('transform') ? `.${o.type}` : ''}.${k === 'signal' ? 'expr' : k}: ${canonical}`)
      } else if (k === 'name' || k === 'type' || k === 'style' || typeof x !== 'object' || SITES_NOT_WALKED.has(k)) continue
      else walk(x, /^\d+$/.test(k) ? site : site === '' ? k : `${site}.${k}`)
    }
  }
  walk(vg, '')
  return [...out].sort()
}
